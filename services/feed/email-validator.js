/**
 * Email Validator
 * Validates email addresses and filters out non-email values like phone numbers
 */

/**
 * Check if a string is a valid email address
 * @param {string} email - Email address to validate
 * @returns {boolean} True if valid email
 */
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;

  // Remove whitespace
  email = email.trim();

  // Check if it looks like a phone number (contains only digits, +, -, spaces, parentheses)
  const phonePattern = /^[\d\s\+\-\(\)]+$/;
  if (phonePattern.test(email)) {
    return false;
  }

  // Basic email regex pattern
  // Must have: local@domain.tld format
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(email)) {
    return false;
  }

  // Additional checks
  // Email should not start or end with special chars
  if (email.startsWith('.') || email.startsWith('@') || email.endsWith('.') || email.endsWith('@')) {
    return false;
  }

  // Domain part should not have consecutive dots
  const parts = email.split('@');
  if (parts.length !== 2) return false;

  const domain = parts[1];
  if (domain.includes('..')) return false;

  return true;
}

/**
 * Filter an array to only valid email addresses
 * @param {Array<string>} emails - Array of potential email addresses
 * @returns {Array<string>} Array of valid emails only
 */
export function filterValidEmails(emails) {
  if (!Array.isArray(emails)) return [];
  return emails.filter(email => isValidEmail(email));
}

/**
 * Classify a contact value as email, phone, or unknown
 * @param {string} value - Contact value to classify
 * @returns {string} 'email', 'phone', or 'unknown'
 */
export function classifyContact(value) {
  if (!value || typeof value !== 'string') return 'unknown';

  value = value.trim();

  // Check if it's a valid email
  if (isValidEmail(value)) return 'email';

  // Check if it looks like a phone number
  const phonePattern = /^[\d\s\+\-\(\)]+$/;
  if (phonePattern.test(value) && value.replace(/[\s\-\(\)\+]/g, '').length >= 7) {
    return 'phone';
  }

  return 'unknown';
}

export default {
  isValidEmail,
  filterValidEmails,
  classifyContact,
};
