/**
 * Well-known company detection for "link" contact method.
 * Only well-known companies with application links (but no email) get method: "link".
 * Unknown/small companies default to "DM".
 *
 * Two sources:
 *   1. RAW_ENTRIES below — manually curated global/Indian well-known companies
 *   2. high-salary-companies.json — auto-maintained list (names + aliases)
 * Both are merged at init time into a single normalized lookup set.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { highSalaryMirror } from '../mirror.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Manually curated well-known companies
const RAW_ENTRIES = [
  // Global tech giants
  'google', 'microsoft', 'amazon', 'meta', 'apple', 'netflix', 'uber', 'stripe',
  'shopify', 'salesforce', 'adobe', 'oracle', 'ibm', 'intel', 'cisco', 'vmware',
  'paypal', 'twitter', 'linkedin', 'spotify', 'slack', 'zoom', 'airbnb', 'snap',
  'databricks', 'snowflake', 'cloudflare', 'datadog', 'twilio', 'okta', 'github',
  'gitlab', 'hashicorp', 'elastic', 'confluent', 'mongodb', 'redis', 'vercel',
  'netlify', 'docker', 'figma', 'canva', 'notion', 'airtable', 'asana',
  'atlassian', 'jira', 'autodesk', 'intuit', 'workday', 'servicenow',
  'nvidia', 'sap', 'qualcomm', 'akamai', 'red hat', 'redhat',
  'palantir', 'twitch', 'pinterest', 'dropbox', 'square', 'block',

  // Indian tech / unicorns
  'flipkart', 'swiggy', 'zomato', 'razorpay', 'paytm', 'phonepe', 'cred',
  'meesho', 'sharechat', 'dream11', 'groww', 'zerodha', 'upstox', 'licious',
  'curefit', 'cure fit', 'cultfit', 'cult fit', 'unacademy', 'physicswallah',
  'physics wallah', 'pw', 'byju', 'byjus', 'vedantu', 'simplilearn', 'scaler',
  'naukri', 'infoedge', 'policybazaar', 'paisabazaar', 'ola', 'rapido', 'dunzo',
  'urban company', 'urbanclap', 'bigbasket', 'blinkit', 'grofers', 'zepto',
  'myntra', 'ajio', 'nykaa', 'mamaearth', 'boat', 'noise', 'freshworks',
  'zoho', 'postman', 'browserstack', 'hasura', 'chargebee', 'clevertap', 'micro1',
  'moengage', 'leadsquared', 'darwinbox', 'yellow ai', 'highradius',
  'highlevel', 'innovaccer', 'druva', 'icertis', 'mindtickle',
  'upgrad', 'spinny', 'juspay', 'rupeek', 'purplle', 'mygate',
  'insurancedekho', 'livspace', 'unstop', 'nxtwave', 'snapmint',
  'sarvam ai', 'signoz', 'cloudsek', 'hiver', 'reelo',
  'zeta', 'zeta ai', 'cred', 'hevodata', 'kapture', 'wysa',
  'snitch', 'oxyzo', 'oxyzo financial', 'atlys', 'animall', 'freo', 'capitalmind',
  'aisensy', 'klenty', 'aisensy',

  // Indian IT services
  'infosys', 'tcs', 'tcs interactive', 'wipro', 'hcl', 'hcltech', 'tech mahindra',
  'cognizant', 'capgemini', 'accenture', 'deloitte', 'kpmg', 'ey', 'ernst young',
  'pwc', 'pricewaterhouse', 'mckinsey', 'bcg', 'bain', 'ey gds',
  'thoughtworks', 'epam', 'nagarro', 'publicis sapient',
  'globallogic', 'global logic', 'mphasis', 'ltimindtree', 'persistent',
  'cyient', 'hexaware', 'coforge', 'zensar', 'birlasoft', 'sonata software',
  'mindtree', 'virtusa', 'ust', 'genpact', 'valuelabs',
  'citiustech', 'ascendion', 'happiest minds', 'cybage',
  'celebal', 'celebal technologies', 'neosoft', 'nineleaps', 'xebia',
  'acl digital', '3i', '3i infotech',
  'quess', 'quesscorp', 'lancesoft', 'devsinc', 'sysmind',
  'softtek', 'kgisl', 'varite', 'net2source', 'dexian',
  'htc global', 'yash technologies', 'yash', 'codiant',
  'xicom', 'servion', 'testingxperts',

  // Global IT services / consulting
  'teksystems', 'ntt data', 'cgi', 'altimetrik', 'apexon',
  'dataart', 'sigma software', 'actalent', 'dentsu', 'merkle',
  'valtech', 'comviva', 'randstad', 'robert half', 'teamlease',
  'adecco', 'compunnel', 'milliman', 'gspann', 'infobeans',

  // Product companies (global)
  'samsung', 'lg', 'sony', 'siemens', 'bosch', 'schneider', 'honeywell',
  'ge', 'general electric', 'caterpillar', 'rockwell automation', 'emerson',
  'dassault', '3m', 'continental', 'philips', 'electrolux', 'bmw', 'bmw techworks',
  'electronic arts', 'ea', 'corsair', 'mcafee', 'uipath',
  'perforce', 'clickhouse', 'simcorp', 'vonage', 'deel',
  'lucid motors', 'dp world', 'amadeus', 'tripadvisor',
  'bigcommerce', 'nightfall ai', 'anthropic', 'turing',
  'cover genius', 'moonpay', 'binance', 'kraken',
  '7-eleven', '7 eleven', 'tesco', 'weave', 'cyncly',
  '0x labs', 'opensesame', 'paymob', 'uveye',

  // Financial / consulting
  'goldman sachs', 'morgan stanley', 'jpmorgan', 'jp morgan', 'jpm', 'jpmc',
  'barclays', 'deutsche bank', 'hsbc', 'citi', 'citibank', 'wells fargo',
  'bnp paribas', 'credit suisse', 'ubs', 'nomura',
  'marsh mclennan', 'gartner', 'visa', 'mastercard',
  'american express', 'amex', 'transunion', 'msci',
  'intercontinental exchange', 'macquarie', 'edelweiss', 'quilter',
  'oaknorth', 'optum', 'athenahealth', 'humana',
  'bottomline', 'flywire', 'fundraise up',

  // Telecom / media
  'jio', 'reliance', 'airtel', 'vodafone', 'idea',
  'bt group', 'bt', 'british telecom', 'verizon', 'at t',
  'zee entertainment', 'zee', 'times internet',

  // E-commerce / retail
  'walmart', 'target', 'ikea', 'h m', 'decathlon',

  // Staffing / HR tech
  'ukg', 'epsilon', 'robert walters', 'uplers',
  'nationbenefits', 'nationsbenefits',

  // Healthcare
  'cleveland clinic',

  // Energy
  'bp',

  // Defense
  'general dynamics',

  // Real estate / construction
  'embassy group', 'embassy',

  // Research / analytics
  'marketsandmarkets', 'tiger analytics',

  // Others well-known
  'olx', 'quikr', 'nerdwallet', 'blue yonder',
  'align technology', 'bigid', 'offerup', 'gojek', 'grab', 'sea',
  'delhivery', 'rivigo', 'blackbuck', 'udaan',
  'oyo', 'makemytrip', 'goibibo', 'yatra', 'cleartrip',
  'hotstar', 'disney', 'warner', 'prime video',
  'deltek', 'mercor', 'interview kickstart', 'appinventiv',
  'exl', 'bitgo', 'godaddy', 'netweb',
  'menlo security', 'sentilink', 'hurix',
  'jk tech', 'radancy', 'emitrr',
  'impelsys', 'fiftyfive', 'doodleblue',

];

/**
 * Normalize a company name for matching.
 * Strips punctuation, common legal/business suffixes (from the end),
 * and collapses whitespace so "Tech Mahindra Ltd." matches "tech mahindra".
 */
function normalizeCompanyName(name) {
  if (!name) return '';
  let n = name.toLowerCase().trim();

  // Remove punctuation: . - & + , ( ) ® ™ ' "
  n = n.replace(/[.\-&+,()®™'"]/g, ' ');

  // Iteratively strip common suffixes from the end
  const suffixPatterns = [
    /\s+(pvt|private|public)\s+(ltd|limited)\s*$/,
    /\s+(pvt|private|public)\s*$/,
    /\s+(ltd|limited|llc|llp|inc|corp|corporation|gmbh|plc|pte)\s*$/,
    /\s+(india|global|worldwide|usa|uk)\s*$/,
    /\s+(technologies|technology|solutions|software|services|systems|consulting|consultancy|infotech|infosystems|infosolutions|enterprises|ventures|group|labs|lab|digital|co|company)\s*$/,
  ];

  let prev;
  do {
    prev = n;
    for (const re of suffixPatterns) {
      n = n.replace(re, '');
    }
    n = n.replace(/\s+/g, ' ').trim();
  } while (n !== prev);

  return n;
}

// Read names + aliases from the mirror (sub-ms) when loaded, otherwise
// from the legacy file (bootstrap window before the mirror is ready).
function loadHighSalaryCompanies() {
  const names = [];
  if (highSalaryMirror.loaded) {
    for (const d of highSalaryMirror.iter()) {
      if (d.company) names.push(d.company.toLowerCase().trim());
      for (const alias of (d.companyAlias || [])) {
        if (alias) names.push(alias.toLowerCase().trim());
      }
    }
    return names;
  }
  try {
    const filePath = path.join(__dirname, '..', '..', 'high-salary-companies.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const c of data) {
      if (c.company) names.push(c.company.toLowerCase().trim());
      for (const alias of (c.companyAlias || [])) {
        if (alias) names.push(alias.toLowerCase().trim());
      }
    }
  } catch { /* file gone — fine */ }
  return names;
}

// Lookup set: RAW_ENTRIES (curated) ∪ mirror/file (auto-maintained).
// We rebuild whenever the mirror absorbs an upsert so a write on the
// next write to the collection reflects within ~15 s.
let WELL_KNOWN_COMPANIES = new Set();
let _wellKnownFromMirror = false;

function rebuildWellKnown() {
  const set = new Set();
  for (const entry of [...RAW_ENTRIES, ...loadHighSalaryCompanies()]) {
    set.add(entry);
    const norm = normalizeCompanyName(entry);
    if (norm) set.add(norm);
  }
  WELL_KNOWN_COMPANIES = set;
  _wellKnownFromMirror = highSalaryMirror.loaded;
}
rebuildWellKnown();
highSalaryMirror.subscribe?.(() => rebuildWellKnown());

/**
 * Check if a known company name appears as a whole-word match within text.
 * Prevents "ola" matching inside "technolabs" or "ust" inside "ampcustech".
 */
function wordBoundaryMatch(text, term) {
  const re = new RegExp(`(?:^|\\s|\\b)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s|\\b)`);
  return re.test(text);
}

export function isWellKnownCompany(companyName) {
  // First call after the mirror finished its async load — swap the
  // bootstrap-from-file Set for a Set built from the mirror.
  if (highSalaryMirror.loaded && !_wellKnownFromMirror) rebuildWellKnown();
  if (!companyName) return false;
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return false;

  // Direct match (covers both raw and normalized set entries)
  if (WELL_KNOWN_COMPANIES.has(normalized)) return true;

  // Word-boundary substring match with length guards to prevent false positives.
  // Short known names ("ola", "oyo", "sea", "zee", "meta", "apple") only match directly,
  // not as substrings, because they appear too often as common English words.
  for (const known of WELL_KNOWN_COMPANIES) {
    // "known inside normalized" — input contains a known company as a whole word
    // Require known.length >= 6 to avoid "apple" matching "Red Apple Learning"
    if (known.length >= 6 && wordBoundaryMatch(normalized, known)) return true;
    // "normalized inside known" — input is a shortened form of a known company
    if (normalized.length >= 6 && wordBoundaryMatch(known, normalized)) return true;
  }
  return false;
}
