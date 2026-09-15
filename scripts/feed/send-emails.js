#!/usr/bin/env node

/**
 * Email Sender CLI
 * Sends the approved-but-unsent drafts in `user_emails`.
 *
 * SMTP credentials are fetched from mongo at send-time from the user's
 * emailConfig, so password/SMTP changes made in /settings are picked up
 * immediately on the next run.
 *
 * Identity: `--user "<name>"` when given, otherwise the sole document in the
 * `users` collection (see services/users/current.js). No env fallback.
 *
 * Usage:
 *   node scripts/feed/send-emails.js [--user "<name>"]            # send
 *   node scripts/feed/send-emails.js [--user "<name>"] --verify   # test SMTP connection
 *   node scripts/feed/send-emails.js [--user "<name>"] --list     # list approved unsent emails
 */

import {
  sendEmail,
  verifyConnection,
} from "../../services/feed/email-sender.js";
import {
  fetchUserEmails,
  markUserEmailSent,
} from "../../services/feed/posts-store.js";
import { isValidEmail } from "../../services/feed/email-validator.js";
import { verifyEmail } from "../../services/feed/email-verifier.js";
import { resolveCliUser } from "../../services/users/current.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const has = (name) => args.includes(name);

let USERNAME;
try {
  USERNAME = await resolveCliUser(flag('--user'), { command: 'send-emails' });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

/** Fetch approved, unsent emails for the user. */
async function getApprovedUnsent() {
  const emails = await fetchUserEmails(USERNAME, 'approved');
  return emails.filter(e => !e.sentAt && e.email?.to);
}

async function main() {
  console.log(`\n   EMAIL SENDER CLI — user: ${USERNAME}\n`);

  if (has("--verify")) {
    console.log("   Testing SMTP connection...");
    const success = await verifyConnection({ username: USERNAME });
    process.exit(success ? 0 : 1);
  }

  if (has("--list")) {
    const unsent = await getApprovedUnsent();
    if (unsent.length === 0) {
      console.log("   No approved unsent emails found");
      process.exit(0);
    }
    console.log(`   Found ${unsent.length} approved unsent email(s):\n`);
    unsent.forEach((c, i) => {
      console.log(`   ${i + 1}. ${c.email.to}`);
      console.log(`      Job: ${c.job?.title || 'Unknown'} at ${c.job?.company || 'Unknown'}`);
      console.log(`      Score: ${c.score || '?'}/10`);
      console.log(`      Subject: ${c.email?.subject || 'N/A'}`);
      console.log('');
    });
    process.exit(0);
  }

  console.log(`   Sending approved unsent emails for "${USERNAME}"\n`);

  const unsent = await getApprovedUnsent();
  if (unsent.length === 0) {
    console.log("   No approved unsent emails found");
    process.exit(0);
  }
  console.log(`   Found ${unsent.length} approved unsent email(s)\n`);

  const connected = await verifyConnection({ username: USERNAME });
  if (!connected) {
    throw new Error(`SMTP connection failed for "${USERNAME}" — check Settings → SMTP`);
  }

  const results = { sent: 0, failed: 0, skipped: 0, invalid: 0, errors: [] };

  for (let i = 0; i < unsent.length; i++) {
    const contact = unsent[i];
    const to = contact.email?.to;

    if (!to || !isValidEmail(to)) {
      console.log(`   [INVALID] Skipping ${to || '(empty)'}`);
      results.invalid++;
      continue;
    }

    const check = await verifyEmail(to);
    if (!check.verified) {
      console.log(`   [SKIP] ${to}: ${check.error}`);
      results.skipped++;
      continue;
    }

    const emailData = {
      to,
      subject: contact.email.subject || `Application for ${contact.job?.title || 'open position'}`,
      body: contact.email.body || `Dear Hiring Manager,\n\nI am interested in the ${contact.job?.title || 'open position'}. Please find my resume attached.\n\nBest regards`,
    };

    try {
      const result = await sendEmail(emailData, { username: USERNAME });
      if (result.success) {
        await markUserEmailSent(USERNAME, contact.postId);
        results.sent++;
      } else {
        results.failed++;
        results.errors.push({ to, error: result.error });
      }
    } catch (error) {
      console.error(`   [ERROR] ${to}: ${error.message}`);
      results.failed++;
      results.errors.push({ to, error: error.message });
    }

    if (i < unsent.length - 1) {
      const delaySec = Math.floor(Math.random() * 35) + 120; // 120-155 seconds
      console.log(`   Waiting ${delaySec}s before next email...`);
      await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
    }
  }

  console.log("\n   SUMMARY:");
  console.log(`   Sent:    ${results.sent}`);
  console.log(`   Skipped: ${results.skipped}`);
  console.log(`   Invalid: ${results.invalid}`);
  console.log(`   Failed:  ${results.failed}`);

  if (results.errors.length > 0) {
    console.log("\n   ERRORS:");
    results.errors.forEach((err) => console.log(`   ${err.to}: ${err.error}`));
  }

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("\n   FATAL ERROR:", error.message);
  process.exit(1);
});
