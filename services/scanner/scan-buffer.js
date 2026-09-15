// Armed-capture buffer for the /scanner page's "Auto-Capture from LinkedIn"
// flow. Pure in-memory — NOT mongo, NOT mirrored. The operator clicks "Start
// capturing" on /scanner, which arms a flag for 5 minutes; while armed, the
// Job Scanner extension (on any linkedin.com/jobs/search page) scrolls, grabs
// the page HTML, and POSTs it here. The /scanner page then pulls the buffered
// HTML and appends it into the importer textarea, exactly as if the operator
// had pasted it — from there the existing Parse flow is unchanged.
//
// Lifetime: process-local and ephemeral. Each user runs their own Node
// process (see CLAUDE.md), so there's no cross-user collision, and a restart
// just drops a half-finished capture session (re-arm + re-page to redo it —
// cheap). Nothing here needs to survive a restart, which is exactly why it's
// not in mongo.

import { parseLinkedInJobsChunks } from './parse-jobs.js';

// Arm window. 15 min covers a full 40-page walk at 12–15s/page; still auto-
// expires so a forgotten "Start" can't keep capturing.
const ARM_MS = 15 * 60_000;

// Caps (ephemeral, process-local heap). 600 chunks / 2GB holds longer walks.
const MAX_CHUNK_BYTES = 6 * 1024 * 1024;
const MAX_CHUNKS = 600;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

let armedUntil = 0;        // epoch ms; armed === Date.now() < armedUntil
let autoClose = false;     // true when armed via the "Open & capture" run — the
                           // extension closes each scanner-opened tab once grabbed
let walk = false;          // true = the extension auto-clicks the single bottom-
                           // bar "Next" button to page through (SPA nav)
let walkPages = 0;         // page cap for walk mode
let chunks = [];           // [{ html, url, kind, at, truncated }]
let totalBytes = 0;
let dropped = 0;           // payloads rejected because the buffer was full

const armed = () => Date.now() < armedUntil;

export const arm = ({ ms = ARM_MS, autoClose: ac = false, walk: w = false, pages = 0 } = {}) => {
  armedUntil = Date.now() + Math.max(0, Number(ms) || ARM_MS);
  autoClose = !!ac;
  walk = !!w;
  walkPages = Math.max(0, Number(pages) || 0);
  return status();
};

export const disarm = () => {
  armedUntil = 0;
  autoClose = false;
  walk = false;
  walkPages = 0;
  return status();
};

// Append a captured chunk. `kind` is 'html' (page scrape) or 'api' (sniffed
// jobs-search response body — where the ids live). Both are just text chunks;
// the importer runs every matching parser over the concatenation.
export const append = ({ html, url, kind } = {}) => {
  if (!armed()) return { accepted: false, reason: 'not-armed', chunkCount: chunks.length };
  if (!html || typeof html !== 'string') {
    return { accepted: false, reason: 'empty', chunkCount: chunks.length };
  }
  if (chunks.length >= MAX_CHUNKS || totalBytes >= MAX_TOTAL_BYTES) {
    dropped += 1;
    return { accepted: false, reason: 'full', chunkCount: chunks.length, dropped };
  }
  let truncated = false;
  let body = html;
  if (body.length > MAX_CHUNK_BYTES) {
    body = body.slice(0, MAX_CHUNK_BYTES);
    truncated = true;
  }
  const k = kind === 'api' ? 'api' : 'html';
  chunks.push({ html: body, url: url || null, kind: k, at: new Date().toISOString(), truncated });
  totalBytes += body.length;
  return { accepted: true, chunkCount: chunks.length, truncated, autoClose, kind: k };
};

const countKind = (k) => chunks.reduce((n, c) => n + ((c.kind || 'html') === k ? 1 : 0), 0);

// Concatenated text for the UI's "Load → input". Newline-joined so the
// importer's parsers see each chunk contiguously; job-id de-dup is the
// parser's job (it collects into a Set), so overlapping pages/payloads are
// harmless. Both 'html' page scrapes and 'api' response bodies are included —
// the parser registry matches whichever applies to each.
export const read = () => ({
  html: chunks.map(c => c.html).join('\n'),
  chunkCount: chunks.length,
  pageCount: countKind('html'),
  apiCount: countKind('api'),
  urls: chunks.map(c => c.url),
  bytes: totalBytes,
});

// Parsed view for the UI's "Load" — parses the buffer in Node and returns only the small { ids, meta, closed[] } result, so the browser never gets the multi-MB raw blob that froze the tab.
export const parsed = () => {
  const r = parseLinkedInJobsChunks(chunks);
  return {
    ids: r.ids,
    meta: r.meta,
    closed: r.closed,
    counts: {
      parsed: r.ids.length,
      pages: countKind('html'),
      api: countKind('api'),
      chunkCount: chunks.length,
      bytes: totalBytes,
    },
  };
};

export const clear = () => {
  chunks = [];
  totalBytes = 0;
  dropped = 0;
  return { chunkCount: 0 };
};

export const status = () => ({
  armed: armed(),
  autoClose: armed() && autoClose,
  walk: armed() && walk,
  pages: walkPages,
  armedUntil: armed() ? armedUntil : 0, // stable per-session key for the walker
  remainingMs: armed() ? armedUntil - Date.now() : 0,
  chunkCount: chunks.length,
  pageCount: countKind('html'),
  apiCount: countKind('api'),
  bytes: totalBytes,
  full: chunks.length >= MAX_CHUNKS || totalBytes >= MAX_TOTAL_BYTES,
  dropped,
});
