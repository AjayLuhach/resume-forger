// Auth: scrypt password hashing + signed-cookie sessions.
// No new deps — uses Node's built-in `crypto`. Sessions are stateless
// HMAC-signed cookies (no server-side store), which is plenty for a
// single-operator tool running on the operator's own machine. Set
// SESSION_SECRET in .env so sessions survive a restart; rotate it to
// invalidate every session at once.
import crypto from 'crypto';
import { col } from '../db.js';
import { log } from '../log.js';
import { invalidateUserCache } from '../users/current.js';

// Without a configured secret every boot mints a fresh random one. Sessions
// still work — they just don't survive a restart — and nothing signs cookies
// with a guessable string that ships in the repo. Loud, once, so the operator
// knows why they keep getting logged out.
const SESSION_SECRET = (() => {
  const configured = process.env.SESSION_SECRET && String(process.env.SESSION_SECRET).trim();
  if (configured) return configured;
  log.warn('auth', 'SESSION_SECRET is not set — using a random per-boot secret, so every restart signs everyone out. Add SESSION_SECRET=<long random string> to .env.');
  return crypto.randomBytes(32).toString('hex');
})();
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;   // 14 days
const COOKIE_NAME = 'forge_session';

// ── Password hashing — scrypt with random salt ──
const SCRYPT_KEYLEN = 64;

const hashPassword = (plain) => new Promise((resolve, reject) => {
  const salt = crypto.randomBytes(16);
  crypto.scrypt(plain, salt, SCRYPT_KEYLEN, (err, derived) => {
    if (err) return reject(err);
    // Stored as: scrypt$<salt-hex>$<hash-hex>
    resolve(`scrypt$${salt.toString('hex')}$${derived.toString('hex')}`);
  });
});

const verifyPassword = (plain, stored) => new Promise((resolve) => {
  if (!stored || !stored.startsWith('scrypt$')) return resolve(false);
  const [, saltHex, hashHex] = stored.split('$');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  crypto.scrypt(plain, salt, SCRYPT_KEYLEN, (err, derived) => {
    if (err) return resolve(false);
    try {
      resolve(crypto.timingSafeEqual(derived, expected));
    } catch { resolve(false); }
  });
});

// ── Session cookie — HMAC-signed payload ──
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

const sign = (payload) => {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
};

const unsign = (token) => {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  // timing-safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
};

// ── User lookup (by email — case-insensitive) ──
// The `users` collection is keyed by username; `auth.email` is the login
// handle stored alongside. Only the identity + auth block comes back — the
// resume payloads on the same doc are not needed to sign someone in.
export const findUserByEmail = async (email) => {
  if (!email) return null;
  const e = String(email).trim().toLowerCase();
  return (await col('users')).findOne(
    { 'auth.email': e },
    { projection: { username: 1, auth: 1 } },
  );
};

// ── Public API ──

export const login = async ({ email, password }) => {
  const user = await findUserByEmail(email);
  if (!user?.auth?.passwordHash) {
    return { ok: false, error: 'Invalid email or password' };
  }
  const ok = await verifyPassword(password, user.auth.passwordHash);
  if (!ok) return { ok: false, error: 'Invalid email or password' };
  // Touch lastLoginAt async (fire and forget, errors swallowed).
  (await col('users')).updateOne({ _id: user._id }, { $set: { 'auth.lastLoginAt': new Date().toISOString() } }).catch(() => {});
  return { ok: true, user: { username: user.username, email: user.auth.email } };
};

export const issueSessionCookie = (user) =>
  sign({ u: user.username, e: user.auth?.email || user.email, exp: Date.now() + SESSION_TTL_MS });

export const readSessionCookie = (rawCookieHeader) => {
  if (!rawCookieHeader) return null;
  // Tiny cookie parser — only looks for our own cookie name.
  const match = rawCookieHeader.split(/;\s*/).find(c => c.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  return unsign(decodeURIComponent(match.slice(COOKIE_NAME.length + 1)));
};

export const sessionCookieString = (token, { clear = false } = {}) => {
  const maxAge = clear ? 0 : Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  return parts.join('; ');
};

// ── User creation ──
//
// The one way a user comes into existence: the first-run /setup page and
// scripts/create-user.js both land here. A single-user database holds exactly
// one `users` doc, so creating a second is refused outright. The only
// exception is `allowExisting`, the credential-reset path: re-running the
// script for the username that already exists rewrites its email + password
// and leaves the resume payloads, SMTP config and history untouched.
//
// The stub doc carries just enough for the person to log in; they paste
// their resume JSONs on /resume.html afterwards. No join-date cutoff field —
// there is no shared pool to cut off, every row in the DB belongs to this user.
const EMAIL_RE = /^.+@.+\..+$/;

export async function createUser({ username, email, password, allowExisting = false } = {}) {
  const name = String(username || '').trim();
  const emailNorm = String(email || '').trim().toLowerCase();
  const plain = String(password || '');
  if (!name) throw new Error('createUser: username required');
  if (/[.$]/.test(name)) throw new Error('createUser: username may not contain "." or "$" (it is used as a Mongo field key)');
  if (!EMAIL_RE.test(emailNorm)) throw new Error('createUser: a valid email is required');
  if (plain.length < 6) throw new Error('createUser: password must be at least 6 characters');

  const users = await col('users');
  const existingDocs = await users
    .find({ username: { $type: 'string', $ne: '' } }, { projection: { username: 1 } })
    .toArray();
  const existingNames = existingDocs.map((d) => d.username);
  const self = existingNames.includes(name);
  const others = existingNames.filter((n) => n !== name);

  // `code` lets an HTTP caller map these to a generic 409 — the messages
  // name the existing account, which is fine on the operator's own terminal
  // and not fine for an unauthenticated /api/setup caller.
  const exists = (msg) => Object.assign(new Error(msg), { code: 'user-exists' });
  if (existingNames.length && !allowExisting) {
    throw exists(`createUser: this database already has a user (${existingNames.map((n) => `"${n}"`).join(', ')}) — Resume Forge is single-user. Re-run with the same --username to reset its credentials.`);
  }
  if (others.length) {
    throw exists(`createUser: refusing to add "${name}" next to existing user ${others.map((n) => `"${n}"`).join(', ')} — one user per database.`);
  }

  const passwordHash = await hashPassword(plain);
  const now = new Date().toISOString();

  if (self) {
    // Credential reset — preserve data, feedData, pdf, emailConfig, history.
    await users.updateOne(
      { username: name },
      { $set: {
        'auth.email': emailNorm,
        'auth.passwordHash': passwordHash,
        'auth.updatedAt': now,
        updatedAt: now,
      } },
    );
  } else {
    await users.createIndex({ username: 1 }, { unique: true });
    const { insertedId } = await users.insertOne({
      username: name,
      data: {
        personalInfo: { name, email: emailNorm },
      },
      auth: {
        email: emailNorm,
        passwordHash,
        createdAt: now,
      },
      updatedAt: now,
    });
    // The count above and this insert are not atomic, and the unique index
    // is on username, so two different names racing through (two processes
    // — /setup and create-user.js, say) both land. Both sides re-read the
    // same ordering, so exactly one backs its own doc out: the one that is
    // not the oldest. A single-user database must stay one.
    const all = await users
      .find({ username: { $type: 'string', $ne: '' } }, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .toArray();
    if (all.length > 1 && !all[0]._id.equals(insertedId)) {
      await users.deleteOne({ _id: insertedId });
      invalidateUserCache();
      throw exists('createUser: another user was created at the same time — this database already has a user. Sign in instead.');
    }
  }

  // Per-user compound index on job_tracker so the Mongo fallback path (the
  // few seconds before the mirror loads) can serve applied/status filters
  // from an index. Idempotent — createIndex no-ops when it already exists.
  const jt = await col('job_tracker');
  const indexName = `apply_${name.replace(/\s+/g, '_')}_1`;
  await jt.createIndex(
    { [`users.${name}.applied`]: 1, [`users.${name}.status`]: 1 },
    { name: indexName },
  );

  invalidateUserCache();
  return { username: name, email: emailNorm, created: !self };
}

// ── Password management ──
export const setUserPassword = async (username, plain) => {
  const passwordHash = await hashPassword(plain);
  const r = await (await col('users')).updateOne(
    { username },
    { $set: { 'auth.passwordHash': passwordHash, 'auth.updatedAt': new Date().toISOString() } },
  );
  if (r.matchedCount === 0) throw new Error(`No user found for username "${username}"`);
  return { ok: true };
};

// Verify the current password for an already-authenticated user — used
// during password-change so we don't let a stolen session cookie reset
// credentials without proof of the old password.
export const verifyCurrentPassword = async (username, plain) => {
  const doc = await (await col('users')).findOne(
    { username },
    { projection: { 'auth.passwordHash': 1 } },
  );
  if (!doc?.auth?.passwordHash) return false;
  return verifyPassword(plain, doc.auth.passwordHash);
};

export const setUserEmail = async (username, email) => {
  const e = String(email).trim().toLowerCase();
  const r = await (await col('users')).updateOne(
    { username },
    { $set: { 'auth.email': e, 'auth.updatedAt': new Date().toISOString() } },
  );
  if (r.matchedCount === 0) throw new Error(`No user found for username "${username}"`);
  return { ok: true };
};

export const COOKIE_KEY = COOKIE_NAME;
export { hashPassword, verifyPassword };
