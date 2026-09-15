// Feed module config — self-contained, no dependency on the tailor's config.js.
// Lives next to the feed code so the feed pipeline can be configured (model,
// AI provider, candidate resume) without touching the tailor's settings.
//
// Identity is never read from env or file. Every caller passes an explicit
// username (the `users.username` doc key — Mongo is the single source of
// truth) into `loadCandidate(username)` to materialize the candidate profile;
// services/users/current.js is how HTTP handlers and CLIs pick that name.
//
// Env vars consumed (non-identity only):
//   AI_PROVIDER          — 'bedrock' (default) or 'gemini'
//   BEDROCK_MODEL_ID     — mantle model id or alias, default 'google.gemma-3-27b-it'
//   BEDROCK_API_KEY      — bearer key for the mantle endpoint (see mantle-client.js)
//   BEDROCK_BASE_URL     — mantle endpoint, default ap-south-1 (Mumbai)
//   GEMINI_API_KEY       — for the (not-yet-migrated) gemini provider
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUser, getFeedResume } from '../resume-store.js';
import { LOGS_DIR } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

// ── Preferences ───────────────────────────────────────────────────────────
// Everything the feed pipeline used to assume about one person's market lives
// here, overridable per user via `feedData.preferences`. The defaults are the
// original deployment's behaviour (India, lakhs per annum, a 6 LPA floor, one
// year of experience headroom), so an existing user sees no change; a new user
// in another market edits the object on /resume.html.
//
//   country          home country; the location filter rejects posts placed
//                    elsewhere. null disables location filtering entirely.
//   currency         ISO code, only used in prompt wording
//   salaryUnit       unit the model normalises salaries into ("LPA", "k/yr"…).
//                    The stored field is still `job.salaryMinLPA` whatever the
//                    unit — the name is historical and the UI filters read it.
//   usdRate          local currency per USD, for "$50/hr"-style conversions
//   minSalary        floor in salaryUnit; null disables the salary checks
//   maxExperienceGap years above the candidate's own a posting may require
//   rejectWalkIn / rejectContract / rejectIntern / rejectStaffing
//                    the deterministic and prompt-side role-type rejections
//   excludeCompanies posts from these companies are skipped (the candidate's
//                    current employer by default — see loadCandidate)
//   noticePeriod     free text used when replying to recruiters; null = omit
export const DEFAULT_PREFERENCES = Object.freeze({
  country: 'India',
  currency: 'INR',
  salaryUnit: 'LPA',
  usdRate: 85,
  minSalary: 6,
  maxExperienceGap: 1,
  rejectWalkIn: true,
  rejectContract: true,
  rejectIntern: true,
  rejectStaffing: true,
  excludeCompanies: [],
  noticePeriod: null,
});

// How prompts name the candidate's role: their actual title, else derived
// from the stack, else a neutral label. Never a hardcoded stack.
export const candidateRole = (candidate) =>
  candidate?.currentTitle
  || (candidate?.stack ? `${candidate.stack} Developer` : 'Software Developer');

// ── Candidate loader ──────────────────────────────────────────────────────
// Feed-specific shape: the keys consumed by extractPhase1 / scoring / email
// drafting. Kept identical to what the original feed-email-extractor config
// produced so the migrated feed code consumes it unchanged.
//
// Accepts either payload the user can store: the feed resume (flat
// `experienceStart` / `stack` / `cannotClaim` / `summary`) or the tailor
// resume, where the same facts sit under `meta` and `professionalSummary`.
// Reading both means a user who only pasted the tailor JSON still gets a
// complete candidate instead of undefined years and an empty cannotClaim.
// The tailor JSON groups skills into buckets ({ frontend: [...], backend:
// [...] }); the feed JSON maps each skill to its aliases ({ 'React.js':
// ['react'] }). Both are objects whose values are arrays of strings, so the
// shape is told by the SOURCE (which document loadCandidate read) with the
// bucket names as the tell for a caller that passes data directly.
const TAILOR_BUCKETS = new Set(['frontend', 'backend', 'toolsdevops', 'databases', 'other']);
const looksBucketed = (skillsMap) => {
  const keys = Object.keys(skillsMap);
  return keys.length > 0 && keys.every((k) => TAILOR_BUCKETS.has(k.toLowerCase()));
};

// { skill: aliases[] } whichever shape came in. A bucketed map is flattened
// — before this, a user who had pasted only the tailor JSON got
// ['frontend', 'backend', 'toolsDevOps', 'other'] as their skills, and every
// prompt, LinkedIn search seed and skill lookup ran on bucket names.
export const skillsMapOf = (skillsMap, { source = null } = {}) => {
  if (!skillsMap || typeof skillsMap !== 'object' || Array.isArray(skillsMap)) return {};
  if (source !== 'tailor' && !(source == null && looksBucketed(skillsMap))) return skillsMap;
  const flat = {};
  for (const v of Object.values(skillsMap)) {
    if (!Array.isArray(v)) continue;
    for (const skill of v) if (typeof skill === 'string' && skill.trim()) flat[skill.trim()] = [];
  }
  return flat;
};

const shapeCandidate = (data, { source = null } = {}) => {
  if (!data) return null;
  const info = data.personalInfo || {};
  const meta = data.meta || {};
  const experienceStart = data.experienceStart ?? meta.experienceStart ?? null;
  const startDate = experienceStart ? new Date(experienceStart) : null;
  const years = startDate && Number.isFinite(startDate.getTime())
    ? ((Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25)).toFixed(1)
    : null;
  const skillsMap = skillsMapOf(data.skills, { source: source ?? (data.meta ? 'tailor' : null) });
  const currentCompany = data.experience?.[0]?.company || '';

  const userPrefs = data.preferences && typeof data.preferences === 'object' && !Array.isArray(data.preferences)
    ? data.preferences
    : {};
  // The candidate's own employer is the one company nobody wants a job ad
  // from. It is the default whenever the stored list is empty — the example
  // JSON ships `excludeCompanies: []`, and README / the editor both promise
  // "if empty, your current employer" — so only a non-empty list overrides.
  const explicitExcludes = Array.isArray(userPrefs.excludeCompanies) && userPrefs.excludeCompanies.length
    ? userPrefs.excludeCompanies
    : null;
  const preferences = {
    ...DEFAULT_PREFERENCES,
    ...userPrefs,
    excludeCompanies: explicitExcludes ?? (currentCompany ? [currentCompany] : []),
  };
  // A dollar market has nothing to convert: unless the user set a rate, USD
  // figures are taken at face value rather than multiplied by the INR default.
  if (String(preferences.currency || '').toUpperCase() === 'USD' && userPrefs.usdRate == null) {
    preferences.usdRate = 1;
  }

  return {
    name: info.name,
    email: info.email,
    phone: info.phone,
    location: info.location,
    linkedin: info.linkedin,
    github: info.github,
    portfolio: info.portfolio,
    leetcode: info.leetcode,
    currentCTC: info.currentCTC || null,
    expectedCTC: info.expectedCTC || null,
    stack: data.stack ?? meta.stack ?? null,
    primaryCloud: data.primaryCloud ?? meta.primaryCloud ?? null,
    experienceStart,
    experience: years ? `${years} years` : null,
    summary: data.summary ?? data.professionalSummary?.default ?? null,
    skills: Object.keys(skillsMap),
    skillsWithAliases: skillsMap,
    projects: data.projects,
    cannotClaim: data.cannotClaim ?? meta.cannotClaim ?? [],
    currentTitle: data.experience?.[0]?.title || 'Software Engineer',
    currentCompany,
    bullets: data.experience?.[0]?.bullets || [],
    preferences,
  };
};

// Load the candidate profile for `username` (the `users.username` doc key).
// Resolution: feedData (authoritative) → tailor `data` (fallback). Throws if
// the user has neither — there is no env or file fallback.
export async function loadCandidate(username) {
  if (!username) throw new Error('loadCandidate: username required');
  const feedDoc = await getFeedResume(username);
  if (feedDoc?.data) return shapeCandidate(feedDoc.data, { source: 'feed' });
  const tailorDoc = await getUser(username);
  if (tailorDoc?.data) return shapeCandidate(tailorDoc.data, { source: 'tailor' });
  throw new Error(`loadCandidate: no resume found in mongo for username "${username}"`);
}

// Exposed for tests: the pure reshaping without a database.
export { shapeCandidate };

// ── Feed config object — shape matches what the original feed code expects ──
const config = {
  // Provider selector. The migrated feed code reads config.aiProvider directly.
  aiProvider: (process.env.AI_PROVIDER || 'bedrock').toLowerCase(),

  // Bedrock (mantle endpoint) — Gemma-by-default for the feed pipeline.
  // Auth is the BEDROCK_API_KEY bearer token, read inside mantle-client.js;
  // no AWS credentials or region are involved (the region is baked into
  // BEDROCK_BASE_URL's hostname).
  bedrock: {
    modelId: process.env.BEDROCK_MODEL_ID || 'google.gemma-3-27b-it',
  },

  // Gemini (provider not migrated yet but the config is here for parity).
  ai: {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    models: [
      'gemini-2.5-pro',
      'gemini-3-pro-preview',
      'gemini-2.5-flash',
      'gemini-3-flash-preview',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
    ],
    rateLimitCooldown: 60000,
  },

  // Paths used by feed scripts (output/, logs/, extract.json).
  paths: {
    outputDir:   path.join(REPO_ROOT, 'output'),
    extractPath: path.join(REPO_ROOT, 'output', 'extract.json'),
    logsDir:     LOGS_DIR, // per-database, see services/db.js
  },
};

export { config };
export default config;
