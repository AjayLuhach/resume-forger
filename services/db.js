// MongoDB connection. The `users` collection holds the one user's auth +
// emailConfig + resume payloads keyed by `username`. Tailored outputs land
// in `resume_variants`. Indexes are owned by scripts/ensure-indexes.js (and
// the stores' lazy ensure* helpers) — there is no boot-time createIndex here.
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || 'resume_forge';

// Which database this process talks to, for anything that must never be
// shared across databases: mirror snapshots (services/mirror.js) and the
// peer-sync self-import guard (services/peers/). Host only — the password
// never leaves the URI.
const _host = (() => {
  try { return new URL(uri || 'mongodb://unset').host.toLowerCase(); } catch { return 'unset'; }
})();
export const dbIdentity = () => ({
  host: _host,
  db: dbName,
  slug: `${_host}__${dbName}`.replace(/[^a-z0-9._-]+/gi, '_'),
});

// The tailor side still keeps a few JSON logs on disk (resume history,
// keyword gaps, outbox contacts, per-job PDF copies). They describe one
// database's activity, so they live under that database's slug — the same
// rule as data/mirrors/. Without this, pointing MONGO_URI at a fresh DB showed
// the previous database's history and outbox to a brand-new user.
export const LOGS_DIR = path.join(__dirname, '..', 'logs', dbIdentity().slug);

let client = null;
let _initPromise = null;

export const getDb = async () => {
  if (!uri) {
    throw new Error(
      'MONGO_URI not set in resume-tailor/.env',
    );
  }
  if (!_initPromise) {
    client = new MongoClient(uri);
    _initPromise = (async () => {
      await client.connect();
      return client.db(dbName);
    })();
  }
  return _initPromise;
};

// Collections that should auto-stamp every write with $currentDate so the
// in-memory mirror can pick up changes via its updatedAt-based delta sync
// (see services/mirror.js). Mongo's server clock is the timestamp source,
// not Node's — so a write from another process on the same database (the
// feed CLI the UI spawns, the peer importer, a second server) is ordered
// the same way the server's own writes are. Exported so
// scripts/ensure-indexes.js indexes exactly this set.
export const STAMPED_COLLECTIONS = new Set(['job_tracker', 'user_emails', 'posts', 'connections', 'user_connects', 'user_inbox', 'high_salary_companies', 'scanner_searches', 'feed_sources']);

// Wrap `updateOne` / `updateMany` / `findOneAndUpdate` / `bulkWrite` so any
// update document automatically gets BOTH timestamps merged in:
//   $currentDate: { updatedAt: true }      — Mongo's server clock, on every update
//   $setOnInsert: { createdAt: new Date() } — Node clock, only on the insert side
//                                             of an upsert (existing docs untouched)
// Two timestamps gives the mirror's delta-sync belt-and-suspenders: it queries
// `$or: [{ updatedAt: $gte }, { createdAt: $gte }]` so a new doc shows up
// even if exactly one of the two fields ever fails to be set. createdAt uses
// Node clock because Mongo's $currentDate inside $setOnInsert isn't a thing
// — small skew (<1 s on NTP-synced machines) is well within the 15 s delta
// window so cross-process sync is still reliable.
const _withTimestamps = (update) => {
  if (!update || typeof update !== 'object') return update;
  // Pipeline-form updates (array of stages) skip stamping — none of our
  // current writes use that shape, so this is just future-proofing.
  if (Array.isArray(update)) return update;
  const now = new Date();
  return {
    ...update,
    $currentDate: { ...(update.$currentDate || {}), updatedAt: true },
    $setOnInsert: { createdAt: now, ...(update.$setOnInsert || {}) },
  };
};

// Inject createdAt + updatedAt into a doc being inserted/replaced. Caller-
// supplied values win — if you explicitly set createdAt on the doc, we
// don't overwrite it. Uses Node clock; ~1s skew on NTP-synced machines is
// well within the mirror's 15s delta window, so a write from another
// process is still caught by the delta.
const _stampDoc = (doc) => {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const now = new Date();
  return { createdAt: now, updatedAt: now, ...doc };
};

const _stampBulkOp = (op) => {
  if (op?.updateOne)   return { updateOne:   { ...op.updateOne,   update: _withTimestamps(op.updateOne.update) } };
  if (op?.updateMany)  return { updateMany:  { ...op.updateMany,  update: _withTimestamps(op.updateMany.update) } };
  if (op?.insertOne)   return { insertOne:   { ...op.insertOne,   document: _stampDoc(op.insertOne.document) } };
  if (op?.replaceOne)  return { replaceOne:  { ...op.replaceOne,  replacement: _stampDoc(op.replaceOne.replacement) } };
  return op;
};

const _stamped = (raw) => new Proxy(raw, {
  get(target, prop, receiver) {
    if (prop === 'updateOne' || prop === 'updateMany') {
      return (filter, update, opts) => target[prop](filter, _withTimestamps(update), opts);
    }
    if (prop === 'findOneAndUpdate') {
      return (filter, update, opts) => target.findOneAndUpdate(filter, _withTimestamps(update), opts);
    }
    if (prop === 'findOneAndReplace') {
      return (filter, doc, opts) => target.findOneAndReplace(filter, _stampDoc(doc), opts);
    }
    if (prop === 'bulkWrite') {
      return (ops, opts) => target.bulkWrite(ops.map(_stampBulkOp), opts);
    }
    if (prop === 'insertOne') {
      return (doc, opts) => target.insertOne(_stampDoc(doc), opts);
    }
    if (prop === 'insertMany') {
      return (docs, opts) => target.insertMany((docs || []).map(_stampDoc), opts);
    }
    if (prop === 'replaceOne') {
      return (filter, doc, opts) => target.replaceOne(filter, _stampDoc(doc), opts);
    }
    return Reflect.get(target, prop, receiver);
  },
});

export const col = async (name) => {
  const raw = (await getDb()).collection(name);
  return STAMPED_COLLECTIONS.has(name) ? _stamped(raw) : raw;
};

export const close = () => (client ? client.close() : Promise.resolve());
