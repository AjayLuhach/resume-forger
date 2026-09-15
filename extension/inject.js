// MAIN-world fetch/XHR hook: capture LinkedIn jobs-search AND home-feed/
// content-search API responses, postMessage them to content.js tagged with
// `kind` ('jobs'|'feed'). Ring buffer + flush event survive the arm race.

(() => {
  "use strict";

  // Latch the Rescan marker before LinkedIn's router can strip it. This file
  // runs at document_start; content.js runs at document_idle, by which time the
  // SPA has often rewritten the URL and #fgcap is gone. When that happened the
  // company page silently did nothing — not scanned, not closed — and the row
  // stayed "missing LI count" forever. Losing the hash is load-dependent, which
  // is why a 50-tab rescan failed on its tail and a small one looked fine.
  try {
    if (/fgcap/i.test(location.hash || '') || /[?&]fgcap\b/i.test(location.search || '')) {
      sessionStorage.setItem('forgeCaptureRun', '1');
    }
    // Same latch for profile tabs the Posts page's Auto-connect opened.
    if (/fgconnect/i.test(location.hash || '')) {
      sessionStorage.setItem('forgeAutoConnect', '1');
    }
  } catch { /* storage blocked — content.js falls back to reading the hash */ }

  if (window.__forgeNetHooked) return; // guard against double-injection
  window.__forgeNetHooked = true;

  const TAG = "forge-jobscanner-net";
  const FLUSH_EVENT = "forge-jobscanner-flush"; // content.js → re-emit buffer
  const MAX_BODY = 4 * 1024 * 1024;
  const MAX_BUFFER_ITEMS = 60;
  const MAX_BUFFER_BYTES = 24 * 1024 * 1024;

  // Debug: set window.__forgeJobDebug = true, then call window.__forgeJobStatus().
  window.__forgeJobDebug = window.__forgeJobDebug || false;
  const dlog = [];
  function debug(tag, msg, extra) {
    dlog.push({ t: new Date().toISOString(), tag, msg, extra });
    if (dlog.length > 500) dlog.shift();
    if (window.__forgeJobDebug) console.log(`[${TAG}] ${tag}: ${msg}`, extra ?? "");
  }

  // Ring buffer of recent payloads, kept regardless of armed state (survives the race).
  const buffer = []; // [{ url, body, kind, at }]
  let bufferBytes = 0;
  function remember(url, body, kind) {
    buffer.push({ url, body, kind, at: Date.now() });
    bufferBytes += body.length;
    while (buffer.length > MAX_BUFFER_ITEMS || bufferBytes > MAX_BUFFER_BYTES) {
      bufferBytes -= buffer.shift().body.length;
    }
  }

  window.__forgeJobStatus = () => ({
    hooked: true,
    buffered: buffer.map((b) => ({ url: b.url, kind: b.kind, bytes: b.body.length, ageMs: Date.now() - b.at })),
    recentLog: dlog.slice(-40),
  });

  function isJobsApi(url) {
    if (typeof url !== "string") return false;
    if (/\/flagship-web\/jobs\/search-results/i.test(url)) return true;
    if (/\/voyager\/api\/voyagerJobsDashJobCards/i.test(url)) return true;
    if (/\/voyager\/api\/graphql/i.test(url) && /job/i.test(url)) return true;
    return false;
  }

  // Cheap pre-gate for feed/content-search APIs (looksLikeFeed is the real filter):
  //  • voyager graphql feed/search (older JSON shape)
  //  • 2026 SDUI/RSC content-search + feed pagination (flagship-web rsc-action)
  function isFeedApi(url) {
    if (typeof url !== "string") return false;
    if (/\/voyager\/api\/graphql/i.test(url) && /(feed|search|cluster|update)/i.test(url)) return true;
    if (/rsc-action\/actions\/pagination/i.test(url) && /(contentSearchResults|feed|search)/i.test(url)) return true;
    if (/\/flagship-web\//i.test(url) && /sdui/i.test(url) && /(content|feed|search)/i.test(url)) return true;
    return false;
  }

  // Only ship payloads that carry an id token the importer's parsers anchor on.
  function looksLikeJobs(text) {
    return (
      typeof text === "string" &&
      /(fsd_jobPosting(Card)?:|\/jobs\/view\/\d|"jobId"\s*:|currentJobId(?:=|%3D)\d|jobPosting:\d|proto\.sdui\.)/.test(
        text,
      )
    );
  }

  // Feed posts: voyager JSON (feedDash…/searchDashClusters… + included), the SDUI
  // content-search marker, or any body carrying a post activity urn.
  function looksLikeFeed(text) {
    if (typeof text !== "string") return false;
    if (/(feedDashMainFeedByMainFeed|searchDashClustersByAll)/.test(text) && /"included"\s*:/.test(text)) return true;
    if (/contentSearchResults/.test(text)) return true;
    if (/urn:li:activity:\d/.test(text)) return true;
    return false;
  }

  // Classify a captured body; null → don't ship. Unambiguous job markers win;
  // then feed; then the generic SDUI (`proto.sdui.`) fallback → jobs. This order
  // matters because the content-search SDUI stream also carries `proto.sdui.`.
  function classify(text) {
    if (typeof text !== "string") return null;
    if (/(fsd_jobPosting(Card)?:|\/jobs\/view\/\d|"jobId"\s*:|currentJobId(?:=|%3D)\d|jobPosting:\d)/.test(text)) return "jobs";
    if (looksLikeFeed(text)) return "feed";
    if (looksLikeJobs(text)) return "jobs";
    return null;
  }

  function post(url, body, kind) {
    try {
      window.postMessage({ source: TAG, url: String(url || ""), body, kind }, "*");
    } catch (e) {
      debug("post-error", String(e), url);
    }
  }

  function ship(url, text) {
    if (!text || text.length > MAX_BODY) { debug("skip", `size=${text ? text.length : 0}`, url); return; }
    const kind = classify(text);
    if (!kind) { debug("skip", "not-jobs-or-feed-like", url); return; }
    remember(url, text, kind);
    post(url, text, kind);
    debug("ship", `${kind} ${text.length}b buffered+posted`, url);
  }

  // content.js fires this when it arms — re-emit anything buffered before it listened.
  window.addEventListener(FLUSH_EVENT, () => {
    debug("flush", `re-emitting ${buffer.length} buffered payload(s)`);
    for (const b of buffer.slice()) post(b.url, b.body, b.kind);
  });

  // clone() so the app's own body read is undisturbed; log read errors.
  function readResponse(res, url) {
    try {
      res.clone().text()
        .then((t) => ship(res.url || url, t))
        .catch((e) => debug("read-error", String(e), url));
    } catch (e) {
      debug("clone-error", String(e), url);
    }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function patchedFetch(input) {
      const url = typeof input === "string" ? input : input && input.url ? input.url : "";
      const p = origFetch.apply(this, arguments);
      if (isJobsApi(url) || isFeedApi(url)) {
        debug("fetch-match", "", url);
        p.then((res) => readResponse(res, url)).catch(() => {});
      }
      return p;
    };
    debug("init", "fetch hooked");
  } else {
    debug("init", "window.fetch missing — not hooked");
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function patchedOpen(_method, url) {
      try { this.__forgeUrl = url; } catch (_e) {}
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function patchedSend() {
      try {
        if (isJobsApi(this.__forgeUrl) || isFeedApi(this.__forgeUrl)) {
          debug("xhr-match", "", this.__forgeUrl);
          this.addEventListener("load", () => {
            try {
              const t = this.responseType === "" || this.responseType === "text" ? this.responseText : null;
              if (t) ship(this.__forgeUrl, t);
            } catch (e) {
              debug("xhr-read-error", String(e), this.__forgeUrl);
            }
          });
        }
      } catch (_e) {}
      return origSend.apply(this, arguments);
    };
  }
})();

// Visibility spoof — toggled by content.js while feed capture is armed. LinkedIn
// (and the browser's render loop) pause feed loading when the tab reports
// hidden, so a backgrounded tab stops fetching. While armed we make the page
// always read visible+focused so it keeps loading in the background. Off by
// default — only flipped on during an armed feed capture, then back off.
(() => {
  "use strict";
  if (window.__forgeVisSpoof) return;
  window.__forgeVisSpoof = true;
  // On from the very first byte for tabs the Posts page's Auto-connect opened
  // (#fgconnect / the sessionStorage latch above): they are background tabs,
  // and LinkedIn will not even render the profile card while it believes the
  // tab is hidden. content.js re-asserts it once it runs.
  let spoof = (() => {
    try {
      return /fgconnect/i.test(location.hash || '') || sessionStorage.getItem('forgeAutoConnect') === '1';
    } catch { return false; }
  })();

  const realVis = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (spoof ? "visible" : (realVis && realVis.get ? realVis.get.call(document) : "visible")),
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => (spoof ? false : document.visibilityState !== "visible"),
    });
  } catch (_e) {}

  const realHasFocus = document.hasFocus.bind(document);
  document.hasFocus = () => (spoof ? true : realHasFocus());

  // Only swallow the document-level visibility event (no element target), never
  // blur/focus — those carry element targets and intercepting them breaks the UI.
  const swallow = (e) => { if (spoof) e.stopImmediatePropagation(); };
  document.addEventListener("visibilitychange", swallow, true);
  window.addEventListener("visibilitychange", swallow, true);
  window.addEventListener("webkitvisibilitychange", swallow, true);

  window.addEventListener("forge-vis-spoof-on", () => { spoof = true; });
  window.addEventListener("forge-vis-spoof-off", () => { spoof = false; });
})();
