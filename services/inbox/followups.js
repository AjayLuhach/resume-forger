// Who is worth nudging, and why. Two populations, deliberately separate:
//
//   silent  — we emailed, nothing ever came back.
//   stalled — they DID reply, the thread then went cold. Far more valuable:
//             a live conversation that lapsed beats a cold contact, and these
//             were previously invisible because nothing tracked replies.
//
// Suppression rules live here so a nudge can never become the 3rd+ touch on
// someone who is already over-contacted (see the 1,545 double-mailed
// recruiters in the outreach audit).

import { userEmailsMirror, inboxMirror } from '../mirror.js';
import { col } from '../db.js';

const DAY = 864e5;
const days = (iso) => (Date.now() - new Date(iso).getTime()) / DAY;

/**
 * @returns {Promise<{stalled:object[], silent:object[]}>}
 */
export async function findFollowUps(username, { silentAfter = 7, stalledAfter = 5, max = 60 } = {}) {
  const sent = userEmailsMirror.loaded
    ? userEmailsMirror.filter((d) => d.username === username && d.status === 'sent')
    : await (await col('user_emails')).find({ username, status: 'sent' }).toArray();

  const inbox = inboxMirror.loaded
    ? inboxMirror.filter((d) => d.username === username)
    : await (await col('user_inbox')).find({ username }).toArray();

  // Everyone who has ever replied to us, and when they last did.
  const repliedBy = new Map();
  for (const m of inbox) {
    const at = m.receivedAt;
    if (!at) continue;
    const prev = repliedBy.get(m.fromAddr);
    if (!prev || String(at) > String(prev.at)) repliedBy.set(m.fromAddr, { at, row: m });
  }

  // How many times we have mailed each address, ever — the suppression input.
  const touches = new Map();
  for (const r of sent) {
    const to = String(r.email?.to || '').toLowerCase();
    if (to) touches.set(to, (touches.get(to) || 0) + 1);
  }

  const stalled = [];
  const silent = [];
  for (const r of sent) {
    const to = String(r.email?.to || '').toLowerCase();
    if (!to) continue;
    if (r.followUpAt) continue;                      // already nudged once — never twice
    if ((touches.get(to) || 0) > 2) continue;        // already over-contacted; do not add
    const sentAt = r.sentAt || r.updatedAt;
    if (!sentAt) continue;

    const reply = repliedBy.get(to);
    if (reply) {
      // They answered. Did the thread then stop, and did WE speak last?
      const quiet = days(reply.at);
      if (quiet >= stalledAfter && reply.row.status !== 'replied') {
        stalled.push({
          kind: 'stalled', to, postId: r.postId, subject: r.email?.subject,
          jobTitle: r.job?.title, company: r.job?.company,
          lastReplyAt: reply.at, quietDays: Math.round(quiet),
          theirLastMessage: String(reply.row.body || '').slice(0, 1500),
          ourLastMessage: String(r.email?.body || '').slice(0, 1500),
          messageId: reply.row.messageId,
        });
      }
      continue;
    }

    const age = days(sentAt);
    if (age >= silentAfter && age <= 45) {           // past 45d it is not a nudge, it is noise
      silent.push({
        kind: 'silent', to, postId: r.postId, subject: r.email?.subject,
        jobTitle: r.job?.title, company: r.job?.company,
        sentAt, quietDays: Math.round(age),
        ourLastMessage: String(r.email?.body || '').slice(0, 1500),
      });
    }
  }

  // Newest activity first: a thread that went quiet yesterday is more
  // recoverable than one abandoned a month ago.
  stalled.sort((a, b) => a.quietDays - b.quietDays);
  silent.sort((a, b) => a.quietDays - b.quietDays);
  return { stalled: stalled.slice(0, max), silent: silent.slice(0, max) };
}

/** Mark a row nudged so it can never surface again. */
export async function markFollowedUp(username, postId) {
  const c = await col('user_emails');
  await c.updateOne({ username, postId }, { $set: { followUpAt: new Date().toISOString() } });
  const doc = await c.findOne({ username, postId });
  if (doc) userEmailsMirror.set(doc);
  return doc;
}
