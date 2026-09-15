// Single-operator identity.
//
// This tool runs as ONE person against ONE database. The `users` collection
// therefore holds exactly one document in normal operation, and that document
// is the identity for every code path that has no session cookie to read:
// the extension's unauthenticated /api/ext/* calls, CLIs run without --user,
// the peer-sync loop, boot-time checks.
//
// Resolution order, everywhere:
//   1. the signed session cookie (HTTP requests from a logged-in browser)
//   2. the sole document in `users`
//   3. null — the caller decides whether that is a 400 or a "run /setup" hint
//
// There is deliberately NO `?user=` override any more (it existed for one
// operator drafting on behalf of another, which a single-user DB cannot mean)
// and NO env / file / nickname fallback (see CLAUDE.md, "The one rule").
//
// A database that still holds several users (the original shared deployment)
// is tolerated: session cookies keep working, `--user` keeps working, and only
// the cookie-less paths refuse with a message naming the candidates. Nothing
// silently picks one.
import { col } from '../db.js';
import { readSessionCookie } from '../auth/auth-store.js';

const TTL_MS = 60_000;
let _cache = null; // { usernames: string[], at: ms }

// Every username in the collection, cached for TTL_MS. User creation and
// deletion are rare and go through code that calls invalidateUserCache().
export async function listUsernames({ fresh = false } = {}) {
  if (!fresh && _cache && Date.now() - _cache.at < TTL_MS) return _cache.usernames;
  const docs = await (await col('users'))
    .find({ username: { $type: 'string', $ne: '' } }, { projection: { username: 1 } })
    .toArray();
  const usernames = docs.map((d) => d.username).sort();
  _cache = { usernames, at: Date.now() };
  return usernames;
}

export async function userCount(opts) {
  return (await listUsernames(opts)).length;
}

export function invalidateUserCache() {
  _cache = null;
}

// The one user, or null when there are zero (first run, before /setup) or
// several (legacy shared DB — ambiguous, so nothing is chosen).
export async function getSoleUser(opts) {
  const names = await listUsernames(opts);
  return names.length === 1 ? names[0] : null;
}

// Why getSoleUser() returned null, for error messages.
export async function describeUserState() {
  const names = await listUsernames();
  if (names.length === 0) return 'no user exists yet — open /setup (or run scripts/create-user.js) first';
  if (names.length === 1) return `single user "${names[0]}"`;
  return `${names.length} users exist (${names.map((n) => `"${n}"`).join(', ')}) — log in, or pass --user "<name>" to pick one`;
}

// HTTP: session cookie, else the sole user. Never reads req.query.user.
export async function resolveUsername(req) {
  const s = readSessionCookie(req?.headers?.cookie);
  if (s?.u) return s.u;
  return getSoleUser();
}

// Express-style helper for handlers that must have a user: resolves, and on
// failure sends the 4xx itself and returns null so the caller can `return`.
export async function requireUsername(req, res) {
  const u = await resolveUsername(req);
  if (u) return u;
  const why = await describeUserState();
  res.status(400).json({ error: `No user: ${why}` });
  return null;
}

// CLIs: an explicit --user wins; otherwise the sole user; otherwise throw
// with the reason, so the operator knows whether to run /setup or add --user.
export async function resolveCliUser(flagValue, { command = 'this command' } = {}) {
  const explicit = flagValue && String(flagValue).trim();
  if (explicit) return explicit;
  const sole = await getSoleUser();
  if (sole) return sole;
  throw new Error(`${command}: could not pick a user — ${await describeUserState()}`);
}

// Boot-time one-liner for the server banner / log.
export async function userStateSummary() {
  try { return await describeUserState(); } catch (e) { return `users collection unreadable: ${e.message}`; }
}
