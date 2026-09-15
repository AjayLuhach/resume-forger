// Prompt builders for the scanner: the job-relevance analysis and the
// LinkedIn referral-request note.
//
// The candidate is an argument, never a file. Callers pass the object that
// `loadCandidate(username)` (services/feed/feed-config.js) returns, or null,
// in which case the prompt renders without the personalised section. There is
// deliberately no profile on disk and no module-init load: a file would pin
// the scanner to one person, and this tool runs for whoever owns the database.
//
// The prompt copy is tuned for the production scanner (Gemma-class models).
// Tweaking it is a model-quality change, not a refactor — the length and
// format rules in buildConnectNotePrompt in particular are kept verbatim.

const list = (arr) =>
  Array.isArray(arr) ? arr.map((s) => String(s ?? '').trim()).filter(Boolean) : [];

// The CANDIDATE PROFILE block. Every line is optional so a sparse profile
// still renders cleanly; the block is omitted entirely when nothing is known.
function buildCandidateContext(candidate) {
  if (!candidate) return '';
  const lines = [];

  const skills = list(candidate.skills);
  if (candidate.stack && skills.length) lines.push(`- Stack: ${candidate.stack} (${skills.join(', ')})`);
  else if (candidate.stack) lines.push(`- Stack: ${candidate.stack}`);
  else if (skills.length) lines.push(`- Skills: ${skills.join(', ')}`);

  if (candidate.experienceStart) {
    const approx = candidate.experience ? ` (~${candidate.experience})` : '';
    lines.push(`- Experience: Started ${candidate.experienceStart}${approx}`);
  } else if (candidate.experience) {
    lines.push(`- Experience: ${candidate.experience}`);
  }

  const cannotClaim = list(candidate.cannotClaim);
  if (cannotClaim.length) lines.push(`- Cannot Claim: ${cannotClaim.join(', ')}`);
  if (candidate.expectedCTC) lines.push(`- Expected compensation: ${candidate.expectedCTC}`);

  if (!lines.length) return '';
  return `\nCANDIDATE PROFILE (use this to judge relevance):\n${lines.join('\n')}\n`;
}

export function buildAnalyzePrompt(jobText, pageUrl, companyInfo = null, candidate = null) {
  const candidateContext = buildCandidateContext(candidate);
  // Who the analyzer is judging for. The stack is the most useful one-word
  // framing when it exists; otherwise point at the profile block, and with
  // no profile at all stay generic rather than describe someone who isn't there.
  const role = candidate?.stack
    ? `a ${candidate.stack} developer`
    : candidateContext ? 'the candidate described below' : 'a software developer';

  let companySection = '';
  if (companyInfo) {
    const parts = [];
    if (companyInfo.companyName) parts.push(`Name: ${companyInfo.companyName}`);
    if (companyInfo.employeeCount)
      parts.push(`Employees (range): ${companyInfo.employeeCount}`);
    if (companyInfo.employeesOnLinkedIn)
      parts.push(`Actual headcount on LinkedIn: ${companyInfo.employeesOnLinkedIn}`);
    if (companyInfo.followers)
      parts.push(`LinkedIn Followers: ${companyInfo.followers}`);
    if (companyInfo.industry) parts.push(`Industry: ${companyInfo.industry}`);
    if (companyInfo.listed !== undefined && companyInfo.listed !== null)
      parts.push(`Listed/Public: ${companyInfo.listed ? 'Yes' : 'No (Private)'}`);
    if (companyInfo.companyLinkedIn)
      parts.push(`LinkedIn: ${companyInfo.companyLinkedIn}`);
    if (companyInfo.insights?.length)
      parts.push(`Page Insights: ${companyInfo.insights.join(' | ')}`);
    if (companyInfo.companyDescription)
      parts.push(`About: ${companyInfo.companyDescription.slice(0, 600)}`);
    if (parts.length) {
      companySection = `\nCOMPANY INFO EXTRACTED FROM PAGE:\n${parts.map((p) => '- ' + p).join('\n')}\n`;
    }
  }

  return `You are a strict job relevance analyzer for ${role}. You will be penalized for any assumption or invented data.

RULES (follow strictly):
- DO NOT assume anything not explicitly mentioned in the job text
- If salary, tech stack, or company info is not clearly written → return null or "unknown"
- DO NOT infer or guess technologies, salary, or experience
- Use ONLY information present in the JOB POSTING TEXT or COMPANY INFO
- Be substantive and specific where the source supports it; be terse where it doesn't

${candidateContext}${companySection}

JOB POSTING URL: ${pageUrl}

JOB POSTING TEXT:
---
${jobText}
---

OUTPUT FORMAT (STRICT JSON ONLY, no markdown, no extra text):

{
  "verdict": "good" | "maybe" | "skip",
  "score": <number 1-10>,
  "title": "<exact title or null>",
  "company": "<exact name or null>",
  "location": "<exact or null>",
  "salary": "<exact text or null>",
  "experience_required": "<exact or null>",
  "red_flags": [],
  "summary": "<4-6 sentences. Cover: (1) what the role exists to do / problem space, (2) main responsibilities or scope, (3) tech stack and tools the JD explicitly names, (4) seniority signals (team size, leadership, ownership). Use only facts from the JD — do not pad with generic filler.>",
  "key_skills_match": ["<skill explicitly required by the JD that the candidate already has>"],
  "key_skills_missing": ["<skill explicitly required by the JD that the candidate does NOT have or cannot claim>"],
  "apply_recommendation": "<1-2 sentences. Concrete advice tailored to this candidate (e.g. 'Apply — strong stack match' / 'Skip — requires 5+ yrs Java backend which candidate lacks').>",
  "company_type": "product" | "service" | "consulting" | "staffing" | "startup" | "unknown",
  "company_industry": "<exact or unknown>",
  "company_employee_count": "<exact or null>",
  "company_assessment": "<2-4 sentences. Cover: (1) what the company does / its product or domain, (2) scale and stage signals (headcount, public/private, industry footprint), (3) any notable signals from the page (e.g. funding, growth, well-known clients) — only if explicitly present in the COMPANY INFO or JD. Do not invent reputation claims.>",
  "posted_relative": "<exact phrase from posting text describing when it was posted, e.g. '15 hours ago', '3 days ago', '1 week ago', 'Reposted 2 days ago' — or null if not present>"
}

KEY SKILLS RULES:
- Extract skills the JD *explicitly* lists as required or strongly preferred (frameworks, languages, databases, cloud, tools, paradigms).
- Compare each against the candidate's stack and "Cannot Claim" list.
- key_skills_match = JD-required skills the candidate has.
- key_skills_missing = JD-required skills the candidate lacks or cannot claim.
- Use short canonical names (e.g. "React", "Node.js", "AWS", "Kubernetes"). Do not include soft skills.
- If the JD lists no concrete skills, return empty arrays.

SCORING RULES:
- Score based ONLY on match with candidate stack
- DO NOT give high score if required skills are missing
- If experience required > candidate → reduce score
- If unclear → default to lower score

VERDICT RULES:
- "good" → score >= 7
- "maybe" → score 4-6
- "skip" → score <= 3 OR mismatch OR unpaid OR non-tech

IMPORTANT:
- If unsure → choose conservative output
- Never fabricate salary, tech stack, or company details
- Prefer null over guessing
`;
}

// Tones we rotate through for variety. Kept terse on purpose — Gemma 27b
// needs a short prompt to behave reliably.
const CONNECT_NOTE_TONES = [
  'warm and friendly',
  'polite and professional',
  'direct and concise',
  'humble and earnest',
  'confident but courteous',
];

export function pickConnectNoteTone() {
  return CONNECT_NOTE_TONES[Math.floor(Math.random() * CONNECT_NOTE_TONES.length)];
}

// One line describing the candidate for the note prompt: title (or stack)
// plus the top 8 skills, so sentence 2 has something real to pick from.
// Generic when there is no candidate — the note still has to render.
function describeConnectCandidate(candidate) {
  if (!candidate) return 'software developer.';
  const role = candidate.currentTitle
    || (candidate.stack ? `${candidate.stack} developer` : 'software developer');
  const stack = candidate.stack && !role.toLowerCase().includes(String(candidate.stack).toLowerCase())
    ? `, ${candidate.stack} stack`
    : '';
  const skills = list(candidate.skills).slice(0, 8);
  return `${role}${stack}${skills.length ? ` (${skills.join(', ')})` : ''}.`;
}

// Short prompt — generates a 3-sentence LinkedIn referral request note.
// The candidate line stays compact (title + 8 skills) so the prompt does too.
//
// `opts.retryReason` is only set on the server-side single retry path
// (too_long / too_short / missing_exp). Manual "regenerate" from the
// dashboard goes through with no retryReason and gets the default branch.
export function buildConnectNotePrompt(title, company, tone, opts = {}, candidate = null) {
  const { retryReason = null } = opts || {};
  const t = tone || pickConnectNoteTone();

  let lengthRule;
  if (retryReason === 'too_long') {
    lengthRule = `CRITICAL LENGTH BUDGET: 250-270 characters total — and SHIPPING THIS OVER 280 GETS THE NOTE REJECTED. The previous attempt EXCEEDED the cap; be ruthless: drop adjectives, shorten the opener, list 3 techs max, terser closer. Aim for ~260. Do NOT drop below 250.`;
  } else if (retryReason === 'too_short') {
    lengthRule = `CRITICAL LENGTH BUDGET: 250-270 characters total — and ANYTHING OVER 280 GETS REJECTED. The previous attempt was BELOW 250 and felt cut-off — flesh it out: name a couple more relevant techs in sentence 2, add a brief reason you're interested in the role / company in sentence 1 or 3, soften the closer. Do NOT exceed 270.`;
  } else if (retryReason === 'missing_exp') {
    lengthRule = `LENGTH BUDGET: 250-270 characters total. NON-NEGOTIABLE: the previous attempt OMITTED the {{exp}} placeholder — sentence 2 MUST contain the literal seven characters {{exp}} verbatim (open-brace open-brace e x p close-brace close-brace). Without that token the note is rejected. ALSO non-negotiable: keep length under 270.`;
  } else if (retryReason === 'missing_name') {
    lengthRule = `LENGTH BUDGET: 250-270 characters total. NON-NEGOTIABLE: the previous attempt OMITTED the {{name}} placeholder — sentence 1 MUST open with "Hi {{name}}," exactly (the eight characters {{name}} verbatim, open-brace open-brace n a m e close-brace close-brace). Without that token the note is rejected. ALSO non-negotiable: keep length under 270.`;
  } else {
    lengthRule = `LENGTH BUDGET: 230-265 characters total (sum of all three sentences). ANYTHING OVER 280 IS REJECTED — count your characters before responding. Under 220 reads cut-off; over 265 leaves no margin for {{exp}} / {{name}} substitution.`;
  }

  return `Write a short LinkedIn referral-request note in a ${t} tone.

ROLE: ${title}
COMPANY: ${company}

CANDIDATE: ${describeConnectCandidate(candidate)}

${lengthRule}

PER-SENTENCE BUDGETS (hard caps — count yourself before responding):
- Sentence 1: max 110 characters.
- Sentence 2: max 90 characters.
- Sentence 3: max 65 characters.
Sum target: 240-265. Going over ANY per-sentence cap rejects the note even if the total fits.

CONTENT — exactly 3 sentences, ONE continuous paragraph (no blank lines, no line breaks):

- Sentence 1 (≤110 chars): MUST start with the literal eight characters "Hi {{name}},". Do NOT substitute a real name, do NOT drop the braces. After the comma, mention the EXACT role title and company — then STOP the sentence.
  Example shape: "Hi {{name}}, I'm reaching out about the <ROLE> role at <COMPANY>."

- Sentence 2 (≤90 chars): EXACTLY this shape: "With {{exp}} years across <T1>, <T2>, and <T3>, I've shipped <one short outcome>."
  Pick THREE techs from the candidate list that fit this role — no more. ONE outcome clause, ≤6 words, no "and"-chains. NO second clause, NO "I've focused on… and have experience with…", NO listing extra techs after the outcome.
  {{exp}} stays a literal seven-character token (open-brace open-brace e x p close-brace close-brace). Do NOT substitute a number, do NOT translate ("X years" is wrong).

- Sentence 3 (≤65 chars): Use ONE of these closers verbatim (vary across runs for freshness — do NOT invent new ones):
    "If this looks like a fit, I'd appreciate a referral. Thanks."
    "If my background fits, a referral would mean a lot. Thanks."
    "Open to a referral if this aligns — thanks for considering."
    "If my profile fits the team, I'd love a referral. Thanks."
    "Happy to share more if a referral feels right. Thanks."

OUTPUT RULES — read carefully:
- Output ONLY the note text. Nothing else.
- The 3 sentences flow as one paragraph separated by single spaces — NO newlines, NO blank lines, NO bullets, NO numbering.
- Do NOT include a character count, word count, or any meta-commentary (no "(237 characters)", no "Length: …", no parenthetical notes about the note itself).
- No preamble ("Here is…"), no quotes around the note, no markdown, no signature, no postscript.
- Must contain BOTH the literal tokens {{name}} and {{exp}}, each exactly once.`;
}
