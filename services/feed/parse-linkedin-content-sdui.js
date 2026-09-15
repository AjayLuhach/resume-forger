/**
 * LinkedIn 2026 SDUI/RSC content-search parser.
 *
 * Parses the `…/rsc-action/actions/pagination?sduiid=…contentSearchResults`
 * React-flight stream into the same normalized shape parseFeedJSON returns.
 * Each pagination page is its own flight stream with its own row-id namespace,
 * so callers must pass ONE response at a time.
 *
 * The stream keeps content and identity in separate regions and in DIFFERENT
 * orders, so nothing here may be paired by position — doing so silently stamps
 * one post's author and contacts onto another's row. Instead:
 *
 *   body      commentary_text -> $L row, resolved recursively. Emails, links and
 *             hashtags are child components, NOT text leaves: a flat read ends a
 *             post at "Email Id:" with the address missing.
 *   identity  the actor block carries the author name, headline and a RELATIVE
 *             "/in/slug/" url (absolute linkedin.com/in/ appears ~3 times in 36
 *             posts, which is why it looks absent).
 *   join      each update's id is repeated ~200x through its own content region,
 *             so the body belongs to whichever update id dominates the window
 *             around it. Ambiguous windows are dropped rather than guessed.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Index the flight rows ("<hexid>:<payload>") so $L<id> refs resolve in O(1).
function buildRowIndex(chunk) {
  const idx = new Map();
  const re = /(?:^|\n)([0-9a-f]+):/g;
  const starts = [];
  let m;
  while ((m = re.exec(chunk)) !== null) starts.push({ id: m[1], from: m.index + m[0].length, hdr: m[0].length });
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].from - starts[i + 1].hdr : chunk.length;
    idx.set(starts[i].id, chunk.slice(starts[i].from, end));
  }
  return idx;
}

// Resolve a row into its text plus any linkified entity it carries.
function resolveRow(rows, id, depth = 0, seen = new Set()) {
  if (depth > 5 || !id || seen.has(id)) return { text: '', links: [] };
  seen.add(id);
  const row = rows.get(id);
  if (!row) return { text: '', links: [] };

  const out = [];
  const links = [];
  for (const m of row.matchAll(/"url":"(mailto:[^"]+|https?:\/\/[^"]+)"/g)) links.push(m[1]);

  const tok = /,"((?:[^"\\]|\\.)*)"\]|"\$L([0-9a-f]+)"/g;
  let m;
  while ((m = tok.exec(row)) !== null) {
    if (m[2]) {
      const n = resolveRow(rows, m[2], depth + 1, seen);
      if (n.text) out.push(n.text);
      links.push(...n.links);
      continue;
    }
    const s = m[1];
    if (!s || s === '$undefined' || /^\$/.test(s) || /^https?:\/\//.test(s)) continue;
    out.push(s);
  }
  return { text: out.join('\n'), links };
}

const clean = (s) => String(s || '')
  .replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\"/g, '"')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Author blocks, each paired to the update whose metadata sits nearest after it. */
function extractActors(text) {
  const actors = [];
  for (const m of text.matchAll(/"legacyControlName":"actor"\}/g)) {
    const seg = text.slice(m.index, m.index + 9000);
    // Both shapes are in the wild: one SDUI build emits a relative "/in/slug/",
    // a newer one emits the absolute URL. Matching only relative silently
    // yielded zero actors — and therefore zero posts — on the newer build.
    const slug = seg.match(/"url":"(?:https:\/\/www\.linkedin\.com)?\/in\/([a-zA-Z0-9%_-]+)\/?"/)?.[1] || null;
    if (!slug) continue;
    const name = seg.match(/profile_name_loading_state[\s\S]{0,240}?"stringValue":"([^"]{2,80})"/)?.[1] || null;
    const headline = seg.match(/profile_headline_loading_state[\s\S]{0,240}?"stringValue":"([^"]{2,200})"/)?.[1] || null;
    actors.push({ at: m.index, slug, name: clean(name), headline: clean(headline) });
  }
  // One actor block per rendered card, but the card is emitted twice (avatar +
  // name line); keep the first sighting of each slug.
  const bySlug = new Map();
  for (const a of actors) if (!bySlug.has(a.slug)) bySlug.set(a.slug, a);
  return [...bySlug.values()];
}

/** Update ids in first-seen order, with their permalink when present. */
function extractUpdates(text) {
  const out = new Map();
  for (const m of text.matchAll(/urn:li:fsd_update:\(urn:li:(?:activity|ugcPost):(\d+),/g)) {
    if (!out.has(m[1])) out.set(m[1], { id: m[1], at: m.index, url: null });
  }
  for (const m of text.matchAll(/urn:li:fsd_update:\(urn:li:(?:activity|ugcPost):(\d+),[^"]*","url":"(https:\/\/www\.linkedin\.com\/posts\/[^"]+)"/g)) {
    const u = out.get(m[1]);
    if (u && !u.url) u.url = m[2];
  }
  return [...out.values()];
}

/**
 * @param {string} text - one content-search pagination flight stream
 * @param {object} [opts]
 * @param {boolean} [opts.requireContact=true] - drop posts with neither an email nor a profile url
 * @returns {{ posts: object[], stats: object }}
 */
export function parseContentSearchSDUI(text, { requireContact = true } = {}) {
  const stats = { commentary: 0, joined: 0, ambiguous: 0, unreachable: 0, noBody: 0, slugMismatch: 0 };
  if (typeof text !== 'string' || !/contentSearchResults|urn:li:fsd_update/.test(text)) {
    return { posts: [], stats };
  }

  const rows = buildRowIndex(text);
  const updates = extractUpdates(text);
  const actors = extractActors(text);
  if (!updates.length) return { posts: [], stats };

  // Join actors to updates by SLUG, not position. The permalink embeds the
  // author's slug ("/posts/<slug>_…") and the actor block carries "/in/<slug>",
  // so this is an exact match with no ordering assumption. Position agreed at
  // count=3 and broke at count=50 — 8 posts mis-paired before this changed.
  const actorBySlug = new Map(actors.map((a) => [a.slug, a]));
  const actorFor = new Map();
  for (const u of updates) {
    if (!u.url) continue;
    const permaSlug = (u.url.match(/\/posts\/([a-zA-Z0-9%_-]+?)_/) || [])[1];
    if (!permaSlug) continue;
    const a = actorBySlug.get(permaSlug);
    if (a) actorFor.set(u.id, a);
    else stats.slugMismatch++;
  }

  const now = new Date().toISOString();
  const posts = [];
  const usedUpdate = new Set();

  // Each body owns the span between its neighbours' midpoints. A fixed window
  // was tuned at count=3 and collapsed at count=50, where 49 posts share one
  // response: it scored ids from neighbouring posts and dropped ~80% as
  // ambiguous. Adaptive regions took the same response from 10 posts to 47.
  const comHits = [...text.matchAll(/commentary_text"\},"children":"\$L([0-9a-f]+)"/g)];
  const regionFor = (i) => ({
    lo: i === 0 ? 0 : Math.floor((comHits[i - 1].index + comHits[i].index) / 2),
    hi: i === comHits.length - 1 ? text.length : Math.floor((comHits[i].index + comHits[i + 1].index) / 2),
  });

  for (let ci = 0; ci < comHits.length; ci++) {
    const m = comHits[ci];
    stats.commentary++;
    const r = resolveRow(rows, m[1]);
    const body = clean([r.text, ...r.links.map((l) => l.replace(/^mailto:/, ''))].join('\n'))
      .replace(/^(?:default\s*)+/i, '');   // placeholder the stream emits ahead of some bodies
    if (body.length < 40) { stats.noBody++; continue; }

    // Whichever update id dominates this body's own region owns it.
    const { lo, hi } = regionFor(ci);
    const win = text.slice(lo, hi);
    const scored = updates
      .map((u) => ({ u, n: (win.match(new RegExp(u.id, 'g')) || []).length }))
      .sort((a, b) => b.n - a.n);
    const top = scored[0];
    const runnerUp = scored[1]?.n || 0;
    if (!top || top.n < 3 || top.n <= runnerUp * 2 || usedUpdate.has(top.u.id)) {
      stats.ambiguous++;
      continue;
    }
    usedUpdate.add(top.u.id);
    stats.joined++;

    const actor = actorFor.get(top.u.id) || null;
    const emails = [...new Set((body.match(new RegExp(EMAIL_RE, 'g')) || []))]
      .filter((e) => !/\.(png|jpe?g|gif|svg|webp)$/i.test(e));

    // Reachability is the bar, not identity: an address in the body is enough
    // on its own, and a profile is enough on its own. Only a post offering
    // neither is unusable, and those are dropped rather than stored.
    if (requireContact && !emails.length && !actor?.slug) { stats.unreachable++; continue; }

    posts.push({
      id: top.u.id,
      source: 'sdui',
      extractedAt: now,
      processed: false,
      author: {
        name: actor?.name || null,
        headline: actor?.headline || null,
        profileUrl: actor?.slug ? `https://www.linkedin.com/in/${actor.slug}` : null,
        degree: null,
      },
      post: {
        text: body,
        url: top.u.url || `https://www.linkedin.com/feed/update/urn:li:activity:${top.u.id}/`,
        postedAgo: null,
        hashtags: [...new Set(body.match(/#[\p{L}\d_]+/gu) || [])],
      },
      contacts: { emails, links: r.links.filter((l) => !l.startsWith('mailto:')) },
      job: null,
      engagement: { reactions: 0, comments: 0, reposts: 0 },
    });
  }

  return { posts, stats };
}

export default { parseContentSearchSDUI };
