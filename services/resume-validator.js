/**
 * Validates a user's tailor-side resume payload (stored at `users.<u>.data`
 * in mongo).
 * Returns { valid, errors[], warnings[], summary }
 */

const SCHEMA = {
  personalInfo: {
    required: ['name', 'email'],
    optional: ['dob', 'phone', 'location', 'linkedin', 'github', 'portfolio', 'leetcode'],
    types: { name: 'string', email: 'string', dob: 'string', phone: 'string', location: 'string', linkedin: 'string', github: 'string', portfolio: 'string', leetcode: 'string' },
  },
  meta: {
    required: ['experienceStart', 'stack'],
    optional: ['primaryCloud', 'coreProjects', 'selectableProjects', 'editableProjects', 'cannotClaim'],
    types: { experienceStart: 'string', stack: 'string', primaryCloud: 'string', coreProjects: 'array', selectableProjects: 'array', editableProjects: 'array', cannotClaim: 'array' },
  },
  professionalSummary: {
    required: ['default'],
    optional: ['keywords'],
    types: { default: 'string', keywords: 'array' },
  },
  // Skills is required but its shape evolved: today it's a flat map of
  // { skillName: [aliases] } per user, not category-grouped. Validator
  // only checks it's a non-empty object.
  skills: {
    isMap: true,
  },
  experience: {
    isArray: true,
    itemRequired: ['company', 'title', 'duration'],
    itemOptional: ['location', 'isCurrent', 'projects', 'bullets'],
    itemTypes: { company: 'string', title: 'string', duration: 'string', location: 'string', isCurrent: 'boolean', projects: 'array', bullets: 'array' },
  },
  projects: {
    isArray: true,
    itemRequired: ['name', 'description'],
    itemOptional: ['coreTech', 'stackUsed'],
    itemTypes: { name: 'string', description: 'string', coreTech: 'array', stackUsed: 'object' },
  },
  education: {
    isArray: true,
    itemRequired: ['degree', 'institution'],
    itemOptional: ['field', 'duration', 'score'],
    itemTypes: { degree: 'string', institution: 'string', field: 'string', duration: 'string', score: 'string' },
  },
};

// Experience project sub-schema
const PROJECT_SCHEMA = {
  required: ['name', 'description'],
  optional: ['coreTech', 'stackUsed'],
  types: { name: 'string', description: 'string', coreTech: 'array', stackUsed: 'object' },
};

function checkType(value, expected) {
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return typeof value === 'object' && !Array.isArray(value) && value !== null;
  return typeof value === expected;
}

function countTailorSkills(skills) {
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return 0;
  return Object.values(skills).reduce(
    (sum, v) => sum + (Array.isArray(v) ? v.length : 0),
    0,
  );
}

export function validateResumeData(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Resume data must be a JSON object'], warnings, summary: null };
  }

  // Check top-level sections
  const topLevelRequired = ['personalInfo', 'meta', 'professionalSummary', 'skills', 'experience', 'projects'];
  const topLevelOptional = ['education'];

  for (const section of topLevelRequired) {
    if (!(section in data)) {
      errors.push(`Missing required section: "${section}"`);
    }
  }

  for (const section of topLevelOptional) {
    if (!(section in data)) {
      warnings.push(`Missing optional section: "${section}"`);
    }
  }

  // Validate object sections
  for (const [section, schema] of Object.entries(SCHEMA)) {
    if (!(section in data)) continue;
    const sectionData = data[section];

    if (schema.isMap) {
      if (!sectionData || typeof sectionData !== 'object' || Array.isArray(sectionData)) {
        errors.push(`"${section}" must be an object`);
      } else if (Object.keys(sectionData).length === 0) {
        warnings.push(`"${section}" is empty`);
      }
      continue;
    }
    if (schema.isArray) {
      // Array sections (experience, projects, education)
      if (!Array.isArray(sectionData)) {
        errors.push(`"${section}" must be an array`);
        continue;
      }
      if (sectionData.length === 0) {
        warnings.push(`"${section}" is empty`);
        continue;
      }

      sectionData.forEach((item, i) => {
        if (typeof item !== 'object' || item === null) {
          errors.push(`${section}[${i}] must be an object`);
          return;
        }

        for (const field of schema.itemRequired) {
          if (!(field in item)) {
            errors.push(`${section}[${i}] missing required field: "${field}"`);
          } else if (schema.itemTypes[field] && !checkType(item[field], schema.itemTypes[field])) {
            errors.push(`${section}[${i}].${field} must be ${schema.itemTypes[field]}`);
          }
        }

        // Validate nested experience projects
        if (section === 'experience' && item.projects) {
          if (!Array.isArray(item.projects)) {
            errors.push(`${section}[${i}].projects must be an array`);
          } else {
            item.projects.forEach((proj, j) => {
              for (const field of PROJECT_SCHEMA.required) {
                if (!(field in proj)) {
                  errors.push(`${section}[${i}].projects[${j}] missing required field: "${field}"`);
                }
              }
              if (proj.description && proj.description.length < 50) {
                warnings.push(`${section}[${i}].projects[${j}].description is very short (${proj.description.length} chars) — aim for 100+ chars`);
              }
            });
          }
        }
      });
    } else {
      // Object sections
      if (typeof sectionData !== 'object' || Array.isArray(sectionData)) {
        errors.push(`"${section}" must be an object`);
        continue;
      }

      for (const field of schema.required) {
        if (!(field in sectionData)) {
          errors.push(`${section} missing required field: "${field}"`);
        } else if (schema.types[field] && !checkType(sectionData[field], schema.types[field])) {
          errors.push(`${section}.${field} must be ${schema.types[field]}`);
        }
      }
    }
  }

  // Content quality warnings
  if (data.personalInfo?.name && data.personalInfo.name.length < 2) {
    warnings.push('personalInfo.name seems too short');
  }
  if (data.personalInfo?.email && !data.personalInfo.email.includes('@')) {
    errors.push('personalInfo.email is not a valid email address');
  }
  if (data.meta?.experienceStart && !/^[A-Z][a-z]{2}\s\d{4}$/.test(data.meta.experienceStart)) {
    warnings.push('meta.experienceStart should be in "Mon YYYY" format (e.g., "Jun 2022")');
  }
  if (data.professionalSummary?.default && data.professionalSummary.default.length < 50) {
    warnings.push('professionalSummary.default is very short — aim for 200+ characters');
  }
  if (data.skills && typeof data.skills === 'object' && !Array.isArray(data.skills)) {
    const skillCount = countTailorSkills(data.skills);
    if (skillCount < 5) {
      warnings.push(`Very few skills listed (${skillCount}) — the more skills you list, the better keyword matching works`);
    }
  }
  if (data.meta?.coreProjects && data.experience) {
    const workProjectNames = data.experience.flatMap(e => (e.projects || []).map(p => p.name));
    for (const core of data.meta.coreProjects) {
      if (!workProjectNames.some(n => n.includes(core))) {
        warnings.push(`meta.coreProjects references "${core}" but no matching work project found`);
      }
    }
  }

  // Build summary
  const summary = {
    name: data.personalInfo?.name || 'Unknown',
    stack: data.meta?.stack || 'Unknown',
    skillCount: countTailorSkills(data.skills),
    workProjects: data.experience
      ? data.experience.reduce((sum, e) => sum + (e.projects?.length || 0), 0)
      : 0,
    personalProjects: data.projects?.length || 0,
    experienceEntries: data.experience?.length || 0,
  };

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Feed-side resume schema
// ─────────────────────────────────────────────────────────────────────────
// What feed code actually consumes (see services/feed/feed-config.js
// shapeCandidate + services/feed/ai-bedrock.js):
//   personalInfo.{name, email, phone, location, linkedin, github,
//                 portfolio, currentCTC, expectedCTC}
//   experienceStart  (Mon YYYY)
//   stack            (free text, e.g. "Django" or "Java / Spring")
//   primaryCloud     (optional)
//   summary          (paragraph)
//   skills           { skillName: [aliases...] }   ← drives JD matching
//   cannotClaim      (optional array of skill names to disclaim)
//   projects         (optional array; only name + bullets read)
//   experience       (optional array; only experience[0] matters)
//   preferences      (optional object; market/filter knobs — see
//                     DEFAULT_PREFERENCES in services/feed/feed-config.js)

// feedData.preferences — every key optional. "a|b" means either type;
// "null" allows an explicit null (which disables that rule).
const PREFERENCE_TYPES = {
  country: 'string|null',
  currency: 'string',
  salaryUnit: 'string',
  usdRate: 'number',
  minSalary: 'number|null',
  maxExperienceGap: 'number',
  rejectWalkIn: 'boolean',
  rejectContract: 'boolean',
  rejectIntern: 'boolean',
  rejectStaffing: 'boolean',
  excludeCompanies: 'array',
  noticePeriod: 'string|null',
};

const checkUnionType = (value, spec) =>
  spec.split('|').some((t) => (t === 'null' ? value === null : checkType(value, t)));

const FEED_SCHEMA = {
  personalInfo: {
    required: ['name'],
    optional: ['email', 'phone', 'location', 'linkedin', 'github', 'portfolio', 'leetcode', 'currentCTC', 'expectedCTC'],
    types: { name: 'string', email: 'string', phone: 'string', location: 'string', linkedin: 'string', github: 'string', portfolio: 'string', leetcode: 'string', currentCTC: 'string', expectedCTC: 'string' },
  },
  topLevelStrings: ['experienceStart', 'stack', 'summary'],
  topLevelOptionalStrings: ['primaryCloud'],
  topLevelOptionalArrays: ['cannotClaim', 'projects', 'experience'],
};

export function validateFeedResumeData(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Feed resume must be a JSON object'], warnings, summary: null };
  }

  // personalInfo
  if (!data.personalInfo || typeof data.personalInfo !== 'object') {
    errors.push('Missing required section: "personalInfo"');
  } else {
    for (const f of FEED_SCHEMA.personalInfo.required) {
      if (!(f in data.personalInfo)) errors.push(`personalInfo.${f} required`);
    }
    for (const [f, t] of Object.entries(FEED_SCHEMA.personalInfo.types)) {
      if (f in data.personalInfo && !checkType(data.personalInfo[f], t)) {
        errors.push(`personalInfo.${f} must be ${t}`);
      }
    }
    if (data.personalInfo.email && !data.personalInfo.email.includes('@')) {
      errors.push('personalInfo.email is not a valid email');
    }
  }

  // required top-level strings
  for (const k of FEED_SCHEMA.topLevelStrings) {
    if (!(k in data)) {
      errors.push(`Missing required field: "${k}"`);
    } else if (typeof data[k] !== 'string') {
      errors.push(`"${k}" must be a string`);
    }
  }

  if (data.experienceStart && !/^[A-Z][a-z]{2}\s\d{4}$/.test(data.experienceStart)) {
    warnings.push('experienceStart should be in "Mon YYYY" format (e.g., "Jun 2022")');
  }

  // optional top-level strings
  for (const k of FEED_SCHEMA.topLevelOptionalStrings) {
    if (k in data && typeof data[k] !== 'string') {
      errors.push(`"${k}" must be a string`);
    }
  }

  // optional top-level arrays
  for (const k of FEED_SCHEMA.topLevelOptionalArrays) {
    if (k in data && !Array.isArray(data[k])) {
      errors.push(`"${k}" must be an array`);
    }
  }

  // preferences: optional; known keys are type-checked, unknown ones only
  // warned about so a typo doesn't block saving the whole resume.
  if ('preferences' in data) {
    const prefs = data.preferences;
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
      errors.push('"preferences" must be an object');
    } else {
      for (const [k, v] of Object.entries(prefs)) {
        const spec = PREFERENCE_TYPES[k];
        if (!spec) {
          warnings.push(`preferences.${k} is not a known preference and will be ignored`);
        } else if (!checkUnionType(v, spec)) {
          errors.push(`preferences.${k} must be ${spec.replace('|', ' or ')}`);
        }
      }
      if (Array.isArray(prefs.excludeCompanies) && prefs.excludeCompanies.some((c) => typeof c !== 'string')) {
        errors.push('preferences.excludeCompanies must contain only strings');
      }
      if (String(prefs.currency || '').toUpperCase() === 'USD' && typeof prefs.usdRate === 'number' && prefs.usdRate !== 1) {
        warnings.push(`preferences.usdRate is ${prefs.usdRate} but currency is USD — dollar salaries would be multiplied by it; set it to 1 or remove it`);
      }
    }
  }

  // skills: must be an object map of { skillName: [aliases] }
  if (!data.skills || typeof data.skills !== 'object' || Array.isArray(data.skills)) {
    errors.push('Missing required section: "skills" (must be an object mapping skill names → array of aliases)');
  } else {
    const keys = Object.keys(data.skills);
    if (keys.length === 0) {
      warnings.push('skills map is empty — JD matching will return 0 for every post');
    }
    for (const k of keys) {
      const v = data.skills[k];
      if (!Array.isArray(v)) {
        errors.push(`skills["${k}"] must be an array of aliases (got ${typeof v})`);
      }
    }
  }

  const summary = {
    name: data.personalInfo?.name || 'Unknown',
    stack: data.stack || 'Unknown',
    skillCount: data.skills && typeof data.skills === 'object' ? Object.keys(data.skills).length : 0,
    hasSummary: !!data.summary,
  };

  return { valid: errors.length === 0, errors, warnings, summary };
}
