/**
 * Post Pre-Filter — deterministic rejection before AI pipeline
 *
 * Catches posts that should be rejected BEFORE sending to the AI pipeline,
 * saving API calls. Also used as a safety net in Phase 2 scoring.
 *
 * Categories:
 *  1. Posts placed outside the candidate's country
 *  2. F2F / walk-in interviews
 *  3. Local candidates only restrictions
 *  4. Internship / stipend / unpaid
 *  5. Job seekers (#OpenToWork, "looking for job")
 *  6. Low salary (below preferences.minSalary)
 *  7. Staffing / recruitment agency posts (not actual jobs)
 *  8. The candidate's own employer (preferences.excludeCompanies)
 *
 * Every rule is driven by the `preferences` object on the candidate (see
 * DEFAULT_PREFERENCES in feed-config.js). Called with no prefs it behaves
 * exactly as the defaults say: India, 6 LPA floor, walk-in / intern /
 * staffing rejected, no excluded companies.
 *
 * THE LOCATION LEXICON IS INDIA-CENTRIC. Section 1 lists the foreign cities,
 * visa terms and email TLDs an India-based candidate wants to skip, with
 * INDIA_CITIES as the home signal. It therefore only runs when
 * prefs.country is India; any other country (or null) skips the deterministic
 * location block and leaves geography to the extraction prompt, which is
 * parametrised by the same preference. Running it for a US-based user would
 * reject their own local posts as "US city".
 *
 * `rejectContract` has no regex here on purpose: "contract" in raw post text
 * is too ambiguous ("we sign contracts with clients") for a blunt match. It is
 * enforced by the extraction prompt, which reads the role type in context.
 *
 * Built from analysis of ~2000 posts across the pipeline.
 */

import { DEFAULT_PREFERENCES } from './feed-config.js';

// ============================================================
// 1. LOCATION PATTERNS (India-centric — see header)
// ============================================================

const LOCATION_PATTERNS = {
  usCities: /\b(San Diego|San Francisco|San Jose|New York|NYC|Chicago|Los Angeles|Seattle|Austin|Dallas|Houston|Plano|Boston|Denver|Atlanta|Phoenix|Portland|Raleigh|Charlotte|Arlington|Tampa|Miami|Orlando|Minneapolis|Detroit|Philadelphia|Pittsburgh|Nashville|Las Vegas|Sacramento|Irvine|Sunnyvale|Mountain View|Palo Alto|Cupertino|Redmond|Bellevue|Ann Arbor|Boulder|Scottsdale|Boise|Salt Lake City|St\.? Louis|San Antonio|Columbus|Indianapolis|Jacksonville|Memphis|Louisville|Richmond|Omaha|Tucson|Fresno|Mesa)\b/i,
  usStates: /\b(California|Texas|Florida|Illinois|Ohio|Georgia|Michigan|Pennsylvania|Massachusetts|Washington State|Colorado|Arizona|Maryland|Virginia|Oregon|Tennessee|Minnesota|Wisconsin|Indiana|Missouri|New Jersey|Connecticut|North Carolina|South Carolina)\b/i,
  usGeneral: /\b(United States|USA|U\.S\.A|US[- ]based|based in US)\b(?!\s*(?:shift|timing|hours|time zone))/i,
  visa: /\b(H1B|H-1B|H1-B|Green Card|USC|US Citizen|EAD|OPT|CPT|work authorization|work permit|visa sponsor|TN visa|E-?verify)\b/i,
  w2c2c: /\b(W2|W-2|C2C|Corp[- ]to[- ]Corp|1099)\b/i,
  pakistan: /\b(Pakistan|Lahore|Karachi|Islamabad|Rawalpindi|Faisalabad|Multan|Peshawar|Quetta|Sialkot|Gujranwala|Johar Town|Bahria Town|DHA Lahore|DHA Karachi)\b/i,
  middleEast: /\b(Dubai|Abu Dhabi|UAE|Saudi Arabia|Riyadh|Jeddah|Qatar|Doha|Bahrain|Kuwait|Oman|Muscat)\b/i,
  seAsia: /\b(Singapore|Makati|Manila|Philippines|Jakarta|Indonesia|Bangkok|Thailand|Ho Chi Minh|Ha Noi|Hanoi|Vietnam|Kuala Lumpur|Malaysia)\b/i,
  europe: /\b(London|Berlin|Amsterdam|Paris|Munich|Stockholm|Barcelona|Madrid|Dublin|Zurich|Geneva|Vienna|Prague|Warsaw|Lisbon|Rome|Copenhagen|Helsinki|Oslo|Brussels|Edinburgh|Manchester|Hamburg|Frankfurt)\b/i,
  otherCountries: /\b(Canada|Toronto|Vancouver|Montreal|Calgary|Ottawa|Australia|Sydney|Melbourne|Brisbane|Perth|Adelaide|Auckland|New Zealand|Japan|Tokyo|South Korea|Seoul|Taiwan|Taipei|Hong Kong|China|Shanghai|Beijing|Shenzhen)\b/i,
  nonIndiaDomains: /@\S+\.(pk|bd|ae|uk|ca|au|sg|ph|my|sa|qa|de|fr|nl|se|ch|jp|kr|cn|tw|nz)\b/i,
};

const LOCATION_LABELS = {
  usCities: 'US city', usStates: 'US state', usGeneral: 'US-based',
  visa: 'visa/work auth required', w2c2c: 'US contract type',
  pakistan: 'Pakistan-based', middleEast: 'Middle East-based',
  seAsia: 'Southeast Asia-based', europe: 'Europe-based',
  otherCountries: 'non-India country', nonIndiaDomains: 'non-India email domain',
};

const NON_INDIA_KEYS = Object.keys(LOCATION_LABELS);

const INDIA_CITIES = /\b(Bangalore|Bengaluru|Mumbai|Pune|Hyderabad|Chennai|Delhi|Noida|Gurgaon|Gurugram|Kolkata|Ahmedabad|Jaipur|Indore|Chandigarh|Mohali|Kochi|Lucknow|Bhopal|Nagpur|Coimbatore|Surat|Visakhapatnam|Thiruvananthapuram|India)\b/i;

const isIndia = (country) => /^india$/i.test(String(country || '').trim());

// ============================================================
// 2. OTHER REJECTION PATTERNS
// ============================================================

const F2F_PATTERN = /\b(walk[- ]?in|face[- ]to[- ]face|F2F|in[- ]person interview)\b/i;

const LOCAL_ONLY_PATTERN = /\b(local candidates? only|only local candidates?|locals only|ONLY .{1,30} LOCAL CANDIDATES|local candidates? can apply|must be (based|from|located|residing) in|currently based in .{1,20} only|only (from|candidates? from) .{1,20}(can apply|only|preferred)|only .{1,15} candidates? (can apply|only))\b/i;

// `interns?` so the plural counts — "hiring Full-Stack Developer Interns" was
// slipping through, and one post only got caught because it happened to say
// "Intern" singular further down. The optional `s` still can't reach "internal"
// or "international": both continue past the word boundary.
const INTERNSHIP_PATTERN = /\b(interns?\b|internship|trainee|apprentice|stipend|unpaid)\b/i;

const JOB_SEEKER_PATTERN = /\b(#OpenToWork|open to work|actively looking|actively seeking|seeking opportunities|looking for .{0,15}(job|role|position|opportunity)|job seeker|hire me|currently unemployed)\b/i;

const STAFFING_PATTERN = /\b(empanelment|recruitment agency|staffing (company|agency|partner|firm))\b/i;

// ============================================================
// 3. PREFERENCE-DRIVEN PATTERNS (compiled per prefs object)
// ============================================================

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "< 6 LPA" as a regex: the integers 1..minSalary-1 (with an optional
// fraction, so "5.5 LPA" is still below 6) followed by an LPA unit. LPA-only
// — the lexicon reads "lakhs per annum" — so for any other salaryUnit the
// deterministic check is skipped and the extraction prompt carries the
// floor. The number must not be preceded by a digit or a dot: a plain \b
// matched the "5" inside "12.5 LPA" and rejected every half-lakh figure
// above the floor as "Low salary (5 LPA)".
function lowSalaryPattern(prefs) {
  const min = Number(prefs.minSalary);
  if (!Number.isFinite(min) || min < 2) return null;
  if (String(prefs.salaryUnit || '').toUpperCase() !== 'LPA') return null;
  const nums = [];
  for (let n = Math.ceil(min) - 1; n >= 1; n--) nums.push(String(n));
  const alt = `(?:${nums.join('|')})(?:\\.\\d+)?`;
  return new RegExp(`(?<![\\d.])(${alt}\\s*LPA|${alt}\\s*lakhs?\\s*(per\\s*annum|PA|p\\.a\\.))\\b`, 'i');
}

// Same trailing-suffix list normalizeCompany uses in feed-filters.js. Kept
// local so this pure text filter stays free of the mirror/db import chain.
const COMPANY_SUFFIX_RES = [
  /\s+(pvt|private|public)\s+(ltd|limited)\s*$/,
  /\s+(pvt|private|public)\s*$/,
  /\s+(ltd|limited|llc|llp|inc|corp|corporation|gmbh|plc|pte)\s*$/,
  /\s+(india|global|worldwide|usa|uk)\s*$/,
  /\s+(technologies|technology|solutions|software|services|systems|consulting|consultancy|infotech|infosystems|enterprises|ventures|group|labs|lab|digital|co|company)\s*$/,
];

// "Acme Technologies Pvt. Ltd." → /\b(acme)\b/i. A post says "Acme is hiring",
// never the registered name, so the legal and generic suffixes are stripped
// and the distinctive part is what the text is matched against.
function ownCompanyPattern(names) {
  const cores = [];
  for (const raw of Array.isArray(names) ? names : []) {
    let n = String(raw || '').toLowerCase().replace(/[.\-&+,()®™'"]/g, ' ').replace(/\s+/g, ' ').trim();
    let prev;
    do { prev = n; for (const re of COMPANY_SUFFIX_RES) n = n.replace(re, '').trim(); } while (n !== prev);
    if (n) cores.push(escapeRegex(n).replace(/ /g, '\\s+'));
  }
  return cores.length ? new RegExp(`\\b(${cores.join('|')})\\b`, 'i') : null;
}

// Regexes derived from the preferences. Cached against the CALLER's prefs
// object (`key`), not the merged copy built per call, so the 25k-post
// pre-filter compiles them once per candidate rather than once per post.
const _compiled = new WeakMap();

function compile(key, prefs) {
  const cached = _compiled.get(key);
  if (cached) return cached;

  const country = prefs.country ? String(prefs.country).trim() : null;
  const c = country ? escapeRegex(country) : null;
  const homeWords = c ? [c, `pan ${c}`, `anywhere in ${c}`] : [];
  if (c && isIndia(country)) homeWords.push('indian');

  const rules = {
    country,
    // The foreign-location lexicon only knows India as home (see header).
    lexicon: !!country && isIndia(country),
    homeRemote: c ? new RegExp(`\\b(remote.{0,20}${c}|${c}.{0,20}remote|PAN ${c})\\b`, 'i') : null,
    homeLocation: c ? (isIndia(country) ? INDIA_CITIES : new RegExp(`\\b${c}\\b`, 'i')) : null,
    homeContext: homeWords.length ? new RegExp(`\\b(${homeWords.join('|')})\\b`, 'i') : null,
    lowSalary: lowSalaryPattern(prefs),
    ownCompany: ownCompanyPattern(prefs.excludeCompanies),
  };
  _compiled.set(key, rules);
  return rules;
}

// ============================================================
// CORE FILTER FUNCTION
// ============================================================

/**
 * Check text for any rejection signal.
 * @param {string} rawText - Post text to scan
 * @param {object} [prefs] - candidate.preferences; missing keys take DEFAULT_PREFERENCES
 * @returns {null|{reason: string, category: string}} - null if OK, object if rejected
 */
export function checkLocation(rawText, prefs = DEFAULT_PREFERENCES) {
  if (!rawText || rawText.trim().length < 10) return null;

  // A partial prefs object gets the defaults for whatever it leaves out.
  const p = prefs && typeof prefs === 'object' ? prefs : DEFAULT_PREFERENCES;
  const merged = p === DEFAULT_PREFERENCES ? p : { ...DEFAULT_PREFERENCES, ...p };
  const rules = compile(p, merged);

  // LinkedIn composes with the typographic apostrophe (U+2019), so "We’re
  // hiring" never matched a pattern written as "we're hiring". That silently
  // disarmed the hiring-signal guard below and got a real Hyderabad job ad
  // rejected as a job seeker, because the guard is the only thing standing
  // between "are you looking for your next opportunity?" (a recruiter talking
  // to candidates) and the seeker rule. Normalise once, up front, so every
  // pattern in this file is spared the same trap.
  const text = String(rawText).replace(/[‘’ʼ‛]/g, "'");

  // ── F2F / walk-in ──
  if (merged.rejectWalkIn) {
    const f2fMatch = text.match(F2F_PATTERN);
    if (f2fMatch) {
      return { reason: `F2F interview required (${f2fMatch[0]})`, category: 'f2f' };
    }
  }

  // ── Location outside the home country ──
  if (rules.lexicon) {
    const locationHits = [];
    for (const [key, regex] of Object.entries(LOCATION_PATTERNS)) {
      const match = text.match(regex);
      if (match) locationHits.push({ key, matched: match[0] });
    }

    if (locationHits.length > 0) {
      const hasVisa = locationHits.some(h => h.key === 'visa');
      const hasW2 = locationHits.some(h => h.key === 'w2c2c');
      const hasRemote = /\b(remote|work from home|WFH|remote.?friendly|fully remote)\b/i.test(text);
      const hasHomeRemote = rules.homeRemote.test(text);
      const hasHomeLocation = rules.homeLocation.test(text);

      const nonHomeHits = locationHits.filter(h => NON_INDIA_KEYS.includes(h.key));

      if (nonHomeHits.length > 0) {
        // Exceptions
        const skip =
          hasHomeRemote ||
          (hasRemote && !hasVisa && !hasW2 && nonHomeHits.length === 1) ||
          (nonHomeHits.length === 1 && nonHomeHits[0].key === 'usGeneral' && hasHomeLocation && !hasVisa && !hasW2);

        if (!skip) {
          const reasons = nonHomeHits.map(h => `${LOCATION_LABELS[h.key]}: ${h.matched}`);
          return { reason: `Non-${rules.country}/restricted (${reasons.join(', ')})`, category: 'location' };
        }
      }
    }
  }

  // ── Local candidates only (without home-country context allowing it) ──
  const localMatch = text.match(LOCAL_ONLY_PATTERN);
  if (localMatch) {
    // Exception: "must be based in <home country>" / "Only <home> Candidates" is fine for us
    const localCtx = text.substring(Math.max(0, text.indexOf(localMatch[0]) - 20), text.indexOf(localMatch[0]) + localMatch[0].length + 40);
    const isHomeContext = rules.homeContext ? rules.homeContext.test(localCtx) : false;
    if (!isHomeContext) {
      return { reason: `Local candidates only (${localMatch[0].substring(0, 50)})`, category: 'local' };
    }
  }

  // ── Internship / stipend / unpaid ──
  if (merged.rejectIntern) {
    const internMatch = text.match(INTERNSHIP_PATTERN);
    if (internMatch) {
      const word = internMatch[0].toLowerCase();
      // Always reject stipend/unpaid
      if (word === 'stipend' || word === 'unpaid') {
        return { reason: `Internship/stipend (${internMatch[0]})`, category: 'intern' };
      }
      // For intern/internship/trainee/apprentice: only reject if the post is primarily about that role
      // Multi-role posts mentioning intern alongside full-time roles should pass through
      const hasFullTime = /\b(full[- ]?time|permanent|regular position)\b/i.test(text);
      if (!hasFullTime) {
        return { reason: `Internship/stipend (${internMatch[0]})`, category: 'intern' };
      }
    }
  }

  // ── Job seekers (not actually hiring) ──
  const seekerMatch = text.match(JOB_SEEKER_PATTERN);
  if (seekerMatch) {
    // Only reject if the post does NOT also contain hiring signals
    const hasHiringSignal = /\b(we are hiring|we're hiring|hiring for|open position|urgent hiring|join our team|looking for a .{0,20}(developer|engineer|designer|candidate)|we are (actively )?(looking|searching|seeking) for|we're (actively )?(looking|searching|seeking) for|we're expanding|we are expanding|our team is (looking|growing|hiring))\b/i.test(text);
    if (!hasHiringSignal) {
      return { reason: `Job seeker, not hiring (${seekerMatch[0].substring(0, 40)})`, category: 'seeker' };
    }
  }

  // ── Low salary (below preferences.minSalary) ──
  if (rules.lowSalary) {
    const salaryMatch = text.match(rules.lowSalary);
    if (salaryMatch) {
      return { reason: `Low salary (${salaryMatch[0]})`, category: 'salary' };
    }
  }

  // ── Staffing / recruitment agency ──
  if (merged.rejectStaffing) {
    const staffingMatch = text.match(STAFFING_PATTERN);
    if (staffingMatch) {
      return { reason: `Staffing/recruitment (${staffingMatch[0]})`, category: 'staffing' };
    }
  }

  // ── Own company (candidate's current employer, or anything excluded) ──
  if (rules.ownCompany) {
    const ownCoMatch = text.match(rules.ownCompany);
    if (ownCoMatch) {
      return { reason: `Own company (${ownCoMatch[0]})`, category: 'own_company' };
    }
  }

  return null;
}

// ============================================================
// CONVENIENCE WRAPPERS
// ============================================================

/**
 * Filter for raw LinkedIn posts (pre-Phase 1, before API call).
 * Post shape: { id, post: { text }, author: { name }, ... }
 * @returns {null|string} - null if OK, rejection reason string if rejected
 */
export function checkRawPost(post, prefs) {
  const text = post?.post?.text || '';
  const result = checkLocation(text, prefs);
  return result ? result.reason : null;
}

/**
 * Filter for extracted posts in the shared pool (Phase 2 scoring safety net).
 * Post shape: { postText, summary, job: { location }, contacts: { emails } }
 * @returns {null|string} - null if OK, rejection reason string if rejected
 */
export function checkExtractedPost(extracted, prefs) {
  const parts = [
    extracted.postText || '',
    extracted.summary || '',
    extracted.job?.location || '',
    (extracted.contacts?.emails || []).join(' '),
  ];
  const result = checkLocation(parts.join(' '), prefs);
  return result ? result.reason : null;
}
