// Feed sibling of scanner/searches-store.js: saved feed/content-search URLs for
// /feed's "Open & capture". One stamped-but-unmirrored doc (feed_sources, _id
// 'global'). Unlike jobs we keep all query params (they ARE the search).
import { randomUUID } from 'crypto';
import { col } from '../db.js';

const KEY = { _id: 'global' };

const HOME_FEED = { label: 'Home feed', url: 'https://www.linkedin.com/feed/' };

// LinkedIn content search for "<term> and hiring", last 24 h, by relevance.
const searchUrl = (term) =>
  `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(`${term} and hiring`)}&origin=FACETED_SEARCH&sortBy=%5B%22relevance%22%5D&datePosted=%5B%22past-24h%22%5D`;

// "Node.js" → "nodejs": LinkedIn's keyword search treats the dot as a word
// break, and the joined form is what people actually type.
const searchTerm = (skill) => String(skill || '').toLowerCase().replace(/\./g, '').trim();

// Seeded on first read: the home feed, plus one "<skill> and hiring · 24h"
// search for each of the candidate's first three skills when a candidate is
// given. With no candidate (the CLI without a resume, an unauthenticated
// read) only the home feed is seeded — a search for a stack the user doesn't
// have is worse than none, and sources are editable on /feed anyway.
const defaultSources = (candidate) => {
  const skills = (candidate?.skills || []).map(searchTerm).filter(Boolean).slice(0, 3);
  return [
    HOME_FEED,
    ...skills.map((s) => ({ label: `${s} · hiring · 24h`, url: searchUrl(s) })),
  ];
};

// Keep the URL intact (drop only the hash); mint a missing id. { id, label, url, enabled }.
const sanitize = (list = []) => {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    const raw = String(s?.url || '').trim();
    if (!raw) continue;
    let url;
    try { url = new URL(raw); } catch { continue; }
    url.hash = '';
    out.push({
      id: String(s?.id || '').trim() || randomUUID(),
      label: String(s?.label || '').trim(),
      url: url.toString(),
      enabled: s?.enabled !== false,
    });
  }
  return out;
};

// `candidate` (the loadCandidate() object) is optional and only consulted on
// the first read, when the defaults are seeded.
export const readSources = async (candidate = null) => {
  const c = await col('feed_sources');
  const doc = await c.findOne(KEY);
  if (!doc) {
    // First run — seed the defaults.
    const seeded = sanitize(defaultSources(candidate));
    await c.updateOne(KEY, { $set: { sources: seeded } }, { upsert: true });
    return seeded;
  }
  return sanitize(doc.sources || []);
};

export const writeSources = async (list) => {
  const c = await col('feed_sources');
  const next = sanitize(list);
  await c.updateOne(KEY, { $set: { sources: next } }, { upsert: true });
  return next;
};
