/**
 * ATS_MAX_MODE — Semantic Expansion Utilities
 *
 * Maps specific technologies to broader ATS-friendly equivalent terms.
 * Only applied when the candidate actually possesses the source skill.
 *
 * This file contains DATA and UTILITY functions only — no prompt text.
 * Prompt text lives in prompts-ats-max.js.
 */

export const SEMANTIC_EXPANSION_MAP = {
  // Frontend
  'react': ['React.js', 'Front-End Development', 'UI Development', 'Component-Based UI'],
  'react.js': ['React', 'Front-End Development', 'UI Development', 'Component-Based UI'],
  'next.js': ['Server-Side Rendering', 'SSR', 'SEO-Friendly Frontend', 'React Framework'],
  'nextjs': ['Server-Side Rendering', 'SSR', 'SEO-Friendly Frontend', 'React Framework'],
  'redux toolkit': ['State Management', 'Redux'],
  'redux': ['State Management'],
  'tailwind css': ['Responsive UI Styling', 'Utility-First CSS'],
  'tailwindcss': ['Responsive UI Styling', 'Utility-First CSS'],

  // Backend
  'node.js': ['Node', 'Backend Development', 'Server-Side Development', 'API Development', 'Backend Infrastructure'],
  'node': ['Node.js', 'Backend Development', 'Server-Side Development', 'API Development', 'Backend Infrastructure'],
  'express': ['Express.js', 'Backend Web Framework', 'REST API Development', 'API-Driven Architecture'],
  'express.js': ['Express', 'Backend Web Framework', 'REST API Development', 'API-Driven Architecture'],

  // Databases
  'mongodb': ['NoSQL Database', 'Database Design', 'Document Database', 'Data Storage Solutions'],
  'mongoose': ['MongoDB ODM', 'Database Modeling'],
  'postgresql': ['SQL Database', 'Relational Database', 'Database Design', 'Data Storage Solutions'],
  'postgres': ['PostgreSQL', 'SQL Database', 'Relational Database'],
  'mysql': ['SQL Database', 'Relational Database', 'Data Storage Solutions'],
  'redis': ['In-Memory Cache', 'Caching Layer', 'Caching Solutions'],

  // Real-time
  'websockets': ['Real-Time Communication', 'Real-Time Features', 'WebSocket Protocol', 'Event-Driven Architecture'],
  'socket.io': ['Real-Time Communication', 'Real-Time Features', 'WebSockets', 'Event-Driven Architecture'],

  // DevOps & Cloud
  'github actions': ['CI/CD Workflows', 'Deployment Automation', 'CI/CD', 'Automated Pipelines'],
  'ci/cd': ['CI/CD Workflows', 'Deployment Automation', 'Continuous Integration', 'Automated Pipelines'],
  'ci/cd pipelines': ['CI/CD Workflows', 'Deployment Automation', 'Continuous Integration', 'Automated Pipelines'],
  'docker': ['Containerization', 'Container Management', 'Infrastructure Automation'],
  'aws': ['Cloud Deployment', 'AWS Infrastructure', 'Cloud Computing', 'Cloud Services'],
  'ec2': ['AWS EC2', 'Cloud Compute', 'AWS Infrastructure', 'Cloud Deployment'],
  's3': ['AWS S3', 'Cloud Storage', 'AWS Infrastructure'],
  'nginx': ['Reverse Proxy', 'Load Balancing', 'Web Server Configuration'],

  // Languages
  'javascript': ['JS', 'ECMAScript', 'ES6+'],
  'javascript (es6+)': ['JS', 'ECMAScript', 'JavaScript'],
  'typescript': ['Typed JavaScript', 'Static Typing'],

  // Tools & Practices
  'git': ['Version Control', 'Git Workflow'],
  'rest apis': ['RESTful Services', 'API Design', 'HTTP APIs', 'API-Driven Architecture'],
  'rest api': ['RESTful Services', 'API Design', 'HTTP APIs', 'API-Driven Architecture'],
  'jwt': ['Token-Based Authentication', 'Auth Tokens', 'Secure Authentication'],
  'ssr': ['Server-Side Rendering', 'SEO-Friendly Frontend'],
  'jest': ['Unit Testing', 'Test-Driven Development', 'Automated Testing'],
  'agile': ['Agile Methodology', 'Agile Development', 'Iterative Development'],
  'scrum': ['Scrum Methodology', 'Sprint Planning'],
  'system design': ['Scalable Architecture', 'System Architecture', 'High-Availability Systems'],
  'performance optimization': ['Performance Tuning', 'Speed Optimization', 'Scalability'],
  'code reviews': ['Code Quality', 'Peer Review', 'Technical Leadership'],
};

/**
 * Get semantically expanded skills for a candidate based on their actual skills.
 * Only returns expansions for skills the candidate genuinely has.
 */
export function getSemanticExpansions(resumeSkills) {
  const allSkills = [
    ...(resumeSkills.frontend || []),
    ...(resumeSkills.backend || []),
    ...(resumeSkills.toolsDevOps || []),
    ...(resumeSkills.databases || []),
    ...(resumeSkills.other || []),
  ];

  const expansions = new Set();

  for (const skill of allSkills) {
    const key = skill.toLowerCase().trim();
    if (SEMANTIC_EXPANSION_MAP[key]) {
      SEMANTIC_EXPANSION_MAP[key].forEach(exp => expansions.add(exp));
    }
  }

  return [...expansions];
}

/**
 * Filter semantic expansions against cannotClaim list.
 */
export function getSafeExpansions(resumeSkills, cannotClaim = []) {
  const expansions = getSemanticExpansions(resumeSkills);
  const blocked = new Set(cannotClaim.map(s => s.toLowerCase()));
  return expansions.filter(exp => !blocked.has(exp.toLowerCase()));
}

export default {
  SEMANTIC_EXPANSION_MAP,
  getSemanticExpansions,
  getSafeExpansions,
};
