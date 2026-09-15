// Turn a row read from a PEER's job_tracker into a row this database will
// accept. Pure: no I/O, so it is unit-tested without Mongo.
//
// The peer's data is untrusted input. It came from a database we do not
// control, written by a version of this code we cannot see, so every field
// is whitelisted, type-checked and capped rather than copied. Anything the
// peer computed that the apply page sorts on (experienceYears*,
// employeesOnLinkedInNum, externalApply) is re-derived here with the same
// helper local scans use, so the numbers are consistent whichever way a
// row entered the tracker.
//
// Skips are the peer's own dead ends — blocklisted, thin text, unusable
// link — and the peer's rejected rows unless the operator opted in. The
// local scanner_filters then run on what survives, so the operator's own
// blocklist and size / experience limits apply to imported rows too.
import { deriveRowFacets } from '../apply/job-store.js';
import { applyFilterRules, detectPlatform } from '../scanner/index.js';

export const MIN_JOB_TEXT = 200;
const MAX_JOB_TEXT = 64 * 1024;
// A job URL longer than this is not a job URL. jobLink is the unique key and
// rides in every /api/apply/jobs response, so it is the one string a cap
// matters most on.
export const MAX_JOB_LINK = 2048;
const MAX_LONG = 4096;
const MAX_LIST = 50;
const MAX_LIST_ITEM = 200;
const VERDICTS = new Set(['good', 'maybe', 'skip']);

// Tracking parameters stripped from non-LinkedIn, non-Naukri links. The same
// job shared through two channels must land on the same jobLink or the
// unique index sees two rows.
const TRACKING_PARAMS = new Set(['src', 'sid', 'xp', 'trk']);

// ── Link normalisation ────────────────────────────────────────────────────

const LINKEDIN_VIEW_RE = /^\/jobs\/view\/(?:[^/]*?-)?(\d{6,})\/?$/;

// Canonical form of a job URL, or null when it is not an http(s) URL.
//   LinkedIn  /jobs/view/<slug-><id>  → https://www.linkedin.com/jobs/view/<id>/
//   Naukri    query string dropped (its ids live in the path)
//   others    utm_* and the usual click-tracking params dropped, hash dropped
export const normalizeJobLink = (raw) => {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length > MAX_JOB_LINK) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    const m = u.pathname.match(LINKEDIN_VIEW_RE);
    if (m) return `https://www.linkedin.com/jobs/view/${m[1]}/`;
  }
  u.hash = '';
  if (host === 'naukri.com' || host.endsWith('.naukri.com')) {
    u.search = '';
    return u.href;
  }
  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_') || TRACKING_PARAMS.has(k)) u.searchParams.delete(key);
  }
  return u.href;
};

// ── Field coercion ────────────────────────────────────────────────────────

const str = (v, max) => {
  if (v == null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return s.length > max ? s.slice(0, max) : s;
};

const iso = (v) => {
  if (!v) return null;
  if (!(v instanceof Date) && typeof v !== 'string' && typeof v !== 'number') return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const strList = (v) => {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = str(item, MAX_LIST_ITEM);
    if (s) out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return out;
};

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const put = (row, key, value) => {
  if (value === undefined || value === null) return;
  if (Array.isArray(value) && value.length === 0) return;
  row[key] = value;
};

const companyDetailsOf = (cd) => {
  if (!cd || typeof cd !== 'object' || Array.isArray(cd)) return null;
  const link = str(cd.companyLinkedIn, 300);
  const out = {
    employeeCount: str(cd.employeeCount, 100),
    employeesOnLinkedIn: str(cd.employeesOnLinkedIn, 100),
    followers: str(cd.followers, 100),
    industry: str(cd.industry, 200),
    listed: typeof cd.listed === 'boolean' ? cd.listed : str(cd.listed, 100),
    companyLinkedIn: link && /^https?:\/\//i.test(link) ? link : null,
    description: str(cd.description, MAX_LONG),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
};

const mentionsBlocklist = (doc) => {
  const summary = typeof doc.summary === 'string' ? doc.summary.trim() : '';
  if (/^auto-skipped/i.test(summary)) return true;
  if (Array.isArray(doc.red_flags) && doc.red_flags.some((f) => /blocklist/i.test(String(f)))) return true;
  return false;
};

// The subset of a sanitised row that is "analysis": what may be $set onto a
// local row that exists but was never analysed (a clipboard import, say).
// Identity (jobLink, jobId, platform, createdAt), the operator's decision
// (rowStatus, rejected*) and users.* are never in it.
export const ANALYSIS_FIELDS = [
  'title', 'company', 'location', 'pageTitle', 'jobText',
  'salary', 'experience_required', 'posted_date', 'posted_relative',
  'jobType', 'workMode', 'easyApply', 'applicantsCount', 'applicantsNumeric',
  'company_industry', 'company_type', 'company_assessment',
  'summary', 'apply_recommendation', 'verdict', 'score',
  'key_skills_match', 'key_skills_missing', 'red_flags',
  'analyzedAt', 'hr', 'contact', 'companyDetails',
  'experienceYearsMin', 'experienceYearsMax', 'externalApply',
  'blockedReasons', 'importedFrom',
];

export const analysisFieldsOf = (row) => {
  const out = {};
  for (const k of ANALYSIS_FIELDS) if (row[k] !== undefined) out[k] = row[k];
  return out;
};

// ── The sanitiser ─────────────────────────────────────────────────────────

// doc — a raw peer row; ctx — { peerId, label, now, filters?, includePeerRejected? }
// Returns { row, skipReason }: exactly one of the two is set.
export const sanitizePeerJob = (doc, ctx = {}) => {
  const skip = (reason) => ({ row: null, skipReason: reason });
  if (!doc || typeof doc !== 'object') return skip('not a document');

  const now = iso(ctx.now) || new Date().toISOString();
  const label = String(ctx.label || 'peer');

  const jobText = typeof doc.jobText === 'string' ? doc.jobText : '';
  if (jobText.trim().length < MIN_JOB_TEXT) return skip('job text too short');
  const analyzedAt = iso(doc.analyzedAt);
  if (!analyzedAt) return skip('not analysed');
  // A row the peer itself imported is somebody else's analysis wearing the
  // peer's label — and with two databases peering each other, a row deleted
  // here would come straight back relabelled as theirs.
  if (doc.importedFrom) return skip('second-hand');
  if (Array.isArray(doc.blockedReasons) && doc.blockedReasons.length) return skip('blocked on the peer');
  if (mentionsBlocklist(doc)) return skip('blocked on the peer');
  const peerRejected = doc.rowStatus === 'rejected';
  if (peerRejected && !ctx.includePeerRejected) return skip('rejected on the peer');

  const rawLink = typeof doc.jobLink === 'string' ? doc.jobLink.trim() : '';
  const jobLink = normalizeJobLink(rawLink);
  if (!jobLink) return skip('bad job link');

  const row = { jobLink };
  const linkId = jobLink.match(/\/jobs\/view\/(\d+)\//)?.[1] || null;
  put(row, 'jobId', str(doc.jobId, 100) || linkId);
  put(row, 'platform', str(doc.platform, 60) || detectPlatform(jobLink));
  put(row, 'title', str(doc.title, 300));
  put(row, 'company', str(doc.company, 300));
  put(row, 'location', str(doc.location, 300));
  put(row, 'pageTitle', str(doc.pageTitle, 300));
  row.jobText = jobText.length > MAX_JOB_TEXT ? jobText.slice(0, MAX_JOB_TEXT) : jobText;
  put(row, 'salary', str(doc.salary, 200));
  put(row, 'experience_required', str(doc.experience_required, 200));
  put(row, 'posted_date', iso(doc.posted_date));
  put(row, 'posted_relative', str(doc.posted_relative, 200));
  put(row, 'jobType', str(doc.jobType, 60));
  put(row, 'workMode', str(doc.workMode, 60));
  if (typeof doc.easyApply === 'boolean') row.easyApply = doc.easyApply;
  put(row, 'applicantsCount', str(doc.applicantsCount, 60));
  put(row, 'applicantsNumeric', finite(doc.applicantsNumeric));
  put(row, 'company_industry', str(doc.company_industry, 200));
  put(row, 'company_type', str(doc.company_type, 200));
  put(row, 'company_assessment', str(doc.company_assessment, MAX_LONG));
  put(row, 'summary', str(doc.summary, MAX_LONG));
  put(row, 'apply_recommendation', str(doc.apply_recommendation, MAX_LONG));
  const verdict = typeof doc.verdict === 'string' ? doc.verdict.trim().toLowerCase() : '';
  put(row, 'verdict', VERDICTS.has(verdict) ? verdict : null);
  const score = finite(typeof doc.score === 'string' ? Number(doc.score) : doc.score);
  put(row, 'score', score !== null && score >= 0 && score <= 10 ? score : null);
  put(row, 'key_skills_match', strList(doc.key_skills_match));
  put(row, 'key_skills_missing', strList(doc.key_skills_missing));
  put(row, 'red_flags', strList(doc.red_flags));
  row.analyzedAt = analyzedAt;
  put(row, 'hr', str(doc.hr, 300));
  put(row, 'contact', str(doc.contact, 300));
  put(row, 'companyDetails', companyDetailsOf(doc.companyDetails));

  // Derived facets: always ours, never the peer's.
  const facets = deriveRowFacets({
    jobText: row.jobText,
    experience_required: row.experience_required,
    companyDetails: row.companyDetails,
  });
  if (facets.employeesOnLinkedInNum != null && row.companyDetails) {
    row.companyDetails.employeesOnLinkedInNum = facets.employeesOnLinkedInNum;
  }
  put(row, 'experienceYearsMin', facets.experienceYearsMin);
  put(row, 'experienceYearsMax', facets.experienceYearsMax);
  put(row, 'externalApply', facets.externalApply);

  row.createdAt = now;
  row.importedFrom = {
    peerId: ctx.peerId || null,
    label,
    at: now,
    peerJobLink: str(rawLink, MAX_JOB_LINK),
    peerCreatedAt: iso(doc.createdAt),
    peerAnalyzedAt: analyzedAt,
    peerRowStatus: typeof doc.rowStatus === 'string' ? doc.rowStatus : null,
  };

  if (peerRejected) {
    row.rowStatus = 'rejected';
    row.rejectedAt = now;
    row.rejectedBy = `peer:${label}`;
    const notes = [str(doc.rejectedNotes, MAX_LONG), ...strList(doc.blockedReasons)].filter(Boolean);
    row.rejectedNotes = notes.join('; ');
  }

  // The operator's own rules, applied to a row analysed elsewhere. A peer's
  // rejection keeps its attribution; the reasons are recorded either way.
  if (ctx.filters) {
    const reasons = applyFilterRules(row, ctx.filters);
    if (reasons.length) {
      row.blockedReasons = reasons;
      if (row.rowStatus !== 'rejected') {
        row.rowStatus = 'rejected';
        row.rejectedAt = now;
        row.rejectedBy = 'system:peer-import';
        row.rejectedNotes = reasons.join('; ');
      }
    }
  }

  return { row, skipReason: null };
};
