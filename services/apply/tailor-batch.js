/**
 * Batch tailoring for the apply queue.
 *
 * This is not a second tailoring engine — it is a loop around the existing one.
 * Every job goes through the same `provider.tailorResume()` → `renderResume()`
 * → `convertToPdf()` → `saveVariant()` path that `/api/generate` uses for a
 * single pasted JD. The only things added here are:
 *
 *   - the JD comes from `job_tracker.jobText` instead of a textarea,
 *   - PDFs land in the resume outbox (`<OUTPUT_DIR>/a-tailored-resumes/<Company>/`,
 *     see OUT_ROOT) so the existing retire/reorder machinery applies to them,
 *   - the saved variant carries `jobId`/`jobLink`, which is what lets the apply
 *     page show a per-row ATS score and open the tailored content.
 *
 * Runs are in-process and tracked in `runs` below so the UI can poll progress;
 * nothing about a batch is persisted except the variants themselves, which are
 * the actual product.
 */

import fs from 'fs';
import path from 'path';
import config from '../../config.js';
import { getProvider } from '../providers/registry.js';
import { generateDocx } from '../pipeline/document.js';
import { convertToPdf, cleanupDocx, checkLibreOffice } from '../pipeline/converter.js';
import { renderResume, htmlRendererAvailable } from '../pipeline/render-resume.js';
import { getUser, saveVariant } from '../resume-store.js';
import { col } from '../db.js';
import { listJobs } from './job-store.js';
import { resumeRoots, listCompanies, findResume } from './resume-outbox.js';

// The scorer divides by the keyword count the analysis step found. When a model
// returns an empty keyword list that division yields NaN, which serialises to
// null in JSON but survives as NaN in-process — so normalise at every read.
const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * DOCX→PDF runs one at a time, no matter how many jobs are tailoring at once.
 *
 * The two halves of a job have opposite shapes: the model call is ~20 s of
 * waiting on the network and wants to be wide, while the conversion is ~1.5 s
 * of local CPU and wants to be narrow. Serialising the cheap half costs
 * essentially nothing — 15 conversions queue through in the time a single model
 * call takes — and it removes every LibreOffice concurrency failure at once
 * (shared profile lock, memory spikes from N soffice processes).
 *
 * Failures do not break the chain: the next conversion runs regardless.
 */
let conversionChain = Promise.resolve();

function queueConversion(fn) {
  const result = conversionChain.then(fn, fn);
  conversionChain = result.then(() => {}, () => {});
  return result;
}

/**
 * Where the outbox helpers expect to find generated resumes: the tailor's
 * output directory (OUTPUT_DIR in .env, `./output` by default) plus the
 * `a-tailored-resumes` root that resume-outbox.js scans for.
 */
export const OUT_ROOT = path.join(config.paths.outputDir, 'a-tailored-resumes');

const sanitize = (s) => String(s ?? '').replace(/[<>:"/\\|?*]/g, '').trim();

/**
 * Where this company's resume belongs.
 *
 * Not simply `OUT_ROOT/<company>`: once the operator has hit "Order resume
 * folders", the folders carry an `NN__` sort prefix. Writing a bare company
 * name then creates a SECOND, unprefixed folder alongside the numbered one and
 * quietly breaks the ordering the operator just set up. So ask the outbox what
 * folder this company already has — it owns the prefix convention — and only
 * mint a new one when there is none.
 */
function companyDir(company) {
  const want = sanitize(company).toLowerCase();
  if (!want) return path.join(OUT_ROOT, 'Unknown');
  try {
    for (const entry of listCompanies(resumeRoots())) {
      if (entry.company.toLowerCase() === want) return entry.dir;
    }
  } catch { /* no roots yet — fall through and create one */ }
  return path.join(OUT_ROOT, sanitize(company));
}

/**
 * Pending jobs for a user that don't have a tailored resume yet.
 *
 * "Yet" needs BOTH a `resume_variants` doc and the PDF still on disk.
 *
 * The variant doc alone used to be the whole test, on the reasoning that the
 * outbox deletes folders as jobs get applied to and a deleted folder shouldn't
 * make a job look untailored. That reasoning only holds for jobs that have
 * MOVED ON: `retireForJob` fires solely on `applied` / `rejected`. A job still
 * sitting in `pending` should therefore still have its file, so a missing one
 * means the operator deleted it, or generation died after the doc was written.
 * Either way the honest answer is "not tailored" — and treating the doc as
 * proof made that unrecoverable, because the flag suppressed every retry.
 *
 * Scoping the disk check to pending is what keeps both behaviours: applied and
 * rejected jobs keep their badge with no file, exactly as before.
 */
export async function pendingWithoutResume(username, { limit = 200 } = {}) {
  const rows = await listJobs({ user: null, statusUser: username, status: 'pending', limit });
  const jobs = Array.isArray(rows) ? rows : (rows.jobs || rows.rows || []);
  const live = await tailoredJobIds(username, { requireFile: true });
  return jobs.filter((j) => j.jobId && !live.has(j.jobId));
}

/**
 * jobIds this user already has a tailored variant for.
 * @param {object} [opts]
 * @param {boolean} [opts.requireFile] also require the PDF to exist on disk,
 *   resolved live so a renumbered outbox folder doesn't read as a missing file.
 */
export async function tailoredJobIds(username, { requireFile = false } = {}) {
  const c = await col('resume_variants');
  if (!requireFile) {
    const ids = await c.distinct('jobId', { username, jobId: { $ne: null } });
    return new Set(ids.filter(Boolean));
  }
  const docs = await c
    .find({ username, jobId: { $ne: null } }, { projection: { jobId: 1, jobCompany: 1, pdfPath: 1, generatedAt: 1 } })
    .sort({ generatedAt: -1 })
    .toArray();
  const out = new Set();
  const seen = new Set();
  for (const d of docs) {
    // Newest variant per job wins — an older one whose file is long gone must
    // not veto a fresh regeneration.
    if (seen.has(d.jobId)) continue;
    seen.add(d.jobId);
    if (livePdfPath(d)) out.add(d.jobId);
  }
  return out;
}

/**
 * Every tailored variant for a user, keyed by jobId — the apply page's score
 * badges and content viewer read this. `aiResponse` is excluded: it is large
 * and only needed when a single resume is opened.
 */
export async function resultsByJobId(username) {
  const c = await col('resume_variants');
  const docs = await c
    .find(
      { username, jobId: { $ne: null } },
      { projection: { 'pdf.data': 0, jobDescription: 0, aiResponse: 0, resumeJson: 0 } },
    )
    .sort({ generatedAt: -1 })
    .toArray();

  const byJob = {};
  for (const d of docs) {
    // Sorted newest-first, so the first hit for a jobId is the current one.
    if (byJob[d.jobId]) continue;
    byJob[d.jobId] = {
      variantId: String(d._id),
      jobId: d.jobId,
      jobTitle: d.jobTitle,
      jobCompany: d.jobCompany,
      atsScore: num(d.atsScore?.overallScore),
      keywordExact: num(d.atsScore?.keywordExact),
      hardReject: d.atsScore?.hardReject ?? null,
      model: d.modelLabel || null,
      provider: d.provider || null,
      mode: d.mode || null,
      generatedAt: d.generatedAt,
      pdfName: d.pdf?.filename || null,
      // Resolved live, not the stored string: reordering the outbox renumbers
      // every folder. Null here means the file is genuinely gone — either
      // retired on apply/reject, or deleted by hand.
      pdfPath: livePdfPath(d),
      hasLocalPdf: !!livePdfPath(d),
    };
  }
  return byJob;
}

/**
 * Where this variant's PDF actually is right now, or null once retired.
 * `pdfPath` on the doc records where it was written; the outbox may have
 * renumbered the folder since.
 */
function livePdfPath(d) {
  if (!d?.pdfPath) return null;
  return findResume(d.jobCompany, path.basename(d.pdfPath));
}

/** Full content for one variant, for the in-page viewer. */
export async function variantContent(username, variantId) {
  const { ObjectId } = await import('mongodb');
  const c = await col('resume_variants');
  let _id;
  try { _id = new ObjectId(variantId); } catch { return null; }
  const d = await c.findOne({ _id, username }, { projection: { 'pdf.data': 0, jobDescription: 0 } });
  if (!d) return null;

  const ai = d.aiResponse || {};
  const projects = (d.resumeJson?.projects || []).map((p) => ({ name: p.name, description: p.description }));
  return {
    variantId: String(d._id),
    jobId: d.jobId || null,
    jobLink: d.jobLink || null,
    company: d.jobCompany,
    role: d.jobTitle,
    model: d.modelLabel,
    provider: d.provider,
    mode: d.mode,
    generatedAt: d.generatedAt,
    atsScore: d.atsScore || null,
    title: ai.title || '',
    summary: ai.summary || '',
    skills: ai.skills || '',
    bullets: ai.bullets || [],
    projects,
    pdfName: d.pdf?.filename || null,
    // Batch variants keep their PDF on disk rather than in Mongo, so the viewer
    // needs to know whether the file is still there — the outbox deletes it as
    // soon as the job is applied to or rejected.
    // Resolved live, not read from the stored path: ordering the queue renames
    // every folder and would otherwise break every link.
    pdfPath: livePdfPath(d),
    hasLocalPdf: !!livePdfPath(d),
  };
}

// ── run tracking ─────────────────────────────────────────────────────────────
// A batch of 30 resumes takes minutes; the browser can't hold a request open
// that long and reloading the page shouldn't kill the run. So runs live here
// and the UI polls. Only the most recent few are kept.

const runs = new Map();
let runSeq = 0;

export const getRun = (id) => runs.get(id) || null;
export const latestRun = () => [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || null;

function newRun(total, model, provider) {
  const id = `run-${Date.now()}-${++runSeq}`;
  const run = {
    id,
    status: 'running',
    total,
    done: 0,
    ok: 0,
    failed: 0,
    model,
    provider,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    items: [],
    error: null,
  };
  runs.set(id, run);
  for (const old of [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(5)) {
    runs.delete(old.id);
  }
  return run;
}

// ── one job ──────────────────────────────────────────────────────────────────

async function tailorJob({ job, username, resumeData, provider, providerName, modelLabel, mode, hasLibre }) {
  const jobDescription = job.jobText || job.description || '';
  if (jobDescription.trim().length < 200) {
    throw new Error(`job text is only ${jobDescription.trim().length} chars — rescan the job first`);
  }

  const aiResponse = await provider.tailorResume(jobDescription, resumeData, { mode });

  const dir = companyDir(job.company);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${sanitize(resumeData.personalInfo?.name) || 'Resume'} - ${sanitize(job.title).slice(0, 60)}`;
  const docxPath = path.join(dir, `${base}.docx`);
  const pdfPath = path.join(dir, `${base}.pdf`);

  // The HTML renderer shares one pooled Chrome across the whole batch and caps
  // its own page concurrency, so it needs no queue here. Only the LibreOffice
  // fallback does — soffice must run one at a time (shared profile lock).
  let outputPath;
  if (await htmlRendererAvailable()) {
    outputPath = (await renderResume(aiResponse, resumeData, { docx: docxPath, pdf: pdfPath })).path;
  } else {
    outputPath = docxPath;
    await generateDocx(aiResponse, { docx: docxPath, pdf: pdfPath }, resumeData);
    if (hasLibre) {
      outputPath = await queueConversion(() => convertToPdf(docxPath, pdfPath));
      cleanupDocx(docxPath);
    }
  }

  // Same editable bundle shape `/api/generate` persists, so a batch-generated
  // variant round-trips through /api/regenerate-from-json like any other.
  const personalProjects = (resumeData.projects || []).map((p) => ({
    name: p.name,
    description: aiResponse[p.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()] || '',
  }));
  const resumeJson = {
    personalInfo: resumeData.personalInfo || {},
    meta: resumeData.meta || {},
    title: aiResponse.title || '',
    summary: aiResponse.summary || '',
    skills: aiResponse.skills || '',
    bullets: aiResponse.bullets || [],
    experience: resumeData.experience || [],
    projects: personalProjects,
    education: resumeData.education || [],
  };

  const saved = await saveVariant({
    username,
    jobTitle: job.title || aiResponse.jdTitle || '',
    jobCompany: job.company || aiResponse.jdCompany || '',
    jobDescription,
    aiResponse,
    email: null,
    linkedInDM: null,
    resumeJson,
    pdfPath: outputPath,
    // The PDF lives in the outbox on disk; keep the bytes out of Mongo.
    storePdf: false,
    atsScore: aiResponse.atsScore || null,
    mode: aiResponse.mode || mode,
    modelLabel,
    provider: providerName,
  });

  // `saveVariant` owns the generic variant shape; the job linkage is this
  // module's concern, so it is stamped on afterwards rather than widening that
  // signature for one caller.
  await (await col('resume_variants')).updateOne(
    { _id: saved._id },
    { $set: { jobId: job.jobId, jobLink: job.jobLink || null, pdfPath: outputPath } },
  );

  return {
    variantId: String(saved._id),
    ats: num(aiResponse.atsScore?.overallScore),
    keywordExact: num(aiResponse.atsScore?.keywordExact),
    file: outputPath,
  };
}

// ── the batch ────────────────────────────────────────────────────────────────

/**
 * Tailor a set of apply-queue jobs, in the background.
 *
 * Returns as soon as the run is registered — poll `getRun(id)` for progress.
 *
 * `concurrency` governs the MODEL calls only — each job is two of them at ~20 s
 * apiece, so 15 in flight takes a 34-job batch from ~13 min to ~2. Mantle
 * rate-limits per key and the client already backs off on 429, so going wider
 * degrades into a slower batch rather than a broken one.
 *
 * PDF conversion is deliberately NOT parallel; see `queueConversion` above.
 *
 * @returns {Promise<object>} the run record
 */
export async function startBatch({
  username,
  jobs,
  provider: providerName = 'bedrock',
  model,
  mode = 'strict',
  concurrency = 15,
} = {}) {
  if (!username) throw new Error('startBatch: username required');
  if (!jobs?.length) throw new Error('startBatch: no jobs given');

  const doc = await getUser(username);
  if (!doc?.data) throw new Error(`startBatch: no resume in mongo for "${username}"`);
  // The stored resume is used as-is — `meta.cannotClaim` is the user's own
  // list and is honoured here exactly as `/api/generate` honours it.
  const resumeData = doc.data;

  const provider = await getProvider(providerName, model);
  const modelLabel = provider.getModelLabel?.() || model || null;
  const hasLibre = checkLibreOffice();

  const run = newRun(jobs.length, modelLabel, providerName);
  run.items = jobs.map((j) => ({
    jobId: j.jobId,
    company: j.company,
    role: j.title,
    status: 'queued',
    ats: null,
    variantId: null,
    error: null,
    ms: null,
  }));

  // Fire and forget — the caller gets the run id immediately.
  (async () => {
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const i = cursor++;
        const item = run.items[i];
        item.status = 'running';
        const started = Date.now();
        try {
          const out = await tailorJob({
            job: jobs[i], username, resumeData, provider, providerName, modelLabel, mode, hasLibre,
          });
          Object.assign(item, { status: 'done', ats: out.ats, keywordExact: out.keywordExact, variantId: out.variantId, file: out.file });
          run.ok++;
        } catch (e) {
          Object.assign(item, { status: 'failed', error: e.message.slice(0, 300) });
          run.failed++;
        }
        item.ms = Date.now() - started;
        run.done++;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
      run.status = 'done';
    } catch (e) {
      run.status = 'error';
      run.error = e.message;
    }
    run.finishedAt = new Date().toISOString();
  })();

  return run;
}

export default {
  startBatch, getRun, latestRun, pendingWithoutResume, tailoredJobIds,
  resultsByJobId, variantContent, OUT_ROOT,
};
