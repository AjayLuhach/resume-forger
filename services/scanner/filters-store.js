// Scanner filters — blocklists + employee/experience thresholds. Replaces
// the file-based filters.json from extensions/job-scanner/server/data/. We
// store a single document in mongo (`scanner_filters` collection, key:
// 'global') so both users share the same blocklist — same behavior as the
// extension, just durable across machines and editable from any browser.
import { col } from '../db.js';

const DEFAULTS = {
  blockedCompanies: [],
  blockedKeywords: [],
  minEmployees: null,
  maxEmployees: null,
  minExperienceYears: null,
  maxExperienceYears: null,
};

const KEY = { _id: 'global' };

const sanitize = (input = {}) => {
  const out = { ...DEFAULTS };
  if (Array.isArray(input.blockedCompanies)) {
    out.blockedCompanies = [
      ...new Set(input.blockedCompanies.map((s) => String(s).trim()).filter(Boolean)),
    ];
  }
  if (Array.isArray(input.blockedKeywords)) {
    out.blockedKeywords = [
      ...new Set(input.blockedKeywords.map((s) => String(s).trim()).filter(Boolean)),
    ];
  }
  for (const k of ['minEmployees', 'maxEmployees', 'minExperienceYears', 'maxExperienceYears']) {
    const v = input[k];
    out[k] = v === null || v === undefined || v === '' ? null : Number(v);
    if (Number.isNaN(out[k])) out[k] = null;
  }
  return out;
};

export const readFilters = async () => {
  const c = await col('scanner_filters');
  const doc = await c.findOne(KEY);
  if (!doc) return { ...DEFAULTS };
  return sanitize(doc);
};

export const writeFilters = async (input) => {
  const c = await col('scanner_filters');
  const next = sanitize(input);
  await c.updateOne(KEY, { $set: next }, { upsert: true });
  return next;
};

export const blockCompany = async (name) => {
  const filters = await readFilters();
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('company name required');
  if (!filters.blockedCompanies.some(c => c.toLowerCase() === trimmed.toLowerCase())) {
    filters.blockedCompanies.push(trimmed);
    await writeFilters(filters);
  }
  return readFilters();
};

export const unblockCompany = async (name) => {
  const filters = await readFilters();
  filters.blockedCompanies = filters.blockedCompanies.filter(
    c => c.toLowerCase() !== String(name).toLowerCase(),
  );
  await writeFilters(filters);
  return readFilters();
};
