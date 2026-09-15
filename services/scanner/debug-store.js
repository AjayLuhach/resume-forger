// Extraction-debug snapshots. The extension sends a `companyInfo.__debug`
// blob with each /analyze call — the raw HTML it scraped, the corpus text it
// regex'd against, what it found / didn't find. Keeping this around makes it
// possible to diagnose "why did employeeCount come back null?" without
// re-loading the LinkedIn page.
//
// Storage: scanner_debug collection, one doc per jobId. Rolling cap of 200
// rows (LRU-by-savedAt) so this never grows unbounded.
import { col } from '../db.js';

// Rolling cap. The original extension capped at 100 (file-based); we run on
// mongo so storage is cheap — 500 covers a comfortable backlog without
// letting the collection grow unbounded.
const MAX_ROWS = 500;

export async function saveDebugSnapshot(jobId, snapshot, extra = {}) {
  if (!jobId || !snapshot) return;
  const c = await col('scanner_debug');
  const now = new Date().toISOString();
  await c.updateOne(
    { jobId: String(jobId) },
    {
      $set: {
        jobId: String(jobId),
        savedAt: now,
        ...extra,
        ...snapshot,
      },
    },
    { upsert: true },
  );
  // Trim oldest above the cap. Cheap because we only run it after a write
  // and the count is bounded.
  const total = await c.estimatedDocumentCount();
  if (total > MAX_ROWS) {
    const excess = total - MAX_ROWS;
    const old = await c.find({}, { projection: { _id: 1 } }).sort({ savedAt: 1 }).limit(excess).toArray();
    if (old.length) await c.deleteMany({ _id: { $in: old.map(d => d._id) } });
  }
}

export async function getDebugSnapshot(jobId) {
  if (!jobId) return null;
  const c = await col('scanner_debug');
  return c.findOne({ jobId: String(jobId) });
}

export async function listDebugSnapshots({ limit = 100 } = {}) {
  const c = await col('scanner_debug');
  // Return lightweight metadata (no big HTML blobs).
  return c.find({}, {
    projection: {
      jobId: 1, url: 1, pageTitle: 1, capturedAt: 1, savedAt: 1,
      aboutSectionFound: 1, aboutTextLength: 1, bodyTextLength: 1,
      'extractedCompanyInfo.companyName': 1,
      'extractedCompanyInfo.employeeCount': 1,
      'extractedCompanyInfo.employeesOnLinkedIn': 1,
    },
  }).sort({ savedAt: -1 }).limit(Math.min(parseInt(limit) || 100, 500)).toArray();
}
