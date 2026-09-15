// resume-tailor's mongo storage layer.
// Reads + writes against the `users` collection. In a single-user database
// it holds one doc: auth, emailConfig, resume payloads (tailor `data` + feed
// `feedData`), history rings, daily-reminder URLs and an optional master PDF
// blob. Tailored outputs go to `resume_variants`, keyed by username +
// generatedAt. Peer job sources (data/peers.json) are a local file, never
// stored on this doc — a connection string does not belong in the DB.
import fs from 'fs';
import { col } from './db.js';
import { Binary } from 'mongodb';

// ── User reads ──

// Fetch the full user doc (auth, emailConfig, data, feedData, history, …).
// PDF blob is excluded by default — pass { includePdf: true } if you need it.
export const getUser = async (username, opts = {}) => {
  if (!username) return null;
  const projection = opts.includePdf ? {} : { 'pdf.data': 0 };
  return (await col('users')).findOne({ username }, { projection });
};

// Fetch just the master PDF blob for a user.
export const getUserPdf = async (username) => {
  if (!username) return null;
  const doc = await (await col('users')).findOne(
    { username },
    { projection: { pdf: 1 } },
  );
  if (!doc?.pdf?.data) return null;
  const data = doc.pdf.data;
  const buffer = data.buffer || Buffer.from(data);
  return { filename: doc.pdf.filename, contentType: doc.pdf.contentType, buffer };
};

// ── User writes ──

let _resumesIndexed = false;
const ensureResumesIndex = async () => {
  if (_resumesIndexed) return;
  await (await col('users')).createIndex({ username: 1 }, { unique: true });
  _resumesIndexed = true;
};

// Upsert the resume JSON for a user. PDF is left untouched.
// (Legacy. New code should use saveTailorData / saveFeedData below — they
// archive the previous version into a 5-deep history ring.)
export const upsertResumeData = async (username, data) => {
  await ensureResumesIndex();
  const r = await (await col('users')).updateOne(
    { username },
    { $set: { username, data, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
  return { matched: r.matchedCount, modified: r.modifiedCount, upserted: !!r.upsertedId };
};

// ─────────────────────────────────────────────────────────────────────────
// Tailor + Feed JSONs with 5-version history ring
// ─────────────────────────────────────────────────────────────────────────
// `data`     = tailor JSON (deep resume schema, drives /api/generate + DOCX)
// `feedData` = feed JSON   (slim schema, drives JD scoring + outreach drafts)
// `dataHistory[]` / `feedDataHistory[]` keep the previous 5 saves of each
// JSON (newest first) so a bad paste can be rolled back.

const HISTORY_DEPTH = 5;

// Generic helper — archives current value into the matching history array,
// caps it at HISTORY_DEPTH, and sets the new value atomically.
async function saveWithHistory(username, field, historyField, nextValue, who) {
  if (!username) throw new Error(`${field}: username required`);
  await ensureResumesIndex();
  const c = await col('users');
  const existing = await c.findOne({ username }, { projection: { [field]: 1, [historyField]: 1 } });
  const prev = existing?.[field];
  const history = Array.isArray(existing?.[historyField]) ? existing[historyField] : [];
  if (prev !== undefined && prev !== null) {
    history.unshift({ data: prev, savedAt: existing?.updatedAt || new Date().toISOString(), savedBy: who || null });
  }
  const capped = history.slice(0, HISTORY_DEPTH);
  const now = new Date().toISOString();
  const r = await c.updateOne(
    { username },
    {
      $set: {
        username,
        [field]: nextValue,
        [historyField]: capped,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
  // A resume save can shift experienceStart (or any meta field that
  // feeds {{exp}}). Drop the years-of-experience cache for this user so
  // the next connect-note resolves with fresh numbers.
  try {
    const { invalidateExperience } = await import('./users/experience.js');
    invalidateExperience(username);
  } catch { /* non-fatal; cache will refresh on its 24 h TTL anyway */ }
  return { upserted: !!r.upsertedId, savedAt: now };
}

export const saveTailorData = (username, nextData, who) =>
  saveWithHistory(username, 'data', 'dataHistory', nextData, who);

export const saveFeedData = (username, nextData, who) =>
  saveWithHistory(username, 'feedData', 'feedDataHistory', nextData, who);

// Fetch feed-side resume JSON. Returns null when the user has no feedData
// yet (callers should fall back to deriving from `data`).
export const getFeedResume = async (username) => {
  if (!username) return null;
  const doc = await (await col('users')).findOne(
    { username },
    { projection: { username: 1, feedData: 1, updatedAt: 1 } },
  );
  return doc?.feedData ? { username: doc.username, data: doc.feedData, updatedAt: doc.updatedAt } : null;
};

// Lightweight metadata for both history rings (no payloads).
export const getResumeHistoryMeta = async (username) => {
  if (!username) return { tailor: [], feed: [] };
  const doc = await (await col('users')).findOne(
    { username },
    { projection: { dataHistory: 1, feedDataHistory: 1 } },
  );
  const trim = (arr) => (arr || []).map((h, i) => ({
    index: i, savedAt: h.savedAt, savedBy: h.savedBy || null,
  }));
  return { tailor: trim(doc?.dataHistory), feed: trim(doc?.feedDataHistory) };
};

// Restore the i-th history entry back into the live field. The CURRENT
// live value is pushed onto the front of the history (so the restore
// itself is reversible).
export async function restoreFromHistory(username, which, index, who) {
  if (!username) throw new Error('restoreFromHistory: username required');
  const field        = which === 'feed' ? 'feedData'        : 'data';
  const historyField = which === 'feed' ? 'feedDataHistory' : 'dataHistory';
  const c = await col('users');
  const doc = await c.findOne({ username }, { projection: { [field]: 1, [historyField]: 1 } });
  if (!doc) throw new Error(`No resume for "${username}"`);
  const history = Array.isArray(doc[historyField]) ? doc[historyField] : [];
  if (index < 0 || index >= history.length) throw new Error(`history index ${index} out of range (0..${history.length - 1})`);
  return saveWithHistory(username, field, historyField, history[index].data, who);
}

// ─────────────────────────────────────────────────────────────────────────
// Shared scalar writes — keys present in BOTH tailor.personalInfo and the
// feed JSON top-level. One PATCH updates both at once.
// ─────────────────────────────────────────────────────────────────────────
const SHARED_SCALAR_KEYS = [
  'name', 'email', 'phone', 'location',
  'linkedin', 'github', 'portfolio', 'leetcode',
  'currentCTC', 'expectedCTC',
];

export const SHARED_SCALARS = SHARED_SCALAR_KEYS;

export async function saveSharedScalars(username, patch) {
  if (!username) throw new Error('saveSharedScalars: username required');
  await ensureResumesIndex();
  const c = await col('users');
  const sanitized = {};
  for (const k of SHARED_SCALAR_KEYS) {
    if (patch && k in patch && typeof patch[k] === 'string') sanitized[k] = patch[k];
  }
  if (Object.keys(sanitized).length === 0) return { matched: 0, modified: 0 };

  const set = { updatedAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(sanitized)) {
    // Tailor JSON keeps these under personalInfo.
    set[`data.personalInfo.${k}`] = v;
    // Feed JSON keeps name/email/etc. at top level under personalInfo too
    // (the new feed schema uses personalInfo, matching tailor).
    set[`feedData.personalInfo.${k}`] = v;
  }
  const r = await c.updateOne({ username }, { $set: set });
  return { matched: r.matchedCount, modified: r.modifiedCount, updated: sanitized };
}

// Replace the master PDF for a user. Buffer goes in as BSON Binary.
export const setUserPdf = async (username, { filename, contentType, buffer }) => {
  await ensureResumesIndex();
  if (!Buffer.isBuffer(buffer)) throw new Error('setUserPdf: buffer required');
  const r = await (await col('users')).updateOne(
    { username },
    { $set: {
      username,
      pdf: {
        filename: filename || 'resume.pdf',
        contentType: contentType || 'application/pdf',
        size: buffer.length,
        data: new Binary(buffer),
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    }},
    { upsert: true },
  );
  return { upserted: !!r.upsertedId };
};

// ── Email config (SMTP + from name) ──
// Stored on the user's own `users` doc under `emailConfig` so the operator
// can edit their send-as identity from /settings. The SMTP password is
// stored in plain text: this is a single-user tool talking to the operator's
// own database, and the mail sender needs the real value back. Treat the
// database as a secret.

export const getEmailConfig = async (username) => {
  if (!username) return null;
  const doc = await (await col('users')).findOne(
    { username },
    { projection: { emailConfig: 1 } },
  );
  return doc?.emailConfig || null;
};

export const setEmailConfig = async (username, cfg) => {
  await ensureResumesIndex();
  if (!username) throw new Error('setEmailConfig: username required');
  const next = {
    fromName: cfg.fromName || '',
    smtp: {
      host: cfg.smtp?.host || '',
      port: Number(cfg.smtp?.port) || 587,
      secure: !!cfg.smtp?.secure,
      user: cfg.smtp?.user || '',
      pass: cfg.smtp?.pass || '',
    },
    updatedAt: new Date().toISOString(),
  };
  await (await col('users')).updateOne(
    { username },
    { $set: { emailConfig: next } },
    { upsert: false },
  );
  return next;
};

// ── Per-user daily-reminder URLs ──
// List of URLs the apply page pops in new tabs on the first refresh-click
// each day (LinkedIn profile edit, Naukri profile, etc.) as a habit nudge.
// Empty/missing → no nudge, the checkbox in apply.html stays disabled.
//
// Validation lives both server-side (in setDailyReminders) and client-side
// (settings.html shows inline errors). Server is authoritative.

export const getDailyReminders = async (username) => {
  if (!username) return [];
  const doc = await (await col('users')).findOne(
    { username },
    { projection: { dailyReminderUrls: 1 } },
  );
  return Array.isArray(doc?.dailyReminderUrls) ? doc.dailyReminderUrls : [];
};

// Validate + persist. Throws on invalid input so the server endpoint
// returns 400 with a useful error. Acceptable URLs: http/https only,
// parseable by `new URL()`, no longer than 2000 chars.
export const setDailyReminders = async (username, urls) => {
  if (!username) throw new Error('setDailyReminders: username required');
  if (!Array.isArray(urls)) throw new Error('urls must be an array');
  const cleaned = [];
  for (const raw of urls) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (s.length > 2000) throw new Error(`URL too long (>2000 chars): ${s.slice(0, 60)}…`);
    let parsed;
    try { parsed = new URL(s); } catch { throw new Error(`Not a valid URL: ${s}`); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Only http/https allowed: ${s}`);
    cleaned.push(parsed.toString());
  }
  // Dedupe while preserving first-occurrence order.
  const seen = new Set();
  const final = cleaned.filter(u => seen.has(u) ? false : (seen.add(u), true));
  await (await col('users')).updateOne(
    { username },
    { $set: { dailyReminderUrls: final } },
    { upsert: false },
  );
  return final;
};

// ── Tailored variants (resume_variants) ──

// Save a tailored variant — every fresh generation appends a new doc so we
// keep a full history. `pdfPath` is read from disk and stored as Binary.
export const saveVariant = async ({
  username,
  jobTitle,
  jobCompany,
  jobDescription,
  aiResponse,
  email,
  linkedInDM,
  resumeJson,
  pdfPath,
  atsScore,
  mode,
  modelLabel,
  provider,
  storePdf = true,
}) => {
  if (!username) throw new Error('saveVariant: username required');
  const doc = {
    username,
    jobTitle: jobTitle || '',
    jobCompany: jobCompany || '',
    jobDescription: jobDescription || '',
    aiResponse: aiResponse || null,
    resumeJson: resumeJson || null,
    email: email || null,
    linkedInDM: linkedInDM || null,
    atsScore: atsScore ?? null,
    mode: mode || 'strict',
    modelLabel: modelLabel || null,
    provider: provider || null,
    generatedAt: new Date().toISOString(),
  };
  // Batch tailoring passes storePdf:false — thirty-odd resumes per run, each
  // regenerated freely and deleted from the outbox the moment the job is
  // applied to or rejected, is a lot of Binary to keep in a free-tier cluster.
  // Those variants keep `pdfPath` instead and are served from disk; the single
  // /api/generate path still embeds, since its output isn't in the outbox and
  // has no local file to fall back on.
  if (storePdf && pdfPath && fs.existsSync(pdfPath)) {
    const buffer = fs.readFileSync(pdfPath);
    doc.pdf = {
      filename: pdfPath.split('/').pop(),
      contentType: 'application/pdf',
      size: buffer.length,
      data: new Binary(buffer),
    };
  }
  const r = await (await col('resume_variants')).insertOne(doc);
  return { _id: r.insertedId, generatedAt: doc.generatedAt };
};

export const listVariants = async (username, opts = {}) => {
  const limit = opts.limit ?? 50;
  const docs = await (await col('resume_variants'))
    .find({ username }, { projection: { 'pdf.data': 0, jobDescription: 0, aiResponse: 0 } })
    .sort({ generatedAt: -1 })
    .limit(limit)
    .toArray();
  return docs;
};

export const getVariantPdf = async (variantId) => {
  const { ObjectId } = await import('mongodb');
  const doc = await (await col('resume_variants')).findOne(
    { _id: new ObjectId(variantId) },
    { projection: { pdf: 1, jobTitle: 1, jobCompany: 1 } },
  );
  if (!doc?.pdf?.data) return null;
  const data = doc.pdf.data;
  return {
    filename: doc.pdf.filename,
    contentType: doc.pdf.contentType,
    buffer: data.buffer || Buffer.from(data),
  };
};
