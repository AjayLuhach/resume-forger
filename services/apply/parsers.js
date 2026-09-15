// Job-source parsers — pure, content-string in, jobs[] out. No I/O.
// Ported verbatim from the original apply repo:
//   - extractlinkdelnData.js → extractJobsFromVoyager  (V1, Voyager API JSON)
//   - extractLinkedinV2.js   → extractJobsFromRSC      (V2, RSC stream text)
//   - naukri/extractNaukriData.js → extractJobsFromNaukri
// Unified behind a single detectAndParse so callers don't need to know
// which shape they have.

import log from '../log.js';

const normalize = (text) =>
  typeof text === 'string'
    ? text.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
    : '';

// Voyager search-applied-jobs payload uses an "Applied" insight string —
// pull it out so we can record which jobs the user actually clicked apply on.
const findAppliedText = (entry) => {
  const insights = entry?.insightsResolutionResults;
  if (!Array.isArray(insights)) return null;
  for (const insight of insights) {
    const text = insight?.simpleInsight?.title?.text;
    if (typeof text === 'string' && text.toLowerCase().startsWith('applied')) {
      return text;
    }
  }
  return null;
};

// ── LinkedIn RSC stream (the format apply's V2 parser handled) ────────────
// Looks for the embedded job rows in the React Server Components payload.
export const extractJobsFromRSC = (rawText) => {
  const re =
    /"jobId":"(\d+)","jobTitle":"([^"]+)","companyLogoUrl":"[^"]*","companyName":"([^"]+)","isVerified":[^,]+,"existingNote":"[^"]*","listedAt":"[^"]*","originallyListedAt":"[^"]*","locationPrimary":"([^"]*)","workplaceTypeName":"([^"]*)","isOnsite":[^,]+,"currentStageKey":"([^"]*)"/g;
  const seen = new Set();
  const jobs = [];
  let m;
  while ((m = re.exec(rawText)) !== null) {
    const [, jobId, jobTitle, companyName, location, , stage] = m;
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    const title = normalize(jobTitle);
    const company = normalize(companyName);
    if (!title && !company) continue;
    jobs.push({
      jobId,
      platform: 'LinkedIn',
      title,
      company,
      location: normalize(location),
      link: `https://www.linkedin.com/jobs/view/${jobId}/`,
      sourceStage: stage || null,
    });
  }
  return jobs;
};

// ── LinkedIn Voyager API JSON ────────────────────────────────────────────
// Verbatim shape from the original apply repo's V1 parser. Voyager's
// "applied jobs" search endpoint returns an `included` array where each
// hit is an EntityResultViewModel with the job summary directly on the
// node — no nested jobPostingResolutionResult. Walking `elements` or
// looking for jobPosting* is the wrong shape entirely.
export const extractJobsFromVoyager = (json) => {
  const included = Array.isArray(json?.included)
    ? json.included
    : (Array.isArray(json) ? json : []);
  const seen = new Set();
  const out = [];
  let nonViewModelCount = 0;
  let viewModelMissingId = 0;

  for (const entry of included) {
    if (entry?.$type !== 'com.linkedin.voyager.dash.search.EntityResultViewModel') {
      nonViewModelCount++;
      continue;
    }
    const trackingUrn = entry.trackingUrn || '';
    const jobMatch = trackingUrn.match(/jobPosting:(\d+)/);
    if (!jobMatch) { viewModelMissingId++; continue; }
    const jobId = jobMatch[1];
    const link = `https://www.linkedin.com/jobs/view/${jobId}/`;
    if (seen.has(link)) continue;
    seen.add(link);

    const title    = normalize(entry?.title?.text);
    const company  = normalize(entry?.primarySubtitle?.text);
    const location = normalize(entry?.secondarySubtitle?.text);
    if (!title && !company) continue;

    out.push({
      jobId,
      platform: 'LinkedIn',
      title,
      company,
      location,
      link,
      sourceStage: findAppliedText(entry),
    });
  }

  if (out.length === 0) {
    // Diagnostics: tell the operator WHY we found nothing instead of just
    // returning the bland "no recognizable entries" error.
    log.warn('parser:voyager',
      `0 jobs extracted from Voyager JSON.`,
      `included entries: ${included.length},`,
      `non-EntityResultViewModel: ${nonViewModelCount},`,
      `EntityResultViewModel without jobPosting urn: ${viewModelMissingId}.`,
      `top-level keys: [${Object.keys(json || {}).slice(0, 8).join(', ')}].`,
      included.length
        ? `sample $type values: [${[...new Set(included.slice(0, 8).map(e => e?.$type))].join(', ')}]`
        : '',
    );
  } else {
    log.ok('parser:voyager', `extracted ${out.length} jobs from Voyager included[].`);
  }
  return out;
};

// ── Naukri payload — applyDetails[] with jobId / company / jobTitle ──────
export const extractJobsFromNaukri = (json) => {
  const out = [];
  const apps = json?.applyDetails || (Array.isArray(json) ? json : []);
  for (const a of apps) {
    const jobId = String(a.jobId || a.id || '');
    if (!jobId) continue;
    const applied = (a.status || []).find((s) => s.statusValue === 'Applied');
    if (!applied) continue;
    out.push({
      jobId,
      platform: 'Naukri',
      title: normalize(a.jobTitle),
      company: normalize(a.company),
      location: normalize(a.location),
      link: `https://www.naukri.com/job-listings-${jobId}`,
      sourceStage: 'Applied',
    });
  }
  return out;
};

// ── detectAndParse: figure out the format, dispatch ──────────────────────
// Returns { jobs, format } or { error }.
export const detectAndParse = (raw) => {
  const text = String(raw || '').trim();
  if (!text) {
    log.warn('parser', 'clipboard empty');
    return { error: 'Clipboard is empty' };
  }
  log.info('parser', `input ${text.length} bytes, starts with "${text.slice(0, 30).replace(/\n/g, '\\n')}…"`);

  // JSON?
  if (text.startsWith('{') || text.startsWith('[')) {
    let json;
    try { json = JSON.parse(text); }
    catch (e) {
      log.err('parser', `JSON parse failed: ${e.message}`);
      return { error: 'Looked like JSON but failed to parse' };
    }
    if (json?.applyDetails || (Array.isArray(json) && json[0]?.jobTitle && json[0]?.company)) {
      const jobs = extractJobsFromNaukri(json);
      log.ok('parser:naukri', `${jobs.length} jobs`);
      return jobs.length ? { jobs, format: 'naukri' } : { error: 'Naukri JSON had no Applied entries' };
    }
    const jobs = extractJobsFromVoyager(json);
    if (jobs.length) return { jobs, format: 'voyager' };
    return { error: 'JSON parsed but no recognizable job entries — see server logs for diagnostic.' };
  }

  // RSC payload — heuristically check for the marker fields used by V2.
  if (text.includes('"jobId":"') && text.includes('"jobTitle":"')) {
    const jobs = extractJobsFromRSC(text);
    log.ok('parser:rsc', `${jobs.length} jobs from RSC stream`);
    return jobs.length ? { jobs, format: 'linkedin-rsc' } : { error: 'RSC stream parsed to 0 jobs' };
  }

  // URL only — return a stub so the user can manually type title/company later.
  const urlMatch = text.match(/https?:\/\/(?:www\.)?(linkedin|naukri)\.com\/(?:jobs\/view\/|job-listings-)([^\/?&\s]+)/i);
  if (urlMatch) {
    const [, platform, idMaybe] = urlMatch;
    log.ok('parser:url', `${platform} ${idMaybe}`);
    return {
      jobs: [{
        jobId: idMaybe,
        platform: platform === 'linkedin' ? 'LinkedIn' : 'Naukri',
        title: '',
        company: '',
        location: '',
        link: text.split(/\s/)[0],
        sourceStage: null,
      }],
      format: 'url-only',
    };
  }

  log.warn('parser', 'content not recognized — no JSON, no RSC markers, no LinkedIn/Naukri URL');
  return { error: 'Clipboard content not recognized (need LinkedIn RSC text, Voyager JSON, Naukri JSON, or a job URL)' };
};
