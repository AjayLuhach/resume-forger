// AI over fetched mail: draft a reply, extract tasks, or compose from a pasted
// job post. Every entry point refuses non-automatable mail — the gate in
// classify.js is the only thing standing between this and a bank email.

import { bedrockChat } from '../providers/bedrock-transport.js';
import { parseLooseJSON } from '../providers/json-repair.js';
import { buildSignoff } from '../feed/signoff.js';

const MODEL = process.env.BEDROCK_MODEL_ID || 'google.gemma-3-27b-it';

// Open-weight models routinely emit raw newlines inside JSON strings; the
// repo already has the repairer for exactly that (services/providers/json-repair.js).
const parseJSON = (raw) => parseLooseJSON(raw);

// Compensation is stated in the prompt's facts, not the sign-off, here.
const sigOf = (cand) => buildSignoff(cand, { salary: false });

const roleOf = (c) => c?.currentTitle || (c?.stack ? `${c.stack} developer` : 'software developer');

// Only what the resume states. A missing notice period or location is left
// out entirely, so the model reaches for a [placeholder] under the rules
// below instead of a default that belonged to somebody else.
const candidateFacts = (c) => {
  const notice = c.preferences?.noticePeriod || c.noticePeriod || null;
  return [
    `- ${c.experience ? `${c.experience} of experience, ` : ''}${roleOf(c)}`,
    `- Key skills: ${(c.skills || []).slice(0, 15).join(', ')}`,
    `- Current compensation: ${c.currentCTC || 'not disclosed'} | Expected: ${c.expectedCTC || 'negotiable'}`,
    notice ? `- Notice period: ${notice}` : null,
    c.location ? `- Location: ${c.location}` : null,
  ].filter(Boolean);
};

/** Draft a reply to a recruiter's question. Returns { subject, body }. */
export async function draftReply(mail, candidate) {
  if (!mail.automatable) throw new Error('mail is not automatable — held for review');
  const prompt = `You are drafting a REPLY that ${candidate.name}, a job candidate, will send to a recruiter.

THEIR EMAIL:
From: ${mail.from}
Subject: ${mail.subject}
${String(mail.body).slice(0, 4000)}

ABOUT THE CANDIDATE:
${candidateFacts(candidate).join('\n')}

RULES:
- Answer every question they actually asked. Do not invent facts not listed above.
- If they asked something the facts above cannot answer, write a placeholder in
  square brackets, e.g. [confirm your availability] — never guess.
- 60-120 words, plain text, no markdown, no sign-off (one is appended).
- Match their register: terse if terse, warm if warm.
- Never restate their entire email back to them.

Return ONLY: {"subject":"...","body":"...","unanswered":["..."]}
"unanswered" lists anything you had to leave as a placeholder.`;

  const r = await bedrockChat({ model: MODEL, prompt, maxTokens: 1200, temperature: 0.4, label: 'reply' });
  const out = parseJSON(r.text);
  return {
    subject: out.subject || `Re: ${String(mail.subject).replace(/^re:\s*/i, '')}`,
    body: `${String(out.body || '').trim()}${sigOf(candidate)}`,
    unanswered: out.unanswered || [],
  };
}

/** Pull actionable items with deadlines out of a mail. Returns tasks[]. */
export async function extractTasks(mail) {
  if (!mail.automatable) throw new Error('mail is not automatable — held for review');
  const prompt = `Extract what the recipient must DO from this email. Nothing else.

Subject: ${mail.subject}
Received: ${mail.receivedAt}
${String(mail.body).slice(0, 4000)}

Return ONLY: {"tasks":[{"title":"...","kind":"assessment|interview|document|form|other","dueAt":"YYYY-MM-DD or null","urgency":"high|medium|low","detail":"one line","link":"url or null"}]}

RULES:
- Only concrete obligations on the recipient. "We will get back to you" is NOT a task.
- dueAt: resolve relative deadlines against the received date ("within 48 hours" -> that date). null if none stated.
- urgency high only when a deadline is inside 3 days or the text says urgent.
- Empty array if there is nothing to do.`;

  const r = await bedrockChat({ model: MODEL, prompt, maxTokens: 1200, temperature: 0.1, label: 'tasks' });
  return (parseJSON(r.text).tasks || []).slice(0, 10);
}

/** Compose a cold email from pasted post/JD text. Returns { to, subject, body }. */
export async function composeFromText(text, candidate) {
  const found = String(text).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  const prompt = `Write a short job-application email from this job post.

POST:
${String(text).slice(0, 6000)}

CANDIDATE: ${[candidate.name, candidate.experience, roleOf(candidate)].filter(Boolean).join(', ')}.
Key skills: ${(candidate.skills || []).slice(0, 15).join(', ')}
Summary: ${candidate.summary || ''}

RULES:
- 90-140 words, one flowing paragraph, plain text.
- Open with a generic greeting on its own line, then a blank line.
- Name 2-3 technologies from the post that the candidate genuinely has.
- Never claim a skill not in the list above. Never invent a location or employer.
- No sign-off — one is appended.

Return ONLY: {"to":"best email from the post or empty","subject":"...","body":"..."}`;

  const r = await bedrockChat({ model: MODEL, prompt, maxTokens: 1600, temperature: 0.4, label: 'compose' });
  const out = parseJSON(r.text);
  const ctc = candidate.currentCTC && candidate.expectedCTC
    ? `\n\nCurrent CTC: ${candidate.currentCTC} | Expected CTC: ${candidate.expectedCTC}` : '';
  return {
    to: out.to || found[0] || '',
    subject: out.subject || 'Application',
    body: `${String(out.body || '').trim()}${ctc}${sigOf(candidate)}`,
    detectedEmails: [...new Set(found)],
  };
}
