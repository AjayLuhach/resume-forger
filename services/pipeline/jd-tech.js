/**
 * Deterministic technology extraction from a job description.
 *
 * Why this exists: the rewrite step (step 2) used to see only the keyword list
 * the *analysis* step (step 1) chose to emit. Measured across ten open-weight
 * models, that list ranged from 0 to 172 entries for the same JD — so when a
 * model extracted five keywords, the rewrite had five keywords to work with and
 * could not do better no matter how good it was. Resume quality was hostage to
 * one model call's whim.
 *
 * A lexicon scan in plain JS can't be lazy. It gives every model the same floor:
 * "here are the technologies this posting actually names, in the posting's own
 * spelling — cover the ones you honestly can." The model's own analysis is still
 * used on top, for the judgement a regex can't do (phrases, seniority, domain).
 *
 * Scope is deliberately technologies, not "keywords". Benefits copy and company
 * boilerplate are not things a resume can or should match, and counting them was
 * what made the old raw-token score meaningless.
 */

// Multi-word entries first so "Spring Boot" is credited before the bare "Spring",
// and "React Native" before "React".
export const TECH_LEXICON = [
  'Spring Boot', 'React Native', 'Node.js', 'NodeJS', 'React.js', 'ReactJS', 'Next.js',
  'Vue.js', 'VueJS', 'Nuxt', 'AngularJS', 'Angular', 'Svelte', 'Express.js', 'Express',
  'Nest.js', 'NestJS', 'MongoDB', 'Mongoose', 'MySQL', 'PostgreSQL', 'Postgres', 'MSSQL',
  'SQLite', 'Oracle', 'Redis', 'DynamoDB', 'Cassandra', 'Firebase', 'Elasticsearch',
  'TypeScript', 'JavaScript', 'Python', 'Java', 'Kotlin', 'Swift', 'Golang', 'Go', 'Rust',
  'C#', '.NET', 'PHP', 'Ruby', 'Scala', 'Django', 'Flask', 'FastAPI', 'Laravel', 'Rails',
  'Pandas', 'NumPy', 'TensorFlow', 'PyTorch', 'LangChain', 'OpenAI', 'LLM', 'RAG',
  'Machine Learning', 'AWS', 'Azure', 'GCP', 'Google Cloud', 'Lambda', 'S3', 'EC2',
  'CloudWatch', 'Bedrock', 'Docker', 'Kubernetes', 'Terraform', 'Ansible', 'Jenkins',
  'CI/CD', 'GitHub Actions', 'GitLab', 'Kafka', 'RabbitMQ', 'GraphQL', 'gRPC', 'REST',
  'RESTful', 'Microservices', 'WebSocket', 'Socket.io', 'Jest', 'Cypress', 'Playwright',
  'Selenium', 'JUnit', 'Mocha', 'Vitest', 'Android', 'iOS', 'Flutter', 'Tailwind',
  'Bootstrap', 'Material UI', 'SCSS', 'Sass', 'CSS3', 'HTML5', 'Redux', 'Zustand',
  'MobX', 'Webpack', 'Vite', 'Babel', 'Storybook', 'Figma', 'Jira', 'Agile', 'Scrum',
  'Git', 'Linux', 'Nginx', 'Apache', 'Prisma', 'Sequelize', 'TypeORM', 'Supabase',
  'Vercel', 'Netlify', 'OAuth', 'JWT', 'RBAC', 'SSO', 'SAML', 'Stripe', 'Razorpay',
  'Twilio', 'Sentry', 'Grafana', 'Prometheus', 'Datadog', 'Snowflake', 'Airflow', 'dbt',
  // Bare forms, last: job ads write "React and Node with Mongo" far more often
  // than "React.js and Node.js". They must come AFTER the multi-word entries so
  // "React Native" is consumed before bare "React" can match inside it.
  // Deliberately absent: 'Next', 'Nest', 'Spring' — ordinary English words that
  // would fire on "next steps" or "Spring 2026".
  'React', 'Vue', 'Node', 'Mongo',
];

// True synonyms — the same technology under a different spelling. Both sides of
// any comparison get canonicalised, otherwise a JD writing "Go" reads as a miss
// against a resume writing "Golang". Angular/AngularJS are deliberately NOT
// synonyms: different frameworks, and conflating them hides a real gap.
export const TECH_SYNONYMS = {
  golang: 'go',
  'react.js': 'react', reactjs: 'react',
  'node.js': 'node', nodejs: 'node',
  'vue.js': 'vue', vuejs: 'vue',
  'nest.js': 'nest', nestjs: 'nest',
  'express.js': 'express',
  postgres: 'postgresql',
  mongo: 'mongodb',
  sass: 'scss',
  restful: 'rest',
  'google cloud': 'gcp',
  rails: 'ruby on rails',
};

export const canonicalTech = (s) => TECH_SYNONYMS[String(s).toLowerCase()] || String(s).toLowerCase();

const wordBoundary = (term) =>
  new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i');

/**
 * Technologies named in `text`, keyed by canonical form.
 * @returns {Map<string, string>} canonical → the spelling the text actually used
 */
export function findTechWithPositions(text) {
  const out = new Map();
  // Matched spans are blanked out as we go, so a longer term consumes its text
  // before a shorter one can match inside it. Without this, "React Native"
  // would also register bare "React", and "Spring Boot" a bare "Spring" —
  // crediting the resume with a technology the posting never asked for.
  //
  // Blanking preserves length, so an offset recorded here stays valid against
  // the original string — which is what makes JD-order ranking possible.
  let s = String(text || '');
  for (const term of TECH_LEXICON) {
    const rx = wordBoundary(term);
    const m = rx.exec(s);
    if (!m) continue;
    const key = canonicalTech(term);
    // m[1] is the leading boundary character, so skip it to point at the term.
    if (!out.has(key)) out.set(key, { spelling: term, index: m.index + m[1].length });
    s = s.replace(new RegExp(rx.source, 'gi'), (mm) => ' '.repeat(mm.length));
  }
  return out;
}

export function findTech(text) {
  const out = new Map();
  // Insertion order stays lexicon order, as every existing caller expects.
  for (const [key, { spelling }] of findTechWithPositions(text)) out.set(key, spelling);
  return out;
}

/** Just the display spellings, in lexicon order. */
export const listTech = (text) => [...findTech(text).values()];

/**
 * Split a JD's technologies by whether the candidate can honestly claim them.
 *
 * `claimable` is what the rewrite must cover; `absent` is stated explicitly so
 * the model leaves it out rather than quietly inventing it — naming the gap
 * suppresses fabrication better than silence does.
 *
 * @param {string} jobDescription
 * @param {object} resumeData - the resume doc, for skills + cannotClaim
 */
export function splitJobTech(jobDescription, resumeData) {
  const jd = findTech(jobDescription);

  const skills = resumeData?.skills || {};
  const candidateText = [
    ...(skills.frontend || []), ...(skills.backend || []), ...(skills.databases || []),
    ...(skills.toolsDevOps || []), ...(skills.other || []),
    ...(resumeData?.experience || []).flatMap((e) => [e.title, ...(e.bullets || [])]),
    ...(resumeData?.projects || []).map((p) => `${p.name} ${p.description || ''}`),
  ].join(' ');
  const owned = findTech(candidateText);

  const banned = new Set((resumeData?.meta?.cannotClaim || []).map(canonicalTech));

  const claimable = [];
  const absent = [];
  for (const [key, spelling] of jd) {
    if (owned.has(key) && !banned.has(key)) claimable.push(spelling);
    else absent.push(spelling);
  }
  return { all: [...jd.values()], claimable, absent };
}

export default {
  TECH_LEXICON, TECH_SYNONYMS, canonicalTech,
  findTech, findTechWithPositions, listTech, splitJobTech,
};
