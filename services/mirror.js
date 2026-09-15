// In-memory collection mirror with on-disk JSON persistence.
//
// THE PROBLEM IT SOLVES
//   Mongo Atlas free tier has ~150–500 ms RTT and aggressive shared-CPU
//   throttling. Read-heavy endpoints that do multiple sequential queries
//   spend most of their time waiting on the network, not the database.
//   At 20–30k docs, the dataset is small enough to live entirely in the
//   Node process — so we mirror each hot collection into a JS Map and
//   serve reads from there. Atlas stays the source of truth.
//
// SHAPE
//   - On boot: load from data/mirrors/<name>.json if it exists (instant),
//     then refresh from Mongo in the background (non-blocking). If the
//     snapshot is missing, do a full Mongo fetch synchronously before
//     reads are allowed.
//   - Reads: filter/sort/count over the in-memory Map. ~µs per op.
//   - Writes: caller writes to Mongo first, then hands the new doc to
//     `mirror.set(doc)`. Mirror marks itself dirty and queues a flush.
//   - Flush: every FLUSH_INTERVAL_MS, if dirty, atomically rewrite the
//     JSON snapshot (write to .tmp, rename). Survives crashes.
//
// CONCURRENCY
//   Single Node process owns the Map, so its own writes are instantly
//   visible to every reader. Writes from OTHER processes against the same
//   database — the feed CLI the server spawns, a hand edit in Compass, a
//   second server pointed at the same cluster — arrive through the delta
//   sync below, within DELTA_INTERVAL_MS.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ObjectId } from 'mongodb';
import { col, dbIdentity } from './db.js';
import { log } from './log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MIRROR_ROOT = path.join(__dirname, '..', 'data', 'mirrors');
// Snapshots are keyed by the database they mirror (host + db name), so
// pointing MONGO_URI at a local test copy can never boot from the remote
// cluster's snapshot — that would show 23k rows the local DB doesn't hold.
// MIRROR_DIR in the environment overrides the whole path.
export const MIRROR_DIR = process.env.MIRROR_DIR || path.join(MIRROR_ROOT, dbIdentity().slug);

const FLUSH_INTERVAL_MS = 30_000;
// Delta sync — every 15 s poll Mongo for docs past the (updatedAt, _id)
// cursor. Catches writes from other processes against the same database.
// With reliable in-process writes plus this 15 s pull, anything written
// outside this process shows up within 15 s. Drop this much lower (5 s)
// if real-time feel matters more than Atlas request cost.
const DELTA_INTERVAL_MS = 15_000;

// Mirror ids are kept as strings; the cursor query needs the BSON form back.
const asBsonId = (s) => (/^[0-9a-f]{24}$/i.test(String(s)) ? new ObjectId(String(s)) : s);
const toDate = (v) => (v instanceof Date ? v : (v ? new Date(v) : null));

const ensureDir = () => {
  if (!fs.existsSync(MIRROR_DIR)) fs.mkdirSync(MIRROR_DIR, { recursive: true });
};

// Convert Mongo ObjectId & Date to plain serializable forms for JSON snapshot.
const toPlain = (doc) => JSON.parse(JSON.stringify(doc, (_k, v) => {
  if (v && typeof v === 'object' && v.constructor?.name === 'ObjectId') return v.toString();
  return v;
}));

export class CollectionMirror {
  constructor(collectionName, { idField = '_id' } = {}) {
    this.name = collectionName;
    this.idField = idField;
    this.docs = new Map();        // string(id) -> plain doc
    this.dirty = false;
    this.loaded = false;
    this._loadingPromise = null;
    this._flushTimer = null;
    this._deltaTimer = null;
    // Delta cursor: the highest (updatedAt, _id) pair absorbed so far. The
    // _id tiebreaker is what lets the query ask for strictly-newer rows —
    // with updatedAt alone, every doc sharing the boundary millisecond
    // (bulk writes cluster there) was re-pulled on every tick.
    this.lastUpdatedAt = new Date(0);
    this.lastId = null;
    this._deltaRan = false;
    // Subscribers fired on every mutation (set/applyMany/delta). Drives
    // the SSE channel — when a write or cross-server delta lands, every
    // open browser tab gets a "your data changed" ping and refetches.
    this._subscribers = new Set();
  }

  subscribe(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  _emit(payload) {
    for (const fn of this._subscribers) {
      try { fn(payload); } catch { /* never let one bad subscriber kill the loop */ }
    }
  }

  _id(doc) {
    const v = doc[this.idField];
    return v == null ? null : String(v);
  }

  _filePath() {
    return path.join(MIRROR_DIR, `${this.name}.json`);
  }

  // Load from disk snapshot first (instant), then kick off a background
  // refresh from Mongo. If no snapshot exists, do a synchronous Mongo fetch
  // so reads can start.
  async load() {
    if (this.loaded) return;
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = (async () => {
      ensureDir();
      const f = this._filePath();
      let snapshotLoaded = false;
      // Snapshots used to live flat in data/mirrors/. They are not moved
      // automatically: a flat file taken from one database would silently
      // seed the mirror of another. Say where it is and let the operator
      // decide (move it into MIRROR_DIR if it belongs to this DB, else delete).
      const legacy = path.join(MIRROR_ROOT, `${this.name}.json`);
      if (!fs.existsSync(f) && fs.existsSync(legacy)) {
        log.warn('mirror', `${this.name}: legacy snapshot at ${legacy} ignored — move it into ${MIRROR_DIR}/ if it was taken from ${dbIdentity().host}/${dbIdentity().db}, otherwise delete it`);
      }
      if (fs.existsSync(f)) {
        try {
          const t0 = Date.now();
          const raw = fs.readFileSync(f, 'utf8');
          const arr = JSON.parse(raw);
          for (const d of arr) this.docs.set(this._id(d), d);
          snapshotLoaded = true;
          log.info('mirror', `${this.name} loaded ${arr.length} docs from snapshot (${Date.now() - t0}ms)`);
        } catch (e) {
          log.warn('mirror', `${this.name} snapshot read failed: ${e.message} — falling back to Mongo`);
        }
      }
      if (!snapshotLoaded) {
        await this._refreshFull();
      }
      await this._backfillMissingStamps();
      this._recomputeLastUpdatedAt();
      this.loaded = true;
      this._startBackgroundTasks();
      // After snapshot load we still kick a delta in the background to
      // catch anything written to the database while we were down. unref()
      // so a short-lived CLI doesn't keep the event loop alive waiting for
      // this fire — and so the delta doesn't try to run AFTER the CLI has
      // closed its Mongo client (was logging "Operation interrupted" /
      // "connection pool closed" warnings every emails-CLI run).
      if (snapshotLoaded) {
        const t = setTimeout(() => this._refreshDelta().catch(e => {
          log.warn('mirror', `${this.name} initial delta failed: ${e.message}`);
        }), 1000);
        t.unref?.();
      }
    })();
    return this._loadingPromise;
  }

  // Catch docs that landed in Mongo without createdAt/updatedAt. The col()
  // Proxy stamps every write path, but a stale Node process (running an
  // older module copy from before the Proxy landed) can still slip
  // unstamped docs through. Those then become invisible to delta sync
  // (which filters on updatedAt $gte). One empty-$set updateMany per boot
  // re-engages the Proxy and stamps anything that was missed.
  async _backfillMissingStamps() {
    try {
      const c = await col(this.name);
      const r = await c.updateMany(
        { updatedAt: { $exists: false } },
        { $set: {} },
      );
      if (r.modifiedCount > 0) {
        log.warn('mirror', `${this.name} backfilled ${r.modifiedCount} unstamped docs at boot`);
      }
    } catch (e) {
      log.warn('mirror', `${this.name} stamp backfill failed: ${e.message}`);
    }
  }

  // Full reload from Mongo. Used once on cold start (no snapshot). Replaces
  // the entire mirror — expensive on Atlas free tier, so we avoid calling
  // this on the regular interval. Delta sync handles ongoing updates.
  async _refreshFull() {
    const t0 = Date.now();
    const c = await col(this.name);
    const docs = await c.find({}, { batchSize: 5000 }).toArray();
    this.docs.clear();
    for (const d of docs) this.docs.set(this._id(d), toPlain(d));
    this.dirty = true;
    log.info('mirror', `${this.name} full-loaded ${docs.length} docs from Mongo (${Date.now() - t0}ms)`);
  }

  // Delta sync — pull only docs past the highest (updatedAt, _id) we've
  // already absorbed. The reciprocal of every mutation in the app setting
  // `$currentDate: { updatedAt: true }` so Mongo's clock stamps each write.
  // Any process writing through services/db.js converges with this one
  // within DELTA_INTERVAL_MS.
  async syncNow() {
    await this._refreshDelta();
    return this.size;
  }

  // Two query shapes:
  //
  //   first delta after a load   $or: [updatedAt >= t, createdAt >= t]
  //   every delta after that     $or: [updatedAt > t, (updatedAt == t AND _id > id)]
  //
  // The first is the old belt-and-braces form: the snapshot may predate a
  // write that only got one of the two stamps, and `>=` re-confirms the
  // boundary. createdAt is an ISO *string* on job_tracker rows, where a
  // Date comparison simply matches nothing — harmless, and on collections
  // where it is a Date it still catches a doc that missed updatedAt.
  //
  // The second is the indexed-cursor form. Strictly-greater means a doc is
  // absorbed once, not on every tick for as long as it shares the boundary
  // millisecond with the newest write — bulk backfills put hundreds of docs
  // in the same millisecond, and each tick was re-reading all of them.
  // Only updatedAt advances the cursor here: createdAt comes from the
  // writer's Node clock, and letting a skewed clock push the cursor ahead
  // of Mongo's own would make `>` skip real writes.
  async _refreshDelta() {
    const c = await col(this.name);
    const since = this.lastUpdatedAt;
    const useCursor = this._deltaRan && this.lastId != null;
    const filter = useCursor
      ? { $or: [{ updatedAt: { $gt: since } }, { updatedAt: since, _id: { $gt: asBsonId(this.lastId) } }] }
      : { $or: [{ updatedAt: { $gte: since } }, { createdAt: { $gte: since } }] };
    const cursor = c.find(filter, { batchSize: 1000 });
    let count = 0;
    let maxSeen = since;
    let maxId = useCursor ? this.lastId : null;
    for await (const d of cursor) {
      this.docs.set(this._id(d), toPlain(d));
      const u = toDate(d.updatedAt);
      if (u && !Number.isNaN(u.getTime())) {
        const id = this._id(d);
        if (u > maxSeen) { maxSeen = u; maxId = id; }
        else if (u.getTime() === maxSeen.getTime() && (maxId == null || id > maxId)) maxId = id;
      }
      count++;
    }
    this._deltaRan = true;
    if (count > 0) {
      this.lastUpdatedAt = maxSeen;
      if (maxId != null) this.lastId = maxId;
      this.dirty = true;
      log.info('mirror', `${this.name} delta +${count} docs (lastUpdatedAt=${maxSeen.toISOString()})`);
      this._emit({ type: 'delta', count });
    }
  }

  // Compute the cursor from the docs currently in the mirror. Called after
  // load() so the very first delta query asks for the right range. Only
  // updatedAt counts (see _refreshDelta for why createdAt must not move the
  // cursor). If no doc has one yet (fresh DB) we stay at epoch and the next
  // delta sees everything — a no-op, since those docs ARE the snapshot.
  _recomputeLastUpdatedAt() {
    let max = new Date(0);
    let maxId = null;
    for (const d of this.docs.values()) {
      const t = toDate(d.updatedAt);
      if (!t || Number.isNaN(t.getTime())) continue;
      const id = this._id(d);
      if (t > max) { max = t; maxId = id; }
      else if (t.getTime() === max.getTime() && (maxId == null || id > maxId)) maxId = id;
    }
    this.lastUpdatedAt = max;
    this.lastId = maxId;
    this._deltaRan = false;
  }

  _startBackgroundTasks() {
    if (!this._flushTimer) {
      this._flushTimer = setInterval(() => this.flush().catch(() => {}), FLUSH_INTERVAL_MS);
      this._flushTimer.unref?.();
    }
    if (!this._deltaTimer) {
      this._deltaTimer = setInterval(() => this._refreshDelta().catch(e => {
        log.warn('mirror', `${this.name} delta failed: ${e.message}`);
      }), DELTA_INTERVAL_MS);
      this._deltaTimer.unref?.();
    }
  }

  async flush() {
    if (!this.dirty) return;
    ensureDir();
    const f = this._filePath();
    const tmp = f + '.tmp';
    const arr = [...this.docs.values()];
    try {
      fs.writeFileSync(tmp, JSON.stringify(arr));
      fs.renameSync(tmp, f);
      this.dirty = false;
    } catch (e) {
      log.warn('mirror', `${this.name} flush failed: ${e.message}`);
    }
  }

  // ── reads ──
  size() { return this.docs.size; }
  all() { return [...this.docs.values()]; }
  get(id) { return this.docs.get(String(id)) ?? null; }

  // Iterate matching docs without allocating an array.
  *iter(predicate) {
    for (const d of this.docs.values()) if (!predicate || predicate(d)) yield d;
  }

  filter(predicate) {
    const out = [];
    for (const d of this.docs.values()) if (predicate(d)) out.push(d);
    return out;
  }

  count(predicate) {
    if (!predicate) return this.docs.size;
    let n = 0;
    for (const d of this.docs.values()) if (predicate(d)) n++;
    return n;
  }

  // ── writes — caller writes to Mongo first, then calls these ──
  set(doc) {
    const id = this._id(doc);
    if (!id) return;
    this.docs.set(id, toPlain(doc));
    this.dirty = true;
    this._emit({ type: 'upsert', id });
  }

  delete(id) {
    const ok = this.docs.delete(String(id));
    if (ok) { this.dirty = true; this._emit({ type: 'delete', id: String(id) }); }
    return ok;
  }

  // Bulk update — used by clearScannerData and similar multi-doc writes.
  // Caller passes the up-to-date set of docs (post-write). Mongo is still
  // authoritative; we just refresh our copy.
  applyMany(docs) {
    if (!docs?.length) return;
    for (const d of docs) {
      const id = this._id(d);
      if (!id) continue;
      this.docs.set(id, toPlain(d));
    }
    this.dirty = true;
    this._emit({ type: 'bulk', count: docs.length });
  }

  // Useful in tests + on shutdown.
  async flushNow() { return this.flush(); }
}

// ── Registry of mirrors used across the app ──
// Add a new collection here when you want it mirrored. The startup hook
// in server.js calls .load() on each — wire that up after adding.

export const jobTrackerMirror = new CollectionMirror('job_tracker');
export const userEmailsMirror = new CollectionMirror('user_emails');
export const postsMirror      = new CollectionMirror('posts');
export const connectionsMirror = new CollectionMirror('connections');
export const highSalaryMirror = new CollectionMirror('high_salary_companies');
// Per-operator connection-request queue for DM-only posts (see
// services/feed/connects-store.js). Starts empty, so it needs no backfill.
export const connectsMirror = new CollectionMirror('user_connects');

// Fetched job-related mail, per operator (services/inbox/inbox-store.js).
export const inboxMirror = new CollectionMirror('user_inbox');

export const ALL_MIRRORS = [jobTrackerMirror, userEmailsMirror, postsMirror, connectionsMirror, highSalaryMirror, connectsMirror, inboxMirror];

// Flush every mirror — call on graceful shutdown so the JSON snapshot
// captures the latest state. The background timer covers normal operation;
// this is the belt-and-braces for SIGTERM.
export const flushAllMirrors = async () => {
  await Promise.all(ALL_MIRRORS.map(m => m.flush().catch(() => {})));
};
