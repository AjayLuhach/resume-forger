/**
 * Groups the tailored flat skills line into the labelled rows a recruiter reads
 * ("Frontend: …", "Backend: …", "AI / LLM: …").
 *
 * The AI still emits `skl` as one comma-separated string — deliberately. That
 * string is what `ats-scorer.js` matches against and what every stored variant,
 * log and dashboard already carries; turning it into a nested object would
 * ripple through all of them for a purely visual gain. Grouping is therefore a
 * render-time concern and lives here.
 *
 * Assignment order, first hit wins:
 *   1. the LEXICON below — the only way to get "AI / LLM" and "Databases" rows,
 *      since a candidate's stored buckets are frontend/backend/toolsDevOps/other
 *      and bury Bedrock next to Jira and MongoDB next to Express;
 *   2. the candidate's OWN `resumeData.skills` bucket, so a skill this file has
 *      never heard of still lands where its owner filed it;
 *   3. `Practices`, the catch-all.
 */

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#]/g, '');

// How many entries the catch-all row prints before it stops. See groupSkills.
const PRACTICES_MAX = 6;

// Display rows, in print order. Empty rows are dropped at render time.
export const GROUP_ORDER = [
  'Frontend',
  'Backend',
  'AI / LLM',
  'Databases',
  'DevOps',
  'Testing',
  'Practices',
];

// Exact (normalized) skill → row. Only entries that need to override the
// candidate's own bucket belong here; everything else can fall through.
const LEXICON = {
  'AI / LLM': [
    'OpenAI', 'Anthropic', 'Claude', 'GPT-4', 'GPT-5', 'Gemini', 'Google Gemini API',
    'AWS Bedrock', 'Bedrock', 'LLM', 'LLMs', 'LLM API Integration', 'AI API Integration',
    'RAG', 'Retrieval-Augmented Generation', 'Vector Search', 'MongoDB Atlas Vector Search',
    'Embeddings', 'Model Context Protocol (MCP)', 'MCP', 'Model Context Protocol',
    'Prompt Engineering', 'Vercel AI SDK', 'LangChain', 'LlamaIndex', 'Hugging Face',
    'Multi-Agent Systems', 'Multi-Agent', 'AI Agents', 'Agentic Workflows', 'Fine-Tuning',
    'AssemblyAI', 'Whisper', 'Ollama', 'GitHub Copilot', 'Cursor', 'Claude Code', 'Codex',
  ],
  Databases: [
    'MongoDB', 'Mongo', 'MongoDB Atlas', 'PostgreSQL', 'Postgres', 'MySQL', 'SQL',
    'NoSQL', 'Redis', 'SQLite', 'Oracle', 'MSSQL', 'SQL Server', 'DynamoDB', 'Cassandra',
    'Elasticsearch', 'Supabase', 'Firebase', 'Firestore', 'Snowflake',
    'MongoDB Indexing', 'MongoDB Aggregation', 'Advanced MongoDB', 'Query Optimization',
    'Database Design', 'Schema Design', 'Schema Versioning', 'Database Migrations',
    'Indexing', 'Aggregation Pipelines',
  ],
  Frontend: [
    'React', 'React.js', 'ReactJS', 'Next.js', 'Next', 'Vue', 'Vue 3', 'Vue.js', 'Nuxt',
    'Angular', 'AngularJS', 'Svelte', 'TypeScript', 'JavaScript', 'JavaScript (ES6+)',
    'ES6+', 'HTML5', 'HTML', 'CSS3', 'CSS', 'CSS3/SCSS', 'SCSS', 'Sass', 'Tailwind',
    'Tailwind CSS', 'Material UI', 'MUI', 'Bootstrap', 'shadcn/ui', 'Radix UI',
    'Redux', 'Redux Toolkit', 'Zustand', 'MobX', 'React Query', 'TanStack Query',
    'Webpack', 'Vite', 'Babel', 'Storybook', 'SSR', 'SSG', 'Responsive Design',
    'Accessibility', 'Micro-frontend Architecture', 'Component-Based Architecture',
    'Core Web Vitals', 'Lighthouse', 'Code Splitting', 'Lazy Loading',
    'Frontend Development', 'UI Development',
  ],
  Backend: [
    'Node.js', 'Node', 'Express', 'Express.js', 'Nest.js', 'NestJS', 'Fastify',
    'Python', 'FastAPI', 'Django', 'Flask', 'Pydantic', 'Celery',
    'REST', 'REST APIs', 'RESTful', 'GraphQL', 'gRPC', 'WebSockets', 'WebSocket',
    'Socket.io', 'Server-Sent Events', 'SSE', 'Message Queues',
    'JWT', 'OAuth', 'OAuth2', 'RBAC', 'Role-Based Access Control (RBAC)',
    'Policy-Based Access Control', 'Authentication', 'Authorization', 'Sessions',
    'Express Middleware', 'Sequelize', 'Mongoose', 'Prisma', 'TypeORM', 'Alembic',
    'Joi', 'Yup', 'Input Validation', 'Microservices', 'Webhooks',
    // Phrasings the rewrite step actually emits, observed on real runs — without
    // these, "REST API design" reads as a practice and lands in the catch-all row.
    'API Design', 'REST API Design', 'API Development', 'Backend Development',
    'Server-Side Development',
    'WhatsApp Business API', 'Meta Graph API',
  ],
  DevOps: [
    'AWS', 'EC2', 'S3', 'Lambda', 'CloudWatch', 'Azure', 'GCP', 'Google Cloud',
    'Docker', 'Docker Compose', 'Kubernetes', 'Nginx', 'Apache', 'Linux', 'Unix',
    'Bash', 'SSH', 'Terraform', 'Ansible', 'Jenkins', 'CI/CD', 'CI/CD Pipelines',
    'GitHub Actions', 'Github Actions', 'GitLab CI', 'Git', 'GitHub', 'GitLab',
    'Vercel', 'Netlify', 'Heroku', 'Cloudflare', 'Blue-Green Deployment',
    'Monitoring & Logging', 'Application Monitoring', 'Grafana', 'Prometheus',
    'Sentry', 'Datadog',
  ],
  Testing: [
    'Jest', 'Vitest', 'Mocha', 'Chai', 'Supertest', 'Cypress', 'Playwright',
    'Selenium', 'JUnit', 'React Testing Library', 'Testing Library', 'TDD', 'BDD',
    'Unit Testing', 'Integration Testing', 'E2E Testing', 'Postman',
  ],
};

// Flatten LEXICON into normalized lookup once at module load.
const LEXICON_INDEX = new Map();
for (const [group, entries] of Object.entries(LEXICON)) {
  for (const entry of entries) {
    const k = norm(entry);
    if (k && !LEXICON_INDEX.has(k)) LEXICON_INDEX.set(k, group);
  }
}

// The candidate's own stored bucket names → display rows.
const BUCKET_TO_GROUP = {
  frontend: 'Frontend',
  backend: 'Backend',
  databases: 'Databases',
  database: 'Databases',
  toolsdevops: 'DevOps',
  devops: 'DevOps',
  tools: 'DevOps',
  ai: 'AI / LLM',
  aillm: 'AI / LLM',
  testing: 'Testing',
  other: 'Practices',
};

/**
 * Build normalized skill → display row from the candidate's own skills object.
 * @param {object} resumeSkills - resumeData.skills, { bucket: [skill, …] }
 */
function buildOwnerIndex(resumeSkills) {
  const index = new Map();
  if (!resumeSkills || typeof resumeSkills !== 'object') return index;
  for (const [bucket, list] of Object.entries(resumeSkills)) {
    if (!Array.isArray(list)) continue;
    const group = BUCKET_TO_GROUP[norm(bucket)] || 'Practices';
    for (const skill of list) {
      const k = norm(skill);
      if (k && !index.has(k)) index.set(k, group);
    }
  }
  return index;
}

/**
 * Split a tailored skills line into labelled rows.
 *
 * @param {string|string[]} skills - the AI's `skl` output
 * @param {object} resumeData - the candidate's resume payload (for its buckets)
 * @returns {{label: string, skills: string[]}[]} non-empty rows, in print order
 */
export function groupSkills(skills, resumeData) {
  const list = (Array.isArray(skills) ? skills : String(skills || '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);

  const ownerIndex = buildOwnerIndex(resumeData?.skills);
  const buckets = new Map(GROUP_ORDER.map((g) => [g, []]));
  const seen = new Set();

  for (const skill of list) {
    const k = norm(skill);
    if (!k || seen.has(k)) continue; // the model does repeat itself
    seen.add(k);
    const group = LEXICON_INDEX.get(k) || ownerIndex.get(k) || 'Practices';
    buckets.get(group).push(skill);
  }

  const rows = GROUP_ORDER
    .map((label) => ({ label, skills: buckets.get(label) }))
    .filter((row) => row.skills.length > 0);

  // The catch-all row is where the rewrite step's generic ATS claims land —
  // measured on a real run: "modern user interfaces", "enterprise applications",
  // "third-party platforms", "external services", "digital experiences". Those
  // earn their place in `skl` because `ats-scorer.js` matches the JD's keywords
  // against that string, but printed in full they were three lines of vague
  // prose at the bottom of the skills section.
  //
  // So the cap is DISPLAY ONLY. `skl` is untouched, the scorer still sees every
  // term, and the stored variant still round-trips — the page just stops
  // showing the tail. Order is the model's own, so the concrete terms it ranked
  // first are the ones that survive.
  const catchAll = rows.find((r) => r.label === 'Practices');
  if (catchAll) catchAll.skills = catchAll.skills.slice(0, PRACTICES_MAX);

  // A row holding one skill ("Testing: Jest") wastes a line and reads as an
  // afterthought, so it folds into the row above under a combined label.
  //
  // Two guards, both learned the hard way: the row above must be substantial
  // (>= 2 skills), and it may absorb at most one orphan. Without them a short
  // skills list — where EVERY row holds one skill — cascades into a single row
  // labelled "Frontend & Backend & AI / LLM & Databases & DevOps". A genuinely
  // small list is better printed as small rows.
  const merged = [];
  for (const row of rows) {
    const prev = merged[merged.length - 1];
    if (row.skills.length === 1 && prev && prev.skills.length >= 2 && !prev.absorbed) {
      prev.label = `${prev.label} & ${row.label}`;
      prev.skills.push(...row.skills);
      prev.absorbed = true;
    } else {
      merged.push({ label: row.label, skills: [...row.skills] });
    }
  }
  // Second pass: an orphan the loop above could not place — because the row
  // before it had already absorbed one — folds into the row BELOW instead.
  // Observed on a real frontend JD, which left "DevOps: CI/CD pipelines" alone
  // on its own line between two full rows.
  for (let i = merged.length - 1; i >= 0; i--) {
    const row = merged[i];
    const next = merged[i + 1];
    if (row.skills.length === 1 && next && next.skills.length >= 2 && !next.absorbed) {
      next.label = `${row.label} & ${next.label}`;
      next.skills = [...row.skills, ...next.skills];
      next.absorbed = true;
      merged.splice(i, 1);
    }
  }

  return merged.map(({ label, skills }) => ({ label, skills }));
}

export default { groupSkills, GROUP_ORDER };
