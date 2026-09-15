/**
 * Resume outbox — TEMPORARY helper for the ATS experiment.
 *
 * Tailored resumes are generated per company into
 * `<OUTPUT_DIR>/a-tailored-resumes*<suffix>/<Company>/<Name> - <Role>.pdf`,
 * where OUTPUT_DIR is the tailor's output directory from config.js.
 * While working the apply queue, two chores get tedious by hand:
 *
 *   1. Once a job is applied to or rejected, its resume is dead weight. If it
 *      was the company's only posting, the whole folder is stale.
 *   2. File managers sort alphabetically, but the operator works the queue in
 *      the apply page's current sort order. Numbering the folders to match
 *      that order makes "upload the next one" a top-to-bottom walk.
 *
 * Everything here is confined to directories directly under that output
 * directory whose name starts with `a-tailored-resumes`. Any path that
 * resolves outside one of those roots is refused — these functions delete
 * files, so containment is enforced rather than assumed.
 */

import fs from 'fs';
import path from 'path';
import config from '../../config.js';

// The parent of every outbox root. Same setting the single-JD path writes
// to, so one OUTPUT_DIR in .env moves both.
const OUTBOX_PARENT = config.paths.outputDir;
const ROOT_PREFIX = 'a-tailored-resumes';

// Folders get an `NN__` prefix when the operator reorders them; strip it to
// recover the company name for matching.
const ORDER_PREFIX = /^\d{2,3}__/;
const stripOrder = (name) => name.replace(ORDER_PREFIX, '');

// Same sanitisation the builder applies when it creates the folder/filename,
// so a lookup by raw company/role still matches what is on disk.
const sanitize = (s) => String(s ?? '').replace(/[<>:"/\\|?*]/g, '').trim();

const RESUME_EXT = /\.(pdf|docx)$/i;
const SIDECAR_EXT = /\.(ats|tailoring)\.json$/i;

/** Absolute paths of every resume root that currently exists. */
export function resumeRoots() {
  if (!fs.existsSync(OUTBOX_PARENT)) return [];
  return fs.readdirSync(OUTBOX_PARENT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(ROOT_PREFIX))
    .map((e) => path.join(OUTBOX_PARENT, e.name))
    .sort();
}

/** Throw unless `target` really sits inside one of `roots`. */
function assertContained(target, roots) {
  const resolved = path.resolve(target);
  const ok = roots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
  if (!ok) throw new Error(`refusing to touch a path outside the resume roots: ${resolved}`);
  return resolved;
}

/** Every company folder across the given roots (defaults to all of them). */
export function listCompanies(roots = resumeRoots()) {
  const out = [];
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const files = fs.readdirSync(dir);
      out.push({
        root,
        dir,
        folder: entry.name,
        company: stripOrder(entry.name),
        resumes: files.filter((f) => RESUME_EXT.test(f)),
      });
    }
  }
  return out;
}

/**
 * Current on-disk path for a resume, found by company + file name.
 *
 * Never trust a stored absolute path here. `reorderCompanies` renames every
 * folder to `NN__<Company>`, so a path recorded at generation time is stale the
 * first time the operator orders the queue — measured: all 86 stored paths
 * broke that way. Resolving through `listCompanies` keeps the prefix
 * convention in the one module that owns it.
 *
 * @returns {string|null} the path, or null when the resume has been retired
 */
export function findResume(company, filename, roots = resumeRoots()) {
  const wanted = sanitize(company).toLowerCase();
  const base = String(filename || '').trim();
  if (!wanted || !base) return null;
  for (const entry of listCompanies(roots)) {
    if (stripOrder(entry.folder).toLowerCase() !== wanted) continue;
    const p = path.join(entry.dir, base);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Retire the resume for one job.
 *
 * Deletes that role's resume (plus its sidecars). If the company has no
 * resumes left afterwards — i.e. this was its only posting — the folder goes
 * too. When `role` is omitted, the whole company folder is retired.
 *
 * @param {{company: string, role?: string}} job
 * @returns {{removedFiles: string[], removedDirs: string[]}}
 */
export function retireResume({ company, role }, roots = resumeRoots()) {
  const wanted = sanitize(company).toLowerCase();
  if (!wanted) return { removedFiles: [], removedDirs: [] };

  const removedFiles = [];
  const removedDirs = [];

  for (const entry of listCompanies(roots)) {
    if (stripOrder(entry.folder).toLowerCase() !== wanted) continue;

    const roleKey = sanitize(role).toLowerCase();
    const all = fs.readdirSync(entry.dir);
    // Without a role, or when this is the company's only resume, take the
    // whole folder. Otherwise remove just this role's files and leave the
    // company's other postings alone.
    const takeAll = !roleKey || entry.resumes.length <= 1;
    const doomed = takeAll
      ? all
      : all.filter((f) => (RESUME_EXT.test(f) || SIDECAR_EXT.test(f)) && f.toLowerCase().includes(roleKey));

    for (const f of doomed) {
      const p = assertContained(path.join(entry.dir, f), roots);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) { fs.unlinkSync(p); removedFiles.push(p); }
    }

    // Drop the folder once nothing worth keeping is left in it.
    const left = fs.existsSync(entry.dir) ? fs.readdirSync(entry.dir) : [];
    if (!left.some((f) => RESUME_EXT.test(f))) {
      const dir = assertContained(entry.dir, roots);
      fs.rmSync(dir, { recursive: true, force: true });
      removedDirs.push(dir);
    }
  }

  return { removedFiles, removedDirs };
}

/**
 * Renumber company folders so a file manager's alphabetical listing matches
 * the order the operator is working the queue in.
 *
 * Idempotent: existing `NN__` prefixes are stripped before renumbering, so
 * reordering repeatedly never stacks prefixes. Companies not present in
 * `orderedCompanies` keep their name with no prefix, sorting after the
 * numbered ones.
 *
 * @param {string[]} orderedCompanies - company names, in the desired order
 * @returns {{renamed: Array<{from: string, to: string}>, cleared: number}}
 */
export function reorderCompanies(orderedCompanies, roots = resumeRoots()) {
  const rank = new Map();
  orderedCompanies.forEach((c, i) => {
    const key = sanitize(c).toLowerCase();
    if (key && !rank.has(key)) rank.set(key, i + 1);
  });
  const width = Math.max(2, String(orderedCompanies.length).length);

  const renamed = [];
  let cleared = 0;

  for (const entry of listCompanies(roots)) {
    const company = stripOrder(entry.folder);
    const position = rank.get(company.toLowerCase());
    const target = position
      ? `${String(position).padStart(width, '0')}__${company}`
      : company;
    if (target === entry.folder) continue;

    const from = assertContained(entry.dir, roots);
    const to = assertContained(path.join(entry.root, target), roots);
    if (fs.existsSync(to)) continue; // never clobber an existing folder
    fs.renameSync(from, to);
    renamed.push({ from: entry.folder, to: target });
    if (!position) cleared++;
  }

  return { renamed, cleared };
}

/**
 * Retire the resume for a job whose status just changed.
 *
 * Called from the server rather than the browser: status changes arrive from
 * BOTH the apply page and the in-page scanner extension, and hooking only the
 * page's click handler silently missed everything the extension did.
 *
 * @param {object} doc - hydrated job_tracker row (needs company + title)
 * @param {string} status - the status just applied
 * @returns {{removedFiles: string[], removedDirs: string[]} | null}
 */
export function retireForJob(doc, status, roots = resumeRoots()) {
  if (status !== 'applied' && status !== 'rejected') return null;
  if (!doc?.company) return null;
  try {
    return retireResume({ company: doc.company, role: doc.title }, roots);
  } catch {
    return null; // housekeeping must never fail the status change
  }
}

/**
 * Sweep resumes that no longer have a live job behind them.
 *
 * Catches up after the fact — jobs marked applied or rejected while the
 * server-side hook wasn't running still have resumes sitting on disk. Anything
 * whose company has no remaining pending job is retired.
 *
 * `roots` is REQUIRED and has no default: this sweep deletes every company
 * folder NOT on the keep-list, so an implicit "all roots" scope makes an
 * accidental caller (a test, a misconfigured script) wipe real resumes. It did
 * exactly that once. Callers must name the roots they mean.
 *
 * @param {Array<{company: string, title: string}>} pendingJobs - the jobs still open
 * @param {string[]} roots - resume roots to sweep
 * @returns {{removedFiles: string[], removedDirs: string[], kept: string[]}}
 */
export function reconcile(pendingJobs, roots) {
  if (!Array.isArray(roots)) {
    throw new Error('reconcile(pendingJobs, roots): roots must be given explicitly');
  }
  const live = new Set(
    (pendingJobs || [])
      .map((j) => sanitize(j.company).toLowerCase())
      .filter(Boolean),
  );

  const removedFiles = [];
  const removedDirs = [];
  const kept = [];

  for (const entry of listCompanies(roots)) {
    const company = stripOrder(entry.folder);
    if (live.has(company.toLowerCase())) { kept.push(company); continue; }
    const out = retireResume({ company });
    removedFiles.push(...out.removedFiles);
    removedDirs.push(...out.removedDirs);
  }

  return { removedFiles, removedDirs, kept };
}

export default { resumeRoots, listCompanies, findResume, retireResume, reorderCompanies, retireForJob, reconcile };
