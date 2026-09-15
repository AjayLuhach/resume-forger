/**
 * Candidate ↔ job-requirement skill matching.
 *
 * Extracted from ai-bedrock.js so the scorer and the UI answer "does the
 * candidate have this skill?" with the SAME code. When the posts page needed
 * to show skill gaps, the tempting shortcut was a second copy of this logic —
 * which is exactly how the jd-tech lexicon drifted out of sync with its
 * measurement harness and produced wrong numbers for months (see CLAUDE.md).
 * One implementation, two callers.
 *
 * No AI involved: the requirement list is already extracted, and the candidate's
 * skills are already known, so the gap is a set operation. That makes it free,
 * instant, retroactive across the whole pool, and — most importantly —
 * guaranteed to agree with the match score shown next to it.
 */

export function normalizeSkill(skill) {
  return String(skill)
    .toLowerCase()
    .replace(/[.\-\/\\()]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

// Build skill lookup (name + aliases) from the candidate's feedData.
export function buildSkillLookup(candidate) {
  const lookup = new Set();
  const skillsMap = candidate.skillsWithAliases || {};

  for (const [skillName, aliases] of Object.entries(skillsMap)) {
    // Add the canonical name normalized
    lookup.add(normalizeSkill(skillName));
    // Add all aliases
    for (const alias of aliases) {
      lookup.add(alias.toLowerCase().replace(/\s+/g, ''));
    }
  }

  return lookup;
}

// Build blocklist from cannotClaim
export function buildCannotClaimSet(candidate) {
  const blocked = new Set();
  for (const skill of (candidate.cannotClaim || [])) {
    blocked.add(normalizeSkill(skill));
  }
  return blocked;
}

// Check if a required skill matches any known skill (exact or safe word-boundary match)
export function matchesSkill(normReq, skillLookup, cannotClaimSet) {
  // Block if skill is in cannotClaim (exact match)
  if (cannotClaimSet.has(normReq)) return false;

  // Exact match against skill lookup
  if (skillLookup.has(normReq)) return true;

  // Word-boundary safe matching: only match if the requirement IS a known skill
  // or a known skill IS the requirement (exact containment with length guard)
  // Minimum token length of 3 to avoid false positives like "go" in "mongo", "ai" in "restapi"
  for (const s of skillLookup) {
    // Skip very short tokens for substring matching (exact already checked above)
    if (s.length < 3 && normReq.length < 3) continue;

    // Only allow containment if the shorter string is at least 60% the length of the longer
    // This prevents "go" matching "mongo", "ai" matching "restapi"
    const shorter = s.length <= normReq.length ? s : normReq;
    const longer = s.length <= normReq.length ? normReq : s;

    if (shorter.length < 3) continue; // never substring-match 1-2 char tokens

    if (longer === shorter) return true; // exact
    if (longer.startsWith(shorter) || longer.endsWith(shorter)) {
      // Prefix/suffix match is OK for things like "nodejs" matching "node"
      // but verify it's not a cannotClaim skill
      if (!cannotClaimSet.has(normReq)) return true;
    }
  }

  return false;
}

/**
 * Pre-build the two sets once per candidate, so a caller splitting hundreds of
 * posts doesn't rebuild them per post.
 * @returns {{ split: (requirements: string[]) => { have: string[], missing: string[] } }}
 */
export function skillMatcher(candidate) {
  const lookup = buildSkillLookup(candidate);
  const blocked = buildCannotClaimSet(candidate);
  return {
    split(requirements = []) {
      const have = [];
      const missing = [];
      for (const req of requirements) {
        if (matchesSkill(normalizeSkill(req), lookup, blocked)) have.push(req);
        else missing.push(req);
      }
      return { have, missing };
    },
  };
}
