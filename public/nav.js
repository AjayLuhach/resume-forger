// Unified navigation rail — injected into every page.
// Renders the vertical sidebar with grouped sections so all pages share
// one design language. The rail figures out the active item from
// window.location and exposes data-active="true" on the matching link.
(() => {
  const NAV_GROUPS = [
    {
      label: 'Tailor',
      links: [
        { href: '/',              label: 'Generate',   id: 'generate' },
        { href: '/resume.html',   label: 'Resume',     id: 'resume' },
        { href: '/history.html',  label: 'History',    id: 'history' },
        { href: '/contacts.html', label: 'Contacts',   id: 'contacts' },
        { href: '/gaps.html',     label: 'Skill Gaps', id: 'gaps' },
      ],
    },
    {
      label: 'Outreach',
      links: [
        { href: '/posts',         label: 'Posts',    id: 'posts' },
        { href: '/feed',          label: 'Emails',     id: 'feed' },
        { href: '/connects',      label: 'Connects',   id: 'connects' },
        { href: '/mail',          label: 'Mail',       id: 'mail' },
      ],
    },
    {
      label: 'Direct',
      links: [
        { href: '/apply',            label: 'Apply',       id: 'apply' },
        { href: '/scanner',          label: 'Scanner',     id: 'scanner' },
        { href: '/connections.html', label: 'Connections', id: 'connections' },
      ],
    },
    {
      label: 'Docs',
      links: [
        { href: '/about.html',    label: 'About',    id: 'about' },
      ],
    },
  ];

  // Glyphs are tiny SVG marks — flat, monoline, the same stroke weight, gold
  // accent on active. Keep them subtle; the typography does the heavy lifting.
  const GLYPH = {
    generate: '<path d="M3 12h12m0 0l-4-4m4 4l-4 4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    resume:   '<path d="M5 2h6l3 3v11H5z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/><path d="M11 2v3h3M7 8h5M7 11h5M7 14h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    history:  '<path d="M3 9a6 6 0 1 1 1.5 4M3 5v4h4M9 6v4l3 1.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    gaps:     '<path d="M2 14l4-6 4 4 4-7" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    feed:     '<path d="M3 9h12M3 13h12M3 5h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="5" r="1.2" fill="currentColor"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="12" cy="13" r="1.2" fill="currentColor"/>',
    posts:    '<rect x="3" y="3" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M5.5 7h7M5.5 10h7M5.5 13h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    emails:   '<path d="M2.5 5.5h13v8h-13z M3 6l6 4 6-4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    contacts: '<circle cx="9" cy="6" r="2.4" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M3 14c1-3 3.4-4.5 6-4.5S14 11 15 14" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
    apply:    '<rect x="3" y="3" width="4" height="12" rx="1" stroke="currentColor" stroke-width="1.4" fill="none"/><rect x="8" y="3" width="4" height="8" rx="1" stroke="currentColor" stroke-width="1.4" fill="none"/><rect x="13" y="3" width="2.5" height="5" rx="1" stroke="currentColor" stroke-width="1.4" fill="none"/>',
    scanner:  '<rect x="2.5" y="3.5" width="13" height="11" rx="1" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M5 7l3 3 5-5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    mail: '<rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M2.5 5.5 10 11l7.5-5.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    connects: '<circle cx="6" cy="6" r="2.4" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M2 15c.8-2.6 2.3-3.9 4-3.9s3.2 1.3 4 3.9" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><path d="M13 4v6M10 7h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    connections: '<circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.4" fill="none"/><circle cx="13" cy="5" r="2" stroke="currentColor" stroke-width="1.4" fill="none"/><circle cx="9" cy="13" r="2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M6.5 6.5l1.5 4.5M11.5 6.5L10 11M7 5h4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
    about:    '<circle cx="9" cy="9" r="6.4" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M9 6v0M9 8.5v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  };

  const here = window.location.pathname;
  const isActive = (href) => {
    if (href === '/feed') return here === '/feed' || here.startsWith('/feed/');
    if (href === '/')     return here === '/' || here === '/index.html';
    return here === href;
  };

  // Allow per-page subtitle / wordmark override (set window.__APP_TITLE
  // before this script runs to customize). Defaults to "Resume Forge".
  const wordmark = window.__APP_TITLE || 'Resume Forge';

  const linkHtml = (link) => `
    <a class="rail__link" href="${link.href}" data-active="${isActive(link.href)}">
      <svg class="rail__link-glyph" viewBox="0 0 18 18" aria-hidden="true">${GLYPH[link.id] || ''}</svg>
      <span>${link.label}</span>
    </a>`;

  const groupHtml = (g) => `
    <div class="rail__group">
      <div class="rail__group-label">${g.label}</div>
      ${g.links.map(linkHtml).join('')}
    </div>`;

  const userPillHtml = () => {
    const userName = window.__APP_USER || 'Profile';
    const initial = userName.trim().charAt(0).toUpperCase() || '·';
    return `
      <div class="rail__user-wrap" style="display:flex;align-items:stretch;gap:6px">
        <a class="rail__user" href="/settings" style="flex:1">
          <span class="rail__user-avatar">${initial}</span>
          <span>
            <span class="rail__user-name">${userName}</span>
            <span class="rail__user-meta">Account · settings</span>
          </span>
        </a>
        <button id="railLogout" title="Sign out"
                style="background:transparent;border:1px solid var(--line);border-radius:8px;
                       color:var(--ink-3);padding:0 10px;cursor:pointer;display:grid;place-items:center"
                onmouseover="this.style.color='var(--brick)';this.style.borderColor='var(--brick)'"
                onmouseout="this.style.color='var(--ink-3)';this.style.borderColor='var(--line)'">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none">
            <path d="M10 11l3-3-3-3M13 8H6M9 3H3v10h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>`;
  };

  async function handleLogout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch {}
    location.href = '/login.html';
  }

  const railHtml = `
    <a class="rail__brand" href="/">
      <span class="rail__brand-mark">Forge</span>
    </a>
    ${NAV_GROUPS.map(groupHtml).join('')}
    <div class="rail__spacer"></div>
    ${userPillHtml()}
  `;

  function mount() {
    // Rip out any legacy top-bar nav rendered by the page itself.
    document.querySelectorAll('nav.nav, .nav').forEach(n => n.remove());

    const body = document.body;
    if (body.classList.contains('app--ready')) return;
    body.classList.add('app--ready');

    const app = document.createElement('div');
    app.className = 'app';

    const rail = document.createElement('aside');
    rail.className = 'rail';
    rail.innerHTML = railHtml;

    const main = document.createElement('main');
    main.className = 'main';

    // Snapshot the existing body children, then move non-script nodes into
    // the main column. Scripts stay where they are — they've already executed
    // and re-parenting them is both unsafe (would re-execute) and was the
    // source of an infinite-loop hang on pages with trailing inline scripts.
    const initial = Array.from(body.childNodes);
    for (const node of initial) {
      if (node.nodeType === 1 && node.tagName === 'SCRIPT') continue;
      // Skip stray text nodes (whitespace) — leaving them in body is fine.
      if (node.nodeType === 3) continue;
      main.appendChild(node);
    }

    app.appendChild(rail);
    app.appendChild(main);
    body.insertBefore(app, body.firstChild);
  }

  // After the rail is in place, hydrate the user pill from /api/me (the
  // authenticated session). Falls back to /feed/api/config-user if /api/me
  // isn't available (legacy path).
  function hydrateUser() {
    fetch('/api/me').then(r => r.ok ? r.json() : null).then(d => {
      const name = d?.user?.username;
      if (!name) return;
      const nameEl = document.querySelector('.rail__user-name');
      const avatarEl = document.querySelector('.rail__user-avatar');
      if (nameEl) nameEl.textContent = name;
      if (avatarEl) avatarEl.textContent = name.trim().charAt(0).toUpperCase();
    }).catch(() => {});
  }

  function wireLogout() {
    const btn = document.getElementById('railLogout');
    if (btn) btn.addEventListener('click', handleLogout);
  }

  // Intercept fetch — on 401 the session is bad, redirect to login.
  function installFetchGuard() {
    const orig = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const r = await orig(...args);
      if (r.status === 401) {
        const url = (args[0] && typeof args[0] === 'string') ? args[0] : (args[0]?.url || '');
        // Don't loop on the login/logout/me endpoints themselves.
        if (!/\/api\/(login|logout|me)/.test(url)) {
          location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
        }
      }
      return r;
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Daily "Open LinkedIn Connections" reminder.
  //
  // Floats bottom-right on every page. Pulses gold→ember while the date in
  // localStorage doesn't match today's local date — the cue is "you
  // haven't refreshed your network today; the extension can't scrape
  // anything new until you visit the page." Click stamps today and opens
  // the connections URL in a new tab. The user can also dismiss without
  // opening (long-press / right-click) but we keep that out for now —
  // forcing the click ensures the page actually loads.
  // ─────────────────────────────────────────────────────────────────────
  const CONN_REMINDER_KEY = 'forge.connectionsLastOpenedAt';
  const CONN_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';

  function todayKey() {
    const d = new Date();
    // Local-date string, not ISO — ISO uses UTC which flips the "today"
    // line for users near midnight.
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function isStaleToday() {
    try { return localStorage.getItem(CONN_REMINDER_KEY) !== todayKey(); }
    catch { return true; }
  }

  // Daily-routine button. Clicking opens LinkedIn Connections AND every URL
  // the user has configured at /settings → Daily reminder tabs. Stale
  // (blinking) when today's routine hasn't been completed; it stays a small
  // corner chip either way. First tab opens synchronously inside the user
  // gesture so the popup blocker accepts it; subsequent tabs are scheduled
  // with 2–3 s random gaps so Chrome doesn't block them.
  function injectConnReminder() {
    if (document.getElementById('connReminderBtn')) return;
    const style = document.createElement('style');
    style.textContent = `
      #connReminderBtn {
        position: fixed; right: 70px; bottom: 22px; z-index: 10;
        width: 38px; height: 38px;
        display: flex; align-items: center; justify-content: center;
        color: var(--gold, #d4a017);
        background: var(--surface-2, #1a1a2a);
        border: 1px solid var(--line, #2a2a3a);
        border-radius: 50%;
        cursor: pointer;
        transition: border-color 100ms ease, color 100ms ease, opacity 100ms ease;
      }
      #connReminderBtn:hover { border-color: var(--gold, #d4a017); color: var(--gold, #d4a017); opacity: 1; }
      #connReminderBtn[data-stale="false"] { opacity: 0.35; }
      #connReminderBtn[data-stale="true"] {
        color: #fff;
        border-color: #ff9500;
        animation: connReminderBlink 0.6s ease-in-out infinite;
      }
      @keyframes connReminderBlink {
        0%   { background: #ff4444; box-shadow: 0 0 4px  #ff4444; transform: scale(1); }
        25%  { background: #ff9500; box-shadow: 0 0 18px #ff9500; transform: scale(1.08); }
        50%  { background: #ff4444; box-shadow: 0 0 26px #ff6600; transform: scale(1.02); }
        75%  { background: #ffcc00; box-shadow: 0 0 18px #ffcc00; transform: scale(1.08); }
        100% { background: #ff4444; box-shadow: 0 0 4px  #ff4444; transform: scale(1); }
      }
      #connReminderBtn .ico { width: 18px; height: 18px; display: block; }
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'connReminderBtn';
    btn.innerHTML = `
      <svg class="ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.4"/>
        <circle cx="11" cy="5" r="2" stroke="currentColor" stroke-width="1.4"/>
        <path d="M2.5 13.5C3 11 4.4 10 5 10s2 1 2.5 3.5M9 13.5C9.5 11 10.9 10 11.5 10s2 1 2.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    `;
    btn.title = 'Daily routine — open LinkedIn Connections + your reminder URLs';
    applyReminderState(btn);
    btn.addEventListener('click', () => {
      try { localStorage.setItem(CONN_REMINDER_KEY, todayKey()); } catch {}
      btn.dataset.stale = 'false';
      // Sync open #1 — Connections page. Stays in the user-gesture stack so
      // popup-blocker treats it as initiated by click.
      window.open(CONN_URL, '_blank', 'noopener');
      // Then drip the configured reminder URLs with a 2–3 s random gap so
      // each tab gets its own opening "event" and Chrome stays calm.
      _dailyReminderUrls.forEach((u, i) => {
        const delay = 2000 + Math.floor(Math.random() * 1000) + i * 2500;
        setTimeout(() => window.open(u, '_blank', 'noopener'), delay);
      });
      syncConnReminderTitle();
    });
    document.body.appendChild(btn);
    // Background-fetch the reminder URLs and refresh the title once they
    // land (button is already usable for connections regardless).
    loadDailyReminderUrls().then(syncConnReminderTitle);
  }

  // Reconcile the button with today's state: blink when pending.
  function applyReminderState(btn) {
    const b = btn || document.getElementById('connReminderBtn');
    if (!b) return;
    b.dataset.stale = String(isStaleToday());
  }
  // Another window of this profile completing the routine refreshes this one.
  window.addEventListener('storage', (e) => {
    if (e.key === CONN_REMINDER_KEY) applyReminderState();
  });

  function syncConnReminderTitle() {
    const btn = document.getElementById('connReminderBtn');
    if (!btn) return;
    const extras = _dailyReminderUrls.length
      ? ` + ${_dailyReminderUrls.length} reminder tab${_dailyReminderUrls.length === 1 ? '' : 's'}`
      : '';
    const state = btn.dataset.stale === 'true' ? 'pending today' : 'done for today';
    btn.title = `Daily routine (${state}) — opens LinkedIn Connections${extras}. Manage URLs at /settings.`;
  }


  // Per-user daily-reminder URLs (configured at /settings → "Daily
  // reminder tabs"). The conn-reminder button opens these alongside the
  // LinkedIn Connections page on click — single button, multi-purpose.
  let _dailyReminderUrls = [];

  async function loadDailyReminderUrls() {
    try {
      const r = await fetch('/api/settings');
      if (!r.ok) return;
      const data = await r.json();
      _dailyReminderUrls = Array.isArray(data.dailyReminderUrls) ? data.dailyReminderUrls : [];
    } catch { /* settings unreachable — leave list empty */ }
  }

  function init() {
    mount();
    wireLogout();
    installFetchGuard();
    hydrateUser();
    injectConnReminder();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
