/**
 * AI Service - AWS Bedrock + Gemma 3 27B (3-phase pipeline)
 * Phase 1: AI extraction — structured data + post summary
 * Phase 2: Code scoring — deterministic skill/experience/salary matching
 * Phase 3: AI email drafting — only for qualifying contacts
 */

import { bedrockChat } from '../providers/bedrock-transport.js';
// Shared with the posts UI so the skill gaps shown on a card and the score
// computed here can never disagree — see services/feed/skill-match.js.
import { normalizeSkill, buildSkillLookup, buildCannotClaimSet, matchesSkill } from './skill-match.js';
import fs from 'fs';
import path from 'path';
import config, { DEFAULT_PREFERENCES, candidateRole } from './feed-config.js';
import { checkRawPost, checkExtractedPost } from './location-filter.js';
import { buildSignoff } from './signoff.js';

// services/feed/ → climb two levels to reach the repo root's output/
const OUTPUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'output');

// ============================================================
// INVOKE MODEL (Gemma via the Bedrock mantle endpoint)
// ============================================================
//
// 2026-07: moved off the SigV4 bedrock-runtime client (dead IAM keys) onto the
// bearer-key mantle endpoint. Transport, throttle-retry and response parsing
// live in services/providers/mantle-client.js. Gemma 3 27B caps output at 8K
// tokens, which is exactly what this pipeline asks for.

async function invokeModel(prompt, stepName) {
  const { text, truncated } = await bedrockChat({
    model: config.bedrock.modelId,
    prompt,
    maxTokens: 8192,
    temperature: 0.1,
    topP: 0.9,
    label: `feed:${stepName}`,
  });

  if (truncated) {
    console.warn(`   ⚠️  ${stepName} hit the 8192-token output cap — JSON may need repair.`);
  }

  return text;
}

// ============================================================
// JSON PARSER (with truncation repair)
// ============================================================

function parseJSON(response, step = '') {
  let text = response.trim();
  if (text.startsWith('```json')) text = text.slice(7);
  else if (text.startsWith('```')) text = text.slice(3);
  if (text.endsWith('```')) text = text.slice(0, -3);
  text = text.trim();

  try {
    return JSON.parse(text);
  } catch {
    console.log(`   Repairing truncated JSON in ${step}...`);
    let repaired = text;

    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      const lastQuoteIdx = repaired.lastIndexOf('"');
      const beforeLastQuote = repaired.substring(0, lastQuoteIdx);
      const lastComma = beforeLastQuote.lastIndexOf(',');
      if (lastComma > 0) repaired = repaired.substring(0, lastComma);
    }

    repaired = repaired.replace(/,\s*$/, '');

    const opens = (repaired.match(/\[/g) || []).length;
    const closes = (repaired.match(/\]/g) || []).length;
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;

    for (let i = 0; i < opens - closes; i++) repaired += ']';
    for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';

    try {
      const result = JSON.parse(repaired);
      console.log(`   JSON repaired successfully`);
      return result;
    } catch (error2) {
      console.error(`\n   JSON parse failed in ${step}:`);
      console.error(text.substring(0, 500));
      throw error2;
    }
  }
}

// ============================================================
// PHASE 1: EXTRACTION PROMPT
// ============================================================

// Everything the extraction prompt used to say about one person — stack,
// years, market — now comes from the candidate and its preferences. With no
// candidate the wording is neutral and the numbers are DEFAULT_PREFERENCES.
function describeCandidateForExtraction(candidate, prefs) {
  const skills = (candidate?.skills || []).slice(0, 15);
  const years = parseFloat(candidate?.experience);
  const hasYears = Number.isFinite(years);
  const isLPA = String(prefs.salaryUnit || '').toUpperCase() === 'LPA';
  const role = candidateRole(candidate);

  const intro = candidate
    ? `The candidate is a ${role}${skills.length ? ` (${skills.join(', ')})` : ''}${hasYears ? ` with ~${years} years of experience` : ''}${prefs.country ? ` based in ${prefs.country}` : ''}. Focus on extracting roles relevant to the candidate's stack and skills.`
    : `Focus on extracting software development and engineering roles${prefs.country ? ` based in ${prefs.country}` : ''}.`;

  // Extraction is the one irreversible step (a non-hiring post is marked
  // processed and never retried), so its experience bar is the STRICT one:
  // the candidate's whole years plus maxExperienceGap, and a post asking for
  // that many or more is dropped — for ~3 years and a gap of 1 that is
  // "4+ years", exactly what the original hardcoded line said. scoreContact
  // applies the looser ceil(years + gap) as the second, reversible gate.
  const expBar = hasYears ? Math.floor(years + Number(prefs.maxExperienceGap ?? 0)) : null;
  const expRule = expBar != null && expBar > 0
    ? `- Mark isHiring=false if the minimum experience required is ${expBar}+ years (candidate has ~${years} years)\n`
    : '';

  // Categorical on purpose. Listing individual skills here made the model
  // drop a post whose primary tech sat at position 9+ of the candidate's
  // list — Phase 1 cannot be undone, so it only rejects clear mismatches
  // and leaves fine-grained skill matching to the deterministic scorer.
  const stackRule = candidate
    ? `- Mark isHiring=false ONLY if the role is clearly outside the candidate's field (${role}) — e.g. built entirely on a language, platform or discipline the candidate does not work in. When in doubt, extract it: skill-by-skill matching happens later`
    : `- Mark isHiring=false if the role is not a software development or engineering role`;

  return {
    intro,
    multiRole: candidate ? "the candidate's skills above" : 'a software developer',
    // The stored fields stay `salaryMinLPA` / `salaryMaxLPA` whatever the
    // unit — the pool filters and the UI read those names.
    salaryUnit: isLPA ? 'Indian Lakhs Per Annum' : `${prefs.salaryUnit} in ${prefs.currency}`,
    expRule,
    stackRule,
  };
}

// The CRITICAL REJECTION RULES block, numbered from whichever rules the
// preferences enable. Wording kept from the tuned original; only the
// country, the role types and the salary floor are substituted.
function buildRejectionRules(prefs) {
  const rules = [];
  if (prefs.rejectWalkIn) {
    rules.push('Interview requires physical presence\n   - walk-in, face-to-face, F2F, in-person interview.');
  }
  rules.push('Candidate location is restricted\n   - phrases like "local candidates only", "only from <city>", "must be from <city>".\n   - mentioning an office or relocation is OK.');
  if (prefs.country) {
    const where = /^india$/i.test(prefs.country)
      ? 'non-Indian cities or domains (.pk, .bd, .ae, .uk, .us, etc)'
      : `cities or email domains that place it in a country other than ${prefs.country}`;
    rules.push(`Job location is outside ${prefs.country}\n   - ${where}.`);
  }
  const types = [prefs.rejectIntern && 'internship', prefs.rejectContract && 'contract'].filter(Boolean);
  const invalid = [];
  if (types.length) invalid.push(`${types.join(' or ')} roles`);
  if (prefs.minSalary != null) {
    // The conversion hint only where it applies: a USD market (or a rate of
    // 1) has nothing to convert, and lakhs need the ÷100000 spelled out or
    // "12,00,000 per annum" is normalised to 1200000 LPA.
    const unit = prefs.salaryUnit;
    const isLPA = String(unit || '').toUpperCase() === 'LPA';
    const noFx = String(prefs.currency || '').toUpperCase() === 'USD' || Number(prefs.usdRate) === 1 || !Number.isFinite(Number(prefs.usdRate));
    const fx = noFx ? '' : `, USD figures ×${prefs.usdRate} ${prefs.currency} per USD`;
    invalid.push(`salary < ${prefs.minSalary} ${unit} (normalise to ${unit}: monthly ×12, hourly ×2080${fx}${isLPA ? ', then ÷100000 for lakhs' : ''})`);
  }
  if (invalid.length) rules.push(`Role type or salary invalid\n${invalid.map((l) => `   - ${l}`).join('\n')}`);

  const valid = prefs.country
    ? `Remote, hybrid, on-site jobs in ${prefs.country} without location restrictions are valid.`
    : 'Remote, hybrid and on-site jobs without location restrictions are valid.';

  return `CRITICAL REJECTION RULES

Set isHiring=false if ANY of these apply:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

${valid}
`;
}

export function buildExtractionPrompt(posts, candidate = null) {
  const prefs = { ...DEFAULT_PREFERENCES, ...(candidate?.preferences || {}) };
  const who = describeCandidateForExtraction(candidate, prefs);
  const rejection = buildRejectionRules(prefs);
  const postsData = posts.map((p, i) => ({
    ref: refFor(i),
    author: p.author?.name || 'Unknown',
    authorHeadline: p.author?.headline || '',
    text: p.post?.text || '',
    jobTitle: p.job?.title || null,
    jobCompany: p.job?.company || null,
    hashtags: (p.post?.hashtags || []).join(', '),
  }));

  return `Extract structured job data from these ${posts.length} LinkedIn posts.
${who.intro}

POSTS:
${JSON.stringify(postsData, null, 2)}

FOR EACH POST, extract:
1. isHiring: Is this post from someone HIRING or a company recruiting? (true/false)
2. If isHiring=true, extract:
   - poster: name and headline from the post author
   - summary: 3-4 line summary of the post — what the role needs, key responsibilities, any standout details (team, product, tech stack context)
   - job.title: job role being hired for
   - job.company: company name (null if not mentioned)
   - job.type: "full-time", "contract", "intern", or "remote"
   - job.requirements: 5 to 8 top TECHNICAL skills/technologies required (short strings like "React", "Node.js", "PostgreSQL", "Docker", "TypeScript"). Extract only technology/tool names, not soft skills
   - job.requiredExperience: MINIMUM years of experience required, as a number. Scan the WHOLE post for this — it is usually on its own line such as "💼 Experience: 1–4 Years" or "Exp: 5+ yrs", but can appear anywhere, including inside a sentence
     - ranges take the LOWER bound: "3-5 years" → 3, "1–4 Years" → 1, "5–7+ Years" → 5
     - "5+ years", "5 years and above", "minimum 5 years" → 5
     - accept every spelling and abbreviation: years, year, yrs, yr, exp, experience, EXP, and obvious typos ("Minimun 10+ years of EXP" → 10)
     - accept en-dashes and hyphens in ranges: "2–4" and "2-4" are the same
     - "fresher", "entry level", "0-1 year", "no experience required" → 0
     - months convert to years, rounded down: "18 months" → 1, "6 months" → 0
     - null ONLY when the post states no experience requirement at all. Do NOT guess a number from seniority words alone — "Senior Developer" with no stated years is null, not 5
   - job.salary: original salary text from the post (null if not mentioned)
   - job.salaryMinLPA: minimum salary normalized to ${who.salaryUnit} (number or null)
   - job.salaryMaxLPA: maximum salary normalized to ${who.salaryUnit} (number or null)
   - contacts.emails: array of email addresses found in post text
     - Match: user@domain.com, name [at] company [dot] com
     - ONLY valid emails with @ and domain. NEVER include URLs, phone numbers, or links
   - contacts.method: "email" if emails found, "DM" if none

3. If isHiring=false: set all fields to defaults (empty strings, null, empty arrays)

MULTI-ROLE POSTS: If a single post lists MULTIPLE distinct job roles (e.g. "Hiring: Node.js Developer, PHP Developer, IT Recruiter"), create a SEPARATE result entry for EACH role that is relevant to ${who.multiRole}. Use the SAME ref for all entries from the same post but different job titles. Skip roles that are clearly non-tech (HR, recruiter, sales, etc.) unless the candidate context matches.

RESPOND WITH ONLY A JSON OBJECT (no markdown, no code fences):
{"results":[{"ref":"p1","isHiring":true,"poster":{"name":"Name","headline":"Headline"},"summary":"Looking for a senior React dev to build a dashboard. Remote friendly, urgent hire.","job":{"title":"Role","company":"Co","type":"full-time","requirements":["React","Node.js","MongoDB","TypeScript","Docker","AWS"],"requiredExperience":3,"salary":"8-12 ${prefs.salaryUnit}","salaryMinLPA":8,"salaryMaxLPA":12},"contacts":{"emails":["a@b.com"],"method":"email"}}]}

RULES:
- Non-hiring posts: isHiring=false, empty defaults
- requirements: 5-8 short technical skill/technology names ONLY (not sentences, not soft skills)
- NEVER put URLs (http://, https://, lnkd.in) in contacts.emails
- requiredExperience: ALWAYS fill this in when the post states years anywhere — it drives filtering and sorting downstream, and a missed number reads as "no requirement". Use the MINIMUM of any range ("5-8 years" → 5). Never invent one that isn't stated
- summary: 3-4 lines, capture what the role needs, key responsibilities,experience needed and any standout details (team size, product, tech stack context)
- Mark isHiring=false if the person is LOOKING FOR a job themselves (#OpenToWork, "actively looking", "seeking opportunities", "open to roles"). These are job SEEKERS, not employers hiring
${who.expRule}- Mark isHiring=false if the role is primarily a TRAINER, TEACHING, or INSTRUCTOR position (not a developer/engineer role)
${who.stackRule}

${rejection}
`;
}

// ============================================================
// PHASE 2: CODE-BASED SCORING (zero AI cost)
// ============================================================

// Exported so every caller scores with the same function the
// pipeline does — a second copy drifted once already.
export function scoreContact(extracted, candidate) {
  const prefs = { ...DEFAULT_PREFERENCES, ...(candidate?.preferences || {}) };
  const years = parseFloat(candidate?.experience);
  // Unknown years disable the experience gate rather than guessing.
  const maxExp = Number.isFinite(years) ? Math.ceil(years + Number(prefs.maxExperienceGap ?? 0)) : null;
  const reqExp = extracted.job?.requiredExperience;

  // Experience filter
  if (maxExp != null && reqExp != null && reqExp > maxExp) {
    return {
      isGoodMatch: false,
      score: 0,
      reason: `Experience requirement too high (needs ${reqExp}yr, max ${maxExp}yr)`,
    };
  }

  // Salary filter. ONE knob: preferences.minSalary (default 6). This used to
  // be a hardcoded 7 while the pre-filter regex and the extraction prompt
  // both said 6 — three places, two numbers. The floor is now the same
  // preference everywhere, which for the default operator deliberately
  // relaxes this check from 7 to 6 LPA.
  const salaryMax = extracted.job?.salaryMaxLPA;
  if (prefs.minSalary != null && salaryMax != null && salaryMax < prefs.minSalary) {
    return {
      isGoodMatch: false,
      score: 0,
      reason: `Salary below ${prefs.minSalary} ${prefs.salaryUnit} (${salaryMax} ${prefs.salaryUnit})`,
    };
  }

  // Location filter — safety net for posts that slipped through pre-filter
  const locationReject = checkExtractedPost(extracted, prefs);
  if (locationReject) {
    return {
      isGoodMatch: false,
      score: 0,
      reason: locationReject,
    };
  }

  // Skill matching
  const requirements = extracted.job?.requirements || [];
  if (requirements.length === 0) {
    return { isGoodMatch: false, score: 0, reason: 'No requirements extracted' };
  }

  const skillLookup = buildSkillLookup(candidate);
  const cannotClaimSet = buildCannotClaimSet(candidate);
  let matched = 0;
  const matchedSkills = [];
  const missingSkills = [];

  for (const req of requirements) {
    const normReq = normalizeSkill(req);

    if (matchesSkill(normReq, skillLookup, cannotClaimSet)) {
      matched++;
      matchedSkills.push(req);
    } else {
      missingSkills.push(req);
    }
  }

  const score = Math.round((matched / requirements.length) * 10);
  const isGoodMatch = score >= 8;

  let reason;
  if (isGoodMatch) {
    reason = `Strong match: ${matchedSkills.join(', ')}`;
  } else if (score >= 5) {
    reason = `Partial match: has ${matchedSkills.join(', ')}; missing ${missingSkills.join(', ')}`;
  } else {
    reason = `Low match: missing ${missingSkills.join(', ')}`;
  }

  return { isGoodMatch, score, reason, matchedSkills, missingSkills };
}

// ============================================================
// BATCH REFS
// ============================================================

/**
 * Posts are addressed to the model as "p1".."pN", never by their 19-digit
 * LinkedIn id. Measured on gemma: 7500285596414799872 came back as
 * 75000285596414799872 (a zero inserted mid-number) and 7500244504562675712
 * as 7500500000000000000 (rounded to trailing zeros). Both were dropped by the
 * attribution guard — correct, since a wrong id stamps one post's company and
 * contacts onto another's row, but the extraction was lost either way.
 * A two-character ref has nothing to corrupt, and a corrupted one cannot
 * collide with a different post because the range is 1..batchSize.
 */
const refFor = (i) => `p${i + 1}`;

// Exported for tests only — the ref scheme is the guard against a real,
// measured failure mode, so it gets locked in.
export const __testing = { refFor, resolveRef };

/** Resolve a model result back to the post it was sent, or null. */
function resolveRef(result, batchPosts, idOf) {
  const m = /^p(\d+)$/i.exec(String(result?.ref ?? '').trim());
  if (m) {
    const post = batchPosts[Number(m[1]) - 1];
    if (post) return post;
  }
  // A model that ignores the instruction and echoes an exact id is still
  // trustworthy — an exact match cannot be a corruption.
  const pid = String(result?.postId ?? '').trim();
  return pid ? (batchPosts.find((x) => idOf(x) === pid) || null) : null;
}

// ============================================================
// PHASE 3: EMAIL DRAFTING PROMPT
// ============================================================

function buildEmailPrompt(contacts, candidate) {
  const contactsData = contacts.map((c, i) => ({
    ref: refFor(i),
    posterName: c.poster?.name,
    posterHeadline: c.poster?.headline,
    postSummary: c.summary || '',
    jobTitle: c.job?.title,
    company: c.job?.company,
    requirements: c.job?.requirements,
    matchedSkills: c.match?.matchedSkills || [],
    emailTo: c.contacts?.emails?.[0],
  }));

  return `Write short personalized job application emails for these ${contacts.length} opportunities.

CONTACTS:
${JSON.stringify(contactsData, null, 2)}

CANDIDATE:
- Name: ${candidate.name}
- Role: ${candidateRole(candidate)}
- Experience: ${candidate.experience}
- Key Skills: ${candidate.skills.slice(0, 15).join(', ')}
- Summary: ${candidate.summary}
FOR EACH CONTACT, generate:
- subject: short natural subject line (not salesy)
- body: email (90-140 words, single flowing paragraph — NO sign-off):
  - Start with a generic greeting (e.g. "Hi," or "Hello,") followed by a newline (\\n\\n) BEFORE the rest of the email body — the greeting MUST be on its own line
  - Reference something specific from the postSummary that caught your eye, then naturally weave in 3-4 skills from matchedSkills with brief context from experience. ONLY mention skills from matchedSkills — never claim skills you don't have
  - End with a note about attached resume and interest in discussing further
  - Do NOT include any sign-off (name, portfolio, linkedin, github) — it is appended automatically
  - Keep it conversational, human, no corporate fluff
  - Plain text only, NO markdown, NO brackets
  - Do NOT split into more than 2 paragraphs — keep it as two cohesive paragraphs

RESPOND WITH ONLY JSON (no markdown, no code fences):
{"emails":[{"ref":"p1","subject":"Subject","body":"Email body"}]}`;
}

// ============================================================
// PHASE 1 ONLY — AI Extraction (for pushing to mongo `posts`)
// ============================================================

export async function extractPhase1(posts, candidate = null) {
  const batchSize = parseInt(process.env.BATCH_SIZE) || 7;
  const modelId = config.bedrock.modelId;
  const prefs = { ...DEFAULT_PREFERENCES, ...(candidate?.preferences || {}) };

  // Pre-filter: reject out-of-country / F2F posts before wasting API calls
  const filtered = [];
  const locationRejected = [];
  for (const post of posts) {
    const reason = checkRawPost(post, prefs);
    if (reason) {
      locationRejected.push({ id: post.id, author: post.author?.name, reason });
    } else {
      filtered.push(post);
    }
  }

  if (locationRejected.length > 0) {
    console.log(`\n   PRE-FILTER: ${locationRejected.length} posts rejected (location/F2F)`);
    for (const r of locationRejected) {
      console.log(`   [✗] ${r.author || '?'} — ${r.reason}`);
    }
  }

  console.log(`\n   PHASE 1: AI Extraction`);
  console.log(`   Model: ${modelId} | Posts: ${filtered.length}/${posts.length} (${locationRejected.length} pre-filtered) | Batch: ${batchSize}\n`);

  const totalBatches = Math.ceil(filtered.length / batchSize);

  const batches = [];
  for (let i = 0; i < filtered.length; i += batchSize) {
    batches.push({
      posts: filtered.slice(i, i + batchSize),
      batchNum: Math.floor(i / batchSize) + 1,
    });
  }

  const batchPromises = batches.map(({ posts: batchPosts, batchNum }) => {
    console.log(`   [Extract] Batch ${batchNum}/${totalBatches} (${batchPosts.length} posts) — sending`);
    const prompt = buildExtractionPrompt(batchPosts, candidate);
    return invokeModel(prompt, `Extract-${batchNum}`)
      .then(responseText => ({ batchNum, batchPosts, responseText, error: null }))
      .catch(error => ({ batchNum, batchPosts, responseText: null, error }));
  });

  const batchResults = await Promise.all(batchPromises);
  const extracted = [];

  let extractFailed = 0;
  let misattributed = 0;
  for (const { batchNum, batchPosts, responseText, error } of batchResults) {
    if (error) {
      console.log(`   [Extract] Batch ${batchNum} FAILED (API): ${error.message}`);
      extractFailed++;
      continue;
    }

    try {
      const parsed = parseJSON(responseText, `Extract-${batchNum}`);
      const results = Array.isArray(parsed.results) ? parsed.results
        : Array.isArray(parsed) ? parsed : [];

      // What the model returns is NOT authoritative. A ref naming no post in
      // this batch belongs to no post we sent, and accepting it stamps one
      // post's company, contacts and poster onto a different post's row.
      // Multi-role posts legitimately repeat the same ref, so match against the
      // batch rather than consuming refs.
      let batchHiring = 0;

      for (const result of results) {
        const source = resolveRef(result, batchPosts, (x) => x.id);
        if (!source) {
          misattributed++;
          const named = result?.ref ?? result?.postId ?? '(none)';
          console.log(`   [Extract] Batch ${batchNum}: DROPPED result — ref "${named}" was not in this batch (${result.job?.company || result.poster?.name || 'unknown'})`);
          continue;
        }
        // Downstream (mongo push, phase-2 match) keys off the real post id.
        result.postId = source.id;
        if (result.isHiring) {
          batchHiring++;
          if (result.contacts?.emails) {
            result.contacts.emails = result.contacts.emails.filter(
              e => e.includes('@') && !e.startsWith('http')
            );
            result.contacts.method = result.contacts.emails.length > 0 ? 'email' : 'DM';
          }
          // Author comes from the parser, which read it out of this post's own
          // DOM container. The model's `poster` is a second reading of the text
          // and drifts to a neighbouring post in the batch.
          result.poster = {
            name: source.author?.name ?? null,
            headline: source.author?.headline ?? null,
          };
          extracted.push(result);
        }
      }

      console.log(`   [Extract] Batch ${batchNum}: ${batchHiring} hiring posts found`);
    } catch (parseErr) {
      console.log(`   [Extract] Batch ${batchNum} FAILED (parse): ${parseErr.message}`);
      extractFailed++;
    }
  }

  if (extractFailed > 0) {
    console.log(`   ⚠ ${extractFailed}/${totalBatches} extraction batch(es) failed — continuing with ${extracted.length} results`);
  }

  if (misattributed > 0) {
    console.log(`   ⚠ ${misattributed} result(s) dropped — model returned a ref outside its own batch`);
  }

  console.log(`\n   Phase 1 complete: ${extracted.length} hiring posts extracted\n`);
  return extracted;
}

// ============================================================
// PHASE 2+3 — Score + Email from pool data
// ============================================================

/**
 * Takes pre-extracted data (from mongo `posts`) and runs scoring + email drafting.
 * @param {object[]} extracted - Array of extraction objects (hiring posts from the pool)
 * @param {object} candidate - Candidate profile
 * @returns {object[]} contacts ready
 */
export async function scoreAndDraftEmails(extracted, candidate) {
  // ── PHASE 2: CODE SCORING ──
  console.log(`\n   ═══ PHASE 2: Code Scoring (${extracted.length} posts) ═══\n`);

  const allContacts = [];

  for (const ex of extracted) {
    const match = scoreContact(ex, candidate);

    const contact = {
      postId: ex.postId,
      generatedAt: new Date().toISOString(),
      poster: ex.poster || {},
      summary: ex.summary || '',
      job: ex.job || {},
      match: {
        isGoodMatch: match.isGoodMatch,
        score: match.score,
        reason: match.reason,
      },
      email: { to: '', subject: '', body: '' },
      contacts: ex.contacts || { emails: [], method: 'DM' },
      sent: false,
      sentAt: null,
    };

    allContacts.push(contact);

    const icon = match.isGoodMatch ? '+' : '-';
    console.log(`   [${icon}] ${contact.poster.name || '?'} — ${contact.job.title || '?'} @ ${contact.job.company || '?'} — Score: ${match.score}/10${match.score === 0 ? ` (${match.reason})` : ''}`);
  }

  // Deduplicate contacts by email — keep the highest-scored contact per email
  const emailBestMap = new Map();
  for (const c of allContacts) {
    if (c.match.score < 7 || !c.contacts.emails?.length) continue;
    const primaryEmail = c.contacts.emails[0].toLowerCase();
    const existing = emailBestMap.get(primaryEmail);
    if (!existing || c.match.score > existing.match.score) {
      emailBestMap.set(primaryEmail, c);
    }
  }
  const goodWithEmail = [...emailBestMap.values()];
  const dedupedCount = allContacts.filter(c => c.match.score >= 7 && c.contacts.emails?.length > 0).length - goodWithEmail.length;

  const goodCount = allContacts.filter(c => c.match.isGoodMatch).length;
  const rejectedCount = allContacts.length - goodCount;
  console.log(`\n   Phase 2 complete: ${goodCount} good matches, ${goodWithEmail.length} qualify for email${dedupedCount > 0 ? ` (${dedupedCount} duplicate emails removed)` : ''}\n`);

  // Save scoring log for false-negative review
  const scoringLog = {
    runAt: new Date().toISOString(),
    summary: { total: allContacts.length, good: goodCount, rejected: rejectedCount, needEmail: goodWithEmail.length },
    accepted: allContacts.filter(c => c.match.isGoodMatch).map(c => ({
      poster: c.poster?.name || '?',
      jobTitle: c.job?.title || '?',
      company: c.job?.company || '?',
      score: c.match.score,
      reason: c.match.reason,
      emails: c.contacts?.emails || [],
    })),
    rejected: allContacts.filter(c => !c.match.isGoodMatch).map(c => {
      const src = extracted.find(e => e.postId === c.postId);
      return {
        poster: c.poster?.name || '?',
        headline: c.poster?.headline || '',
        jobTitle: c.job?.title || '?',
        company: c.job?.company || '?',
        score: c.match.score,
        reason: c.match.reason,
        requirements: c.job?.requirements || [],
        requiredExperience: c.job?.requiredExperience,
        type: c.job?.type,
        postText: src?.postText || '',
        summary: c.summary || '',
        emails: c.contacts?.emails || [],
      };
    }),
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, '.cc-scoring-log.json'), JSON.stringify(scoringLog, null, 2));

  // ── PHASE 3: AI EMAIL DRAFTING ──
  if (goodWithEmail.length === 0) {
    console.log(`   ═══ PHASE 3: Skipped (no qualifying contacts) ═══\n`);
    return allContacts;
  }

  console.log(`   ═══ PHASE 3: AI Email Drafting (${goodWithEmail.length} contacts) ═══\n`);

  const emailBatchSize = 7;
  const emailBatches = [];
  for (let i = 0; i < goodWithEmail.length; i += emailBatchSize) {
    emailBatches.push(goodWithEmail.slice(i, i + emailBatchSize));
  }

  const emailPromises = emailBatches.map((batch, i) => {
    console.log(`   [Email] Batch ${i + 1}/${emailBatches.length} (${batch.length} emails) — sending`);
    const prompt = buildEmailPrompt(batch, candidate);
    return invokeModel(prompt, `Email-${i + 1}`)
      .then(responseText => ({ batchNum: i + 1, batch, responseText, error: null }))
      .catch(error => ({ batchNum: i + 1, batch, responseText: null, error }));
  });

  const emailResults = await Promise.all(emailPromises);

  let emailFailed = 0;
  let emailMisaddressed = 0;
  for (const { batchNum, batch, responseText, error } of emailResults) {
    if (error) {
      console.log(`   [Email] Batch ${batchNum} FAILED (API): ${error.message}`);
      emailFailed++;
      continue;
    }

    try {
      const parsed = parseJSON(responseText, `Email-${batchNum}`);
      const emails = Array.isArray(parsed.emails) ? parsed.emails
        : Array.isArray(parsed) ? parsed : [];

      // Shared builder: only the links the candidate has, never "undefined".
      const signoff = buildSignoff(candidate);
      for (const emailResult of emails) {
        // Scoped to this batch, not allContacts: a ref the model echoed wrong
        // still resolves somewhere in the full list, and the body written for
        // one role then lands on another recruiter's row.
        const contact = resolveRef(emailResult, batch, (c) => c.postId);
        if (!contact) {
          emailMisaddressed++;
          const named = emailResult?.ref ?? emailResult?.postId ?? '(none)';
          console.log(`   [Email] Batch ${batchNum}: DROPPED draft — ref "${named}" was not in this batch`);
          continue;
        }
        if (emailResult.subject && emailResult.body) {
          contact.email = {
            to: contact.contacts.emails[0],
            subject: emailResult.subject,
            body: emailResult.body + signoff,
          };
          console.log(`   [Email] ${contact.poster.name} — drafted`);
        }
      }
    } catch (parseErr) {
      console.log(`   [Email] Batch ${batchNum} FAILED (parse): ${parseErr.message}`);
      emailFailed++;
    }
  }

  if (emailFailed > 0) {
    console.log(`   ⚠ ${emailFailed}/${emailBatches.length} email batch(es) failed — ${allContacts.filter(c => c.email?.body).length} emails still drafted`);
  }

  if (emailMisaddressed > 0) {
    console.log(`   ⚠ ${emailMisaddressed} draft(s) dropped — model returned a ref outside its own batch`);
  }

  const emailCount = allContacts.filter(c => c.email?.body).length;
  console.log(`\n   Phase 3 complete: ${emailCount} emails drafted\n`);

  return allContacts;
}

// ============================================================
// LEGACY — Full 3-phase pipeline (kept for backward compat)
// ============================================================

export async function processInBatches(posts, candidate) {
  const extracted = await extractPhase1(posts, candidate);
  if (extracted.length === 0) return [];
  return scoreAndDraftEmails(extracted, candidate);
}
