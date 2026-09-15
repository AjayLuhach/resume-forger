// `user_inbox` — one row per (username, messageId). Mirrored + stamped.
// Holds only what the UI needs; the mailbox stays the source of truth.

import { col } from '../db.js';
import { inboxMirror } from '../mirror.js';
import { classify } from './classify.js';

const norm = (s) => String(s || '').replace(/^(re|fwd|fw)\s*:\s*/gi, '').trim().toLowerCase();
const key = (username, messageId) => `${username}::${messageId}`;

/**
 * Ingest a fetched batch. Correlates replies to our sent mail, then classifies.
 *
 * `windowStart` turns this into a reconcile: within the range IMAP actually
 * searched, the mailbox is authoritative, so a stored row whose message no
 * longer comes back has been deleted (or archived) upstream and is dropped.
 * Rows older than the window are left alone — we have no evidence about them.
 */
export async function ingest(username, mails, { sentIndex = new Map(), windowStart = null } = {}) {
  if (!mails.length) return { added: 0, updated: 0, buckets: {} };
  const c = await col('user_inbox');
  const existing = new Set(
    (await c.find({ username }, { projection: { messageId: 1 } }).toArray()).map((d) => d.messageId)
  );

  // Subjects we have sent on — a cheap thread test that works even when the
  // recipient's client drops In-Reply-To, which many webmail clients do.
  const ourSubjects = new Set([...sentIndex.keys()].map(norm));

  const docs = [];
  const buckets = {};
  for (const m of mails) {
    if (!m.messageId || m.direction !== 'inbound') continue;   // outbound is context, not a row
    if (existing.has(m.messageId)) continue;

    const refs = [m.inReplyTo, ...(m.references || [])].filter(Boolean);
    const linked = refs.map((r) => sentIndex.get(r)).find(Boolean) || null;
    const isKnownThread = !!linked || ourSubjects.has(norm(m.subject));

    const verdict = classify(m, { isKnownThread });
    buckets[verdict.bucket] = (buckets[verdict.bucket] || 0) + 1;

    docs.push({
      username,
      messageId: m.messageId,
      threadKey: norm(m.subject),
      from: m.from, fromAddr: m.fromAddr, subject: m.subject,
      body: m.body, receivedAt: m.date, hasAttachments: m.hasAttachments,
      bucket: verdict.bucket, reason: verdict.reason, automatable: verdict.automatable,
      linkedPostId: linked?.postId || null,
      linkedJobTitle: linked?.jobTitle || null,
      status: 'new',              // new | drafted | replied | done | dismissed
      draft: '', tasks: [],
      handledAt: null,
    });
  }
  if (docs.length) {
    await c.insertMany(docs);
    inboxMirror.applyMany(docs);
  }

  const removed = windowStart ? await reconcile(username, mails, windowStart) : 0;
  return { added: docs.length, updated: 0, removed, buckets };
}

/** Drop rows inside the fetched window that the mailbox no longer returns. */
async function reconcile(username, mails, windowStart) {
  const seenNow = new Set(mails.filter((m) => m.direction === 'inbound' && m.messageId).map((m) => m.messageId));
  if (!seenNow.size) return 0;                       // an empty fetch proves nothing
  const since = new Date(windowStart).toISOString();

  const c = await col('user_inbox');
  const held = await c.find(
    { username, receivedAt: { $gte: since } },
    { projection: { _id: 1, messageId: 1 } }
  ).toArray();

  const gone = held.filter((d) => d.messageId && !seenNow.has(d.messageId));
  if (!gone.length) return 0;
  await c.deleteMany({ _id: { $in: gone.map((d) => d._id) } });
  // Mirrors have no tombstones (a documented trade-off), and they key on _id —
  // evict by hand or the row keeps serving from memory until a restart.
  for (const d of gone) inboxMirror.delete(String(d._id));
  return gone.length;
}

// bucket 'all' is the raw Inbox view: every fetched message, dismissed ones
// included, so nothing the classifier routed can go missing from sight.
const matcher = (p) => (d) => {
  if (d.username !== p.username) return false;
  const all = p.bucket === 'all';
  if (p.bucket && !all && d.bucket !== p.bucket) return false;
  if (p.status && d.status !== p.status) return false;
  if (!all && p.status === undefined && d.status === 'dismissed') return false;
  return true;
};

export async function listInbox(params = {}) {
  const limit = Number(params.limit || 200);
  if (inboxMirror.loaded) {
    return inboxMirror.filter(matcher(params))
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
      .slice(0, limit);
  }
  const c = await col('user_inbox');
  const f = { username: params.username };
  if (params.bucket && params.bucket !== 'all') f.bucket = params.bucket;
  if (params.status) f.status = params.status;
  return c.find(f).sort({ receivedAt: -1 }).limit(limit).toArray();
}

export async function inboxCounts(username) {
  const rows = inboxMirror.loaded
    ? inboxMirror.filter((d) => d.username === username)
    : await (await col('user_inbox')).find({ username }).toArray();
  const out = { all: rows.length, reply: 0, task: 0, review: 0, done: 0 };
  for (const d of rows) {
    if (d.status === 'done' || d.status === 'dismissed') { out.done++; continue; }
    out[d.bucket] = (out[d.bucket] || 0) + 1;
  }
  return out;
}

/** Patch one row and keep the mirror current. */
export async function setInbox(username, messageId, patch) {
  const c = await col('user_inbox');
  await c.updateOne({ username, messageId }, { $set: patch });
  const doc = await c.findOne({ username, messageId });
  if (doc) inboxMirror.set(doc);
  return doc;
}

/** Cursor for the next poll — newest row we hold, minus a day of overlap. */
export async function lastSeen(username) {
  const rows = inboxMirror.loaded
    ? inboxMirror.filter((d) => d.username === username)
    : await (await col('user_inbox')).find({ username }, { projection: { receivedAt: 1 } }).toArray();
  if (!rows.length) return null;
  const newest = rows.reduce((a, b) => (String(a.receivedAt) > String(b.receivedAt) ? a : b));
  return new Date(new Date(newest.receivedAt).getTime() - 24 * 3600 * 1000);
}

export const _key = key;
