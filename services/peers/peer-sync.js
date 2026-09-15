// Peer job sources — the sync loop.
//
// Every SYNC_INTERVAL_MS this pulls newly analysed rows from each enabled
// peer database into the local job_tracker as PENDING rows, so the operator
// can triage jobs a friend already scraped and analysed without opening the
// listings again. Nothing is ever written to the peer: the client is opened
// with a secondary-preferred read preference and the only calls it makes
// are find / countDocuments (plus one deliberate probe, see testPeer).
//
// Ordering is a (updatedAt, _id) cursor per peer, persisted in
// data/peers.json after each batch's local writes have resolved — a crash
// between the read and the write re-reads the batch, and the local upserts
// are idempotent, so nothing is lost or doubled. Rows without a BSON-Date
// updatedAt are excluded from the peer query outright rather than sorted
// into an undefined position: the peer runs the same col() proxy we do, so
// in practice every row has one.
//
// Local writes go through col('job_tracker') so updatedAt is stamped, and
// the mirror is refreshed from the post-write docs so the apply page's SSE
// channel fires the same way it does for a local scan.
import { MongoClient, ObjectId } from 'mongodb';
import { col, getDb, dbIdentity } from '../db.js';
import { jobTrackerMirror } from '../mirror.js';
import { log } from '../log.js';
import { readFilters } from '../scanner/filters-store.js';
import {
  readPeers, writePeers, getPeer, patchPeerState, setPeerEnabled,
  validatePeerInput, checkPeerKey, normalizePeerKey, PeerConfigError, scrubMessage,
} from './peers-config.js';
import { sanitizePeerJob, analysisFieldsOf, ANALYSIS_FIELDS } from './sanitize.js';

export const SYNC_INTERVAL_MS = 30_000;
const BATCH_SIZE = 500;
const BATCHES_PER_TICK = 2;
// How long a graceful shutdown waits for an in-flight tick before closing
// the clients out from under it.
const STOP_GRACE_MS = 5_000;

// Small pool, short timeouts: a peer that is down must not hold a tick for
// long, and two connections are plenty for one sequential reader.
const CLIENT_OPTIONS = {
  serverSelectionTimeoutMS: 8000,
  connectTimeoutMS: 8000,
  socketTimeoutMS: 30000,
  maxPoolSize: 2,
  retryReads: true,
  readPreference: 'secondaryPreferred',
  appName: 'resume-forge-peer',
};

// What we read from a peer row. Everything the sanitiser whitelists, plus
// the fields it needs to decide a skip (blockedReasons, summary, red_flags,
// rowStatus, rejectedNotes, importedFrom — a row the peer itself imported
// is second-hand and refused) and the cursor fields.
const PROJECTION = Object.fromEntries([
  '_id', 'updatedAt', 'createdAt', 'rowStatus', 'blockedReasons', 'rejectedNotes', 'importedFrom',
  'jobLink', 'jobId', 'platform', 'title', 'company', 'location', 'pageTitle', 'jobText',
  'salary', 'experience_required', 'posted_date', 'posted_relative',
  'jobType', 'workMode', 'easyApply', 'applicantsCount', 'applicantsNumeric',
  'company_industry', 'company_type', 'company_assessment',
  'summary', 'apply_recommendation', 'verdict', 'score',
  'key_skills_match', 'key_skills_missing', 'red_flags',
  'analyzedAt', 'hr', 'contact', 'companyDetails',
].map((k) => [k, 1]));

// ── Clients ────────────────────────────────────────────────────────────────

const _clients = new Map(); // peerId -> { client, uri }

const getClient = (peer) => {
  const cached = _clients.get(peer.id);
  if (cached && cached.uri === peer.uri) return cached.client;
  if (cached) cached.client.close().catch(() => {});
  const client = new MongoClient(peer.uri, CLIENT_OPTIONS);
  _clients.set(peer.id, { client, uri: peer.uri });
  return client;
};

export const closePeerClient = async (peerId) => {
  const cached = _clients.get(peerId);
  if (!cached) return;
  _clients.delete(peerId);
  await cached.client.close().catch(() => {});
};

const closeAllClients = async () => {
  await Promise.all([..._clients.keys()].map(closePeerClient));
};

// ── Query ──────────────────────────────────────────────────────────────────

const asId = (s) => (/^[0-9a-f]{24}$/i.test(String(s)) ? new ObjectId(String(s)) : s);

// Rows analysed within the window, with text, and (unless opted in) not
// rejected on the peer. analyzedAt is an ISO string in this collection, so
// the window bound is a string too — ISO-8601 compares lexicographically.
export const baseFilter = (peer, now = Date.now()) => {
  const since = new Date(now - peer.windowDays * 86_400_000).toISOString();
  const f = {
    $and: [
      { analyzedAt: { $type: 'string', $ne: '' } },
      { analyzedAt: { $gte: since } },
    ],
    jobText: { $type: 'string' },
    updatedAt: { $type: 'date' },
  };
  if (!peer.includePeerRejected) f.rowStatus = { $ne: 'rejected' };
  return f;
};

const queryFor = (peer, cursor) => {
  const f = baseFilter(peer);
  if (cursor?.t) {
    const t = new Date(cursor.t);
    f.$or = [
      { updatedAt: { $gt: t } },
      { updatedAt: t, _id: { $gt: asId(cursor.id) } },
    ];
  }
  return f;
};

// ── Local lookup ───────────────────────────────────────────────────────────

// One pass over the mirror (or two indexed finds while it is still loading)
// answers "which of these links / ids do we already have" for a whole batch.
const localIndexFor = async (links, ids) => {
  const byLink = new Map();
  const byId = new Map();
  const linkSet = new Set(links);
  const idSet = new Set(ids.filter(Boolean));
  if (jobTrackerMirror.loaded) {
    for (const d of jobTrackerMirror.iter()) {
      if (linkSet.has(d.jobLink)) byLink.set(d.jobLink, d);
      if (d.jobId && idSet.has(String(d.jobId))) byId.set(String(d.jobId), d);
    }
    return { byLink, byId };
  }
  const c = await col('job_tracker');
  const proj = { projection: { _id: 1, jobLink: 1, jobId: 1, analyzedAt: 1 } };
  if (linkSet.size) {
    for (const d of await c.find({ jobLink: { $in: [...linkSet] } }, proj).toArray()) byLink.set(d.jobLink, d);
  }
  if (idSet.size) {
    for (const d of await c.find({ jobId: { $in: [...idSet] } }, proj).toArray()) byId.set(String(d.jobId), d);
  }
  return { byLink, byId };
};

const isAnalysed = (d) => typeof d?.analyzedAt === 'string' && d.analyzedAt !== '';

// ── Self-import guard ──────────────────────────────────────────────────────

// "Is that deployment this one?" — asked with `hello` on both sides. A
// replica set names itself (setName) and lists its members, so the same
// cluster reached through a tunnel, an alias or another DNS name still
// answers with the same name. The key check in peers-config catches the
// obvious spellings; this catches the rest.
//
// It deliberately does NOT look at the rows. An earlier version flagged a
// peer whose rows carried this database's own _ids — but copied DATA is not
// the same DATABASE: a friend who seeded from your dump, or a local mongod
// restored from a backup, carries the same _ids and is a legitimate peer.
// (A true self-import is harmless anyway — every row already exists locally
// and is skipped — so this guard only needs to be precise, not paranoid.)
const deploymentOf = async (admin) => {
  try {
    const h = await admin.command({ hello: 1 });
    const hosts = [...(h.hosts || []), ...(h.passives || []), ...(h.arbiters || [])]
      .map((x) => String(x).toLowerCase());
    return { setName: h.setName || null, hosts };
  } catch {
    return null;
  }
};

const sameDeployment = (a, b) => {
  if (!a?.setName || !b?.setName) return false;   // standalones carry no identity
  return a.setName === b.setName && a.hosts.some((h) => b.hosts.includes(h));
};

// Same deployment AND the same database name — the same cluster's *other*
// database (a friend on your Atlas project) is a fine peer.
const isSelfDeployment = async (client, peer) => {
  if (peer.db !== dbIdentity().db) return false;
  const [remote, local] = await Promise.all([
    deploymentOf(client.db('admin').admin()),
    getDb().then((db) => deploymentOf(db.admin())).catch(() => null),
  ]);
  return sameDeployment(remote, local);
};

// ── One batch ──────────────────────────────────────────────────────────────

const bump = (map, reason, n = 1) => { map[reason] = (map[reason] || 0) + n; };

// Sanitise, decide, write. Returns per-batch counts.
const importBatch = async (peer, docs, { filters }) => {
  const now = new Date().toISOString();
  const skippedReasons = {};
  const candidates = [];
  for (const d of docs) {
    const { row, skipReason } = sanitizePeerJob(d, {
      peerId: peer.id, label: peer.label, now, filters, includePeerRejected: peer.includePeerRejected,
    });
    if (!row) { bump(skippedReasons, skipReason); continue; }
    candidates.push({ row });
  }

  const { byLink, byId } = await localIndexFor(
    candidates.map((c) => c.row.jobLink),
    candidates.map((c) => c.row.jobId),
  );

  const ops = [];
  const written = [];
  for (const { row } of candidates) {
    if (row.jobId && byId.has(row.jobId) && byId.get(row.jobId).jobLink !== row.jobLink) {
      bump(skippedReasons, 'jobId exists');
      continue;
    }
    const local = byLink.get(row.jobLink);
    if (local) {
      if (isAnalysed(local)) { bump(skippedReasons, 'exists locally'); continue; }
      // Exists but never analysed (a clipboard import, a URL-only stub):
      // fill in the analysis, leave the operator's state alone. The row
      // keeps its own createdAt, which is how purgePeerRows later tells a
      // filled-in stub (strip the analysis) from an inserted row (delete).
      const notAnalysed = { $or: [{ analyzedAt: { $exists: false } }, { analyzedAt: null }, { analyzedAt: '' }] };
      const fields = analysisFieldsOf(row);
      let filter = { jobLink: row.jobLink, ...notAnalysed };
      if (row.rowStatus === 'rejected') {
        // A peer-rejected (or locally auto-rejected) row lands on a stub the
        // operator never decided on with the same rejection tuple an insert
        // would carry — otherwise the same source row sits rejected or
        // pending depending on an accident of local state. A stub the
        // operator already rejected by hand is left entirely alone.
        const undecided = { $or: [{ rowStatus: { $exists: false } }, { rowStatus: null }, { rowStatus: '' }] };
        filter = { jobLink: row.jobLink, $and: [notAnalysed, undecided] };
        Object.assign(fields, {
          rowStatus: row.rowStatus, rejectedAt: row.rejectedAt,
          rejectedBy: row.rejectedBy, rejectedNotes: row.rejectedNotes,
        });
      }
      ops.push({ updateOne: { filter, update: { $set: fields } } });
    } else {
      // A plain insert, not an insert-only upsert: col() stamps updatedAt on
      // every update — the match side of an upsert included — so an upsert
      // that found the row anyway (the mirror index is a few seconds stale
      // at boot) would still bump the local row and count as an update. A
      // duplicate insert fails with 11000 and is counted as a skip below.
      ops.push({ insertOne: { document: row } });
    }
    written.push(row.jobLink);
  }

  let imported = 0;
  let updated = 0;
  if (ops.length) {
    const c = await col('job_tracker');
    let result;
    try {
      result = await c.bulkWrite(ops, { ordered: false });
    } catch (e) {
      // ordered:false keeps going past individual failures; the result of
      // the ones that did land rides on the error. 11000 is a row that
      // another writer inserted first — that is a skip, not a failure.
      result = e.result || e;
      const errs = Array.isArray(e.writeErrors) ? e.writeErrors : [];
      let dup = 0; let other = 0;
      for (const we of errs) { if (we.code === 11000) dup++; else other++; }
      if (dup) bump(skippedReasons, 'duplicate', dup);
      if (other) {
        bump(skippedReasons, 'write error', other);
        log.warn('peers', `${peer.label}: ${other} row(s) failed to write: ${scrubMessage(errs.find((w) => w.code !== 11000)?.errmsg || e.message)}`);
      }
      if (!errs.length) throw e;
    }
    imported = result?.insertedCount || 0;
    // Only the fill-in ops are updateOnes, so matchedCount is exactly the
    // stubs that received an analysis (modifiedCount would also count the
    // timestamp stamp on rows nothing else changed on).
    updated = result?.matchedCount || 0;

    const refreshed = await c.find({ jobLink: { $in: written } }).toArray();
    if (refreshed.length) jobTrackerMirror.applyMany(refreshed);
    if (imported > 0) {
      try {
        const { invalidateMatchIndex } = await import('../connections/store.js');
        invalidateMatchIndex({});
      } catch { /* non-fatal — the match index rebuilds on its TTL */ }
    }
  }

  const skipped = Object.values(skippedReasons).reduce((a, b) => a + b, 0);
  return { imported, updated, skipped, skippedReasons };
};

// ── Error mapping ──────────────────────────────────────────────────────────

const HINTS = {
  'bad-uri': 'Paste the full connection string, e.g. mongodb+srv://user:password@cluster.mongodb.net/dbname',
  dns: 'The host name does not resolve — check the cluster address in the connection string',
  unreachable: 'Nothing is listening at that address — check the host and port, or whether the server is up',
  auth: 'The username or password is wrong, or that user has no access to this database — ask them to re-create the database user',
  scope: 'The credential connects but cannot read this collection — ask them to grant find on the job_tracker collection',
  timeout: 'Could not reach the cluster in time — ask them to add your public IP under Atlas Network Access',
  'not-mongo': 'Something answered at that address, but it is not a MongoDB server',
  self: 'This is your own database — a peer must be someone else\'s',
  'not-found': 'Unknown peer',
  ok: '',
};

// Never lets a connection string through: every message is scrubbed.
export const mapError = (e) => {
  const detail = scrubMessage(e?.message);
  if (e instanceof PeerConfigError) {
    return { code: e.code === 'self' ? 'self' : 'bad-uri', hint: e.message, detail };
  }
  const name = String(e?.name || '');
  const lower = detail.toLowerCase();
  const out = (code, hint = HINTS[code]) => ({ code, hint, detail });
  if (e?.code === 18 || e?.codeName === 'AuthenticationFailed' || /bad auth|authentication failed/.test(lower)) return out('auth');
  if (e?.code === 13 || e?.codeName === 'Unauthorized' || /not authorized/.test(lower)) return out('auth', HINTS.scope);
  if (/enotfound|eai_again|getaddrinfo|querysrv|querytxt/.test(lower)) return out('dns');
  if (/econnrefused|ehostunreach|enetunreach/.test(lower)) return out('unreachable');
  if (name === 'MongoParseError' || /invalid message size|not a mongodb|unexpected/.test(lower)) return out('not-mongo');
  if (name === 'MongoInvalidArgumentError' || name === 'MongoAPIError') return out('bad-uri');
  if (name === 'MongoServerSelectionError' || name === 'MongoNetworkTimeoutError' || /timed out|timeout/.test(lower)) return out('timeout');
  if (name === 'MongoNetworkError' || /econnreset|closed/.test(lower)) return out('unreachable');
  return { code: 'error', hint: detail || 'Unknown error', detail };
};

// ── Sync ───────────────────────────────────────────────────────────────────

// Every running syncPeer, by peer id, whatever started it (the tick, an
// add, an enable, a manual sync) — so shutdown can wait for all of them and
// removal can wait for one. A sync that is cut off between batches would
// otherwise reopen a connection to the peer during shutdown and record a
// spurious lastError that survives the restart.
const _inFlight = new Map();   // peerId -> Promise<result>
// Peers being removed: a new sync for them is refused until the purge and
// the config write are done (see withPeerRemoval).
const _removing = new Set();
let _syncAllRunning = null;
let _shuttingDown = false;

export const isSyncing = (peerId) => (peerId ? _inFlight.has(peerId) : !!_syncAllRunning);

// Resolves once no sync is running for this peer (immediately if none is).
export const waitForSync = (peerId) => (_inFlight.get(peerId) || Promise.resolve()).catch(() => {});

// Where a peer points: hosts + db + collection. A sync compares this against
// the live config after every batch, so an edit that re-targets the peer
// mid-sync can never persist the OLD target's cursor onto the new one.
const targetOf = (peer) => {
  let key;
  try { key = normalizePeerKey(peer.uri, peer.db); } catch { key = `?/${peer.db}`; }
  return `${key}#${peer.collection}`;
};

// Pull up to BATCHES_PER_TICK batches from one peer. `manual` lets the
// Settings page sync a disabled peer once without enabling it.
export const syncPeer = (id, opts = {}) => {
  if (_inFlight.has(id)) return Promise.resolve({ ok: false, code: 'in-flight', hint: 'A sync for this source is already running' });
  if (_shuttingDown) return Promise.resolve({ ok: false, code: 'stopping', hint: 'Server is shutting down' });
  if (_removing.has(id)) return Promise.resolve({ ok: false, code: 'removing', hint: 'Source is being removed' });
  const p = _syncPeer(id, opts).finally(() => { if (_inFlight.get(id) === p) _inFlight.delete(id); });
  _inFlight.set(id, p);
  return p;
};

const _syncPeer = async (id, { manual = false } = {}) => {
  const peer = getPeer(id);
  if (!peer) return { ok: false, code: 'not-found', hint: HINTS['not-found'] };
  if (!peer.enabled && !manual) return { ok: false, code: 'disabled', hint: 'Source is disabled' };

  const target0 = targetOf(peer);
  const startedAt = new Date().toISOString();
  patchPeerState(id, { syncing: true, nextSyncAt: new Date(Date.now() + SYNC_INTERVAL_MS).toISOString() });
  const totals = { imported: 0, updated: 0, skipped: 0, skippedReasons: {}, batches: 0 };
  try {
    const filters = await readFilters();
    const client = getClient(peer);
    let cursor = peer.state.cursor;
    // Once, before the first row is read: a source that turns out to be
    // this very deployment is disabled rather than synced with itself.
    if (!cursor?.t && await isSelfDeployment(client, peer)) {
      setPeerEnabled(id, false);
      patchPeerState(id, { syncing: false, lastError: 'self: this connection string points at your own database — source disabled', lastErrorAt: new Date().toISOString() });
      await closePeerClient(id);
      log.warn('peers', `${peer.label}: answers as this server's own deployment — disabled as a self-import`);
      return { ok: false, code: 'self', hint: HINTS.self, ...totals };
    }
    const coll = client.db(peer.db).collection(peer.collection);
    for (let b = 0; b < BATCHES_PER_TICK; b++) {
      if (_shuttingDown) break;
      const docs = await coll
        .find(queryFor(peer, cursor), { projection: PROJECTION, sort: { updatedAt: 1, _id: 1 }, limit: BATCH_SIZE })
        .toArray();
      if (!docs.length) break;
      const r = await importBatch(peer, docs, { filters });
      const last = docs[docs.length - 1];
      cursor = { t: last.updatedAt.toISOString(), id: String(last._id) };
      // Persisted only now, after the local writes above resolved — and only
      // if the peer still points where this batch was read from. Removed or
      // re-targeted while the batch was in flight: the rows already written
      // are fine (they are idempotent), the cursor is not ours to keep.
      const live = getPeer(id);
      if (!live) return { ok: false, code: 'not-found', hint: HINTS['not-found'], ...totals };
      if (targetOf(live) !== target0) {
        patchPeerState(id, { syncing: false });
        log.info('peers', `${peer.label}: re-targeted during sync — cursor not persisted`);
        return { ok: false, code: 'reconfigured', hint: 'Source was edited during the sync — it restarts from the new target on the next tick', ...totals };
      }
      patchPeerState(id, { cursor }, {
        add: { imported: r.imported, updated: r.updated, skipped: r.skipped },
        addReasons: r.skippedReasons,
      });
      totals.imported += r.imported;
      totals.updated += r.updated;
      totals.skipped += r.skipped;
      for (const [k, n] of Object.entries(r.skippedReasons)) bump(totals.skippedReasons, k, n);
      totals.batches++;
      if (docs.length < BATCH_SIZE) break;
    }
    patchPeerState(id, { syncing: false, lastSyncAt: startedAt, lastError: null, lastErrorAt: null });
    if (totals.imported || totals.updated || totals.skipped) {
      const reasons = Object.entries(totals.skippedReasons).map(([k, n]) => `${k}: ${n}`).join(', ');
      log.info('peers', `${peer.label} +${totals.imported} imported, ${totals.updated} updated, ${totals.skipped} skipped${reasons ? ` (${reasons})` : ''}`);
    }
    return { ok: true, code: 'ok', ...totals };
  } catch (e) {
    if (_shuttingDown) {
      // The client was closed under it — not the peer's fault.
      patchPeerState(id, { syncing: false });
      return { ok: false, code: 'stopping', hint: 'Server is shutting down', ...totals };
    }
    const m = mapError(e);
    patchPeerState(id, { syncing: false, lastError: `${m.code}: ${m.hint}`, lastErrorAt: new Date().toISOString() });
    log.warn('peers', `${peer.label}: sync failed (${m.code}) ${m.detail}`);
    return { ok: false, ...m, ...totals };
  }
};

// Run `fn` (purge + config removal, see routes.js) with the peer's sync
// held off: the client is closed so a batch in flight aborts at its next
// read, the in-flight sync is awaited so its last writes have landed, and
// no new sync can start for this peer until `fn` has resolved. Without
// this a batch could land rows after the purge had counted them gone.
export const withPeerRemoval = async (peerId, fn) => {
  _removing.add(peerId);
  try {
    await closePeerClient(peerId);
    await waitForSync(peerId);
    return await fn();
  } finally {
    _removing.delete(peerId);
  }
};

// Every enabled peer, one after another — the local Atlas tier is the
// bottleneck, and parallel bulkWrites would only fight over it.
export const syncAll = async () => {
  if (_syncAllRunning) return { ok: false, code: 'in-flight', hint: 'A sync is already running' };
  _syncAllRunning = (async () => {
    const results = {};
    for (const p of readPeers().peers) {
      if (!p.enabled) continue;
      results[p.id] = await syncPeer(p.id);
    }
    return { ok: true, results };
  })();
  try {
    return await _syncAllRunning;
  } finally {
    _syncAllRunning = null;
  }
};

// ── Test ───────────────────────────────────────────────────────────────────

const SCOPE_WARNING =
  'this credential can read collections other than job_tracker — ask them to narrow it to find on job_tracker';

// Connect, count what the sync would see, sample three titles, and probe
// whether the credential is scoped to the one collection it needs. Accepts
// either a stored peer's id or a not-yet-saved { label, uri, db, ... }.
export const testPeer = async (inputOrId) => {
  const t0 = Date.now();
  let peer;
  let temp = false;
  if (typeof inputOrId === 'string') {
    peer = getPeer(inputOrId);
    if (!peer) return { ok: false, code: 'not-found', hint: HINTS['not-found'], ms: 0 };
  } else {
    try {
      const v = validatePeerInput(inputOrId || {});
      checkPeerKey(v.key, { peers: [] });   // self only — duplicates are the add route's call
      peer = { ...v, id: null };
      temp = true;
    } catch (e) {
      return { ok: false, ...mapError(e), ms: 0 };
    }
  }

  let client = null;
  try {
    client = temp ? new MongoClient(peer.uri, CLIENT_OPTIONS) : getClient(peer);
    await client.connect();
    if (await isSelfDeployment(client, peer)) {
      return { ok: false, code: 'self', hint: HINTS.self, ms: Date.now() - t0 };
    }
    const db = client.db(peer.db);
    const coll = db.collection(peer.collection);
    const filter = baseFilter(peer);
    const remoteAnalyzedCount = await coll.countDocuments(filter);
    const samples = await coll
      .find(filter, { projection: { title: 1, company: 1 }, sort: { updatedAt: -1 }, limit: 3 })
      .toArray();
    const sampleTitles = samples.map((s) => [s.title, s.company].filter(Boolean).join(' — ')).filter(Boolean);

    // A read on a collection the sync never needs. Success (even an empty
    // result) means the credential is broader than it should be — the peer's
    // users doc holds their SMTP password and mail.
    let scopeWarning = null;
    try {
      await db.collection('users').findOne({}, { projection: { _id: 1 } });
      scopeWarning = SCOPE_WARNING;
    } catch { /* unauthorized — exactly what we want */ }

    if (!temp) patchPeerState(peer.id, { remoteAnalyzedCount });
    return {
      ok: true, code: 'ok', hint: '',
      remoteAnalyzedCount, sampleTitles, scopeWarning,
      db: peer.db, collection: peer.collection, ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, ...mapError(e), ms: Date.now() - t0 };
  } finally {
    if (temp && client) await client.close().catch(() => {});
  }
};

// ── Purge ──────────────────────────────────────────────────────────────────

// Take back what a removed peer brought in, but only where the operator
// never touched it: no apply state, and rejected (if at all) by the import
// itself or by a peer — `peer:<label>` under whatever label the peer had at
// import time, since labels can be renamed — never by hand.
//
// Two kinds of row match. One the import INSERTED (createdAt is the same
// instant as importedFrom.at — sanitizePeerJob stamps both from one clock)
// is deleted. One that existed before the peer did and only received a
// fill-in analysis (a URL stub, a row cleared for rescan) belongs to the
// operator: it is stripped back to the stub the way clearScannerData does,
// and an import-attributed rejection is lifted with it.
export const purgePeerRows = async (peerId, label) => {
  const c = await col('job_tracker');
  const filter = {
    'importedFrom.peerId': peerId,
    $and: [
      { $or: [{ users: { $exists: false } }, { users: null }, { users: {} }] },
      { $or: [{ rejectedBy: { $in: [null, 'system:peer-import'] } }, { rejectedBy: /^peer:/ }] },
    ],
  };
  const docs = await c.find(filter, { projection: { _id: 1, createdAt: 1, 'importedFrom.at': 1 } }).toArray();
  if (!docs.length) return 0;
  const inserted = [];
  const filledIn = [];
  for (const d of docs) {
    const created = d.createdAt instanceof Date ? d.createdAt.toISOString() : d.createdAt;
    (created && created === d.importedFrom?.at ? inserted : filledIn).push(d._id);
  }
  let purged = 0;
  if (inserted.length) {
    const r = await c.deleteMany({ _id: { $in: inserted } });
    for (const id of inserted) jobTrackerMirror.delete(id);
    purged += r.deletedCount || 0;
  }
  if (filledIn.length) {
    // Same set clearScannerData strips for a rescan: title / company /
    // location / contact stay (the peer's scraped values are as good as
    // anyone's and the stub's own were overwritten by the fill-in), the
    // analysis, the provenance and the import's rejection go.
    const KEEP = new Set(['title', 'company', 'location', 'hr', 'contact']);
    const strip = [...ANALYSIS_FIELDS.filter((k) => !KEEP.has(k)), 'rowStatus', 'rejectedAt', 'rejectedBy', 'rejectedNotes'];
    const r = await c.updateMany({ _id: { $in: filledIn } }, { $unset: Object.fromEntries(strip.map((k) => [k, ''])) });
    const refreshed = await c.find({ _id: { $in: filledIn } }).toArray();
    if (refreshed.length) jobTrackerMirror.applyMany(refreshed);
    purged += r.modifiedCount || 0;
  }
  log.info('peers', `purged ${purged} row(s) imported from "${label}" (${inserted.length} deleted, ${filledIn.length} stripped back to stubs)`);
  return purged;
};

// ── Loop ───────────────────────────────────────────────────────────────────

let _timer = null;
let _stopped = true;
let _running = null;

const arm = () => {
  if (_stopped || _timer) return;
  _timer = setTimeout(tick, SYNC_INTERVAL_MS);
  _timer.unref?.();
};

const tick = async () => {
  _timer = null;
  try {
    _running = syncAll();
    await _running;
  } catch (e) {
    log.warn('peers', `tick failed: ${scrubMessage(e.message)}`);
  } finally {
    _running = null;
    arm();
  }
};

// A setTimeout that re-arms itself once the tick is over, so a slow peer
// can never stack ticks the way setInterval would.
export const startPeerSync = () => {
  if (!_stopped) return;
  _stopped = false;
  _shuttingDown = false;
  // `syncing` is persisted so the UI can show it; a crash mid-tick would
  // otherwise leave a peer marked busy forever.
  try {
    const cfg = readPeers();
    let dirty = false;
    for (const p of cfg.peers) if (p.state.syncing) { p.state.syncing = false; dirty = true; }
    if (dirty) writePeers(cfg);
    const enabled = cfg.peers.filter((p) => p.enabled).length;
    if (cfg.peers.length) log.info('peers', `${enabled} of ${cfg.peers.length} source(s) enabled — syncing every ${SYNC_INTERVAL_MS / 1000} s`);
  } catch (e) {
    log.warn('peers', `could not read peers at start: ${e.message}`);
  }
  arm();
};

export const stopPeerSync = async () => {
  _stopped = true;
  _shuttingDown = true;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  // Every running sync, not just the tick's: one started by a route is cut
  // off between batches the same way, and nothing else re-checks it.
  const active = [..._inFlight.values()];
  if (_running) active.push(_running);
  if (active.length) {
    await Promise.race([
      Promise.allSettled(active),
      new Promise((r) => setTimeout(r, STOP_GRACE_MS).unref?.()),
    ]);
  }
  await closeAllClients();
};
