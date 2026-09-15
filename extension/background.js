// Background service worker. Exists for ONE reason: MV3 content scripts go
// through the host page's CORS rules when calling `fetch()`, which blocks
// every cross-origin call from linkedin.com → http://localhost:5003 with
// a generic "CORS error" (no useful detail in DevTools). The popup works
// because it runs in chrome-extension:// origin which is exempt.
//
// This worker IS in extension context, so its fetches DO use host_permissions
// and DON'T go through page-level CORS. content.js forwards every server
// call through here via chrome.runtime.sendMessage and gets a structured
// reply: { ok, status, body, error }.
//
// Keep the message protocol tiny — one action ('fetch') with { url, method,
// body }. JSON in and out only.
//
// Every fetch sends credentials so the Resume Forge session cookie rides
// along when the operator is logged in to the server in this browser: the
// server resolves the operator from that cookie, else from the single user
// in its database, so the extension never has to know a name itself.

// The server port is a popup setting (chrome.storage.local.forgeServerPort,
// default 5003). content.js builds its URLs against the default origin and
// this worker swaps in the configured port — one place, no manifest edit,
// no extension reload when the server moves.
const PORT_KEY = 'forgeServerPort';
const DEFAULT_PORT = 5003;
let _port = DEFAULT_PORT;
async function readPort() {
  try {
    const d = await chrome.storage.local.get(PORT_KEY);
    const p = Number(d[PORT_KEY]);
    _port = Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
  } catch { _port = DEFAULT_PORT; }
  return _port;
}
const toServer = (url) =>
  String(url).replace(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(?=\/)/i, `http://localhost:${_port}`);

// Auto-connect queue. The Posts page hands over profile URLs; we work through
// them ONE AT A TIME: open the profile, wait for the content script's verdict
// (or the timeout), close the tab if it finished, pause 4–5 s, next. Never
// the whole list at once — LinkedIn rate-limits invitations and a tab storm
// looks like exactly what it is. Failures stay open for a human look. State
// lives in this worker: a worker restart mid-run drops the remainder — the
// page shows what did land via the connects rows (a confirmed sent / Pending
// is never offered again), so nothing is double-sent. The tab opens ACTIVE
// so the operator can watch each click land.
const AUTO_BATCH = 1;
const AUTO_ACTIVE_TAB = true;
const AUTO_TIMEOUT_MS = 60000;
const AUTO_GAP_MS = [4000, 5000];
// One entry per person: the same slug queued twice (two posts, or a second
// click while a run is going) would open their profile twice.
const slugOf = (url) => (String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] || '').toLowerCase();
const KEEP_OPEN = new Set(['error', 'not-found', 'timeout', 'limit']);
const _auto = { queue: [], inFlight: [], running: false, waiters: new Map() };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOne(item) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: `${item.profileUrl.split('#')[0]}#fgconnect`, active: AUTO_ACTIVE_TAB });
  } catch (e) {
    return { result: 'error', detail: e.message };
  }
  const outcome = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ result: 'timeout' }), AUTO_TIMEOUT_MS);
    _auto.waiters.set(tab.id, (r) => { clearTimeout(t); resolve(r); });
  });
  _auto.waiters.delete(tab.id);
  if (!KEEP_OPEN.has(outcome.result)) chrome.tabs.remove(tab.id).catch(() => {});
  return outcome;
}

async function runAutoConnect() {
  if (_auto.running) return;
  _auto.running = true;
  try {
    while (_auto.queue.length) {
      const batch = _auto.queue.splice(0, AUTO_BATCH);
      _auto.inFlight = batch;
      const runs = [];
      for (let i = 0; i < batch.length; i++) {
        runs.push(runOne(batch[i]));
        if (i < batch.length - 1) await wait(1000);
      }
      const outcomes = await Promise.all(runs);
      _auto.inFlight = [];
      if (outcomes.some((o) => o.result === 'limit')) { _auto.queue.length = 0; break; } // LinkedIn said stop
      if (_auto.queue.length) await wait(AUTO_GAP_MS[0] + Math.random() * (AUTO_GAP_MS[1] - AUTO_GAP_MS[0]));
    }
  } finally {
    _auto.running = false;
    _auto.inFlight = [];
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === 'autoConnectQueue') {
    const queued = new Set([..._auto.queue, ..._auto.inFlight].map((i) => slugOf(i.profileUrl)));
    const items = (msg.items || []).filter((i) => {
      if (!i || !/^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(i.profileUrl)) return false;
      const k = slugOf(i.profileUrl);
      if (!k || queued.has(k)) return false;
      queued.add(k);
      return true;
    });
    _auto.queue.push(...items);
    runAutoConnect();
    sendResponse({ ok: true, queued: items.length, pending: _auto.queue.length });
    return false;
  }
  // A profile tab asks whether it is one of ours. Deterministic, unlike the
  // URL hash, which LinkedIn's router sometimes strips before inject.js runs.
  if (msg?.action === 'autoConnectCheck') {
    const tabId = _sender?.tab?.id;
    sendResponse({ run: tabId != null && _auto.waiters.has(tabId) });
    return false;
  }
  if (msg?.action === 'autoConnectResult') {
    const tabId = _sender?.tab?.id;
    const waiter = tabId != null ? _auto.waiters.get(tabId) : null;
    if (waiter) waiter({ result: msg.result, detail: msg.detail });
    sendResponse({ ok: !!waiter });
    return false;
  }
  if (msg?.action === 'closeTab') {
    const tabId = _sender?.tab?.id;
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    sendResponse({ ok: tabId != null });
    return false;
  }
  if (msg?.action !== 'fetch') return false;

  // IIFE so we can use async/await; sendResponse is async via `return true`.
  (async () => {
    const t0 = Date.now();
    try {
      await readPort();
      const init = {
        method: msg.method || 'GET',
        credentials: 'include',
        headers: msg.body ? { 'Content-Type': 'application/json' } : undefined,
        body: msg.body || undefined,
      };
      const res = await fetch(toServer(msg.url), init);
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      sendResponse({
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        body: json,
        text: json ? null : text,
        dur: Date.now() - t0,
      });
    } catch (e) {
      // Network-level failure. Surface enough that content.js can log a
      // useful diagnostic (the previous "Failed to fetch" was useless).
      sendResponse({
        ok: false,
        error: `${e.name || 'Error'}: ${e.message}`,
        dur: Date.now() - t0,
      });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
});
