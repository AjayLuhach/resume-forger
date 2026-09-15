// Detect external-apply signals in raw JD text: emails, phone numbers,
// non-platform links. Pure: text in, structured object out.
//
// Output shape (all arrays deduped, empty when absent):
//   {
//     emails: ['careers@x.com', ...],
//     phones: ['+919999988888', '9876543210', ...],
//     links:  ['https://forms.gle/abc', 'https://boards.greenhouse.io/...'],
//   }
//
// Design notes (intentionally loose, by user request):
//   - emails: any plausible email (no noise filter). If a JD names support@
//     or no-reply@ that's still useful context — the user can decide.
//   - phones: any number that looks phone-shaped — international (+CC + digits),
//     Indian mobile (10 digits starting 6/7/8/9), or US-style xxx-xxx-xxxx.
//     No "WhatsApp" / "Call" keyword required. False-positive guard: extract
//     phones from text AFTER URLs are masked, so LinkedIn 10-digit job IDs
//     inside an embedded URL don't masquerade as phone numbers.
//   - links: any http/https URL except the platform's own domains
//     (linkedin.com, naukri.com, lnkd.in) — those are virtually always
//     "open the job in the platform" links, not external apply targets.

const PLATFORM_HOST_RE = /^https?:\/\/(?:[a-z0-9-]+\.)?(linkedin\.com|naukri\.com|lnkd\.in|nkr\.in|indeed\.com)(?:\/|$)/i;

// Decode the few HTML entities the LinkedIn/Naukri DOM dumps produce. We
// deliberately do NOT strip tags — emails and URLs frequently live inside
// `<a href="mailto:...">` and `<a href="https://forms.gle/...">`, and
// stripping tags first would erase them entirely. The URL/email regexes
// don't care about surrounding `<a …>` noise; they match on shape.
const normalizeText = (s) => String(s || '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>');

const EMAIL_RE = /(?:mailto:)?([a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/gi;

// Phone patterns. Each one is conservative on its own; combined they cover
// the formats that show up in LinkedIn/Naukri JDs from Indian and global
// recruiters. Boundary checks (\b or lookarounds) prevent matching inside
// longer digit strings.
//
//   1) +CC ... (10-15 digits total, with optional separators)
//   2) Indian mobile bare: 10 digits starting 6/7/8/9
//   3) US-style: 3-3-4 with separators
const PHONE_PATTERNS = [
  /\+\d[\d\s().-]{8,18}\d/g,            // international
  /(?<!\d)[6-9]\d{9}(?!\d)/g,           // Indian mobile (10 digits, prefix 6-9)
  /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g,   // US-style xxx-xxx-xxxx
];

// Strip trailing punctuation a URL or value tends to pick up when it sits
// at sentence-end ("apply at https://x.com/y.").
const cleanUrl = (u) => String(u || '').trim().replace(/[.,;:>"'\])}]+$/g, '');

// Normalize a phone-ish capture into a digits-only form (with optional +).
// Strips spaces, dashes, dots, parens. Rejects lengths outside 10-15 to
// rule out residual noise (e.g. a captured 8-digit string that happened to
// match the +CC pattern with min length).
const cleanPhone = (raw) => {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return hasPlus ? `+${digits}` : digits;
};

const dedupe = (arr) => [...new Set(arr.filter(Boolean))];

const isPlatformLink = (url) => PLATFORM_HOST_RE.test(url);

export const extractExternalApply = (rawText) => {
  const text = normalizeText(rawText);
  const out = { emails: [], phones: [], links: [] };
  if (!text) return out;

  // 1. Links first — collected from raw text, then this set is also used
  //    to mask URL spans before phone/email extraction so digit-heavy URL
  //    paths (e.g. LinkedIn 10-digit job IDs) don't show up as phones.
  const links = [];
  const urlSpans = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0]);
    urlSpans.push([m.index, m.index + m[0].length]);
    if (isPlatformLink(url)) continue;
    links.push(url);
  }
  out.links = dedupe(links);

  // 2. Mask URL spans with spaces so phone/email regexes can't recover
  //    digits/emails from inside them.
  let masked = text;
  if (urlSpans.length) {
    const chars = text.split('');
    for (const [s, e] of urlSpans) {
      for (let i = s; i < e && i < chars.length; i++) chars[i] = ' ';
    }
    masked = chars.join('');
  }

  // 3. Emails — no noise filter; the user explicitly asked for any email.
  const emails = [];
  for (const m of masked.matchAll(EMAIL_RE)) emails.push(m[1].toLowerCase());
  out.emails = dedupe(emails);

  // 4. Phones — try each pattern, normalize, dedupe across all patterns.
  const phones = [];
  for (const re of PHONE_PATTERNS) {
    for (const m of masked.matchAll(re)) {
      const p = cleanPhone(m[0]);
      if (p) phones.push(p);
    }
  }
  out.phones = dedupe(phones);

  return out;
};

// Convenience: returns true iff any bucket has at least one entry. Used by
// hydrate() to avoid sending the empty object over the wire. Tolerates
// legacy shapes (`forms`/`ats`/`whatsapp`) so rows that haven't been
// re-backfilled yet still report "has contact" correctly.
export const hasExternalApply = (e) => {
  if (!e) return false;
  return !!(
    e.emails?.length ||
    e.phones?.length ||
    e.links?.length ||
    // legacy buckets — still counted until backfill runs.
    e.forms?.length ||
    e.ats?.length ||
    e.whatsapp?.length
  );
};
