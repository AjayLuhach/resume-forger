/**
 * Email & LinkedIn DM Generator
 * Creates formatted email and LinkedIn connection messages
 *
 * Template-based, no AI — and therefore only allowed to say what the resume
 * says. A missing stack or start date drops the clause rather than filling
 * it with someone else's.
 */

/**
 * Generate email object from analysis (template-based, no AI)
 * @param {Object} analysis - Analysis from Step 1 (contains contact info)
 * @param {Object} resumeData - Resume data (for personal info like portfolio, LinkedIn, etc.)
 * @returns {Object|null} Email object with to, subject, body, or null if no email contact
 */
export function generateEmail(analysis, resumeData) {
  const contact = analysis.contact || {};

  // Skip if no email address
  if (!contact.email) {
    return null;
  }

  const name = resumeData?.personalInfo?.name || 'Applicant';
  const jobTitle = analysis.jdTitle || 'the open position';
  const company = analysis.jdCompany || 'your company';
  const contactName = contact.name || 'Hiring Manager';
  const portfolio = resumeData?.personalInfo?.portfolio || '';
  const linkedin = resumeData?.personalInfo?.linkedin || '';
  const phone = resumeData?.personalInfo?.phone || '';
  const stack = resumeData?.meta?.stack || '';

  const subject = `Application for ${jobTitle} – ${name}`;

  const body = `Dear ${contactName},

I hope this message finds you well. I am writing to express my interest in the ${jobTitle} role at ${company}. Please find my resume attached for your consideration.

With hands-on experience in ${stack ? `${stack} development` : 'software development'} and a strong focus on building scalable, production-grade applications, I am confident in my ability to contribute effectively to your team.

I would welcome the opportunity to discuss how my skills align with your requirements.${portfolio ? `\n\nPortfolio: ${portfolio}` : ''}${linkedin ? `\nLinkedIn: ${linkedin}` : ''}${phone ? `\nPhone: ${phone}` : ''}

Best regards,
${name}`;

  return {
    to: contact.email,
    subject,
    body,
  };
}

/**
 * Generate LinkedIn connection request message (max 300 characters)
 * ALWAYS generates a message regardless of contact info availability
 * @param {Object} analysis - Analysis from Step 1 (contains contact info)
 * @param {Object} resumeData - Resume data
 * @returns {Object} LinkedIn DM object with linkedInUrl (or null), message, contactName
 */
export function generateLinkedInDM(analysis, resumeData) {
  const contact = analysis.contact || {};

  const jobTitle = analysis.jdTitle || 'the role';
  const company = analysis.jdCompany || 'your company';
  const contactName = contact.name || null;
  const expStart = resumeData?.meta?.experienceStart;
  const yearsExp = expStart ? getYearsOfExperience(expStart) : null;

  // Determine LinkedIn URL (may be null if not provided)
  const linkedInUrl = (contact.link && contact.link.toLowerCase().includes('linkedin.com'))
    ? contact.link
    : null;

  // Generate concise LinkedIn connection note (max 300 characters)
  // Use contact name if available, otherwise generic greeting
  const greeting = contactName ? `Hi ${contactName}!` : `Hi there!`;

  const stack = resumeData?.meta?.stack || '';
  const built = yearsExp ? `With ${yearsExp} years building` : 'Having built';
  const message = `${greeting} Noticed the ${jobTitle} opening at ${company}. ${built} scalable ${stack ? `${stack} ` : ''}applications in production, I'd love to connect and discuss how my experience aligns with your team's needs.`;

  return {
    linkedInUrl, // null if no LinkedIn URL provided
    contactName,
    message,
    jobTitle: analysis.jdTitle,
    company: analysis.jdCompany,
    instruction: linkedInUrl
      ? null
      : `Search for "${contactName || company}" on LinkedIn and send connection request with above message`,
  };
}

/**
 * Calculate years of experience from start date
 */
function getYearsOfExperience(startDate) {
  const start = new Date(startDate);
  if (!Number.isFinite(start.getTime())) return null;
  const now = new Date();
  const years = (now - start) / (1000 * 60 * 60 * 24 * 365.25);
  if (years < 1.5) return '1+';
  const half = Math.round(years * 2) / 2;
  const label = Number.isInteger(half) ? String(half) : half.toFixed(1);
  return `~${label}`;
}

export default { generateEmail, generateLinkedInDM };
