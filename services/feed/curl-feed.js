/**
 * Curl Feed — fetch LinkedIn content-search pages directly instead of scrolling.
 *
 * The operator pastes a curl copied from the Network tab; we take only what is
 * actually required (measured: li_at + JSESSIONID, and csrf-token which must
 * equal JSESSIONID — dropping it is the only change that 403s). Everything else
 * in that curl is telemetry.
 *
 * Responses are parsed as they land and appended to extract.json, so Analyze
 * works on them exactly as it does on scrolled captures.
 */

import fs from 'fs';
import path from 'path';
import { parseContentSearchSDUI } from './parse-linkedin-content-sdui.js';
import { appendPosts } from './extract-store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Everything the parser rejected, and a readable breakdown of why. `noBody` and
// `slugMismatch` were absent from the old count, so a page could drop every post
// and still report "dropped 0".
const droppedOf = (s) => (s.ambiguous || 0) + (s.unreachable || 0) + (s.noBody || 0) + (s.slugMismatch || 0);
const fmtStats = (s) => Object.entries(s).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || 'all zero';

const ENDPOINT = 'https://www.linkedin.com/flagship-web/rsc-action/actions/pagination?sduiid=com.linkedin.sdui.search.contentSearchResults';

/** Pull the three values that matter out of a pasted curl. */
export function parseCurl(curl) {
  const s = String(curl || '');
  const cookieBlob = (s.match(/-b\s+'([^']*)'/) || s.match(/--cookie\s+'([^']*)'/) || [])[1]
    || (s.match(/-H\s+'cookie:\s*([^']*)'/i) || [])[1] || '';
  const li_at = (cookieBlob.match(/(?:^|;\s*)li_at=([^;]+)/) || [])[1];
  const jsid = (cookieBlob.match(/(?:^|;\s*)JSESSIONID="?(ajax:[0-9]+)"?/) || [])[1]
    || (s.match(/csrf-token:\s*(ajax:[0-9]+)/) || [])[1];
  const missing = [];
  if (!li_at) missing.push('li_at');
  if (!jsid) missing.push('JSESSIONID / csrf-token');
  return { li_at, jsid, ok: !missing.length, missing };
}

const buildBody = ({ keywords, count, startIndex, searchId, datePosted = 'past-24h', sortBy = 'relevance' }) => {
  const payload = {
    startIndex, keywords, count,
    sortBy: [sortBy], postedBy: [], datePosted: [datePosted], contentType: [],
    fromMember: [], mentionsOrganization: [], mentionsMember: [], fromOrganization: [],
    authorCompany: [], authorIndustry: [], authorJobTitle: [],
    spellCheckEnabled: true, clusterStartPosition: startIndex, searchId,
  };
  const args = {
    $type: 'proto.sdui.actions.requests.RequestedArguments',
    requestedStateKeys: [], payload,
    requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
    states: [], screenId: 'com.linkedin.sdui.flagshipnav.search.SearchResultsContent',
    knownTemplateIds: [],
  };
  return JSON.stringify({
    pagerId: 'com.linkedin.sdui.search.contentSearchResults',
    clientArguments: args,
    paginationRequest: {
      $type: 'proto.sdui.actions.requests.PaginationRequest',
      pagerId: 'com.linkedin.sdui.search.contentSearchResults',
      trigger: { $case: 'itemDistanceTrigger', itemDistanceTrigger: { $type: 'proto.sdui.actions.requests.ItemDistanceTrigger', preloadDistance: 3, preloadLength: 1500 } },
      retryCount: 2,
      requestedArguments: { $type: 'proto.sdui.actions.requests.RequestedArguments', requestedStateKeys: [], payload, requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' } },
    },
  });
};

/** One page, with a single retry — LinkedIn resets the odd connection. */
async function fetchPage(creds, opts, attempt = 0) {
  try {
    return await fetchPageOnce(creds, opts);
  } catch (e) {
    const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated/i.test(String(e.cause?.code || e.message));
    if (transient && attempt < 1) {
      await sleep(6000);
      return fetchPage(creds, opts, attempt + 1);
    }
    throw new Error(`${e.cause?.code || e.message}`);
  }
}

async function fetchPageOnce(creds, opts) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'csrf-token': creds.jsid,
      'x-li-rsc-stream': 'true',
      accept: '*/*',
      cookie: `li_at=${creds.li_at}; JSESSIONID="${creds.jsid}"`,
    },
    body: buildBody(opts),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  return { status: res.status, text, ms: Date.now() - t0 };
}

/**
 * A page that parses to zero is indistinguishable from a page LinkedIn returned
 * empty unless the bytes are kept. One dump per run is enough to tell which.
 */
function dumpResponse(text, tag) {
  try {
    const dir = path.join(process.cwd(), 'data', 'curl-feed-debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}.txt`);
    fs.writeFileSync(file, text);
    return file;
  } catch { return null; }
}

const jitter = (base, spread = 2500) => base + Math.floor(Math.random() * spread);
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});

/**
 * Run the whole thing. `onEvent` streams progress lines to the UI.
 *
 * Safety rails, in order of how much they matter:
 *  - a probe call (count=3) must succeed before anything larger is attempted
 *  - a page returning fewer than half the posts it asked for stops that term,
 *    because that is what running out of results or being throttled looks like
 *  - two consecutive failures abort the whole run
 */
export async function runCurlFeed({ curl, terms, perTerm = 250, onEvent = () => {}, signal }) {
  const creds = parseCurl(curl);
  if (!creds.ok) throw new Error(`curl is missing: ${creds.missing.join(', ')}`);

  const say = (m) => onEvent({ message: m });
  const summary = { requests: 0, posts: 0, added: 0, duplicate: 0, dropped: 0, terms: [], aborted: null };
  let dumped = false;

  say('probing with count=3 before anything larger…');
  let probe;
  try {
    probe = await fetchPage(creds, { keywords: terms[0], count: 3, startIndex: 0, searchId: uuid() });
  } catch (e) {
    throw new Error(`probe could not reach LinkedIn (${e.message}) — check the network, or the curl may be stale`);
  }
  summary.requests++;
  if (probe.status !== 200) throw new Error(`probe failed: HTTP ${probe.status} — paste a fresh curl`);
  const probed = parseContentSearchSDUI(probe.text);
  say(`probe ok — ${(probe.text.length / 1048576).toFixed(1)}MB, ${probed.posts.length} posts, ${probe.ms}ms  [${fmtStats(probed.stats)}]`);
  if (!probed.posts.length) {
    const f = dumpResponse(probe.text, 'probe-zero');
    throw new Error(`probe returned no parseable posts — the response shape may have changed${f ? ` (saved ${f})` : ''}`);
  }

  let consecutiveFailures = 0;

  for (const term of terms) {
    if (signal?.aborted) { summary.aborted = 'stopped by operator'; break; }
    const searchId = uuid();
    let startIndex = 0;
    let got = 0;
    // LinkedIn's own client pages this endpoint at count=3. count~50 came back
    // with nothing parseable, so stay in a range near what the site itself asks.
    let step = 24;

    say(`── "${term}" — target ${perTerm}`);
    while (got < perTerm) {
      if (signal?.aborted) { summary.aborted = 'stopped by operator'; break; }
      // Vary the page size a little so the cadence isn't a metronome.
      const count = Math.max(20, Math.min(step + (Math.floor(Math.random() * 8) - 3), 35, perTerm - got));
      let r;
      try {
        r = await fetchPage(creds, { keywords: term, count, startIndex, searchId });
      } catch (e) {
        consecutiveFailures++;
        say(`   request error: ${e.message}`);
        if (consecutiveFailures >= 2) { summary.aborted = 'two consecutive request failures'; break; }
        await sleep(jitter(8000));
        continue;
      }
      summary.requests++;

      if (r.status !== 200) {
        consecutiveFailures++;
        say(`   HTTP ${r.status} at startIndex ${startIndex}`);
        if (consecutiveFailures >= 2) { summary.aborted = `HTTP ${r.status} twice — paste a fresh curl`; break; }
        await sleep(jitter(8000));
        continue;
      }
      consecutiveFailures = 0;

      const { posts, stats } = parseContentSearchSDUI(r.text);
      // appendPosts dedupes by id. Reporting posts.length as "added" overstated
      // a run by ~25% — overlapping pages re-return the same post.
      const { added, skipped, total } = appendPosts(posts);
      const mb = (r.text.length / 1048576).toFixed(1);
      summary.posts += posts.length;
      summary.added += added;
      summary.duplicate += skipped;
      summary.dropped += droppedOf(stats);
      got += posts.length;
      startIndex += count;
      // Size and the full stats breakdown, because "+0 posts, 0 dropped" has
      // three different causes and the old line could not tell them apart:
      // an empty response, no commentary rows, or bodies under the length floor.
      say(`   +${added} new (parsed ${posts.length}, dup ${skipped}, asked ${count}, dropped ${droppedOf(stats)}) · ${mb}MB · ${got}/${perTerm} · pool ${total}  [${fmtStats(stats)}]`);
      if (!posts.length && !dumped) {
        dumped = true;
        const f = dumpResponse(r.text, `zero-c${count}-i${startIndex - count}`);
        if (f) say(`   saved the zero-post response → ${f}`);
      }
      onEvent({ progress: { term, got, target: perTerm, requests: summary.requests } });

      // Fewer than half of what we asked for: results are exhausted or we are
      // being throttled. Either way, asking for MORE is the wrong move.
      if (posts.length < count / 2) {
        say(`   short page (${posts.length} < ${Math.ceil(count / 2)}) — stopping "${term}"`);
        break;
      }
      step = Math.min(step + 4, 35);
      await sleep(jitter(6000, 3500));   // 6.0–9.5s between pages
    }
    summary.terms.push({ term, got });
    if (summary.aborted) break;
    // A long, uneven pause between terms — two back-to-back search bursts from
    // one session is the pattern most worth not looking like.
    if (term !== terms[terms.length - 1]) {
      const gap = jitter(20000, 15000);
      say(`   … pausing ${(gap / 1000).toFixed(0)}s before the next term`);
      await sleep(gap);
    }
  }

  say(`done — ${summary.requests} requests, ${summary.added} new posts (${summary.duplicate} dup, ${summary.dropped} dropped)`);
  return summary;
}

export default { runCurlFeed, parseCurl };
