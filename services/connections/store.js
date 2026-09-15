// LinkedIn connections store — the operator's own LinkedIn network, scraped
// by the extension from the connections page and matched by headline against
// the companies in job_tracker. Schema (one doc per profile):
//
//   {
//     profileUrl: string (unique),
//     profileSlug: string,
//     name: string,
//     headline: string|null,
//     connectedOnText: string|null,
//     connectedOn: ISO|null,
//     photoUrl: string|null,
//     profileUrn: string|null,
//     fsdProfileId: string|null,
//     recipient: string|null,
//     messageUrl: string|null,
//     firstSeenAt: ISO,
//     lastSeenAt: ISO,
//     source: string|null,
//     owners: [string],         // always [<the local user>]. Kept as an
//                               // array so rows written by earlier versions
//                               // of the schema stay readable — every query
//                               // here is `owners: <user>`, which matches
//                               // either shape.
//   }
//
// Performance: the (job × connection) headline match is the hot path
// behind every /api/apply/jobs?includeRefs=1 call. On Atlas, the cold
// build can take 3-10 s for 900+ connections × 3000+ jobs. We cache the
// computed index two ways:
//   1. In-process Map (fast warm reads)
//   2. JSON file on disk, keyed by the local user (survives server restarts)
// The disk cache cuts the post-restart cold-start cost to ~50 ms.
// Invalidated automatically when connections / jobs change.
//
// View state (mark-seen timestamps) lives in `scanner_view_state` keyed by
// _id: 'global'. Same shape as the old view-state.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { col } from '../db.js';
import { connectionsMirror, jobTrackerMirror } from '../mirror.js';

let _indexed = false;
const ensureIndex = async () => {
  if (_indexed) return;
  const c = await col('connections');
  await c.createIndex({ profileUrl: 1 }, { unique: true });
  await c.createIndex({ firstSeenAt: -1 });
  _indexed = true;
};

// ── Matching helpers (verbatim from connect-tracker/server/routes.js) ─────

export function normalizeCompanyName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\b(?:pvt|private|ltd|limited|inc|inc\.|incorporated|llc|llp|corp|corporation|gmbh|sa|ag|co|company|technologies|tech|labs|systems|solutions|services|software)\b/g, '')
    .replace(/[.,&/()\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function headlineMatchesCompany(headline, normalizedCompany) {
  if (!headline || !normalizedCompany || normalizedCompany.length < 2) return false;
  const hay = ' ' + normalizeCompanyName(headline) + ' ';
  return hay.includes(' ' + normalizedCompany + ' ');
}

// ── Reads ─────────────────────────────────────────────────────────────────

// Build the index of every (job, connection) match for the local user.
// Cached for 30 s so paging + filter switches don't repeatedly recompute the
// O(jobs × connections) join. We emit BOTH directions so callers don't have
// to re-scan: byProfile (used by the connections page) and byJobLink (used
// by /api/apply/jobs to surface the "N refs" pill + popover).
//
// Cache shape per entry:
//   { at, byProfile, byJobLink, matchedProfiles }
//     byProfile  : profileUrl → [{ jobLink, title, company }]  (cap 25)
//     byJobLink  : jobLink    → [{ profileUrl, profileSlug, name, headline,
//                                  photoUrl, messageUrl, firstSeenAt }] (cap 20)
//     matchedProfiles : Set<profileUrl> for fast hasJobMatch filtering
const _matchIndexCache = new Map();
// In-memory cache TTL is short — the disk cache is the long-lived layer.
const MATCH_CACHE_TTL_MS = 30_000;
// Disk cache TTL is longer — connections rarely churn during a sitting and
// the rebuild is expensive. Invalidated explicitly on connection / job upserts.
const MATCH_DISK_TTL_MS = 30 * 60_000; // 30 minutes

const __dirname = dirname(fileURLToPath(import.meta.url));
const MATCH_CACHE_DIR = join(__dirname, '.cache');
const matchFilePath = (ownerKey) =>
  join(MATCH_CACHE_DIR, `match-index-${encodeURIComponent(ownerKey)}.json`);

// Serialize Maps/Sets to plain objects/arrays so JSON can hold them.
const serializeIndex = (entry) => ({
  at: entry.at,
  byProfile: Object.fromEntries(entry.byProfile),
  byJobLink: Object.fromEntries(entry.byJobLink),
  matchedProfiles: [...entry.matchedProfiles],
});
const deserializeIndex = (json) => ({
  at: json.at,
  byProfile: new Map(Object.entries(json.byProfile || {})),
  byJobLink: new Map(Object.entries(json.byJobLink || {})),
  matchedProfiles: new Set(json.matchedProfiles || []),
});

function readDiskCache(ownerKey) {
  try {
    const fp = matchFilePath(ownerKey);
    if (!existsSync(fp)) return null;
    const age = Date.now() - statSync(fp).mtimeMs;
    if (age > MATCH_DISK_TTL_MS) return null;
    return deserializeIndex(JSON.parse(readFileSync(fp, 'utf-8')));
  } catch { return null; }
}
function writeDiskCache(ownerKey, entry) {
  try {
    if (!existsSync(MATCH_CACHE_DIR)) mkdirSync(MATCH_CACHE_DIR, { recursive: true });
    writeFileSync(matchFilePath(ownerKey), JSON.stringify(serializeIndex(entry)), 'utf-8');
  } catch { /* non-fatal — the cache miss path will rebuild next call */ }
}

// Hooks called from upsertConnections / upsertScannedJob so the next
// ownerMatchesIndex() call rebuilds from fresh data. `{ owner }` drops that
// user's entry; `{}` wipes every entry (a new job can match anyone).
export function invalidateMatchIndex({ owner = null } = {}) {
  if (owner) {
    _matchIndexCache.delete(owner);
    try { unlinkSync(matchFilePath(owner)); } catch {}
    return;
  }
  _matchIndexCache.clear();
  try {
    if (!existsSync(MATCH_CACHE_DIR)) return;
    for (const f of readdirSync(MATCH_CACHE_DIR)) {
      if (f.startsWith('match-index-')) try { unlinkSync(join(MATCH_CACHE_DIR, f)); } catch {}
    }
  } catch {}
}

// The cache is keyed by the local user. A null owner only happens before
// /setup has created one (or on a legacy multi-user DB with no session), and
// then the index covers every connection row so reads still work.
async function ownerMatchesIndex({ owner }) {
  const ownerKey = owner || '__all__';
  // Two-tier cache: in-process first, then disk.
  const memCached = _matchIndexCache.get(ownerKey);
  if (memCached && Date.now() - memCached.at < MATCH_CACHE_TTL_MS) return memCached;
  const diskCached = readDiskCache(ownerKey);
  if (diskCached) {
    _matchIndexCache.set(ownerKey, diskCached);
    return diskCached;
  }

  const cConn = await col('connections');
  const cJobs = await col('job_tracker');

  // Pull every field the apply-page popover needs in a single projection,
  // so getMatchesForJobs can read from cache instead of re-querying.
  const connFilter = owner ? { owners: owner } : {};
  const [connects, jobs] = await Promise.all([
    cConn.find(connFilter, {
      projection: {
        profileUrl: 1, profileSlug: 1, name: 1, headline: 1,
        photoUrl: 1, messageUrl: 1, firstSeenAt: 1,
      },
    }).toArray(),
    cJobs.find(
      { company: { $exists: true, $ne: null, $ne: '' } },
      { projection: { jobLink: 1, title: 1, company: 1 } },
    ).toArray(),
  ]);

  // Pre-normalize each connection's headline once — string-matching against
  // it is the hot path for the inner loop (jobs × connections).
  const prepped = connects.map(c => ({
    c,
    hay: ' ' + normalizeCompanyName(c.headline || '') + ' ',
    firstSeenMs: c.firstSeenAt ? new Date(c.firstSeenAt).getTime() : 0,
  }));

  const byProfile = new Map();
  const byJobLink = new Map();
  const matchedProfiles = new Set();
  for (const j of jobs) {
    const norm = normalizeCompanyName(j.company);
    if (norm.length < 2) continue;
    const needle = ' ' + norm + ' ';
    let jobMatches = null;
    for (const p of prepped) {
      if (!p.hay.includes(needle)) continue;
      matchedProfiles.add(p.c.profileUrl);
      // byProfile direction
      let arr = byProfile.get(p.c.profileUrl);
      if (!arr) { arr = []; byProfile.set(p.c.profileUrl, arr); }
      if (arr.length < 25) arr.push({ jobLink: j.jobLink, title: j.title, company: j.company });
      // byJobLink direction
      if (!jobMatches) { jobMatches = []; byJobLink.set(j.jobLink, jobMatches); }
      if (jobMatches.length < 20) {
        jobMatches.push({
          profileUrl: p.c.profileUrl,
          profileSlug: p.c.profileSlug,
          name: p.c.name,
          headline: p.c.headline,
          photoUrl: p.c.photoUrl,
          messageUrl: p.c.messageUrl,
          firstSeenAt: p.c.firstSeenAt,
          firstSeenMs: p.firstSeenMs,
        });
      }
    }
  }
  const entry = { at: Date.now(), byProfile, byJobLink, matchedProfiles };
  _matchIndexCache.set(ownerKey, entry);
  writeDiskCache(ownerKey, entry);
  return entry;
}

// Compare helpers used by listConnections + UI sort param. Sort keys:
//   connected-desc (default), connected-asc, name-asc, name-desc,
//   match-desc, match-asc.
// connected-* sorts on the ISO `connectedOn` field; rows missing it sort last.
function _cmpConnected(a, b, dir) {
  const av = a.connectedOn || '';
  const bv = b.connectedOn || '';
  if (!av && !bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
}
function _cmpName(a, b, dir) {
  const r = (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
  return dir === 'asc' ? r : -r;
}
function _cmpMatch(a, b, dir) {
  const an = (a.matchingJobs || []).length;
  const bn = (b.matchingJobs || []).length;
  return dir === 'asc' ? an - bn : bn - an;
}
function _sorter(sort) {
  switch (sort) {
    case 'connected-asc': return (a, b) => _cmpConnected(a, b, 'asc');
    case 'name-asc':      return (a, b) => _cmpName(a, b, 'asc');
    case 'name-desc':     return (a, b) => _cmpName(a, b, 'desc');
    case 'match-asc':     return (a, b) => _cmpMatch(a, b, 'asc');
    case 'match-desc':    return (a, b) => _cmpMatch(a, b, 'desc');
    case 'connected-desc':
    default:              return (a, b) => _cmpConnected(a, b, 'desc');
  }
}

export const listConnections = async ({
  limit = 200, skip = 0, owner = null, q = null, sort = null,
  hasJobMatch = false, withMatchedJobs = false,
} = {}) => {
  await ensureIndex();

  // Sorting by match count needs the match index loaded for every row, not
  // just the page slice — so we load it whenever sort is match-* even if
  // hasJobMatch / withMatchedJobs weren't asked for.
  const sortNeedsMatches = sort === 'match-desc' || sort === 'match-asc';

  let matchIndex = null;
  if (hasJobMatch || withMatchedJobs || sortNeedsMatches) {
    matchIndex = await ownerMatchesIndex({ owner });
  }
  const cappedLimit = Math.min(Math.max(1, parseInt(limit) || 200), 2000);
  const cappedSkip = Math.max(0, parseInt(skip) || 0);

  // ── Mirror path ── filter the in-memory Map; ~µs even for 1000+ connections.
  if (connectionsMirror.loaded) {
    const re = (q && String(q).trim())
      ? new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : null;
    const matchSet = hasJobMatch ? matchIndex.matchedProfiles : null;
    const matched = connectionsMirror.filter((d) => {
      if (owner && !(d.owners?.includes(owner))) return false;
      if (matchSet && !matchSet.has(d.profileUrl)) return false;
      if (re && !re.test(`${d.name || ''}\n${d.headline || ''}`)) return false;
      return true;
    });
    // Attach matchingJobs BEFORE sorting so match-* sort sees the counts.
    // Enrich each match with the OWNER's apply state on that job so the
    // connections page can show / filter by "Recently applied" without a
    // second round-trip. We index job_tracker by jobLink once per request
    // (microseconds over the mirror) so the per-match lookup is O(1).
    if ((withMatchedJobs || sortNeedsMatches) && matchIndex) {
      let jobsByLink = null;
      if (owner && jobTrackerMirror.loaded) {
        jobsByLink = new Map();
        for (const j of jobTrackerMirror.iter()) {
          if (j.jobLink) jobsByLink.set(j.jobLink, j);
        }
      }
      for (const d of matched) {
        const matches = matchIndex.byProfile.get(d.profileUrl) || [];
        d.matchingJobs = jobsByLink
          ? matches.map(m => ({
              ...m,
              appliedAt: jobsByLink.get(m.jobLink)?.users?.[owner]?.appliedAt || null,
            }))
          : matches;
      }
    }
    matched.sort(_sorter(sort));
    const page = matched.slice(cappedSkip, cappedSkip + cappedLimit);
    if (!withMatchedJobs && sortNeedsMatches) {
      // Sort needed matches but the caller didn't ask for them — strip
      // so we don't leak them onto the wire.
      for (const d of page) delete d.matchingJobs;
    }
    return page;
  }

  const c = await col('connections');
  const filter = {};
  if (owner) filter.owners = owner;
  if (hasJobMatch) {
    filter.profileUrl = { $in: [...matchIndex.matchedProfiles] };
  }
  if (q && String(q).trim()) {
    const re = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: re }, { headline: re }];
  }

  // Mongo fallback: only connected-* and name-* push down cleanly. match-*
  // needs the in-memory index → we fetch a wider window, sort in JS, slice.
  if (sortNeedsMatches) {
    const docs = await c.find(filter).toArray();
    if (matchIndex) {
      for (const d of docs) d.matchingJobs = matchIndex.byProfile.get(d.profileUrl) || [];
    }
    docs.sort(_sorter(sort));
    const page = docs.slice(cappedSkip, cappedSkip + cappedLimit);
    if (!withMatchedJobs) for (const d of page) delete d.matchingJobs;
    return page;
  }

  const mongoSort =
    sort === 'name-asc'      ? { name: 1 }
    : sort === 'name-desc'   ? { name: -1 }
    : sort === 'connected-asc' ? { connectedOn: 1 }
    : { connectedOn: -1 };

  const docs = await c
    .find(filter)
    .sort(mongoSort)
    .skip(cappedSkip)
    .limit(cappedLimit)
    .toArray();

  if (withMatchedJobs && matchIndex) {
    for (const d of docs) d.matchingJobs = matchIndex.byProfile.get(d.profileUrl) || [];
  }
  return docs;
};

// Bulk match: returns a Map of jobLink → matching connections.
// Now O(visible-jobs) instead of O(jobs × connections) — the heavy work
// is done once in ownerMatchesIndex (cached 30s) and we just look up each
// jobLink. Cuts a 24s /api/apply/jobs call to ~300ms warm.
//
// `seenAtByJob` is the only per-call work — we layer the isNew flag onto
// the cached results so the popover's NEW dot stays accurate even when
// the user has marked-seen a job between renders.
export const getMatchesForJobs = async ({ jobs, owner, seenAtByJob = new Map() } = {}) => {
  if (!Array.isArray(jobs) || !jobs.length) return new Map();
  await ensureIndex();
  const index = await ownerMatchesIndex({ owner });
  const out = new Map();
  for (const j of jobs) {
    const hits = index.byJobLink.get(j.jobLink);
    if (!hits || !hits.length) continue;
    const seenMs = seenAtByJob.get(j.jobLink)
      ? new Date(seenAtByJob.get(j.jobLink)).getTime() : 0;
    out.set(j.jobLink, hits.map(h => ({
      profileUrl: h.profileUrl,
      profileSlug: h.profileSlug,
      name:       h.name,
      headline:   h.headline,
      photoUrl:   h.photoUrl,
      messageUrl: h.messageUrl,
      firstSeenAt: h.firstSeenAt,
      isNew: h.firstSeenMs > seenMs,
    })));
  }
  return out;
};

export const countConnections = async () => {
  await ensureIndex();
  return (await col('connections')).estimatedDocumentCount();
};

// True totals for the connections page's headline stats. The page pages
// through 200 rows at a time, so client-side reductions can't compute these
// accurately. We run one pass over the user's connections plus a
// distinct-companies query against job_tracker.
//
// Returns: { totalConnections, withJobMatch, distinctMatchingCompanies,
//            distinctTrackedCompanies }
//   - totalConnections           — the user's connection count
//   - withJobMatch               — connections whose headline matches the
//                                   normalized company of ANY tracked job
//   - distinctMatchingCompanies  — distinct tracked companies with ≥1 match
//   - distinctTrackedCompanies   — distinct non-empty companies in job_tracker
export const connectionMatchStats = async ({ owner = null } = {}) => {
  await ensureIndex();

  // ── Mirror path ── three queries collapsed into pure JS over the
  // in-memory Maps. Was 1.8 s on Atlas free tier; now ~5 ms regardless
  // of dataset size because there's no network hop.
  if (connectionsMirror.loaded && jobTrackerMirror.loaded) {
    const connects = owner
      ? connectionsMirror.filter(d => d.owners?.includes(owner))
      : connectionsMirror.all();
    const totalConnections = connects.length;

    // Distinct non-empty company names from job_tracker, computed once.
    const companySet = new Set();
    for (const j of jobTrackerMirror.iter()) {
      if (j.company && j.company.trim()) companySet.add(j.company);
    }
    const companies = [...companySet];

    const prepped = connects.map(c => ' ' + normalizeCompanyName(c.headline || '') + ' ');
    const connectMatched = new Array(prepped.length).fill(false);
    let distinctMatchingCompanies = 0;
    for (const co of companies) {
      const n = normalizeCompanyName(co);
      if (n.length < 2) continue;
      const needle = ' ' + n + ' ';
      let any = false;
      for (let i = 0; i < prepped.length; i++) {
        if (prepped[i].includes(needle)) { connectMatched[i] = true; any = true; }
      }
      if (any) distinctMatchingCompanies++;
    }
    return {
      totalConnections,
      withJobMatch: connectMatched.filter(Boolean).length,
      distinctMatchingCompanies,
      distinctTrackedCompanies: companies.length,
    };
  }

  // ── Mongo fallback (mirror still loading) ──
  const cConn = await col('connections');
  const cJobs = await col('job_tracker');
  const connFilter = owner ? { owners: owner } : {};
  const [connects, companies, totalConnections] = await Promise.all([
    cConn.find(connFilter, { projection: { headline: 1 } }).toArray(),
    cJobs.distinct('company', { company: { $ne: '', $ne: null } }),
    cConn.countDocuments(connFilter),
  ]);

  const prepped = connects.map(c => ' ' + normalizeCompanyName(c.headline || '') + ' ');
  const connectMatched = new Array(prepped.length).fill(false);
  let distinctMatchingCompanies = 0;
  for (const co of companies) {
    const n = normalizeCompanyName(co);
    if (n.length < 2) continue;
    const needle = ' ' + n + ' ';
    let any = false;
    for (let i = 0; i < prepped.length; i++) {
      if (prepped[i].includes(needle)) { connectMatched[i] = true; any = true; }
    }
    if (any) distinctMatchingCompanies++;
  }
  return {
    totalConnections,
    withJobMatch: connectMatched.filter(Boolean).length,
    distinctMatchingCompanies,
    distinctTrackedCompanies: companies.filter(c => c && c.trim()).length,
  };
};

// Connections whose headline references the given company. Used by the apply
// row's "X connects at this company" hint. `owner` is the local user; null
// (pre-/setup) searches every row.
export const findConnectsForCompany = async (company, { owner = null } = {}) => {
  const norm = normalizeCompanyName(company);
  if (!norm) return [];
  const all = await listConnections({ limit: 5000, owner });
  return all.filter(c => headlineMatchesCompany(c.headline, norm));
};

// ── Writes ────────────────────────────────────────────────────────────────

// Upsert a batch of scraped records. Dedupes by profileUrl, refreshes
// updatable fields (headline edits, photo updates), keeps firstSeenAt frozen.
// `owner` (the local user) is REQUIRED — an owner-less row is one nobody can
// act on later — and is written with $addToSet so re-scraping the same
// profile never duplicates the entry.
// Returns { added, updated, accepted, total }.
export const upsertConnections = async ({ records = [], source = null, owner = null } = {}) => {
  if (!owner || !String(owner).trim()) {
    throw new Error('upsertConnections: owner (the local user) is required');
  }
  await ensureIndex();
  if (!Array.isArray(records) || !records.length) {
    return { added: 0, updated: 0, accepted: 0, total: await countConnections() };
  }
  const c = await col('connections');
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;

  // Read existing rows once so we can tell added vs updated and freeze
  // firstSeenAt for known profiles.
  const urls = records.map(r => r?.profileUrl).filter(Boolean);
  const existing = new Map(
    (await c.find({ profileUrl: { $in: urls } }).toArray()).map(d => [d.profileUrl, d]),
  );

  // $addToSet auto-creates the array if missing, so no $setOnInsert for
  // owners is needed on the insert side.
  const ownerOp = { $addToSet: { owners: owner } };
  const ops = [];
  for (const rec of records) {
    if (!rec || !rec.profileUrl) continue;
    const prev = existing.get(rec.profileUrl);
    const { firstSeenAt: recFirst, lastSeenAt: recLast, ...recRest } = rec;
    if (!prev) {
      added++;
      ops.push({
        updateOne: {
          filter: { profileUrl: rec.profileUrl },
          update: {
            $set: { ...recRest, lastSeenAt: recLast || now, source: source || null },
            $setOnInsert: { firstSeenAt: recFirst || now },
            ...ownerOp,
          },
          upsert: true,
        },
      });
    } else {
      if (prev.headline !== rec.headline || prev.name !== rec.name) updated++;
      ops.push({
        updateOne: {
          filter: { profileUrl: rec.profileUrl },
          update: {
            $set: { ...recRest, lastSeenAt: recLast || now, source: source || prev.source || null },
            ...ownerOp,
          },
        },
      });
    }
  }

  if (ops.length) {
    await c.bulkWrite(ops, { ordered: false });
    // Refresh the mirror for the affected docs. The bulkWrite already
    // stamped updatedAt via the col() proxy, so we just need to read
    // them back and seed the in-memory copy. (The delta-sync loop would
    // catch this within 15 s anyway; this is the "same-process" shortcut.)
    try {
      const touchedUrls = [...new Set(records.map(r => r.profileUrl).filter(Boolean))];
      if (touchedUrls.length) {
        const refreshed = await c.find({ profileUrl: { $in: touchedUrls } }).toArray();
        connectionsMirror.applyMany(refreshed);
      }
    } catch { /* non-fatal */ }
  }
  // New connections (or updated headlines) invalidate the match index so
  // the next /api/apply/jobs?includeRefs call rebuilds against fresh data
  // instead of serving stale cached refs.
  if (added > 0 || updated > 0) invalidateMatchIndex({ owner });

  // A connections scrape is the only signal we get that an invitation was
  // accepted — LinkedIn exposes no API for it. Anyone in this batch who has an
  // outstanding invite moves to `connected` and surfaces in the follow-up
  // queue. Imported lazily to keep the connections store free of a feed
  // dependency, and non-fatal because a failure here must not lose the upload.
  let accepted = 0;
  try {
    const { markAcceptedFromConnections } = await import('../feed/connects-store.js');
    accepted = await markAcceptedFromConnections({ records, owner });
  } catch { /* non-fatal — the queue just stays as-is until the next scrape */ }

  return { added, updated, accepted, total: await countConnections() };
};

export const deleteAllConnections = async () => {
  await ensureIndex();
  await (await col('connections')).deleteMany({});
};

// ── View state (mark-seen timestamps) ─────────────────────────────────────

const VIEW_KEY = { _id: 'global' };

export const readViewState = async () => {
  const c = await col('scanner_view_state');
  const doc = await c.findOne(VIEW_KEY);
  return {
    jobsLastViewedAt: doc?.jobsLastViewedAt || null,
    perCompanySeenAt: doc?.perCompanySeenAt || {},
  };
};

export const markSeen = async ({ company } = {}) => {
  const now = new Date().toISOString();
  const c = await col('scanner_view_state');
  if (company) {
    const norm = normalizeCompanyName(company);
    if (!norm) throw new Error('company normalizes to empty');
    await c.updateOne(
      VIEW_KEY,
      { $set: { [`perCompanySeenAt.${norm}`]: now } },
      { upsert: true },
    );
    return { scope: 'company', company, normalizedCompany: norm, seenAt: now };
  }
  // Global mark-all subsumes per-company stamps.
  await c.updateOne(
    VIEW_KEY,
    { $set: { jobsLastViewedAt: now, perCompanySeenAt: {} } },
    { upsert: true },
  );
  return { scope: 'all', jobsLastViewedAt: now };
};

export const effectiveSeenMs = (viewState, normalizedCompany) => {
  const g = viewState.jobsLastViewedAt
    ? new Date(viewState.jobsLastViewedAt).getTime() : 0;
  const c = normalizedCompany && viewState.perCompanySeenAt?.[normalizedCompany]
    ? new Date(viewState.perCompanySeenAt[normalizedCompany]).getTime() : 0;
  return Math.max(g, c);
};

// ── Per-(owner, jobLink) mark-seen ────────────────────────────────────────
// Used by the apply page's inline refs popover: opening a popover stamps
// (owner, jobLink) → now, so the NEW dot disappears next render. Separate
// from the global mark-seen above because this fires constantly (one per
// popover open) and we don't want to balloon a single document.

let _viewSeenIndexed = false;
const ensureViewSeenIndex = async () => {
  if (_viewSeenIndexed) return;
  const c = await col('connection_view_state');
  await c.createIndex({ owner: 1, jobLink: 1 }, { unique: true });
  _viewSeenIndexed = true;
};

export const markJobConnectsSeen = async ({ owner, jobLink }) => {
  if (!owner || !jobLink) throw new Error('markJobConnectsSeen: owner + jobLink required');
  await ensureViewSeenIndex();
  const now = new Date().toISOString();
  await (await col('connection_view_state')).updateOne(
    { owner, jobLink },
    { $set: { owner, jobLink, seenAt: now } },
    { upsert: true },
  );
  return { owner, jobLink, seenAt: now };
};

// Bulk fetch the seenAt timestamp for many (owner, jobLink) pairs. Returns a
// Map keyed by jobLink. Used by /api/apply/jobs to compute isNew per row.
export const getSeenAtByJob = async ({ owner, jobLinks }) => {
  const out = new Map();
  if (!owner || !Array.isArray(jobLinks) || !jobLinks.length) return out;
  await ensureViewSeenIndex();
  const docs = await (await col('connection_view_state'))
    .find({ owner, jobLink: { $in: jobLinks } }, { projection: { jobLink: 1, seenAt: 1 } })
    .toArray();
  for (const d of docs) out.set(d.jobLink, d.seenAt);
  return out;
};
