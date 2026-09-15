// Feed sibling of scan-buffer.js: armed DISK-backed buffer of sniffed FEED API
// JSON pages for /feed's "Feed Capture". parseAndStore runs parseFeedJSON →
// appendPosts so the existing generate step picks the posts up (real ids).
//
// WHY DISK, NOT HEAP (2026-06): the previous version kept every captured page
// body in a process-local `chunks[]` array — up to 4GB of whole-page HTML in
// the Node heap. It did two bad things: (1) it OOM-killed the server once it
// grew past V8's heap limit, and (2) anything captured-but-not-yet-Loaded lived
// ONLY in heap, so a crash/restart silently dropped it. Now each chunk's body
// is written straight to `data/feed-capture/chunks/<seq>.txt` on arrival; the
// heap holds only a small metadata index (no bodies). Bodies are read back one
// at a time during Load. The index + bodies survive a restart, so a crash mid-
// capture loses nothing — re-Load after reboot banks them. Heap stays flat
// regardless of how much is captured.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parseFeedJSON } from './parse-linkedin-feed.js';
import { parseContentSearchSDUI } from './parse-linkedin-content-sdui.js';
import { parseHTMLv2 } from './parse-linkedin-html-v2.js';
import { appendPosts, loadExtract } from './extract-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// services/feed/ → climb two levels to reach the repo root, then data/ (which
// is gitignored, same home as data/mirrors/).
const CAPTURE_DIR = path.join(__dirname, '..', '..', 'data', 'feed-capture');
const CHUNK_DIR = path.join(CAPTURE_DIR, 'chunks');
const INDEX_PATH = path.join(CAPTURE_DIR, 'index.json');

// 15-min arm window, auto-expires so a forgotten "Start" can't keep capturing.
const ARM_MS = 15 * 60_000;

// Caps. Bodies live on DISK now, so these protect disk, not heap — but the
// heap-OOM class is gone regardless (only metadata is ever in memory).
const MAX_CHUNK_BYTES = 100 * 1024 * 1024; // single whole-page HTML snapshot ceiling
const MAX_CHUNKS = 2000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

let armedUntil = 0;        // epoch ms; armed === Date.now() < armedUntil
let autoClose = false;     // close each "Open & capture" tab once walked
let walk = false;          // extension auto-scrolls to page through more results
let walkPages = 0;         // scroll-cycle cap for walk mode

// In-heap index — METADATA ONLY, never bodies. Each entry:
//   { seq, file, url, kind, at, truncated, banked, bytes }
let index = [];
let nextSeq = 1;
let totalBytes = 0;
let dropped = 0;           // payloads rejected because the buffer was full

const armed = () => Date.now() < armedUntil;

function ensureDir() {
  if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });
}

// Atomic index write (tmp + rename) so a crash mid-write can't corrupt the
// index that everything else trusts on reboot.
function persistIndex() {
  try {
    ensureDir();
    const tmp = `${INDEX_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ nextSeq, chunks: index }));
    fs.renameSync(tmp, INDEX_PATH);
  } catch { /* best-effort; bodies are already on disk regardless */ }
}

const bodyPath = (c) => path.join(CHUNK_DIR, c.file);

// Rehydrate the metadata index from disk at module load. Bodies stay on disk —
// we only read the small index.json, so boot is cheap no matter how much is
// banked. Captured-but-not-Loaded pages from before a crash are still here.
function hydrate() {
  try {
    if (!fs.existsSync(INDEX_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    if (parsed && Array.isArray(parsed.chunks)) {
      // Keep only entries whose body file actually exists on disk.
      index = parsed.chunks.filter((c) => c && c.file && fs.existsSync(path.join(CHUNK_DIR, c.file)));
      totalBytes = index.reduce((n, c) => n + (c.bytes || 0), 0);
      nextSeq = Math.max(Number(parsed.nextSeq) || 0, index.reduce((m, c) => Math.max(m, c.seq || 0), 0) + 1, 1);
      if (index.length !== (parsed.chunks?.length || 0)) persistIndex(); // prune dangling refs
    }
  } catch { index = []; totalBytes = 0; nextSeq = 1; }
}
hydrate();

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

// When full, evict oldest BANKED pages first — their posts are already saved to
// extract.json by a Load, so only never-Loaded pages are ever at risk. Deletes
// the body file off disk too.
const evictBanked = () => {
  let changed = false;
  while (index.length >= MAX_CHUNKS || totalBytes >= MAX_TOTAL_BYTES) {
    const i = index.findIndex((c) => c.banked);
    if (i === -1) break;
    const [c] = index.splice(i, 1);
    totalBytes -= (c.bytes || 0);
    try { fs.unlinkSync(bodyPath(c)); } catch { /* already gone */ }
    changed = true;
  }
  if (changed) persistIndex();
};

// Append one sniffed feed API page (raw JSON text). Body goes to disk
// immediately; only metadata enters the heap. `kind` kept for parity.
export const append = ({ html, url, kind } = {}) => {
  if (!armed()) return { accepted: false, reason: 'not-armed', chunkCount: index.length };
  if (!html || typeof html !== 'string') {
    return { accepted: false, reason: 'empty', chunkCount: index.length };
  }
  evictBanked();
  if (index.length >= MAX_CHUNKS || totalBytes >= MAX_TOTAL_BYTES) {
    dropped += 1;
    persistIndex();
    return { accepted: false, reason: 'full', chunkCount: index.length, dropped };
  }
  let truncated = false;
  let body = html;
  if (body.length > MAX_CHUNK_BYTES) {
    body = body.slice(0, MAX_CHUNK_BYTES);
    truncated = true;
  }
  const seq = nextSeq++;
  const file = `${seq}.txt`;
  try {
    ensureDir();
    fs.writeFileSync(bodyPath({ file }), body);
  } catch (e) {
    nextSeq -= 1; // roll back the seq we didn't use
    return { accepted: false, reason: 'disk-error', error: e.message, chunkCount: index.length };
  }
  index.push({
    seq, file, url: url || null,
    kind: kind === 'feed' ? 'feed' : (kind || 'feed'),
    at: new Date().toISOString(), truncated, banked: false, bytes: body.length,
  });
  totalBytes += body.length;
  persistIndex();
  return { accepted: true, chunkCount: index.length, truncated, autoClose };
};

// Raw read (debug only; the UI calls parseAndStore, never pulls the blob).
export const read = () => ({
  chunkCount: index.length,
  urls: index.map((c) => c.url),
  bytes: totalBytes,
});

// Parse all buffered pages → dedup by activity id → appendPosts to extract.json.
// Bodies are read off disk one at a time (peak heap = one body, not the whole
// buffer). Pages are KEPT (marked banked) until clear() — Load never discards
// anything; re-Loading just re-dedups. Garbled / missing chunks are skipped.
export const parseAndStore = () => {
  const apiPosts = [];   // JSON/SDUI API pages → real urn:li:activity ids
  const htmlPosts = [];  // rendered-DOM snapshots via v2 → clean text, gen- ids
  let okChunks = 0;
  let badChunks = 0;
  for (const c of index) {
    let body;
    try { body = fs.readFileSync(bodyPath(c), 'utf-8'); }
    catch { badChunks += 1; continue; } // body file gone — skip, don't crash
    try {
      if (c.kind === 'feed-html') {
        htmlPosts.push(...(parseHTMLv2(body).posts || []));
      } else {
        // Voyager JSON parses as JSON → parseFeedJSON; the SDUI/RSC content-
        // search stream isn't JSON → parseContentSearchSDUI.
        let json = null;
        try { json = JSON.parse(body); } catch { /* not JSON → SDUI */ }
        apiPosts.push(...(json ? (parseFeedJSON(json).posts || []) : (parseContentSearchSDUI(body).posts || [])));
      }
      okChunks += 1;
    } catch { badChunks += 1; }
  }
  // Dedup by CONTENT (normalized text prefix), not id — so the same post from
  // API, HTML, or multiple page scans collapses to one. Text-less posts fall
  // back to id. This is the single key used both within the buffer AND against
  // the already-saved pool, so re-scans / gen-vs-real never inflate the counts
  // or create false duplicates.
  const isReal = (p) => p.id && !String(p.id).startsWith('gen-');
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim().slice(0, 160).toLowerCase();
  const keyOf = (p) => { const k = norm(p.post && p.post.text); return k.length >= 25 ? `t:${k}` : `id:${p.id}`; };

  // Collapse the buffer to unique posts (prefer the real-id copy).
  const byKey = new Map();
  for (const p of [...apiPosts, ...htmlPosts]) {
    if (!p || !p.id) continue;
    const k = keyOf(p);
    const ex = byKey.get(k);
    if (!ex || (isReal(p) && !isReal(ex))) byKey.set(k, p);
  }
  const allPosts = [...byKey.values()];

  // New vs already-ANALYZED, decided by content key against the saved pool —
  // mirroring the Analyze step, which works the `processed`-flag set
  // (getUnprocessedPosts). A buffer post counts as "new" (still needs analysis)
  // if its content isn't in the pool yet OR it's in the pool but not yet
  // processed; only posts whose pool copy is already processed are "duplicates".
  // (Previously ANY pool match counted as a duplicate, so posts sitting in the
  // pool awaiting analysis were wrongly reported as "New 0 · Duplicates N".)
  const processedByKey = new Map();
  for (const p of (loadExtract().posts || [])) {
    const k = keyOf(p);
    processedByKey.set(k, (processedByKey.get(k) || false) || !!p.processed);
  }
  const isProcessed = (p) => processedByKey.get(keyOf(p)) === true;

  // Physically-new posts (content not in the pool at all) must be written so the
  // Analyze step picks them up; appendPosts dedups by id as a backstop. A gen-id
  // HTML copy of an already-saved real-id post is NOT re-added (its key is present).
  const physicallyNew = allPosts.filter((p) => !processedByKey.has(keyOf(p)));
  const { total } = appendPosts(physicallyNew);

  // "New" = still-unprocessed (needs analysis); "Duplicates" = already analyzed.
  const fresh = allPosts.filter((p) => !isProcessed(p));
  let bankedChanged = false;
  for (const c of index) { if (!c.banked) { c.banked = true; bankedChanged = true; } } // saved — safe to evict if buffer fills
  if (bankedChanged) persistIndex();

  // Partition of `parsed` keyed off the `processed` flag (same signal Analyze
  // uses), so the buckets sum cleanly and don't overlap:
  //   parsed = unprocessed + duplicates   (newCaptured is a subset of unprocessed)
  return {
    parsed: allPosts.length,                       // unique posts in the buffer (deduped by content)
    unprocessed: fresh.length,                     // still need analysis (new + in-pool-but-not-analyzed)
    newCaptured: physicallyNew.length,             // subset of unprocessed: genuinely new → just added this Load
    duplicates: allPosts.length - fresh.length,    // already analyzed (processed) — true duplicates, skipped
    added: fresh.length,                           // back-compat alias of `unprocessed`
    total,                                         // total posts in extract.json after append
    counts: {
      chunkCount: index.length,
      okChunks,
      badChunks,
      bytes: totalBytes,
      apiPosts: apiPosts.length,
      htmlPosts: htmlPosts.length,
    },
  };
};

// Debug snapshot of the first n raw chunks (capped) — written to output/ only
// when a Load parses 0 posts, so a new/changed format can be debugged.
export const dump = (n = 3, cap = 300000) =>
  index.slice(0, n).map((c) => {
    let body = '';
    try { body = fs.readFileSync(bodyPath(c), 'utf-8'); } catch { /* gone */ }
    return { url: c.url, kind: c.kind, bytes: c.bytes ?? body.length, body: body.slice(0, cap) };
  });

export const clear = () => {
  for (const c of index) { try { fs.unlinkSync(bodyPath(c)); } catch { /* already gone */ } }
  index = [];
  totalBytes = 0;
  dropped = 0;
  try { if (fs.existsSync(INDEX_PATH)) fs.unlinkSync(INDEX_PATH); } catch { /* non-fatal */ }
  return { chunkCount: 0 };
};

export const status = () => ({
  armed: armed(),
  autoClose: armed() && autoClose,
  walk: armed() && walk,
  pages: walkPages,
  armedUntil: armed() ? armedUntil : 0, // stable per-session key for the walker
  remainingMs: armed() ? armedUntil - Date.now() : 0,
  chunkCount: index.length,
  bytes: totalBytes,
  full: index.length >= MAX_CHUNKS || totalBytes >= MAX_TOTAL_BYTES,
  dropped,
});
