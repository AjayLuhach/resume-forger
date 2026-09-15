// Scanner orchestrator: blocklist short-circuit, AI invoke, filter-rule
// auto-reject, inline connect-note generation, one retry on length/format
// failure. Originally lifted from the browser extension's analyze /
// connect-note routes; the extension now reaches it through /api/ext.
//
// Storage targets:
//   - Job rows: services/apply/job-store.js (the job_tracker collection)
//   - Filters: services/scanner/filters-store.js
//
// `analyzeJob` is the single entry point. The candidate (the object
// loadCandidate() in services/feed/feed-config.js returns) is supplied by the
// caller — the scanner never loads a profile itself — and may be null, in
// which case the prompts render without the personalised section.
import { invokeModel, parseJSON, DEFAULT_SCANNER_MODEL } from './bedrock-lite.js';
import { buildAnalyzePrompt, buildConnectNotePrompt, pickConnectNoteTone } from './prompts.js';
import { readFilters } from './filters-store.js';
import { upsertScannedJob, getJobByJobId, setConnectNote } from '../apply/job-store.js';
import { saveDebugSnapshot } from './debug-store.js';
import { log } from '../log.js';

// Default scanner model. Caller can override per-request via `modelId`.
export const SCANNER_MODEL_ID = DEFAULT_SCANNER_MODEL;

// ── Filter rules ──────────────────────────────────────────────────────────

const parseRange = (str) => {
  if (!str) return null;
  const s = String(str).replace(/,/g, '');
  const range = s.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (range) return [Number(range[1]), Number(range[2])];
  const plus = s.match(/(\d+)\s*\+/);
  if (plus) return [Number(plus[1]), Infinity];
  const single = s.match(/(\d+)/);
  if (single) return [Number(single[1]), Number(single[1])];
  return null;
};

export const companyMatchesBlocklist = (companyName, blockedCompanies) => {
  if (!companyName || !blockedCompanies?.length) return null;
  const lc = companyName.toLowerCase();
  return blockedCompanies.find((b) => lc.includes(b.toLowerCase())) || null;
};

// Deterministic auto-reject reasons for an analysed row against the
// scanner_filters doc. Exported so the peer importer can apply the local
// operator's rules to rows analysed elsewhere.
export const applyFilterRules = (entry, filters) => {
  const reasons = [];
  const blockedMatch = companyMatchesBlocklist(entry.company, filters.blockedCompanies);
  if (blockedMatch) reasons.push(`company blocked: ${blockedMatch}`);

  if (filters.blockedKeywords?.length) {
    const haystack = `${entry.title || ''} ${entry.summary || ''}`.toLowerCase();
    for (const kw of filters.blockedKeywords) {
      if (haystack.includes(kw.toLowerCase())) {
        reasons.push(`keyword blocked: ${kw}`);
        break;
      }
    }
  }

  const empStr =
    entry.companyDetails?.employeesOnLinkedIn ||
    entry.companyDetails?.employeeCount ||
    entry.company_employee_count;
  const empRange = parseRange(empStr);
  if (empRange) {
    const [empMin, empMax] = empRange;
    if (filters.minEmployees != null && empMax < filters.minEmployees) {
      reasons.push(`employees ${empStr} below min ${filters.minEmployees}`);
    }
    if (filters.maxEmployees != null && empMin > filters.maxEmployees) {
      reasons.push(`employees ${empStr} above max ${filters.maxEmployees}`);
    }
  }

  const expRange = parseRange(entry.experience_required);
  if (expRange) {
    const [expMin, expMax] = expRange;
    if (filters.minExperienceYears != null && expMax < filters.minExperienceYears) {
      reasons.push(`experience ${entry.experience_required} below min ${filters.minExperienceYears}`);
    }
    if (filters.maxExperienceYears != null && expMin > filters.maxExperienceYears) {
      reasons.push(`experience ${entry.experience_required} above max ${filters.maxExperienceYears}`);
    }
  }

  return reasons;
};

// LinkedIn-style "15 hours ago" → absolute ISO. Returns null when unparseable.
const computePostedDate = (relative, referenceISO) => {
  if (!relative) return null;
  const s = String(relative).trim().toLowerCase();
  if (!s || s === 'null' || s === 'undefined') return null;
  const m = s.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const ms = {
    minute: 60_000, hour: 3_600_000, day: 86_400_000,
    week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000,
  }[unit];
  const ref = new Date(referenceISO || Date.now()).getTime();
  return new Date(ref - n * ms).toISOString();
};

// A caller-supplied date, normalised to ISO, or null when it isn't one.
const validISO = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const cleanStr = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined') return null;
  return s;
};

const KNOWN_PLATFORMS = [
  [/linkedin\.com/i, 'LinkedIn'],
  [/naukri\.com/i, 'Naukri'],
  [/indeed\.com/i, 'Indeed'],
  [/wellfound\.com/i, 'Wellfound'],
  [/instahyre\.com/i, 'Instahyre'],
  [/cutshort\.io/i, 'Cutshort'],
];

// Known boards get their display name. Anything else is labelled by its
// hostname (e.g. "boards.greenhouse.io") so the apply page can still tell
// sources apart, and 'Other' only when the URL cannot be parsed at all.
// Unknown hosts used to fall through to 'LinkedIn', which mislabelled every
// company careers page as a LinkedIn posting.
export const detectPlatform = (url) => {
  const s = String(url || '');
  for (const [re, name] of KNOWN_PLATFORMS) if (re.test(s)) return name;
  try {
    const host = new URL(s).hostname.replace(/^www\./i, '');
    return host || 'Other';
  } catch {
    return 'Other';
  }
};

// ── Connect-note generation ───────────────────────────────────────────────

const NOTE_MAX_CHARS = 280;
const NOTE_MIN_CHARS = 250;

const cleanNoteText = (raw) => {
  let s = String(raw || '')
    .replace(/^```[a-z]*\s*|\s*```$/gi, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s
      .replace(/\s*[\(\[]\s*\d+\s*(?:characters?|chars?|words?)\s*[\)\]]\s*$/i, '')
      .replace(/\s*(?:Length|Char(?:acter)?\s*count|Word\s*count)\s*[:=]\s*\d+\s*\.?\s*$/i, '')
      .trim();
    if (s === before) break;
  }
  s = s.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  return s;
};

const noteFailureReason = (note) => {
  if (!note) return 'empty';
  if (note.length > NOTE_MAX_CHARS) return 'too_long';
  if (note.length < NOTE_MIN_CHARS) return 'too_short';
  if (!note.includes('{{exp}}')) return 'missing_exp';
  if (!note.includes('{{name}}')) return 'missing_name';
  return null;
};

export async function generateConnectNote(title, company, tone, candidate = null) {
  const chosenTone = tone || pickConnectNoteTone();
  const firstPrompt = buildConnectNotePrompt(title, company, chosenTone, {}, candidate);
  const firstRaw = await invokeModel(firstPrompt, {
    modelId: SCANNER_MODEL_ID,
    maxTokens: 200,
    temperature: 0.85,
  });
  const firstNote = cleanNoteText(firstRaw);
  const failure = noteFailureReason(firstNote);
  if (!failure) return { note: firstNote, tone: chosenTone };

  const retryReason = failure === 'empty' ? 'too_short' : failure;
  log.warn('scanner:connectNote', `retry (${retryReason}) length=${firstNote.length} title="${title}" company="${company}"`);
  const retryPrompt = buildConnectNotePrompt(title, company, chosenTone, { retryReason }, candidate);
  const retryRaw = await invokeModel(retryPrompt, {
    modelId: SCANNER_MODEL_ID,
    maxTokens: 200,
    temperature: 0.5,
  });
  const retryNote = cleanNoteText(retryRaw);
  const retryFailure = noteFailureReason(retryNote);
  if (!retryFailure) return { note: retryNote, tone: chosenTone };

  // Both attempts failed validation. Pick whichever has the most
  // mandatory tokens (both placeholders > one > neither) and ship it
  // as-is. Operator preference: long notes are easier to shorten by
  // hand than short ones are to expand — no auto-truncation.
  const score = (n) => (n?.includes('{{exp}}') ? 1 : 0) + (n?.includes('{{name}}') ? 1 : 0);
  const pick = score(retryNote) >= score(firstNote) ? (retryNote || firstNote) : firstNote;
  log.warn('scanner:connectNote', `both attempts failed validation (firstLen=${firstNote.length} retryLen=${retryNote?.length || 0}) — shipping picked note as-is (${pick?.length || 0} chars)`);
  return { note: pick, tone: chosenTone };
}

// Regenerate connect-note for a known job, persisting it on the row.
export async function regenerateConnectNote({ jobId, jobLink, title, company, tone, candidate = null } = {}) {
  let resolvedTitle = (title || '').trim();
  let resolvedCompany = (company || '').trim();
  if ((!resolvedTitle || !resolvedCompany) && (jobId || jobLink)) {
    const existing = jobId ? await getJobByJobId(jobId) : null;
    if (existing) {
      resolvedTitle ||= existing.title || '';
      resolvedCompany ||= existing.company || '';
    }
  }
  if (!resolvedTitle || !resolvedCompany) {
    throw new Error('title and company required (or a jobId that resolves to both)');
  }
  const { note, tone: chosenTone } = await generateConnectNote(resolvedTitle, resolvedCompany, tone, candidate);
  if (!note) throw new Error('Empty note from model');
  if (jobId || jobLink) {
    await setConnectNote({ jobLink, jobId, note }).catch(e => {
      log.warn('scanner:connectNote', `upsert failed: ${e.message}`);
    });
  }
  return { note, tone: chosenTone, title: resolvedTitle, company: resolvedCompany };
}

// ── Analyze ───────────────────────────────────────────────────────────────

// Inputs: { jobText, pageUrl, pageTitle, jobId, companyInfo,
//           jobType, workMode, easyApply, applicantsCount, applicantsNumeric,
//           candidate, opts }
//   candidate — loadCandidate() object or null (prompt renders without it)
//   opts.skipConnectNote   — don't spend a model call on the referral note
//   opts.referencePostedAt — ISO; a stored posted_date to keep on re-analysis
// Returns: { analysis, cached, blocked }
export async function analyzeJob({
  jobText, pageUrl, pageTitle, jobId, companyInfo,
  jobType, workMode, easyApply, applicantsCount, applicantsNumeric,
  candidate = null, opts = {},
}) {
  // Capture the debug snapshot BEFORE we hit any short-circuit path. We
  // always want the "what did the extractor see?" record on file, even when
  // a cache hit / blocklist hit skips the AI invocation. The router strips
  // __debug off companyInfo so it doesn't pollute the persisted analysis.
  const debug = companyInfo?.__debug || null;
  if (debug && jobId) {
    saveDebugSnapshot(jobId, debug, {
      url: pageUrl,
      pageTitle,
      extractedCompanyInfo: companyInfo ? (() => {
        const { __debug: _d, ...rest } = companyInfo;
        return rest;
      })() : null,
    }).catch(e => log.warn('scanner:debug', `save failed: ${e.message}`));
  }
  if (companyInfo?.__debug) delete companyInfo.__debug;

  // No cache short-circuit. Every /analyze call runs the AI + upserts. The
  // double-cache (content.js GET + server-side hit-bypass) caused subtle
  // bugs where rescans no-op'd because somewhere along the way we returned
  // the stale row. Trading a few extra AI invocations for code that just
  // does what it says. If AI cost becomes a real concern, the caller
  // (content.js) is in the best position to decide "have I scanned this
  // recently?" since it knows about page-load context.

  // Blocklist short-circuit — skip the AI call entirely.
  const filters = await readFilters();
  const companyName = companyInfo?.companyName;
  const blockedMatch = companyMatchesBlocklist(companyName, filters.blockedCompanies);
  if (blockedMatch) {
    const stub = {
      jobLink: pageUrl,
      jobId,
      pageTitle,
      verdict: 'skip',
      score: 0,
      title: pageTitle || 'Blocked',
      company: companyName || blockedMatch,
      summary: `Auto-skipped: company "${companyName}" is on the blocklist (matched "${blockedMatch}").`,
      red_flags: [`Company on blocklist: ${blockedMatch}`],
      blockedReasons: [`company blocked: ${blockedMatch}`],
    };
    const saved = await upsertScannedJob(stub);
    log.info('scanner:analyze', `blocked (no AI) company="${companyName}" jobId=${jobId}`);
    return { analysis: saved, cached: false, blocked: true };
  }

  if (!jobText || jobText.trim().length < 50) {
    const msg = 'Job text too short or missing';
    log.warn('scanner:analyze', `${msg} url=${pageUrl} length=${jobText?.length || 0}`);
    const err = new Error(msg);
    err.statusCode = 400;
    throw err;
  }

  log.info('scanner:analyze', `start title="${pageTitle || ''}" url=${pageUrl} jobId=${jobId || '-'} chars=${jobText.length} model=${SCANNER_MODEL_ID} candidate=${candidate ? 'yes' : 'none'}`);

  const prompt = buildAnalyzePrompt(jobText, pageUrl, companyInfo, candidate);
  const aiResponse = await invokeModel(prompt, {
    modelId: SCANNER_MODEL_ID,
    maxTokens: 2048,
  });
  const analysis = parseJSON(aiResponse);

  // Normalize companyDetails + clean stringy nulls.
  if (companyInfo) {
    analysis.companyDetails = {
      employeeCount:
        cleanStr(companyInfo.employeeCount) ||
        cleanStr(analysis.company_employee_count) ||
        null,
      employeesOnLinkedIn: cleanStr(companyInfo.employeesOnLinkedIn) || null,
      followers: cleanStr(companyInfo.followers) || null,
      industry:
        cleanStr(companyInfo.industry) ||
        cleanStr(analysis.company_industry) ||
        null,
      listed: companyInfo.listed ?? null,
      companyLinkedIn: cleanStr(companyInfo.companyLinkedIn) || null,
      description: cleanStr(companyInfo.companyDescription?.slice(0, 500)) || null,
    };
  }
  for (const k of ['salary', 'experience_required', 'company_employee_count', 'company_industry']) {
    analysis[k] = cleanStr(analysis[k]);
  }

  log.info('scanner:analyze', `verdict=${analysis.verdict} score=${analysis.score} title="${analysis.title}" company="${analysis.company}"`);

  // Auto-reject by filter rules.
  const ruleReasons = applyFilterRules(analysis, filters);
  if (ruleReasons.length) {
    analysis.blockedReasons = ruleReasons;
    log.info('scanner:analyze', `auto-rejected by rules: ${ruleReasons.join('; ')} jobId=${jobId}`);
  }

  // Inline connect-note. We used to skip skip-verdict jobs to save AI cost,
  // but in practice users still want a referral note on those — a "skip"
  // verdict often means thin JD or missing tech stack info, not a dealbreaker.
  // Callers that re-analyse in bulk (the reanalyze route, the peer importer)
  // pass opts.skipConnectNote to keep the row's existing note instead.
  if (!opts?.skipConnectNote && analysis.title && analysis.company) {
    try {
      const { note } = await generateConnectNote(analysis.title, analysis.company, undefined, candidate);
      if (note) {
        analysis.connectNote = note;
        analysis.connectNoteAt = new Date().toISOString();
      }
    } catch (e) {
      log.warn('scanner:analyze', `connectNote inline generation failed: ${e.message}`);
    }
  }

  // Persist. The upsert keys off jobLink (= pageUrl); jobId is a secondary
  // index for the extension's cache lookup.
  const analyzedAt = new Date().toISOString();
  const platform = detectPlatform(pageUrl);

  // A re-analysis reads the same "15 hours ago" the original scrape did, so
  // anchoring it at *now* would push the posting date forward by however long
  // ago the row was first scanned. When the caller hands back the row's
  // stored posted_date as opts.referencePostedAt, that wins outright.
  const posted_date =
    validISO(opts?.referencePostedAt) ||
    analysis.posted_date ||
    computePostedDate(analysis.posted_relative, analyzedAt);

  const saved = await upsertScannedJob({
    jobLink: pageUrl,
    jobId,
    platform,
    pageTitle,
    analyzedAt,
    title: analysis.title || '',
    company: analysis.company || '',
    location: analysis.location || '',
    verdict: analysis.verdict,
    score: analysis.score,
    summary: analysis.summary || '',
    apply_recommendation: analysis.apply_recommendation || '',
    key_skills_match: analysis.key_skills_match || [],
    key_skills_missing: analysis.key_skills_missing || [],
    red_flags: analysis.red_flags || [],
    salary: analysis.salary,
    experience_required: analysis.experience_required,
    company_industry: analysis.company_industry,
    company_type: analysis.company_type,
    company_assessment: analysis.company_assessment,
    companyDetails: analysis.companyDetails,
    posted_relative: analysis.posted_relative,
    posted_date,
    connectNote: analysis.connectNote,
    connectNoteAt: analysis.connectNoteAt,
    blockedReasons: analysis.blockedReasons || [],
    // Page-scraped facets (TYPE / APPLY columns) — pass-through from
    // content.js extractor. Caller may omit these (non-LinkedIn jobs);
    // upsertScannedJob skips undefined fields without clobbering prior values.
    jobType,
    workMode,
    easyApply,
    applicantsCount,
    applicantsNumeric,
    // Only persist jobText if non-empty — keeps doc size in check.
    ...(jobText && jobText.trim() ? { jobText } : {}),
  });

  return { analysis: saved, cached: false };
}
