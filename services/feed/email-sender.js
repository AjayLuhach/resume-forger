/**
 * Email Sender Service
 *
 * Sends mail via nodemailer using per-user SMTP credentials pulled from
 * mongo `resumes.<username>.emailConfig` at every call — so a user can
 * edit their SMTP/password in the Settings page and the next Send picks
 * up the latest credentials without a server restart.
 *
 * Resume PDF attachment comes from mongo `resumes.<username>.pdf`. There
 * is no SMTP_* / FROM_NAME / RESUME_PATH env fallback — every send must
 * be tied to a user that has both an emailConfig and a master PDF saved
 * via the UI.
 */

import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { isValidEmail } from "./email-validator.js";
import { getUserPdf, getVariantPdf, getEmailConfig } from "../resume-store.js";

dotenv.config();

// ============================================================
// CONFIG RESOLUTION (mongo only)
// ============================================================

/**
 * Resolve the SMTP config for a given username. Always re-fetches from
 * mongo (no caching) so edits in /settings take effect immediately.
 * Throws if the user has no emailConfig.
 */
async function resolveSmtpConfig(username) {
  if (!username) {
    throw new Error('Username required — SMTP creds are per-user in Settings.');
  }
  const cfg = await getEmailConfig(username);
  if (!cfg?.smtp?.host || !cfg.smtp?.user || !cfg.smtp?.pass) {
    throw new Error(`No SMTP config in mongo for "${username}". Open /settings and fill in Email sending (SMTP) first.`);
  }
  return cfg;
}

function buildTransporter(cfg) {
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
  });
}

// ============================================================
// RESUME ATTACHMENT (per-user, cached for the process lifetime)
// ============================================================

const _resumeCache = new Map(); // username -> Promise<attachment | null>

async function getResumeAttachment(username, variantId = null) {
  if (!username) return null;
  // Drafts from the tailor flow carry the variant generated for that JD:
  // attach that PDF, not the master resume. Falls back to the master if the
  // variant has no bytes (disk-backed batch variants keep only a path).
  if (variantId) {
    try {
      const v = await getVariantPdf(variantId);
      if (v?.buffer) {
        return { filename: v.filename || 'resume.pdf', content: v.buffer, contentType: v.contentType || 'application/pdf' };
      }
    } catch (err) {
      console.warn(`   Tailored PDF fetch failed for variant ${variantId} (${err.message}) — using the master resume`);
    }
  }
  if (_resumeCache.has(username)) return _resumeCache.get(username);
  const promise = (async () => {
    try {
      const pdf = await getUserPdf(username);
      if (pdf?.buffer) {
        return { filename: pdf.filename, content: pdf.buffer, contentType: pdf.contentType };
      }
    } catch (err) {
      console.warn(`   Resume mongo fetch failed for "${username}" (${err.message})`);
    }
    return null;
  })();
  _resumeCache.set(username, promise);
  return promise;
}

// Drop the cached resume for a user — Resume page calls this after a
// fresh PDF upload so the next send attaches the new one.
export function invalidateResumeCache(username) {
  if (username) _resumeCache.delete(username);
  else _resumeCache.clear();
}

// ============================================================
// VERIFY
// ============================================================

/**
 * @param {Object} opts
 * @param {string} opts.username - mongo emailConfig key
 */
export async function verifyConnection(opts = {}) {
  try {
    const cfg = await resolveSmtpConfig(opts.username);
    await buildTransporter(cfg).verify();
    console.log(`   [OK] SMTP connection verified for ${opts.username}`);
    return true;
  } catch (error) {
    console.error("   [FAIL] SMTP connection failed:", error.message);
    return false;
  }
}

// ============================================================
// SEND
// ============================================================

/**
 * Send a single email.
 *
 * @param {Object} emailData - { to, subject, body }
 * @param {Object} opts
 * @param {string} opts.username - mongo emailConfig key (REQUIRED)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string, to: string|null}>}
 */
export async function sendEmail(emailData, opts = {}) {
  const { to, subject, body } = emailData;
  const username = opts.username;

  if (!username) {
    const error = "username required";
    console.error(`   [FAIL] ${to || '(no recipient)'}: ${error}`);
    return { success: false, error, to: to || null };
  }
  if (!to || !subject || !body) {
    const error = "Email must have to, subject, and body";
    console.error(`   [FAIL] ${to || '(no recipient)'}: ${error}`);
    return { success: false, error, to: to || null };
  }
  if (!isValidEmail(to)) {
    const error = "Invalid email address format";
    console.error(`   [FAIL] ${to}: ${error}`);
    return { success: false, error, to };
  }

  // Test mode: redirect emails to a test inbox. Kept as env-only since
  // it's a debug toggle, not user-facing config. There is no default inbox:
  // a redirect target that belongs to nobody in particular would either
  // bounce or, worse, deliver a stranger's application to a shared mailbox.
  const testMode = process.env.EMAIL_TEST_MODE === 'true';
  const testInbox = (process.env.EMAIL_TEST_INBOX || '').trim();
  if (testMode && !isValidEmail(testInbox)) {
    const error = testInbox
      ? `EMAIL_TEST_MODE=true but EMAIL_TEST_INBOX ("${testInbox}") is not a valid address`
      : 'EMAIL_TEST_MODE=true but EMAIL_TEST_INBOX is unset — set it to the inbox that should receive redirected mail';
    console.error(`   [FAIL] ${to}: ${error}`);
    return { success: false, error, to };
  }
  const actualRecipient = testMode ? testInbox : to;
  if (testMode) console.log(`   [TEST MODE] Redirecting ${to} -> ${actualRecipient}`);

  let cfg;
  try {
    cfg = await resolveSmtpConfig(username);
  } catch (err) {
    console.error(`   [FAIL] ${actualRecipient}: ${err.message}`);
    return { success: false, error: err.message, to: actualRecipient };
  }

  const attachments = [];
  const resume = await getResumeAttachment(username, emailData.variantId || null);
  if (resume) attachments.push(resume);
  else console.warn(`   Email will be sent without resume attachment (no PDF in mongo for "${username}")`);

  try {
    const info = await buildTransporter(cfg).sendMail({
      from: `"${cfg.fromName || username}" <${cfg.smtp.user}>`,
      to: actualRecipient,
      subject,
      text: body,
      attachments,
    });

    console.log(`   [SENT] ${actualRecipient} | messageId=${info.messageId}`);
    return { success: true, messageId: info.messageId, to: actualRecipient };
  } catch (error) {
    console.error(`   [FAIL] ${actualRecipient}: ${error.message}`);
    return { success: false, error: error.message, to: actualRecipient };
  }
}

export default {
  sendEmail,
  verifyConnection,
  invalidateResumeCache,
};
