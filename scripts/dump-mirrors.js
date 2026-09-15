#!/usr/bin/env node
// scripts/dump-mirrors.js
//
// One-shot script to populate the mirror snapshots without going through
// the server's slow lazy-load path. Runs `find({})` with a generous
// batchSize so the cursor pulls many docs per RTT — much faster than the
// default 101-per-RTT that the server's cold-start fetch uses.
//
// Snapshots are keyed by the database they came from: they land in
// data/mirrors/<host>__<db>/<collection>.json, the same directory the
// server reads for the MONGO_URI / MONGO_DB in .env. A dump taken against
// one database can therefore never be booted by a server pointed at
// another — a local test copy and the real database keep separate
// snapshot sets side by side. MIRROR_DIR in the environment overrides the
// whole path.
//
// Use whenever:
//   - First time setting up the mirror (no snapshots yet)
//   - Need to force a full refresh after a schema change
//   - Atlas was throttling and the in-server refresh stalled
//
// Run: `node scripts/dump-mirrors.js`
// On success, restart the server and it'll boot from snapshots in <200ms.

import fs from 'fs';
import path from 'path';
import { col } from '../services/db.js';
// MIRROR_DIR is the per-database snapshot directory the server reads;
// ALL_MIRRORS is the registry, so a newly mirrored collection is dumped
// without this script having to know about it.
import { MIRROR_DIR, ALL_MIRRORS } from '../services/mirror.js';

const COLLECTIONS = ALL_MIRRORS.map((m) => m.name);

const toPlain = (doc) => JSON.parse(JSON.stringify(doc, (_k, v) => {
  if (v && typeof v === 'object' && v.constructor?.name === 'ObjectId') return v.toString();
  return v;
}));

const dump = async (name) => {
  const t0 = Date.now();
  const c = await col(name);
  // batchSize: bigger = fewer RTTs to Atlas. 5000 docs/RTT is what Mongo
  // is happy to send; the default of ~101 is what makes a cold start slow.
  const cursor = c.find({}, { batchSize: 5000 });
  const docs = [];
  let n = 0, last = Date.now();
  for await (const d of cursor) {
    docs.push(toPlain(d));
    n++;
    if (n % 2000 === 0) {
      const now = Date.now();
      console.log(`  ${name}: ${n} docs (+${now - last}ms)`);
      last = now;
    }
  }
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  const file = path.join(MIRROR_DIR, `${name}.json`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(docs));
  fs.renameSync(tmp, file);
  const size = fs.statSync(file).size;
  console.log(`${name}: ${n} docs, ${(size / 1024 / 1024).toFixed(1)} MB, ${Date.now() - t0}ms`);
};

const main = async () => {
  console.log(`\nDumping ${COLLECTIONS.length} mirrors to ${MIRROR_DIR}\n`);
  // Run in parallel — each collection is independent and a handful of
  // concurrent cursors is fine even on a free-tier cluster.
  await Promise.all(COLLECTIONS.map(dump));
  console.log('\nDone. Restart the server to pick up the new snapshots.\n');
  process.exit(0);
};

main().catch(e => { console.error(e); process.exit(1); });
