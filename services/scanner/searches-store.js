// Saved LinkedIn job-search URLs for the /scanner page's "Open & capture"
// button. One mongo document (`scanner_searches` collection, _id 'global'),
// shaped exactly like filters-store.js — a single shared config doc both users
// see, durable across machines, editable from any browser. Config-shaped /
// low-churn, so it's stamped (STAMPED_COLLECTIONS in db.js) but NOT mirrored;
// cross-machine propagation is on page reload, same as scanner_filters.
import { randomUUID } from 'crypto';
import { col } from '../db.js';

const KEY = { _id: 'global' };

// Keep only the params that DEFINE the search; drop session/tracking params so
// a saved link carries no reference to the account that created it. LinkedIn
// still attributes browsing via the session cookie — this only de-fingerprints
// the URL itself (notably `referralSearchId`, plus `origin`/`currentJobId`/
// `trackingId`/`refId`/`trk`…). String-based so the kept params' original
// encoding (the heavy `keywords` blob) is preserved verbatim.
const KEEP_PARAM = (k) =>
  k === 'keywords' || k === 'geoId' || k === 'location' ||
  k === 'distance' || k === 'sortBy' || /^f_/.test(k);

const cleanSearchUrl = (raw) => {
  try {
    const [head, query] = String(raw).split('#')[0].split('?');
    if (!query) return head;
    const kept = query.split('&').filter((p) => p && KEEP_PARAM(p.split('=')[0]));
    return kept.length ? `${head}?${kept.join('&')}` : head;
  } catch { return raw; }
};

// Each entry: { id, label, url, enabled }. `url` is required; a missing id is
// minted server-side so edit/delete have a stable handle. We don't hard-reject
// non-LinkedIn URLs (the operator may have a niche search host) but we do drop
// anything that isn't a parseable absolute URL.
const sanitize = (list = []) => {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    const raw = String(s?.url || '').trim();
    if (!raw) continue;
    try { new URL(raw); } catch { continue; }
    out.push({
      id: String(s?.id || '').trim() || randomUUID(),
      label: String(s?.label || '').trim(),
      url: cleanSearchUrl(raw),
      enabled: s?.enabled !== false,
    });
  }
  return out;
};

export const readSearches = async () => {
  const c = await col('scanner_searches');
  const doc = await c.findOne(KEY);
  return sanitize(doc?.searches || []);
};

export const writeSearches = async (list) => {
  const c = await col('scanner_searches');
  const next = sanitize(list);
  await c.updateOne(KEY, { $set: { searches: next } }, { upsert: true });
  return next;
};
