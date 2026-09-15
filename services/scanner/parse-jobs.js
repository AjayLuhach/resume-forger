// Server-side port of scanner.html's job-id parser registry: parses the
// capture buffer in Node so the browser gets compact { ids, meta } instead of
// the multi-MB raw blob that froze the tab. Mirrors the four page parsers
// one-for-one (regex ones verbatim; the two HTML ones use cheerio not
// DOMParser) — keep both in sync when LinkedIn ships a new format.

import * as cheerio from 'cheerio';

// First-non-empty-wins merge (matches scanner.html): first parser to describe an id keeps its full meta; later ones only fill blank title/company/easyApply.
function mergeMeta(into, from) {
  for (const [id, m] of Object.entries(from || {})) {
    if (!into[id]) into[id] = { ...m };
    else into[id] = {
      title: into[id].title || m.title,
      company: into[id].company || m.company,
      companyAlt: into[id].companyAlt || m.companyAlt,
      easyApply: into[id].easyApply || m.easyApply,
    };
  }
}

export function parseLinkedInSdui2026(text) {
  const ids = new Set();
  const closed = new Set();
  const meta = {};
  let m;
  const idRe = /componentkey="job-card-component-ref-(\d+)"/g;
  while ((m = idRe.exec(text)) !== null) ids.add(m[1]);
  try {
    const $ = cheerio.load(text);
    const seen = new Set();
    $('[componentkey^="job-card-component-ref-"]').each((_, el) => {
      const ck = $(el).attr('componentkey') || '';
      const id = (ck.match(/(\d+)$/) || [])[1];
      if (!id || seen.has(id)) return;
      seen.add(id);
      const ps = $(el).find('p');
      const p0 = ps.eq(0);
      let titleEl = p0.find('span:not([aria-hidden="true"])').first();
      if (!titleEl.length) titleEl = p0.find('span').first();
      const title = (titleEl.text() || p0.text() || '').trim();
      const company = (ps.eq(1).text() || '').trim();
      const cardText = $(el).text() || '';
      const easyApply = /easy apply/i.test(cardText);
      if (title || company || easyApply) meta[id] = { title, company, easyApply };
      if (/no longer accepting/i.test(cardText)) closed.add(id);
    });
  } catch (e) { /* best-effort enrichment; regex-pass ids still stand */ }
  return { ids, closed, meta };
}

export function parseLinkedInClassic(text) {
  const ids = new Set();
  const closed = new Set();
  const meta = {};
  let m;
  for (const re of [/data-occludable-job-id=["'](\d+)["']/g, /data-job-id=["'](\d+)["']/g]) {
    while ((m = re.exec(text)) !== null) ids.add(m[1]);
  }
  try {
    const $ = cheerio.load(text);
    $('[data-occludable-job-id], [data-job-id]').each((_, el) => {
      const $el = $(el);
      const id = $el.attr('data-occludable-job-id') || $el.attr('data-job-id');
      if (!id) return;
      const link = $el.find('a[href*="/jobs/view/"][aria-label]').first();
      let title = (link.attr('aria-label') || '').trim();
      if (!title) {
        title = ($el.find('a[href*="/jobs/view/"] strong').first().text() || '').trim();
      }
      const company = ($el.find('.artdeco-entity-lockup__subtitle').first().text() || '').trim();
      const state = ($el.find('.job-card-container__footer-job-state').first().text() || '')
        .toLowerCase().trim();
      if (state.includes('no longer accepting')) closed.add(id);
      const footer = $el.find('.job-card-list__footer-wrapper, .job-card-container__footer-wrapper').first();
      const footerText = footer.length ? (footer.text() || '') : ($el.text() || '');
      const easyApply = /easy apply/i.test(footerText);
      if (title || company || easyApply) meta[id] = { title, company, easyApply };
    });
  } catch (e) { /* best-effort enrichment */ }
  return { ids, closed, meta };
}

export function parseVoyagerJson(text) {
  const ids = new Set();
  const closed = new Set();
  let m;
  for (const re of [/fsd_jobPostingCard:\((\d+)/g, /fsd_jobPosting:(\d+)/g]) {
    while ((m = re.exec(text)) !== null) ids.add(m[1]);
  }
  const closedRe = /(no longer accepting applications|NO_LONGER_ACCEPTING_APPLICATIONS|"jobState"\s*:\s*"CLOSED"|"closed"\s*:\s*true)/gi;
  const idRe = /(?:fsd_jobPostingCard:\(|fsd_jobPosting:)(\d+)/g;
  const idPositions = [];
  let im;
  while ((im = idRe.exec(text)) !== null) idPositions.push({ id: im[1], pos: im.index });
  if (idPositions.length) {
    let cm;
    while ((cm = closedRe.exec(text)) !== null) {
      let bestId = null, bestDist = Infinity;
      for (const p of idPositions) {
        const d = Math.abs(p.pos - cm.index);
        if (d < bestDist) { bestDist = d; bestId = p.id; }
      }
      if (bestId && bestDist < 5000) closed.add(bestId);
    }
  }
  return { ids, closed, meta: {} };
}

// Card chrome that sits among a job card's text leaves but is never the employer.
const RSC_CHROME = /^(viewed|saved|applied|promoted|easy apply|be an early applicant|actively (hiring|reviewing)|responses managed off linkedin|verified|\s*\u00b7\s*|\d+ (school alumni|connections?|people)|.*\balumni work here\b|.*\bclicked apply\b|over \d+|\d+\+? applicants?|new|hybrid|remote|on-?site|full-?time|part-?time|contract|internship)$/i;

const rscUnesc = (s) => String(s)
  .replace(/\\n/g, ' ').replace(/\\t/g, ' ')
  .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  .replace(/\s+/g, ' ').trim();

// Loose compare — a card repeats its title as a leaf with different punctuation.
const rscKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// When an agency or job board reposts, LinkedIn writes "<Role> at <Employer>"
// into the title and the card subtitle is the POSTING ACCOUNT, not the employer.
// Both names are real and either may be the one on the blocklist, so we record
// both and let the matcher test each. Picking one would be a guess: choosing the
// title employer costs correct answers whenever " at " is part of an ordinary
// role name ("Engineer at Scale"), and choosing only the subtitle misses the
// employer entirely on every aggregator repost.
const rscTitleEmployer = (title) => {
  const m = /\s+at\s+([^,|\u2013\u2014-]{2,60})$/i.exec(String(title || ''));
  const v = m ? m[1].trim() : '';
  return v && !/^(scale|speed|heart|pace|home|work|last|least|best|most|a |an |the )/i.test(v) ? v : '';
};

// LinkedIn 2026 SDUI/RSC stream (sniffed jobs-search API body): ids in nav
// actions / job-posting urns, title from the A11yLabel binding.
//
// Company IS in this stream, contrary to what this comment used to claim — the
// card's text leaves follow its A11yLabel<id> anchor in render order
// (employer, then location). Measured 72/74 against already-scanned jobs; the
// two misses are cards where a job board is the poster and the DB stores the
// real employer the AI later read out of the JD, so the card value is right for
// a pre-scan blocklist. Without this, "Open & capture" walks carry no company,
// the blocklist cannot fire, and blocked employers get scanned anyway — 3,195
// such rows had accumulated before this landed.
//
// The scan for each card is bounded by the NEXT anchor, so a card can never
// read its neighbour's leaves. That bound is what makes this a structural join
// rather than a proximity guess; proximity pairing has silently mis-stamped
// data onto the wrong row twice in this repo.
export function parseLinkedInRsc2026(text) {
  const ids = new Set();
  const closed = new Set();
  const meta = {};
  let m;
  const idRes = [
    /currentJobId(?:=|%3D)(\d+)/g,                  // card nav action / url
    /urn:li:[a-zA-Z_]*[jJ]ob[a-zA-Z_]*:\(?(\d+)/g,  // urn:li:fsd_jobPosting:<id> etc.
    /jobPosting:(\d+)/g,                            // trackingUrn jobPosting:<id>
    /"jobId":"(\d+)"/g,                             // explicit jobId field
  ];
  for (const re of idRes) { while ((m = re.exec(text)) !== null) ids.add(m[1]); }

  // Title + company per job, anchored on the A11yLabel<id> binding.
  const titleRe = /A11yLabel(\d{8,})"\}\}\},"value":\{"\$case":"stringValue","stringValue":"((?:[^"\\]|\\.)*)"/g;
  const leafRe = /"children":\["((?:[^"\\]|\\.){2,80})"\]/g;
  const anchors = [];
  while ((m = titleRe.exec(text)) !== null) {
    if (/^Selected,/.test(m[2])) continue;         // skip the "Selected, …" duplicate
    let title = rscUnesc(m[2]);
    const verified = /\(Verified job\)$/.test(title);
    title = title.replace(/\s*\(Verified job\)\s*$/, '').trim();
    if (title) anchors.push({ id: m[1], at: m.index, title, verified });
  }
  for (let i = 0; i < anchors.length; i++) {
    const { id, at, title, verified } = anchors[i];
    ids.add(id);
    if (meta[id]) continue;                        // first sighting of a card wins
    // Bounded by the next anchor so leaves can't bleed across cards.
    const end = i + 1 < anchors.length ? anchors[i + 1].at : Math.min(text.length, at + 40000);
    const seg = text.slice(at, end);
    const tk = rscKey(title);
    let company = '';
    leafRe.lastIndex = 0;
    let leaf;
    while ((leaf = leafRe.exec(seg)) !== null) {
      const v = rscUnesc(leaf[1]);
      if (!v || RSC_CHROME.test(v)) continue;
      // Some layouts repeat the title as a leaf; the employer is the first
      // leaf that is not the title.
      const vk = rscKey(v);
      if (vk && tk && (vk === tk || tk.startsWith(vk) || vk.startsWith(tk))) continue;
      company = v;
      break;
    }
    // `company` is always the card's own subtitle — never substituted by a
    // heuristic. `companyAlt` is additive; the blocklist tests both.
    const alt = rscTitleEmployer(title);
    meta[id] = {
      title, verified,
      ...(company ? { company } : {}),
      ...(alt && rscKey(alt) !== rscKey(company) ? { companyAlt: alt } : {}),
    };
  }
  // Closed listings — best-effort proximity match (same approach as voyager).
  const closedRe = /(no longer accepting applications|NO_LONGER_ACCEPTING_APPLICATIONS|"jobState"\s*:\s*"CLOSED"|ListedStatus_CLOSED)/gi;
  const idRe = /(?:currentJobId(?:=|%3D)|jobPosting:|"jobId":")(\d+)/g;
  const positions = []; let im;
  while ((im = idRe.exec(text)) !== null) positions.push({ id: im[1], pos: im.index });
  if (positions.length) {
    let cm;
    while ((cm = closedRe.exec(text)) !== null) {
      let bestId = null, bestDist = Infinity;
      for (const p of positions) { const d = Math.abs(p.pos - cm.index); if (d < bestDist) { bestDist = d; bestId = p.id; } }
      if (bestId && bestDist < 5000) closed.add(bestId);
    }
  }
  return { ids, closed, meta };
}

const PARSERS = [
  { name: 'linkedin-html-sdui-2026', matches: (t) => /componentkey="job-card-component-ref-\d+/.test(t), parse: parseLinkedInSdui2026 },
  { name: 'linkedin-html-classic',   matches: (t) => /data-occludable-job-id|data-job-id=/.test(t),     parse: parseLinkedInClassic },
  { name: 'voyager-json-v1',         matches: (t) => /fsd_jobPostingCard:\(\d+|fsd_jobPosting:\d+/.test(t), parse: parseVoyagerJson },
  { name: 'linkedin-rsc-2026',       matches: (t) => /proto\.sdui\.|\$Sreact\.fragment/.test(t),         parse: parseLinkedInRsc2026 },
];

// Parse one text blob. Returns { ids: string[], closed: Set, meta: {} }.
export function parseLinkedInJobs(text) {
  const ids = new Set();
  const closed = new Set();
  const meta = {};
  for (const p of PARSERS) {
    if (!p.matches(text)) continue;
    const r = p.parse(text);
    for (const id of r.ids) ids.add(id);
    for (const id of r.closed) closed.add(id);
    mergeMeta(meta, r.meta);
  }
  // Last-chance net: any `/jobs/view/<id>` href, regardless of format.
  let m;
  const hrefRe = /\/jobs\/view\/(\d+)/g;
  while ((m = hrefRe.exec(text)) !== null) ids.add(m[1]);
  return { ids: [...ids], closed, meta };
}

// Parse the buffer chunk-by-chunk and merge — bounds peak memory to one chunk's DOM instead of holding the whole 120 MB walk in a parser at once.
export function parseLinkedInJobsChunks(chunks) {
  const ids = new Set();
  const closed = new Set();
  const meta = {};
  for (const c of chunks || []) {
    const r = parseLinkedInJobs(c.html || '');
    for (const id of r.ids) ids.add(id);
    for (const id of r.closed) closed.add(id);
    mergeMeta(meta, r.meta);
  }
  return { ids: [...ids], closed: [...closed], meta };
}
