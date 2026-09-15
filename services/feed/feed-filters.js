import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { highSalaryMirror } from '../mirror.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// services/feed/ → climb two levels to reach the repo root where the
// LEGACY high-salary-companies.json lives. Source of truth is now the
// `high_salary_companies` mongo collection (mirrored), but we keep the
// file as a bootstrap for the brief window between server start and
// snapshot load.
const ROOT = path.join(__dirname, '..', '..');

const COMPANY_SUFFIX_RES = [
  /\s+(pvt|private|public)\s+(ltd|limited)\s*$/,
  /\s+(pvt|private|public)\s*$/,
  /\s+(ltd|limited|llc|llp|inc|corp|corporation|gmbh|plc|pte)\s*$/,
  /\s+(india|global|worldwide|usa|uk)\s*$/,
  /\s+(technologies|technology|solutions|software|services|systems|consulting|consultancy|infotech|infosystems|enterprises|ventures|group|labs|lab|digital|co|company)\s*$/,
];

export const normalizeCompany = (name) => {
  if (!name) return '';
  let n = name.toLowerCase().trim().replace(/[.\-&+,()®™'"]/g, ' ');
  let prev;
  do { prev = n; for (const re of COMPANY_SUFFIX_RES) n = n.replace(re, '').trim(); } while (n !== prev);
  return n.replace(/\s+/g, ' ').trim();
};

// USD → local currency, for "$50/hr" and "$120k/yr" figures. INR by
// construction: this is the rate the stored pool was normalised at.
export const USD_TO_LOCAL = 85;

// INR/LPA-centric on purpose. It reads "LPA", "lakh", "LPM" and "₹" as Indian
// units and converts dollar figures at USD_TO_LOCAL, because every stored
// `job.salaryMinLPA` / `salaryMaxLPA` in the pool carries that unit and the
// filters compare against them. Changing the unit here without re-extracting
// the pool would make the salary pills lie; preferences.salaryUnit governs
// what NEW extractions are normalised to.
export const parseSalaryToLPA = (sal) => {
  if (!sal) return null;
  const s = String(sal).toLowerCase().replace(/,/g, '');
  let m = s.match(/([\d.]+)\s*(?:-\s*[\d.]+\s*)?(?:lpa|lakhs?\s*per\s*annum|l\b)/);
  if (m) return parseFloat(m[1]);
  m = s.match(/([\d.]+)\s*lpm/);
  if (m) return parseFloat(m[1]) * 12;
  m = String(sal).match(/₹\s*([\d,]+)/);
  if (m) {
    const amt = parseFloat(m[1].replace(/,/g, ''));
    return amt >= 100000 ? amt / 100000 : (amt * 12) / 100000;
  }
  m = s.match(/\$\s*([\d.]+)\s*(?:\/\s*)?(?:hr|hour)/);
  if (m) return (parseFloat(m[1]) * 2080 * USD_TO_LOCAL) / 100000;
  m = s.match(/\$\s*([\d.]+)\s*k?\s*(?:\/\s*)?(?:yr|year|annual)/);
  if (m) { let v = parseFloat(m[1]); if (v < 1000) v *= 1000; return (v * USD_TO_LOCAL) / 100000; }
  m = s.match(/([\d.]+)/);
  if (m) { const v = parseFloat(m[1]); return v < 200 ? v : (v * 12) / 100000; }
  return null;
};

let _wellKnownCache = null;
let _wellKnownFromMirror = false;
export const loadWellKnownKeys = () => {
  // Re-build whenever the mirror lands or refreshes so we don't keep
  // serving the bootstrap-file snapshot after the mirror has fresher data.
  if (_wellKnownCache && (_wellKnownFromMirror || !highSalaryMirror.loaded)) {
    return _wellKnownCache;
  }
  const set = new Set();
  if (highSalaryMirror.loaded) {
    for (const d of highSalaryMirror.iter()) {
      for (const n of [d.company, ...(d.companyAlias || [])]) {
        const k = normalizeCompany(n);
        if (k) set.add(k);
      }
    }
    _wellKnownFromMirror = true;
  } else {
    // Bootstrap path — read the legacy file once. Replaced by the mirror
    // path as soon as the snapshot loads (~150 ms after boot).
    try {
      const filePath = path.join(ROOT, 'high-salary-companies.json');
      const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const c of list) {
        for (const n of [c.company, ...(c.companyAlias || [])]) {
          const k = normalizeCompany(n);
          if (k) set.add(k);
        }
      }
    } catch { /* file gone; fine — mirror will take over */ }
  }
  _wellKnownCache = [...set];
  return _wellKnownCache;
};

// Bust the cache whenever the mirror absorbs an upsert/delete/delta so
// a write to the collection
// reflects within ~15 s without restarting the server.
highSalaryMirror.subscribe?.(() => {
  _wellKnownCache = null;
  _wellKnownFromMirror = false;
});

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// In-memory predicate equivalents of buildEmailsFilter / buildPostsFilter.
// Mongo filters are great for the DB; for the in-process mirror we need
// plain functions over plain objects. Semantics must stay identical or the
// mirror path will return different results from the Mongo fallback.

const _hasAt = (s) => typeof s === 'string' && /@/.test(s);

// `addedAt` is stored as an ISO string, not a Date, so compare strings —
// ISO 8601 sorts lexicographically. Coercing to Date here would silently match
// nothing, the same trap the createdAt note in CLAUDE.md describes.
export const sinceISO = (days) => {
  const n = parseInt(days, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.now() - n * 86400000).toISOString();
};

// A DM-only post with no profile link is unreachable — there is no address to
// write to and nobody to send an invitation to. Treat it as not-a-result rather
// than showing a row that can't be acted on.
const _reachableDM = (d) => Boolean(d.poster?.profileUrl);

export const buildEmailsMatcher = (p) => {
  const wellKnown = (p.wellKnown === 'yes' || p.wellKnown === 'no')
    ? new Set(loadWellKnownKeys())
    : null;
  const re = p.q ? new RegExp(escapeRegex(p.q), 'i') : null;
  const minSal = (p.minSalary && p.minSalary !== 'unknown') ? parseFloat(p.minSalary) : null;
  return (d) => {
    if (p.user && d.username !== p.user) return false;
    if (p.status && p.status !== 'all' && d.status !== p.status) return false;
    if (p.type && d.job?.type !== p.type) return false;
    if (p.hasEmail === '1' && !_hasAt(d.email?.to)) return false;
    if (p.hasEmail === '0' && _hasAt(d.email?.to)) return false;
    if (p.minSalary === 'unknown') {
      if (d.job?.salaryMinLPA != null) return false;
    } else if (minSal != null) {
      if (d.job?.salaryMinLPA == null || d.job.salaryMinLPA < minSal) return false;
    }
    if (wellKnown) {
      const inSet = d._companyKey && wellKnown.has(d._companyKey);
      if (p.wellKnown === 'yes' && !inSet) return false;
      if (p.wellKnown === 'no' && inSet) return false;
    }
    if (re) {
      const hay = [
        d.poster?.name, d.poster?.headline,
        d.job?.title, d.job?.company, d.job?.type,
        d.email?.to, d.email?.subject,
        d.matchReason, d.username, d.postSummary,
      ].filter(Boolean).join('\n');
      if (!re.test(hay)) return false;
    }
    return true;
  };
};

export const buildPostsMatcher = (p) => {
  const wellKnown = (p.wellKnown === 'yes' || p.wellKnown === 'no')
    ? new Set(loadWellKnownKeys())
    : null;
  const re = p.q ? new RegExp(escapeRegex(p.q), 'i') : null;
  const minSal = (p.minSalary && p.minSalary !== 'unknown') ? parseFloat(p.minSalary) : null;
  const since = sinceISO(p.days);
  return (d) => {
    if (p.status === 'hiring' && d.status !== 'hiring') return false;
    if (p.status === 'skipped' && d.status !== 'skipped') return false;
    if (since && String(d.addedAt || '') < since) return false;
    if (p.type && d.job?.type !== p.type) return false;
    if (p.contactMethod === 'email' && d.contacts?.method !== 'email') return false;
    if (p.contactMethod === 'link'  && d.contacts?.method !== 'link')  return false;
    if (p.contactMethod === 'dm' && (d.contacts?.method !== 'DM' || !_reachableDM(d))) return false;
    if (p.minSalary === 'unknown') {
      if (d.job?.salaryMinLPA != null) return false;
    } else if (minSal != null) {
      if (d.job?.salaryMinLPA == null || d.job.salaryMinLPA < minSal) return false;
    }
    if (wellKnown) {
      const inSet = d._companyKey && wellKnown.has(d._companyKey);
      if (p.wellKnown === 'yes' && !inSet) return false;
      if (p.wellKnown === 'no' && inSet) return false;
    }
    if (re) {
      const hay = [
        d.poster?.name, d.poster?.headline,
        d.job?.title, d.job?.company, d.job?.type,
        d.summary, ...(d.contacts?.emails || []),
      ].filter(Boolean).join('\n');
      if (!re.test(hay)) return false;
    }
    return true;
  };
};

// Build a Mongo filter for the user_emails collection.
export const buildEmailsFilter = (p) => {
  const and = [];
  if (p.user) and.push({ username: p.user });
  if (p.status && p.status !== 'all') and.push({ status: p.status });
  if (p.type) and.push({ 'job.type': p.type });
  if (p.hasEmail === '1') and.push({ 'email.to': /@/ });
  if (p.hasEmail === '0') and.push({ $or: [{ 'email.to': { $exists: false } }, { 'email.to': '' }, { 'email.to': { $not: /@/ } }] });
  if (p.minSalary === 'unknown') and.push({ $or: [{ 'job.salaryMinLPA': null }, { 'job.salaryMinLPA': { $exists: false } }] });
  else if (p.minSalary) and.push({ 'job.salaryMinLPA': { $gte: parseFloat(p.minSalary) } });
  if (p.wellKnown === 'yes') and.push({ _companyKey: { $in: loadWellKnownKeys() } });
  if (p.wellKnown === 'no') and.push({ _companyKey: { $nin: loadWellKnownKeys() } });
  if (p.q) {
    const re = new RegExp(escapeRegex(p.q), 'i');
    and.push({ $or: [
      { 'poster.name': re }, { 'poster.headline': re },
      { 'job.title': re }, { 'job.company': re }, { 'job.type': re },
      { 'email.to': re }, { 'email.subject': re },
      { matchReason: re }, { username: re }, { postSummary: re },
    ]});
  }
  return and.length ? { $and: and } : {};
};

// Build a Mongo filter for the posts collection.
export const buildPostsFilter = (p) => {
  const and = [];
  if (p.status === 'hiring') and.push({ status: 'hiring' });
  if (p.status === 'skipped') and.push({ status: 'skipped' });
  const since = sinceISO(p.days);
  if (since) and.push({ addedAt: { $gte: since } });
  if (p.type) and.push({ 'job.type': p.type });
  if (p.contactMethod === 'email') and.push({ 'contacts.method': 'email' });
  if (p.contactMethod === 'link') and.push({ 'contacts.method': 'link' });
  // Mirror _reachableDM: $nin with null also excludes docs missing the field.
  if (p.contactMethod === 'dm') and.push({ 'contacts.method': 'DM', 'poster.profileUrl': { $nin: ['', null] } });
  if (p.minSalary === 'unknown') and.push({ $or: [{ 'job.salaryMinLPA': null }, { 'job.salaryMinLPA': { $exists: false } }] });
  else if (p.minSalary) and.push({ 'job.salaryMinLPA': { $gte: parseFloat(p.minSalary) } });
  if (p.wellKnown === 'yes') and.push({ _companyKey: { $in: loadWellKnownKeys() } });
  if (p.wellKnown === 'no') and.push({ _companyKey: { $nin: loadWellKnownKeys() } });
  if (p.q) {
    const re = new RegExp(escapeRegex(p.q), 'i');
    and.push({ $or: [
      { 'poster.name': re }, { 'poster.headline': re },
      { 'job.title': re }, { 'job.company': re }, { 'job.type': re },
      { summary: re }, { 'contacts.emails': re },
    ]});
  }
  return and.length ? { $and: and } : {};
};
