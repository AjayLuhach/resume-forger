// Job Scanner — Content Script
// Auto-scans job pages and shows a small verdict pill.
//
// MV3 quirk: content scripts go through the HOST page's CORS rules for
// fetch(), which blocks every cross-origin call from linkedin.com to
// http://localhost:5003 with a generic "CORS error" — host_permissions
// doesn't help. The fix: forward every server call through the background
// service worker via chrome.runtime.sendMessage. The worker runs in
// extension context (same privilege as the popup) so its fetches use
// host_permissions and aren't subject to page-level CORS.
//
// Every "fetch" in this file goes through srvFetch() below. It returns a
// uniform { ok, status, body, error } so callers don't need to know
// whether the failure was network-level or HTTP-level.

(() => {
  // One origin constant per context (popup.js has its own — content scripts
  // and the popup don't share scope). This is the DEFAULT origin only: the
  // real port is a popup setting, and background.js rewrites every request
  // that goes through srvFetch to it — which is why nothing here may call
  // fetch() on the server directly. Identity is the server's business: the
  // background worker forwards the session cookie, and the server falls back
  // to the single user in its database — nothing here carries a name.
  const SERVER_ORIGIN = 'http://localhost:5003';
  const SERVER_URL = `${SERVER_ORIGIN}/api/ext`;
  // Set when the Rescan button opened this tab (#fgcap) — only then do we
  // scan + auto-close. The hash is unreliable by the time this file runs
  // (document_idle): LinkedIn's router rewrites the URL first, and it wins more
  // often the more tabs are opening at once. inject.js latches the marker into
  // sessionStorage at document_start, so read that too.
  const FG_CAPTURE_RUN = /fgcap/i.test(window.location.hash || '')
    || (() => { try { return sessionStorage.getItem('forgeCaptureRun') === '1'; } catch { return false; } })();
  const LOG_KEY = 'jobScannerLogs';
  const MAX_LOGS = 200;

  // ============================================================
  // GLOBAL ERROR REPORTING
  // Surface uncaught errors + unhandled rejections to the tailor server's
  // log so they don't die silently in chrome://extensions. Throttle by
  // message+stack hash so a tight error loop can't flood the server.
  // ============================================================

  const _reportedErrors = new Map(); // hash → first-seen ms
  const ERROR_DEDUP_MS = 60_000;
  function reportError(level, scope, message, stack) {
    try {
      const hash = (scope || '') + '|' + (message || '').slice(0, 200);
      const now = Date.now();
      const seen = _reportedErrors.get(hash);
      if (seen && now - seen < ERROR_DEDUP_MS) return;
      _reportedErrors.set(hash, now);
      const body = JSON.stringify({
        level, scope,
        message: String(message || '').slice(0, 1000),
        stack: stack ? String(stack).slice(0, 2000) : '',
        url: typeof location !== 'undefined' ? location.href : '',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      });
      // Best-effort — failures here must not throw (would loop forever).
      chrome.runtime.sendMessage({
        action: 'fetch', method: 'POST',
        url: `${SERVER_URL}/log`, body,
      }, () => { if (chrome.runtime.lastError) { /* swallow */ } });
    } catch { /* swallow */ }
  }
  window.addEventListener('error', (e) => {
    reportError('error', 'window-error', e.message || 'unknown', e.error?.stack || '');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    reportError('error', 'unhandled-rejection',
      r?.message || String(r) || 'unknown',
      r?.stack || '');
  });

  // ============================================================
  // FORGE COPY-NOTE PIGGYBACK
  //
  // The Forge apply page (/apply on the tailor server) has its own
  // "Note" / inline copy-note buttons. Those buttons write to the
  // clipboard but don't touch chrome.storage.local — so when the user
  // later opens a LinkedIn connect modal, our observer has nothing to
  // pull from. Hook those button clicks here (the content script runs
  // on every URL via the manifest's <all_urls>) and stash the note to
  // chrome.storage.local so the cross-page handoff works whether you
  // copied from the badge or from the apply page.
  // ============================================================

  function stashNoteFromForge(btn) {
    // Two flavors of buttons exist in apply.html — `.copy-note-btn`
    // (uses data-note) and `[data-action="copy-note"]` (also data-note).
    // Both put the raw note string on `data-note`.
    const note = btn.dataset?.note;
    if (!note) return;
    // Best-effort jobId: jump up to the nearest row and read its
    // data-jobid / aria-rowindex. Falls back to empty string when the
    // button isn't inside the apply table (e.g. badge copy goes its
    // own path elsewhere in this file).
    const row = btn.closest('tr,[data-jobid],[data-job-id]');
    const jobId = row?.dataset?.jobid || row?.dataset?.jobId || '';
    chrome.storage.local.set({
      lastConnectNote: { note, jobId, copiedAt: Date.now(), source: 'forge-apply' },
    }).then(() => {
      addLog('info', 'forge', `stashed connectNote from apply page (${note.length} chars, jobId=${jobId || '-'})`);
    }).catch((err) => {
      addLog('error', 'forge', `stash from apply page failed: ${err?.message || err}`);
    });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-action="copy-note"], .copy-note-btn');
    if (!btn) return;
    stashNoteFromForge(btn);
  }, true); // capture so we run BEFORE apply.html's own click handler closes/re-renders the row

  // Forward a fetch to the background service worker. The worker handles
  // CORS for us. Returns { ok, status, body, text, error, dur }.
  function srvFetch(url, opts = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'fetch',
        url,
        method: opts.method || 'GET',
        body: opts.body || null,
      }, (reply) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: `runtime.lastError: ${chrome.runtime.lastError.message}`,
          });
          return;
        }
        resolve(reply || { ok: false, error: 'no reply from background worker' });
      });
    });
  }

  const AUTO_SCAN_PATTERNS = [
    /linkedin\.com\/jobs\/view\//,
    /linkedin\.com\/jobs\/collections\//,
    // Naukri auto-scan (and its scroll) disabled for now — manual popup scan still works.
    // /naukri\.com\/job-listings-/,
    // /naukri\.com\/job\/[^/]+\/\d+/,
    /indeed\.com\/viewjob/,
    /wellfound\.com\/jobs\//,
    /instahyre\.com\/job\//,
    /cutshort\.io\/jobs\//,
  ];

  let scannedJobId = null;
  let scannedCompanySlug = null;

  // ============================================================
  // LOGGING
  // ============================================================

  async function addLog(level, category, message, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level, category, message,
      url: window.location.href,
      pageTitle: document.title,
      ...details,
    };
    try {
      const data = await chrome.storage.local.get(LOG_KEY);
      const logs = data[LOG_KEY] || [];
      logs.push(entry);
      if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
      await chrome.storage.local.set({ [LOG_KEY]: logs });
    } catch {}

    const prefix = `[JobScanner][${category}]`;
    if (level === 'error') console.error(prefix, message, details);
    else if (level === 'warn') console.warn(prefix, message, details);
    else console.log(prefix, message, details);
  }

  // ============================================================
  // TEXT + COMPANY INFO EXTRACTION
  // ============================================================

  // Find the "About the company" section by content, since LinkedIn's class names
  // are now obfuscated (e.g. "_885f3d1f") and selectors like .jobs-company__box no longer match.
  function findAboutCompanySection() {
    const headings = document.querySelectorAll('h2, h3');
    for (const h of headings) {
      if (/about the company/i.test(h.textContent || '')) {
        // Walk up to a container that includes the heading + the body content
        let el = h.parentElement;
        for (let i = 0; i < 5 && el; i++) {
          if ((el.textContent || '').length > 80) return el;
          el = el.parentElement;
        }
        return h.parentElement;
      }
    }
    return null;
  }

  // Find the company link by its href pattern (stable across LinkedIn redesigns).
  // The href-fallback path can match multiple anchors per page — including empty
  // logo wrappers that have the right href but no text. Pick the first one that
  // actually has text content.
  function findCompanyAnchor() {
    const namedSelector = document.querySelector('.jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__subtitle-primary-grouping a');
    if (namedSelector) return namedSelector;
    const anchors = document.querySelectorAll('a[href*="/company/"][href*="linkedin.com"]');
    for (const a of anchors) {
      if ((a.textContent || '').trim()) return a;
    }
    return null;
  }

  function extractLinkedInCompanyInfo() {
    const info = {};

    const companyEl = findCompanyAnchor();
    if (companyEl) {
      info.companyName = companyEl.textContent.trim();
      info.companyLinkedIn = companyEl.href || null;
    }

    // Combine targeted section text + full body text as our search corpus.
    // We always include bodyText too — the about-section walk-up can land on a
    // narrow container that misses the size/headcount metadata even when the
    // industry line is present. The proximity-anchored regex below ensures we
    // still match the right "X on LinkedIn" pair from bodyText.
    const aboutSection = findAboutCompanySection();
    const aboutText = (aboutSection?.innerText || '').trim();
    const bodyText = (document.body?.innerText || '').slice(0, 80000);
    const corpus = (aboutText ? aboutText + '\n\n' : '') + bodyText;

    if (aboutText.length > 20) {
      info.companyDescription = aboutText.slice(0, 1000);
    }

    // Employee count bucket — "X,XXX employees" or "X-Y employees" or "10000+ employees"
    const empMatch = corpus.match(/([\d,]+\+?(?:\s*[-–]\s*[\d,]+)?)\s*employees/i);
    if (empMatch) info.employeeCount = empMatch[1].trim();

    // Actual headcount visible on LinkedIn. LinkedIn renders this as "9 on LinkedIn"
    // (without the word "employees"). To avoid matching unrelated phrases like
    // "5,000 jobs on LinkedIn", require "employees" to appear close before the count.
    const onLiNear = corpus.match(/employees?[\s\S]{1,40}?([\d,]+)\s+on\s+linkedin/i);
    const onLiExplicit = corpus.match(/([\d,]+)\s*employees?\s+on\s+linkedin/i);
    const onLi = onLiExplicit || onLiNear;
    if (onLi) info.employeesOnLinkedIn = onLi[1].replace(/,/g, '').trim();

    // Followers
    const followerMatch = corpus.match(/([\d,]+)\s*followers/i);
    if (followerMatch) info.followers = followerMatch[1].trim();

    // Industry — try the about section's first short paragraph (e.g. "IT Services and IT Consulting").
    // The first <p> in the section is usually the company name itself, so skip any <p>
    // that just repeats the company name we already extracted.
    if (aboutSection) {
      const ps = aboutSection.querySelectorAll('p');
      const companyLc = (info.companyName || '').toLowerCase();
      for (const p of ps) {
        const t = (p.textContent || '').trim();
        // Industry line is typically short, no digits, no bullet
        if (t.length > 5 && t.length < 80 && !/\d/.test(t) && !/^[•·\s]+$/.test(t) &&
            !/follow|interested|profile|recruiter|share|learn more/i.test(t) &&
            (!companyLc || t.toLowerCase() !== companyLc)) {
          info.industry = t;
          break;
        }
      }
    }

    // Industry pattern fallback
    if (!info.industry) {
      const industryPatterns = ['Information Technology', 'IT Services', 'Software', 'Internet',
        'Financial Services', 'Consulting', 'E-commerce', 'SaaS', 'Staffing', 'Recruitment'];
      for (const p of industryPatterns) {
        if (corpus.toLowerCase().includes(p.toLowerCase())) {
          info.industry = p;
          break;
        }
      }
    }

    // Public/Private — require an explicit qualifier. Matching bare "private(ly)"
    // catches unrelated UI copy like "Privately share your profile with our recruiters".
    if (/\bpublicly\s+(?:listed|traded|owned)\b|\bpublic\s+company\b/i.test(corpus)) info.listed = true;
    else if (/\bprivately\s+(?:held|owned)\b|\bprivate\s+company\b/i.test(corpus)) info.listed = false;

    // Insights — collect the 1-line metadata pieces (industry • size • headcount)
    if (aboutSection) {
      const ps = aboutSection.querySelectorAll('p');
      const insights = [];
      for (const p of ps) {
        const t = (p.textContent || '').trim().replace(/\s+/g, ' ');
        if (t.length > 1 && t.length < 200 && !/^[•·\s]+$/.test(t)) insights.push(t);
      }
      if (insights.length) info.insights = insights.slice(0, 10);
    }

    // Debug snapshot — captures exactly what the extractor saw, so we can
    // diagnose failures later without re-loading the LinkedIn page.
    info.__debug = {
      url: window.location.href,
      pageTitle: document.title,
      capturedAt: new Date().toISOString(),
      aboutSectionFound: !!aboutSection,
      aboutTextLength: aboutText.length,
      bodyTextLength: bodyText.length,
      // Slice generously but bounded — about sections are usually 2-15KB
      aboutSectionHtml: aboutSection ? (aboutSection.outerHTML || '').slice(0, 30000) : null,
      // A truncated copy of the corpus for the debug viewer. The REGEX runs
      // against the FULL corpus (~ aboutText + first 80KB of body). This is
      // just what we display in the debug modal — keep it big enough to
      // diagnose match failures (50KB covers most LinkedIn pages end-to-end).
      corpusText: corpus.slice(0, 50000),
      // Real corpus length BEFORE truncation, so the debug viewer can show
      // "showing 50KB of 73KB scanned".
      corpusFullLength: corpus.length,
    };

    return Object.keys(info).length > 0 ? info : null;
  }

  // ============================================================
  // COMPANY-PAGE EXTRACTION
  // ============================================================
  // Canonical company slug from any /company/<slug>/... URL.
  function getCompanySlug(url) {
    const m = (url || '').match(/linkedin\.com\/company\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  // Company HOME page or PEOPLE tab (both render the headcount band); excludes /about, /posts, /jobs.
  function isCompanyScrapePage(url) {
    return /^https?:\/\/[^/]*linkedin\.com\/company\/[^/?#]+\/(?:people\/?)?(?:[?#].*)?$/i.test(url || '')
      || /^https?:\/\/[^/]*linkedin\.com\/company\/[^/?#]+(?:[?#].*)?$/i.test(url || '');
  }

  // Scrape the company top-card for the headcount band + exact on-LinkedIn count (structured selectors over the corpus-regex base, so it works logged-in and incognito).
  function extractCompanyPageInfo() {
    // Corpus-regex base — "X-Y employees", "N on LinkedIn", "N followers".
    const info = extractLinkedInCompanyInfo() || {};

    // Canonical company URL from the slug — the join key for backfill.
    const slug = getCompanySlug(window.location.href);
    if (slug) info.companyLinkedIn = `https://www.linkedin.com/company/${slug}/`;

    // Company name — top-card h1 beats the job-page anchor. The /people/ tab has
    // no top card, so the base extractor was returning the nav label instead and
    // every scrape logged company="Home", killing the name-match fallback for
    // rows that carry no company URL. Fall back to og:title / document.title,
    // and never accept a tab label.
    const NAV_LABEL = /^(home|about|posts|jobs|people|life|videos|events|insights)$/i;
    const titleEl = document.querySelector('.org-top-card-summary__title, h1.org-top-card-summary__title');
    const fromTitle = titleEl && (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
    const fromOg = document.querySelector('meta[property="og:title"]')?.content?.trim();
    const fromDoc = (document.title || '').replace(/\s*\|\s*LinkedIn\s*$/i, '').split('|').pop().trim();
    const name = [fromTitle, fromOg, fromDoc, info.companyName]
      .find((v) => v && !NAV_LABEL.test(v));
    if (name) info.companyName = name;
    else if (NAV_LABEL.test(info.companyName || '')) delete info.companyName;

    // Structured info-list rows (logged-in): employees=band, followers, else short comma-free row=industry.
    const items = [...document.querySelectorAll('.org-top-card-summary-info-list__info-item')]
      .map(el => (el.textContent || '').trim()).filter(Boolean);
    for (const t of items) {
      if (/employees/i.test(t)) {
        const m = t.match(/([\d,]+\+?(?:\s*[-–]\s*[\d,]+)?)\s*employees/i);
        if (m) info.employeeCount = m[1].trim();
      } else if (/followers/i.test(t)) {
        const m = t.match(/([\d,.]+[KMk]?)\s*followers/i);
        if (m && !info.followers) info.followers = m[1].trim();
      } else if (!info.industry && t.length < 60 && !/\d/.test(t) && !t.includes(',')) {
        info.industry = t;
      }
    }

    // Exact on-LinkedIn headcount. Different surfaces phrase it differently:
    //   "See all 234 employees" (People tab, larger cos), "View 56 employees"
    //   (incognito modal), "5 associated members" (People tab, smaller cos),
    //   "N on LinkedIn" (older). Take the first that's present — any beats the band.
    const corpus = (document.body?.innerText || '').slice(0, 80000);
    const exact =
      corpus.match(/see all\s+([\d,]+)\s+employees?/i)?.[1] ||
      corpus.match(/view\s+([\d,]+)\s+employees?\b/i)?.[1] ||
      corpus.match(/([\d,]+)\s+associated\s+members?/i)?.[1] ||
      corpus.match(/([\d,]+)\s+employees?\s+on\s+linkedin/i)?.[1] ||
      null;
    if (exact) info.employeesOnLinkedIn = exact.replace(/,/g, '').trim();

    // Numeric company id from the People canned-search link.
    const peopleLink = document.querySelector('a[href*="currentCompany="]');
    if (peopleLink) {
      const idm = decodeURIComponent(peopleLink.getAttribute('href') || '').match(/currentCompany=\[?"?(\d+)/);
      if (idm) info.companyNumericId = idm[1];
    }

    info.scrapedFrom = 'company-page';
    delete info.__debug; // server only needs the headcount/identity fields
    return info;
  }

  // Extract job-listing facets from the LinkedIn job header strip:
  //   - jobType         'Full-time' / 'Contract' / 'Part-time' / 'Internship'
  //   - workMode        'On-site' / 'Remote' / 'Hybrid'
  //   - applicantsCount display string ('Over 100', '23 applicants', 'Be an early applicant')
  //   - applicantsNumeric  numeric extract for sorting (parses '23', 'Over 100' → 100)
  //   - easyApply       bool — page has an Easy Apply CTA
  //
  // Robust to LinkedIn's obfuscated class names by reading the body text
  // and applying tolerant regex patterns. Returns an object suitable for
  // spreading into the /analyze payload.
  function extractLinkedInJobFacets() {
    const facets = { jobType: null, workMode: null, easyApply: false, applicantsCount: null, applicantsNumeric: null };
    const body = (document.body?.innerText || '').slice(0, 80000);

    // workMode — anchor on the standalone word + bullet separator. LinkedIn
    // puts these in the top card's bullets (e.g. "Bengaluru, India · On-site").
    if (/\bRemote\b/i.test(body) && !/\b(On-?site|Hybrid)\b/i.test(body.slice(0, 4000))) {
      facets.workMode = 'Remote';
    } else if (/\bHybrid\b/i.test(body.slice(0, 4000))) {
      facets.workMode = 'Hybrid';
    } else if (/\bOn-?site\b/i.test(body.slice(0, 4000))) {
      facets.workMode = 'On-site';
    } else if (/\bRemote\b/i.test(body.slice(0, 4000))) {
      facets.workMode = 'Remote';
    }

    // jobType — LinkedIn's "Matches your job preferences" pill row + the
    // header bullets contain phrases like "Full-time", "Contract", etc.
    const jt = body.slice(0, 4000).match(/\b(Full-time|Part-time|Contract|Temporary|Internship|Volunteer)\b/i);
    if (jt) facets.jobType = jt[1].replace(/^./, c => c.toUpperCase()).replace('time', 'time');

    // Easy Apply — the in-page apply CTA. Classic UIs render the literal
    // text "Easy Apply"; the SDUI (2026) rewrite renders just "Apply" and
    // moves the signal into the apply href (openSDUIApplyFlow / .../apply/).
    facets.easyApply =
      /Easy Apply/i.test(body.slice(0, 6000)) ||
      !!document.querySelector(
        'a[href*="openSDUIApplyFlow=true"], a[href*="/jobs/view/"][href*="/apply"]'
      );

    // Applicants count — first 6KB of body, several formats.
    const text6k = body.slice(0, 6000);
    let m;
    if ((m = text6k.match(/Over\s+(\d+)\s+(?:applicants|people clicked apply)/i))) {
      facets.applicantsCount = `Over ${m[1]}`;
      facets.applicantsNumeric = Number(m[1]);
    } else if ((m = text6k.match(/(\d+)\s+(?:applicants|people clicked apply)/i))) {
      facets.applicantsCount = `${m[1]}`;
      facets.applicantsNumeric = Number(m[1]);
    } else if (/Be an early applicant/i.test(text6k)) {
      facets.applicantsCount = 'Early applicant';
      facets.applicantsNumeric = 0;
    }
    return facets;
  }

  // The containers LinkedIn renders the JD into. Shared by the reader below and
  // by waitForJobDescription(), so the wait and the read can never disagree
  // about what "the description has rendered" means.
  const JD_SELECTORS = [
    '.jobs-description__content',
    '.jobs-unified-description__content',
    '.jobs-box__html-content',
    '.jobs-details__main-content',
    '.jobs-search__job-details--wrapper',
    '[class*="jobs-description"]',
    '[class*="job-details"]',
  ];

  // Same >100 char bar extractLinkedInJob() uses to accept a container.
  const jdRendered = () =>
    JD_SELECTORS.some((sel) => {
      const el = document.querySelector(sel);
      return el && el.textContent.trim().length > 100;
    });

  function extractLinkedInJob() {
    const selectors = JD_SELECTORS;

    let text = '';
    const titleEl = document.querySelector(
      '.jobs-unified-top-card__job-title, .job-details-jobs-unified-top-card__job-title, h1.t-24, h1.t-20'
    );
    if (titleEl) text += `JOB TITLE: ${titleEl.textContent.trim()}\n\n`;

    const companyEl = document.querySelector(
      '.jobs-unified-top-card__company-name, .job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__subtitle-primary-grouping a'
    );
    if (companyEl) text += `COMPANY: ${companyEl.textContent.trim()}\n\n`;

    const locationEl = document.querySelector(
      '.jobs-unified-top-card__bullet, .job-details-jobs-unified-top-card__bullet, .jobs-unified-top-card__workplace-type'
    );
    if (locationEl) text += `LOCATION: ${locationEl.textContent.trim()}\n\n`;

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) {
        text += el.textContent.trim();
        break;
      }
    }

    return text.length >= 50 ? text : null;
  }

  function extractGenericJob() {
    const selectors = [
      '[class*="job-description"]', '[class*="jobDescription"]',
      '[class*="jd-"]', '[id*="job-description"]', '[id*="jobDescription"]',
      'article', 'main', '.content',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) return el.textContent.trim();
    }
    return null;
  }

  function extractVisibleText() {
    if (window.location.hostname.includes('linkedin.com')) {
      const text = extractLinkedInJob();
      if (text) return text;
    }
    const generic = extractGenericJob();
    if (generic) return generic;

    addLog('warn', 'extract', 'Targeted selectors failed, using body fallback');
    return document.body.innerText.slice(0, 10000);
  }

  // ============================================================
  // FLOATING BADGE — small pill
  // ============================================================

  function removeBadge() {
    document.getElementById('job-scanner-badge')?.remove();
  }

  // `imported`: the verdict came from a peer's database (shown while this
  // install re-scores the job against the operator's own resume).
  // `applied`: the operator has already applied — the ✓ chip is hidden.
  function showBadge(state, analysis = null, { imported = false, applied = false } = {}) {
    removeBadge();

    const badge = document.createElement('div');
    badge.id = 'job-scanner-badge';
    badge.style.cssText = `
      position: fixed; top: 12px; right: 12px; z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      border-radius: 20px; padding: 6px 8px 6px 14px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
      transition: opacity 0.3s; font-size: 12px; font-weight: 600;
      white-space: nowrap; user-select: none;
      display: inline-flex; align-items: center; gap: 8px;
    `;

    // Score text lives in its own span so the dismiss click target is the
    // score, not the (future) copy-note button to its right.
    const scoreEl = document.createElement('span');
    scoreEl.style.cssText = 'cursor: pointer;';
    badge.appendChild(scoreEl);

    if (state === 'loading') {
      badge.style.background = '#2a2a4a';
      badge.style.color = '#ffaa00';
      badge.style.border = '1px solid #ffaa0033';
      scoreEl.textContent = 'Checking...';
    } else if (state === 'error') {
      badge.style.background = '#3a1a1a';
      badge.style.color = '#ff4444';
      badge.style.border = '1px solid #ff444433';
      scoreEl.textContent = 'Scan failed';
      setTimeout(() => badge.style.opacity = '0', 4000);
      setTimeout(removeBadge, 4500);
      return document.body.appendChild(badge);
    } else if (state === 'company') {
      // Headcount-scrape result — `analysis` carries { text }.
      badge.style.background = '#1a2a3a';
      badge.style.color = '#66bbff';
      badge.style.border = '1px solid #66bbff33';
      scoreEl.textContent = `👥 ${analysis?.text || 'scraped'}`;
      setTimeout(() => badge.style.opacity = '0', 4000);
      setTimeout(removeBadge, 4500);
      return document.body.appendChild(badge);
    } else if (analysis) {
      const cfg = {
        good:  { bg: '#1a3a1a', border: '#44ff4433', text: '#44ff44', label: 'GOOD' },
        maybe: { bg: '#3a3a1a', border: '#ffaa0033', text: '#ffaa00', label: 'MAYBE' },
        skip:  { bg: '#3a1a1a', border: '#ff444433', text: '#ff4444', label: 'SKIP' },
      };

      // Blocked overrides verdict — company on user blocklist
      if (analysis.status === 'blocked') {
        badge.style.background = '#2a2a2a';
        badge.style.color = '#aaaaaa';
        badge.style.border = '1px solid #66666633';
        scoreEl.textContent = 'BLOCKED';
      } else if (analysis.status === 'rejected' && analysis.blockedReasons?.length) {
        badge.style.background = '#3a1a1a';
        badge.style.color = '#ff8866';
        badge.style.border = '1px solid #ff886633';
        scoreEl.textContent = `AUTO-REJECT ${analysis.score}/10`;
      } else {
        const c = cfg[analysis.verdict] || cfg.skip;
        badge.style.background = c.bg;
        badge.style.color = c.text;
        badge.style.border = `1px solid ${c.border}`;
        scoreEl.textContent = `${c.label} ${analysis.score}/10`;
      }
      if (applied) scoreEl.textContent = `✓ APPLIED · ${scoreEl.textContent}`;

      // Peer-imported verdict: flagged as such because it was scored against
      // someone else's resume. The badge is replaced as soon as the re-scan
      // (which autoScan runs right after showing this) comes back.
      if (imported) {
        const tag = document.createElement('span');
        tag.textContent = 'IMPORTED';
        tag.title = 'Verdict imported from a peer — re-analyzing against your resume';
        tag.style.cssText = `
          font-size: 9px; letter-spacing: 0.06em; padding: 2px 6px;
          border-radius: 10px; border: 1px dashed currentColor; opacity: 0.8;
        `;
        badge.appendChild(tag);
      }

      // Shared style for the inline action chips after the score.
      const mkChip = (label, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.style.cssText = `
          background: rgba(255,255,255,0.06); color: inherit;
          border: 1px solid currentColor; border-radius: 14px;
          padding: 3px 10px; font: 600 11px/1 inherit;
          cursor: pointer; opacity: 1;
        `;
        b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,0.16)'; });
        b.addEventListener('mouseleave', () => { b.style.background = 'rgba(255,255,255,0.06)'; });
        return b;
      };
      // Flash replaces inner content with `text` for `ms` and restores the
      // original HTML (preserves SVG/icon markup, not just text).
      const flash = (btn, text, ms = 1400) => {
        const orig = btn.innerHTML;
        btn.textContent = text;
        setTimeout(() => { btn.innerHTML = orig; }, ms);
        badge.style.opacity = '1';
      };

      // Copy-note pill — shows only if the server generated a connectNote.
      // Stops propagation so clicking it doesn't dismiss the whole badge.
      // Server already substituted {{exp}} against the operator's
      // experienceStart, so the copied text is paste-ready.
      // Icon-only chip (bigger than the ✓/✕ ones) — the action is the most
      // common one so it gets the most visual weight.
      if (analysis.connectNote) {
        const note = String(analysis.connectNote);
        const copyBtn = mkChip('', 'Copy the personalized connect-note for this job');
        copyBtn.innerHTML = `
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none"
               stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="4" y="3" width="9" height="11" rx="1.4"/>
            <path d="M6 3V2.4A1.4 1.4 0 0 1 7.4 1h2.2A1.4 1.4 0 0 1 11 2.4V3"/>
          </svg>
        `;
        copyBtn.style.padding = '4px 10px';
        copyBtn.style.display = 'inline-flex';
        copyBtn.style.alignItems = 'center';
        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Stash for the modal observer regardless of clipboard outcome.
          // clipboard.readText() requires a user gesture, so the observer
          // can't reliably read it back from a MutationObserver callback —
          // storage is the source of truth for the cross-page handoff.
          try {
            await chrome.storage.local.set({
              lastConnectNote: { note, jobId: analysis.jobId, copiedAt: Date.now() },
            });
            addLog('info', 'badge', `stashed connectNote for jobId=${analysis.jobId} (${note.length} chars)`);
          } catch (err) {
            addLog('error', 'badge', `failed to stash connectNote: ${err?.message || err}`);
          }
          try {
            await navigator.clipboard.writeText(note);
            flash(copyBtn, 'Copied!');
          } catch {
            // Clipboard API can be blocked on some pages; fall back to
            // a hidden textarea + execCommand so the copy still works.
            const ta = document.createElement('textarea');
            ta.value = note;
            ta.style.cssText = 'position:fixed;top:-1000px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); flash(copyBtn, 'Copied!'); }
            catch { flash(copyBtn, 'Copy blocked', 2000); }
            document.body.removeChild(ta);
          }
        });
        badge.appendChild(copyBtn);
      }

      // Apply / Reject chips — POST to /api/ext/jobs/status, the same call
      // the apply page's Apply / Reject buttons make. The server resolves
      // who is acting, so the request carries only { jobId, status }.
      // Absent when there's no jobId (analyze stub); ✓ is hidden once the
      // row is already applied.
      // `jobId` belongs to the autoScan closure, not this function — read it
      // off the saved doc instead. (Reference-error bug fix: 2026-05-15.)
      const targetJobId = analysis.jobId;
      if (targetJobId) {
        const sendStatus = (btn, status, successLabel) => async (e) => {
          e.stopPropagation();
          const orig = btn.textContent;
          btn.textContent = '…';
          btn.disabled = true;
          const r = await srvFetch(`${SERVER_URL}/jobs/status`, {
            method: 'POST',
            body: JSON.stringify({ jobId: targetJobId, status }),
          });
          btn.disabled = false;
          btn.textContent = orig;
          if (r.ok) {
            flash(btn, successLabel);
            addLog('info', 'badge', `${successLabel} jobId=${targetJobId}`, { dur: r.dur });
            // Once the flash has been seen, redraw so the badge reflects the
            // server's applied state (the ✓ chip goes away after applying).
            const nowApplied = typeof r.body?.applied === 'boolean' ? r.body.applied : status === 'applied';
            setTimeout(() => showBadge('result', analysis, { imported, applied: nowApplied }), 1400);
          } else {
            const msg = r.body?.error || r.text?.slice(0, 60) || `HTTP ${r.status}`;
            flash(btn, '!', 2200);
            addLog('error', 'badge', `${status} failed: ${msg}`, { jobId: targetJobId });
          }
        };
        if (!applied) {
          const applyBtn = mkChip('✓', 'Mark applied');
          applyBtn.style.color = '#44ff44';
          applyBtn.addEventListener('click', sendStatus(applyBtn, 'applied', 'Applied!'));
          badge.appendChild(applyBtn);
        }
        const rejectBtn = mkChip('✕', 'Mark rejected');
        rejectBtn.style.color = '#ff6666';
        rejectBtn.addEventListener('click', sendStatus(rejectBtn, 'rejected', 'Rejected!'));
        badge.appendChild(rejectBtn);
      }

      // The badge stays at full opacity for as long as it is on the page — it
      // used to fade to 60% after 8 s until hovered, which read as "disabled".
      // Click the score area to dismiss.
      badge.style.opacity = '1';
    }

    scoreEl.addEventListener('click', removeBadge);
    document.body.appendChild(badge);
  }

  // ============================================================
  // JOB ID EXTRACTION
  // ============================================================

  function extractJobId(url) {
    // LinkedIn collections / search pages put the active job in a query param.
    // Handle these first, before the path patterns.
    const liQuery = url.match(/linkedin\.com\/jobs\/(?:collections|search)\/[^?#]*[?&]currentJobId=(\d+)/);
    if (liQuery) return liQuery[1];

    const patterns = [
      // /jobs/view/<digits>/ AND slug variant /jobs/view/<slug>-<digits>/ — capture trailing digits.
      /linkedin\.com\/jobs\/view\/(?:[^/?#]*?-)?(\d+)(?:[/?#]|$)/,
      /naukri\.com\/job\/[^/]+\/(\d+)/,
      /naukri\.com\/job-listings-.*?-(\d+)\??/,
      /indeed\.com\/viewjob\?.*?jk=([a-f0-9]+)/,
      /wellfound\.com\/jobs\/(\d+)/,
      /instahyre\.com\/job\/(\d+)/,
      /cutshort\.io\/jobs\/([a-zA-Z0-9-]+)/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  // ============================================================
  // AUTO-SCAN
  // ============================================================

  function shouldAutoScan() {
    return AUTO_SCAN_PATTERNS.some(p => p.test(window.location.href));
  }

  // Scroll every scrollable container to the bottom in steps so
  // IntersectionObserver-driven lazy sections (applicant counts, "About the
  // company", etc.) render before extraction. LinkedIn's job pages keep the
  // detail content inside an inner overflow container, so window-only scrolling
  // never reaches the lazy-loaded sections. Idempotent per page-load.
  let _scrolledOnce = false;

  function findScrollContainers() {
    const out = [];
    const pageScroller = document.scrollingElement || document.documentElement;
    if (pageScroller && pageScroller.scrollHeight - pageScroller.clientHeight > 50) {
      out.push(pageScroller);
    }
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.scrollHeight - el.clientHeight < 200) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      out.push(el);
    }
    out.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return out;
  }

  async function scrollToBottomOnce() {
    if (_scrolledOnce) return;
    _scrolledOnce = true;
    try {
      const containers = findScrollContainers();
      if (!containers.length) return;
      let stableRounds = 0;
      for (let i = 0; i < 40 && stableRounds < 2; i++) {
        let moved = false;
        for (const c of containers) {
          const max = c.scrollHeight - c.clientHeight;
          if (c.scrollTop < max - 2) {
            const stride = Math.max(400, Math.floor(c.clientHeight * 0.8));
            c.scrollTop = Math.min(c.scrollTop + stride, max);
            moved = true;
          }
        }
        stableRounds = moved ? 0 : stableRounds + 1;
        await new Promise(r => setTimeout(r, 150));
      }
      for (const c of containers) c.scrollTop = c.scrollHeight - c.clientHeight;
      await new Promise(r => setTimeout(r, 400));
    } catch {}
  }

  async function autoScan() {
    const url = window.location.href;

    // Company page → headcount-only backfill path (no job text, no verdict, no jobId).
    // Gated on #fgcap: only tabs opened by the Forge Rescan buttons scan+scroll;
    // organic company browsing must stay untouched.
    if (isCompanyScrapePage(url)) {
      if (FG_CAPTURE_RUN) return autoScanCompany();
      return;
    }

    if (!shouldAutoScan()) return;

    const jobId = extractJobId(url);

    // LinkedIn URLs must yield a jobId — otherwise we'd save an un-deletable record
    // (the dashboard keys Approve/Reject/Delete off jobId). Bail out instead.
    if (!jobId && /linkedin\.com\/jobs\//.test(url)) {
      addLog('warn', 'auto', `Skipped: no jobId extractable from ${url}`);
      return;
    }

    if (jobId && scannedJobId === jobId) return;
    if (jobId) scannedJobId = jobId;

    // Fast pre-flight cache check. For already-analyzed jobs (the common
    // case while browsing), this is the entire flow — no scroll, no wait,
    // no extraction, no AI. The page doesn't lag because we skip the
    // expensive scrollToBottomOnce / 3s settle / DOM walk until we know
    // the server doesn't already have a result. The /analyze endpoint
    // ALSO checks the cache on its side, so a manual rescan from the popup
    // (which posts directly to /analyze) still goes through the server's
    // dedup.
    showBadge('loading');
    // A verdict imported from a peer's database is a cache hit too, and is
    // shown straight away so the page isn't blank — but it was scored
    // against someone else's resume, so the full scan below still runs and
    // its result replaces the badge.
    let reanalyzingImport = false;
    if (jobId) {
      const cacheRes = await srvFetch(`${SERVER_URL}/result/${encodeURIComponent(jobId)}`);
      if (cacheRes.ok && cacheRes.body?.analysis) {
        const { analysis: cached, imported, applied } = cacheRes.body;
        showBadge('result', cached, { imported: !!imported, applied: !!applied });
        addLog('info', 'auto', `Cache hit: ${cached.verdict} ${cached.score}/10${imported ? ' (imported from a peer — re-analyzing)' : ''}`, {
          jobId, dur: cacheRes.dur,
        });
        if (!imported) return;
        reanalyzingImport = true;
      }
      // 404 (miss) or transient error → fall through to the full scan path.
    }

    addLog('info', 'auto', `Auto-scan triggered on ${url}` + (jobId ? ` (jobId: ${jobId})` : ''));

    // Cache miss — do the expensive work. Force-render lazy sections by
    // scrolling to the bottom, then wait for the description to actually be
    // there. A fixed 3s sleep sometimes fired before LinkedIn had streamed the
    // JD in, and the scan then shipped a near-empty jobText that scored 1 —
    // indistinguishable downstream from a genuinely bad match.
    //
    // On LinkedIn: poll for a populated description container, then a short
    // settle for the side panels (applicant count, "About the company") that
    // the old 3s was also covering. Elsewhere: keep the fixed wait, since
    // there is no selector worth polling.
    scrollToBottomOnce();
    if (window.location.hostname.includes('linkedin.com')) {
      const ready = await waitFor(() => (jdRendered() ? true : null), 9000);
      if (!ready) addLog('warn', 'extract', 'JD did not render within 9s — extracting anyway');
      await new Promise(r => setTimeout(r, ready ? 800 : 1500));
    } else {
      await new Promise(r => setTimeout(r, 3000));
    }

    try {
      const jobText = extractVisibleText();
      if (!jobText || jobText.length < 50) {
        showBadge('error');
        addLog('warn', 'extract', 'Insufficient text for auto-scan', { textLength: jobText?.length });
        return;
      }

      // Extract company info from page
      let companyInfo = null;
      if (window.location.hostname.includes('linkedin.com')) {
        companyInfo = extractLinkedInCompanyInfo();
      }

      // Pluck job-listing facets (type, work-mode, applicants, easyApply)
      // from the page so the apply tracker can show them in their own
      // columns + sort on them — same as the old dashboard's TYPE/APPLY
      // columns. Empty/null for non-LinkedIn jobs.
      const facets = window.location.hostname.includes('linkedin.com')
        ? extractLinkedInJobFacets()
        : { jobType: null, workMode: null, easyApply: false, applicantsCount: null, applicantsNumeric: null };

      const fetchUrl = `${SERVER_URL}/analyze`;
      const body = JSON.stringify({
        jobText, pageUrl: url, pageTitle: document.title, jobId, companyInfo,
        ...facets,
      });
      const r = await srvFetch(fetchUrl, { method: 'POST', body });

      if (!r.ok) {
        // Background worker reports either a network-level failure
        // (r.error set) or a non-2xx HTTP response.
        if (r.error) {
          addLog('error', 'auto', `Auto-scan network failure: ${r.error} (url=${fetchUrl} bodyBytes=${body.length} jobId=${jobId})`, { dur: r.dur });
        } else {
          const serverMsg = r.body?.error || r.text?.slice(0, 200) || '';
          addLog('error', 'auto', `Auto-scan rejected: HTTP ${r.status} ${r.statusText || ''} ${serverMsg ? '— ' + serverMsg : ''}`, { jobId, dur: r.dur });
        }
        showBadge('error');
        return;
      }

      const analysis = r.body?.analysis;
      if (!analysis) {
        addLog('error', 'auto', `Auto-scan got 200 but no analysis in body: ${JSON.stringify(r.body).slice(0, 200)}`);
        showBadge('error');
        return;
      }
      showBadge('result', analysis, { applied: !!r.body?.applied });
      addLog('info', 'auto', `Result: ${analysis.verdict} ${analysis.score}/10`, {
        title: analysis.title, company: analysis.company, jobId, dur: r.dur,
      });
      // Tabs opened by /scanner's batch-open would otherwise pile up, so a
      // fresh scan closes its tab; 1.5s lets the verdict badge flash. The
      // cache-hit path above doesn't close (user came back on purpose),
      // errors don't close, and neither does the re-scan of an imported row:
      // the batch never opens those (they're already SCANNED), so this is a
      // tab the operator opened to read.
      if (!reanalyzingImport) {
        setTimeout(() => {
          try { chrome.runtime.sendMessage({ action: 'closeTab' }); } catch {}
        }, 1500);
      }
    } catch (err) {
      showBadge('error');
      // Inner exceptions (extraction throws, JSON parse, etc.) — these are
      // distinct from the network-level failure handled above.
      addLog('error', 'auto', `Auto-scan inner error: ${err.name || 'Error'}: ${err.message}`, {
        stack: (err.stack || '').slice(0, 400),
      });
      console.error('[JobScanner] inner', err);
    }
  }

  // Company-page headcount scrape (dedup per slug/load). LinkedIn lazy-loads the
  // top card, "About us" and the People carousel ("N associated members") at
  // different times, so we POLL: keep re-extracting + re-scrolling, POSTing each
  // time we capture MORE than before, so whatever loads is saved as it appears.
  //   - exact count appears  → best result, done (auto-close on a rescan run);
  //   - only the band, settled → good enough, done;
  //   - nothing loads         → keep waiting up to MAX, then stop and LEAVE THE
  //                             TAB OPEN for the user to close — we've already
  //                             saved whatever partial data we could get.
  const CO_POLL_MS = 1500;       // re-check cadence
  const CO_EXACT_SETTLE_MS = 12000; // once we have the band, keep trying this long for the exact
  const CO_MAX_WAIT_MS = 120000;    // overall ceiling before we give up polling

  async function autoScanCompany() {
    const url = window.location.href;
    const slug = getCompanySlug(url);
    if (!slug) return;
    if (scannedCompanySlug === slug) return;
    scannedCompanySlug = slug;
    // LinkedIn is an SPA — if the user navigates away (e.g. to /posts) the
    // content script survives, so the poll loop must notice and stop scrolling.
    const startPath = window.location.pathname;
    const navigatedAway = () => window.location.pathname !== startPath;

    showBadge('loading');
    scrollToBottomOnce();

    const fetchUrl = `${SERVER_URL}/company-scrape`;
    const closeTab = () => { try { chrome.runtime.sendMessage({ action: 'closeTab' }); } catch {} };
    const sig = (d) => `${d.employeeCount || ''}|${d.employeesOnLinkedIn || ''}|${d.followers || ''}|${d.industry || ''}`;

    let postedSig = '';
    let firstDataAt = 0;
    const startedAt = Date.now();

    // Save whatever we have right now if it's new; returns the parsed details.
    const captureOnce = async () => {
      let details;
      try { details = extractCompanyPageInfo(); } catch { return null; }
      const hasAny = details && (details.employeeCount || details.employeesOnLinkedIn || details.followers);
      if (!hasAny) return details;
      if (!firstDataAt) firstDataAt = Date.now();
      if (sig(details) === postedSig) return details; // nothing new since last POST
      try {
        const r = await srvFetch(fetchUrl, { method: 'POST', body: JSON.stringify({ slug, url, details }) });
        if (r.ok) {
          postedSig = sig(details);
          const matched = r.body?.matched ?? 0, updated = r.body?.updated ?? 0;
          const count = details.employeesOnLinkedIn || details.employeeCount || '?';
          showBadge('company', { text: `${count} · ${updated}/${matched} rows` });
          addLog('info', 'company', `${details.companyName || slug}: ${count} → ${updated}/${matched} rows${details.employeesOnLinkedIn ? ' (exact)' : ' (band)'}${FG_CAPTURE_RUN ? ' [rescan]' : ''}`, { slug });
        } else {
          addLog('warn', 'company', `company-scrape POST failed: ${r.error || ('HTTP ' + r.status)} (slug=${slug})`);
        }
      } catch (e) { addLog('error', 'company', `company-scrape error: ${e.message} (slug=${slug})`); }
      return details;
    };

    // Poll until we have the exact count, or the band has settled, or we hit the
    // ceiling. Re-scroll each round to nudge the lazy People carousel into view.
    while (Date.now() - startedAt < CO_MAX_WAIT_MS) {
      if (navigatedAway()) {
        addLog('info', 'company', `poll stopped — navigated away from ${startPath} (slug=${slug})`, { slug });
        return;
      }
      const d = await captureOnce();
      const hasExact = d && d.employeesOnLinkedIn;
      const bandSettled = d && d.employeeCount && firstDataAt && (Date.now() - firstDataAt >= CO_EXACT_SETTLE_MS);
      if (hasExact || bandSettled) {
        if (FG_CAPTURE_RUN) setTimeout(closeTab, 1200); // success → clean up rescan tab
        return;
      }
      if (navigatedAway()) return;
      try { await scrollResultsToBottom(); } catch {}
      await new Promise(r => setTimeout(r, CO_POLL_MS));
    }
    // Ceiling hit: leave the tab open (user closes manually). Partial data, if
    // any, is already saved. Only flag an error if we never got anything at all.
    if (!postedSig) {
      // Tell the server we looked and there was nothing — a /showcase/ page has
      // followers but no headcount and never will, so without this the Rescan
      // queue re-opens the same dead tab every run.
      //
      // Only when the page actually RENDERED, though. A background tab that
      // never painted also produces no headcount, and marking that unavailable
      // would permanently hide a company that has one. "Rendered" = the org top
      // card is present, or the body mentions followers/employees at all.
      const details = (() => { try { return extractCompanyPageInfo(); } catch { return null; } })();
      const rendered = !!document.querySelector('.org-top-card-summary-info-list__info-item, .org-top-card-summary__title')
        || /\b(followers|employees|associated members)\b/i.test(document.body?.innerText || '');
      if (rendered) {
        try {
          await srvFetch(fetchUrl, { method: 'POST', body: JSON.stringify({ slug, url, details, unavailable: true }) });
        } catch { /* best-effort — the warning below still fires */ }
      }
      showBadge('error');
      addLog('warn', 'company',
        `gave up after ${Math.round(CO_MAX_WAIT_MS / 1000)}s (slug=${slug}) — `
        + (rendered ? 'page has no headcount; marked unavailable' : 'page never rendered; NOT marked, will retry'),
        { slug });
    }
  }

  function scheduleAutoScan() {
    // 500ms — just enough for SPA-nav URL to settle. The cache check fires
    // here; on hit, we're done. On miss, autoScan() runs scrollToBottomOnce
    // (up to ~6s) plus a 3s settle before extracting, which together cover
    // LinkedIn's lazy-loaded applicant counts and company headcount.
    setTimeout(autoScan, 500);
  }

  // ============================================================
  // SPA NAVIGATION DETECTION
  // ============================================================

  let lastUrl = window.location.href;

  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      scheduleAutoScan();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('popstate', () => {
    lastUrl = window.location.href;
    scheduleAutoScan();
  });

  // ============================================================
  // MESSAGE HANDLER (for popup manual triggers)
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'extract') {
      try {
        const jobText = extractVisibleText();
        let companyInfo = null;
        if (window.location.hostname.includes('linkedin.com')) {
          companyInfo = extractLinkedInCompanyInfo();
        }
        sendResponse({
          jobText,
          pageTitle: document.title,
          pageUrl: window.location.href,
          jobId: extractJobId(window.location.href),
          companyInfo,
        });
      } catch (err) {
        addLog('error', 'extract', `Extraction failed: ${err.message}`);
        sendResponse({ jobText: null, error: err.message });
      }
    }
    return true;
  });

  // ============================================================
  // CONNECTIONS PAGE SCRAPER
  //
  // On https://www.linkedin.com/mynetwork/invite-connect/connections/ we run
  // a periodic parse and POST any new records to the server's extension API
  // as { records, totalCount, source, scrapedAt }. The server dedupes by
  // profileUrl, so re-running the same page repeatedly is safe — only
  // genuinely new entries get appended — and it tags every row with the
  // operator it resolves itself; the upload carries no name.
  // ============================================================

  const CONNECTIONS_URL_RE = /linkedin\.com\/mynetwork\/invite-connect\/connections/;
  const CONNECT_SCAN_INTERVAL_MS = 5000;
  let connectScanTimer = null;
  let lastConnectsHash = '';

  function hashConnects(records) {
    return records.map(r => r.profileUrl).sort().join('|');
  }

  async function scanConnections() {
    if (!CONNECTIONS_URL_RE.test(window.location.href)) return;
    const parser = window.ConnectTrackerParser;
    if (!parser) {
      addLog('warn', 'connects', 'Tick: ConnectTrackerParser not loaded on this page');
      return;
    }

    let records;
    try {
      records = parser.parseConnectionsPage();
    } catch (err) {
      addLog('error', 'connects', `Tick: parse failed: ${err.name}: ${err.message}`);
      return;
    }
    if (!records.length) {
      addLog('info', 'connects', 'Tick: 0 records visible — scroll the page so LinkedIn renders connection cards.');
      return;
    }

    const h = hashConnects(records);
    if (h === lastConnectsHash) {
      addLog('info', 'connects', `Tick: ${records.length} on page, no changes since last scan — skipping upload.`);
      return;
    }
    lastConnectsHash = h;

    const url = `${SERVER_URL}/connections`;
    const r = await srvFetch(url, {
      method: 'POST',
      body: JSON.stringify({
        records,
        totalCount: parser.parseTotalCount(),
        source: 'connections-page',
        scrapedAt: new Date().toISOString(),
      }),
    });
    if (!r.ok) {
      if (r.error) {
        addLog('error', 'connects', `Upload failed: ${r.error} (url=${url}, recs=${records.length})`);
      } else {
        const msg = r.body?.error || r.text?.slice(0, 200) || '';
        addLog('error', 'connects', `Server rejected upload: HTTP ${r.status}${msg ? ' — ' + msg : ''}`);
      }
      return;
    }
    // Always log scan outcomes — including no-op resyncs — so the user can
    // see the extension is alive and what it just did.
    const added = r.body?.added || 0;
    const updated = r.body?.updated || 0;
    const total = r.body?.total || 0;
    if (added > 0) {
      addLog('info', 'connects', `Synced ${records.length}: +${added} new, ${updated} updated, total ${total}`);
    } else if (updated > 0) {
      addLog('info', 'connects', `Resync ${records.length}: ${updated} refreshed, no new (total ${total})`);
    } else {
      addLog('info', 'connects', `Scanned ${records.length}: nothing new (total ${total})`);
    }
  }

  function startConnectionsScraper() {
    if (connectScanTimer) return;
    // First pass after a short delay so LinkedIn has time to render the list.
    setTimeout(scanConnections, 2500);
    connectScanTimer = setInterval(scanConnections, CONNECT_SCAN_INTERVAL_MS);
  }

  function stopConnectionsScraper() {
    if (connectScanTimer) {
      clearInterval(connectScanTimer);
      connectScanTimer = null;
    }
    lastConnectsHash = '';
  }

  function syncConnectionsScraperWithUrl() {
    if (CONNECTIONS_URL_RE.test(window.location.href)) startConnectionsScraper();
    else stopConnectionsScraper();
  }

  // SPA navigation: hook into the existing url-change observer above by
  // re-checking on every detected nav. The observer at lastUrl handles the
  // detection; we just need to react.
  const _originalScheduleAutoScan = scheduleAutoScan;
  scheduleAutoScan = function patched() {
    _originalScheduleAutoScan();
    syncConnectionsScraperWithUrl();
  };

  // ============================================================
  // CONNECT-MODAL PERSONALIZATION
  //
  // When LinkedIn opens the "Add a note to your invitation" modal — on
  // profile pages, search results, company People pages, anywhere — the
  // modal heading reads "Personalize your invitation to <Full Name> by
  // adding a note." We pull the first name out of that, then hot-swap
  // the user's clipboard: every "Hi there," (or "Hi {{name}},") becomes
  // "Hi <first>,". Toast for 2 s so the operator knows it landed. If no
  // name is extractable, the clipboard stays untouched.
  //
  // We never touch the LinkedIn textarea — text-injection is exactly the
  // automation pattern LinkedIn flags. The operator still hits Paste.
  // ============================================================

  // Any linkedin.com page can pop the invite-note dialog: profile, search,
  // people tab on a company, even "people you can reach out to" on a job
  // page. So we mount the observer everywhere on linkedin.com and act
  // only when the dialog's specific copy ("Add a note" / "Personalize
  // your invitation") shows up inside [role="dialog"].
  const PERSON_PAGE_RE = /linkedin\.com\//;
  // Tracks WHO we last pre-filled for. Reset to null when the dialog
  // leaves the DOM. New dialog or same dialog with a different
  // recipient → name differs from last → re-personalize. This replaces
  // a single boolean flag that never reset between people.
  let _lastFilledFor = null;
  let _modalObserver = null;
  // Premium modal variant has heading "Add a note to your invitation"
  // — no recipient name visible anywhere inside the dialog. LinkedIn's
  // Connect button always carries the name on its aria-label though
  // ("Invite Jane Doe to connect" / "Connect with John Doe"). We
  // capture clicks on those buttons and stash the name + timestamp; the
  // modal observer reads this as a fallback when its own heading parse
  // turns up nothing. TTL is 5 s so an old click can't pollute a later
  // unrelated dialog.
  let _pendingRecipient = null; // { firstName, ts }
  const PENDING_RECIPIENT_TTL_MS = 5000;

  // Detect the company name on the current page. Handles four LinkedIn
  // page shapes — falls through them in order until one yields a name.
  //   1. Job page (/jobs/view/…): the existing company anchor.
  //   2. Profile page (/in/<slug>/): the subtitle line below the h1
  //      ("Software Engineer at <Company>"). LinkedIn renders the
  //      person's current company there for almost every profile.
  //   3. Company page (/company/<slug>/): the h1.
  //   4. Anything else: null. Caller skips the fallback.
  function detectCompanyOnPage() {
    // 1) Job page — reuse the existing anchor finder.
    if (/linkedin\.com\/jobs\//.test(window.location.href)) {
      try {
        const a = findCompanyAnchor && findCompanyAnchor();
        if (a?.textContent) return a.textContent.trim();
      } catch { /* findCompanyAnchor may not be in scope here */ }
    }
    // 2) Profile page — the "Title at Company" subtitle below the name.
    //    LinkedIn's class names are obfuscated; match by structure.
    if (/linkedin\.com\/in\//.test(window.location.href)) {
      const h1 = document.querySelector('h1');
      // The subtitle is usually the sibling div / div.text-body-medium
      // a few nodes down from h1 within the top card. Grab nearby text
      // and look for the "X at Y" pattern.
      const candidates = [];
      let el = h1?.parentElement;
      for (let i = 0; i < 4 && el; i++) {
        for (const node of el.querySelectorAll('div, span')) {
          const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length > 3 && t.length < 200) candidates.push(t);
        }
        el = el.parentElement;
      }
      // Match "<role> at <Company>" — Company captures up to a hyphen,
      // pipe, bullet, or the end. Defensive on whitespace.
      for (const t of candidates) {
        const m = t.match(/\bat\s+([^|·•\-\n]+?)(?:\s*[|·•\-]|$)/i);
        if (m) {
          const c = m[1].trim();
          if (c && c.length < 80) return c;
        }
      }
    }
    // 3) Company page — the h1 IS the company.
    const compMatch = window.location.href.match(/linkedin\.com\/company\/([^/?#]+)/);
    if (compMatch) {
      const h1 = document.querySelector('h1');
      const t = (h1?.textContent || '').trim();
      if (t && t.length < 80) return t;
      // Fallback: slug → titleish (e.g. "acme-corp" → "acme corp").
      return compMatch[1].replace(/-/g, ' ');
    }
    return null;
  }

  // Server-side fallback. Hits /api/ext/note-for-company through the
  // background worker (a direct fetch from linkedin.com is blocked by page
  // CORS — see the header); the server prefers rows the operator applied
  // to. Returns the resolved note string ({{exp}} filled, {{name}} still a
  // placeholder for the caller to swap) or null.
  async function fetchNoteForCompany(company) {
    if (!company) return null;
    const params = new URLSearchParams({ company });
    const r = await srvFetch(`${SERVER_URL}/note-for-company?${params.toString()}`);
    if (!r.ok) {
      addLog('warn', 'modal', `note-for-company failed: ${r.error || 'HTTP ' + r.status} (company=${company})`);
      return null;
    }
    const data = r.body;
    if (!data?.note) return null;
    addLog('info', 'modal', `note-for-company hit: company="${company}" → "${data.fromJob?.title || '?'}" (${data.note.length} chars, applied=${!!data.fromJob?.appliedByCurrentUser})`);
    return data.note;
  }

  // Returns the best available raw note (with {{name}} still in place)
  // for the current page — tries the chrome.storage.local stash first,
  // then the company-based server fallback. Returns null when nothing
  // is usable. Source is logged so the operator can tell which path
  // fired.
  async function resolveBestRawNote() {
    try {
      const data = await chrome.storage.local.get('lastConnectNote');
      const last = data.lastConnectNote;
      if (last?.note) {
        const ageMs = Date.now() - (Number(last.copiedAt) || 0);
        if (ageMs <= 30 * 60 * 1000) return { note: String(last.note), source: 'stash', ageMs };
      }
    } catch { /* fall through to server lookup */ }
    const company = detectCompanyOnPage();
    if (!company) return null;
    const note = await fetchNoteForCompany(company);
    if (!note) return null;
    return { note, source: 'company', company };
  }

  // Capture clicks on LinkedIn's Connect buttons anywhere on the page.
  // Two jobs:
  //   1. Stash the recipient first-name (from aria-label "Invite X to
  //      connect" / "Connect with X") so the modal observer has a
  //      fallback when its own heading parse comes back empty.
  //   2. PROACTIVELY personalize the stashed note and write it to the
  //      clipboard NOW. This click IS the user gesture clipboard.writeText
  //      needs — the modal observer's MutationObserver callback isn't one,
  //      so doing it here is the only reliable path. If the auto-fill
  //      later succeeds the user clicks Send; if it doesn't, Ctrl+V works
  //      because the clipboard already holds the right text.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('button, a');
    if (!btn) return;
    const aria = (btn.getAttribute('aria-label') || '').trim();
    if (!aria) return;
    const m = aria.match(/(?:Invite|Connect with)\s+([A-Z][\p{L}'’.\-]+)/u);
    if (!m) return;
    const firstName = m[1];
    _pendingRecipient = { firstName, ts: Date.now() };
    _lastFilledFor = null;
    addLog('info', 'modal', `connect-click captured aria-label="${aria.slice(0, 80)}" → recipient=${firstName}`);

    // Pre-personalize and write to clipboard while the user gesture is
    // still live. Stash path stays sync-ish (single storage read); the
    // company fallback (server fetch) is best-effort — Chrome usually
    // honours clipboard.writeText after a short await chain as long as
    // the original click is still on the gesture stack.
    try {
      const best = await resolveBestRawNote();
      if (!best) return;
      const personalized = String(best.note)
        .replace(/\{\{name\}\}/g, firstName)
        .replace(/^(Hi|Hello|Hey)\s+there([!,])/i, `Hi ${firstName}$2`);
      await navigator.clipboard.writeText(personalized);
      addLog('info', 'modal', `clipboard pre-personalized for ${firstName} on connect-click (${personalized.length} chars, source=${best.source})`);
    } catch (err) {
      addLog('warn', 'modal', `clipboard pre-personalize failed: ${err?.message || err}`);
    }
  }, true);

  function extractRecipientFirstName(modalEl) {
    // The heading text varies slightly by LinkedIn locale but always
    // contains the recipient's full name in bold or right after "to".
    // Three reliable strategies, first hit wins:
    //   1. The modal's h2 — title. Strip the prefix and any trailing prose.
    //   2. <strong> inside the modal body — usually wraps the name.
    //   3. (Profile pages only) The page's h1 — the person's name.
    const candidates = [];
    const h2 = modalEl.querySelector('h2');
    if (h2?.textContent) candidates.push(h2.textContent);
    for (const s of modalEl.querySelectorAll('strong')) {
      if (s.textContent) candidates.push(s.textContent);
    }
    for (const raw of candidates) {
      const txt = raw.replace(/\s+/g, ' ').trim();
      // "Personalize your invitation to John Doe by adding a note." → John
      const m = txt.match(/(?:to|invite)\s+([A-Z][\p{L}'’.\-]*)/u);
      if (m) return m[1];
      // Bare name in a <strong>: "John Doe" → "John"
      if (/^[A-Z][\p{L}'’.\-]+(\s+[A-Z][\p{L}'’.\-]+)*$/u.test(txt)) {
        return txt.split(/\s+/)[0];
      }
    }
    // Profile-page fallback. On /in/<slug>/ pages the h1 IS the person.
    // The Premium "Add a note" modal omits the name everywhere inside
    // itself, so this is the only place we can find it without relying
    // on the (sometimes missing) Connect-button aria-label.
    if (/linkedin\.com\/in\//.test(window.location.href)) {
      const h1 = document.querySelector('h1');
      const txt = (h1?.textContent || '').replace(/\s+/g, ' ').trim();
      const m = txt.match(/^([A-Z][\p{L}'’.\-]+)/u);
      if (m) return m[1];
    }
    return null;
  }

  function showPersonalizationToast(message, kind = 'ok') {
    document.getElementById('job-scanner-personalize-toast')?.remove();
    const palette = kind === 'warn'
      ? { bg: '#3a1a1a', fg: '#ff8866', border: '#ff886633' }
      : { bg: '#1a3a1a', fg: '#44ff44', border: '#44ff4433' };
    const t = document.createElement('div');
    t.id = 'job-scanner-personalize-toast';
    t.textContent = message;
    t.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      background: ${palette.bg}; color: ${palette.fg};
      border: 1px solid ${palette.border}; border-radius: 18px;
      padding: 8px 16px; font: 600 12.5px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
      transition: opacity 0.3s;
    `;
    document.body.appendChild(t);
    // Warn toasts linger longer — the operator needs time to read what
    // went wrong before reacting.
    const lifetimeMs = kind === 'warn' ? 4000 : 1700;
    setTimeout(() => t.style.opacity = '0', lifetimeMs);
    setTimeout(() => t.remove(), lifetimeMs + 500);
  }

  // Wait for a child element to appear under `root`. Resolves null on
  // timeout. Used to pick up the modal's textarea after React mounts it.
  function waitForElementWithin(root, selector, timeoutMs) {
    return new Promise((resolve) => {
      const existing = root.querySelector(selector);
      if (existing) return resolve(existing);
      let done = false;
      const obs = new MutationObserver(() => {
        const el = root.querySelector(selector);
        if (el && !done) { done = true; obs.disconnect(); resolve(el); }
      });
      obs.observe(root, { childList: true, subtree: true });
      setTimeout(() => { if (!done) { done = true; obs.disconnect(); resolve(null); } }, timeoutMs);
    });
  }

  // React tracks textarea state internally; just setting .value bypasses
  // its tracker so React rewrites the DOM on its next render and clobbers
  // our text. Two ways around it:
  //   1. execCommand('insertText') — DOM mutation event React listens to.
  //   2. The "native setter" trick — invoke the prototype's value setter
  //      directly, then dispatch an input event React picks up.
  // We try (1) first since it's more native; fall back to (2).
  function setTextareaValueReactSafe(ta, value) {
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    if (document.execCommand('insertText', false, value)) return true;
    try {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      proto.set.call(ta, value);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch { return false; }
  }

  async function tryPersonalizeOnModal(modalEl, firstName) {
    // Caller already extracted the name and gate-checked _lastFilledFor.
    // Source order: chrome.storage.local stash (set by badge copy click)
    // → server fallback by detected company (note-for-company endpoint).
    // We DON'T try to read the clipboard because clipboard.readText()
    // requires a user gesture and the MutationObserver isn't one.
    const best = await resolveBestRawNote();
    if (!best) {
      addLog('info', 'modal', `modal for ${firstName}, no note from stash or company fallback`);
      showPersonalizationToast('No note found — copy one from Forge or visit a job for this company first', 'warn');
      return;
    }
    if (best.source === 'stash' && best.ageMs > 25 * 60 * 1000) {
      // Soft warn at >25min — still use it, but tell the operator.
      addLog('info', 'modal', `using stashed note ${((best.ageMs || 0) / 60000) | 0}min old for ${firstName}`);
    }
    const personalized = String(best.note)
      .replace(/\{\{name\}\}/g, firstName)
      .replace(/^(Hi|Hello|Hey)\s+there([!,])/i, `Hi ${firstName}$2`);

    const ta = await waitForElementWithin(modalEl, 'textarea', 2500);
    if (!ta) {
      addLog('warn', 'modal', `modal for ${firstName}, textarea did not appear within 2.5s`);
      return;
    }
    const ok = setTextareaValueReactSafe(ta, personalized);
    if (ok) {
      const tag = best.source === 'company' ? ` (via ${best.company})` : '';
      showPersonalizationToast(`Pre-filled for ${firstName}${tag}`);
      addLog('info', 'modal', `textarea filled with personalized note for ${firstName} (${personalized.length} chars, source=${best.source}${best.company ? ', company=' + best.company : ''})`);
    } else {
      addLog('warn', 'modal', `failed to write textarea for ${firstName} (both execCommand and native-setter)`);
    }
  }

  function startConnectModalObserver() {
    if (_modalObserver) return;
    _modalObserver = new MutationObserver(() => {
      // LinkedIn frequently leaves multiple [role="dialog"] elements
      // in the DOM (hidden tooltips, closed-but-not-removed dialogs).
      // querySelector returned the FIRST one regardless of visibility,
      // so we'd often be staring at a stale dialog that didn't match
      // our text check, returning early without ever seeing the live
      // invite modal. Walk every dialog and pick the one whose text
      // names the invite flow AND is actually rendered.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      let modal = null;
      for (const d of dialogs) {
        if (d.offsetParent === null && d.hidden) continue;
        const t = (d.textContent || '').toLowerCase();
        if (t.includes('add a note') || t.includes('personalize your invitation')) {
          modal = d;
          break;
        }
      }
      if (!modal) {
        // No live invite dialog found — reset so the NEXT open (could
        // be the same person again, or someone else) gets a fresh
        // attempt.
        if (_lastFilledFor !== null) _lastFilledFor = null;
        return;
      }
      const text = (modal.textContent || '').toLowerCase();
      if (!(text.includes('add a note') || text.includes('personalize your invitation'))) return;
      let firstName = extractRecipientFirstName(modal);
      // Premium modal fallback: no name in heading → use the name we
      // captured from the Connect button's aria-label moments ago.
      if (!firstName && _pendingRecipient
          && Date.now() - _pendingRecipient.ts < PENDING_RECIPIENT_TTL_MS) {
        firstName = _pendingRecipient.firstName;
        addLog('info', 'modal', `modal heading had no name; using pending recipient=${firstName}`);
      }
      // No recipient resolvable AT ALL (modal heading silent + no
      // recent connect-click captured). Still fill the textarea —
      // empty is the wrong default; "Hi there, …" reads naturally.
      if (!firstName) {
        firstName = 'there';
        addLog('info', 'modal', 'no recipient extractable; falling back to generic "there" greeting');
      }
      // Gate: only fire once per recipient. New recipient (or same
      // recipient after the dialog fully closed and _lastFilledFor was
      // wiped) triggers a fresh personalization.
      if (_lastFilledFor === firstName) return;
      _lastFilledFor = firstName;
      tryPersonalizeOnModal(modal, firstName);
    });
    _modalObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopConnectModalObserver() {
    _modalObserver?.disconnect();
    _modalObserver = null;
    _lastFilledFor = null;
    document.getElementById('job-scanner-personalize-toast')?.remove();
  }

  function syncConnectModalObserverWithUrl() {
    if (PERSON_PAGE_RE.test(window.location.href)) startConnectModalObserver();
    else stopConnectModalObserver();
  }

  // Patch the scheduleAutoScan SPA-nav hook (same pattern the
  // connections-scraper uses) so the modal observer mounts/unmounts as
  // the user navigates between LinkedIn pages.
  const _origScheduleAutoScanForModal = scheduleAutoScan;
  scheduleAutoScan = function patchedForModal() {
    _origScheduleAutoScanForModal();
    syncConnectModalObserverWithUrl();
  };

  // ============================================================
  // SEARCH-PAGE AUTO-CAPTURE
  //
  // When the operator clicks "Start capturing" on the Forge /scanner page, a
  // 5-minute window opens server-side (services/scanner/scan-buffer.js). While
  // it's armed, every linkedin.com/jobs/search page we land on gets scrolled
  // to the bottom (to render its ~25 cards), its HTML grabbed, and POSTed to
  // /api/ext/scan-capture — the /scanner page then pulls that HTML into its
  // importer textarea. We poll the armed flag on a timer (like the connections
  // scraper) so arming also works on an already-open search tab, and capture
  // each distinct results URL once. NOTE: no card-extraction logic lives here
  // — we grab generic HTML and let /scanner's single parser do the parsing.
  // ============================================================

  const SEARCH_URL_RE = /linkedin\.com\/jobs\/search/;
  const CAPTURE_SCAN_INTERVAL_MS = 4000;
  let searchCaptureTimer = null;
  let searchCaptureBusy = false;
  const capturedSearchKeys = new Set();

  // On disarmed→armed, tell inject.js to re-emit buffered payloads (recovers the
  // early LIST response). _armedCache is shared with the message handler below.
  let _prevArmed = false;
  let _armedCache = { val: false, at: 0 };
  function flushBufferedApiPayloads() {
    try { window.dispatchEvent(new CustomEvent('forge-jobscanner-flush')); } catch (_e) {}
  }

  // Walk mode: auto-click the single bottom-bar Next button to page through
  // results (each click = an SPA nav the interceptor captures).
  const NEXT_BTN_VISIBLE = 'button[data-testid="pagination-controls-next-button-visible"]';
  const PAGE_CURRENT = 'button[data-testid^="pagination-indicator-"][aria-current="true"]';
  let walkInFlight = false;
  const walkedSessions = new Set(); // dedup: one walk per armed session

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Random 12–15s gap between clicks so paging looks human and doesn't hammer LinkedIn.
  const randomGap = () => 12000 + Math.floor(Math.random() * 3000);

  function currentPageNum() {
    const b = document.querySelector(PAGE_CURRENT);
    const m = b && (b.getAttribute('aria-label') || '').match(/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  // Poll for a condition; returns its truthy value, or null on timeout.
  async function waitFor(fn, ms = 9000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(400); }
    return null;
  }

  // Prev button: data-testid, then chevron-left icon / "Previous" text fallbacks.
  function findPrevButton() {
    return document.querySelector('button[data-testid="pagination-controls-prev-button-visible"]')
      || [...document.querySelectorAll('button[data-testid^="pagination-controls-prev-button-"]')]
           .find((b) => b.getAttribute('data-testid') !== 'pagination-controls-prev-button-hidden'
             && !b.disabled && b.getAttribute('aria-disabled') !== 'true')
      || [...document.querySelectorAll('button')]
           .find((b) => b.querySelector('[id="chevron-left-small"]') || /^\s*Previous\s*$/i.test(b.textContent || ''));
  }

  // Full pointer/mouse sequence — LinkedIn's SDUI button ignores a plain .click().
  function realClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_e) {}
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const P = window.PointerEvent ? PointerEvent : MouseEvent;
    const seq = [['pointerover', P], ['pointerenter', P], ['pointerdown', P],
      ['mousedown', MouseEvent], ['pointerup', P], ['mouseup', MouseEvent], ['click', MouseEvent]];
    for (const [type, Ctor] of seq) { try { el.dispatchEvent(new Ctor(type, opts)); } catch (_e) {} }
    return true;
  }

  const WALK_SAFETY_CAP = 40; // LinkedIn caps job search at ~40 pages (1000 results)
  async function runWalk(pages) {
    // pages>0 = explicit cap; 0/absent = walk until the Next button disappears.
    const maxPages = Number(pages) > 0 ? Math.min(Number(pages), WALK_SAFETY_CAP) : WALK_SAFETY_CAP;
    addLog('info', 'capture', 'walk: auto-paging via Next to the last page');
    // Wait for the pagination bar to render before touching it.
    await waitFor(() => document.querySelector(NEXT_BTN_VISIBLE) || document.querySelector(PAGE_CURRENT), 12000);
    await sleep(randomGap()); // let page 1 settle + be captured first

    // Recover page 1 (its cold-load fetch can be missed): bounce Next→Prev to
    // re-fetch it via SPA. Wait for the page to change before clicking Prev.
    if (currentPageNum() === 1 && document.querySelector(NEXT_BTN_VISIBLE)) {
      addLog('info', 'capture', 'walk: page-1 recovery — clicking Next');
      realClick(document.querySelector(NEXT_BTN_VISIBLE));
      const prev = await waitFor(() => (currentPageNum() !== 1 ? findPrevButton() : null), 12000);
      if (prev) {
        addLog('info', 'capture', 'walk: clicking Previous to re-capture page 1');
        realClick(prev);
        await waitFor(() => currentPageNum() === 1, 12000);
        await sleep(randomGap());
      } else {
        const tids = [...document.querySelectorAll('[data-testid^="pagination-"]')]
          .map((e) => e.getAttribute('data-testid')).join(', ');
        addLog('warn', 'capture', `walk: Previous not found (now page ${currentPageNum()}); pagination testids: [${tids}]`);
      }
    }

    // Each page: dwell ~6s, scroll to bottom, then advance at the 12–15s mark.
    // Stops at the cap or when Next disappears (last page).
    const DWELL_MS = 6000;
    let stalled = false;
    for (let p = 1; p <= maxPages; p++) {
      const cycleMs = randomGap();          // total 12–15s on this page
      const t0 = Date.now();
      await sleep(DWELL_MS);                 // let the page settle + be captured
      await scrollResultsToBottom();         // then scroll to load all cards
      // Cap by the ACTUAL page number so manual paging (user clicking Next alongside us) counts toward Max pages.
      const nowPage = currentPageNum();
      if (nowPage != null && nowPage >= maxPages) { addLog('info', 'capture', `walk: reached Max pages (${maxPages}) at page ${nowPage}`); break; }
      if (p >= maxPages) { addLog('info', 'capture', `walk: hit Max pages cap (${maxPages})`); break; }
      // Transient missing Next ≠ last page — LinkedIn unmounts the bar mid-nav (and the user may be paging too). Stop only on the hidden-Next variant or a sustained absence.
      let next = document.querySelector(NEXT_BTN_VISIBLE);
      if (!next) {
        if (document.querySelector('button[data-testid="pagination-controls-next-button-hidden"]')) {
          addLog('info', 'capture', `walk: last page (Next hidden) at page ${nowPage ?? p}`); break;
        }
        next = await waitFor(() => document.querySelector(NEXT_BTN_VISIBLE), 8000);
        if (!next) { addLog('info', 'capture', `walk: no Next after 8s at page ${nowPage ?? p} — treating as last page`); break; }
      }
      const remain = cycleMs - (Date.now() - t0);
      if (remain > 0) await sleep(remain);   // wait out the rest of the 12–15s cycle
      const before = currentPageNum();
      realClick(next);
      await waitFor(() => { const c = currentPageNum(); return c != null && c !== before; }, 12000);
      if (before != null && currentPageNum() === before) {
        addLog('warn', 'capture', `walk: Next didn't advance from page ${before} — leaving tab open to finish manually`);
        stalled = true;
        break;
      }
    }

    // Close the tab on a clean finish; leave it open if a click stalled.
    if (stalled) {
      addLog('info', 'capture', 'walk: stopped early — tab left open');
    } else {
      addLog('info', 'capture', `walk: done (cap ${maxPages}) — closing tab`);
      await sleep(2500); // let the final page's capture POST land first
      try { chrome.runtime.sendMessage({ action: 'closeTab' }); } catch (_e) {}
    }
  }

  function maybeStartWalk(pages, deadlineKey) {
    if (walkInFlight || walkedSessions.has(deadlineKey)) return; // one walk per armed session
    walkedSessions.add(deadlineKey);
    if (walkedSessions.size > 20) walkedSessions.clear();
    walkInFlight = true;
    runWalk(pages).catch((e) => addLog('error', 'capture', `walk failed: ${e.message || e}`))
      .finally(() => { walkInFlight = false; });
  }

  // Dedup key: the search query WITHOUT currentJobId (which changes as the
  // user clicks jobs in the right pane) and WITHOUT the hash, so we capture a
  // results page once — but re-capture when `start` (page) changes.
  function searchCaptureKey() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('currentJobId');
      u.hash = '';
      return `${u.pathname}?${u.searchParams.toString()}`;
    } catch { return window.location.href; }
  }

  // Re-runnable scroll. scrollToBottomOnce() is guarded to fire once per
  // document; each LinkedIn search "page" is an SPA nav within the SAME
  // document, so we need a version that runs fresh for every page.
  async function scrollResultsToBottom() {
    try {
      const containers = findScrollContainers();
      if (!containers.length) return;
      let stableRounds = 0;
      for (let i = 0; i < 40 && stableRounds < 2; i++) {
        let moved = false;
        for (const c of containers) {
          const max = c.scrollHeight - c.clientHeight;
          if (c.scrollTop < max - 2) {
            const stride = Math.max(400, Math.floor(c.clientHeight * 0.8));
            c.scrollTop = Math.min(c.scrollTop + stride, max);
            moved = true;
          }
        }
        stableRounds = moved ? 0 : stableRounds + 1;
        await new Promise(r => setTimeout(r, 200));
      }
      for (const c of containers) c.scrollTop = c.scrollHeight - c.clientHeight;
      await new Promise(r => setTimeout(r, 500));
    } catch {}
  }

  async function captureSearchPageIfArmed() {
    if (!SEARCH_URL_RE.test(window.location.href)) return;
    if (searchCaptureBusy) return;

    // Poll armed state first, every tick, so the flush + walker always run.
    const st = await srvFetch(`${SERVER_URL}/scan-capture/status`);
    const armed = !!(st.ok && st.body?.armed);
    if (armed && !_prevArmed) {
      flushBufferedApiPayloads(); // recover the early LIST response
      addLog('info', 'capture', 'armed — flushed buffered API payloads');
    }
    _prevArmed = armed;
    _armedCache = { val: armed, at: Date.now() }; // keep the message handler in sync
    if (!armed) return;

    // Walk mode: paginate via Next and skip the HTML grab (multi-MB, fills the
    // buffer, and carries no ids in the SDUI UI — the API interceptor has them).
    if (st.body.walk) { maybeStartWalk(st.body.pages, st.body.armedUntil); return; }

    // Per-page HTML grab (manual mode only — title/company; ids come from API).
    const key = searchCaptureKey();
    if (capturedSearchKeys.has(key)) return;

    searchCaptureBusy = true;
    try {
      if (capturedSearchKeys.has(key)) return; // sibling tick raced us
      capturedSearchKeys.add(key);
      addLog('info', 'capture', `armed — scrolling + grabbing ${key}`);
      await scrollResultsToBottom();
      const html = ((document.querySelector('main') || document.body)?.outerHTML) || '';
      if (!html) { addLog('warn', 'capture', 'no HTML to grab'); capturedSearchKeys.delete(key); return; }
      const r = await srvFetch(`${SERVER_URL}/scan-capture`, {
        method: 'POST',
        body: JSON.stringify({ html, url: window.location.href }),
      });
      if (!r.ok) {
        capturedSearchKeys.delete(key); // network blip — allow a retry next tick
        addLog('error', 'capture', `POST failed: ${r.error || ('HTTP ' + r.status)}`);
        return;
      }
      if (r.body?.accepted) {
        addLog('info', 'capture', `captured page → server (${html.length} bytes, total ${r.body.chunkCount})`);
        // Auto-close the tab once grabbed only if the arm requested it AND we're
        // not walking (the walker needs the tab alive to keep paging). Manual
        // "Start capturing" arms without autoClose, so hand-browsed tabs are
        // left alone too.
        if (r.body.autoClose && !st.body.walk) {
          setTimeout(() => { try { chrome.runtime.sendMessage({ action: 'closeTab' }); } catch {} }, 600);
        }
      } else {
        capturedSearchKeys.delete(key); // not armed / full — let a re-arm retry
        addLog('info', 'capture', `not accepted (${r.body?.reason || '?'})`);
      }
    } finally {
      searchCaptureBusy = false;
    }
  }

  function startSearchCaptureLoop() {
    if (searchCaptureTimer) return;
    setTimeout(captureSearchPageIfArmed, 2500);
    searchCaptureTimer = setInterval(captureSearchPageIfArmed, CAPTURE_SCAN_INTERVAL_MS);
  }

  function stopSearchCaptureLoop() {
    if (searchCaptureTimer) {
      clearInterval(searchCaptureTimer);
      searchCaptureTimer = null;
    }
  }

  function syncSearchCaptureWithUrl() {
    if (SEARCH_URL_RE.test(window.location.href)) startSearchCaptureLoop();
    else stopSearchCaptureLoop();
  }

  // Patch scheduleAutoScan (same pattern as above) so the loop mounts/unmounts
  // as the operator navigates between LinkedIn pages.
  const _origScheduleAutoScanForCapture = scheduleAutoScan;
  scheduleAutoScan = function patchedForCapture() {
    _origScheduleAutoScanForCapture();
    syncSearchCaptureWithUrl();
  };

  // ── Search-API network capture ─────────────────────────────────────────────
  // inject.js (MAIN world) postMessages us each jobs-search API body; we forward
  // it to /scan-capture (kind:'api') when armed. The server gates on the armed
  // flag and the /scanner importer parses the ids out.

  // Short-TTL armed cache so we don't ship a big body just to have it dropped.
  async function isCaptureArmed() {
    const now = Date.now();
    if (now - _armedCache.at < 2000) return _armedCache.val;
    const st = await srvFetch(`${SERVER_URL}/scan-capture/status`);
    _armedCache = { val: !!(st.ok && st.body?.armed), at: now };
    return _armedCache.val;
  }

  // ============================================================
  // FEED CAPTURE (home feed + content search)
  // While armed on /feed or /search/results/content, flush buffered payloads and
  // ship sniffed feed API pages (kind:'feed'). Walk mode auto-scrolls via a
  // faithful port of the proven console scroller; Copy scroll script remains the
  // manual fallback.
  // ============================================================

  const FEED_URL_RE = /linkedin\.com\/(feed|search\/results\/content)/;
  const FEED_CAPTURE_INTERVAL_MS = 4000;
  let feedCaptureTimer = null;
  let _prevFeedArmed = false;
  let _feedArmedCache = { val: false, at: 0 };
  // flushBufferedApiPayloads() (above) re-emits all buffered payloads; the handler routes by kind.

  // Ship the WHOLE page HTML (kind:'feed-html') — exactly what a manual copy →
  // Add posts sends, so v2 parses the same [role=listitem] cards. Dedup'd against
  // the last snapshot so a static page isn't re-shipped.
  let _lastFeedHtml = '';
  async function shipFeedHtml() {
    try {
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      if (!html || html.length < 1000 || html === _lastFeedHtml) return;
      _lastFeedHtml = html;
      await srvFetch(`${SERVER_URL}/feed-capture`, {
        method: 'POST',
        body: JSON.stringify({ html, url: window.location.href, kind: 'feed-html' }),
      });
      addLog('info', 'feed-capture', `shipped page HTML (${html.length} bytes)`);
    } catch (_e) {}
  }

  async function captureFeedIfArmed() {
    if (!FEED_URL_RE.test(window.location.href)) return;
    const st = await srvFetch(`${SERVER_URL}/feed-capture/status`);
    const armed = !!(st.ok && st.body?.armed);
    if (armed && !_prevFeedArmed) {
      flushBufferedApiPayloads(); // recover the early page captured before arm
      addLog('info', 'feed-capture', 'armed — flushed buffered feed payloads');
    }
    _prevFeedArmed = armed;
    _feedArmedCache = { val: armed, at: Date.now() }; // keep the message handler in sync
    // Spoof visibility while armed so LinkedIn keeps loading the feed as you scroll.
    try { window.dispatchEvent(new CustomEvent(armed ? 'forge-vis-spoof-on' : 'forge-vis-spoof-off')); } catch (_e) {}
    // No auto-scroll — you scroll (or paste the Copy scroll script). While armed,
    // snapshot the rendered DOM each poll (dedup'd) so what you scroll past is captured.
    if (armed) shipFeedHtml();
  }

  function startFeedCaptureLoop() {
    if (feedCaptureTimer) return;
    setTimeout(captureFeedIfArmed, 2500);
    feedCaptureTimer = setInterval(captureFeedIfArmed, FEED_CAPTURE_INTERVAL_MS);
  }
  function stopFeedCaptureLoop() {
    if (feedCaptureTimer) { clearInterval(feedCaptureTimer); feedCaptureTimer = null; }
    try { window.dispatchEvent(new CustomEvent('forge-vis-spoof-off')); } catch (_e) {}
  }
  function syncFeedCaptureWithUrl() {
    if (FEED_URL_RE.test(window.location.href)) startFeedCaptureLoop();
    else stopFeedCaptureLoop();
  }

  // Short-TTL armed cache so we don't ship a big body just to have it dropped.
  async function isFeedCaptureArmed() {
    const now = Date.now();
    if (now - _feedArmedCache.at < 2000) return _feedArmedCache.val;
    const st = await srvFetch(`${SERVER_URL}/feed-capture/status`);
    _feedArmedCache = { val: !!(st.ok && st.body?.armed), at: now };
    return _feedArmedCache.val;
  }

  // ── Sniffed-API → server dispatch ───────────────────────────────────────────
  // Route jobs payloads → /scan-capture (kind:'api'), feed → /feed-capture
  // (kind:'feed'), each gated on its own armed window. Dedup key is kind-scoped.
  const seenApiKeys = new Set(); // LinkedIn sometimes double-fires a call
  async function shipCaptured(d, { endpoint, armedFn, kindTag, label }) {
    const key = `${kindTag}|${d.url}|${d.body.length}`;
    if (seenApiKeys.has(key)) return;
    seenApiKeys.add(key);
    if (seenApiKeys.size > 300) seenApiKeys.clear(); // bound; ids re-dedup at parse
    if (!(await armedFn())) { seenApiKeys.delete(key); return; }
    try {
      const r = await srvFetch(`${SERVER_URL}/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify({ html: d.body, url: d.url, kind: kindTag }),
      });
      if (r.ok && r.body?.accepted) {
        addLog('info', label, `${kindTag} payload captured → server (${d.body.length} bytes, total ${r.body.chunkCount})`);
      } else {
        seenApiKeys.delete(key); // not accepted (disarmed/full/blip) — allow retry
        if (r.body?.reason && r.body.reason !== 'not-armed') {
          addLog('warn', label, `${kindTag} payload not accepted (${r.body.reason})`);
        }
      }
    } catch (e) {
      seenApiKeys.delete(key);
      addLog('error', label, `${kindTag} payload POST failed: ${e.message || e}`);
    }
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'forge-jobscanner-net' || typeof d.body !== 'string') return;
    if (d.kind === 'feed') {
      await shipCaptured(d, { endpoint: 'feed-capture', armedFn: isFeedCaptureArmed, kindTag: 'feed', label: 'feed-capture' });
    } else {
      // jobs (kind 'jobs' or legacy untagged). scan-buffer expects kind:'api'
      // for sniffed bodies, so tag it that way regardless of the source label.
      await shipCaptured(d, { endpoint: 'scan-capture', armedFn: isCaptureArmed, kindTag: 'api', label: 'capture' });
    }
  });

  // Mount/unmount the feed loop as the operator navigates (same pattern as the
  // search-capture sync above).
  const _origScheduleAutoScanForFeedCapture = scheduleAutoScan;
  scheduleAutoScan = function patchedForFeedCapture() {
    _origScheduleAutoScanForFeedCapture();
    syncFeedCaptureWithUrl();
  };

  // ============================================================
  // INIT
  // ============================================================

  scheduleAutoScan();
  syncConnectionsScraperWithUrl();
  syncConnectModalObserverWithUrl();
  syncSearchCaptureWithUrl();
  syncFeedCaptureWithUrl();

  // ============================================================
  // AUTO-CONNECT
  //
  // A profile tab that background.js opened for the Posts page's Auto-connect
  // button carries #fgconnect (latched into sessionStorage by inject.js, since
  // LinkedIn's router strips the hash). On such a tab we do what the operator
  // would do by hand: click Connect — the top-card button when LinkedIn shows
  // one, else the entry inside the "More" menu — then "Send without a note"
  // in the invitation dialog. The outcome goes to the server (the connects
  // row flips) and to background.js (which closes the tab, or leaves it open
  // on a failure so a human can look). Nothing is ever typed into LinkedIn.
  // Profile pages without the marker are never touched.
  // ============================================================
  const FG_AUTO_CONNECT = /fgconnect/i.test(window.location.hash || '')
    || (() => { try { return sessionStorage.getItem('forgeAutoConnect') === '1'; } catch { return false; } })();
  // Profile pages, plus the invite page the Connect anchor may navigate to.
  const PROFILE_URL_RE = /linkedin\.com\/(in\/|preload\/custom-invite)/;

  const acSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const acText = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const acAria = (el) => el?.getAttribute?.('aria-label') || '';
  async function acWaitFor(fn, { timeout = 15000, every = 250 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await acSleep(every);
    }
    return null;
  }
  // LinkedIn's action row mixes elements: Connect and Message are <a> tags
  // (Connect points at /preload/custom-invite/?vanityName=…), More is a
  // <button>, and the More menu's entries are [role="menuitem"] anchors/divs.
  // So "button" here means any of those.
  const acHref = (el) => el?.getAttribute?.('href') || '';
  const acInMenu = (b) => !!b.closest('[role="menu"], .artdeco-dropdown__content, [role="listbox"], [popover]');

  // Polls, never one-shot: LinkedIn renders the action row late and in
  // pieces, so every step looks again each second until it sees what it
  // needs or its budget runs out, and logs what it saw so a miss can be
  // diagnosed from the popup's Logs tab.
  const acShown = (el) => !!el && el.getClientRects().length > 0;
  // The invitation modal is not in the page's light DOM. Measured miss after
  // the Connect click opened it on screen: no [role=dialog] in the document,
  // iframes ["about:blank" ×2, "/preload/?_bprMode=vanilla → 7 buttons"], and
  // no "Send without a note" button in any of them. The profile page is the
  // new React UI while the invite modal is the older Ember UI (booted in that
  // /preload/ iframe), which it mounts into a shadow root — a boundary plain
  // querySelectorAll never crosses. So every lookup walks the top document,
  // each readable iframe, and every shadow root under either, open or closed
  // (chrome.dom exists only in content scripts, which is where this runs).
  const acShadowOf = (el) => {
    try { return chrome.dom?.openOrClosedShadowRoot?.(el) || el.shadowRoot || null; } catch { return el.shadowRoot || null; }
  };
  const acRoots = () => {
    const roots = [];
    const seen = new Set();
    const visit = (root) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      roots.push(root);
      for (const el of root.querySelectorAll('*')) {
        const sr = acShadowOf(el);
        if (sr) visit(sr);
        if (el.tagName === 'IFRAME') {
          try { if (el.contentDocument) visit(el.contentDocument); } catch { /* cross-origin — not ours */ }
        }
      }
    };
    visit(document);
    return roots;
  };
  const acAll = (root, sel) => (root ? [root] : acRoots()).flatMap((r) => [...r.querySelectorAll(sel)]).filter(acShown);
  // Names a root for the logs: the page, an iframe by path, or a shadow root
  // by its host's tag#id. Not `instanceof ShadowRoot` — a shadow root inside
  // an iframe belongs to that frame's realm and fails the check.
  const acRootLabel = (r) => r.nodeType === 11 && r.host
    ? `shadow:${r.host.tagName.toLowerCase()}${r.host.id ? '#' + r.host.id : ''}`
    : (r === document ? 'doc' : `iframe:${(r.location?.pathname || '').slice(0, 30)}`);
  // Where the lookups looked, for the failure report: each root and its visible buttons.
  const acWhere = () => acRoots().map((r) => `${acRootLabel(r)}(${[...r.querySelectorAll('button')].filter(acShown).length})`).join(' ');
  const acCandidates = () => acAll(null, 'button, a[href], [role="button"], [role="menuitem"]');
  const acNotAside = (el) => !el.closest('aside');

  async function autoConnectProfile() {
    try { sessionStorage.removeItem('forgeAutoConnect'); } catch {}
    const onInvitePage = location.pathname.startsWith('/preload/custom-invite');
    const profileUrl = onInvitePage
      ? `https://www.linkedin.com/in/${new URLSearchParams(location.search).get('vanityName') || ''}/`
      : window.location.href.split('#')[0].split('?')[0];
    const slug = (profileUrl.match(/\/in\/([^/]+)/) || [])[1] || '';
    const slugRe = slug ? new RegExp(`vanityName=${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(&|$)`, 'i') : null;
    const step = (msg) => addLog('info', 'auto-connect', `${msg} — ${slug}`);
    const report = async (result, detail = '') => {
      addLog(result === 'sent' ? 'info' : 'warn', 'auto-connect', `${result}${detail ? ' — ' + detail : ''} ${profileUrl}`);
      await srvFetch(`${SERVER_URL}/connects/auto-result`, {
        method: 'POST',
        body: JSON.stringify({ profileUrl, result, detail }),
      });
      try { chrome.runtime.sendMessage({ action: 'autoConnectResult', result, detail, profileUrl }); } catch {}
    };

    // This profile's own controls. Connect is an <a> whose href carries the
    // profile's vanityName — sidebar "Connect" buttons never do, so that is
    // the first thing looked for. More is the first visible "More" <button>
    // outside <aside>. Pending is the text on the spot where Connect was.
    const findConnect = () =>
      acCandidates().find((b) => slugRe && slugRe.test(acHref(b)))
      || acCandidates().find((b) => acNotAside(b) && !acInMenu(b) && (/^invite .+ to connect$/i.test(acAria(b)) || /^connect$/i.test(acText(b))));
    const findPending = () => acCandidates().find((b) => acNotAside(b) && (/^pending$/i.test(acText(b)) || /^pending/i.test(acAria(b))));
    const findMore = () => acCandidates().find((b) => acNotAside(b) && !acInMenu(b) && b.tagName === 'BUTTON'
      && (/^more$/i.test(acText(b)) || /^more actions$/i.test(acAria(b))));
    const findMenuConnect = () => acCandidates().find((b) => acInMenu(b)
      && (/^invite .+ to connect$/i.test(acAria(b)) || /^connect$/i.test(acText(b)) || /\/custom-invite\//.test(acHref(b))));
    const findMenuRemove = () => acCandidates().find((b) => acInMenu(b) && /remove connection/i.test(acText(b)));
    const findSend = () =>
      acCandidates().find((b) => /^send without (a )?note$/i.test(acAria(b)) || /^send without (a )?note$/i.test(acText(b)))
      || acCandidates().find((b) => b.closest('[role="dialog"], dialog, .artdeco-modal') && /^send( now| invitation)?$/i.test(acText(b)));
    const describe = (list) => JSON.stringify(list.map((b) => acText(b) || acAria(b)).filter(Boolean).slice(0, 15));

    try { window.dispatchEvent(new CustomEvent('forge-vis-spoof-on')); } catch {}

    if (!onInvitePage) {
      // 1) The action row: Connect, Pending or More. Up to 30 s, one look per second.
      const found = await acWaitFor(() => {
        if (findPending()) return 'pending';
        if (findConnect()) return 'connect';
        if (findMore()) return 'more';
        return null;
      }, { timeout: 30000, every: 1000 });
      if (!found) {
        return report('error', `action row never appeared in 30 s (hidden: ${document.hidden}, seen: ${describe(acCandidates().filter(acNotAside))})`);
      }
      step(`action row ready (${found})`);
      await acSleep(2000 + Math.random() * 1500); // settle, and look human

      if (findPending()) return report('pending', 'invitation already pending');
      let connect = findConnect();
      if (!connect) {
        const more = findMore();
        if (!more) return report('not-found', `no Connect link and no More button (seen: ${describe(acCandidates().filter(acNotAside))})`);
        step('no Connect in the row — opening More');
        more.click();
        const menuHit = await acWaitFor(() => findMenuConnect() || (findMenuRemove() ? 'remove' : null), { timeout: 6000, every: 500 });
        if (!menuHit || menuHit === 'remove') {
          const items = describe(acCandidates().filter(acInMenu));
          document.body.click(); // close the menu again
          return menuHit === 'remove'
            ? report('already-connected', '1st-degree connection')
            : report('not-found', `More menu has no Connect (items: ${items})`);
        }
        connect = menuHit;
      }
      step(`clicking ${connect.tagName.toLowerCase()} "${acText(connect) || acAria(connect)}"`);
      connect.click();
    } else {
      step('on the invite page itself');
    }

    // 2) The invitation dialog — or the invite page, if the anchor navigated:
    //    "Send without a note". Up to 15 s, looking every half second.
    const DIALOG_SEL = '[role="dialog"], [role="alertdialog"], dialog, .artdeco-modal';
    const send = await acWaitFor(() => {
      const dialog = acAll(null, DIALOG_SEL)[0];
      if (dialog && /invitation limit|reached the .* limit/i.test(acText(dialog))) return 'limit';
      return findSend();
    }, { timeout: 15000, every: 500 });
    if (send === 'limit') return report('limit', 'LinkedIn invitation limit reached');
    if (!send) {
      const dialog = acAll(null, DIALOG_SEL)[0];
      const noteish = acCandidates().filter((b) => /note|send|invit/i.test(acText(b) || acAria(b)));
      return report('error', `no "Send without a note" button within 15 s (dialog: ${dialog ? acText(dialog).slice(0, 80) : 'none'}; note/send buttons: ${describe(noteish)}; roots: ${acWhere()}; url: ${location.pathname})`);
    }
    step(`clicking "${acText(send) || acAria(send)}" (in ${acRootLabel(send.getRootNode())})`);
    await acSleep(800 + Math.random() * 800);
    send.click();
    const pending = await acWaitFor(findPending, { timeout: 8000, every: 500 });
    return report('sent', pending ? 'row now shows Pending' : 'clicked Send; Pending not observed');
  }

  // The Forge pages (any localhost port) ask for a batch with
  // window.postMessage({ type: 'forge:auto-connect', items: [{ postId, profileUrl }] })
  // and get { type: 'forge:auto-connect:ack', ok, queued } back. The queue
  // itself runs in background.js, one profile tab at a time.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data?.type !== 'forge:auto-connect') return;
      const items = (Array.isArray(e.data.items) ? e.data.items : [])
        .filter((i) => i && /^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(i.profileUrl))
        .slice(0, 25);
      chrome.runtime.sendMessage({ action: 'autoConnectQueue', items }, (reply) => {
        const err = chrome.runtime.lastError?.message || reply?.error || null;
        window.postMessage({ type: 'forge:auto-connect:ack', ok: !err && !!reply?.ok, queued: reply?.queued || 0, error: err }, '*');
      });
    });
  }

  // Run when background.js says this tab is one of its auto-connect tabs
  // (deterministic), or when the #fgconnect marker survived (belt and braces).
  if (PROFILE_URL_RE.test(window.location.href)) {
    const ready = document.readyState === 'loading'
      ? new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }))
      : Promise.resolve();
    const shouldRun = new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'autoConnectCheck' }, (reply) => {
          resolve(!chrome.runtime.lastError && !!reply?.run);
        });
      } catch { resolve(false); }
      setTimeout(() => resolve(false), 3000);
    });
    Promise.all([ready, shouldRun]).then(([, run]) => {
      if (run || FG_AUTO_CONNECT) return autoConnectProfile();
    }).catch((e) => addLog('error', 'auto-connect', `crashed: ${e.message}`));
  }
})();
