/**
 * One-page PDF renderer.
 *
 * Why this exists alongside `document.js`: the DOCX template path cannot
 * guarantee a page count. Content length swings with the JD — a verbose posting
 * produces a longer summary, longer bullets and a longer skills line — and a
 * template has no way to react, so tailored resumes routinely spilled onto a
 * second page (measured: 2 pages on a plain run for the current candidate).
 *
 * Rendering through Chrome makes the fit *measurable*. The page is laid out at
 * print media, its height read against the A4 printable box, and a single CSS
 * multiplier (`--k`, which every size on the page is expressed in terms of)
 * binary-searched for the largest value that still fits. Only if the smallest
 * readable multiplier still overflows does content get trimmed, oldest and
 * least relevant first — see TRIMS.
 *
 * `generateDocx()` is untouched and still serves the .docx download and the
 * no-Chrome fallback.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { groupSkills } from './skill-groups.js';
import { calculateExperience } from './prompts.js';

// ── Page geometry ──
// A4 at 96dpi. Margins match the printable box passed to page.pdf() below, so
// the height measured on screen is the height Chrome paginates against.
const MM_PX = 96 / 25.4;
const MARGIN = { top: 10, bottom: 8, left: 11, right: 11 }; // mm
const CONTENT_W = Math.floor((210 - MARGIN.left - MARGIN.right) * MM_PX); // 710
const CONTENT_H = Math.floor((297 - MARGIN.top - MARGIN.bottom) * MM_PX); // 1054

// Type-scale multiplier bounds. Below ~0.82 the page stops being comfortable to
// read, so that is where trimming takes over from shrinking.
const K_MIN = 0.82;
const K_MAX = 1.16;
const FIT_SLACK = 0.995; // leave a hair of room for print-layout rounding

// ── Text helpers ──

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const rxEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Quantified results are the part of a bullet a recruiter's eye should land on.
const METRIC_RX = /\b\d+(?:\.\d+)?\s*(?:%|x\b|×|\+?\s*years?\b|\+?\s*yrs?\b)|\b\d+\+?\s*(?:LPA|users|roles|apps|tools)\b/gi;

/**
 * Collect non-overlapping [start, end) spans to bold, longest match first at
 * any given position, then emit the string with those spans wrapped in <b>.
 * Detection runs on the RAW text and escaping happens per-slice on the way out,
 * so a term can never be matched inside an HTML entity.
 */
function boldify(text, termRx, used) {
  const raw = String(text ?? '');
  if (!raw) return '';

  const spans = [];
  const push = (m, key) => {
    if (key !== undefined) {
      if (used.has(key)) return; // one highlight per term, resume-wide
      used.add(key);
    }
    spans.push([m.index, m.index + m[0].length]);
  };

  if (termRx) {
    termRx.lastIndex = 0;
    for (let m; (m = termRx.exec(raw)); ) push(m, m[0].toLowerCase());
  }
  METRIC_RX.lastIndex = 0;
  for (let m; (m = METRIC_RX.exec(raw)); ) push(m);

  // A leading "Project Name:" prefix — the shape the current resume already uses.
  const label = raw.match(/^[A-Z][^:.]{2,45}:/);
  if (label) spans.push([0, label[0].length]);

  if (!spans.length) return esc(raw);

  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s < last[1]) {
      last[1] = Math.max(last[1], e); // overlapping highlights read as one
    } else {
      merged.push([s, e]);
    }
  }

  let out = '';
  let cursor = 0;
  for (const [s, e] of merged) {
    out += esc(raw.slice(cursor, s)) + '<b>' + esc(raw.slice(s, e)) + '</b>';
    cursor = e;
  }
  return out + esc(raw.slice(cursor));
}

/**
 * Regex matching any of the tailored skills as a standalone term.
 * Longest-first so "React.js" wins over "React" at the same position, and the
 * trailing lookahead keeps bare "Node" from firing inside "Node.js".
 */
function buildTermRegex(skills) {
  const raw = (Array.isArray(skills) ? skills : String(skills || '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);

  // Prose rarely uses the skills line's exact spelling: the list says
  // "React.js" and "Model Context Protocol (MCP)" while the summary writes
  // "React" and "MCP". Without these variants the most important terms on the
  // page go unhighlighted.
  const terms = new Set();
  for (const term of raw) {
    terms.add(term);
    const stem = term.replace(/\.js$/i, '');
    if (stem !== term) terms.add(stem);
    const paren = term.match(/^(.+?)\s*\(([^)]+)\)$/);
    if (paren) { terms.add(paren[1].trim()); terms.add(paren[2].trim()); }
  }

  const list = [...terms]
    .filter((s) => s.length >= 2 && s.length <= 40)
    .sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  return new RegExp(
    `(?<![A-Za-z0-9+#.])(?:${list.map(rxEsc).join('|')})(?![A-Za-z0-9+#]|\\.[A-Za-z])`,
    'gi',
  );
}

// ── Content model ──

/** Strip a URL down to what a resume prints, e.g. "linkedin.com/in/x". */
const asHref = (url) => {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, '')}`;
};

/**
 * Flatten the AI response + stored resume into everything the template prints.
 * Mirrors `prepareTemplateData()` in document.js: AI bullets replace the
 * CURRENT role's bullets only, and each personal project takes its rewritten
 * description keyed by the project's slug.
 */
export function buildResumeModel(aiResponse, resumeData) {
  const info = resumeData.personalInfo || {};
  const meta = resumeData.meta || {};

  const expStart = meta.experienceStart;
  const years = expStart ? Math.floor(calculateExperience(expStart)) : null;

  const skillRows = groupSkills(aiResponse.skills, resumeData);
  const hasAI = skillRows.some((r) => r.label === 'AI / LLM');

  // e.g. "SOFTWARE DEVELOPER • <meta.stack> & AI/LLM • 3+ YEARS"
  const tagline = [
    aiResponse.title || 'Software Developer',
    [meta.stack, hasAI ? 'AI/LLM' : null].filter(Boolean).join(' & ') || null,
    years ? `${years}+ Years` : null,
  ].filter(Boolean).join(' • ');

  const links = [
    { label: 'Portfolio', href: asHref(info.portfolio) },
    { label: 'LinkedIn', href: asHref(info.linkedin) },
    { label: 'GitHub', href: asHref(info.github) },
    { label: 'LeetCode', href: asHref(info.leetcode) },
  ].filter((l) => l.href);

  const experiences = (resumeData.experience || []).map((exp) => ({
    title: exp.title || '',
    company: exp.company || '',
    location: exp.location || '',
    duration: exp.duration || '',
    isCurrent: !!exp.isCurrent,
    bullets: exp.isCurrent ? (aiResponse.bullets || []) : (exp.bullets || []),
  }));

  const projects = (resumeData.projects || []).map((p) => {
    const key = p.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return {
      name: p.name || '',
      description: aiResponse[key] || aiResponse.projects?.[p.name] || p.description || '',
    };
  });

  // `field` is often already spelled out inside `degree` ("Diploma in Computer
  // Engineering" + field "Computer Science" must not become "…Engineering in
  // Computer Science"). Only append it when the degree carries no field of its own.
  const education = (resumeData.education || []).map((e) => ({
    degree: [e.degree, e.field && !/\bin\b/i.test(e.degree || '') ? `in ${e.field}` : null]
      .filter(Boolean).join(' '),
    institution: e.institution || '',
    duration: e.duration || '',
    score: e.score || '',
  }));

  return {
    name: info.name || '',
    tagline,
    contact: [info.location, info.email, info.phone].filter(Boolean).join(' | '),
    links,
    summary: aiResponse.summary || '',
    skillRows,
    experiences,
    projects,
    education,
  };
}

// ── Trim ladder ──
// Applied cumulatively, and only once shrinking has bottomed out at K_MIN.
// Ordered by what a reader loses least: extra personal projects first, then the
// depth of old roles, then the old roles themselves.
const TRIMS = [
  (m) => { m.projects = m.projects.slice(0, 3); },
  (m) => { m.experiences.forEach((e) => { if (!e.isCurrent) e.bullets = e.bullets.slice(0, 2); }); },
  (m) => { m.projects = m.projects.slice(0, 2); },
  (m) => { m.experiences = m.experiences.filter((e, i) => e.isCurrent || i < 2); },
  (m) => { m.experiences.forEach((e) => { if (!e.isCurrent) e.bullets = []; }); },
  // `isCurrent` is optional in stored resumes. Without the guard this level
  // deletes the whole EXPERIENCE section when no role carries the flag —
  // a resume with no jobs on it is worse than a two-page one.
  (m) => {
    if (m.experiences.some((e) => e.isCurrent)) m.experiences = m.experiences.filter((e) => e.isCurrent);
    else m.experiences = m.experiences.slice(0, 1);
  },
];

export function trimModel(model, level) {
  const m = {
    ...model,
    experiences: model.experiences.map((e) => ({ ...e, bullets: [...e.bullets] })),
    projects: [...model.projects],
  };
  for (let i = 0; i < level && i < TRIMS.length; i++) TRIMS[i](m);
  return m;
}

// ── Template ──

const CSS = `
  @page { size: A4; margin: ${MARGIN.top}mm ${MARGIN.right}mm ${MARGIN.bottom}mm ${MARGIN.left}mm; }
  :root { --k: 1; font-size: calc(9.4pt * var(--k)); }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Carlito, Calibri, "Noto Sans", "Liberation Sans", Arial, sans-serif;
    font-size: 1rem; line-height: 1.34; color: #1a1a1a;
  }
  a { color: inherit; text-decoration: none; }
  .name { text-align: center; font-size: 2.1rem; font-weight: 700; letter-spacing: .055em; margin: 0 0 .12rem; }
  .tag { text-align: center; font-size: .88rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #333; margin: 0 0 .25rem; }
  .contact, .links { text-align: center; font-size: .89rem; color: #333; margin: 0; line-height: 1.4; }
  .links { margin-top: .06rem; }
  h2 { font-size: .97rem; font-weight: 700; letter-spacing: .12em; margin: .72rem 0 .26rem;
       padding-bottom: .16rem; border-bottom: 1px solid #b9b9b9; }
  p { margin: 0 0 .18rem; text-align: justify; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: .8rem; }
  .row .l { font-weight: 700; }
  .row .r { color: #555; font-size: .92rem; white-space: nowrap; }
  .loc { font-style: italic; color: #555; font-size: .9rem; margin: 0 0 .1rem; }
  ul { margin: .16rem 0 .34rem; padding-left: 1.05rem; }
  li { margin: 0 0 .13rem; text-align: justify; }
  li::marker { font-size: .75rem; color: #444; }
  .skill { margin: 0 0 .1rem; text-align: left; }
  .proj, .edu { margin: 0 0 .22rem; }
  .job + .job { margin-top: .3rem; }
`;

function renderSection(title, body) {
  return body ? `<h2>${title}</h2>${body}` : '';
}

/**
 * @returns {string} a complete standalone HTML document for the resume.
 */
export function buildResumeHtml(aiResponse, resumeData, opts = {}) {
  const model = opts.model || buildResumeModel(aiResponse, resumeData);
  const termRx = buildTermRegex(aiResponse.skills);
  const used = new Set();
  const b = (t) => boldify(t, termRx, used);

  // Order matters: each term is highlighted at its first occurrence only, so the
  // summary has to claim its terms before the bullets consume them.
  const summaryHtml = model.summary ? `<p>${b(model.summary)}</p>` : '';

  const header = `
<div class="name">${esc(model.name).toUpperCase()}</div>
<div class="tag">${esc(model.tagline)}</div>
<div class="contact">${esc(model.contact)}</div>
${model.links.length
    ? `<div class="links">${model.links
        .map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`)
        .join(' | ')}</div>`
    : ''}`;

  const skills = model.skillRows
    .map((r) => `<p class="skill"><b>${esc(r.label)}:</b> ${esc(r.skills.join(', '))}</p>`)
    .join('');

  const experience = model.experiences
    .map((e) => `<div class="job">
<div class="row"><span class="l">${esc([e.title, e.company].filter(Boolean).join(' — '))}</span><span class="r">${esc(e.duration)}</span></div>
${e.location ? `<div class="loc">${esc(e.location)}</div>` : ''}
${e.bullets.length ? `<ul>${e.bullets.map((t) => `<li>${b(t)}</li>`).join('')}</ul>` : ''}
</div>`)
    .join('');

  const projects = model.projects
    .map((p) => `<p class="proj"><b>${esc(p.name)}</b> — ${b(p.description)}</p>`)
    .join('');

  const education = model.education
    .map((e) => `<div class="edu row"><span class="l">${esc(
      [[e.degree, e.institution].filter(Boolean).join(' — '), e.score ? `(${e.score})` : '']
        .filter(Boolean).join(' '),
    )}</span><span class="r">${esc(e.duration)}</span></div>`)
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(model.name)} — ${esc(aiResponse.title || 'Resume')}</title>
<style>${CSS}</style></head>
<body>
${header}
${renderSection('SUMMARY', summaryHtml)}
${renderSection('SKILLS', skills)}
${renderSection('EXPERIENCE', experience)}
${renderSection('PROJECTS', projects)}
${renderSection('EDUCATION', education)}
</body></html>`;
}

// ── Chrome ──

function findChrome() {
  const isWin = process.platform === 'win32';
  const candidates = [
    process.env.CHROME_PATH,
    'google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  // execFileSync, not execSync: CHROME_PATH is interpolated into the command,
  // and a shell would run $(…) inside it. Verified executable before this
  // changed. No shell is involved now, so the value is only ever a path.
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'pipe' });
      if (!c.includes('/') && !c.includes('\\')) {
        const resolved = execFileSync(isWin ? 'where' : 'which', [c], {
          stdio: 'pipe', encoding: 'utf-8',
        }).trim().split('\n')[0];
        if (resolved) return resolved;
      }
      return c;
    } catch { /* try next */ }
  }
  return null;
}

/** Whether the one-page HTML path can run at all (Chrome + puppeteer-core). */
export async function checkHtmlRenderer() {
  try {
    await import('puppeteer-core');
    return !!findChrome();
  } catch {
    return false;
  }
}

// ── Browser pool ──
//
// Batch tailoring runs 15 jobs at once (`startBatch` concurrency), so a
// browser-per-render meant 15 simultaneous Chrome launches. Measured: 15
// concurrent renders took 85 s, against 1.6 s each when uncontended — a ~35x
// degradation, plus the memory of 15 full browsers on the operator's laptop.
//
// One shared browser, with pages capped, fixes both. The model calls are still
// the batch's real cost (~20 s each, 15 in flight); rendering just has to stop
// fighting them for CPU.

const MAX_PAGES = 4;
const IDLE_CLOSE_MS = 60_000;

let _browser = null;
let _launching = null;
let _idleTimer = null;
let _activePages = 0;
const _waiting = [];

/** The shared browser, launched on first use and re-launched if it ever dies. */
async function acquireBrowser() {
  if (_browser?.connected) return _browser;
  if (!_launching) {
    _launching = (async () => {
      const puppeteer = await import('puppeteer-core');
      const chromePath = findChrome();
      if (!chromePath) throw new Error('Chrome/Chromium not found for one-page PDF rendering');
      const browser = await puppeteer.default.launch({
        executablePath: chromePath,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
      });
      // A crashed browser must not be handed to the next render.
      browser.on('disconnected', () => { if (_browser === browser) _browser = null; });
      _browser = browser;
      return browser;
    })().finally(() => { _launching = null; });
  }
  return _launching;
}

const acquirePage = () => {
  // Disarm first: the timer is armed while idle, and a render that starts just
  // before it fires would otherwise have the browser closed underneath it.
  // Measured: 120 renders straddling the deadline lost exactly MAX_PAGES of
  // them, and the failure is silent — render-resume.js falls back to DOCX.
  clearTimeout(_idleTimer);
  _idleTimer = null;
  return _activePages < MAX_PAGES
    ? (_activePages++, Promise.resolve())
    : new Promise((resolve) => _waiting.push(resolve));
};

function releasePage() {
  const next = _waiting.shift();
  if (next) next(); // hand the slot straight over — _activePages is unchanged
  else _activePages--;
}

/**
 * Close the shared browser once nothing has rendered for a while, so a server
 * that tailors one resume an hour isn't holding Chrome open all day. The timer
 * is unref'd, but note that alone does NOT let a short-lived process exit — the
 * pooled browser's own connection is a ref'd handle, so anything that renders
 * and then wants to exit must await closeRenderer() (the tests do).
 */
function scheduleIdleClose() {
  clearTimeout(_idleTimer);
  if (_activePages > 0) return;
  _idleTimer = setTimeout(() => {
    if (_activePages > 0) return;   // a render started while we were waiting
    const browser = _browser;
    _browser = null;
    browser?.close().catch(() => {});
  }, IDLE_CLOSE_MS);
  _idleTimer.unref?.();
}

/** Shut the shared browser down now. For tests and explicit shutdown paths. */
export async function closeRenderer() {
  clearTimeout(_idleTimer);
  const browser = _browser;
  _browser = null;
  if (browser) await browser.close().catch(() => {});
}

/**
 * Chrome writes an uncompressed page tree, so /Type /Page is countable.
 *
 * `page.pdf()` resolves to a Uint8Array, NOT a Buffer, and
 * `Uint8Array.prototype.toString('latin1')` ignores its argument — it returns
 * "37,80,68,70,…". The regex therefore never matched, this always returned the
 * fallback 1, and with it went the retry loop, the overflow warning and the
 * page count reported to the UI. Measured: a genuinely 2-page render logged
 * "✅ PDF saved (1 page)". Wrap before decoding.
 */
function countPdfPages(buffer) {
  const matches = Buffer.from(buffer).toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 1;
}

/**
 * Render the tailored resume to a single-page PDF.
 *
 * @param {object} aiResponse - the tailored payload (title/summary/bullets/skills/…)
 * @param {object} resumeData - the candidate's stored resume
 * @param {string} pdfPath - destination
 * @returns {Promise<{path: string, scale: number, pages: number, trimLevel: number}>}
 */
export async function renderResumePdf(aiResponse, resumeData, pdfPath) {
  console.log('📄 Rendering one-page resume (HTML → PDF)...');
  const baseModel = buildResumeModel(aiResponse, resumeData);

  await acquirePage();
  let page;
  try {
    const browser = await acquireBrowser();
    page = await browser.newPage();
    await page.emulateMediaType('print'); // measure the layout Chrome will print
    await page.setViewport({ width: CONTENT_W, height: CONTENT_H });

    const heightAt = (k) =>
      page.evaluate((kk) => {
        document.documentElement.style.setProperty('--k', String(kk));
        void document.body.offsetHeight; // force reflow before measuring
        return document.body.scrollHeight;
      }, k);

    let scale = K_MIN;
    let trimLevel = 0;

    for (; trimLevel <= TRIMS.length; trimLevel++) {
      const html = buildResumeHtml(aiResponse, resumeData, {
        model: trimModel(baseModel, trimLevel),
      });
      await page.setContent(html, { waitUntil: 'load' });

      const limit = CONTENT_H * FIT_SLACK;
      if ((await heightAt(K_MIN)) > limit) continue; // still too tall — trim more

      // Largest multiplier that still fits. 7 halvings of a 0.34 range lands
      // inside 0.003, far below a visible difference.
      let lo = K_MIN;
      let hi = K_MAX;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        if ((await heightAt(mid)) <= limit) lo = mid;
        else hi = mid;
      }
      scale = lo;
      break;
    }
    trimLevel = Math.min(trimLevel, TRIMS.length);

    const pdfOptions = {
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: `${MARGIN.top}mm`, bottom: `${MARGIN.bottom}mm`,
        left: `${MARGIN.left}mm`, right: `${MARGIN.right}mm`,
      },
    };

    // Screen measurement and print pagination agree to within a rounding error,
    // but "within a rounding error" is exactly how a 3-line overflow onto page 2
    // happens. Confirm against the real artifact and step down if it spilled.
    let buffer;
    let pages = 1;
    for (let attempt = 0; attempt < 4; attempt++) {
      await heightAt(scale);
      buffer = await page.pdf(pdfOptions);
      pages = countPdfPages(buffer);
      if (pages <= 1) break;
      // Floor at K_MIN, not below it. This loop had never executed, so the old
      // K_MIN * 0.94 bound was never measured; K_MIN is the documented readable
      // minimum and silently printing under it to force one page trades a
      // promise the page makes to the reader. If it still spills we warn.
      if (scale <= K_MIN) break;
      scale = Math.max(K_MIN, scale * 0.96);
    }

    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, buffer);

    console.log(
      `✅ PDF saved: ${pdfPath} (${pages} page${pages === 1 ? '' : 's'}, ` +
      `scale ${scale.toFixed(3)}${trimLevel ? `, trim level ${trimLevel}` : ''})`,
    );
    if (pages > 1) {
      console.warn('⚠️  Resume still exceeds one page after shrinking and trimming');
    }

    return { path: pdfPath, scale, pages, trimLevel };
  } finally {
    if (page) await page.close().catch(() => {});
    releasePage();
    scheduleIdleClose();
  }
}

export default {
  buildResumeHtml, buildResumeModel, trimModel,
  renderResumePdf, checkHtmlRenderer, closeRenderer,
};
