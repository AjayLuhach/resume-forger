// Extension-facing API. Mounted at /api/ext on the tailor server, BEFORE the
// auth gate — the browser extension calls these from linkedin.com without a
// login flow of its own. That is safe because this tool runs as ONE person
// against ONE database: identity comes from `resolveUsername(req)` — the
// session cookie when the background worker forwards one (fetches use
// credentials:'include'), else the sole document in `users`. There is no
// per-request user override; the extension has no identity picker.
//
// Endpoints:
//   GET    /api/ext/health
//   GET    /api/ext/result/:jobId           — cache lookup by platform jobId
//   POST   /api/ext/results/by-ids          — batch cache lookup (/scanner)
//   GET    /api/ext/job?jobLink=            — cache lookup by URL
//   GET    /api/ext/results                 — recent analyzed rows (popup)
//   POST   /api/ext/log                     — extension error sink
//   POST   /api/ext/jobs/status             — mark applied / rejected
//   POST   /api/ext/analyze                 — AI analysis + filter rules
//   POST   /api/ext/company-scrape          — headcount backfill
//   GET    /api/ext/debug/:jobId            — extractor debug snapshot
//   POST   /api/ext/connect-note            — regenerate note
//   GET    /api/ext/note-for-company?company= — fallback: latest note for
//                                               the company (preferring
//                                               rows the user applied to)
//   GET    /api/ext/filters                 — read filter config
//   PUT    /api/ext/filters                 — update filters
//   POST   /api/ext/filters/block-company   — add to blocklist
//   DELETE /api/ext/filters/block-company/:name
//   GET    /api/ext/applied/by-job          — { jobId → { applied, status, rowStatus } }
//   POST   /api/ext/connections             — upload scraped LinkedIn connects
//   GET    /api/ext/connections             — list connections
//   DELETE /api/ext/connections             — wipe
//   GET    /api/ext/connections/match-stats
//   GET    /api/ext/connections/for-company?company=
//   POST   /api/ext/connections/mark-seen
//   …plus the scan-capture / feed-capture buffers, saved searches and feed
//   sources (all identity-free) at the bottom of this file.
import { Router } from 'express';
import { analyzeJob, regenerateConnectNote } from '../scanner/index.js';
import { readFilters, writeFilters, blockCompany, unblockCompany } from '../scanner/filters-store.js';
import { readSearches, writeSearches } from '../scanner/searches-store.js';
import { readSources, writeSources } from '../feed/feed-sources-store.js';
import * as scanBuffer from '../scanner/scan-buffer.js';
import * as feedCaptureBuffer from '../feed/feed-capture-buffer.js';
import {
  getJobByJobId, getJobByLink, getAppliedByJobId, updateUserStatus,
  backfillCompanyDetailsByCompany,
} from '../apply/job-store.js';
import {
  upsertConnections, listConnections, deleteAllConnections,
  findConnectsForCompany, markSeen, connectionMatchStats,
} from '../connections/store.js';
import { retireForJob } from '../apply/resume-outbox.js';
import { log } from '../log.js';
import { col } from '../db.js';
import { resolveUsername, requireUsername } from '../users/current.js';
import { markAutoConnect } from '../feed/connects-store.js';
import { loadCandidate } from '../feed/feed-config.js';
import { yearsOfExperienceFor } from '../users/experience.js';
import { jobTrackerMirror } from '../mirror.js';

const router = Router();

// Resolve the {{exp}} / {{name}} placeholders in a connect note for the
// given user. Mutates a shallow copy of the doc so the cached value in
// Mongo / the mirror keeps the placeholders intact — substitution is a
// render-time concern, not a storage one. {{name}} defaults to "there"
// (so "Hi there,") when the caller hasn't supplied a recipient — the
// extension's modal observer is what carries a real name through.
async function withResolvedConnectNote(doc, username, recipientName = null) {
  if (!doc?.connectNote) return doc;
  let note = doc.connectNote;
  if (username && note.includes('{{exp}}')) {
    const years = await yearsOfExperienceFor(username);
    if (years) note = note.replaceAll('{{exp}}', years);
  }
  if (note.includes('{{name}}')) {
    const name = (recipientName && String(recipientName).trim()) || 'there';
    note = note.replaceAll('{{name}}', name);
  }
  if (note === doc.connectNote) return doc;
  return { ...doc, connectNote: note };
}

// Has the operator applied to this (hydrated) row? `hydrate()` already
// coerces the legacy 'yes' / status-implies-applied shapes into a boolean,
// so this is a plain read — no second coercion here.
const appliedBy = (doc, username) =>
  !!(username && doc?.users?.[username]?.applied === true);

// The candidate profile the scanner prompts against. Absent (null) on a
// fresh install before /resume is filled in — the prompt then renders
// without the candidate section rather than failing the scan.
async function candidateFor(username, scope) {
  if (!username) return null;
  try {
    return await loadCandidate(username);
  } catch (e) {
    log.warn(scope, `candidate profile unavailable for "${username}": ${e.message} — analyzing without it`);
    return null;
  }
}

// ── Health ────────────────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', extension: 'job-scanner', mounted: '/api/ext' });
});

// ── Job lookups ──────────────────────────────────────────────────────────

// Batch lookup — used by /scanner's importer to mark each pasted ID as NEW
// vs SCANNED in one round-trip. Mirror-backed via getJobByJobId, so a 200-ID
// batch is sub-ms. `importedFrom` lets the page tell a peer-imported row
// from one this install analyzed itself.
router.post('/results/by-ids', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.jobIds) ? req.body.jobIds : [];
    const username = await resolveUsername(req);
    const out = {};
    for (const id of ids) {
      const doc = await getJobByJobId(String(id));
      if (doc) {
        const applied = appliedBy(doc, username);
        out[String(id)] = {
          jobId: doc.jobId, url: doc.jobLink,
          title: doc.title, company: doc.company,
          verdict: doc.verdict, score: doc.score,
          easyApply: typeof doc.easyApply === 'boolean' ? doc.easyApply : null,
          status: doc.rowStatus || (applied ? 'applied' : null),
          applied,
          importedFrom: doc.importedFrom || null,
          analyzedAt: doc.analyzedAt,
        };
      }
    }
    res.json({ results: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/result/:jobId', async (req, res) => {
  try {
    const doc = await getJobByJobId(req.params.jobId);
    if (!doc) return res.status(404).json({ analysis: null });
    // Row exists but has never been analyzed (or was cleared by the rescan
    // flow). Treat as "not cached" so the extension's content.js falls into
    // its fresh-scan path instead of short-circuiting on the stub doc.
    if (!doc.verdict) return res.status(404).json({ analysis: null });
    const username = await resolveUsername(req);
    const resolved = await withResolvedConnectNote(doc, username);
    // `imported` tells the extension this verdict came from a peer's
    // database: it shows the badge but still runs /analyze so the row is
    // re-scored against THIS operator's resume. `applied` drives the
    // badge's applied state (the extension no longer knows its own name).
    res.json({
      analysis: resolved,
      cached: true,
      imported: !!resolved.importedFrom,
      applied: appliedBy(resolved, username),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/job', async (req, res) => {
  try {
    const jobLink = req.query.jobLink ? String(req.query.jobLink) : '';
    if (!jobLink) return res.status(400).json({ error: 'jobLink required' });
    const doc = await getJobByLink(jobLink);
    if (!doc) return res.status(404).json({ job: null });
    const username = await resolveUsername(req);
    const resolved = await withResolvedConnectNote(doc, username);
    res.json({ job: resolved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recent scanned jobs — the popup's "Results" tab. Only rows with a verdict
// (i.e. ones the AI has actually analyzed), newest first. Limit-capped to
// keep the popup snappy.
router.get('/results', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const username = await resolveUsername(req);
    const c = await col('job_tracker');
    const docs = await c.find(
      { verdict: { $exists: true, $ne: null, $ne: '' } },
      { projection: { jobText: 0 } },
    ).sort({ analyzedAt: -1, _id: -1 }).limit(limit).toArray();
    // These are raw Mongo docs, not hydrated ones, so the per-user applied
    // flag comes from the store (which owns the legacy-shape coercion)
    // rather than being re-derived here.
    const appliedMap = username
      ? await getAppliedByJobId({ jobIds: docs.map(d => d.jobId).filter(Boolean), username })
      : {};
    res.json(docs.map(d => {
      const applied = !!appliedMap[d.jobId]?.applied;
      return {
        jobId: d.jobId,
        url: d.jobLink,
        title: d.title,
        company: d.company,
        verdict: d.verdict,
        score: d.score,
        analyzedAt: d.analyzedAt,
        status: applied ? 'applied' : null,
        applied,
        importedFrom: d.importedFrom || null,
      };
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Receive uncaught extension errors so they show up in the tailor server
// log instead of dying silently in chrome://extensions. The extension's
// global window.onerror / unhandledrejection handlers POST here. Body:
// { level, scope, message, url, userAgent, stack }. Dedup is the client's
// job (it throttles by message hash); we just append.
router.post('/log', async (req, res) => {
  try {
    const { level, scope, message, url, userAgent, stack } = req.body || {};
    const tag = `ext:${scope || 'unknown'}`;
    const prefix = `[${url || '-'}] ${message || ''}`;
    if (level === 'error') log.err(tag, prefix, stack || '', userAgent ? `ua=${userAgent}` : '');
    else if (level === 'warn') log.warn(tag, prefix, userAgent ? `ua=${userAgent}` : '');
    else log.info(tag, prefix);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark a job applied / rejected / pending from the in-page scanner badge,
// without bouncing the operator to /apply. Body: { jobId, status, notes }.
// `status` accepts the same values updateUserStatus does: 'applied',
// 'interviewing', 'success', 'rejected', or 'pending' (reset).
router.post('/jobs/status', async (req, res) => {
  try {
    const user = await requireUsername(req, res);
    if (!user) return;
    const { jobId, status, notes } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    if (!status) return res.status(400).json({ error: 'status required' });
    const doc = await getJobByJobId(String(jobId));
    if (!doc) return res.status(404).json({ error: `no job_tracker row for jobId ${jobId}` });
    const out = await updateUserStatus({
      user,
      jobLink: doc.jobLink,
      patch: { status, notes: notes || '' },
    });
    // Same housekeeping the apply page gets — the extension marks jobs too
    // (TEMPORARY — ATS experiment).
    const outbox = retireForJob(out, status);
    if (outbox?.removedFiles.length || outbox?.removedDirs.length) {
      log.info('outbox:retire', `${out.company} / ${out.title} — ${outbox.removedFiles.length} file(s), ${outbox.removedDirs.length} dir(s) [ext]`);
    }
    res.json({
      ok: true, jobId: out.jobId, jobLink: out.jobLink,
      rowStatus: out.rowStatus || null,
      applied: appliedBy(out, user),
      outbox,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Analyze ──────────────────────────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  const {
    jobText, pageUrl, pageTitle, jobId, companyInfo,
    jobType, workMode, easyApply, applicantsCount, applicantsNumeric,
  } = req.body || {};
  const t0 = Date.now();
  log.info('scanner:analyze', `request received jobId=${jobId || '-'} url=${pageUrl} textBytes=${jobText?.length || 0} hasCompanyInfo=${!!companyInfo} hasDebug=${!!companyInfo?.__debug} jobType=${jobType || '-'} workMode=${workMode || '-'} apply=${applicantsCount || '-'} origin=${req.headers.origin || '-'}`);
  try {
    const username = await resolveUsername(req);
    const candidate = await candidateFor(username, 'scanner:analyze');
    const result = await analyzeJob({
      jobText, pageUrl, pageTitle, jobId, companyInfo,
      jobType, workMode, easyApply, applicantsCount, applicantsNumeric,
      candidate,
    });
    // Substitute {{exp}} in the connect note for the operator before
    // shipping. Stored copy in Mongo keeps the placeholder so subsequent
    // re-renders pick up the user's CURRENT years (drift safety).
    if (result?.analysis) {
      result.analysis = await withResolvedConnectNote(result.analysis, username);
      // A fresh analysis clears any peer import on the row, so `imported`
      // is false here in practice; shipped anyway so the extension reads
      // one shape from /result and /analyze.
      result.imported = !!result.analysis.importedFrom;
      result.applied = appliedBy(result.analysis, username);
    }
    log.ok('scanner:analyze', `ok jobId=${jobId} verdict=${result.analysis?.verdict} score=${result.analysis?.score} cached=${!!result.cached} dur=${Date.now() - t0}ms`);
    res.json(result);
  } catch (e) {
    log.err('scanner:analyze', `failed jobId=${jobId} url=${pageUrl} dur=${Date.now() - t0}ms err=${e.name}: ${e.message}`);
    if (e.stack) log.err('scanner:analyze', `stack: ${e.stack.split('\n').slice(0, 5).join(' | ')}`);
    res.status(e.statusCode || 500).json({ error: e.message, name: e.name });
  }
});

// Company-page headcount scrape → backfill companyDetails on every job row for that company. No AI, no verdict.
router.post('/company-scrape', async (req, res) => {
  const { slug, url, details, unavailable } = req.body || {};
  const t0 = Date.now();
  try {
    const out = await backfillCompanyDetailsByCompany({ slug, companyUrl: url, details, unavailable: !!unavailable });
    log.ok('scanner:company-scrape',
      `slug=${out.slug || '-'} company="${out.company || '-'}" emp=${out.unavailable ? 'UNAVAILABLE' : (out.fields?.employeesOnLinkedIn || out.fields?.employeeCount || '-')} matched=${out.matched} updated=${out.updated}${out.nameAmbiguous ? ' nameAmbiguous' : ''} dur=${Date.now() - t0}ms`);
    res.json(out);
  } catch (e) {
    log.err('scanner:company-scrape', `failed slug=${slug || '-'} url=${url} err=${e.message}`);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Extraction-debug — fetch the raw scraped HTML / corpus the extractor saw
// for a given jobId. Used by the apply page's "Show extraction debug" link.
router.get('/debug/:jobId', async (req, res) => {
  try {
    const { getDebugSnapshot } = await import('../scanner/debug-store.js');
    const doc = await getDebugSnapshot(req.params.jobId);
    if (!doc) return res.status(404).json({ error: 'No debug snapshot for this jobId' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Connect-note regenerate ──────────────────────────────────────────────

router.post('/connect-note', async (req, res) => {
  try {
    const { title, company, tone, jobId, jobLink } = req.body || {};
    const username = await resolveUsername(req);
    const candidate = await candidateFor(username, 'scanner:connect-note');
    const out = await regenerateConnectNote({ jobId, jobLink, title, company, tone, candidate });
    // Resolve {{exp}} BEFORE returning so the apply page (and the extension)
    // get a copy-paste-ready note without depending on a follow-up
    // substitution. Stored value keeps the placeholder intact — see the
    // withResolvedConnectNote comment for why substitution stays a
    // render-time concern at the storage layer. {{name}} stays unresolved
    // here — the recipient isn't known until the user picks someone to
    // message; the extension's modal observer does that substitution.
    let note = out.note;
    if (username && note?.includes('{{exp}}')) {
      const years = await yearsOfExperienceFor(username);
      if (years) note = note.replaceAll('{{exp}}', years);
    }
    res.json({ ...out, note });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Filters ──────────────────────────────────────────────────────────────

router.get('/filters', async (_req, res) => {
  try { res.json(await readFilters()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/filters', async (req, res) => {
  try {
    const saved = await writeFilters(req.body || {});
    log.info('scanner:filters', `updated keys=${Object.keys(saved).join(',')}`);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/filters/block-company', async (req, res) => {
  try {
    const { company } = req.body || {};
    if (!company || !String(company).trim()) {
      return res.status(400).json({ error: 'company name required' });
    }
    const name = String(company).trim();
    const filters = await blockCompany(name);

    // Two-step row update so the user's intent ("block this company
    // everywhere") actually evicts the rows from their Pending queue:
    //   1) Tag every matching row with verdict='skip' + blockedReasons.
    //      Annotation-only — runs regardless of current rowStatus.
    //   2) Row-level reject every matching row that isn't ALREADY
    //      rejected. Skipping already-rejected rows protects existing
    //      rejectedBy / rejectedAt / rejectedNotes — a row the operator
    //      rejected by hand last week, with a note explaining why, keeps
    //      that note when the company is blocked today.
    //
    // Previously this only did step 1, which is why the apply page never
    // hid the blocked rows: the Pending filter keys off rowStatus, not
    // verdict.
    const c = await col('job_tracker');
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const now = new Date().toISOString();
    await c.updateMany(
      { company: re },
      { $set: { verdict: 'skip', blockedReasons: [`company blocked: ${name}`] } },
    );
    const r = await c.updateMany(
      { company: re, rowStatus: { $ne: 'rejected' } },
      {
        $set: {
          rowStatus: 'rejected',
          rejectedAt: now,
          rejectedBy: 'system:block-company',
          rejectedNotes: `Company blocked: ${name}`,
        },
      },
    );

    // Refresh the in-process mirror with the affected rows so the apply
    // page's reload() shows the new state without waiting on the 15s
    // delta tick.
    try {
      const docs = await c.find({ company: re }).toArray();
      if (docs.length) jobTrackerMirror.applyMany(docs);
    } catch { /* non-fatal */ }

    log.info('scanner:filters', `blocked company="${name}" markedRows=${r.modifiedCount}`);
    res.json({ success: true, filters, markedBlocked: r.modifiedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/filters/block-company/:name', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const filters = await unblockCompany(name);
    log.info('scanner:filters', `unblocked company="${name}"`);
    res.json({ success: true, filters });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Apply state per job for the operator: { jobId → { applied, status,
// rowStatus } }. Read-only; `jobIds` narrows the result, otherwise every
// row that carries state is returned.
router.get('/applied/by-job', async (req, res) => {
  try {
    const ids = req.query.jobIds
      ? String(req.query.jobIds).split(',').map(s => s.trim()).filter(Boolean)
      : null;
    const username = await requireUsername(req, res);
    if (!username) return;
    const out = await getAppliedByJobId({ jobIds: ids, username });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Connections ──────────────────────────────────────────────────────────

router.post('/connections', async (req, res) => {
  try {
    const { records, source, scrapedAt, totalCount } = req.body || {};
    if (!Array.isArray(records)) return res.status(400).json({ error: 'records[] required' });
    // Every scraped connection belongs to the operator. Refusing without a
    // user (only possible before /setup) beats writing orphan rows nobody
    // can act on later.
    const owner = await requireUsername(req, res);
    if (!owner) return;
    const out = await upsertConnections({ records, source, owner });
    if (out.added > 0 || out.updated > 0) {
      log.info('connections:upload', `+${out.added} (updated ${out.updated}, total ${out.total}, src ${source || '?'}, owner ${owner})`);
    }
    res.json({
      success: true,
      ...out,
      owner,
      totalCountOnPage: typeof totalCount === 'number' ? totalCount : null,
      scrapedAt: scrapedAt || new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/connections', async (req, res) => {
  try {
    const owner = await resolveUsername(req);
    const rows = await listConnections({
      limit: req.query.limit,
      skip: req.query.skip,
      owner,
      q: req.query.q,
      sort: req.query.sort,
      hasJobMatch: req.query.hasJobMatch === '1' || req.query.hasJobMatch === 'true',
      // Always bundle matchingJobs when an owner is set so the page renders
      // the Matching column without a second round-trip.
      withMatchedJobs: !!owner,
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Headline stats for the connections-page top-strip — TRUE totals
// (not paged slice). { totalConnections, withJobMatch,
// distinctMatchingCompanies, distinctTrackedCompanies }.
router.get('/connections/match-stats', async (req, res) => {
  try {
    const owner = await resolveUsername(req);
    res.json(await connectionMatchStats({ owner }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/connections', async (_req, res) => {
  try { await deleteAllConnections(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Company-keyed note fallback. Used by the extension when the user is on
// a page that has no jobId (e.g. a recruiter's profile, a company page,
// or LinkedIn's compose modal opened from outside a job posting). Picks
// the most recent job_tracker row whose company matches case-insensitively
// and that has a non-empty connectNote. Prefer-order:
//   1. Rows the operator has APPLIED to.
//   2. Any analyzed row with a note (newest first by analyzedAt | _id).
// {{exp}} is resolved before return so the response is paste-ready;
// {{name}} stays unresolved (extension fills it from the recipient).
router.get('/note-for-company', async (req, res) => {
  try {
    const company = String(req.query.company || '').trim();
    if (!company) return res.status(400).json({ error: 'company required' });
    const user = await resolveUsername(req);

    const normalized = company.toLowerCase();
    const sameCompany = (d) => (d.company || '').trim().toLowerCase() === normalized;

    // Mirror is the hot path. Falls back to a Mongo find only if the
    // mirror hasn't loaded yet (early boot). Both paths return the same
    // shape — single best-match doc or null.
    let pick = null;
    if (jobTrackerMirror.loaded) {
      const candidates = [];
      for (const d of jobTrackerMirror.iter()) {
        if (!sameCompany(d)) continue;
        if (!d.connectNote) continue;
        candidates.push(d);
      }
      const score = (d) => (user && d.users?.[user]?.applied === true) ? 1 : 0;
      candidates.sort((a, b) => {
        const s = score(b) - score(a);
        if (s !== 0) return s;
        const ta = a.analyzedAt ? new Date(a.analyzedAt).getTime() : 0;
        const tb = b.analyzedAt ? new Date(b.analyzedAt).getTime() : 0;
        if (tb !== ta) return tb - ta;
        return String(b._id).localeCompare(String(a._id));
      });
      pick = candidates[0] || null;
    } else {
      const c = await col('job_tracker');
      // Case-insensitive exact-match on company, with a note. Two passes
      // so we can prefer applied rows without one big aggregation.
      const baseFilter = {
        company: { $regex: `^${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
        connectNote: { $exists: true, $ne: '' },
      };
      if (user) {
        pick = await c.find({ ...baseFilter, [`users.${user}.applied`]: true })
          .sort({ analyzedAt: -1, _id: -1 }).limit(1).next();
      }
      if (!pick) {
        pick = await c.find(baseFilter).sort({ analyzedAt: -1, _id: -1 }).limit(1).next();
      }
    }

    if (!pick) {
      return res.json({ company, note: null, fromJob: null });
    }
    const resolved = await withResolvedConnectNote(pick, user);
    res.json({
      company,
      note: resolved.connectNote,
      fromJob: {
        jobId: pick.jobId || null,
        jobLink: pick.jobLink || null,
        title: pick.title || null,
        analyzedAt: pick.analyzedAt || null,
        appliedByCurrentUser: !!(user && pick.users?.[user]?.applied),
      },
    });
  } catch (e) {
    log.err('ext:note-for-company', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/connections/for-company', async (req, res) => {
  try {
    const company = String(req.query.company || '');
    if (!company) return res.status(400).json({ error: 'company required' });
    const owner = await resolveUsername(req);
    const rows = await findConnectsForCompany(company, { owner });
    res.json({ company, owner, connections: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// What the extension's auto-connect did on a profile page it was sent to by
// the Posts page (sent / pending / already-connected / limit / not-found /
// error). Keyed by profile slug; the connects row flips accordingly.
router.post('/connects/auto-result', async (req, res) => {
  try {
    const username = await requireUsername(req, res);
    if (!username) return;
    const { profileUrl, result, detail } = req.body || {};
    if (!profileUrl || !result) return res.status(400).json({ error: 'profileUrl and result required' });
    const out = await markAutoConnect({ username, profileUrl, result: String(result), detail });
    log.info('connects:auto', `${result} ${profileUrl} (${out.matched} row(s))${detail ? ' — ' + String(detail).slice(0, 600) : ''}`);
    res.json({ ok: true, matched: out.matched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/connections/mark-seen', async (req, res) => {
  try {
    const out = await markSeen({ company: req.body?.company });
    res.json({ success: true, ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Auto-capture buffer ───────────────────────────────────────────────────
// Armed-capture flow for /scanner. The page arms a 5-minute window; while
// armed the extension POSTs each linkedin.com/jobs/search page's HTML here,
// and the page later pulls it back into the importer textarea. All in-memory
// (scan-buffer.js) — process-local, ephemeral, not mongo. See that module.

router.post('/scan-capture/arm', (req, res) => {
  const b = req.body || {};
  res.json(scanBuffer.arm({ autoClose: !!b.autoClose, walk: !!b.walk, pages: b.pages }));
});

router.post('/scan-capture/disarm', (_req, res) => {
  res.json(scanBuffer.disarm());
});

router.get('/scan-capture/status', (_req, res) => {
  res.json(scanBuffer.status());
});

router.post('/scan-capture', (req, res) => {
  const { html, url, kind } = req.body || {};
  const out = scanBuffer.append({ html, url, kind });
  if (out.accepted) {
    log.info('scanner:capture', `+1 ${out.kind} chunk (${(html?.length || 0)} bytes) url=${url || '-'} total=${out.chunkCount}${out.truncated ? ' [truncated]' : ''}`);
  } else if (out.reason === 'full') {
    log.warn('scanner:capture', `DROPPED ${kind || 'html'} chunk — buffer FULL (${out.chunkCount} chunks, dropped=${out.dropped}). Load → Parse → Clear captured, then re-run.`);
  }
  res.json(out);
});

router.get('/scan-capture', (_req, res) => {
  res.json(scanBuffer.read());
});

// "Load" hits this — extraction runs server-side, only the compact result crosses the wire (not the tens-of-MB blob that froze the tab).
router.get('/scan-capture/parsed', (_req, res) => {
  const out = scanBuffer.parsed();
  log.info('scanner:capture', `parsed buffer → ${out.counts.parsed} ids (${out.counts.pages} pages + ${out.counts.api} api, ${(out.counts.bytes / 1048576).toFixed(1)}MB)`);
  res.json(out);
});

router.delete('/scan-capture', (_req, res) => {
  res.json(scanBuffer.clear());
});

// ── Saved searches ────────────────────────────────────────────────────────
// LinkedIn search URLs the /scanner page stores + auto-opens (pages 1..N) for
// the armed capture run. Whole-list read/write (the list is tiny).

router.get('/searches', async (_req, res) => {
  try { res.json(await readSearches()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/searches', async (req, res) => {
  try {
    const saved = await writeSearches(req.body?.searches || []);
    log.info('scanner:searches', `updated count=${saved.length}`);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Feed auto-capture buffer ────────────────────────────────────────────────
// Sibling of /scan-capture: extension POSTs sniffed FEED API pages while armed.
// Parse+generate (needs operator identity) lives on the auth-gated /feed mount.

router.post('/feed-capture/arm', (req, res) => {
  const b = req.body || {};
  res.json(feedCaptureBuffer.arm({ autoClose: !!b.autoClose, walk: !!b.walk, pages: b.pages }));
});

router.post('/feed-capture/disarm', (_req, res) => {
  res.json(feedCaptureBuffer.disarm());
});

router.get('/feed-capture/status', (_req, res) => {
  res.json(feedCaptureBuffer.status());
});

router.post('/feed-capture', (req, res) => {
  const { html, url, kind } = req.body || {};
  const out = feedCaptureBuffer.append({ html, url, kind: kind || 'feed' });
  if (out.accepted) {
    log.info('feed:capture', `+1 feed page (${(html?.length || 0)} bytes) url=${url || '-'} total=${out.chunkCount}${out.truncated ? ' [truncated]' : ''}`);
  } else if (out.reason === 'full') {
    log.warn('feed:capture', `DROPPED feed page — buffer FULL (${out.chunkCount} chunks, dropped=${out.dropped}). Load captured, then re-run.`);
  }
  res.json(out);
});

router.get('/feed-capture', (_req, res) => {
  res.json(feedCaptureBuffer.read());
});

router.delete('/feed-capture', (_req, res) => {
  res.json(feedCaptureBuffer.clear());
});

// ── Feed capture sources ────────────────────────────────────────────────────
// Feed/content-search URLs /feed stores + auto-opens. Whole-list read/write.

router.get('/feed-sources', async (req, res) => {
  try {
    // First read seeds the defaults; with the candidate's skills known it
    // seeds the skill searches too, not just the home feed.
    const username = await resolveUsername(req);
    const candidate = await candidateFor(username, 'feed:sources');
    res.json(await readSources(candidate));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/feed-sources', async (req, res) => {
  try {
    const saved = await writeSources(req.body?.sources || []);
    log.info('feed:sources', `updated count=${saved.length}`);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
