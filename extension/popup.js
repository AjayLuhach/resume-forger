// Talks to the Resume Forge server at the /api/ext/* mount. The server PORT
// is a setting in this popup (chrome.storage.local.forgeServerPort, default
// 5003) and must equal PORT in the server's .env. The manifest permits any
// localhost port and background.js rewrites every request from content.js
// to the configured one, so nobody edits the manifest or reloads the
// extension to move the server. All fetches include credentials so the
// server's session cookie rides along when the operator is logged in to it
// in the same browser — that, or the single user in its database, is how
// the server knows who is scanning. The extension itself carries no identity.
const PORT_KEY = 'forgeServerPort';
const DEFAULT_PORT = 5003;
let SERVER_PORT = DEFAULT_PORT;
let SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
let SERVER_URL = `${SERVER_ORIGIN}/api/ext`;
// "Open Dashboard" opens the apply tracker page, where scanned jobs are
// rendered as pending rows with the full analysis details expanded inline.
let DASHBOARD_URL = `${SERVER_ORIGIN}/apply`;

function applyPort(port) {
  const p = Number(port);
  SERVER_PORT = Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
  SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
  SERVER_URL = `${SERVER_ORIGIN}/api/ext`;
  DASHBOARD_URL = `${SERVER_ORIGIN}/apply`;
}

async function loadPort() {
  try {
    const d = await chrome.storage.local.get(PORT_KEY);
    applyPort(d[PORT_KEY]);
  } catch { applyPort(DEFAULT_PORT); }
  const input = document.getElementById('serverPort');
  if (input) input.value = String(SERVER_PORT);
}
const LOG_KEY = 'jobScannerLogs';
const FETCH_OPTS = { credentials: 'include' };

const statusEl = document.getElementById('status');
const serverStatusEl = document.getElementById('serverStatus');
const analyzeBtn = document.getElementById('analyzeBtn');
const resultCard = document.getElementById('resultCard');

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// SERVER CHECK
// ============================================================

async function checkServer() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, FETCH_OPTS);
    if (res.ok) {
      serverStatusEl.textContent = `Server: Connected (Resume Forge :${SERVER_PORT})`;
      serverStatusEl.className = 'server-status online';
      analyzeBtn.disabled = false;
      return true;
    }
  } catch {}
  serverStatusEl.textContent = `Server: Offline on :${SERVER_PORT} — start Resume Forge ("npm run web") and set its PORT above`;
  serverStatusEl.className = 'server-status offline';
  analyzeBtn.disabled = true;
  return false;
}

// ============================================================
// SEND TO CONTENT SCRIPT
// ============================================================

async function sendToContent(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return chrome.tabs.sendMessage(tab.id, msg);
}

// ============================================================
// TABS
// ============================================================

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ============================================================
// RESULT RENDERER
// ============================================================

function renderResult(analysis) {
  const scoreColor = analysis.score >= 7 ? '#44ff44' : analysis.score >= 4 ? '#ffaa00' : '#ff4444';
  const scorePercent = (analysis.score / 10) * 100;

  resultCard.style.display = 'block';
  resultCard.innerHTML = `
    <div class="result-card verdict-${analysis.verdict}">
      <div class="result-header">
        <div>
          <div class="result-title">${escapeHtml(analysis.title || 'Unknown Title')}</div>
          <div class="result-company">${escapeHtml(analysis.company || 'Unknown')} ${analysis.location ? '• ' + escapeHtml(analysis.location) : ''}</div>
        </div>
        <span class="verdict-badge verdict-${analysis.verdict}">${analysis.verdict} ${analysis.score}/10</span>
      </div>
      <div class="score-bar">
        <div class="score-fill" style="width: ${scorePercent}%; background: ${scoreColor};"></div>
      </div>
      ${analysis.salary ? `<div style="font-size:11px;color:#aaa;margin-bottom:6px;">Salary: ${escapeHtml(analysis.salary)}</div>` : ''}
      ${analysis.experience_required ? `<div style="font-size:11px;color:#aaa;margin-bottom:6px;">Experience: ${escapeHtml(analysis.experience_required)}</div>` : ''}
      <div class="result-section">
        <div class="result-section-title">Summary</div>
        <div class="result-summary">${escapeHtml(analysis.summary || '')}</div>
      </div>
      ${analysis.key_skills_match?.length ? `
        <div class="result-section">
          <div class="result-section-title">Matching Skills</div>
          <div class="skill-tags">${analysis.key_skills_match.map(s => `<span class="skill-tag match">${escapeHtml(s)}</span>`).join('')}</div>
        </div>` : ''}
      ${analysis.key_skills_missing?.length ? `
        <div class="result-section">
          <div class="result-section-title">Missing Skills</div>
          <div class="skill-tags">${analysis.key_skills_missing.map(s => `<span class="skill-tag missing">${escapeHtml(s)}</span>`).join('')}</div>
        </div>` : ''}
      ${analysis.red_flags?.length ? `
        <div class="result-section">
          <div class="result-section-title">Red Flags</div>
          ${analysis.red_flags.map(f => `<div class="red-flag">• ${escapeHtml(f)}</div>`).join('')}
        </div>` : ''}
      ${analysis.apply_recommendation ? `<div class="recommendation">${escapeHtml(analysis.apply_recommendation)}</div>` : ''}
    </div>`;
}

// ============================================================
// ANALYZE (manual trigger)
// ============================================================

analyzeBtn.addEventListener('click', async () => {
  const online = await checkServer();
  if (!online) return;

  setStatus('Extracting job details...', 'loading');
  analyzeBtn.disabled = true;
  resultCard.style.display = 'none';

  try {
    const extractResult = await sendToContent({ action: 'extract' });
    if (extractResult.error || !extractResult.jobText || extractResult.jobText.length < 50) {
      setStatus('Could not extract job details from this page', 'error');
      analyzeBtn.disabled = false;
      return;
    }

    setStatus(`Analyzing ${extractResult.jobText.length} chars with AI...`, 'loading');

    const res = await fetch(`${SERVER_URL}/analyze`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobText: extractResult.jobText,
        pageUrl: extractResult.pageUrl,
        pageTitle: extractResult.pageTitle,
        jobId: extractResult.jobId,
        companyInfo: extractResult.companyInfo,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Server error' }));
      throw new Error(err.error || `Server returned ${res.status}`);
    }

    const { analysis } = await res.json();
    renderResult(analysis);
    setStatus('', '');
    loadResults();
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    analyzeBtn.disabled = false;
  }
});

// ============================================================
// RESULTS (from server JSON)
// ============================================================

async function loadResults() {
  try {
    const res = await fetch(`${SERVER_URL}/results`, FETCH_OPTS);
    if (!res.ok) return;
    const results = await res.json();
    const container = document.getElementById('resultsList');
    const badge = document.getElementById('resultsBadge');

    if (results.length > 0) {
      badge.textContent = results.length;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }

    if (results.length === 0) {
      container.innerHTML = '<div class="empty-msg">No analyzed jobs yet.</div>';
      return;
    }

    container.innerHTML = results.map(h => {
      const date = new Date(h.analyzedAt).toLocaleDateString();
      // `applied` is the operator's own state; `importedFrom` marks a row
      // whose analysis came from a peer's database and hasn't been re-run
      // against this resume yet (visiting the job does that).
      const marks = [
        h.applied ? '✓ applied' : '',
        h.importedFrom ? `imported from ${h.importedFrom.label || 'peer'}` : '',
      ].filter(Boolean).map(escapeHtml).join(' • ');
      return `<div class="history-entry" data-url="${escapeHtml(h.url || '')}">
        <div class="history-header">
          <span class="history-title">${escapeHtml(h.title || 'Unknown')}</span>
          <span class="verdict-badge verdict-${h.verdict}" style="font-size:9px;padding:1px 6px;">${h.verdict} ${h.score}/10</span>
        </div>
        <div class="history-meta">${escapeHtml(h.company || '')} • ${date}${marks ? ' • ' + marks : ''}</div>
      </div>`;
    }).join('');

    container.querySelectorAll('.history-entry').forEach(entry => {
      entry.addEventListener('click', () => {
        const item = results.find(r => r.url === entry.dataset.url);
        if (item) renderResult(item);
      });
    });
  } catch {}
}

document.getElementById('refreshResults').addEventListener('click', loadResults);
// There is deliberately no bulk "clear" here — the server exposes no
// bulk-delete on /api/ext, because wiping the apply tracker from a browser
// popup is too easy to fat-finger. Reset rows one at a time on /apply.
document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});

// ============================================================
// LOGS (from server JSON)
// ============================================================

async function loadLogs() {
  try {
    // Logs are local to the extension (chrome.storage.local) — the tailor
    // server doesn't expose a per-extension log feed (it has its own server
    // logger and you read it via `journalctl` / terminal).
    const data = await chrome.storage.local.get(LOG_KEY);
    const logs = data[LOG_KEY] || [];
    const reversed = logs.slice().reverse();
    const container = document.getElementById('logList');
    const badge = document.getElementById('logBadge');

    const errorCount = reversed.filter(l => l.level === 'error').length;
    if (errorCount > 0) {
      badge.textContent = errorCount;
      badge.style.display = 'inline';
      badge.style.background = '#ff4444';
    } else {
      badge.style.display = 'none';
    }

    if (reversed.length === 0) {
      container.innerHTML = '<div class="empty-msg">No logs yet.</div>';
      return;
    }

    container.innerHTML = reversed.slice(0, 100).map(log => {
      const time = new Date(log.timestamp).toLocaleTimeString();
      return `<div class="log-entry level-${log.level}">
        <span class="log-time">${time}</span>
        <span class="log-cat">[${log.level}]</span>
        <span class="log-msg">${escapeHtml(log.message)}</span>
      </div>`;
    }).join('');
  } catch {}
}

document.getElementById('refreshLogs').addEventListener('click', loadLogs);

// Auto-refresh: the content script writes log entries to chrome.storage.local
// from another context (the LinkedIn tab). Without this listener the popup
// would only see new entries when the user clicked Refresh.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[LOG_KEY]) loadLogs();
});
document.getElementById('clearLogs').addEventListener('click', async () => {
  // Clears only the extension's chrome.storage.local log buffer. The tailor
  // server's own logs go to stdout — read them in the terminal that ran
  // `npm run web`.
  await chrome.storage.local.set({ [LOG_KEY]: [] });
  loadLogs();
});

// ============================================================
// FEED CAPTURE (arm/disarm the feed window; status mirror)
// ============================================================

// A getter, not a constant: the port can change while the popup is open.
const FC = () => `${SERVER_URL}/feed-capture`;
let fcTimer = null;

function fcRender(st) {
  const tog = document.getElementById('fcPopToggle');
  const stat = document.getElementById('fcPopStatus');
  if (!tog || !stat) return;
  const cap = st.chunkCount ? ` · ${st.chunkCount}p` : '';
  if (st.armed) {
    tog.textContent = 'Stop capturing';
    const s = Math.max(0, Math.round(st.remainingMs / 1000));
    stat.textContent = `Capturing ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${cap}`;
    stat.style.color = '#44ff44';
  } else {
    tog.textContent = 'Start capturing';
    stat.textContent = cap ? `Idle${cap}.` : 'Idle.';
    stat.style.color = '#888';
  }
}

async function fcRefresh() {
  try {
    const r = await fetch(`${FC()}/status`, FETCH_OPTS);
    if (!r.ok) return;
    const st = await r.json();
    fcRender(st);
    if (!st.armed && fcTimer) { clearInterval(fcTimer); fcTimer = null; }
  } catch {}
}
function fcStartPoll() { if (!fcTimer) fcTimer = setInterval(fcRefresh, 3000); }

document.getElementById('fcPopToggle')?.addEventListener('click', async () => {
  const armed = document.getElementById('fcPopToggle').textContent.startsWith('Stop');
  const r = await fetch(`${FC()}/${armed ? 'disarm' : 'arm'}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  if (r.ok) { fcRender(await r.json()); if (!armed) fcStartPoll(); }
});

// Copy the auto-scroll script to paste into the LinkedIn tab's console.
document.getElementById('fcPopCopy')?.addEventListener('click', async () => {
  const btn = document.getElementById('fcPopCopy');
  const orig = btn.textContent;
  const script = (document.getElementById('fcScrollScript')?.textContent || '').trim();
  try { await navigator.clipboard.writeText(script); }
  catch {
    const ta = document.createElement('textarea'); ta.value = script; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  }
  btn.textContent = 'Copied ✓';
  setTimeout(() => { btn.textContent = orig; }, 2000);
});

document.getElementById('fcPopOpen')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.linkedin.com/feed/' });
});

// ============================================================
// INIT
// ============================================================

async function onServerOnline() {
  loadResults();
  loadLogs();
  await fcRefresh();
  const tog = document.getElementById('fcPopToggle');
  if (tog && tog.textContent.startsWith('Stop')) fcStartPoll();
}

async function init() {
  await loadPort();
  const input = document.getElementById('serverPort');
  const save = document.getElementById('savePortBtn');
  const persist = async () => {
    applyPort(input.value);
    input.value = String(SERVER_PORT);
    try { await chrome.storage.local.set({ [PORT_KEY]: SERVER_PORT }); } catch { /* storage unavailable — port still applies for this popup */ }
    if (await checkServer()) onServerOnline();
  };
  if (save && input) {
    save.addEventListener('click', persist);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') persist(); });
  }
  if (await checkServer()) onServerOnline();
}
init();
