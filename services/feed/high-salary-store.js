// High-salary companies — what used to live in high-salary-companies.json
// at the repo root. Now in mongo `high_salary_companies` (mirrored), so
// edits from one laptop propagate to the other within ~15 s instead of
// requiring a git commit/pull.
//
// Doc shape (one per company; _id is the lowercased trimmed company name
// for trivially idempotent upserts):
//   {
//     _id: 'acme corp',
//     company: 'Acme Corp',
//     companyAlias: ['Acme', 'Acme Inc'],
//     employee_count: '201-500 employees',
//     salaryMaxLPA: 30, salaryMinLPA: 12, salaryLPA: '12-30',
//     company_url: 'https://linkedin.com/company/acme',
//     createdAt, updatedAt        // stamped by services/db.js col() Proxy
//   }
import { col } from '../db.js';
import { highSalaryMirror } from '../mirror.js';

const KEY = (name) => String(name || '').toLowerCase().trim();

// Read every row. Mirror path is microseconds; Mongo fallback covers the
// brief window between server start and the snapshot load.
export const loadAll = async () => {
  if (highSalaryMirror.loaded) return highSalaryMirror.all();
  const c = await col('high_salary_companies');
  return c.find({}).toArray();
};

// Same as loadAll but returns null when the mirror isn't ready yet — for
// call sites that need a sync answer and have a file-based fallback.
export const loadAllSync = () => (highSalaryMirror.loaded ? highSalaryMirror.all() : null);

// Lookup by raw or normalized company name. Sub-ms over the mirror.
export const findByName = async (name) => {
  const k = KEY(name);
  if (!k) return null;
  if (highSalaryMirror.loaded) return highSalaryMirror.get(k);
  const c = await col('high_salary_companies');
  return c.findOne({ _id: k });
};

// Bulk upsert — used by bulk imports. Auto-
// stamped with createdAt/updatedAt via the col() Proxy. Refreshes the
// in-process mirror with the post-write docs so subsequent reads from
// THIS process see them immediately.
export const upsertCompanies = async (rows) => {
  if (!Array.isArray(rows) || !rows.length) return { upserted: 0, modified: 0 };
  const c = await col('high_salary_companies');
  const ops = [];
  const keys = [];
  for (const r of rows) {
    const key = KEY(r.company);
    if (!key) continue;
    keys.push(key);
    ops.push({
      updateOne: {
        filter: { _id: key },
        update: { $set: { ...r, _id: key } },
        upsert: true,
      },
    });
  }
  if (!ops.length) return { upserted: 0, modified: 0 };
  const res = await c.bulkWrite(ops, { ordered: false });
  // Refresh the in-process mirror — same pattern as connections/posts.
  try {
    const refreshed = await c.find({ _id: { $in: keys } }).toArray();
    highSalaryMirror.applyMany(refreshed);
  } catch { /* mirror not loaded; delta loop will catch up */ }
  return { upserted: res.upsertedCount || 0, modified: res.modifiedCount || 0 };
};

// Subscribe to mirror changes — used by company-filter / feed-filters to
// bust their in-memory Set caches when delta sync or local writes land.
export const subscribeChanges = (fn) => highSalaryMirror.subscribe?.(fn);
