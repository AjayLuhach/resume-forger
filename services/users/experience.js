// Compute the user's "years of experience" string for {{exp}} substitution
// in connect notes / outreach. Cached in-process: the value only drifts
// by ~1 day per 365, and the users.<u>.data.meta.experienceStart field
// changes rarely. Restart the server to force a recompute outside the
// 24 h TTL.
//
// Output shape:
//   - '1+'    when raw years < 1.5 (avoids overselling a junior profile;
//             "1+" reads as "less than two years total" to recruiters).
//   - '~N'    when the half-year-rounded value is a whole (e.g. '~2', '~3').
//   - '~N.5'  when the half-year-rounded value lands on a half
//             (e.g. 2.33 → '~2.5'). Half-year granularity keeps partial
//             years visible — a previous Math.round(years) flattened
//             2.33 to '~2' which felt underselling.
//   - null    when the user doc / experienceStart is missing.
//
// Lives outside services/ext-api/ because both the extension router AND
// the authenticated /api/apply/jobs handler need it (same substitution,
// different request shapes).
import { getUser } from '../resume-store.js';

const _cache = new Map(); // username → { years: string|null, computedAt: ms }
const TTL_MS = 24 * 60 * 60 * 1000;

export async function yearsOfExperienceFor(username) {
  if (!username) return null;
  const hit = _cache.get(username);
  if (hit && Date.now() - hit.computedAt < TTL_MS) return hit.years;
  const u = await getUser(username).catch(() => null);
  const start = u?.data?.meta?.experienceStart;
  if (!start) {
    _cache.set(username, { years: null, computedAt: Date.now() });
    return null;
  }
  const ms = Date.now() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) {
    _cache.set(username, { years: null, computedAt: Date.now() });
    return null;
  }
  const years = ms / (1000 * 60 * 60 * 24 * 365.25);
  // Round to nearest 0.5, then trim a trailing .0 so a whole-year value
  // renders as "~3" not "~3.0".
  const half = Math.round(years * 2) / 2;
  const label = Number.isInteger(half) ? String(half) : half.toFixed(1);
  const out = years < 1.5 ? '1+' : `~${label}`;
  _cache.set(username, { years: out, computedAt: Date.now() });
  return out;
}

// Drop the cached value for one user (or everything if no username is
// passed). Called from the resume-save paths so an updated
// experienceStart is reflected on the next request without waiting for
// the 24 h TTL.
export function invalidateExperience(username = null) {
  if (username == null) _cache.clear();
  else _cache.delete(username);
}

// Bulk variant for /api/apply/jobs — one years lookup, then in-place
// substitution on each item's `connectNote`. Mutates items because the
// response is built from this same array immediately after.
export async function resolveExpInItems(items, username) {
  if (!items?.length || !username) return;
  const years = await yearsOfExperienceFor(username);
  if (!years) return;
  for (const j of items) {
    if (j?.connectNote && j.connectNote.includes('{{exp}}')) {
      j.connectNote = j.connectNote.replaceAll('{{exp}}', years);
    }
  }
}
