// Routing gate for fetched mail. Deterministic, no AI: decides what may be
// automated at all. Anything not confidently job-related lands in `review`,
// where nothing is ever auto-drafted or auto-sent.

// Hard block — these never reach the AI, never get a draft, never get a task.
// Financial and delivery mail is the stated worry, but the real rule is
// broader: anything transactional about money, credentials or physical goods.
const BLOCK = [
  // Phrases, not domain nouns. "bank"/"sip"/"emi" as bare words wrongly caught
  // real recruiter mail — Indian JDs say "banking domain" constantly, and an
  // AI Engineer (Voice) JD says SIP because it is a telephony protocol.
  /\b(net ?banking|debit card|credit card|card ending|account statement|available balance)\b/i,
  /\b(has been (credited|debited)|transaction of|payment (of|due|failed|received)|amount of (inr|rs|₹))\b/i,
  /\b(otp|one[- ]time password|verification code|password reset|reset your password)\b/i,
  /\b(security alert|suspicious (sign|login)|unusual activity on your)\b/i,
  /\b(your (order|parcel|shipment)|out for delivery|has been (shipped|delivered)|tracking (id|number))\b/i,
  /\b(invoice (no|#|number)|subscription (renew|expir)|auto[- ]?debit|mandate)\b/i,
  /\b(kyc|demat|mutual fund|systematic investment|loan (application|approved|offer)|emi (due|payment))\b/i,
  /\b(swiggy|zomato|blinkit|zepto|bigbasket|myntra|flipkart)\b/i,
];

// Senders that are never a hiring counterpart. Split local-part from domain —
// the address is usually "Name <a@b.com>", and no-reply is a LOCAL part.
const NOREPLY_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|noreply|alerts?|notifications?|notify|billing|invoices?|support|info|newsletter|mailer-daemon|postmaster|bounce)$/i;
const BLOCK_DOMAIN = /(?:^|\.)(?:linkedin|naukri|indeed|glassdoor|instahyre|wellfound|monster|shine|timesjobs)\.(?:com|co\.in|in)$/i;
const addrOf = (from) => {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
};

// Required to be considered job mail at all. Deliberately narrower than
// opening-tracker's list: "role", "job" and "cv" alone matched newsletters.
const JOB = [
  /\b(interview|shortlist(ed)?|candidature|your application|applied for|application for)\b/i,
  /\b(assessment|assignment|coding (test|challenge|round)|take[- ]home|hackerrank|codility|hackerearth|dsa round)\b/i,
  /\b(offer letter|ctc|lpa|notice period|joining date|onboarding|hr round|technical round)\b/i,
  /\b(hiring|recruit(er|ment)|opening|vacancy|position at|opportunity at)\b/i,
  /\b(resume|profile) (attached|shared|received|looks)\b/i,
  // Calendar invites for a call are the most actionable mail there is, and
  // carry none of the words above — they were landing in review.
  /\b(invitation:|updated invitation:|google meet|microsoft teams meeting|zoom meeting|calendly)\b/i,
];

// Actionable-with-a-deadline signals — drives the Tasks section.
const TASK = [
  /\b(assessment|assignment|coding (test|challenge)|take[- ]home|case study|submit(ted|ssion)?)\b/i,
  /\b(complete (it|this|the)|deadline|due (by|on)|within (24|48|72) hours|by (mon|tue|wed|thu|fri|sat|sun)|expires?)\b/i,
  /\b(schedule|book (a|your) slot|availability|calendar|reschedul)/i,
  /\b(fill (out|in)|form|document(s)? required|share your (details|documents))\b/i,
  /\b(invitation:|google meet|microsoft teams meeting|zoom meeting|calendly|join with)\b/i,
];

const hay = (m) => `${m.subject || ''}\n${m.body || ''}`;

/**
 * @returns {{bucket:'reply'|'task'|'review', reason:string, automatable:boolean}}
 * `automatable:false` means: never draft, never send, never extract. Show only.
 */
export function classify(mail, { isKnownThread = false } = {}) {
  const text = hay(mail);
  const from = String(mail.from || '');

  const blocked = BLOCK.find((re) => re.test(text));
  if (blocked) return { bucket: 'review', reason: `blocked: ${blocked.source.slice(0, 40)}`, automatable: false };
  const addr = addrOf(from);
  const [local, domain] = addr.split('@');
  if (local && NOREPLY_LOCAL.test(local)) return { bucket: 'review', reason: 'no-reply sender', automatable: false };
  if (domain && BLOCK_DOMAIN.test(domain)) return { bucket: 'review', reason: 'job-board blast', automatable: false };

  // A reply on a thread we started is job mail by construction — that is the
  // strongest signal available and it does not depend on keywords.
  if (isKnownThread) {
    return TASK.some((re) => re.test(text))
      ? { bucket: 'task', reason: 'reply on our thread, actionable', automatable: true }
      : { bucket: 'reply', reason: 'reply on our thread', automatable: true };
  }

  const jobHit = JOB.find((re) => re.test(text));
  if (!jobHit) return { bucket: 'review', reason: 'no job signal', automatable: false };

  return TASK.some((re) => re.test(text))
    ? { bucket: 'task', reason: `job mail, actionable`, automatable: true }
    : { bucket: 'reply', reason: `job mail`, automatable: true };
}

export const _internals = { BLOCK, NOREPLY_LOCAL, BLOCK_DOMAIN, JOB, TASK, addrOf };
