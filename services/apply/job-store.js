// Job-tracker storage. Backed by the `job_tracker` collection.
//
// MODEL (single user, single database):
//   - `rowStatus` is ROW-LEVEL: 'rejected' is the user's "don't bother
//     applying" decision. Absent / 'pending' is the default. One toggle per
//     row; `rejectedBy` records who set it (the username, or a tool tag such
//     as "Claude" for rule-based triage).
//   - `users.<username>` is the user's APPLY state on the row — applied /
//     interviewing / success, with feedback, notes and interview dates. The
//     map shape is kept (rather than flattening to top-level fields) because
//     every existing row, index (`apply_<Name>_1`) and mirror snapshot
//     carries it, and a peer's exported rows use the same layout under their
//     own username.
//
// DISPLAY priority for a row:
//   1. users.<me> has an active state (applied/interviewing/success) → that.
//   2. rowStatus === 'rejected' → Rejected.
//   3. Otherwise → Pending (the triage queue).
//
// Rows imported from a peer database (services/peers/) arrive as pending
// rows with `importedFrom` set; the first local /analyze on the row clears
// it, because from then on the analysis is the user's own.
//
// Schema:
//   {
//     jobLink: string (unique),
//     jobId: string,
//     platform, title, company, location, hr, contact: string,
//     createdAt: ISO,
//     rowStatus: 'rejected' | undefined,    // ROW-LEVEL toggle
//
//     // Scanner analysis (row-level, set by /analyze):
//     verdict, score, summary, apply_recommendation,
//     key_skills_match, key_skills_missing, red_flags,
//     salary, experience_required,
//     company_industry, company_type, company_assessment,
//     companyDetails: { employeeCount, employeesOnLinkedIn, ... },
//     posted_date, posted_relative,
//     analyzedAt, pageTitle, jobText,
//     connectNote, connectNoteAt,
//     blockedReasons,
//     importedFrom: { peerId, label, at, peerJobLink, peerCreatedAt,
//                     peerAnalyzedAt, peerRowStatus } | absent,
//
//     users: {
//       <username>: {
//         applied: boolean,                  // true ⇒ user has an active state
//         status: 'applied'|'interviewing'|'success',
//         feedback, notes: string,
//         appliedAt, statusUpdatedAt: ISO,
//         interviewDates: [ISO]
//       }
//     }
//   }
//
// Backward compatibility: legacy docs stored applied as 'Yes' string and
// status as title-case 'Applied'|'Waiting'|'Rejected'. coerceUserSub() reads
// those tolerantly. Writes go through the new shape only.
//
// Historical legacy: some rows still carry users.<u>.status='rejected' from
// the very first migration before we settled on the row-level model. Those
// are ignored by display priority but kept on disk for audit.
import { col } from '../db.js';
import { jobTrackerMirror } from '../mirror.js';
import { extractExternalApply, hasExternalApply } from './external-apply.js';

// Toggle for the in-memory mirror. All read paths consult the mirror once
// it's loaded; write paths still go to Mongo first (authoritative), then
// update the mirror with the post-write doc. Setting this to false makes
// the system fall back to direct Mongo reads (the old path) for debugging
// any mirror-vs-Mongo drift.
const USE_MIRROR = true;
const mirrorReady = () => USE_MIRROR && jobTrackerMirror.loaded;

let _indexed = false;
// Resilient createIndex — swallow "already exists with different name" /
// "already exists with different options" errors so a one-off historical
// index-name drift doesn't crash every page load. Real errors (network,
// auth) still throw.
const safeCreateIndex = async (c, keys, opts) => {
  try {
    await c.createIndex(keys, opts);
  } catch (e) {
    if (/already exists with a different/i.test(e.message)) return;
    throw e;
  }
};
const ensureIndex = async () => {
  if (_indexed) return;
  const c = await col('job_tracker');
  // Identity indexes.
  await safeCreateIndex(c, { jobLink: 1 }, { unique: true });
  await safeCreateIndex(c, { createdAt: -1 });
  // jobId is the extension's lookup key (one platform-side id per row); not
  // unique because legacy rows may share blanks.
  await safeCreateIndex(c, { jobId: 1 });
  // Sort/filter indexes used by the new apply.html columns + sort dropdown.
  // All sparse — pre-merge rows have no scanner data and shouldn't bloat the
  // index. Compound (verdict, score desc) covers the common "show me 'good'
  // jobs, top scores first" path. ~3ms on 3300-row collections in Atlas.
  await safeCreateIndex(c, { verdict: 1, score: -1 }, { sparse: true });
  await safeCreateIndex(c, { score: -1 }, { sparse: true });
  await safeCreateIndex(c, { 'companyDetails.employeesOnLinkedInNum': -1 }, { sparse: true });
  await safeCreateIndex(c, { experienceYearsMin: -1 }, { sparse: true });
  await safeCreateIndex(c, { analyzedAt: -1 }, { sparse: true });
  await safeCreateIndex(c, { title: 1 });
  // Row-level rejected — used by every read (pending excludes, rejected
  // counts, active-status filters exclude).
  await safeCreateIndex(c, { rowStatus: 1 }, { sparse: true });
  // Applicant-count sort: 'show me jobs with fewest applicants first' for
  // less-competitive pickings. Sparse — legacy rows have no value.
  await safeCreateIndex(c, { applicantsNumeric: -1 }, { sparse: true });
  // Compound for the Rejected tab: filter by rowStatus + sort by _id desc in
  // one index pass. Without this, mongo picks rowStatus_1, fetches all
  // rejected rows, then sorts in memory — slow when there are many.
  await safeCreateIndex(c, { rowStatus: 1, _id: -1 }, { sparse: true });
  _indexed = true;
};

// Fields to drop on list reads. `jobText` is the raw scraped JD (often
// 5–20 KB) and is never rendered in the apply table — only in the scanner
// re-analysis flow. Excluding it cuts the response payload of a 100-row
// rejected page from ~2 MB to ~200 KB.
const LIST_PROJECTION = { jobText: 0 };

// updatedAt is auto-stamped on every write — see services/db.js `col()`.
// All updateOne/updateMany/bulkWrite calls against job_tracker get
// `$currentDate: { updatedAt: true }` merged in automatically. The
// mirror's delta-sync loop relies on this to pick up cross-server writes.

// Workflow: pending → applied → interviewing → success | rejected.
// Pending isn't a stored value (it means "no users.<key> entry" OR an entry
// that hasn't reached a final state yet), but it's recognized as a write
// target so a Reset button can roll a user back.
export const STATUSES = [
  'applied',
  'interviewing',
  'success',
  'rejected',
  // Legacy schema values still accepted on write for backward compat — an
  // imported or hand-migrated row may still carry them, and coerceStatus()
  // below folds each one into the four real states on read. Kept so an old
  // client sending 'offer' doesn't get a 400; new UI code never sends them.
  'screening',
  'offer',
  'ghosted',
  'withdrawn',
];

const coerceStatus = (raw) => {
  if (!raw) return 'applied';
  const s = String(raw).toLowerCase().trim();
  // Legacy → simplified value mapping. "expired" used to be a status;
  // it's been retired — anything in that bucket folds back to applied.
  if (s === 'waiting') return 'applied';
  if (s === 'screening') return 'applied';
  if (s === 'expired') return 'applied';
  if (s === 'offer') return 'success';
  if (s === 'ghosted' || s === 'withdrawn' || s === 'no response' || s === 'no-response') return 'applied';
  if (s === 'interview') return 'interviewing';
  if (s === 'pending') return 'applied'; // no-op fallback; pending isn't stored
  if (STATUSES.includes(s)) return s;
  return 'applied';
};

const coerceUserSub = (legacy) => {
  if (!legacy) return null;
  const status = coerceStatus(legacy.status);
  const applied =
    legacy.applied === true ||
    (typeof legacy.applied === 'string' && legacy.applied.toLowerCase() === 'yes') ||
    // Rejected-from-pending stores applied=false intentionally — don't coerce
    // it back to true based on status presence.
    (!!status && status !== 'rejected' && legacy.applied !== false);
  return {
    applied,
    status,
    feedback: legacy.feedback || '',
    notes: legacy.notes || '',
    appliedAt: legacy.appliedAt || (applied ? legacy.updatedAt || null : null),
    rejectedAt: legacy.rejectedAt || null,
    statusUpdatedAt: legacy.statusUpdatedAt || legacy.updatedAt || null,
    interviewDates: Array.isArray(legacy.interviewDates) ? legacy.interviewDates : [],
  };
};

const hydrate = (doc) => {
  if (!doc) return null;
  const users = {};
  for (const [k, v] of Object.entries(doc.users || {})) users[k] = coerceUserSub(v);
  return {
    _id: doc._id,
    jobLink: doc.jobLink,
    jobId: doc.jobId || (doc.jobLink?.match(/(\d+)/)?.[1]) || '',
    platform: doc.platform || 'LinkedIn',
    title: doc.title || '',
    company: doc.company || '',
    location: doc.location || '',
    hr: doc.hr || '',
    contact: doc.contact || '',
    createdAt: doc.createdAt || null,
    // Row-level rejection — the user's "don't apply" decision. When set to
    // 'rejected' the row leaves the pending queue. An active apply state on
    // users.<me> still overrides it for display — see comment at top of file.
    rowStatus: doc.rowStatus || null,
    rejectedAt: doc.rejectedAt || null,
    rejectedBy: doc.rejectedBy || null,
    rejectedNotes: doc.rejectedNotes || '',
    // Provenance for rows pulled from a peer database (services/peers/).
    // Null for rows the user scanned themselves; cleared by the next local
    // /analyze so the badge only shows while the analysis is still the
    // peer's.
    importedFrom: doc.importedFrom || null,

    // Scanner analysis fields. All optional — pre-scanner rows have none of
    // these and the UI should treat absent values as "not yet analyzed".
    verdict: doc.verdict || null,
    score: typeof doc.score === 'number' ? doc.score : (doc.score ? Number(doc.score) : null),
    summary: doc.summary || '',
    apply_recommendation: doc.apply_recommendation || '',
    key_skills_match: doc.key_skills_match || [],
    key_skills_missing: doc.key_skills_missing || [],
    red_flags: doc.red_flags || [],
    salary: doc.salary || '',
    experience_required: doc.experience_required || '',
    company_industry: doc.company_industry || '',
    company_type: doc.company_type || '',
    company_assessment: doc.company_assessment || '',
    companyDetails: doc.companyDetails || null,
    posted_date: doc.posted_date || null,
    posted_relative: doc.posted_relative || null,
    analyzedAt: doc.analyzedAt || null,
    pageTitle: doc.pageTitle || '',
    connectNote: doc.connectNote || '',
    connectNoteAt: doc.connectNoteAt || null,
    blockedReasons: doc.blockedReasons || [],
    // Job-type / work-mode / applicant headcount — scraped from the
    // listing page at /analyze time. Older rows may not have these (they
    // pre-date the extractor). UI shows '—' when null/missing.
    jobType:     doc.jobType     || null,   // e.g. 'Full-time', 'Contract'
    workMode:    doc.workMode    || null,   // 'On-site' / 'Remote' / 'Hybrid'
    easyApply:   doc.easyApply ?? null,
    applicantsCount:   doc.applicantsCount   || null,  // display string ('Over 100')
    applicantsNumeric: doc.applicantsNumeric ?? null,  // sort key (Number or null)
    // External-apply signals extracted from jobText at scan-time. Null
    // (not {}) when the JD had no detectable external channel — the UI
    // skips rendering the indicator strip on null.
    externalApply: hasExternalApply(doc.externalApply) ? doc.externalApply : null,
    // Numeric facets — parsed from companyDetails / experience_required at
    // write-time so the UI can sort/filter on them without re-parsing strings.
    employeesOnLinkedInNum: doc.companyDetails?.employeesOnLinkedInNum
      ?? doc.employeesOnLinkedInNum ?? null,
    experienceYearsMin: doc.experienceYearsMin ?? null,
    experienceYearsMax: doc.experienceYearsMax ?? null,
    // jobText omitted on hydrate — usually large and only needed for re-analysis.

    users,
  };
};

// Parse strings like "10000+", "5,001-10,000 employees", "201-500" → leading
// integer. The leading number is the most useful sort key.
const parseLeadingNum = (s) => {
  if (s == null) return null;
  const str = String(s).replace(/,/g, '');
  const m = str.match(/(\d+)/);
  return m ? Number(m[1]) : null;
};

// Parse experience strings into [min, max]. Handles:
//   "3-5 years"        → [3, 5]
//   "2.5-5 Years"      → [2.5, 5]      (was buggy: matched 5-5 because the
//                                       integer-only regex skipped the 2 in 2.5)
//   "5+ years"         → [5, null]
//   "2 years"          → [2, 2]
//   "Minimum of 3 yrs" → [3, 3]        (first integer wins as last resort)
const parseYearsRange = (s) => {
  if (!s) return [null, null];
  const str = String(s).replace(/,/g, '');
  // Decimal-aware range. The previous regex `(\d+)\s*[-–]\s*(\d+)` couldn't
  // match "2.5-5" — it'd skip the leading "2", match the trailing "5-5",
  // and return [5, 5] which sorted ahead of "4+ years". Now (\d+(?:\.\d+)?)
  // captures the full decimal so "2.5-5" → [2.5, 5].
  const range = str.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (range) return [Number(range[1]), Number(range[2])];
  const plus = str.match(/(\d+(?:\.\d+)?)\s*\+/);
  if (plus) return [Number(plus[1]), null];
  const single = str.match(/(\d+(?:\.\d+)?)/);
  if (single) return [Number(single[1]), Number(single[1])];
  return [null, null];
};

// Numeric / structured facets derived from a row's text fields. One
// definition shared by upsertScannedJob (local scans) and the peer importer
// (services/peers/sanitize.js), so a row derives identically whichever way
// it entered the tracker — the apply page sorts and filters on these.
//
//   externalApply          — apply channels found in the JD text, or null
//                            when there is no text to look at
//   experienceYears{Min,Max} — parsed from experience_required
//   employeesOnLinkedInNum — leading integer of the LinkedIn headcount,
//                            else of the size band, else null
export const deriveRowFacets = ({ jobText, experience_required, companyDetails } = {}) => {
  const text = jobText && String(jobText).trim() ? String(jobText) : '';
  const [experienceYearsMin, experienceYearsMax] = parseYearsRange(experience_required);
  const cd = companyDetails || {};
  const employeesOnLinkedInNum =
    parseLeadingNum(cd.employeesOnLinkedIn)
    ?? parseLeadingNum(cd.employeeCount)
    ?? (Number.isFinite(cd.employeesOnLinkedInNum) ? cd.employeesOnLinkedInNum : null);
  return {
    externalApply: text ? extractExternalApply(text) : null,
    experienceYearsMin,
    experienceYearsMax,
    employeesOnLinkedInNum,
  };
};

// ── Reads ────────────────────────────────────────────────────────────────

// Status counts for the user: { users: [username], counts: { [username]:
// { applied, interviewing, success, rejected, total } }, total }. `total` is
// the row count of the whole tracker. The one-element `users` array and the
// per-username `counts` map are kept so the apply page's existing shape
// still works; there is exactly one entry.
export const getUsersAndCounts = async ({ username } = {}) => {
  await ensureIndex();
  if (!username) throw new Error('getUsersAndCounts: username required');
  const c = await col('job_tracker');

  // ── Mirror path ── four scans over a ~3k-doc Map, sub-millisecond.
  if (mirrorReady()) {
    const rejected = jobTrackerMirror.count(d => d.rowStatus === 'rejected');
    const total = jobTrackerMirror.size();
    const matchActive = (st) => jobTrackerMirror.count(d =>
      d.rowStatus !== 'rejected' &&
      d.users?.[username]?.applied === true &&
      d.users?.[username]?.status === st
    );
    const a = matchActive('applied');
    const i = matchActive('interviewing');
    const su = matchActive('success');
    return {
      users: [username],
      counts: { [username]: { applied: a, interviewing: i, success: su, rejected, total: a + i + su + rejected } },
      total,
    };
  }

  // Mongo fallback (the few seconds before the mirror loads): one $facet
  // with a flat $match per branch, each served by rowStatus_1 or the
  // per-user compound index apply_<Name>_1 (see createUser in auth-store).
  const active = (st) => [
    { $match: {
      rowStatus: { $ne: 'rejected' },
      [`users.${username}.applied`]: true,
      [`users.${username}.status`]: st,
    } },
    { $count: 'n' },
  ];
  const [r] = await c.aggregate([{ $facet: {
    total: [{ $count: 'n' }],
    rejected: [{ $match: { rowStatus: 'rejected' } }, { $count: 'n' }],
    applied: active('applied'),
    interviewing: active('interviewing'),
    success: active('success'),
  } }]).toArray();
  const pick = (k) => r?.[k]?.[0]?.n || 0;
  const a = pick('applied'), i = pick('interviewing'), su = pick('success'), rejected = pick('rejected');
  return {
    users: [username],
    counts: { [username]: { applied: a, interviewing: i, success: su, rejected, total: a + i + su + rejected } },
    total: pick('total'),
  };
};

// Build the "pending" mongo filter clause — the user's triage queue.
//
//   pending = rowStatus is NOT 'rejected'
//             AND the user has no active sub-doc (applied !== true)
//
// We don't filter on users.<u>.status — the row-level rowStatus is
// authoritative for rejection, and the sub-doc only ever holds active states.
const pendingClause = (user) => ({
  $and: [
    { rowStatus: { $ne: 'rejected' } },
    {
      $or: [
        { [`users.${user}`]: { $exists: false } },
        { [`users.${user}.applied`]: { $ne: true } },
      ],
    },
  ],
});

// Sortable fields the client can request via `sort=<field>` /
// `dir=<asc|desc>`. Each maps to a mongo sort spec — we keep _id desc as a
// tiebreaker for stable ordering across pages.
const SORT_FIELDS = {
  newest:    [['_id', -1]],
  oldest:    [['_id',  1]],
  date_desc: [['createdAt', -1], ['_id', -1]],
  date_asc:  [['createdAt',  1], ['_id', -1]],
  score_desc: [['score', -1], ['_id', -1]],
  score_asc:  [['score',  1], ['_id', -1]],
  employees_desc: [['companyDetails.employeesOnLinkedInNum', -1], ['_id', -1]],
  employees_asc:  [['companyDetails.employeesOnLinkedInNum',  1], ['_id', -1]],
  exp_desc: [['experienceYearsMin', -1], ['_id', -1]],
  exp_asc:  [['experienceYearsMin',  1], ['_id', -1]],
  // Sort by applicant count — popular jobs first (or least competition first).
  applicants_desc: [['applicantsNumeric', -1], ['_id', -1]],
  applicants_asc:  [['applicantsNumeric',  1], ['_id', -1]],
  title_asc:  [['title',   1], ['_id', -1]],
  title_desc: [['title',  -1], ['_id', -1]],
  verdict_desc: [['score', -1], ['verdict', 1], ['_id', -1]], // good-first
  // Easy-Apply first: boolean desc puts true → false → null. Useful for
  // "knock out the one-click apps before tackling external forms".
  easyapply_first: [['easyApply', -1], ['_id', -1]],
  // Job type alphabetical. Both mirror + Mongo sort missing values last
  // in desc; mongo sorts missing first in asc (mirror sorts them last).
  // Acceptable for the rare rows missing jobType.
  type_asc:  [['jobType',  1], ['_id', -1]],
  type_desc: [['jobType', -1], ['_id', -1]],
};

// rows sort last.
const resolveSortPairs = (sort, { user, statusUser } = {}) => {
  if (sort === 'applied_desc') {
    const u = statusUser || user;
    return u
      ? [[`users.${u}.appliedAt`, -1], ['_id', -1]]
      : [['updatedAt', -1], ['_id', -1]];
  }
  return SORT_FIELDS[sort] || [['_id', -1]];
};

// Verdict filter ('good'|'maybe'|'skip'|'') — applied as a top-level $match.
// Combines with status / statusUser filters.
const VERDICT_FIELD = 'verdict';

// Every status other than the row-level 'rejected' is read off
// users.<statusUser>, so a caller asking for status without saying whose is
// a bug — there used to be an "any user has this status" fallback for the
// shared-pool view, and it is gone with the pool.
const assertStatusScope = (status, statusUser) => {
  if (status && status !== 'rejected' && !statusUser) {
    throw new Error(`job-store: status="${status}" requires statusUser`);
  }
};

// In-memory predicate that mirrors the Mongo filter assembled in listJobs.
// Kept as a single function (rather than re-deriving the predicate per
// caller) so the mirror-backed list/count/stats paths share one definition.
const buildMatcher = ({ user, status, statusUser, q, platform, verdict, hasContact } = {}) => {
  const escQ = q ? new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  assertStatusScope(status, statusUser);
  return (doc) => {
    if (user && status !== 'rejected' && !doc.users?.[user]?.applied) return false;
    if (platform && doc.platform !== platform) return false;
    if (verdict && doc[VERDICT_FIELD] !== verdict) return false;
    if (hasContact) {
      const e = doc.externalApply;
      // New shape (emails/phones/links) + legacy fallback (forms/ats/whatsapp)
      // for rows not yet re-backfilled.
      if (!e || (
        !e.emails?.length && !e.phones?.length && !e.links?.length &&
        !e.forms?.length  && !e.ats?.length    && !e.whatsapp?.length
      )) return false;
    }
    if (escQ) {
      const hay = `${doc.title || ''}\n${doc.company || ''}\n${doc.jobLink || ''}\n${doc.location || ''}`;
      if (!escQ.test(hay)) return false;
    }
    if (status) {
      if (status === 'pending' && statusUser) {
        if (doc.rowStatus === 'rejected') return false;
        const sub = doc.users?.[statusUser];
        if (sub && sub.applied === true) return false;
      } else if (status === 'rejected') {
        if (doc.rowStatus !== 'rejected') return false;
      } else {
        const sub = doc.users?.[statusUser];
        if (!sub?.applied) return false;
        if (sub.status !== status) return false;
        if (doc.rowStatus === 'rejected') return false;
      }
    }
    return true;
  };
};

// Compare helper that handles strings, numbers, dates, and missing values
// (null/undefined always sort last regardless of direction).
const _cmp = (a, b, dir) => {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a < b) return -1 * dir;
  if (a > b) return  1 * dir;
  return 0;
};

const _getPath = (doc, path) => {
  if (path === '_id') return String(doc._id || '');
  if (!path.includes('.')) return doc[path];
  let v = doc;
  for (const k of path.split('.')) {
    if (v == null) return undefined;
    v = v[k];
  }
  return v;
};

const _sortIn = (docs, sortPairs) => {
  const pairs = sortPairs.map(([k, dir]) => [k, dir > 0 ? 1 : -1]);
  docs.sort((a, b) => {
    for (const [k, dir] of pairs) {
      const c = _cmp(_getPath(a, k), _getPath(b, k), dir);
      if (c !== 0) return c;
    }
    return 0;
  });
  return docs;
};

// List a page of the tracker.
//
//   user        — scope to the APPLIED pipeline: rows where users.<user>
//                 .applied is true (ignored for status='rejected', which is
//                 row-level). Pass null for the triage queue.
//   status      — 'pending' | 'applied' | 'interviewing' | 'success' |
//                 'rejected'
//   statusUser  — whose users.<name> sub-doc `status` reads (required for
//                 every status except 'rejected')
//
// The triage queue is therefore { user: null, statusUser: me, status:
// 'pending' }; the applied tab is { user: me, statusUser: me, status:
// 'applied' }. Combining user=me with status='pending' asks for "applied
// AND not applied" and returns nothing — see CLAUDE.md.
export const listJobs = async (params = {}) => {
  await ensureIndex();
  const { user, status, statusUser, q, platform, verdict, sort, limit = 200, skip = 0, hasContact } = params;
  assertStatusScope(status, statusUser);

  // ── Mirror path ──
  // Once the in-memory mirror is loaded, list reads are served entirely from
  // process memory — same filter semantics, same sort spec, same hydrate.
  // No Mongo round-trip. Sub-millisecond on a 30k-doc collection.
  if (mirrorReady()) {
    const matcher = buildMatcher({ user, status, statusUser, q, platform, verdict, hasContact });
    const matched = jobTrackerMirror.filter(matcher);
    const sortPairs = resolveSortPairs(sort, { user, statusUser });
    _sortIn(matched, sortPairs);
    const cappedLimit = Math.min(Math.max(1, parseInt(limit) || 200), 2000);
    const cappedSkip  = Math.max(0, parseInt(skip) || 0);
    return matched.slice(cappedSkip, cappedSkip + cappedLimit).map(hydrate);
  }

  const filter = {};
  // `user` scopes to the applied pipeline: rows the user has engaged with
  // (applied=true). EXCEPT when the caller is asking for the Rejected tab —
  // rejected is row-level, so intersecting it with users.<u>.applied=true
  // would always be empty (applying un-rejects the row, see updateUserStatus).
  if (user && status !== 'rejected') {
    filter[`users.${user}.applied`] = true;
  }
  if (platform) filter.platform = platform;
  if (verdict) filter[VERDICT_FIELD] = verdict;
  if (q) {
    const re = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: re }, { company: re }, { jobLink: re }, { location: re }];
  }
  if (hasContact) {
    filter.$and = [...(filter.$and || []), {
      $or: [
        { 'externalApply.emails.0':   { $exists: true } },
        { 'externalApply.phones.0':   { $exists: true } },
        { 'externalApply.links.0':    { $exists: true } },
        // Legacy fields kept until backfill rewrites every row.
        { 'externalApply.forms.0':    { $exists: true } },
        { 'externalApply.ats.0':      { $exists: true } },
        { 'externalApply.whatsapp.0': { $exists: true } },
      ],
    }];
  }
  if (status) {
    if (status === 'pending' && statusUser) {
      filter.$and = [...(filter.$and || []), pendingClause(statusUser)];
    } else if (status === 'rejected') {
      // Row-level. statusUser is ignored.
      filter.rowStatus = 'rejected';
    } else {
      // Active states: applied / interviewing / success. Row-level rejected
      // takes precedence in display priority — exclude those rows even if a
      // stale sub-doc state lingers from legacy data.
      filter[`users.${statusUser}.applied`] = true;
      filter[`users.${statusUser}.status`] = status;
      filter.rowStatus = { $ne: 'rejected' };
    }
  }

  const c = await col('job_tracker');
  const cappedLimit = Math.min(Math.max(1, parseInt(limit) || 200), 2000);
  const cappedSkip  = Math.max(0, parseInt(skip) || 0);
  // Resolve sort spec. Default to _id desc (newest add at the top — ObjectId
  // encodes timestamp + counter so this is stable across re-runs and works
  // for both freshly-scanned rows and the bulk-migrated batch).
  const sortPairs = resolveSortPairs(sort, { user, statusUser });
  const sortSpec = Object.fromEntries(sortPairs);
  const docs = await c
    .find(filter, { projection: LIST_PROJECTION })
    .sort(sortSpec)
    .skip(cappedSkip)
    .limit(cappedLimit)
    .toArray();
  return docs.map(hydrate);
};

// Same filter logic as listJobs but returns the TOTAL count instead of a
// page of items. Cheap — uses countDocuments against the same mongo filter,
// no sort or page traversal. Used by /api/apply/jobs to surface "showing
// 100 of 432" so the user knows the page is a slice, not the whole set.
export const countJobs = async (params = {}) => {
  await ensureIndex();
  const { user, status, statusUser, q, platform, verdict, hasContact } = params;
  assertStatusScope(status, statusUser);

  if (mirrorReady()) {
    return jobTrackerMirror.count(buildMatcher({ user, status, statusUser, q, platform, verdict, hasContact }));
  }

  const filter = {};
  if (user && status !== 'rejected') {
    filter[`users.${user}.applied`] = true;
  }
  if (platform) filter.platform = platform;
  if (verdict) filter[VERDICT_FIELD] = verdict;
  if (q) {
    const re = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: re }, { company: re }, { jobLink: re }, { location: re }];
  }
  if (hasContact) {
    filter.$and = [...(filter.$and || []), {
      $or: [
        { 'externalApply.emails.0':   { $exists: true } },
        { 'externalApply.phones.0':   { $exists: true } },
        { 'externalApply.links.0':    { $exists: true } },
        // Legacy fields kept until backfill rewrites every row.
        { 'externalApply.forms.0':    { $exists: true } },
        { 'externalApply.ats.0':      { $exists: true } },
        { 'externalApply.whatsapp.0': { $exists: true } },
      ],
    }];
  }
  if (status) {
    if (status === 'pending' && statusUser) {
      filter.$and = [...(filter.$and || []), pendingClause(statusUser)];
    } else if (status === 'rejected') {
      filter.rowStatus = 'rejected';
    } else {
      filter[`users.${statusUser}.applied`] = true;
      filter[`users.${statusUser}.status`] = status;
      filter.rowStatus = { $ne: 'rejected' };
    }
  }

  const c = await col('job_tracker');
  return c.countDocuments(filter);
};

// LinkedIn jobs ALWAYS render an "employees on LinkedIn" count somewhere on
// the page, so a row that has been scanned (verdict present) but has no
// LI count means the scraper ran before the page finished rendering. The
// apply page has a "Rescan missing LI count" button that lists these for
// re-visit. Returns { count, jobLinks: [...] }.
//
// Eligibility — mirrors the old dashboard's `pendingOnly:true`:
//   • Platform is LinkedIn (Naukri / Indeed don't expose the LI count).
//   • Row is NOT rejected.
//   • The user has not applied to this row yet. Once they have acted, the
//     row is "done" and rescanning for an LI count is wasted work.
//
// We deliberately do NOT require a verdict — rows that were never analyzed
// (title+company only, no AI run) also have a missing LI count, and opening
// them in a tab lets the extension scan them for the first time. Same
// mechanic either way: open URL → extension content.js handles cache bypass
// + scan.
//
// Limit-capped so the button can't blast 1500 URLs at once.
/**
 * Jobs whose scanner score came out at or below `maxScore`.
 *
 * A score of 1 is usually not a real verdict — it's the scanner grading a page
 * whose job description hadn't finished rendering when it ran, so it scored an
 * almost-empty body. `jobTextLen` is returned alongside so the caller can see
 * that directly: a 1 with a few hundred characters of text is a scrape that
 * failed, while a 1 with a full description is a genuine bad match.
 *
 * Scoped to rows the given user still has pending — there's no point
 * re-scanning something already applied to or rejected.
 *
 * @param {{maxScore?: number, statusUser?: string, limit?: number}} opts
 * @returns {Promise<{count: number, jobs: Array<object>}>}
 */
export const findLowScoreJobs = async ({ maxScore = 1, statusUser, limit = 300 } = {}) => {
  await ensureIndex();
  const c = await col('job_tracker');
  const cap = Math.min(parseInt(limit) || 300, 1000);

  const match = {
    score: { $exists: true, $ne: null, $lte: Number(maxScore) },
    rowStatus: { $ne: 'rejected' },
  };
  if (statusUser) match[`users.${statusUser}.applied`] = { $ne: true };

  // $strLenCP rather than shipping jobText: the whole point is to compare
  // lengths across hundreds of rows, and the text itself is large.
  const docs = await c.aggregate([
    { $match: match },
    { $project: {
      jobLink: 1, jobId: 1, company: 1, title: 1, score: 1, platform: 1,
      jobTextLen: { $strLenCP: { $ifNull: ['$jobText', ''] } },
    } },
    { $sort: { jobTextLen: 1, score: 1 } },
    { $limit: cap },
  ]).toArray();

  return {
    count: docs.length,
    jobs: docs.map((d) => ({
      jobLink: d.jobLink, jobId: d.jobId, company: d.company, title: d.title,
      score: d.score, platform: d.platform || 'LinkedIn', jobTextLen: d.jobTextLen || 0,
    })),
  };
};

// `statusUser` scopes this to the user's triage queue, the same way
// findLowScoreJobs does — without it the set is every non-rejected row that
// lacks a count, including jobs already applied to, and the button opens
// company pages for rows outside the view it sits in. Omit it only for a
// deliberately unscoped sweep.
export const findMissingLiCountJobs = async ({ limit = 200, statusUser = null } = {}) => {
  await ensureIndex();
  const c = await col('job_tracker');
  // No statusUser = unscoped sweep: every non-rejected row that lacks a count.
  const pending = statusUser ? { [`users.${statusUser}.applied`]: { $ne: true } } : {};
  const docs = await c.find({
    platform: 'LinkedIn',
    rowStatus: { $ne: 'rejected' },
    ...pending,
    // A company page we already opened that produced nothing will produce
    // nothing next time either — don't queue it again.
    'companyDetails.liCountUnavailableAt': { $exists: false },
    // Missing only when it has NEITHER the exact on-LinkedIn count NOR the band (the band alone satisfies the tailor).
    $and: [
      { $or: [
        { 'companyDetails.employeesOnLinkedIn': { $in: [null, ''] } },
        { 'companyDetails.employeesOnLinkedIn': { $exists: false } },
      ] },
      { $or: [
        { 'companyDetails.employeeCount': { $in: [null, ''] } },
        { 'companyDetails.employeeCount': { $exists: false } },
      ] },
    ],
  }, { projection: { jobLink: 1, company: 1, title: 1, jobId: 1, 'companyDetails.companyLinkedIn': 1 } })
    .limit(Math.min(parseInt(limit) || 200, 500))
    .toArray();
  return {
    count: docs.length,
    jobLinks: docs.map(d => ({
      jobLink: d.jobLink, jobId: d.jobId, company: d.company, title: d.title,
      // Real company URL caught on a prior scan (null if never captured) — Rescan opens only these.
      companyLinkedIn: d.companyDetails?.companyLinkedIn || null,
    })),
  };
};

// Company-identity fields a peer row can lend to a row whose LinkedIn company
// panel never loaded. Size + identity only — NOT verdict/jobText/etc.
const COMPANY_COPY_FIELDS = [
  'employeeCount', 'employeesOnLinkedIn', 'employeesOnLinkedInNum',
  'followers', 'industry', 'companyLinkedIn',
];
const normCompany = (c) => (c || '').trim().toLowerCase().replace(/\s+/g, ' ');
// Canonical company slug from any /company/<slug>/… URL — the join key the
// company-page scrape backfill matches on.
const companySlugFromUrl = (u) => {
  const m = (u || '').match(/\/company\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
};
// A row "has a count" if it carries EITHER the exact on-LinkedIn number or the
// size band — the same bar findMissingLiCountJobs uses to decide a row is done.
// The two used to disagree: 650 band-only rows satisfied the target test but
// were refused as donors, so rows that a sibling could have filled instantly
// were queued for a live tab open instead.
const cdHasLiCount = (cd) =>
  (cd?.employeesOnLinkedIn != null && cd.employeesOnLinkedIn !== '') ||
  (cd?.employeeCount != null && cd.employeeCount !== '');
const donorDate = (d) => d.companyDetails?.scrapedAt || d.analyzedAt || d.createdAt || '';
// Donor quality: a fully-rendered company panel carries the band, followers,
// industry and a company URL alongside the count. A glitchy/partial scrape
// (e.g. "1 on LinkedIn" with nothing else) scores low and loses to a complete
// row — so we don't propagate a one-off bad number. Freshness breaks ties.
const donorScore = (cd) => {
  let s = 0;
  if (cd.employeeCount) s++;
  if (cd.followers) s++;
  if (cd.industry) s++;
  if (cd.companyLinkedIn) s++;
  return s;
};

// Backfill the LinkedIn employee count (and stable company identity) on rows
// where LinkedIn stopped serving the company panel, by copying from the most
// recently-scraped row of the SAME company that still has it. LinkedIn now
// omits the panel on many job pages, but the same employer was often scraped
// in an older posting — this maps that data forward instead of re-opening a
// browser tab for a number we already hold.
//
// Contract:
//   - Purely ADDITIVE: only fills empty fields, never overwrites a real scrape.
//   - EXACT company-name match only (case/whitespace-normalized). No fuzzing —
//     "EisnerAmper India" and "EisnerAmper" are different headcounts, and
//     grafting one onto the other is precisely the wrong outcome.
//   - Stamps companyDetails.backfilledFrom/backfilledAt for provenance + undo.
//
// Scope:
//   - 'missingLi' (default) — the same actionable set the Rescan button shows
//     (LinkedIn, not rejected, and — when `statusUser` is given — not yet
//     applied to by that user). Pass { jobLinks } to limit to exactly the
//     rows a click is about to rescan.
//   - 'all' — every row missing the count, regardless of platform/status.
//
// Returns { donors, filled, filledRows, remaining, remainingJobLinks } so the
// caller can rescan only the rows we still couldn't satisfy.
export const backfillCompanyDetailsFromPeers = async ({
  jobLinks = null, scope = 'missingLi', dryRun = false, statusUser = null,
} = {}) => {
  await ensureIndex();
  const c = await col('job_tracker');

  // Source rows for the donor map: the in-memory mirror when present (sub-ms
  // over ~9k rows), else a projected Mongo scan during the cold-start window.
  let rows;
  if (mirrorReady()) {
    rows = [...jobTrackerMirror.iter()];
  } else {
    rows = await c.find(
      { 'companyDetails.employeesOnLinkedIn': { $nin: [null, ''] } },
      { projection: { company: 1, companyDetails: 1, analyzedAt: 1, createdAt: 1, jobId: 1 } },
    ).toArray();
  }

  // 1a. Name-collision guard: the same company string scraped with conflicting
  //     size bands almost always means two different employers share a name
  //     (e.g. the real "Turing" at 1001-5000 vs a 2-10 namesake). We can't tell
  //     which donor a stub belongs to, so we refuse to backfill that name and
  //     let it fall through to a live rescan.
  const bandsByCompany = new Map();
  for (const d of rows) {
    const k = normCompany(d.company);
    const band = d.companyDetails?.employeeCount;
    if (!k || !band) continue;
    (bandsByCompany.get(k) || bandsByCompany.set(k, new Set()).get(k)).add(String(band).trim());
  }
  const ambiguous = new Set(
    [...bandsByCompany].filter(([, s]) => s.size > 1).map(([k]) => k),
  );

  // 1b. Donor map: company -> best companyDetails that carries a count. Most
  //     complete panel wins (donorScore), freshest breaks ties.
  const donors = new Map();
  for (const d of rows) {
    const k = normCompany(d.company);
    if (!k || ambiguous.has(k) || !cdHasLiCount(d.companyDetails)) continue;
    const cand = {
      cd: d.companyDetails, src: d.jobId || d.jobLink,
      date: donorDate(d), score: donorScore(d.companyDetails),
    };
    const prev = donors.get(k);
    if (!prev || cand.score > prev.score
        || (cand.score === prev.score && cand.date > prev.date)) {
      donors.set(k, cand);
    }
  }

  // 2. Target rows: a row is fixable only if it lacks the count itself.
  const missingCount = {
    $or: [
      { 'companyDetails.employeesOnLinkedIn': { $in: [null, ''] } },
      { 'companyDetails.employeesOnLinkedIn': { $exists: false } },
    ],
  };
  let filter;
  if (Array.isArray(jobLinks) && jobLinks.length) {
    filter = { jobLink: { $in: jobLinks }, ...missingCount };
  } else if (scope === 'all') {
    filter = missingCount;
  } else {
    filter = {
      platform: 'LinkedIn',
      rowStatus: { $ne: 'rejected' },
      ...(statusUser ? { [`users.${statusUser}.applied`]: { $ne: true } } : {}),
      ...missingCount,
    };
  }
  const targets = await c.find(filter, {
    projection: { jobLink: 1, jobId: 1, company: 1, title: 1, companyDetails: 1 },
  }).limit(5000).toArray();

  // 3. Build one $set per fixable target — fill only empty fields, recompute
  //    the numeric facet if the donor lent a string count but no number.
  const ops = [];
  const filledRows = [];
  const remainingJobLinks = [];
  const now = new Date().toISOString();
  for (const d of targets) {
    const stub = { jobLink: d.jobLink, jobId: d.jobId, company: d.company, title: d.title };
    const src = donors.get(normCompany(d.company));
    const cur = d.companyDetails || {};
    if (!src) { remainingJobLinks.push(stub); continue; }

    const set = {};
    for (const f of COMPANY_COPY_FIELDS) {
      const v = src.cd[f];
      if (v != null && v !== '' && (cur[f] == null || cur[f] === '')) set[`companyDetails.${f}`] = v;
    }
    if (!Object.keys(set).length) { remainingJobLinks.push(stub); continue; }
    if (set['companyDetails.employeesOnLinkedIn'] != null
        && set['companyDetails.employeesOnLinkedInNum'] == null) {
      const n = parseLeadingNum(set['companyDetails.employeesOnLinkedIn'])
        ?? parseLeadingNum(set['companyDetails.employeeCount']);
      if (n != null) set['companyDetails.employeesOnLinkedInNum'] = n;
    }
    set['companyDetails.backfilledFrom'] = src.src;
    set['companyDetails.backfilledAt'] = now;
    ops.push({ updateOne: { filter: { jobLink: d.jobLink }, update: { $set: set } } });
    filledRows.push({ ...stub, employeesOnLinkedIn: src.cd.employeesOnLinkedIn, from: src.src });
  }

  // 4. One bulk write (the col() Proxy stamps updatedAt per op), then refresh
  //    the mirror so the rows immediately read as populated.
  if (ops.length && !dryRun) {
    await c.bulkWrite(ops, { ordered: false });
    const refreshed = await c.find(
      { jobLink: { $in: filledRows.map(f => f.jobLink) } },
    ).toArray();
    jobTrackerMirror.applyMany(refreshed);
  }

  return {
    donors: donors.size,
    ambiguousCompanies: ambiguous.size,
    filled: filledRows.length,
    filledRows,
    remaining: remainingJobLinks.length,
    remainingJobLinks,
    dryRun,
  };
};

// Backfill companyDetails on every job row for one company from a /company-scrape.
// Match by stored-URL slug first, else exact name (URL-less rows, non-ambiguous name).
// Authoritative: overwrites the scraped fields; empty fields are dropped, never wiping a good value.
// Stamp every row for a company whose page we opened and which produced no
// headcount at all. `findMissingLiCountJobs` skips these, which is what stops
// the rescan queue re-opening a page that can never answer.
const markLiCountUnavailable = async (c, wantSlug, wantName, companyName) => {
  const rows = mirrorReady()
    ? [...jobTrackerMirror.iter()]
    : await c.find({}, { projection: { jobLink: 1, company: 1, companyDetails: 1 } }).toArray();
  const matches = rows.filter((d) => {
    const rowSlug = companySlugFromUrl(d.companyDetails?.companyLinkedIn);
    return (wantSlug && rowSlug === wantSlug)
      || (!rowSlug && wantName && normCompany(d.company) === wantName);
  });
  if (!matches.length) return { slug: wantSlug, company: companyName, matched: 0, updated: 0, fields: {}, unavailable: true };
  const now = new Date().toISOString();
  await c.bulkWrite(matches.map((d) => ({
    updateOne: {
      filter: { jobLink: d.jobLink },
      update: { $set: { 'companyDetails.liCountUnavailableAt': now, 'companyDetails.companyScrapedAt': now } },
    },
  })), { ordered: false });
  const refreshed = await c.find({ jobLink: { $in: matches.map((m) => m.jobLink) } }).toArray();
  jobTrackerMirror.applyMany(refreshed);
  return { slug: wantSlug, company: companyName, matched: matches.length, updated: matches.length, fields: {}, unavailable: true };
};

export const backfillCompanyDetailsByCompany = async ({ slug, companyUrl, details, unavailable = false } = {}) => {
  await ensureIndex();
  const c = await col('job_tracker');

  const wantSlug = (slug
    || companySlugFromUrl(companyUrl)
    || companySlugFromUrl(details?.companyLinkedIn) || '').toLowerCase();
  const wantName = normCompany(details?.companyName);
  if (!wantSlug && !wantName) {
    throw new Error('backfillCompanyDetailsByCompany: need slug or companyName');
  }

  // Normalize the scrape into the companyDetails fields we persist.
  const incoming = {};
  for (const f of COMPANY_COPY_FIELDS) {
    const v = details?.[f];
    if (v != null && v !== '') incoming[f] = v;
  }
  incoming.companyLinkedIn = details?.companyLinkedIn
    || (wantSlug ? `https://www.linkedin.com/company/${wantSlug}/` : incoming.companyLinkedIn);
  const num = parseLeadingNum(incoming.employeesOnLinkedIn) ?? parseLeadingNum(incoming.employeeCount);
  if (num != null) incoming.employeesOnLinkedInNum = num;
  // companyLinkedIn alone isn't worth a write — require a real headcount signal.
  // But a page that genuinely HAS no headcount (a /showcase/ page carries
  // followers and nothing else) must still be recorded, or the row keeps
  // qualifying as "missing" and Rescan re-opens the same dead tab every run.
  if (!incoming.employeeCount && !incoming.employeesOnLinkedIn && !incoming.followers) {
    if (!unavailable) {
      return { slug: wantSlug, company: details?.companyName || null, matched: 0, updated: 0, fields: {} };
    }
    return markLiCountUnavailable(c, wantSlug, wantName, details?.companyName || null);
  }

  // Candidate rows: mirror when warm (sub-ms over ~9k), else a projected scan.
  let rows;
  if (mirrorReady()) {
    rows = [...jobTrackerMirror.iter()];
  } else {
    rows = await c.find({}, {
      projection: { jobLink: 1, jobId: 1, company: 1, companyDetails: 1 },
    }).toArray();
  }

  // Name-collision guard — if the name maps to >1 size band, allow slug matches only.
  const bands = new Set();
  for (const d of rows) {
    if (normCompany(d.company) !== wantName) continue;
    const b = d.companyDetails?.employeeCount;
    if (b) bands.add(String(b).trim());
  }
  const nameAmbiguous = bands.size > 1;

  const matches = [];
  for (const d of rows) {
    const rowSlug = companySlugFromUrl(d.companyDetails?.companyLinkedIn);
    const slugHit = wantSlug && rowSlug === wantSlug;
    const nameHit = !slugHit && wantName && !nameAmbiguous && !rowSlug
      && normCompany(d.company) === wantName;
    if (slugHit || nameHit) matches.push(d);
  }

  const now = new Date().toISOString();
  const ops = matches.map(d => {
    const set = {};
    for (const [k, v] of Object.entries(incoming)) set[`companyDetails.${k}`] = v;
    set['companyDetails.companyScrapedAt'] = now;
    set['companyDetails.companyScrapeSlug'] = wantSlug || null;
    return { updateOne: { filter: { jobLink: d.jobLink }, update: { $set: set } } };
  });

  if (ops.length) {
    await c.bulkWrite(ops, { ordered: false });
    const refreshed = await c.find(
      { jobLink: { $in: matches.map(m => m.jobLink) } },
    ).toArray();
    jobTrackerMirror.applyMany(refreshed);
  }

  return {
    slug: wantSlug,
    company: details?.companyName || null,
    matched: matches.length,
    updated: ops.length,
    nameAmbiguous,
    fields: incoming,
  };
};

// Lookup by jobId — the extension's primary key. Returns the hydrated doc or
// null. Used by /api/ext/result/:jobId to short-circuit re-scans when a job
// has already been analyzed.
export const getJobByJobId = async (jobId) => {
  if (!jobId) return null;
  if (mirrorReady()) {
    const id = String(jobId);
    for (const d of jobTrackerMirror.iter()) {
      if (d.jobId === id) return hydrate(d);
    }
    return null;
  }
  await ensureIndex();
  const c = await col('job_tracker');
  const doc = await c.findOne({ jobId: String(jobId) });
  return doc ? hydrate(doc) : null;
};

// Lookup by jobLink (the unique key). Same shape as getJobByJobId.
export const getJobByLink = async (jobLink) => {
  if (!jobLink) return null;
  if (mirrorReady()) {
    for (const d of jobTrackerMirror.iter()) {
      if (d.jobLink === jobLink) return hydrate(d);
    }
    return null;
  }
  await ensureIndex();
  const c = await col('job_tracker');
  const doc = await c.findOne({ jobLink });
  return doc ? hydrate(doc) : null;
};

// ── Writes ───────────────────────────────────────────────────────────────

// Upserts a parsed job (from clipboard). Marks the active user as applied.
// Returns { upserted, modified, doc }.
export const upsertJobFromParse = async ({ user, parsedJob }) => {
  await ensureIndex();
  if (!user) throw new Error('upsertJobFromParse: user required');
  if (!parsedJob?.link) throw new Error('upsertJobFromParse: parsedJob.link required');

  const now = new Date().toISOString();
  const c = await col('job_tracker');
  const existing = await c.findOne({ jobLink: parsedJob.link });

  const userSub = {
    applied: true,
    status: 'applied',
    feedback: '',
    notes: '',
    appliedAt: now,
    rejectedAt: null,
    statusUpdatedAt: now,
    interviewDates: [],
  };
  // If user already has an entry with a more advanced status, preserve it.
  const prev = existing?.users?.[user];
  if (prev) {
    const prevSub = coerceUserSub(prev);
    if (prevSub.applied) {
      // user already applied — keep their status, just refresh appliedAt missing
      Object.assign(userSub, prevSub);
      if (!userSub.appliedAt) userSub.appliedAt = now;
    }
  }

  // $setOnInsert is for IMMUTABLE row identity ONLY (jobLink + createdAt).
  // Putting jobId / platform / title etc. there used to cause "Updating the
  // path 'jobId' would create a conflict at 'jobId'" errors when an existing
  // row was missing jobId — the same field landed in both $setOnInsert and
  // $set. Now all non-identity fields go through $set with the same
  // "don't overwrite a populated existing value" guard.
  const setOnInsert = { jobLink: parsedJob.link, createdAt: now };
  const setShared = {};
  if (!existing) {
    // Seed identity fields on first insert.
    if (parsedJob.jobId)    setShared.jobId    = parsedJob.jobId;
    if (parsedJob.platform) setShared.platform = parsedJob.platform || 'LinkedIn';
    if (parsedJob.title)    setShared.title    = parsedJob.title;
    if (parsedJob.company)  setShared.company  = parsedJob.company;
    if (parsedJob.location) setShared.location = parsedJob.location;
  } else {
    // Existing row — only fill blanks, never overwrite a populated field.
    if (!existing.title && parsedJob.title)       setShared.title    = parsedJob.title;
    if (!existing.company && parsedJob.company)   setShared.company  = parsedJob.company;
    if (!existing.location && parsedJob.location) setShared.location = parsedJob.location;
    if (!existing.platform && parsedJob.platform) setShared.platform = parsedJob.platform;
    if (!existing.jobId && parsedJob.jobId)       setShared.jobId    = parsedJob.jobId;
  }

  // If the user is applying to a row they had rejected, un-reject it
  // implicitly — same behavior as clicking the Apply button on apply.html
  // (see updateUserStatus). Without this, the row stays rowStatus='rejected'
  // and gets filtered out of every Active/Applied/Interviewing view, so
  // the apply effectively disappears.
  const unset = (existing?.rowStatus === 'rejected')
    ? { rowStatus: '', rejectedAt: '', rejectedBy: '', rejectedNotes: '' }
    : null;

  const update = {
    $setOnInsert: setOnInsert,
    $set: { ...setShared, [`users.${user}`]: userSub },
  };
  if (unset) update.$unset = unset;

  const r = await c.updateOne({ jobLink: parsedJob.link }, update, { upsert: true });
  const doc = await c.findOne({ jobLink: parsedJob.link });
  if (doc) jobTrackerMirror.set(doc);
  return { upserted: !!r.upsertedId, modified: r.modifiedCount, doc: hydrate(doc) };
};

// Fields the extension's /analyze writes onto a row. Everything is at the
// document root (job-level) — none of this is per-user. Unknown fields are
// silently dropped to keep the doc tidy.
const SCANNER_FIELDS = [
  'verdict', 'score', 'title', 'company', 'location',
  'salary', 'experience_required',
  'summary', 'apply_recommendation',
  'key_skills_match', 'key_skills_missing', 'red_flags',
  'company_industry', 'company_type', 'company_assessment',
  'companyDetails', 'posted_date', 'posted_relative',
  'analyzedAt', 'pageTitle', 'jobText',
  'connectNote', 'connectNoteAt',
  'blockedReasons',
  'platform', 'jobId',
  // Job-listing facets scraped from the page header (LinkedIn job pin
  // strip). All optional; missing on legacy rows.
  'jobType', 'workMode', 'easyApply',
  'applicantsCount', 'applicantsNumeric',
];

// Upsert a scanned job. Lands the row in `job_tracker` with all the rich
// analysis fields. Does NOT touch the `users` map — a scanned job is pending
// until the user explicitly applies or rejects. A fresh analysis also clears
// `importedFrom`: the row may have arrived from a peer, but the analysis on
// it is now the user's own.
//
// Inputs:
//   - jobLink (required) — unique row key.
//   - jobId, platform, title, company, location — basic identity.
//   - any subset of SCANNER_FIELDS — analysis payload.
//
// Behaviour: on first scan we $setOnInsert createdAt + basics, on re-scans
// we $set the analysis fields (latest scan wins). User-typed values (title,
// company, location) are preserved only when re-scanning would clear them —
// i.e. we don't overwrite a non-empty existing field with an empty new value.
export const upsertScannedJob = async (input = {}) => {
  await ensureIndex();
  const jobLink = input.jobLink || input.url;
  if (!jobLink) throw new Error('upsertScannedJob: jobLink required');
  const c = await col('job_tracker');
  const existing = await c.findOne({ jobLink });
  const now = new Date().toISOString();

  // $setOnInsert is for IMMUTABLE row identity only (jobLink + createdAt).
  // All other fields go through $set so re-scans can update them — and so
  // we don't end up with the "path appears in both $setOnInsert and $set"
  // mongo conflict when input fields overlap with row-identity fields.
  const setOnInsert = { jobLink, createdAt: now };

  const set = { analyzedAt: now };
  // Seed the basic identity fields on first insert (when `existing` is null).
  // On re-scans these are handled by SCANNER_FIELDS below — same conditional
  // (don't overwrite a populated existing value with an empty new one).
  if (!existing) {
    if (input.jobId)    set.jobId = input.jobId;
    if (input.platform) set.platform = input.platform;
    if (input.title)    set.title = input.title;
    if (input.company)  set.company = input.company;
    if (input.location) set.location = input.location;
  }

  // Build $set from SCANNER_FIELDS, skipping undefined and skipping fields
  // that would blank out an existing populated value.
  for (const k of SCANNER_FIELDS) {
    const v = input[k];
    if (v === undefined) continue;
    if (existing && existing[k] && (v === '' || v == null)) continue;
    set[k] = v;
  }

  // Derived facets for sort/filter — one definition shared with the peer
  // importer (deriveRowFacets). Each facet is only written when its source
  // field is in this payload, so a partial re-scan never blanks a facet the
  // previous full scan computed.
  const facets = deriveRowFacets({
    jobText: set.jobText ?? input.jobText,
    experience_required: set.experience_required ?? input.experience_required,
    companyDetails: set.companyDetails || existing?.companyDetails,
  });
  if (set.companyDetails || input.companyDetails) {
    const cd = set.companyDetails || existing?.companyDetails || {};
    if (facets.employeesOnLinkedInNum != null) {
      set.companyDetails = { ...cd, employeesOnLinkedInNum: facets.employeesOnLinkedInNum };
    }
  }
  if (set.experience_required || input.experience_required) {
    if (facets.experienceYearsMin != null) set.experienceYearsMin = facets.experienceYearsMin;
    if (facets.experienceYearsMax != null) set.experienceYearsMax = facets.experienceYearsMax;
  }
  // External-apply extraction re-runs whenever jobText is in the payload
  // (every analyze ships the fresh JD) — re-scans then naturally refresh the
  // indicators. An empty result is written too, so a JD that loses its
  // previous apply link doesn't keep a stale indicator.
  if (facets.externalApply) set.externalApply = facets.externalApply;

  await c.updateOne(
    { jobLink },
    // analyzedAt is always written here, so the peer provenance always goes.
    { $setOnInsert: setOnInsert, $set: set, $unset: { importedFrom: '' } },
    { upsert: true },
  );
  // A newly-inserted job introduces a company that may match connections —
  // bust the match-index cache so /api/apply/jobs?includeRefs picks it up
  // on the next call instead of waiting for the disk TTL.
  if (!existing) {
    try {
      const { invalidateMatchIndex } = await import('../connections/store.js');
      invalidateMatchIndex({});
    } catch { /* non-fatal */ }
  }
  const doc = await c.findOne({ jobLink });
  if (doc) jobTrackerMirror.set(doc);
  return hydrate(doc);
};

// Clear scanner-derived fields on a set of rows so the next visit produces
// a fully fresh analysis instead of returning a stale "previous result".
// Preserves identity (jobLink, jobId, platform), the user's apply state
// (users.*) and the row-level rowStatus. Peer provenance (importedFrom) goes
// with the analysis it described. Modeled after the old dashboard's "DELETE
// /result/:jobId" rescan behavior but doesn't drop the row outright —
// that would lose the user's actions.
//
// Inputs: { jobLinks: [...] } — pass either field, both keyed against the
// unique jobLink index. Bulk-write for speed.
export const clearScannerData = async ({ jobLinks = [] } = {}) => {
  if (!Array.isArray(jobLinks) || !jobLinks.length) return { cleared: 0 };
  await ensureIndex();
  const c = await col('job_tracker');
  const r = await c.updateMany(
    { jobLink: { $in: jobLinks } },
    {
      $unset: {
        verdict: '', score: '',
        summary: '', apply_recommendation: '',
        key_skills_match: '', key_skills_missing: '', red_flags: '',
        salary: '', experience_required: '',
        company_industry: '', company_type: '', company_assessment: '',
        companyDetails: '',
        posted_date: '', posted_relative: '',
        analyzedAt: '', pageTitle: '', jobText: '',
        connectNote: '', connectNoteAt: '',
        blockedReasons: '',
        jobType: '', workMode: '', easyApply: '',
        applicantsCount: '', applicantsNumeric: '',
        experienceYearsMin: '', experienceYearsMax: '',
        externalApply: '',
        importedFrom: '',
      },
    },
  );
  // Re-read the cleared docs and refresh the mirror so subsequent reads
  // don't return stale scanner fields.
  const refreshed = await c.find({ jobLink: { $in: jobLinks } }).toArray();
  jobTrackerMirror.applyMany(refreshed);
  return { cleared: r.modifiedCount };
};

// Upsert just the connect-note (and its timestamp). Separate from the full
// analyze upsert because /connect-note is its own endpoint — regenerating
// shouldn't have to round-trip the whole analysis payload.
export const setConnectNote = async ({ jobLink, jobId, note }) => {
  await ensureIndex();
  const c = await col('job_tracker');
  const filter = jobLink ? { jobLink } : { jobId: String(jobId || '') };
  if (!filter.jobLink && !filter.jobId) throw new Error('setConnectNote: jobLink or jobId required');
  const now = new Date().toISOString();
  await c.updateOne(filter, { $set: { connectNote: note || '', connectNoteAt: now } });
  const doc = await c.findOne(filter);
  if (doc) jobTrackerMirror.set(doc);
  return doc ? hydrate(doc) : null;
};

// Real per-status counts for the user, computed against the whole
// collection (not just the visible page). `user` is required — every count
// except `rejected` reads users.<user>, and there is no cross-user view.
export const getStats = async ({ user, platform, q } = {}) => {
  await ensureIndex();
  if (!user) throw new Error('getStats: user required');

  const out = { user, total: 0, pending: 0, applied: 0, interviewing: 0, success: 0, rejected: 0 };

  // ── Mirror path ── 5 counts on a ~3k-doc Map. Sub-millisecond.
  if (mirrorReady()) {
    const matchScope = (extra) => buildMatcher({ user: null, platform, q, ...extra });
    out.total        = jobTrackerMirror.count(matchScope({}));
    out.rejected     = jobTrackerMirror.count(matchScope({ status: 'rejected' }));
    out.applied      = jobTrackerMirror.count(matchScope({ status: 'applied',      statusUser: user }));
    out.interviewing = jobTrackerMirror.count(matchScope({ status: 'interviewing', statusUser: user }));
    out.success      = jobTrackerMirror.count(matchScope({ status: 'success',      statusUser: user }));
    out.pending      = Math.max(0, out.total - out.rejected - out.applied - out.interviewing - out.success);
    return out;
  }

  const c = await col('job_tracker');

  const base = {};
  if (platform) base.platform = platform;
  if (q) {
    const re = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    base.$or = [{ title: re }, { company: re }, { jobLink: re }, { location: re }];
  }

  // Single $facet aggregation — runs all 5 counts in one round-trip
  // (instead of 5 sequential countDocuments × ~150ms RTT each on Atlas).
  // Each branch is its own $match + $count pipeline; mongo runs them
  // in parallel and returns a single result.
  // pending is computed by arithmetic: total - rejected - active.
  // pendingClause used $exists + $ne which mongo can't serve from an
  // index — it was the slowest branch of the old $facet. The branches
  // below all hit either rowStatus_1 or apply_<user>_1 (per-user compound).
  const active = (st) => [
    { $match: { rowStatus: { $ne: 'rejected' }, [`users.${user}.applied`]: true, [`users.${user}.status`]: st } },
    { $count: 'n' },
  ];
  const [r] = await c.aggregate([
    { $match: base },
    {
      $facet: {
        total:        [{ $count: 'n' }],
        rejected:     [{ $match: { rowStatus: 'rejected' } }, { $count: 'n' }],
        applied:      active('applied'),
        interviewing: active('interviewing'),
        success:      active('success'),
      },
    },
  ]).toArray();
  const pick = (k) => r?.[k]?.[0]?.n || 0;
  out.total = pick('total');
  out.rejected = pick('rejected');
  out.applied = pick('applied');
  out.interviewing = pick('interviewing');
  out.success = pick('success');
  out.pending = Math.max(0, out.total - out.rejected - out.applied - out.interviewing - out.success);
  return out;
};

// Update a row's state.
//
//   Reject       (patch.status='rejected')  → row-level rowStatus='rejected',
//                                             rejectedBy=<user>. No sub-doc
//                                             write — a reject is not an apply
//                                             state, and the row keeps whatever
//                                             the user had done on it before.
//   Reset / Pending — what gets cleared depends on the row's CURRENT state:
//     a) the user has an active sub-doc (applied/interviewing/success) →
//        clear just that sub-doc; a rowStatus='rejected' set earlier stays.
//     b) otherwise, if the row is rejected → un-reject it (clear rowStatus).
//   Apply / Interview / Success → users.<user> sub-doc.
//
// `user` is always required: it names the sub-doc for apply states and is
// recorded as `rejectedBy` on a reject, so tool-driven triage (rejectedBy=
// "Claude") stays distinguishable from a hand click.
export const updateUserStatus = async ({ user, jobLink, patch = {} }) => {
  await ensureIndex();
  if (!user || !jobLink) throw new Error('updateUserStatus: user + jobLink required');
  const c = await col('job_tracker');

  const existing = await c.findOne({ jobLink });
  if (!existing) throw new Error(`job not found: ${jobLink}`);
  const now = new Date().toISOString();
  const prev = coerceUserSub(existing.users?.[user]) || null;

  // ── Row-level Reject ──
  if (patch.status === 'rejected') {
    await c.updateOne({ jobLink }, {
      $set: {
        rowStatus: 'rejected',
        rejectedAt: now,
        rejectedBy: user,
        rejectedNotes: patch.notes || '',
      },
    });
    const doc = await c.findOne({ jobLink });
    if (doc) jobTrackerMirror.set(doc);
    return hydrate(doc);
  }

  // ── Reset / Pending ──
  if (patch.status === 'pending' || patch.reset === true) {
    const update = {};
    // Priority: clear the user's active state if they have one. Otherwise,
    // if the row is rejected, un-reject it (the user is re-opening it).
    if (prev) {
      update.$unset = { [`users.${user}`]: '' };
    } else if (existing.rowStatus === 'rejected') {
      update.$unset = { rowStatus: '', rejectedAt: '', rejectedBy: '', rejectedNotes: '' };
    } else {
      // Nothing to reset. Return current.
      return hydrate(existing);
    }
    await c.updateOne({ jobLink }, update);
    const doc = await c.findOne({ jobLink });
    if (doc) jobTrackerMirror.set(doc);
    return hydrate(doc);
  }

  // ── Active per-user transitions: applied / interviewing / success ──
  if (!patch.status || !STATUSES.includes(patch.status)) {
    throw new Error(`unknown status: ${patch.status}`);
  }

  // Applying to a rejected row un-rejects it implicitly — the user changed
  // their mind and decided to engage. Cleaner than asking them to first
  // Reset then Apply.
  const unrejectIfNeeded = existing.rowStatus === 'rejected'
    ? { rowStatus: '', rejectedAt: '', rejectedBy: '', rejectedNotes: '' }
    : null;

  if (!prev) {
    const seed = {
      applied: true,
      status: patch.status,
      feedback: patch.feedback || '',
      notes: patch.notes || '',
      appliedAt: now,
      statusUpdatedAt: now,
      interviewDates: Array.isArray(patch.interviewDates) ? patch.interviewDates : [],
    };
    const update = { $set: { [`users.${user}`]: seed } };
    if (unrejectIfNeeded) update.$unset = unrejectIfNeeded;
    await c.updateOne({ jobLink }, update);
    const doc = await c.findOne({ jobLink });
    if (doc) jobTrackerMirror.set(doc);
    return hydrate(doc);
  }

  // Subsequent transition (applied → interviewing, etc).
  const set = {
    [`users.${user}.statusUpdatedAt`]: now,
    [`users.${user}.status`]: patch.status,
    [`users.${user}.applied`]: true,
  };
  if (patch.feedback !== undefined) set[`users.${user}.feedback`] = patch.feedback;
  if (patch.notes !== undefined)    set[`users.${user}.notes`] = patch.notes;
  if (Array.isArray(patch.interviewDates)) set[`users.${user}.interviewDates`] = patch.interviewDates;
  const update = { $set: set };
  if (unrejectIfNeeded) update.$unset = unrejectIfNeeded;
  await c.updateOne({ jobLink }, update);
  const doc = await c.findOne({ jobLink });
  if (doc) jobTrackerMirror.set(doc);
  return hydrate(doc);
};

// Compact { jobId → { applied, status, rowStatus } } map for the user. Used
// by the extension to decorate the on-page floating badge — whether this
// row is rejected and whether the user has already applied to it.
//
//   applied   — users.<username>.applied is true
//   status    — that sub-doc's status ('applied' | 'interviewing' |
//               'success'), or null when not applied
//   rowStatus — 'rejected' | null
//
// Only rows that exist in the tracker come back; an unknown jobId is simply
// absent from the map. Mirror-backed, so a 200-id batch is sub-millisecond.
export const getAppliedByJobId = async ({ jobIds, username } = {}) => {
  if (!username) throw new Error('getAppliedByJobId: username required');
  const wanted = Array.isArray(jobIds) && jobIds.length ? new Set(jobIds.map(String)) : null;
  const out = {};
  const add = (d) => {
    if (!d.jobId) return;
    if (wanted && !wanted.has(String(d.jobId))) return;
    const sub = coerceUserSub(d.users?.[username]);
    const applied = !!sub?.applied;
    out[String(d.jobId)] = {
      applied,
      status: applied ? sub.status : null,
      rowStatus: d.rowStatus === 'rejected' ? 'rejected' : null,
    };
  };

  if (mirrorReady()) {
    for (const d of jobTrackerMirror.iter()) add(d);
    return out;
  }

  await ensureIndex();
  const c = await col('job_tracker');
  const filter = wanted ? { jobId: { $in: [...wanted] } } : {};
  const docs = await c.find(filter, {
    projection: { jobId: 1, [`users.${username}`]: 1, rowStatus: 1 },
  }).toArray();
  for (const d of docs) add(d);
  return out;
};
