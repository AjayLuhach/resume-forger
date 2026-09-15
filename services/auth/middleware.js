// Auth middleware. Reads the signed session cookie, attaches `req.user`
// on success, and short-circuits with 401 (JSON) or redirect (HTML) for
// unauthenticated requests. Whitelists a small set of public paths so
// the login + first-run setup pages and their static assets keep working.
//
// First run: with no user in the database there is nothing to log in as, so
// an unauthenticated HTML request is sent to /setup instead of /login. The
// check is injected by server.js via `setSetupCheck` (it lives in
// services/users/current.js and is cached, so it costs nothing per request).
import crypto from 'crypto';
import { readSessionCookie } from './auth-store.js';

const PUBLIC_PATHS = new Set([
  '/login',
  '/login.html',
  '/setup',
  '/setup.html',
  '/api/login',
  '/api/logout',
  '/api/setup',
  '/favicon.svg',
  '/favicon.ico',
]);

const PUBLIC_PREFIXES = [
  '/app.css',          // shared design system loads before auth
  '/nav.js',
];

const isPublic = (pathname) => {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '?'));
};

const wantsHtml = (req) =>
  (req.headers.accept || '').includes('text/html') &&
  req.method === 'GET';

// "Does the database have no user yet?" — injected so this module stays free
// of a DB import. Defaults to "no" (i.e. behave exactly as before) until
// server.js wires the real check.
let _isSetupRequired = async () => false;
export const setSetupCheck = (fn) => { _isSetupRequired = typeof fn === 'function' ? fn : (async () => false); };
const setupRequired = async () => {
  try { return !!(await _isSetupRequired()); } catch { return false; }
};

// Where an unauthenticated HTML request goes.
const loginTarget = async (nextUrl) =>
  (await setupRequired()) ? '/setup' : '/login.html?next=' + encodeURIComponent(nextUrl);

// Express middleware
export const requireAuth = async (req, res, next) => {
  if (isPublic(req.path)) return next();
  const session = readSessionCookie(req.headers.cookie);
  if (!session) {
    if (wantsHtml(req)) return res.redirect(await loginTarget(req.originalUrl));
    const needsSetup = await setupRequired();
    return res.status(401).json(needsSetup
      ? { error: 'No user exists yet — open /setup', setupRequired: true }
      : { error: 'Not authenticated' });
  }
  req.user = { username: session.u, email: session.e };
  next();
};

// Raw-Node version, for routers that don't run inside Express (the feed
// router under /feed/* is a plain http handler). Resolves to the user object
// on success, otherwise sends the response and resolves to null.
export const requireAuthRaw = async (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (isPublic(url)) return { __public: true };
  const session = readSessionCookie(req.headers.cookie);
  if (!session) {
    if ((req.headers.accept || '').includes('text/html') && req.method === 'GET') {
      res.writeHead(302, { Location: await loginTarget(req.url) });
      res.end();
    } else {
      const needsSetup = await setupRequired();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(needsSetup
        ? { error: 'No user exists yet — open /setup', setupRequired: true }
        : { error: 'Not authenticated' }));
    }
    return null;
  }
  return { username: session.u, email: session.e };
};
