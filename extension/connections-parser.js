// LinkedIn Connections page parser.
// LinkedIn serves TWO different DOMs for this page depending on the account:
//   1. SDUI — obfuscated classes, anchored on componentkey + /messaging/compose
//      hrefs + "Connected on <date>" text.
//   2. Classic Ember — stable `mn-connection-card__*` classes, name/occupation
//      in spans, a Message <button> (no compose href), and a relative
//      "Connected <N> <unit> ago" <time> badge.
// We handle both: findCards collects cards from either shape and parseCard
// reads each field with an SDUI selector first, falling back to the classic one.

(() => {
  const PROFILE_RE = /^https?:\/\/(?:www\.)?linkedin\.com\/in\/[^/?#]+/;

  // Whitespace-collapsed text of an element (classic DOM is heavily indented).
  const textOf = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  function getList() {
    return document.querySelector('[componentkey="ConnectionsPage_ConnectionsList"]');
  }

  // Collect connection cards from either DOM shape.
  //   SDUI: climb from each /messaging/compose anchor until we hit an ancestor
  //   that also contains an /in/ link — that's the card boundary.
  //   Classic: the cards are explicit `<li class="mn-connection-card">` items.
  // On any given page only one shape is present, but unioning both (deduped by
  // element) is harmless and means no per-account branching.
  function findCards(root) {
    const cards = new Set();
    if (root) {
      for (const a of root.querySelectorAll('a[href*="/messaging/compose"]')) {
        let el = a;
        for (let i = 0; i < 10 && el; i++) {
          if (el.querySelector && el.querySelector('a[href*="/in/"]')) {
            cards.add(el);
            break;
          }
          el = el.parentElement;
        }
      }
    }
    for (const li of document.querySelectorAll('li.mn-connection-card, .mn-connection-card')) {
      cards.add(li);
    }
    return [...cards];
  }

  // Classic badge is a relative "Connected <N> <unit> ago" — convert to an
  // approximate ISO timestamp off the current clock so the Forge side can still
  // sort by recency. (SDUI's absolute "Connected on <date>" uses parseConnectedOn.)
  function parseRelativeConnected(text) {
    if (!text) return null;
    const m = text.match(/Connected\s+(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const ms = { minute: 60e3, hour: 3600e3, day: 864e5, week: 6048e5, month: 26298e5, year: 315576e5 }[m[2].toLowerCase()];
    if (!ms) return null;
    return new Date(Date.now() - n * ms).toISOString();
  }

  function parseConnectedOn(text) {
    if (!text) return null;
    const m = text.match(/Connected on\s+([A-Za-z]+\s+\d+,\s*\d{4})/i);
    if (!m) return null;
    const d = new Date(m[1]);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function parseProfileUrn(messagingHref) {
    if (!messagingHref) return null;
    try {
      const url = new URL(messagingHref, 'https://www.linkedin.com');
      const urn = url.searchParams.get('profileUrn');
      const recipient = url.searchParams.get('recipient');
      const decoded = urn ? decodeURIComponent(urn) : null;
      const fsdMatch = decoded ? decoded.match(/fsd_profile:([A-Za-z0-9_-]+)/) : null;
      return {
        profileUrn: decoded,
        fsdProfileId: fsdMatch ? fsdMatch[1] : null,
        recipient: recipient || (fsdMatch ? fsdMatch[1] : null),
      };
    } catch {
      return null;
    }
  }

  // Build a clean LinkedIn messaging URL (no lipi tracking suffix), so the
  // generated link looks like a normal user click rather than automated.
  function buildMessageUrl({ profileUrn, recipient, fsdProfileId }) {
    if (!profileUrn && !fsdProfileId) return null;
    const urn = profileUrn || `urn:li:fsd_profile:${fsdProfileId}`;
    const recip = recipient || fsdProfileId;
    const params = new URLSearchParams();
    params.set('profileUrn', urn);
    if (recip) params.set('recipient', recip);
    params.set('interop', 'msgOverlay');
    return `https://www.linkedin.com/messaging/compose/?${params.toString()}`;
  }

  function parseCard(card) {
    if (!card) return null;
    const inLinks = [...card.querySelectorAll('a[href*="/in/"]')];
    const profileAnchor =
      inLinks.find(a => (a.textContent || '').trim().length > 0) || inLinks[0];
    if (!profileAnchor) return null;
    const profileUrl = (profileAnchor.href || '').split('?')[0].replace(/\/$/, '');
    if (!PROFILE_RE.test(profileUrl)) return null;

    const namedAnchor = inLinks.find(a => (a.textContent || '').trim().length > 0);

    // Name: classic span → SDUI paragraph-in-anchor → image alt.
    let name = textOf(card.querySelector('.mn-connection-card__name'));
    if (!name && namedAnchor) {
      const ps = namedAnchor.querySelectorAll('p');
      if (ps.length >= 1) name = textOf(ps[0]);
    }
    if (!name) {
      const img = card.querySelector('img[alt]');
      // SDUI alt is "X's profile picture" (curly apostrophe); classic alt is the
      // bare name, sometimes suffixed " is hiring". Strip both, ignore generics.
      if (img) {
        name = (img.alt || '')
          .replace(/['’]s\s+profile picture$/i, '')
          .replace(/\s+is hiring$/i, '')
          .trim();
        if (/^profile picture$/i.test(name)) name = '';
      }
    }
    if (!name) return null;

    // Headline: classic occupation span → SDUI second paragraph.
    let headline = textOf(card.querySelector('.mn-connection-card__occupation'));
    if (!headline && namedAnchor) {
      const ps = namedAnchor.querySelectorAll('p');
      if (ps.length >= 2) headline = textOf(ps[1]);
    }

    // Connected badge: classic <time> → SDUI "Connected on" paragraph.
    let connectedOnText = '';
    const timeEl = card.querySelector('time.time-badge, time');
    if (timeEl && /^Connected/i.test(textOf(timeEl))) {
      connectedOnText = textOf(timeEl);
    }
    if (!connectedOnText) {
      for (const p of card.querySelectorAll('p')) {
        const t = textOf(p);
        if (/^Connected on /i.test(t)) { connectedOnText = t; break; }
      }
    }
    const connectedOn = parseConnectedOn(connectedOnText) || parseRelativeConnected(connectedOnText);

    const msgAnchor = card.querySelector('a[href*="/messaging/compose"]');
    const msgInfo = msgAnchor ? parseProfileUrn(msgAnchor.getAttribute('href')) : null;

    const photoEl = card.querySelector('img[src*="media.licdn.com"]');
    const photoUrl = photoEl ? photoEl.src : null;

    const profileSlug = profileUrl.replace(/^https?:\/\/(?:www\.)?linkedin\.com\/in\//, '');

    return {
      profileUrl,
      profileSlug,
      name,
      headline: headline || null,
      connectedOnText: connectedOnText || null,
      connectedOn,
      photoUrl,
      profileUrn: msgInfo?.profileUrn || null,
      fsdProfileId: msgInfo?.fsdProfileId || null,
      recipient: msgInfo?.recipient || null,
      messageUrl: buildMessageUrl(msgInfo || {}),
    };
  }

  function parseConnectionsPage() {
    const list = getList();
    const cards = findCards(list);
    const out = [];
    const seen = new Set();
    for (const c of cards) {
      const rec = parseCard(c);
      if (!rec) continue;
      if (seen.has(rec.profileUrl)) continue;
      seen.add(rec.profileUrl);
      out.push(rec);
    }
    return out;
  }

  // Optional total count from the header ("853 connections"). The header sits
  // as a sibling of the list, not inside it, so query the document directly.
  function parseTotalCount() {
    const header = document.querySelector('[componentkey="ConnectionsPage_ConnectionsListHeader"]')
      || document.querySelector('.mn-connections__header')
      || document.querySelector('section.mn-connections h1');
    const text = header ? header.textContent || '' : '';
    const m = text.match(/([\d,]+)\s+connections?/i);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  window.ConnectTrackerParser = {
    parseConnectionsPage,
    parseTotalCount,
    parseCard,
    findCards,
    getList,
    buildMessageUrl,
  };
})();
