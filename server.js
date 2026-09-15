/**
 * Resume Forge Web Server
 *
 * Wraps the tailoring pipeline, the apply tracker, the feed and the mail
 * tools into one HTTP server for one operator. Identity for every request is
 * the session cookie, else the database's sole user (services/users/current.js)
 * — never a query parameter.
 */

import express from 'express';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve as resolvePath, sep as pathSep, basename } from 'path';
import config from './config.js';
import { validateJobDescription } from './services/clipboard.js';
import { cleanupDocx, checkLibreOffice } from './services/pipeline/converter.js';
import { renderResume, htmlRendererAvailable } from './services/pipeline/render-resume.js';
import { generateEmail, generateLinkedInDM } from './services/outreach/email-generator.js';
import { saveLinkedInDM, saveEmailData, getAllEmailContacts, updateEmailStatus, getUnsentEmails, markEmailAsSent, saveResumeForContact } from './services/outreach/contact-logger.js';
import { pushTailorEmail } from './services/feed/posts-store.js';
import { sendEmail, verifyConnection } from './services/outreach/email-sender.js';
import { getProvider, listProviders } from './services/providers/registry.js';
import { transportInfo, activeTransport } from './services/providers/bedrock-transport.js';
import { resumeRoots, listCompanies, retireResume, reorderCompanies, retireForJob, reconcile as reconcileOutbox } from './services/apply/resume-outbox.js';
import { startBatch, getRun, latestRun, pendingWithoutResume, resultsByJobId, variantContent } from './services/apply/tailor-batch.js';
import { validateResumeData, validateFeedResumeData } from './services/resume-validator.js';
import {
  getUser,
  saveVariant,
  saveTailorData,
  saveFeedData,
  getFeedResume,
  getResumeHistoryMeta,
  restoreFromHistory,
  saveSharedScalars,
  SHARED_SCALARS,
  listVariants,
} from './services/resume-store.js';
import { col, dbIdentity, LOGS_DIR } from './services/db.js';
import { contentDisposition } from './services/content-disposition.js';
import { Binary } from 'mongodb';
import { feedHandler, invalidateFeedCandidate } from './scripts/feed/dashboard-server.js';
import { detectAndParse } from './services/apply/parsers.js';
import {
  STATUSES as APPLY_STATUSES,
  getUsersAndCounts,
  getStats as getApplyStats,
  listJobs,
  countJobs,
  upsertJobFromParse,
  updateUserStatus,
  findMissingLiCountJobs,
  findLowScoreJobs,
  backfillCompanyDetailsFromPeers,
  clearScannerData,
} from './services/apply/job-store.js';
import clipboardyDefault from 'clipboardy';
const clipboard = clipboardyDefault.default || clipboardyDefault;
import { login, createUser, issueSessionCookie, sessionCookieString, readSessionCookie, verifyCurrentPassword, setUserPassword, setUserEmail, findUserByEmail } from './services/auth/auth-store.js';
import { requireAuth, requireAuthRaw, setSetupCheck } from './services/auth/middleware.js';
import { getEmailConfig, setEmailConfig, getDailyReminders, setDailyReminders } from './services/resume-store.js';
// {{exp}} substitution shared with /api/ext/* — single cache + format.
import { resolveExpInItems, yearsOfExperienceFor } from './services/users/experience.js';
import { resolveUsername, requireUsername, listUsernames, userStateSummary } from './services/users/current.js';
import { loadCandidate } from './services/feed/feed-config.js';
import { analyzeJob } from './services/scanner/index.js';
import extRouter from './services/ext-api/router.js';
import peersRouter from './services/peers/routes.js';
import { startPeerSync, stopPeerSync } from './services/peers/peer-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// The operator for a request: the session cookie, else the database's sole
// user (bearer-token CLI calls carry no cookie). Never a query parameter —
// there is one user per database, so there is nobody else to act as.
// `requireUsername` is the same lookup but answers the request with a 400
// naming the reason (no user yet / several users) when nothing resolves.
const sessionUser = (req) => resolveUsername(req);

// First run: with no user in the database, unauthenticated HTML requests go
// to /setup instead of /login. Cached in current.js; createUser() busts it.
setSetupCheck(async () => (await listUsernames()).length === 0);

// ── Request logger ──────────────────────────────────────────────────────
// One log line per request, emitted on `response:finish` so we get the
// final status + duration. Skips static asset noise. Sits BEFORE the auth
// gate so 401s are still recorded.
import { log } from './services/log.js';
const STATIC_RE = /\.(css|js|svg|png|jpe?g|ico|woff2?|map)$/;
app.use((req, res, next) => {
  if (STATIC_RE.test(req.path)) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    const sess = readSessionCookie(req.headers.cookie);
    const who  = sess?.u || '-';
    const dur  = Date.now() - t0;
    const lvl  = res.statusCode >= 500 ? 'err'
               : res.statusCode >= 400 ? 'warn'
               : 'info';
    log[lvl]('http', `${req.method} ${req.originalUrl} ${res.statusCode} ${dur}ms user=${who}`);
  });
  next();
});

// ── Public auth endpoints (no auth required) ──
// JSON parsing for these only; the global json() middleware comes after the
// feed mount (which needs raw bodies for PDF upload).
const jsonParser = express.json({ limit: '64kb' });

app.post('/api/login', jsonParser, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email + password required' });
    // Nobody to sign in as yet — the login page bounces to /setup on this.
    if (!(await listUsernames()).length) {
      return res.status(409).json({ error: 'No user exists yet — complete first-run setup', setupRequired: true });
    }
    const r = await login({ email, password });
    if (!r.ok) {
      log.warn('auth:login', `failed for ${email}: ${r.error}`);
      return res.status(401).json({ error: r.error });
    }
    const token = issueSessionCookie(r.user);
    res.setHeader('Set-Cookie', sessionCookieString(token));
    log.ok('auth:login', `${r.user.username} (${email})`);
    res.json({ ok: true, user: r.user });
  } catch (e) {
    log.err('auth:login', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', sessionCookieString('', { clear: true }));
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const s = readSessionCookie(req.headers.cookie);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: { username: s.u, email: s.e } });
});

// ── First-run setup (public) ──
// A fresh database has no user, so there is nothing to log in as. /setup
// creates the one user and signs them in; once a user exists the POST is a
// 409 and the page is just a link back to /login. The auth middleware
// whitelists these paths and redirects HTML requests here while
// setupRequired is true.
app.get('/api/setup', async (_req, res) => {
  try {
    res.json({ setupRequired: (await listUsernames({ fresh: true })).length === 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One setup at a time. The check ("no user yet") and the insert are not one
// atomic operation, and only `username` is unique, so two submissions in
// flight together would both pass the check and create two different users
// — after which nothing cookie-less can resolve the sole user. Serialising
// the handler in-process makes the second request see the first's insert.
// createUser() re-counts after its own insert as the last line of defence.
const SETUP_DONE = 'Setup is already complete — a user exists. Sign in instead.';
let _setupChain = Promise.resolve();
const handleSetup = async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if ((await listUsernames({ fresh: true })).length) {
      return res.status(409).json({ error: SETUP_DONE });
    }
    const user = await createUser({ username, email, password });
    const token = issueSessionCookie({ username: user.username, email: user.email });
    res.setHeader('Set-Cookie', sessionCookieString(token));
    log.ok('auth:setup', `created user "${user.username}" (${user.email})`);
    res.json({ ok: true, user: { username: user.username, email: user.email } });
  } catch (e) {
    log.warn('auth:setup', e.message);
    // The "already has a user" errors name the existing account; an
    // unauthenticated caller gets the generic line instead.
    if (e.code === 'user-exists') return res.status(409).json({ error: SETUP_DONE });
    res.status(400).json({ error: e.message.replace(/^createUser: /, '') });
  }
};
app.post('/api/setup', jsonParser, (req, res) => {
  _setupChain = _setupChain.then(() => handleSetup(req, res)).catch(() => {});
});

app.get(['/setup', '/setup.html'], (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'setup.html')),
);

// SSE channel for live mirror updates. Browser opens an EventSource, gets
// a `data: {collection, type, ...}` line every time something in the
// mirror changes — a local write (same process, instant), a peer import
// landing from the 30 s sync loop, or a CLI / extension write picked up by
// the 15 s delta sync. The UI uses this to auto-refetch the active view
// instead of polling on a timer or requiring a manual reload.
app.get('/api/events', (req, res) => {
  const s = readSessionCookie(req.headers.cookie);
  if (!s) return res.status(401).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const mirrors = [
    ['job_tracker',           jobTrackerMirror],
    ['user_emails',           userEmailsMirror],
    ['posts',                 postsMirror],
    ['connections',           connectionsMirror],
    ['user_connects',         connectsMirror],
    ['user_inbox',            inboxMirror],
    ['high_salary_companies', highSalaryMirror],
  ];
  const send = (collection) => (event) => {
    res.write(`data: ${JSON.stringify({ collection, ...event })}\n\n`);
  };
  const unsubs = mirrors.map(([name, m]) => m.subscribe(send(name)));
  // Heartbeat — keeps proxies / load balancers from dropping idle
  // SSE connections after their (usually 60s) timeout.
  const hb = setInterval(() => res.write(': hb\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(hb);
    for (const u of unsubs) u();
  });
});

// =========================================================================
// SETTINGS — current user only. requireAuth runs before these via the
// global gate further down, but each handler also sanity-checks req.user.
// =========================================================================

// GET /api/settings — { account: { email, username }, smtp: { host, port, ... } }
app.get('/api/settings', jsonParser, async (req, res) => {
  const s = readSessionCookie(req.headers.cookie);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const [emailCfg, dailyReminders] = await Promise.all([
      getEmailConfig(s.u),
      getDailyReminders(s.u),
    ]);
    res.json({
      account: { username: s.u, email: s.e },
      smtp: emailCfg ? { ...emailCfg, smtp: { ...emailCfg.smtp, pass: '' } } : null,
      // Returning a stripped emailConfig (no pass). Saving with empty pass
      // means "keep existing", set on PUT below.
      dailyReminderUrls: dailyReminders,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings/daily-reminders — { urls: string[] }
// Per-user list of URLs the apply page pops on the first refresh-click
// each day. Server validates protocol + URL shape and rejects the whole
// payload on any invalid entry (no partial save). Empty array clears the
// list, which disables the apply-page checkbox.
app.put('/api/settings/daily-reminders', jsonParser, async (req, res) => {
  const s = readSessionCookie(req.headers.cookie);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const next = await setDailyReminders(s.u, Array.isArray(req.body?.urls) ? req.body.urls : []);
    log.ok('settings:daily-reminders', `${s.u} count=${next.length}`);
    res.json({ ok: true, dailyReminderUrls: next });
  } catch (e) {
    log.warn('settings:daily-reminders', `${s.u}: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/settings/email — change login email
app.put('/api/settings/email', jsonParser, async (req, res) => {
  const s = readSessionCookie(req.headers.cookie);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  const next = String(req.body?.email || '').trim().toLowerCase();
  if (!next || !/^.+@.+\..+$/.test(next)) return res.status(400).json({ error: 'Valid email required' });
  // One user per database, but a stale second doc must still not end up
  // sharing a login email with this one.
  const clash = await findUserByEmail(next);
  if (clash && clash.username !== s.u) return res.status(409).json({ error: 'Email already in use by another account' });
  try {
    await setUserEmail(s.u, next);
    log.ok('settings:email', `${s.u} → ${next}`);
    // Re-issue cookie so subsequent /api/me reflects the new email.
    const token = issueSessionCookie({ username: s.u, auth: { email: next } });
    res.setHeader('Set-Cookie', sessionCookieString(token));
    res.json({ ok: true, email: next });
  } catch (e) {
    log.err('settings:email', `${s.u}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings/password — { currentPassword, newPassword }
app.put('/api/settings/password', jsonParser, async (req, res) => {
  const s = readSessionCookie(req.headers.cookie);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword + newPassword required' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  try {
    const ok = await verifyCurrentPassword(s.u, currentPassword);
    if (!ok) {
      log.warn('settings:password', `${s.u}: current password incorrect`);
      return res.status(401).json({ error: 'Current password incorrect' });
    }
    await setUserPassword(s.u, newPassword);
    log.ok('settings:password', `${s.u} rotated`);
    res.json({ ok: true });
  } catch (e) {
    log.err('settings:password', `${s.u}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings/smtp — { fromName, smtp: { host, port, secure, user, pass } }
// Empty `smtp.pass` means "leave existing password unchanged".
app.put('/api/settings/smtp', jsonParser, async (req, res) => {
  const s = readSessionCookie(req.headers.cookie);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const body = req.body || {};
    const incoming = body.smtp || {};
    // Preserve existing password if the form left it blank.
    const preserved = !incoming.pass;
    if (preserved) {
      const prev = await getEmailConfig(s.u);
      if (prev?.smtp?.pass) incoming.pass = prev.smtp.pass;
    }
    const next = await setEmailConfig(s.u, { fromName: body.fromName, smtp: incoming });
    log.ok('settings:smtp', `${s.u} host=${incoming.host} port=${incoming.port} secure=${!!incoming.secure} user=${incoming.user} pass=${preserved ? 'kept' : 'updated'}`);
    res.json({ ok: true, smtp: { ...next, smtp: { ...next.smtp, pass: '' } } });
  } catch (e) {
    log.err('settings:smtp', `${s.u}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/settings', (_req, res) => res.sendFile(join(__dirname, 'public', 'settings.html')));

// =========================================================================
// EXTENSION API — /api/ext/*
//
// Mounted BEFORE the auth gate so the browser extension can POST scanned
// jobs, fetch cached analyses, upload connections, etc. without requiring
// the same browser to be logged into tailor. Where an endpoint needs to know
// the user (applied badges, connection ownership, the candidate profile for
// analysis) the router resolves it the same way as everything else: session
// cookie if the browser has one, else the database's sole user.
//
// CORS: we echo any localhost / extension / known job-board origin back,
// with credentials enabled, so the extension's fetch(credentials:'include')
// works from content scripts running on linkedin.com / naukri.com / etc.
// The endpoints themselves are read/write to the tailor's mongo, so the
// "no-auth" stance is fine for a single-user-machine setup but should be
// hardened (e.g. an API key) before exposing the server publicly.
// =========================================================================
const ALLOW_ORIGIN_RE = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?|chrome-extension:\/\/[a-z0-9]+|https?:\/\/(?:www\.)?(?:linkedin\.com|naukri\.com|indeed\.com|wellfound\.com|instahyre\.com|cutshort\.io|hirist\.com))$/i;
const extCors = (req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOW_ORIGIN_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  // Chrome's Private Network Access (PNA): HTTPS pages on the public internet
  // (linkedin.com, naukri.com) are blocked from fetching localhost by default.
  // Servers opt in by setting this header on both preflight and the actual
  // response. Without it the content-script's fetch throws "Failed to fetch"
  // before the request ever leaves the browser — the popup context is exempt
  // so it still works, which is why the symptom is so confusing.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
// Scanner /analyze posts jobText + debug HTML; /scan-capture and /feed-capture
// post whole-page outerHTML snapshots (a content-search page with 100+ cards can
// run 5-15MB). This is just a request-body guard, not a memory limit — bumped
// high so big HTML snapshots aren't 413'd before the parser sees them.
const extJson = express.json({ limit: '100mb' });
app.use('/api/ext', extCors, extJson, extRouter);

// Public assets needed BEFORE the auth gate (the login page itself).
app.get(['/login', '/login.html'], (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'login.html')),
);

// ── Auth gate — everything below requires a valid session ──
// Feed mount (mounted as raw http handler) gets its own check via requireAuthRaw
// in the wrapper. Express routes inherit `requireAuth`.
app.use((req, res, next) => {
  if (req.path === '/api/login' || req.path === '/api/logout' || req.path === '/api/me' || req.path === '/api/setup') return next();
  // /api/ext/* already handled above (mounted before the gate). Belt-and-braces
  // in case the router's mount path ever changes — keep the gate quiet for it.
  if (req.path.startsWith('/api/ext/')) return next();
  return requireAuth(req, res, next);
});

// Feed mount — auth check before delegating to the raw-http handler.
// Must come BEFORE express.json so feedHandler can read raw bodies for PDF upload.
app.get('/feed', (_req, res) => res.sendFile(join(__dirname, 'public', 'feed.html')));
// /posts is the shared post pool view. Same HTML as /feed (it auto-detects the
// URL and renders the posts slice) so the two routes share a single client.
app.get('/posts', (_req, res) => res.sendFile(join(__dirname, 'public', 'feed.html')));
// Connection-request queue — the outreach path for posts with no email address.
// Its own page rather than a third feed.html view: the flow is a per-person
// state machine, not a filtered list of posts.
app.get('/connects', (_req, res) => res.sendFile(join(__dirname, 'public', 'connects.html')));

// Mail — fetched job mail routed into replies / tasks / review, plus a composer.
app.get('/mail', (_req, res) => res.sendFile(join(__dirname, 'public', 'mail.html')));
app.use('/feed', async (req, res, next) => {
  const u = await requireAuthRaw(req, res);
  if (u === null) return; // response already sent
  req.user = u;
  return feedHandler(req, res, next);
});

app.use(express.json({ limit: '1mb' }));

// Peer job sources — other people's databases whose already-analyzed jobs
// are pulled into this one as pending rows (services/peers/). Behind the
// gate and after the body parser, so the router needs neither of its own.
app.use('/api/settings/peers', peersRouter);

app.use(express.static(join(__dirname, 'public'), { index: 'index.html' }));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// =========================================================================
// =========================================================================
// RESUME v2 — tailor + feed JSONs with paste-to-replace, schema validation,
// and a 5-deep history ring per JSON. Shared scalars (name/email/phone/...)
// update BOTH JSONs at once.
// =========================================================================

// GET /api/resume — tailor + feed + sharedScalars + history meta.
app.get('/api/resume', async (req, res) => {
  try {
    const user = await requireUsername(req, res);
    if (!user) return;
    const [doc, feedDoc, history] = await Promise.all([
      getUser(user),
      getFeedResume(user),
      getResumeHistoryMeta(user),
    ]);
    if (!doc && !feedDoc) return res.status(404).json({ error: `No resume for "${user}"` });
    const tailor = doc?.data || null;
    const feed   = feedDoc?.data || null;
    const pInfo  = tailor?.personalInfo || {};
    const fInfo  = feed?.personalInfo   || {};
    const shared = {};
    for (const k of SHARED_SCALARS) shared[k] = pInfo[k] ?? fInfo[k] ?? '';
    res.json({
      username: user,
      tailor,
      feed,
      shared,
      history,
      pdf: doc?.pdf ? {
        filename: doc.pdf.filename,
        contentType: doc.pdf.contentType,
        size: doc.pdf.size,
        updatedAt: doc.pdf.updatedAt,
      } : null,
      updatedAt: doc?.updatedAt || feedDoc?.updatedAt || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/resume/tailor — replace tailor JSON (validated).
app.put('/api/resume/tailor', jsonParser, async (req, res) => {
  try {
    const user = await requireUsername(req, res);
    if (!user) return;
    const body = req.body;
    const check = validateResumeData(body);
    if (!check.valid) {
      log.warn('resume:tailor', `validation failed for ${user}: ${check.errors.slice(0,3).join(' | ')}`);
      return res.status(400).json({ error: 'Schema invalid', validation: check });
    }
    const r = await saveTailorData(user, body, user);
    invalidateFeedCandidate(user);
    log.ok('resume:tailor', `saved for ${user} warnings=${check.warnings.length}`);
    res.json({ ok: true, ...r, warnings: check.warnings, summary: check.summary });
  } catch (e) {
    log.err('resume:tailor', `${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/resume/feed — replace feed JSON (validated).
app.put('/api/resume/feed', jsonParser, async (req, res) => {
  try {
    const user = await requireUsername(req, res);
    if (!user) return;
    const body = req.body;
    const check = validateFeedResumeData(body);
    if (!check.valid) {
      log.warn('resume:feed', `validation failed for ${user}: ${check.errors.slice(0,3).join(' | ')}`);
      return res.status(400).json({ error: 'Schema invalid', validation: check });
    }
    const r = await saveFeedData(user, body, user);
    invalidateFeedCandidate(user);
    log.ok('resume:feed', `saved for ${user} warnings=${check.warnings.length}`);
    res.json({ ok: true, ...r, warnings: check.warnings, summary: check.summary });
  } catch (e) {
    log.err('resume:feed', `${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/resume/shared — patch shared scalars in BOTH JSONs.
app.put('/api/resume/shared', jsonParser, async (req, res) => {
  try {
    const user = await requireUsername(req, res);
    if (!user) return;
    const r = await saveSharedScalars(user, req.body || {});
    invalidateFeedCandidate(user);
    log.ok('resume:shared', `updated ${user}: ${Object.keys(r.updated || {}).join(',') || '(no fields)'}`);
    res.json({ ok: true, ...r });
  } catch (e) {
    log.err('resume:shared', `${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/resume/restore { which: 'tailor'|'feed', index: 0..4 }
app.post('/api/resume/restore', jsonParser, async (req, res) => {
  try {
    const user = await requireUsername(req, res);
    if (!user) return;
    const which = req.body?.which;
    const index = parseInt(req.body?.index, 10);
    if (!['tailor', 'feed'].includes(which)) return res.status(400).json({ error: 'which must be "tailor" or "feed"' });
    if (Number.isNaN(index)) return res.status(400).json({ error: 'index required' });
    const r = await restoreFromHistory(user, which, index, user);
    invalidateFeedCandidate(user);
    log.ok('resume:restore', `${which} #${index} restored for ${user}`);
    res.json({ ok: true, ...r });
  } catch (e) {
    log.err('resume:restore', `${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

// =========================================================================
// APPLY — job-application tracker
// =========================================================================

// GET /api/apply/users — the user + their status counts. The one-element
// `users` array and per-username `counts` map are the shape apply.html
// already reads; there is exactly one entry.
app.get('/api/apply/users', async (req, res) => {
  try {
    const me = await requireUsername(req, res);
    if (!me) return;
    const data = await getUsersAndCounts({ username: me });
    res.json({
      ...data,
      statuses: APPLY_STATUSES,
      currentUser: me,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/apply/stats?platform=&q= — real per-status counts for the user,
// computed against the whole collection (not the visible page).
app.get('/api/apply/stats', async (req, res) => {
  try {
    const me = await requireUsername(req, res);
    if (!me) return;
    const stats = await getApplyStats({
      user: me,
      platform: req.query.platform,
      q: req.query.q,
    });
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/apply/jobs?status=&q=&platform=&verdict=&sort=&limit=&skip=
// Every row belongs to the user, so the scope is derived from the session:
//   pending          → the triage queue: rows the user has neither applied
//                      to nor rejected (user=null, statusUser=me)
//   rejected         → row-level, rowStatus='rejected'
//   applied / interviewing / success, or no status
//                    → the applied pipeline: users.<me>.applied=true, then
//                      narrowed to that status when one is given
// See listJobs in services/apply/job-store.js for why the two scopes must
// not be combined.
app.get('/api/apply/jobs', async (req, res) => {
  // One-shot timing probe so we can see exactly where time is going on
  // slow requests. Logs only when total > 800ms.
  const tStart = Date.now();
  const marks = [];
  const mark = (label) => marks.push([label, Date.now() - tStart]);
  try {
    const me = await requireUsername(req, res);
    if (!me) return;
    mark('sessionUser');
    const status = req.query.status ? String(req.query.status) : undefined;
    const listParams = {
      user: status === 'pending' ? null : me,
      statusUser: me,
      status,
      q: req.query.q,
      platform: req.query.platform,
      verdict: req.query.verdict,
      sort: req.query.sort,
      limit: req.query.limit,
      skip: req.query.skip,
      hasContact: req.query.hasContact === '1' || req.query.hasContact === 'true',
    };
    const [items, totalMatching] = await Promise.all([
      listJobs(listParams).then(r => { mark('listJobs'); return r; }),
      countJobs(listParams).then(r => { mark('countJobs'); return r; }),
    ]);

    if (req.query.includeRefs && items.length) {
      const { getMatchesForJobs, getSeenAtByJob } = await import('./services/connections/store.js');
      const links = items.map(j => j.jobLink).filter(Boolean);
      // Run seenAt + matches in parallel — they don't depend on each other
      // until the final merge.
      const [seenAtByJob, matches] = await Promise.all([
        getSeenAtByJob({ owner: me, jobLinks: links }).then(r => { mark('seenAt'); return r; }),
        getMatchesForJobs({ jobs: items, owner: me }).then(r => { mark('matches'); return r; }),
      ]);
      // Layer isNew flag from seenAt on top of cached matches.
      for (const j of items) {
        const hits = matches.get(j.jobLink) || [];
        const seenMs = seenAtByJob.get(j.jobLink)
          ? new Date(seenAtByJob.get(j.jobLink)).getTime() : 0;
        j.matchingConnects = hits.map(h => ({ ...h, isNew: (h.firstSeenMs || 0) > seenMs }));
      }
      mark('mergeRefs');
    }
    // Resolve {{exp}} on each row's connectNote — so apply.html's data-note
    // attribute is paste-ready and the extension's piggyback stash carries
    // the years filled in. {{name}} is left as-is here; the modal observer
    // fills it on the LinkedIn side from the recipient.
    await resolveExpInItems(items, me); mark('resolveExp');
    res.json({
      currentUser: me,
      statuses: APPLY_STATUSES,
      items,
      totalMatching,
    });
    const total = Date.now() - tStart;
    if (total > 800) {
      log.warn('apply:jobs', `slow ${total}ms status=${req.query.status||'-'} marks=${marks.map(([l, t]) => `${l}:${t}`).join(' ')}`);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/apply/parse — read clipboard, parse, upsert each job for the user.
// Body (optional): { content?: string }. If `content` is given we use that
// directly (handy when the browser's own clipboard is unavailable); otherwise
// we read the server-side clipboard (works on the local dev box).
app.post('/api/apply/parse', async (req, res) => {
  try {
    const user = await requireUsername(req, res);
    if (!user) return;
    log.info('apply:parse', `start user=${user} bodyContent=${req.body?.content ? 'inline' : 'clipboard-read'}`);
    let raw = req.body?.content;
    if (!raw) {
      try { raw = await clipboard.read(); }
      catch (err) {
        log.err('apply:parse', `clipboard read failed: ${err.message}`);
        return res.status(500).json({ error: `Clipboard read failed: ${err.message}` });
      }
    }
    const parsed = detectAndParse(raw);
    if (parsed.error) {
      log.warn('apply:parse', `rejected — ${parsed.error}`);
      return res.status(400).json({ error: parsed.error });
    }
    log.ok('apply:parse', `format=${parsed.format} jobs=${parsed.jobs.length}`);

    const results = [];
    for (const job of parsed.jobs) {
      try {
        const r = await upsertJobFromParse({ user, parsedJob: job });
        results.push({ ok: true, link: job.link, ...r });
      } catch (err) {
        log.err('apply:parse', `upsert failed for ${job.link}: ${err.message}`);
        results.push({ ok: false, link: job.link, error: err.message });
      }
    }
    const inserted = results.filter(r => r.ok && r.upserted).length;
    const refreshed = results.filter(r => r.ok && !r.upserted).length;
    log.ok('apply:parse', `done user=${user} inserted=${inserted} refreshed=${refreshed}`);
    res.json({
      user,
      format: parsed.format,
      total: parsed.jobs.length,
      inserted,
      refreshed,
      results,
    });
  } catch (e) {
    log.err('apply:parse', `unhandled: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/apply/jobs?jobLink= — update the row's status / feedback / notes
app.put('/api/apply/jobs', async (req, res) => {
  try {
    const user = await requireUsername(req, res);
    if (!user) return;
    const jobLink = (req.query.jobLink || req.body?.jobLink || '').trim();
    if (!jobLink) return res.status(400).json({ error: 'jobLink required' });
    const patch = {
      status:    req.body?.status,
      feedback:  req.body?.feedback,
      notes:     req.body?.notes,
      applied:   req.body?.applied,
      interviewDates: req.body?.interviewDates,
    };
    const doc = await updateUserStatus({ user, jobLink, patch });
    const changed = Object.entries(patch).filter(([_, v]) => v !== undefined).map(([k]) => k).join(',');
    log.ok('apply:status', `user=${user} ${jobLink} → {${changed}} status=${patch.status || '(no-change)'}`);
    // The tailored resume for this job is now spent (TEMPORARY — ATS experiment).
    const outbox = retireForJob(doc, patch.status);
    if (outbox?.removedFiles.length || outbox?.removedDirs.length) {
      log.info('outbox:retire', `${doc.company} / ${doc.title} — ${outbox.removedFiles.length} file(s), ${outbox.removedDirs.length} dir(s)`);
    }
    res.json({ ok: true, doc, outbox });
  } catch (e) {
    log.err('apply:status', `${req.query.jobLink || ''}: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

// Per-jobLink mark-seen for the inline refs popover on apply.html.
// Opening the popover stamps "seen" so the NEW dot on the refs pill clears
// next render. Keyed by owner because the connections store is.
app.post('/api/apply/connections/mark-seen', jsonParser, async (req, res) => {
  try {
    const owner = await requireUsername(req, res);
    if (!owner) return;
    const jobLink = (req.body?.jobLink || '').trim();
    if (!jobLink) return res.status(400).json({ error: 'jobLink required' });
    const { markJobConnectsSeen } = await import('./services/connections/store.js');
    const out = await markJobConnectsSeen({ owner, jobLink });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// LinkedIn-only rows whose scan completed (verdict present) but where the
// "employees on LinkedIn" count is missing — these were almost certainly
// scraped before the page finished rendering and benefit from a re-visit.
// Returns { count, jobLinks: [{jobLink, jobId, company, title},...] }.
// Wipe scanner-derived fields (verdict, score, summary, companyDetails,
// jobText, etc.) on the listed jobLinks so the next page-visit triggers a
// completely fresh AI re-analysis — no chance of returning a stale row.
// Called by the apply page's "Rescan ..." buttons RIGHT BEFORE opening
// the tabs, so by the time LinkedIn finishes loading and the extension
// POSTs /analyze, the row has nothing to short-circuit on.
app.post('/api/apply/jobs/clear-scan', jsonParser, async (req, res) => {
  try {
    const jobLinks = Array.isArray(req.body?.jobLinks) ? req.body.jobLinks : [];
    if (!jobLinks.length) return res.status(400).json({ error: 'jobLinks[] required' });
    const out = await clearScannerData({ jobLinks });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/apply/jobs/reanalyze { jobLinks: string[] } — run the user's own
// scanner analysis over rows that already hold a JD, without a browser tab.
// The main customer is a row imported from a peer: its verdict / score were
// computed against the peer's resume, so they are a hint until this
// replaces them (upsertScannedJob clears importedFrom). Also useful after a
// resume change. Rows with too little jobText are reported, not re-scraped
// — that still needs the extension.
const REANALYZE_MAX = 50;
const REANALYZE_CONCURRENCY = 4;
const REANALYZE_MIN_CHARS = 200;
app.post('/api/apply/jobs/reanalyze', jsonParser, async (req, res) => {
  const me = await requireUsername(req, res);
  if (!me) return;
  const raw = Array.isArray(req.body?.jobLinks) ? req.body.jobLinks : [];
  const links = [...new Set(raw.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim()))];
  if (!links.length) return res.status(400).json({ error: 'jobLinks[] required' });
  if (links.length > REANALYZE_MAX) return res.status(400).json({ error: `at most ${REANALYZE_MAX} jobLinks per call` });
  try {
    // The candidate section of the prompt is what makes the verdict the
    // user's own; without a resume the scanner still runs, just generically.
    const candidate = await loadCandidate(me).catch((e) => {
      log.warn('apply:reanalyze', `no candidate profile for ${me} (${e.message}) — analyzing without one`);
      return null;
    });
    // Mirror rows are hydrated without jobText, so read the JD from Mongo —
    // one round-trip for the whole batch.
    const c = await col('job_tracker');
    const rows = await c.find(
      { jobLink: { $in: links } },
      { projection: {
        jobLink: 1, jobId: 1, jobText: 1, title: 1, company: 1, pageTitle: 1,
        companyDetails: 1, posted_date: 1, connectNote: 1,
        jobType: 1, workMode: 1, easyApply: 1, applicantsCount: 1, applicantsNumeric: 1,
      } },
    ).toArray();
    const byLink = new Map(rows.map((r) => [r.jobLink, r]));

    const results = new Array(links.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < links.length) {
        const i = cursor++;
        const jobLink = links[i];
        const fail = (error) => { results[i] = { jobLink, ok: false, verdict: null, score: null, error }; };
        const row = byLink.get(jobLink);
        if (!row) { fail('not in the tracker'); continue; }
        const text = String(row.jobText || '').trim();
        if (text.length < REANALYZE_MIN_CHARS) {
          fail(`jobText too short (${text.length} chars) — open the job so the extension can rescan it`);
          continue;
        }
        try {
          const cd = row.companyDetails || {};
          const { analysis } = await analyzeJob({
            jobText: text,
            pageUrl: row.jobLink,
            pageTitle: row.pageTitle || row.title || '',
            jobId: row.jobId,
            companyInfo: {
              companyName: row.company,
              employeeCount: cd.employeeCount,
              employeesOnLinkedIn: cd.employeesOnLinkedIn,
              followers: cd.followers,
              industry: cd.industry,
              listed: cd.listed,
              companyLinkedIn: cd.companyLinkedIn,
              companyDescription: cd.description,
            },
            jobType: row.jobType,
            workMode: row.workMode,
            easyApply: row.easyApply,
            applicantsCount: row.applicantsCount,
            applicantsNumeric: row.applicantsNumeric,
            candidate,
            // The JD's "posted 3 days ago" is relative to when it was scraped,
            // not to now — anchor it so posted_date doesn't drift on re-runs.
            // A row that already carries a referral note keeps it (one model
            // call saved); imported rows never carry one, so they get theirs.
            opts: { referencePostedAt: row.posted_date || null, skipConnectNote: !!row.connectNote },
          });
          results[i] = {
            jobLink, ok: true,
            verdict: analysis?.verdict ?? null,
            score: Number.isFinite(analysis?.score) ? analysis.score : null,
            error: null,
          };
        } catch (e) {
          fail(e.message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(REANALYZE_CONCURRENCY, links.length) }, worker));
    const ok = results.filter((r) => r.ok).length;
    log.ok('apply:reanalyze', `user=${me} ok=${ok} failed=${results.length - ok}`);
    res.json({ results });
  } catch (e) {
    log.err('apply:reanalyze', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/apply/jobs/missing-li-count', async (req, res) => {
  const me = await requireUsername(req, res);
  if (!me) return;
  try {
    const out = await findMissingLiCountJobs({
      limit: req.query.limit,
      statusUser: me,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backfill the LinkedIn employee count from a same-company row we already
// scraped, instead of re-opening a browser tab for it. The Rescan button
// hits this FIRST; only the rows that come back in `remainingJobLinks` (no
// peer to copy from) actually need a live re-scrape. Pass { jobLinks } to
// scope it to exactly the rows a click is about to rescan; omit for the whole
// missing-LI set.
// Jobs the scanner scored at/below `maxScore` (default 1). A 1 is usually a
// page whose JD hadn't rendered when the scanner ran, so `jobTextLen` comes
// back with each row to separate "scrape failed" from "genuinely a bad match".
app.get('/api/apply/jobs/low-score', async (req, res) => {
  const me = await requireUsername(req, res);
  if (!me) return;
  try {
    const out = await findLowScoreJobs({
      maxScore: req.query.maxScore ?? 1,
      statusUser: me,
      limit: req.query.limit,
    });
    res.json(out);
  } catch (e) {
    log.err('apply:low-score', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/apply/jobs/backfill-li-count', jsonParser, async (req, res) => {
  const me = await requireUsername(req, res);
  if (!me) return;
  try {
    const jobLinks = Array.isArray(req.body?.jobLinks) ? req.body.jobLinks : null;
    const scope = req.body?.scope === 'all' ? 'all' : 'missingLi';
    const out = await backfillCompanyDetailsFromPeers({ jobLinks, scope, statusUser: me });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Resume outbox (TEMPORARY — ATS experiment) ───────────────────────────
// Housekeeping for the per-company tailored resumes in ~/Downloads. See
// services/apply/resume-outbox.js for the containment rules.

app.get('/api/apply/resume-outbox', (_req, res) => {
  try {
    res.json({ roots: resumeRoots(), companies: listCompanies().map(c => ({ folder: c.folder, company: c.company, resumes: c.resumes })) });
  } catch (e) {
    log.err('outbox:list', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Fired after an Apply/Reject — the resume for that job is now spent.
app.post('/api/apply/resume-outbox/retire', jsonParser, (req, res) => {
  const { company, role } = req.body || {};
  if (!company) return res.status(400).json({ error: 'company required' });
  try {
    const out = retireResume({ company, role });
    if (out.removedFiles.length || out.removedDirs.length) {
      log.info('outbox:retire', `${company}${role ? ` / ${role}` : ''} — ${out.removedFiles.length} file(s), ${out.removedDirs.length} dir(s)`);
    }
    res.json(out);
  } catch (e) {
    log.err('outbox:retire', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Number the company folders to match the queue's current sort order.
app.post('/api/apply/resume-outbox/reorder', jsonParser, (req, res) => {
  const companies = Array.isArray(req.body?.companies) ? req.body.companies : null;
  if (!companies) return res.status(400).json({ error: 'companies array required' });
  try {
    const out = reorderCompanies(companies);
    log.info('outbox:reorder', `${out.renamed.length} folder(s) renamed`);
    res.json(out);
  } catch (e) {
    log.err('outbox:reorder', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Catch-up sweep: drop resumes for jobs that are no longer pending. Needed
// because status changes made before the server-side hook existed (or from
// any other client) left their resumes behind.
app.post('/api/apply/resume-outbox/reconcile', jsonParser, async (req, res) => {
  try {
    const user = await requireUsername(req, res);
    if (!user) return;
    const rows = await listJobs({ user: null, statusUser: user, status: 'pending', limit: 1000 });
    const pending = (Array.isArray(rows) ? rows : rows.rows || []).map((j) => ({ company: j.company, title: j.title }));
    const out = reconcileOutbox(pending, resumeRoots());
    log.info('outbox:reconcile', `${pending.length} pending job(s) kept; removed ${out.removedFiles.length} file(s), ${out.removedDirs.length} dir(s)`);
    res.json({ pendingJobs: pending.length, ...out });
  } catch (e) {
    log.err('outbox:reconcile', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Batch tailoring for the apply queue ──────────────────────────────────
// Same pipeline as /api/generate, driven over many jobs at once. A run takes
// minutes, so it is started in-process and polled rather than held open on the
// request. See services/apply/tailor-batch.js.

// What's tailored already, keyed by jobId — feeds the score badges on /apply.
app.get('/api/apply/tailor/results', async (req, res) => {
  try {
    const me = await requireUsername(req, res);
    if (!me) return;
    res.json({ results: await resultsByJobId(me) });
  } catch (e) {
    log.err('tailor:results', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Pending jobs with no tailored resume yet — what a "tailor the rest" click covers.
app.get('/api/apply/tailor/queue', async (req, res) => {
  try {
    const me = await requireUsername(req, res);
    if (!me) return;
    const jobs = await pendingWithoutResume(me, { limit: Number(req.query.limit) || 200 });
    res.json({ count: jobs.length, jobs: jobs.map((j) => ({ jobId: j.jobId, company: j.company, role: j.title, score: j.score })) });
  } catch (e) {
    log.err('tailor:queue', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Full tailored content for the in-page viewer.
app.get('/api/apply/tailor/variant/:id', async (req, res) => {
  try {
    const me = await requireUsername(req, res);
    if (!me) return;
    const out = await variantContent(me, req.params.id);
    if (!out) return res.status(404).json({ error: 'variant not found' });
    res.json(out);
  } catch (e) {
    log.err('tailor:variant', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serve a batch-tailored PDF from disk. These variants deliberately keep no
// bytes in Mongo (see saveVariant's `storePdf`), so the file is streamed from
// the resume outbox — and only from there: the stored path is re-checked
// against the roots on every request rather than trusted, since it decides
// which file gets sent.
app.get('/api/apply/tailor/variant/:id/pdf', async (req, res) => {
  try {
    const me = await requireUsername(req, res);
    if (!me) return;
    const meta = await variantContent(me, req.params.id);
    if (!meta) return res.status(404).json({ error: 'variant not found' });
    if (!meta.pdfPath) return res.status(404).json({ error: 'variant has no local PDF' });

    const target = resolvePath(meta.pdfPath);
    const inside = resumeRoots().some((r) => {
      const root = resolvePath(r);
      return target === root || target.startsWith(root + pathSep);
    });
    if (!inside) return res.status(403).json({ error: 'PDF is outside the resume outbox' });
    if (!fs.existsSync(target)) {
      return res.status(410).json({ error: 'PDF was retired from the outbox (job applied or rejected)' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('inline', basename(target)));
    fs.createReadStream(target).pipe(res);
  } catch (e) {
    log.err('tailor:pdf', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Kick off a batch. Body: { jobIds?, limit?, provider?, model?, mode?, force? }
// With no jobIds it takes the pending-without-resume queue; `force` re-tailors
// jobs that already have one.
app.post('/api/apply/tailor/run', jsonParser, async (req, res) => {
  try {
    const user = await requireUsername(req, res);
    if (!user) return;
    const { jobIds, limit, provider, model, mode, force } = req.body || {};

    let jobs;
    if (Array.isArray(jobIds) && jobIds.length) {
      const rows = await listJobs({ user: null, statusUser: user, status: 'pending', limit: 1000 });
      const all = Array.isArray(rows) ? rows : rows.rows || [];
      const wanted = new Set(jobIds);
      jobs = all.filter((j) => wanted.has(j.jobId));
    } else {
      jobs = force
        ? (await listJobs({ user: null, statusUser: user, status: 'pending', limit: limit || 200 }))
        : await pendingWithoutResume(user, { limit: limit || 200 });
      jobs = Array.isArray(jobs) ? jobs : jobs.rows || [];
    }
    if (limit) jobs = jobs.slice(0, Number(limit));
    if (!jobs.length) return res.status(400).json({ error: 'nothing to tailor — every pending job already has a resume' });

    // The queue rows are mirror-backed and don't carry the JD text; the
    // pipeline needs it, so pull it for exactly the rows in this run.
    const c = await col('job_tracker');
    const docs = await c
      .find({ jobId: { $in: jobs.map((j) => j.jobId) } }, { projection: { jobId: 1, jobText: 1 } })
      .toArray();
    const textById = new Map(docs.map((d) => [d.jobId, d.jobText || '']));
    jobs = jobs.map((j) => ({ ...j, jobText: textById.get(j.jobId) || '' }));

    const run = await startBatch({ username: user, jobs, provider, model, mode });
    log.info('tailor:run', `${run.id} — ${jobs.length} job(s) via ${run.provider}/${run.model}`);
    res.json({ runId: run.id, total: run.total, model: run.model, provider: run.provider });
  } catch (e) {
    log.err('tailor:run', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Progress for a run. Two routes rather than one optional `:id?` — Express 5's
// router rejects optional params outright and throws at registration.
const sendRun = (run, res) => (run ? res.json(run) : res.status(404).json({ error: 'no such run' }));
app.get('/api/apply/tailor/run', (_req, res) => sendRun(latestRun(), res));
app.get('/api/apply/tailor/run/:id', (req, res) => sendRun(getRun(req.params.id), res));

app.get('/apply', (_req, res) => res.sendFile(join(__dirname, 'public', 'apply.html')));
app.get('/scanner', (_req, res) => res.sendFile(join(__dirname, 'public', 'scanner.html')));

// AI service loader via provider registry

// Load the tailor resume JSON from mongo for `username` (the `users.username`
// doc key). No env, no file fallback — identity comes from the session (or
// the sole user) and Mongo is the single source of truth.
async function loadResumeData(username) {
  if (!username) throw new Error('loadResumeData: username required');
  const doc = await getUser(username);
  if (!doc?.data) throw new Error(`No resume in mongo for username "${username}"`);
  return doc.data;
}

// Pre-flight checks — global (non-user-specific) prerequisites only.
// `requestedProvider` is the provider the UI picked for this run; without it
// we'd validate the config default and let a mismatched selection fail deep in
// the pipeline instead of here.
async function preflightChecks(requestedProvider) {
  const hasLibreOffice = checkLibreOffice();
  const hasHtmlRenderer = await htmlRendererAvailable();
  const provider = requestedProvider || config.ai.provider;

  const errors = [];
  if (provider === 'bedrock') {
    // Which credential counts depends on the transport — a bearer key for
    // mantle, the AWS chain for SigV4 — so ask the transport rather than
    // testing for AWS keys that mantle never uses.
    if (!transportInfo().configured) {
      errors.push(`Bedrock credentials not configured for the '${activeTransport()}' transport`);
    }
  } else if (provider === 'gemini') {
    if (!(config.ai.gemini.apiKey || process.env.GEMINI_API_KEY)) errors.push('Gemini API key not configured');
  }
  // template.docx only matters to the DOCX fallback — the one-page HTML
  // renderer doesn't read it, so a missing template isn't fatal when Chrome is up.
  if (!hasHtmlRenderer && !fs.existsSync(config.paths.template)) errors.push('template.docx not found');
  if (!hasHtmlRenderer && !hasLibreOffice) errors.push('no PDF renderer available (install Chrome or LibreOffice)');

  return { hasLibreOffice, hasHtmlRenderer, errors, provider };
}

// The role half of the output filename ("<Name>_<Role>.pdf"): the tailored
// title when the model produced one, else the candidate's own stack from
// resume meta, else a plain "Resume".
const roleSlug = (title, meta) => {
  const t = String(title || '').trim();
  const stack = String(meta?.stack || '').trim();
  return (t || (stack ? `${stack}-Developer` : 'Resume')).replace(/\s+/g, '-');
};

// SSE helper
function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Main generate endpoint - SSE stream
app.post('/api/generate', async (req, res) => {
  const { jobDescription, model } = req.body;

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    const username = await sessionUser(req);
    if (!username) {
      sendEvent(res, 'error', { message: 'No user — complete /setup first' });
      return res.end();
    }

    // Step 0: Preflight
    sendEvent(res, 'step', { step: 0, label: 'Running pre-flight checks...' });
    const { errors } = await preflightChecks(req.body.provider);
    if (errors.length > 0) {
      sendEvent(res, 'error', { message: `Pre-flight failed: ${errors.join(', ')}` });
      return res.end();
    }
    sendEvent(res, 'step', { step: 0, label: 'Pre-flight checks passed', done: true });

    // Step 1: Validate JD
    sendEvent(res, 'step', { step: 1, label: 'Validating job description...' });
    try {
      validateJobDescription(jobDescription);
    } catch (e) {
      sendEvent(res, 'error', { message: e.message });
      return res.end();
    }
    sendEvent(res, 'step', { step: 1, label: 'Job description validated', done: true });

    // Step 2: Load resume data
    sendEvent(res, 'step', { step: 2, label: `Loading resume data for ${username}...` });
    const resumeData = await loadResumeData(username);
    sendEvent(res, 'step', { step: 2, label: `Loaded: ${resumeData.personalInfo?.name}`, done: true });

    // Step 3: AI Tailoring
    const providerName = req.body.provider || config.ai.provider;
    const mode = req.body.mode || config.tailoring.mode;
    const effectiveModel = model || (mode === 'ats_max' ? config.tailoring.atsMaxModel : undefined);
    const modelLabel = effectiveModel || config.ai.bedrock.modelId || 'haiku';
    const modeLabel = mode === 'ats_max' ? ' [ATS_MAX]' : '';
    sendEvent(res, 'step', { step: 3, label: `AI tailoring via ${providerName.toUpperCase()} [${modelLabel}]${modeLabel}...` });
    const aiProvider = await getProvider(providerName, effectiveModel);
    const aiResponse = await aiProvider.tailorResume(jobDescription, resumeData, { mode });
    sendEvent(res, 'step', { step: 3, label: 'AI tailoring complete', done: true });

    // Step 4: Generate outputs (email, LinkedIn)
    sendEvent(res, 'step', { step: 4, label: 'Generating email & LinkedIn DM...' });
    const emailData = generateEmail(aiResponse, resumeData);
    const linkedInDM = generateLinkedInDM(aiResponse, resumeData);

    if (emailData) {
      saveEmailData(emailData.to, emailData.subject, emailData.body);
    }
    saveLinkedInDM(linkedInDM.linkedInUrl, linkedInDM.message, linkedInDM.contactName);
    sendEvent(res, 'step', { step: 4, label: 'Messages generated', done: true });

    // Step 5 + 6: Lay the resume out and write the file. The HTML renderer
    // does both at once (it measures the layout to guarantee one page), so the
    // two steps collapse when it's available.
    const userName = resumeData.personalInfo?.name || 'Resume';
    const outputPaths = config.paths.getOutputPaths(userName, roleSlug(aiResponse.title, resumeData.meta));
    const onePage = await htmlRendererAvailable();
    sendEvent(res, 'step', { step: 5, label: onePage ? 'Laying out one-page resume...' : 'Generating resume document...' });
    const rendered = await renderResume(aiResponse, resumeData, outputPaths);
    const outputPath = rendered.path;
    sendEvent(res, 'step', { step: 5, label: 'Resume document generated', done: true });
    sendEvent(res, 'step', {
      step: 6,
      label: rendered.engine === 'html'
        ? `PDF ready (${rendered.pages} page${rendered.pages === 1 ? '' : 's'})`
        : rendered.engine === 'libreoffice' ? 'PDF ready' : 'PDF skipped (no converter)',
      done: true,
    });

    // Save per-job resume copy (local logs/resumes/ — kept for backwards compat)
    saveResumeForContact(outputPath, aiResponse.jdTitle, aiResponse.jdCompany);

    // Persist the tailored variant to mongo (resume_variants). One doc per
    // generation — never overwrites previous runs, so the dashboard can list
    // every iteration of a tailored resume.
    const variantUser = username;
    if (variantUser) {
      try {
        const v = await saveVariant({
          username: variantUser,
          jobTitle: aiResponse.jdTitle || aiResponse.title || '',
          jobCompany: aiResponse.jdCompany || '',
          jobDescription,
          aiResponse,
          email: emailData,
          linkedInDM,
          resumeJson: null, // built below; assigned right after this block
          pdfPath: outputPath,
          atsScore: aiResponse.atsScore || null,
          mode: aiResponse.mode || mode,
          modelLabel,
          provider: providerName,
        });
        console.log(`[mongo] variant saved: ${v._id} (${aiResponse.jdCompany} / ${aiResponse.jdTitle})`);
        // The drafted email shows up on the Emails page (Outreach) next to
        // the feed drafts, with the tailored PDF attached when it is sent.
        if (emailData?.to && emailData?.body) {
          try {
            await pushTailorEmail(variantUser, {
              variantId: v._id,
              to: emailData.to,
              subject: emailData.subject,
              body: emailData.body,
              jobTitle: aiResponse.jdTitle || aiResponse.title || '',
              jobCompany: aiResponse.jdCompany || '',
              contactName: emailData.contactName || aiResponse.contact?.name || '',
              score: aiResponse.atsScore?.overallScore,
            });
          } catch (err) {
            console.warn(`[mongo] tailor email draft not saved: ${err.message}`);
          }
        }
      } catch (err) {
        console.warn(`[mongo] variant save failed: ${err.message}`);
      }
    }

    // Build personal projects data
    const personalProjects = (resumeData.projects || []).map(project => {
      const key = project.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      return { name: project.name, description: aiResponse[key] || '' };
    });

    // Editable JSON bundle — round-trippable through /api/regenerate-from-json
    const resumeJson = {
      personalInfo: resumeData.personalInfo || {},
      meta: resumeData.meta || {},
      title: aiResponse.title || '',
      summary: aiResponse.summary || '',
      skills: aiResponse.skills || '',
      bullets: aiResponse.bullets || [],
      experience: resumeData.experience || [],
      projects: personalProjects,
      education: resumeData.education || [],
    };

    // Send final result
    sendEvent(res, 'result', {
      mode: aiResponse.mode || 'strict',
      title: aiResponse.title,
      summary: aiResponse.summary,
      skills: aiResponse.skills,
      bullets: aiResponse.bullets,
      personalProjects,
      atsScore: aiResponse.atsScore || null,
      jobType: aiResponse.jobType || 'Full-time',
      salary: aiResponse.salary || null,
      email: emailData,
      linkedInDM,
      contact: aiResponse.contact || null,
      outputPath,
      phrases: aiResponse.phrases || [],
      phrasesUsed: aiResponse.phrasesUsed || [],
      coverLetter: aiResponse.coverLetter || null,
      resumeJson,
    });

  } catch (error) {
    sendEvent(res, 'error', { message: error.message });
  }

  res.end();
});

// Health check
app.get('/api/health', async (req, res) => {
  const { errors, provider } = await preflightChecks();
  res.json({ ok: errors.length === 0, provider, errors });
});

// Resume data validation endpoint — validates the user's tailor JSON from
// mongo.
app.get('/api/validate-resume', async (req, res) => {
  try {
    const username = await requireUsername(req, res);
    if (!username) return;
    const doc = await getUser(username);
    if (!doc?.data) {
      return res.json({
        valid: false,
        exists: false,
        errors: [`No resume in mongo for "${username}"`],
        warnings: [],
        summary: null,
      });
    }
    const result = validateResumeData(doc.data);
    res.json({ ...result, exists: true });
  } catch (err) {
    res.json({ valid: false, exists: true, errors: [`Failed to validate resume: ${err.message}`], warnings: [], summary: null });
  }
});

// Available AI providers and models
app.get('/api/models', async (req, res) => {
  const providers = await listProviders();
  const activeProvider = config.ai.provider;
  // Bedrock's model list depends on which transport is live — mantle and the
  // AWS Converse API expose different catalogues under different ids — so the
  // UI is told the transport as well as the models.
  res.json({
    activeProvider,
    providers,
    bedrockTransport: transportInfo(),
  });
});

// Log data endpoints. LOGS_DIR is per database (logs/<host>__<db>/), see
// services/db.js — a fresh MONGO_DB starts with an empty history and outbox.
function readLogFile(filename) {
  const filepath = join(LOGS_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  try { return JSON.parse(fs.readFileSync(filepath, 'utf-8')); } catch { return null; }
}

app.get('/api/contacts', (req, res) => {
  res.json(readLogFile('contacts.json') || []);
});

// Email dashboard endpoints
app.get('/api/emails', (req, res) => {
  res.json(getAllEmailContacts());
});

app.post('/api/emails/approve', (req, res) => {
  const { index } = req.body;
  if (typeof index !== 'number') return res.status(400).json({ error: 'index required' });
  const ok = updateEmailStatus(index, 'approved');
  res.json({ ok });
});

app.post('/api/emails/reject', (req, res) => {
  const { index } = req.body;
  if (typeof index !== 'number') return res.status(400).json({ error: 'index required' });
  const ok = updateEmailStatus(index, 'rejected');
  res.json({ ok });
});

app.post('/api/emails/reset', (req, res) => {
  const { index } = req.body;
  if (typeof index !== 'number') return res.status(400).json({ error: 'index required' });
  const ok = updateEmailStatus(index, 'drafted');
  res.json({ ok });
});

app.post('/api/emails/send', async (req, res) => {
  // SMTP creds + master PDF live on the user's doc in mongo, so the send
  // always goes out as the resolved user.
  const username = await requireUsername(req, res);
  if (!username) return;

  const unsent = getUnsentEmails();
  if (unsent.length === 0) {
    log.info('emails:send', `no approved unsent for ${username}`);
    return res.json({ sent: 0, failed: 0, message: 'No approved emails to send' });
  }

  log.info('emails:send', `start user=${username} candidates=${unsent.length}`);
  const connected = await verifyConnection({ username });
  if (!connected) {
    log.err('emails:send', `verifyConnection failed for ${username}`);
    return res.status(500).json({ error: 'SMTP connection failed — check Settings → SMTP' });
  }

  const results = { sent: 0, failed: 0, errors: [] };

  for (let i = 0; i < unsent.length; i++) {
    const contact = unsent[i];
    let emailData;
    if (contact.emailData?.subject && contact.emailData?.body) {
      emailData = { to: contact.to, subject: contact.emailData.subject, body: contact.emailData.body };
    } else {
      emailData = {
        to: contact.to,
        subject: `Application for ${contact.jobTitle || 'the open position'}${contact.jobCompany ? ` at ${contact.jobCompany}` : ''}`,
        body: `Dear ${contact.contactName || 'Hiring Manager'},\n\nI am writing to express my interest in the ${contact.jobTitle || 'open position'}${contact.jobCompany ? ` at ${contact.jobCompany}` : ''}. Please find my resume attached.\n\nBest regards`,
      };
    }

    if (contact.resumePath) emailData.resumePath = contact.resumePath;

    const result = await sendEmail(emailData, { username, markSent: true });
    if (result.success) {
      results.sent++;
      log.ok('emails:send', `[${i + 1}/${unsent.length}] ${contact.to} ✓`);
    } else {
      results.failed++;
      results.errors.push({ to: contact.to, error: result.error });
      log.err('emails:send', `[${i + 1}/${unsent.length}] ${contact.to} ✗ ${result.error}`);
    }

    if (i < unsent.length - 1) await new Promise(r => setTimeout(r, 1200));
  }

  log.ok('emails:send', `done user=${username} sent=${results.sent} failed=${results.failed}`);
  res.json(results);
});

// History entries come from the file log, but the PDF lives in resume_variants
// under the filename the renderer chose (`<Name>_<Role>.pdf`), which the page
// used to guess as `<date>_<company>_<title>.pdf` and 404 on. Match each entry
// to its variant (same company + title, generated within 15 minutes) and send
// the real filename along.
app.get('/api/history', async (req, res) => {
  const entries = readLogFile('resume_history.json') || [];
  const username = await resolveUsername(req);
  if (!username || !entries.length) return res.json(entries);
  try {
    const norm = (s) => String(s || '').trim().toLowerCase();
    const variants = (await listVariants(username, { limit: 5000 }))
      .filter((v) => v.pdf?.filename)
      .map((v) => ({ key: `${norm(v.jobCompany)}|${norm(v.jobTitle)}`, at: new Date(v.generatedAt).getTime(), filename: v.pdf.filename }));
    const byKey = new Map();
    for (const v of variants) (byKey.get(v.key) || byKey.set(v.key, []).get(v.key)).push(v);
    for (const h of entries) {
      const at = new Date(h.date).getTime();
      const cands = byKey.get(`${norm(h.job?.company)}|${norm(h.job?.title)}`) || [];
      let best = null;
      for (const c of cands) {
        const d = Math.abs(c.at - at);
        if (d <= 15 * 60 * 1000 && (!best || d < best.d)) best = { d, filename: c.filename };
      }
      if (best) h.filename = best.filename;
    }
  } catch (e) {
    log.warn('history', `variant match skipped: ${e.message}`);
  }
  res.json(entries);
});

app.get('/api/keyword-gaps', (_req, res) => {
  res.json(readLogFile('keyword_gaps.json') || { entries: [], summary: {} });
});

// List filenames of saved resume variants for the current user. Used by
// history.html to decide which entries have a "ready" PDF vs. need regen.
// Sourced from `resume_variants` in mongo — `logs/resumes/` is no longer
// consulted. Only variants whose `pdf.filename` is set surface here.
app.get('/api/resumes', async (req, res) => {
  const username = await sessionUser(req);
  if (!username) return res.json([]);
  try {
    const c = await col('resume_variants');
    const docs = await c.find(
      { username, 'pdf.filename': { $exists: true, $ne: null, $ne: '' } },
      { projection: { 'pdf.filename': 1 } },
    ).toArray();
    res.json(docs.map(d => d.pdf?.filename).filter(Boolean));
  } catch (e) {
    log.err('resumes:list', `user=${username} err=${e.message}`);
    res.json([]);
  }
});

// Download or regen a saved resume PDF by its `pdf.filename`. Look up in
// `resume_variants` (per-user) — if the variant has stored bytes, send those;
// otherwise regenerate DOCX → PDF in-memory from the variant's `aiResponse`
// and stream back. `logs/resumes/` is no longer touched.
app.get('/api/resumes/:filename', async (req, res) => {
  const filename = req.params.filename;
  // Prevent path traversal via :filename param. Even though we don't use it
  // as a path anymore, keep the guard — it's cheap and protects against
  // future regressions if anyone adds a filesystem path here later.
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const username = await requireUsername(req, res);
  if (!username) return;

  try {
    const c = await col('resume_variants');
    const variant = await c.findOne(
      { username, 'pdf.filename': filename },
      { sort: { generatedAt: -1 } },
    );
    if (!variant) {
      return res.status(404).json({ error: 'Resume not found in resume_variants for this user' });
    }

    // Fast path: stored PDF bytes. Stream Binary back as application/pdf.
    if (variant.pdf?.data) {
      const data = variant.pdf.data;
      const buffer = data.buffer || Buffer.from(data);
      res.setHeader('Content-Type', variant.pdf.contentType || 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition('attachment', filename));
      return res.send(buffer);
    }

    // Regen path: variant exists but no bytes. Rebuild DOCX → PDF from the
    // stored `aiResponse` payload. Writes only to /tmp; cleaned up after.
    if (!variant.aiResponse) {
      return res.status(404).json({ error: 'Variant has no PDF and no aiResponse to regen from' });
    }
    const resumeData = await loadResumeData(username);
    const tmpDir = join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const stamp = Date.now();
    const tmpDocx = join(tmpDir, `regen_${stamp}.docx`);
    const tmpPdf  = join(tmpDir, `regen_${stamp}.pdf`);
    const regen = await renderResume(variant.aiResponse, resumeData, { docx: tmpDocx, pdf: tmpPdf });

    if (regen.engine === 'docx') {
      // No converter at all — serve DOCX as a fallback so the user gets something.
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', contentDisposition('attachment', filename.replace(/\.pdf$/, '.docx')));
      const buf = fs.readFileSync(regen.path);
      cleanupDocx(regen.path);
      return res.send(buf);
    }

    const buf = fs.readFileSync(regen.path);
    try { fs.unlinkSync(regen.path); } catch {}

    // Persist the freshly-regenerated bytes back onto the variant so the next
    // request hits the fast path. Skipped for variants that carry a `pdfPath`:
    // those are batch-tailored and deliberately disk-backed, and caching here
    // would put the Binary straight back into Mongo.
    try {
      if (variant.pdfPath) throw new Error('disk-backed variant — not caching bytes');
      await c.updateOne(
        { _id: variant._id },
        { $set: { pdf: { filename, contentType: 'application/pdf', size: buf.length, data: new Binary(buf) } } },
      );
    } catch (e) {
      log.warn('resumes:regen-cache', `variant=${variant._id} err=${e.message}`);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition('attachment', filename));
    return res.send(buf);
  } catch (error) {
    log.err('resumes:get', `filename=${filename} user=${username} err=${error.message}`);
    return res.status(500).json({ error: `Failed to serve resume: ${error.message}` });
  }
});

// Regenerate PDF from a user-edited JSON bundle (the same shape returned in
// the SSE 'result' event as `resumeJson`). Returns the PDF as a download.
app.post('/api/regenerate-from-json', async (req, res) => {
  try {
    const bundle = req.body || {};
    if (!bundle.personalInfo || typeof bundle.personalInfo !== 'object') {
      return res.status(400).json({ error: 'personalInfo object is required' });
    }

    // Reconstruct aiResponse + resumeData so the existing pipeline can be reused.
    // Coerce types defensively — AI editors sometimes turn the skills CSV into an array.
    const toStr = (v) => Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v));
    const aiResponse = {
      title: toStr(bundle.title),
      summary: toStr(bundle.summary),
      skills: toStr(bundle.skills),
      bullets: Array.isArray(bundle.bullets) ? bundle.bullets.map(toStr) : [],
    };
    for (const project of bundle.projects || []) {
      if (!project || !project.name) continue;
      const key = project.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      aiResponse[key] = toStr(project.description);
    }

    const resumeDataFromBundle = {
      personalInfo: bundle.personalInfo || {},
      // `meta` carries the stack + start date the header tagline is built from.
      // No `skills` map: the bundle is hand-editable and shipping the
      // candidate's full 150-entry bucket list would drown it. Skill grouping
      // falls back to the lexicon in skill-groups.js, which covers real
      // technology names — only exotic entries land in the catch-all row.
      meta: bundle.meta || {},
      experience: bundle.experience || [],
      projects: (bundle.projects || []).map(p => ({ name: p.name })),
      education: bundle.education || [],
    };

    const userName = bundle.personalInfo.name || 'Resume';
    const outputPaths = config.paths.getOutputPaths(userName, roleSlug(bundle.title, bundle.meta));

    const rendered = await renderResume(aiResponse, resumeDataFromBundle, outputPaths);
    return res.download(rendered.path);
  } catch (error) {
    console.error('Regenerate-from-JSON error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Eagerly boot the in-memory mirrors (job_tracker today, more later). Each
// mirror loads from its persisted JSON snapshot first (instant) and then
// reconciles against Mongo in the background. We don't `await` here so
// the HTTP server still opens within a few ms; the mirror reaches `loaded`
// state as soon as the first read either finds the snapshot or the Mongo
// fetch completes.
import { jobTrackerMirror, userEmailsMirror, postsMirror, connectionsMirror, connectsMirror, inboxMirror, highSalaryMirror, flushAllMirrors } from './services/mirror.js';
// Kick off all mirror loads in parallel. Each loads its snapshot first
// (instant) then refreshes from Mongo in the background. The HTTP server
// doesn't wait — first reads either find the mirror loaded (fast path)
// or fall through to the Mongo fallback for the brief startup window.
jobTrackerMirror.load().catch(e => log.err('mirror', `job_tracker boot failed: ${e.message}`));
userEmailsMirror.load().catch(e => log.err('mirror', `user_emails boot failed: ${e.message}`));
postsMirror.load().catch(e => log.err('mirror', `posts boot failed: ${e.message}`));
connectionsMirror.load().catch(e => log.err('mirror', `connections boot failed: ${e.message}`));
connectsMirror.load().catch(e => log.err('mirror', `user_connects boot failed: ${e.message}`));
inboxMirror.load().catch(e => log.err('mirror', `user_inbox boot failed: ${e.message}`));
highSalaryMirror.load().catch(e => log.err('mirror', `high_salary_companies boot failed: ${e.message}`));

// Peer job sources: every 30 s pull already-analyzed rows from the databases
// listed in data/peers.json into this one. A missing / empty peers file is
// the normal case and costs nothing.
try {
  Promise.resolve(startPeerSync()).catch(e => log.err('peers', `sync loop failed to start: ${e.message}`));
} catch (e) {
  log.err('peers', `sync loop failed to start: ${e.message}`);
}

// Flush snapshots on graceful shutdown so a clean SIGTERM doesn't lose
// the last few seconds of writes that haven't hit the periodic flush yet.
// The peer loop is stopped first so a half-finished import can't land in
// Mongo after the snapshot it belongs in was written.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { await stopPeerSync(); } catch {}
    try { await flushAllMirrors(); } catch {}
    process.exit(0);
  });
}

const PORT = Number(process.env.PORT) || 5003;
// The browser extension talks to whatever port is set in its popup ("Server
// port", default 5003). A server on any other port is simply invisible to it,
// with no error on either side, so the banner says so whenever PORT is not
// the default.
const EXTENSION_DEFAULT_PORT = 5003;
// Fail loudly if the port is already taken. Without the explicit error
// handler, EADDRINUSE prints a long stacktrace and (in some shell wrappers
// like nodemon/concurrently) gets swallowed so it looks like the server
// "started" three times in three terminals — it didn't, only the first
// one is actually listening. This shortens the message and exits with a
// non-zero code so the shell makes it obvious.
// ── Mail ──────────────────────────────────────────────────────────────────
// Everything here is gated on `automatable` from services/inbox/classify.js —
// a row it marked non-automatable can be read and dismissed, never drafted,
// never sent, never fed to the model.
const mailRow = async (username, messageId) => {
  const { listInbox } = await import('./services/inbox/inbox-store.js');
  return (await listInbox({ username, limit: 5000 })).find(r => r.messageId === messageId) || null;
};

app.post('/api/mail/sync', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { fetchSince } = await import('./services/inbox/imap-client.js');
    const { ingest, lastSeen } = await import('./services/inbox/inbox-store.js');
    const user = await getUser(username);
    const days = Math.min(Number(req.body?.days) || 14, 90);
    const since = (await lastSeen(username)) || new Date(Date.now() - days * 864e5);

    // Index our sent mail so an inbound reply can be tied back to the post it
    // answers. messageId only exists on rows sent after we started storing it;
    // subject is the fallback and is why Sent is fetched at all.
    const sentIndex = new Map();
    if (userEmailsMirror.loaded) {
      for (const r of userEmailsMirror.iter()) {
        if (r.username !== username || r.status !== 'sent') continue;
        const ref = { postId: r.postId, jobTitle: r.job?.title };
        if (r.messageId) sentIndex.set(r.messageId, ref);
        if (r.email?.subject) sentIndex.set(r.email.subject, ref);
      }
    }

    const { mails, complete } = await fetchSince(user, since);
    // Only a clean INBOX fetch is allowed to delete anything — a degraded one
    // would read as "the whole window was deleted upstream".
    const out = await ingest(username, mails, { sentIndex, windowStart: complete ? since : null });
    log.ok('mail:sync', `${username}: fetched ${mails.length}, added ${out.added}, removed ${out.removed || 0}`
      + `${complete ? '' : ' (degraded fetch — reconcile skipped)'} ${JSON.stringify(out.buckets)}`);
    res.json({ ok: true, fetched: mails.length, complete, since: since.toISOString(), ...out });
  } catch (e) {
    log.err('mail:sync', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/mail', async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { listInbox, inboxCounts } = await import('./services/inbox/inbox-store.js');
    const items = await listInbox({ username, bucket: req.query.bucket, status: req.query.status, limit: req.query.limit });
    res.json({ items, counts: await inboxCounts(username) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mail/draft', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { setInbox } = await import('./services/inbox/inbox-store.js');
    const { draftReply, extractTasks } = await import('./services/inbox/mail-ai.js');
    const row = await mailRow(username, req.body?.messageId);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!row.automatable) return res.status(409).json({ error: 'held for review — not automatable' });

    if (row.bucket === 'task') {
      const tasks = await extractTasks(row);
      return res.json({ ok: true, row: await setInbox(username, row.messageId, { tasks, status: 'drafted' }) });
    }
    const d = await draftReply(row, await loadCandidate(username));
    res.json({ ok: true, row: await setInbox(username, row.messageId, {
      draft: d.body, draftSubject: d.subject, unanswered: d.unanswered, status: 'drafted',
    }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mail/send', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { setInbox } = await import('./services/inbox/inbox-store.js');
    const { sendEmail } = await import('./services/feed/email-sender.js');
    const { messageId, subject, body } = req.body || {};
    const row = await mailRow(username, messageId);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!row.automatable) return res.status(409).json({ error: 'held for review — not automatable' });
    if (!String(body || '').trim()) return res.status(400).json({ error: 'empty body' });

    const r = await sendEmail({ to: row.fromAddr, subject: subject || row.draftSubject, body }, { username });
    if (!r.success) return res.status(502).json({ error: r.error });
    res.json({ ok: true, row: await setInbox(username, messageId, {
      status: 'replied', handledAt: new Date().toISOString(), sentBody: body,
    }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mail/status', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { setInbox } = await import('./services/inbox/inbox-store.js');
    const { messageId, status } = req.body || {};
    if (!['new', 'drafted', 'replied', 'done', 'dismissed'].includes(status)) return res.status(400).json({ error: 'bad status' });
    res.json({ ok: true, row: await setInbox(username, messageId, { status, handledAt: new Date().toISOString() }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Composer — paste a post/JD, get a drafted application. No inbox row involved.
app.post('/api/mail/compose', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { composeFromText } = await import('./services/inbox/mail-ai.js');
    const text = String(req.body?.text || '');
    if (text.trim().length < 40) return res.status(400).json({ error: 'paste the post text first' });
    res.json({ ok: true, ...(await composeFromText(text, await loadCandidate(username))) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mail/compose/send', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { sendEmail } = await import('./services/feed/email-sender.js');
    const { to, subject, body } = req.body || {};
    if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject and body required' });
    const r = await sendEmail({ to, subject, body }, { username });
    if (!r.success) return res.status(502).json({ error: r.error });
    log.ok('mail:compose', `${username} -> ${to}`);
    res.json({ ok: true, to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Referral-note templates for the /connections cards, batched by jobLink.
//
// The note is already written: `job_tracker.connectNote` holds one per job with
// {{name}} / {{exp}} placeholders (13.7k rows), so this is substitution, not
// generation — no model call, and fast enough for the click to stay synchronous
// on the client, which is what keeps the clipboard write reliable.
app.post('/api/connections/notes', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const links = (req.body?.jobLinks || []).slice(0, 400).filter(Boolean);
    if (!links.length) return res.json({ notes: {} });

    const cand = await loadCandidate(username);
    // Same value /api/apply/jobs and /api/ext/* substitute ('1+', '~3', '~2.5'
    // — see services/users/experience.js). Unknown stays unknown: the
    // placeholder is left in the note rather than filled with a guess.
    const exp = await yearsOfExperienceFor(username);

    const wanted = new Set(links);
    const byLink = new Map();
    const byCompany = new Map();       // fallback: latest applied job at the same company
    for (const j of jobTrackerMirror.iter()) {
      if (!String(j.connectNote || '').trim()) continue;
      if (j.jobLink && wanted.has(j.jobLink)) byLink.set(j.jobLink, j);
      const key = String(j.company || '').trim().toLowerCase();
      if (!key) continue;
      const appliedAt = j.users?.[username]?.appliedAt || null;
      const prev = byCompany.get(key);
      // Prefer the most recently APPLIED job; fall back to most recently seen.
      const rank = (x) => x?.users?.[username]?.appliedAt || x?.analyzedAt || x?.createdAt || '';
      if (!prev || String(rank(j)) > String(rank(prev))) byCompany.set(key, j);
    }

    // Every job in the tracker, so a card can name its own role even when that
    // role has no stored note.
    const anyJob = new Map();
    for (const j of jobTrackerMirror.iter()) if (j.jobLink && wanted.has(j.jobLink)) anyJob.set(j.jobLink, j);

    // Name the candidate's own top skills; with none on file the clause is
    // dropped rather than filled with a stack they may not have.
    const stack = (cand.skills || []).slice(0, 3).join(', ');
    const background = exp
      ? ` With ${exp} years${stack ? ` across ${stack}` : ''}, I've shipped production features end to end.`
      : stack ? ` Working across ${stack}, I've shipped production features end to end.` : '';
    const synth = (title, company) =>
      `Hi {{name}}, I'm reaching out about the ${title || 'role'}${company ? ` at ${company}` : ''}`
      + ` — I applied recently and would love your thoughts.${background}`
      + ` If my background fits, a referral would mean a lot. Thanks.`;

    const notes = {};
    for (const link of links) {
      const own = byLink.get(link);
      const meta = own || anyJob.get(link) || null;
      const askedCo = req.body?.companies?.[link];
      const co = String(askedCo || meta?.company || '').trim().toLowerCase();
      // No note on this exact job — reach for the company's latest applied one.
      const borrowed = !own && co ? byCompany.get(co) : null;
      const src = own || borrowed;

      // Still nothing? Write one. A card with no note used to fall through and
      // the button silently opened the chat with an empty clipboard, which
      // reads as "copy is broken" rather than "this job has no note".
      const template = src
        ? (exp ? String(src.connectNote).replace(/\{\{\s*exp\s*\}\}/gi, exp) : String(src.connectNote))
        : synth(meta?.title || null, askedCo || meta?.company || null);

      notes[link] = {
        template,
        title: (src || meta)?.title || null,
        company: (src || meta)?.company || askedCo || null,
        appliedAt: (src || meta)?.users?.[username]?.appliedAt || null,
        origin: own ? 'job' : borrowed ? 'company' : 'generated',
      };
    }
    res.json({ notes, exp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reclassify — the gate is deliberately cautious, so an operator override is
// the pressure valve. Moving out of `review` also sets automatable, which is
// what unlocks drafting for that row.
app.post('/api/mail/reclassify', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { setInbox } = await import('./services/inbox/inbox-store.js');
    const { messageId, bucket } = req.body || {};
    if (!['reply', 'task', 'review'].includes(bucket)) return res.status(400).json({ error: 'bad bucket' });
    res.json({ ok: true, row: await setInbox(username, messageId, {
      bucket, automatable: bucket !== 'review', reason: 'moved by operator', status: 'new',
    }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mail/followups/dismiss', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { markFollowedUp } = await import('./services/inbox/followups.js');
    if (!req.body?.postId) return res.status(400).json({ error: 'postId required' });
    await markFollowedUp(username, req.body.postId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Follow-ups — two populations: threads that replied then went cold (worth far
// more), and mail that was never answered. Nudging is capped at one per row and
// suppressed for anyone already contacted more than twice.
app.get('/api/mail/followups', async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { findFollowUps } = await import('./services/inbox/followups.js');
    res.json({ ok: true, ...(await findFollowUps(username)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mail/followups/draft', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { findFollowUps } = await import('./services/inbox/followups.js');
    const { draftReply } = await import('./services/inbox/mail-ai.js');
    const { postId } = req.body || {};
    const all = await findFollowUps(username);
    const row = [...all.stalled, ...all.silent].find((r) => r.postId === postId);
    if (!row) return res.status(404).json({ error: 'not in the follow-up set' });

    // A stalled thread is answered in context; a silent one gets a short nudge.
    const cand = await loadCandidate(username);
    const synthetic = {
      automatable: true,
      from: row.to,
      subject: row.subject || row.jobTitle || 'our conversation',
      body: row.kind === 'stalled'
        ? `Their last message ${row.quietDays} days ago:\n${row.theirLastMessage}\n\n(Write a brief, warm nudge that moves this forward. Do not repeat their message back.)`
        : `No reply in ${row.quietDays} days to an application for ${row.jobTitle || 'the role'}${row.company ? ' at ' + row.company : ''}. (Write a 2-3 sentence polite follow-up asking about next steps. Do not re-apply or restate the whole CV.)`,
      receivedAt: new Date().toISOString(),
    };
    const d = await draftReply(synthetic, cand);
    res.json({ ok: true, to: row.to, subject: `Re: ${row.subject || row.jobTitle || ''}`.trim(), body: d.body, kind: row.kind });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mail/followups/send', jsonParser, async (req, res) => {
  const username = await requireUsername(req, res);
  if (!username) return;
  try {
    const { sendEmail } = await import('./services/feed/email-sender.js');
    const { markFollowedUp } = await import('./services/inbox/followups.js');
    const { postId, to, subject, body } = req.body || {};
    if (!postId || !to || !body) return res.status(400).json({ error: 'postId, to and body required' });
    const r = await sendEmail({ to, subject: subject || 'Following up', body }, { username });
    if (!r.success) return res.status(502).json({ error: r.error });
    await markFollowedUp(username, postId);
    log.ok('mail:followup', `${username} -> ${to}`);
    res.json({ ok: true, to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Loopback unless HOST says otherwise: /api/setup (until the first user
// exists) and the whole /api/ext router answer without a session, and the
// extension only ever talks to localhost. Exposing the LAN is a deliberate
// act (HOST=0.0.0.0 in .env), not the default posture of a fresh install.
const HOST = process.env.HOST || '127.0.0.1';
const _server = app.listen(PORT, HOST, async () => {
  const { host: dbHost, db: dbName } = dbIdentity();
  const userState = await userStateSummary();
  // Peer count is informational; the sync loop itself is started above.
  let peerLine;
  try {
    const { readPeers } = await import('./services/peers/peers-config.js');
    const peers = await readPeers();
    const list = Array.isArray(peers) ? peers : Array.isArray(peers?.peers) ? peers.peers : [];
    peerLine = list.length
      ? `Peers: ${list.length} job source(s) in data/peers.json, syncing every 30 s`
      : 'Peers: none (add other people\'s databases under Settings → Shared job sources)';
  } catch (e) {
    peerLine = `Peers: unavailable (${e.message})`;
  }

  console.log(`\n  Resume Forge`);
  console.log(`  http://localhost:${PORT}${HOST !== '127.0.0.1' && HOST !== 'localhost' ? `  (bound to ${HOST})` : ''}`);
  console.log(`  Database: ${dbHost}/${dbName}`);
  console.log(`  User: ${userState}`);
  console.log(`  AI provider: ${config.ai.provider}`);
  console.log(`  Mirror: in-memory read replica of the hot collections (snapshots in data/mirrors/)`);
  console.log(`  ${peerLine}`);
  if (!process.env.PORT) {
    console.log(`  Note: PORT is not set in .env — using ${PORT}. Add PORT=${PORT} to .env to keep it explicit.`);
  }
  if (PORT !== EXTENSION_DEFAULT_PORT) {
    console.log(`  Extension: open the Job Scanner popup and set "Server port" to ${PORT} (it defaults to ${EXTENSION_DEFAULT_PORT}).`);
  }
  console.log('');
});
_server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use.`);
    console.error(`    Another tailor server is running. Stop it first:`);
    console.error(`      lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    console.error(`      kill <pid>`);
    console.error(`    Or set PORT=<other> to run on a different port.\n`);
    process.exit(1);
  }
  throw err;
});
