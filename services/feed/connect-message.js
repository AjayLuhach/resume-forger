/**
 * Follow-up message drafting for accepted connection requests.
 *
 * This is NOT the invitation — invitations go out without a note. This is the
 * message sent once the request is accepted and a real thread exists, so it can
 * be longer and more specific than a 300-character invite note.
 *
 * The context that makes it worth sending is the post itself: the message
 * references the role they posted about, which is the whole reason they were
 * invited. Without that it reads as a cold template and gets ignored.
 */

import { bedrockChat } from '../providers/bedrock-transport.js';
import config, { candidateRole } from './feed-config.js';

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Deterministic fallback used when the model is unreachable or returns junk.
 * Plain, short, and honest — a bad draft the operator edits still beats an
 * empty box, and this path must never throw.
 *
 * It states only what the candidate object says: no years when the start
 * date is unknown, no stack the candidate didn't list. A template that
 * invents a years figure or a named stack for whoever runs it is worse than
 * a shorter one.
 */
export function fallbackMessage(row, candidate) {
  const role = row.job?.title || 'the role';
  const at = row.job?.company ? ` at ${row.job.company}` : '';
  const title = candidate?.currentTitle || 'developer';
  const article = /^[aeiou]/i.test(title) ? 'an' : 'a';
  const exp = candidate?.experience ? ` with ${candidate.experience} of experience` : '';
  const skills = (candidate?.skills || []).slice(0, 4).join(', ');
  const across = skills || candidate?.stack || '';
  return [
    `Hi ${String(row.posterName || '').split(' ')[0] || 'there'}, thanks for connecting.`,
    '',
    `I saw your post about ${role}${at}. I'm ${article} ${title}${exp}${across ? ` across ${across}` : ''}, and it lines up closely with what you described.`,
    '',
    `Happy to send my resume across if the role is still open.`,
  ].join('\n');
}

function buildPrompt(rows, candidate) {
  const items = rows.map((r) => ({
    postId: r.postId,
    name: r.posterName,
    headline: clip(r.headline, 160),
    jobTitle: r.job?.title || null,
    company: r.job?.company || null,
    requirements: (r.job?.requirements || []).slice(0, 8),
    postSummary: clip(r.postSummary, 400),
  }));

  const facts = [
    `- Name: ${candidate?.name || 'the candidate'}`,
    `- Role: ${candidateRole(candidate)}`,
    candidate?.experience ? `- Experience: ${candidate.experience}` : null,
    `- Key skills: ${(candidate?.skills || []).slice(0, 15).join(', ')}`,
  ].filter(Boolean);

  return `Write short LinkedIn follow-up messages. Each recipient has just ACCEPTED a connection request from the candidate. This is the first message in a brand new thread — not a cold outreach, and not a connection-request note.

RECIPIENTS:
${JSON.stringify(items, null, 2)}

CANDIDATE:
${facts.join('\n')}

FOR EACH RECIPIENT return a message that:
- opens by thanking them for connecting, using their FIRST NAME only
- refers to the specific role from their post in the first two lines, so it is obviously not a template
- states the candidate's experience ONLY if it is listed above, and names 2-3 skills that overlap with THEIR stated requirements — never claim a skill absent from the candidate's list above, never state years that are not listed
- ends by offering to send a resume
- is 60-90 words, plain text, no emoji, no bullet points, no subject line, no sign-off
- never invents a location, a mutual contact, a shared employer, or a referral

RESPOND WITH ONLY A JSON OBJECT (no markdown, no code fences):
{"messages":[{"postId":"<id>","message":"<text>"}]}`;
}

/**
 * Draft messages for a batch of accepted connections.
 * Always returns one entry per input row — the fallback fills any the model
 * missed, so a partial or malformed response degrades instead of failing.
 *
 * @returns {Map<string, string>} postId → message
 */
export async function draftConnectMessages(rows, candidate) {
  const out = new Map();
  if (!rows.length) return out;

  try {
    const { text } = await bedrockChat({
      model: config.bedrock?.modelId,
      prompt: buildPrompt(rows, candidate),
      maxTokens: 4096,
      temperature: 0.4,
      topP: 0.9,
      label: 'feed:connect-message',
    });
    const json = JSON.parse(String(text).replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
    for (const m of (json.messages || [])) {
      if (m?.postId && m?.message) out.set(String(m.postId), String(m.message).trim());
    }
  } catch { /* fall through to the deterministic draft below */ }

  for (const r of rows) {
    if (!out.has(r.postId)) out.set(r.postId, fallbackMessage(r, candidate));
  }
  return out;
}
