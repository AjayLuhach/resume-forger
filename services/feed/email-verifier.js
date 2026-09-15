/**
 * Email Verifier Service
 * Lightweight verification for small-volume cold email:
 *   1. Junk/role-based email filter (noreply@, info@, etc.)
 *   2. DNS MX record lookup (does the domain accept email?)
 */

import dns from 'dns';
import dotenv from 'dotenv';
import { isValidEmail } from './email-validator.js';

dotenv.config();

const MX_TIMEOUT = Number(process.env.VERIFY_MX_TIMEOUT || 5000);

// ============================================================
// JUNK / ROLE-BASED EMAIL FILTER
// ============================================================

const JUNK_PREFIXES = [

  // Auto / System
  'noreply', 'no-reply', 'no_reply',
  'donotreply', 'do-not-reply', 'do_not_reply',
  'autoreply', 'auto-reply', 'auto_reply',
  'mailer-daemon', 'postmaster',
  'bounce', 'bounces',
  'return', 'returns',

  // Abuse / Security / Legal sinks
  'abuse', 'spam', 'security', 'phishing',
  'complaints', 'privacy', 'gdpr',
  'legal-notices', 'compliance',

  // Infrastructure / Server
  'hostmaster', 'root', 'system',
  'systems', 'server', 'servers',
  'daemon',

  // Notification-only mailboxes
  'notifications', 'notification',
  'alerts', 'alert',
  'updates', 'update',
  'newsletter', 'newsletters',
  'noresponse', 'no-response',

  // Monitoring / Automation
  'monitoring', 'status',
  'health', 'healthcheck',
  'robot', 'bots', 'bot',

  // Accounting automation (usually tool-driven)
  'invoices', 'billing-notify',
  'accounts-payable', 'accounts-receivable'
];

/**
 * Check if an email is a junk/role-based address unlikely to be read by a person.
 * @param {string} email
 * @returns {{ isJunk: boolean, reason: string|null }}
 */
export function checkJunk(email) {
  const local = email.split('@')[0].toLowerCase();

  for (const prefix of JUNK_PREFIXES) {
    if (local === prefix || local.startsWith(prefix + '+')) {
      return { isJunk: true, reason: `Role-based address: ${prefix}@` };
    }
  }

  return { isJunk: false, reason: null };
}

// ============================================================
// MX RECORD LOOKUP
// ============================================================

/**
 * Verify that the email's domain has valid MX records.
 * Falls back to A record check per RFC 5321 Section 5.1.
 * @param {string} email
 * @returns {Promise<{valid: boolean, mxRecords: Array, error: string|null}>}
 */
export async function verifyMX(email) {
  const domain = email.split('@')[1];
  if (!domain) {
    return { valid: false, mxRecords: [], error: 'No domain in email address' };
  }

  try {
    const mxRecords = await withTimeout(
      dns.promises.resolveMx(domain),
      MX_TIMEOUT,
      `MX lookup timeout for ${domain}`
    );

    if (mxRecords && mxRecords.length > 0) {
      mxRecords.sort((a, b) => a.priority - b.priority);
      return { valid: true, mxRecords, error: null };
    }

    return { valid: false, mxRecords: [], error: `No MX records for ${domain}` };
  } catch (err) {
    // Fallback: check A records (RFC 5321 — domain itself can accept mail)
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
      try {
        const addresses = await withTimeout(
          dns.promises.resolve4(domain),
          MX_TIMEOUT,
          `A record lookup timeout for ${domain}`
        );
        if (addresses && addresses.length > 0) {
          return {
            valid: true,
            mxRecords: [{ exchange: domain, priority: 0 }],
            error: null,
          };
        }
      } catch {
        // Also no A records
      }

      return { valid: false, mxRecords: [], error: `Domain ${domain} has no MX or A records` };
    }

    return { valid: false, mxRecords: [], error: err.message };
  }
}

// ============================================================
// ORCHESTRATOR
// ============================================================

/**
 * Verify an email address: format check → junk filter → MX lookup.
 * @param {string} email
 * @returns {Promise<{ email, verified, method, isCatchAll, details, error }>}
 */
export async function verifyEmail(email) {
  if (!isValidEmail(email)) {
    return { email, verified: false, method: 'format', isCatchAll: false, details: {}, error: 'Invalid email format' };
  }

  // Junk filter
  const junk = checkJunk(email);
  if (junk.isJunk) {
    return { email, verified: false, method: 'junk', isCatchAll: false, details: { junk }, error: junk.reason };
  }

  // MX lookup
  const mx = await verifyMX(email);
  if (!mx.valid) {
    return { email, verified: false, method: 'mx', isCatchAll: false, details: { mx }, error: mx.error };
  }

  return { email, verified: true, method: 'mx', isCatchAll: false, details: { mx }, error: null };
}

// ============================================================
// UTILITIES
// ============================================================

function withTimeout(promise, ms, errorMsg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms)),
  ]);
}

export default { verifyEmail, verifyMX, checkJunk };
