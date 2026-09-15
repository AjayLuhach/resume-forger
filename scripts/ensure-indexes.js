#!/usr/bin/env node
// scripts/ensure-indexes.js
//
// Create every index the app relies on. Safe to run on a fresh database and
// safe to run again — createIndex is a no-op when the index already exists,
// and an index that exists under another name or with other options is
// reported and left alone rather than treated as an error.
//
// The server also creates most of these lazily on the first request that
// needs them (services/apply/job-store.js, scripts/feed/dashboard-server.js,
// services/connections/store.js). This script exists so a new database is
// indexed before the first page load, and so the two timestamp indexes the
// mirror's delta sync depends on are never missing.
//
// It also stamps `updatedAt` on any document that lacks it. The in-memory
// mirror (services/mirror.js) only sees rows whose updatedAt / createdAt is
// newer than its last sync, so a row imported by hand without a timestamp
// would otherwise stay invisible until something else touched it.
//
//   node scripts/ensure-indexes.js          (or: npm run ensure-indexes)

import { col, close, STAMPED_COLLECTIONS } from '../services/db.js';
import { listUsernames } from '../services/users/current.js';

// Per-collection indexes beyond the timestamp pair. Keys are the collection
// name; each entry is [keys, options]. Keep in step with the lazy ensure*
// functions in the stores — same keys, same options, so neither side ever
// trips over the other's index.
const INDEXES = {
  users: [
    [{ username: 1 }, { unique: true }],
  ],
  job_tracker: [
    [{ jobLink: 1 }, { unique: true }],
    // The extension's lookup key; not unique because rows added by URL paste
    // may have no platform id at all.
    [{ jobId: 1 }, {}],
    [{ title: 1 }, {}],
    [{ rowStatus: 1 }, { sparse: true }],
    [{ rowStatus: 1, _id: -1 }, { sparse: true }],
    [{ verdict: 1, score: -1 }, { sparse: true }],
    [{ score: -1 }, { sparse: true }],
    [{ analyzedAt: -1 }, { sparse: true }],
    [{ applicantsNumeric: -1 }, { sparse: true }],
    [{ experienceYearsMin: -1 }, { sparse: true }],
    [{ 'companyDetails.employeesOnLinkedInNum': -1 }, { sparse: true }],
  ],
  posts: [
    [{ postId: 1 }, { unique: true }],
    [{ addedAt: -1 }, {}],
    [{ status: 1, addedAt: -1 }, {}],
    [{ _companyKey: 1 }, {}],
  ],
  user_emails: [
    [{ username: 1, postId: 1 }, {}],
    [{ username: 1, status: 1 }, {}],
    [{ status: 1, score: -1 }, {}],
    [{ postId: 1 }, {}],
    [{ _companyKey: 1 }, {}],
  ],
  connections: [
    [{ profileUrl: 1 }, { unique: true }],
    [{ firstSeenAt: -1 }, {}],
  ],
  user_connects: [
    [{ username: 1, postId: 1 }, {}],
  ],
  user_inbox: [
    [{ username: 1, messageId: 1 }, {}],
  ],
  resume_variants: [
    [{ username: 1, generatedAt: -1 }, {}],
    [{ username: 1, jobId: 1 }, {}],
  ],
  connection_view_state: [
    [{ owner: 1, jobLink: 1 }, { unique: true }],
  ],
};

// Every stamped collection gets the timestamp pair the delta sync queries.
// job_tracker's lazy ensureIndex declares createdAt descending; match it so a
// booted server does not add a second createdAt index next to this one.
for (const name of STAMPED_COLLECTIONS) {
  INDEXES[name] = INDEXES[name] || [];
  INDEXES[name].push([{ updatedAt: 1 }, {}]);
  INDEXES[name].push([{ createdAt: name === 'job_tracker' ? -1 : 1 }, {}]);
}

const label = (keys, opts) =>
  JSON.stringify(keys) + (Object.keys(opts).length ? ' ' + JSON.stringify(opts) : '');

const ensure = async (c, keys, opts) => {
  try {
    await c.createIndex(keys, opts);
    return 'ok';
  } catch (e) {
    if (/already exists/i.test(e.message)) return `exists with different name/options — left alone`;
    throw e;
  }
};

const main = async () => {
  // The per-user compound index the apply page's Mongo fallback path uses
  // (the same one scripts/create-user.js creates). One user in normal
  // operation; every username is covered so an older multi-user database
  // still works.
  for (const name of await listUsernames({ fresh: true })) {
    INDEXES.job_tracker.push([
      { [`users.${name}.applied`]: 1, [`users.${name}.status`]: 1 },
      { name: `apply_${name.replace(/\s+/g, '_')}_1` },
    ]);
  }

  for (const [name, specs] of Object.entries(INDEXES)) {
    const c = await col(name);
    console.log(`\n[${name}]`);

    if (STAMPED_COLLECTIONS.has(name)) {
      const t0 = Date.now();
      const r = await c.updateMany(
        { updatedAt: { $exists: false } },
        { $currentDate: { updatedAt: true } },
      );
      if (r.modifiedCount) console.log(`  stamped updatedAt on ${r.modifiedCount} docs (${Date.now() - t0}ms)`);
    }

    for (const [keys, opts] of specs) {
      const t0 = Date.now();
      const res = await ensure(c, keys, opts);
      console.log(`  ${label(keys, opts).padEnd(70)} ${res} (${Date.now() - t0}ms)`);
    }
  }

  console.log('\nDone.\n');
  await close();
};

main().catch(async (e) => {
  console.error(e);
  await close();
  process.exit(1);
});
