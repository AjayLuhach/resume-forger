/**
 * Connection-request outreach queue.
 *
 * The other half of the feed pipeline. `user_emails` handles posts that
 * published an address; this handles the ones that didn't — roughly half the
 * pool — where the only way through is a LinkedIn connection request.
 *
 * The flow is deliberately three states rather than one, because the two steps
 * are days apart and only the middle one is observable:
 *
 *   invited    — the operator sent the request. LinkedIn has no API for this,
 *                so "sent" is recorded when they click through to the profile.
 *   connected  — the person accepted. Detected passively: when the extension
 *                next scrapes the connections page, `markAcceptedFromConnections`
 *                matches new rows against outstanding invites by profile URL.
 *   messaged   — the follow-up went out.
 *
 * Rows are keyed by (username, postId) exactly like user_emails, so the same
 * post can be worked independently by both operators.
 *
 * No invitation note is drafted on purpose: notes are capped at 300 characters,
 * and a request without one is both faster to send and no less likely to be
 * accepted. The written message comes later, once there is a thread to put it in.
 */

import { col } from '../db.js';
import { connectsMirror, connectionsMirror } from '../mirror.js';

const CONNECTS = () => col('user_connects');

export const CONNECT_STATUSES = ['queued', 'invited', 'connected', 'messaged', 'skipped'];

// LinkedIn profile URLs arrive with varying case, trailing slashes and tracking
// params. Compare on the slug alone or the same person reads as two people.
export const profileKey = (url) => {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
};

const _hydrate = (d) => {
  if (!d) return null;
  const { _id, ...rest } = d;
  return { ...rest, _id: String(_id) };
};

const _refresh = async (filter) => {
  const c = await CONNECTS();
  const docs = await c.find(filter).toArray();
  if (docs.length) connectsMirror.applyMany(docs);
  return docs;
};

/**
 * Queue (or re-queue) a post for a connection request.
 * Idempotent: re-inviting an existing row only moves it forward, never back,
 * so a double click can't reset someone who has already accepted.
 */
export const queueConnect = async ({ username, post, status = 'invited' }) => {
  if (!username) throw new Error('queueConnect: username required');
  const profileUrl = post?.poster?.profileUrl;
  if (!profileUrl) throw new Error('queueConnect: post has no poster.profileUrl');

  const c = await CONNECTS();
  const now = new Date().toISOString();
  const key = profileKey(profileUrl);

  // If this person is ALREADY a connection, there is nothing to invite —
  // jump straight to `connected` so they surface in the follow-up queue.
  const already = connectionsMirror.loaded
    ? connectionsMirror.all().find((x) => profileKey(x.profileUrl) === key
        && (x.owners || []).includes(username))
    : null;
  const effective = already ? 'connected' : status;

  await c.updateOne(
    { username, postId: post.postId },
    {
      $set: {
        username,
        postId: post.postId,
        profileUrl,
        profileKey: key,
        posterName: post.poster?.name || '',
        headline: post.poster?.headline || '',
        degree: post.poster?.degree || null,
        job: {
          title: post.job?.title || '',
          company: post.job?.company || '',
          requirements: post.job?.requirements || [],
        },
        postSummary: post.summary || '',
        status: effective,
        [effective === 'connected' ? 'connectedAt' : 'invitedAt']: now,
      },
      $setOnInsert: { queuedAt: now, message: '', messagedAt: null },
    },
    { upsert: true },
  );
  const [doc] = await _refresh({ username, postId: post.postId });
  return _hydrate(doc);
};

/**
 * Record what the extension's auto-connect did on a profile page. `result` is
 * one of sent | pending | already-connected | limit | not-found | error |
 * timeout. Rows are found by profileKey (the same slug rule everything else
 * uses), so a profile URL with tracking params still lands on the right
 * invite; only queued/invited rows are touched.
 */
export const markAutoConnect = async ({ username, profileUrl, result, detail = '' }) => {
  if (!username) throw new Error('markAutoConnect: username required');
  const key = profileKey(profileUrl);
  if (!key) throw new Error('markAutoConnect: profileUrl required');
  const c = await CONNECTS();
  const now = new Date().toISOString();
  const set = { autoConnect: { result: String(result), detail: String(detail || '').slice(0, 600), at: now } };
  if (result === 'already-connected') { set.status = 'connected'; set.connectedAt = now; }
  else if (result === 'sent' || result === 'pending') {
    // `invited` alone is not proof: the Posts page writes it before the
    // extension has touched LinkedIn. This is the stamp that says LinkedIn
    // showed the request as sent / Pending, so the profile is never opened
    // again. A later auto result overwrites `autoConnect`, never this.
    set.status = 'invited'; set.invitedAt = now; set.inviteConfirmedAt = now;
  }
  const r = await c.updateMany(
    { username, profileKey: key, status: { $in: ['queued', 'invited'] } },
    { $set: set },
  );
  const docs = await _refresh({ username, profileKey: key });
  return { matched: r.matchedCount, rows: docs.map(_hydrate) };
};

/**
 * Flip outstanding invites to `connected` when the person shows up among the
 * owner's connections. Called from upsertConnections, so acceptance is picked
 * up by the same scrape that refreshes the connections page — no polling and
 * no extra step for the operator.
 *
 * @param {object[]} records - the connection rows just upserted
 * @param {string} owner - the operator those rows belong to
 * @returns {number} how many invites flipped
 */
export const markAcceptedFromConnections = async ({ records = [], owner } = {}) => {
  if (!owner || !records.length) return 0;
  const keys = [...new Set(records.map((r) => profileKey(r?.profileUrl)).filter(Boolean))];
  if (!keys.length) return 0;

  const c = await CONNECTS();
  const now = new Date().toISOString();
  const filter = {
    username: owner,
    profileKey: { $in: keys },
    status: { $in: ['queued', 'invited'] },
  };
  const pending = await c.find(filter, { projection: { postId: 1 } }).toArray();
  if (!pending.length) return 0;

  await c.updateMany(filter, { $set: { status: 'connected', connectedAt: now } });
  await _refresh({ username: owner, postId: { $in: pending.map((d) => d.postId) } });
  return pending.length;
};

export const setConnectStatus = async ({ username, postId, status, message }) => {
  if (!CONNECT_STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  const c = await CONNECTS();
  const now = new Date().toISOString();
  const set = { status };
  if (status === 'messaged') set.messagedAt = now;
  if (typeof message === 'string') set.message = message;
  await c.updateOne({ username, postId }, { $set: set });
  const [doc] = await _refresh({ username, postId });
  return _hydrate(doc);
};

export const saveConnectMessage = async ({ username, postId, message }) => {
  const c = await CONNECTS();
  await c.updateOne({ username, postId }, { $set: { message: String(message || '') } });
  const [doc] = await _refresh({ username, postId });
  return _hydrate(doc);
};

export const getConnect = async ({ username, postId }) => {
  if (connectsMirror.loaded) {
    return _hydrate(connectsMirror.all().find((d) => d.username === username && d.postId === postId));
  }
  return _hydrate(await (await CONNECTS()).findOne({ username, postId }));
};

// Nothing left to send: LinkedIn confirmed the request (sent or Pending), or
// the person already accepted. Rows from before `inviteConfirmedAt` existed
// only carry the auto result.
const AUTO_DONE = new Set(['sent', 'pending', 'already-connected']);
export const isInviteDone = (row) => !!row && (
  !!row.inviteConfirmedAt
  || AUTO_DONE.has(row.autoConnect?.result)
  || row.status === 'connected' || row.status === 'messaged'
);

/**
 * This user's connect state per person (profileKey → { status, autoResult,
 * done }). Keyed by person rather than post: someone with three hiring posts
 * gets one request, so a confirmed invite on any of their rows marks them all.
 */
export const connectStateByProfile = async (username) => {
  const rows = connectsMirror.loaded
    ? connectsMirror.filter((d) => d.username === username)
    : await (await CONNECTS()).find({ username }, {
      projection: { profileKey: 1, profileUrl: 1, status: 1, autoConnect: 1, inviteConfirmedAt: 1 },
    }).toArray();
  const out = new Map();
  for (const r of rows) {
    const key = r.profileKey || profileKey(r.profileUrl);
    if (!key) continue;
    const prev = out.get(key);
    const done = isInviteDone(r);
    if (prev?.done && !done) continue;
    out.set(key, { status: r.status, autoResult: r.autoConnect?.result || null, done: done || !!prev?.done });
  }
  return out;
};

/** Post ids this user already has a connect row for — used to hide them from the queue. */
export const listConnectedPostIds = async (username) => {
  if (connectsMirror.loaded) {
    return new Set(connectsMirror.all().filter((d) => d.username === username).map((d) => d.postId));
  }
  const docs = await (await CONNECTS()).find({ username }, { projection: { postId: 1 } }).toArray();
  return new Set(docs.map((d) => d.postId));
};

export const listConnects = async ({ username, status = null, limit = 200 } = {}) => {
  const match = (d) => d.username === username && (!status || d.status === status);
  // Newest activity first — a row that just flipped to `connected` is the one
  // worth acting on, not the invite sent last week.
  const stamp = (d) => d.messagedAt || d.connectedAt || d.invitedAt || d.queuedAt || '';
  if (connectsMirror.loaded) {
    const rows = connectsMirror.filter(match).sort((a, b) => String(stamp(b)).localeCompare(String(stamp(a))));
    return { items: rows.slice(0, limit).map(_hydrate), total: rows.length };
  }
  const q = { username, ...(status ? { status } : {}) };
  const c = await CONNECTS();
  const rows = await c.find(q).limit(limit).toArray();
  const total = await c.countDocuments(q);
  return { items: rows.map(_hydrate).sort((a, b) => String(stamp(b)).localeCompare(String(stamp(a)))), total };
};

export const connectCounts = async (username) => {
  const out = Object.fromEntries(CONNECT_STATUSES.map((s) => [s, 0]));
  const rows = connectsMirror.loaded
    ? connectsMirror.filter((d) => d.username === username)
    : await (await CONNECTS()).find({ username }, { projection: { status: 1 } }).toArray();
  for (const d of rows) if (out[d.status] != null) out[d.status] += 1;
  return out;
};

/**
 * The messaging deep-link for someone we're now connected to. LinkedIn needs
 * the fsd profile urn to open a compose window; that only exists on the scraped
 * connection row, so fall back to the profile page when it's absent.
 */
export const messageUrlFor = (row) => {
  if (!connectionsMirror.loaded) return row.profileUrl;
  const key = row.profileKey || profileKey(row.profileUrl);
  const conn = connectionsMirror.all().find((x) => profileKey(x.profileUrl) === key);
  return conn?.messageUrl || row.profileUrl;
};
