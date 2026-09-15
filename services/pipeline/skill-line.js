/**
 * Settles the final skills line: what is kept, what is added, and in what order.
 *
 * Two defects this fixes, both silent:
 *
 * 1. **The candidate's core stack could be pushed off the resume entirely.**
 *    Step 1 extracts `coreSkills` — "skills the candidate has that this JD does
 *    NOT ask for" — with a comment saying it is there for step 2. Step 2 was
 *    never given it. Measured on a real AEM/frontend posting: the tailored
 *    skills line came back as React.js, TypeScript, JavaScript, HTML5, CSS3 …
 *    with **no Node.js, no MongoDB, no Express, no AWS**, on a full-stack candidate's
 *    resume whose own bullets three lines below name all four. One narrow JD
 *    rewrote the candidate's identity.
 *
 * 2. **Order was arbitrary.** `findTech` walks TECH_LEXICON, so JD technologies
 *    came back in lexicon order — the posting's own emphasis was thrown away.
 *
 * The rule, applied deterministically because ordering and retention are not
 * things a model should be trusted to redo on every call:
 *
 *   - keep what the candidate already has; a JD may not evict it;
 *   - add a JD term only when the posting actually names it AND the candidate
 *     can honestly claim it;
 *   - rank by first mention in the JD, so what the posting leads with is what
 *     the recruiter reads first. Anything the JD never mentions keeps its
 *     relative order and follows.
 *
 * This runs before scoring, so `ats-scorer.js` scores the line that is printed.
 * Retention only ever adds real, owned keywords, so coverage cannot go down.
 */

import { findTechWithPositions, canonicalTech } from './jd-tech.js';

/** Dedup key. Tech collapses onto its canonical form; prose lowercases. */
const key = (s) => canonicalTech(String(s || '').trim());

const parse = (skills) =>
  (Array.isArray(skills) ? skills : String(skills || '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);

/** Every skill the candidate has stored, flattened across their buckets. */
function ownedSkills(resumeData) {
  const buckets = resumeData?.skills || {};
  const out = new Map(); // canonical → the candidate's own spelling
  for (const list of Object.values(buckets)) {
    if (!Array.isArray(list)) continue;
    for (const skill of list) {
      const k = key(skill);
      if (k && !out.has(k)) out.set(k, skill);
    }
  }
  return out;
}

/**
 * @param {object} args
 * @param {string|string[]} args.skills - the model's `skl` output
 * @param {string} args.jobDescription
 * @param {object} args.resumeData
 * @param {object} [args.analysis] - step 1's output, for `coreSkills`
 * @param {string} [args.pageText] - the rest of the tailored page (summary,
 *   bullets, project descriptions). Any technology it claims and the candidate
 *   owns is pinned to the skills line, so the page cannot contradict itself.
 * @param {number} [args.max] - hard ceiling on the printed line
 * @returns {string} the comma-separated line, retained and JD-ordered
 */
export function buildSkillLine({
  skills, jobDescription, resumeData, analysis = {}, pageText = '', max = 26,
}) {
  const model = parse(skills);
  const owned = ownedSkills(resumeData);
  const banned = new Set((resumeData?.meta?.cannotClaim || []).map(canonicalTech));
  const jd = findTechWithPositions(jobDescription || '');

  // Rank by where the posting first mentions the skill. Everything the JD never
  // names shares Infinity and therefore keeps its incoming relative order.
  const rankOf = (skill) => {
    const hit = jd.get(key(skill));
    return hit ? hit.index : Infinity;
  };

  const entries = [];
  const seen = new Set();
  // A single entry can name more than one technology — the model writes
  // "Agile/Scrum" where the JD says "Agile" and "Scrum" separately. Tracking
  // only the entry's own key would then re-add both as duplicates, so record
  // every technology each entry mentions.
  const covered = new Set();

  const add = (skill, { protectedEntry = false } = {}) => {
    const k = key(skill);
    if (!k || seen.has(k) || covered.has(k) || banned.has(k)) return;
    // The entry's own key is not enough: "Apache Kafka" canonicalises to
    // something other than "Kafka", so a banned Kafka still printed. Check
    // every technology the entry names — the same set already collected for
    // dedup — so a longer spelling can't smuggle a disclaimed skill onto the
    // page. This is the last filter before the line is printed.
    const names = [...findTechWithPositions(skill).keys()];
    if (names.some((t) => banned.has(t))) return;
    seen.add(k);
    for (const tech of names) covered.add(tech);
    entries.push({ skill, rank: rankOf(skill), seq: entries.length, protectedEntry });
  };

  // 1. The model's selection, in its own order — the JD-required additions it
  //    chose plus whatever of the candidate's stack it kept.
  for (const skill of model) add(skill);

  // 2. Retention, deterministic floor: anything the rest of the page already
  //    claims. A resume whose bullets say "…pipeline on Node.js APIs → MongoDB"
  //    while its skills line lists neither is contradicting itself, and that is
  //    exactly what the regression looked like. Restricted to technologies the
  //    candidate owns, so it can only surface what is already true.
  for (const [k] of findTechWithPositions(pageText || '')) {
    const stored = owned.get(k);
    if (stored) add(stored, { protectedEntry: true });
  }

  // 3. Retention, model's judgement on top. `coreSkills` is step 1's answer to
  //    "what does this person do that this posting doesn't ask about" — the
  //    things a narrow JD deletes. Useful, but it varies run to run, which is
  //    why it supplements the floor above rather than being the whole rule.
  for (const skill of analysis.coreSkills || []) {
    const stored = owned.get(key(skill));
    if (stored) add(stored, { protectedEntry: true });
  }

  // 4. Anything the JD names that the candidate owns and the model still missed.
  //    Required by the posting and honestly claimable, so it belongs on the page.
  for (const [k, { spelling }] of jd) {
    if (owned.has(k)) add(spelling, { protectedEntry: true });
  }

  // JD order first. Among everything the JD never names, the candidate's real
  // retained skills come before the model's generic ATS claims ("modern user
  // interfaces", "digital experiences") — a recruiter should hit Node.js before
  // filler. Ranks are byte offsets, so a tie only ever happens at Infinity.
  entries.sort((a, b) =>
    a.rank - b.rank
    || Number(b.protectedEntry) - Number(a.protectedEntry)
    || a.seq - b.seq);

  // Trim to the ceiling by dropping the least useful first: unranked, unprotected
  // entries from the tail. Protected ones survive even when the JD never mentions
  // them — that is the whole point of keeping them.
  if (entries.length > max) {
    for (let i = entries.length - 1; i >= 0 && entries.length > max; i--) {
      if (!entries[i].protectedEntry && entries[i].rank === Infinity) entries.splice(i, 1);
    }
    for (let i = entries.length - 1; i >= 0 && entries.length > max; i--) {
      if (!entries[i].protectedEntry) entries.splice(i, 1);
    }
    // Everything left is protected and something still has to go. Sorting puts
    // unranked entries LAST, so a blind truncation cut the page-text floor
    // first — the retention this module exists to provide. Drop the entries the
    // JD mentions latest instead, and keep the unranked ones the page claims.
    for (let i = entries.length - 1; i >= 0 && entries.length > max; i--) {
      if (entries[i].rank !== Infinity) entries.splice(i, 1);
    }
    entries.length = Math.min(entries.length, max);
  }

  return entries.map((e) => e.skill).join(', ');
}

export default { buildSkillLine };
