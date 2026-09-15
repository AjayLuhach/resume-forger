#!/usr/bin/env node
// Build a small, single-user test database from a full one.
//
// Copies ONE user's slice of a source Mongo (by default the MONGO_URI in .env)
// into a target Mongo (by default a local mongod), keeping only the newest N
// rows of each large collection. The result is what a fresh install of this
// tool looks like after a few weeks of use, which is what every change should
// be tested against — not the database you actually work from. It also turns
// a database that still holds several users (an older shared deployment) into
// the single-user shape this tool expects.
//
// What lands in the target, all with their original _ids:
//   users                 the chosen user only (auth, resume JSONs, PDF, history)
//   job_tracker           newest N rows; `users` trimmed to the chosen user's sub-doc
//   posts                 newest N rows (copied as-is)
//   user_emails           the chosen user's newest N drafts
//   connections           profiles the chosen user owns, newest N, owners:[user]
//   user_connects, user_inbox, resume_variants   the chosen user's rows (variants: newest N)
//   scanner_filters, scanner_searches, feed_sources, high_salary_companies   everything
// Anything else (debug/log collections, *_view_state) is not copied.
//
// Usage:
//   node scripts/seed-local-from-remote.js --user "Name"                 # dry-run: counts only
//   node scripts/seed-local-from-remote.js --user "Name" --apply         # write to mongodb://127.0.0.1:27017/forge_local
//   node scripts/seed-local-from-remote.js --user "Name" --limit 5000 --target mongodb://127.0.0.1:27017 --target-db forge_local --apply
//   node scripts/seed-local-from-remote.js --user "Name" --apply --drop  # drop the target db first
//   npm run seed:local -- --user "Name" --apply --drop                   # same, via npm
//
// Then run the app against it:
//   npm run web:local            (MONGO_URI=mongodb://127.0.0.1:27017 MONGO_DB=forge_local)
//
// Mirror snapshots are keyed per database (data/mirrors/<host>__<db>/), so
// the local copy and the source never share one.
//
// The target is REFUSED when it resolves to the same host + db as the source.
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const flag = (name, dflt = undefined) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);

const USER = flag('--user');
const LIMIT = Number(flag('--limit', 3000));
const SOURCE_URI = flag('--source', process.env.MONGO_URI);
const SOURCE_DB = flag('--source-db', process.env.MONGO_DB || 'resume_forge');
const TARGET_URI = flag('--target', 'mongodb://127.0.0.1:27017');
const TARGET_DB = flag('--target-db', 'forge_local');
const APPLY = has('--apply');
const DROP = has('--drop');

if (!USER || !SOURCE_URI || !Number.isFinite(LIMIT) || LIMIT < 1) {
  console.error('Usage: node scripts/seed-local-from-remote.js --user "<name>" [--limit 3000] [--source <uri>] [--source-db <db>] [--target <uri>] [--target-db <db>] [--apply] [--drop]');
  process.exit(1);
}

const hostOf = (uri) => { try { return new URL(uri).host.toLowerCase(); } catch { return String(uri); } };
if (hostOf(SOURCE_URI) === hostOf(TARGET_URI) && SOURCE_DB === TARGET_DB) {
  console.error(`Refusing: source and target are the same database (${hostOf(SOURCE_URI)}/${SOURCE_DB}).`);
  process.exit(1);
}

const redact = (uri) => String(uri).replace(/(\/\/[^:/@]+:)[^@]+@/, '$1***@');
console.log(`[seed] source  ${redact(SOURCE_URI)} / ${SOURCE_DB}`);
console.log(`[seed] target  ${redact(TARGET_URI)} / ${TARGET_DB}`);
console.log(`[seed] user    "${USER}"   limit per big collection: ${LIMIT}   mode: ${APPLY ? 'APPLY' : 'dry-run'}${DROP ? ' (drop target first)' : ''}`);

const src = new MongoClient(SOURCE_URI, { serverSelectionTimeoutMS: 20000 });
const dst = new MongoClient(TARGET_URI, { serverSelectionTimeoutMS: 8000 });
await src.connect();
await dst.connect();
const S = src.db(SOURCE_DB);
const D = dst.db(TARGET_DB);

const userDoc = await S.collection('users').findOne({ username: USER });
if (!userDoc) {
  const names = (await S.collection('users').find({}, { projection: { username: 1 } }).toArray()).map((d) => d.username);
  console.error(`No user "${USER}" in source. Known: ${names.map((n) => `"${n}"`).join(', ')}`);
  await src.close(); await dst.close();
  process.exit(1);
}

// Newest-N reader: sort by _id desc (ObjectId carries insertion time), then
// reverse so the target receives rows in their natural order.
const newest = async (name, filter, limit, projection) => {
  const rows = await S.collection(name).find(filter, projection ? { projection } : {}).sort({ _id: -1 }).limit(limit).toArray();
  return rows.reverse();
};

// Per-collection plans: { name, rows: () => Promise<doc[]>, indexes: [[keys, opts]] }
const PLANS = [
  {
    name: 'users',
    rows: async () => [userDoc],
    indexes: [[{ username: 1 }, { unique: true }]],
  },
  {
    name: 'job_tracker',
    rows: async () => (await newest('job_tracker', {}, LIMIT)).map((d) => {
      // Keep only this user's per-row state; other operators' sub-docs are
      // exactly the multi-user coupling a single-user DB must not carry.
      const mine = d.users?.[USER];
      const out = { ...d };
      out.users = mine ? { [USER]: mine } : {};
      return out;
    }),
    indexes: [[{ jobLink: 1 }, { unique: true }], [{ jobId: 1 }, {}], [{ updatedAt: 1 }, {}], [{ createdAt: 1 }, {}], [{ rowStatus: 1 }, { sparse: true }]],
  },
  {
    name: 'posts',
    rows: () => newest('posts', {}, LIMIT),
    indexes: [[{ postId: 1 }, { unique: true }], [{ updatedAt: 1 }, {}], [{ createdAt: 1 }, {}], [{ addedAt: -1 }, {}]],
  },
  {
    name: 'user_emails',
    rows: () => newest('user_emails', { username: USER }, LIMIT),
    indexes: [[{ username: 1, postId: 1 }, {}], [{ username: 1, status: 1 }, {}], [{ updatedAt: 1 }, {}], [{ createdAt: 1 }, {}]],
  },
  {
    name: 'connections',
    rows: async () => (await newest('connections', { owners: USER }, LIMIT)).map((d) => ({ ...d, owners: [USER] })),
    indexes: [[{ profileUrl: 1 }, { unique: true }], [{ updatedAt: 1 }, {}], [{ createdAt: 1 }, {}]],
  },
  { name: 'user_connects', rows: () => newest('user_connects', { username: USER }, 100000), indexes: [[{ username: 1, postId: 1 }, {}], [{ updatedAt: 1 }, {}]] },
  { name: 'user_inbox', rows: () => newest('user_inbox', { username: USER }, 100000), indexes: [[{ username: 1 }, {}], [{ updatedAt: 1 }, {}]] },
  {
    name: 'resume_variants',
    rows: () => newest('resume_variants', { username: USER }, Math.min(LIMIT, 300)),
    indexes: [[{ username: 1, generatedAt: -1 }, {}]],
  },
  { name: 'scanner_filters', rows: () => S.collection('scanner_filters').find({}).toArray(), indexes: [] },
  { name: 'scanner_searches', rows: () => S.collection('scanner_searches').find({}).toArray(), indexes: [] },
  { name: 'feed_sources', rows: () => S.collection('feed_sources').find({}).toArray(), indexes: [] },
  { name: 'high_salary_companies', rows: () => S.collection('high_salary_companies').find({}).toArray(), indexes: [[{ updatedAt: 1 }, {}]] },
];

if (APPLY && DROP) {
  await D.dropDatabase();
  console.log(`[seed] dropped target db ${TARGET_DB}`);
}

let grand = 0;
for (const plan of PLANS) {
  const rows = await plan.rows();
  grand += rows.length;
  const bytes = rows.length ? Math.round(JSON.stringify(rows).length / 1024) : 0;
  console.log(`[seed] ${plan.name.padEnd(22)} ${String(rows.length).padStart(6)} rows  ~${bytes} KB`);
  if (!APPLY || !rows.length) continue;
  const c = D.collection(plan.name);
  // Upsert by _id so re-runs refresh rather than duplicate, and a target that
  // already has newer local edits is not wiped by an older source copy.
  const ops = rows.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } }));
  for (let i = 0; i < ops.length; i += 500) {
    await c.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }
  for (const [keys, opts] of plan.indexes) {
    try { await c.createIndex(keys, opts); } catch (e) { if (!/already exists/i.test(e.message)) console.warn(`[seed]   index ${JSON.stringify(keys)} on ${plan.name}: ${e.message}`); }
  }
}

console.log(`[seed] ${APPLY ? 'wrote' : 'would write'} ${grand} rows into ${TARGET_DB}`);
if (!APPLY) console.log('[seed] dry-run only — add --apply to write.');
else {
  console.log(`[seed] done. Run the app against it with:`);
  console.log(`         MONGO_URI=${TARGET_URI} MONGO_DB=${TARGET_DB} npm run web      (or: npm run web:local)`);
  console.log(`       Login stays the same as on the source (same users doc).`);
}
await src.close();
await dst.close();
