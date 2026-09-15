#!/usr/bin/env node

/**
 * Feed Email Extractor CLI
 *
 * Commands:
 *   node scripts/feed/feed-cli.js parse [--file <path>]                  Parse LinkedIn data → output/extract.json
 *   node scripts/feed/feed-cli.js generate [--user "<name>"]             Phase 1: AI extract → mongo `posts`
 *   node scripts/feed/feed-cli.js emails   [--user "<name>"] [--redraft] Phase 2+3: Score posts → draft emails → user_emails
 *   node scripts/feed/feed-cli.js send     [--user "<name>"]             List unsent emails
 *
 * --user is optional: the `users.username` doc key in mongo (the single
 * source of truth for identity). When omitted, the sole document in `users`
 * is used (services/users/current.js); the flag is only needed while a
 * database still holds several users. No env or resume-name fallback.
 * `parse` never needs a user.
 */

import fs from 'fs';
import path from 'path';
import config, { loadCandidate } from '../../services/feed/feed-config.js';
import { readClipboard, detectAndParse } from '../../services/feed/clipboard.js';
import { appendPosts, getUnprocessedPosts, markProcessed } from '../../services/feed/extract-store.js';
import {
  pushPhase1Posts,
  fetchExistingPostIds,
  fetchHiringPosts,
  fetchUserEmailPostIds,
  pushUserEmails,
} from '../../services/feed/posts-store.js';
import { resolveCliUser } from '../../services/users/current.js';

// ── Temp file helpers for caching AI responses ──
const TEMP_DIR = config.paths.outputDir;
const TEMP_PHASE1 = path.join(TEMP_DIR, '.ai-phase1.json');
const TEMP_PHASE23 = path.join(TEMP_DIR, '.ai-phase23.json');

function saveTempAI(filePath, data) {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`   Cached AI response → ${path.basename(filePath)}`);
}

function loadTempAI(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    console.log(`   Found cached AI response ← ${path.basename(filePath)}`);
    return data;
  } catch { return null; }
}

function removeTempAI(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

// Dynamic AI provider import (Gemini not migrated yet — bedrock only).
async function getPhase1Provider() {
  if (config.aiProvider === 'gemini') {
    throw new Error('Gemini provider not available in this build — set AI_PROVIDER=bedrock in .env');
  }
  const mod = await import('../../services/feed/ai-bedrock.js');
  return mod.extractPhase1;
}

async function getPhase23Provider() {
  // Always use bedrock's scoreAndDraftEmails for Phase 2+3
  // (works with both providers since it takes pre-extracted data)
  const mod = await import('../../services/feed/ai-bedrock.js');
  return mod.scoreAndDraftEmails;
}

// ============================================================
// CLI ARGUMENT PARSING
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const options = { file: null, redraft: false, user: null };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      options.file = args[i + 1];
      i++;
    } else if (args[i] === '--user' && args[i + 1]) {
      options.user = args[i + 1];
      i++;
    } else if (args[i] === '--redraft') {
      options.redraft = true;
    }
  }

  return { command, options };
}

// ============================================================
// COMMAND: parse
// ============================================================

async function cmdParse(options) {
  console.log('\n   PARSE — Extract LinkedIn posts\n');

  let text;
  if (options.file) {
    console.log(`   Reading from file: ${options.file}`);
    if (!fs.existsSync(options.file)) {
      throw new Error(`File not found: ${options.file}`);
    }
    text = fs.readFileSync(options.file, 'utf-8');
  } else {
    text = await readClipboard();
  }

  const result = detectAndParse(text);

  if (result.posts.length === 0) {
    console.log('\n   No posts found in the input.');
    if (result.source === 'raw' || result.source === 'unknown') {
      console.log('   Tip: Copy LinkedIn feed HTML or API JSON response to clipboard.');
    }
    return;
  }

  const { added, skipped, total } = appendPosts(result.posts);

  console.log(`\n   Source:     ${result.source}`);
  console.log(`   Parsed:     ${result.posts.length} posts`);
  console.log(`   New added:  ${added}`);
  console.log(`   Duplicates: ${skipped}`);
  console.log(`   Total:      ${total} posts in extract.json`);
}

// ============================================================
// COMMAND: generate — Phase 1 only → push to mongo `posts`
// ============================================================

async function cmdGenerate(options) {
  const username = await resolveCliUser(options.user, { command: 'generate' });
  const candidate = await loadCandidate(username);

  console.log(`\n   GENERATE — Phase 1: AI Extract → MongoDB (as "${username}")\n`);

  const provider = config.aiProvider;
  console.log(`   AI Provider: ${provider}`);

  if (provider === 'bedrock' && !process.env.BEDROCK_API_KEY) {
    throw new Error('BEDROCK_API_KEY not set in .env (AI_PROVIDER=bedrock)');
  }

  const unprocessed = getUnprocessedPosts();

  if (unprocessed.length === 0) {
    console.log('   No unprocessed posts found.');
    console.log('   Run "node scripts/feed/feed-cli.js parse" first to add posts to extract.json.');
    return;
  }

  console.log(`   Found ${unprocessed.length} unprocessed post(s)`);

  // Pre-filter: skip posts already in mongo (saves AI calls).
  const existingIds = await fetchExistingPostIds();
  const newPosts = unprocessed.filter(p => !existingIds.has(p.id));
  const alreadyInDb = unprocessed.length - newPosts.length;

  if (alreadyInDb > 0) {
    console.log(`   ${alreadyInDb} post(s) already in mongo — marking processed locally`);
    // Safe to mark these immediately: they're already in the DB, no work to do.
    const alreadyIds = unprocessed.filter(p => existingIds.has(p.id)).map(p => p.id);
    if (alreadyIds.length) markProcessed(alreadyIds);
  }

  if (newPosts.length === 0) {
    console.log(`\n   All ${unprocessed.length} post(s) already in mongo. Nothing to extract.`);
    return;
  }

  console.log(`   ${newPosts.length} new post(s) to process with AI`);

  // Phase 1: AI extraction — use cached response if available (from a previous failed mongo write).
  // markProcessed for the AI-targeted batch is deferred until AFTER the AI call returns and we've
  // pushed to mongo. If anything throws (import error, network, bad response), those posts stay
  // unprocessed so the next `feed:generate` retries them instead of silently dropping them.
  let extracted = loadTempAI(TEMP_PHASE1);

  if (!extracted) {
    const extractPhase1 = await getPhase1Provider();
    // The candidate carries the preferences (country, salary floor…) the
    // extraction prompt and pre-filter are phrased in terms of.
    extracted = await extractPhase1(newPosts, candidate);

    if (extracted.length > 0) {
      saveTempAI(TEMP_PHASE1, extracted);
    }
  }

  // AI succeeded (we got here without throwing). Lock in the local processed flag
  // for the AI-targeted batch BEFORE pushing — pushing is idempotent (upsert by
  // postId), so a re-run is safe even if mongo write fails partially.
  const newIds = newPosts.map(p => p.id);
  markProcessed(newIds);

  if (extracted.length === 0) {
    console.log('\n   No hiring posts found in this batch.');
    console.log(`   ${newIds.length} post(s) marked processed (non-hiring or filtered).`);
    removeTempAI(TEMP_PHASE1);
    return;
  }

  // Push hiring posts to the `posts` pool.
  console.log('\n   Saving to mongo `posts`…');
  const { added, skipped } = await pushPhase1Posts(
    extracted,
    unprocessed,
    username,
    { salaryUnit: candidate.preferences?.salaryUnit }
  );

  // Mongo write succeeded — remove temp cache
  removeTempAI(TEMP_PHASE1);

  console.log('\n   ' + '='.repeat(50));
  console.log('   PHASE 1 RESULTS');
  console.log('   ' + '='.repeat(50));
  console.log(`   Posts processed:   ${alreadyInDb + newIds.length} (${alreadyInDb} skipped, ${newIds.length} new)`);
  console.log(`   Hiring posts:      ${extracted.length}`);
  console.log(`   Added to pool:     ${added}`);
  console.log(`   Already in pool:   ${skipped}`);
  console.log('\n   Next: node scripts/feed/feed-cli.js emails');
}

// ============================================================
// COMMAND: emails — Phase 2+3: Score pool posts → draft → user_emails
// ============================================================

async function cmdEmails(options = {}) {
  const username = await resolveCliUser(options.user, { command: 'emails' });
  const candidate = await loadCandidate(username);
  const redraft = options.redraft || false;
  console.log(`\n   EMAILS — Score & Draft for "${username}"${redraft ? ' (REDRAFT mode)' : ''}\n`);

  // Every hiring post in the pool — the whole pool is this user's.
  const hiringPosts = await fetchHiringPosts();

  if (hiringPosts.length === 0) {
    console.log('   No hiring posts in the pool.');
    console.log('   Run "node scripts/feed/feed-cli.js generate" first.');
    return;
  }

  // Filter out posts this user already has a draft for.
  // In redraft mode, include drafted-status rows so they can be re-processed.
  const fetchOpts = redraft ? { excludeStatuses: ["drafted"] } : {};
  const usedIds = await fetchUserEmailPostIds(username, fetchOpts);
  const fresh = hiringPosts.filter(p => !usedIds.has(p.postId));

  if (fresh.length === 0) {
    console.log(`   ${hiringPosts.length} post(s) in pool, but all already processed for ${username}.`);
    return;
  }

  console.log(`   ${hiringPosts.length} post(s) in pool, ${fresh.length} ${redraft ? 'to process' : 'new'} for ${username}`);

  // Phase 2+3: Score and draft — use cached response if available (from a previous failed mongo write).
  let contacts = loadTempAI(TEMP_PHASE23);

  if (!contacts) {
    const scoreAndDraft = await getPhase23Provider();
    contacts = await scoreAndDraft(fresh, candidate);

    // Cache AI response before attempting mongo write
    if (contacts.length > 0) {
      saveTempAI(TEMP_PHASE23, contacts);
    }
  }

  if (contacts.length === 0) {
    console.log('\n   No qualifying contacts from these posts.');
    removeTempAI(TEMP_PHASE23);
    return;
  }

  // Push to the user's rows in `user_emails`.
  const { added, skipped, updated } = await pushUserEmails(username, contacts, { redraft, salaryUnit: candidate.preferences?.salaryUnit });

  // Mongo write succeeded — remove temp cache
  removeTempAI(TEMP_PHASE23);

  // Summary
  const withEmail = contacts.filter(c => c.email?.body).length;
  const goodMatch = contacts.filter(c => c.match?.isGoodMatch).length;

  console.log('\n   ' + '='.repeat(50));
  console.log('   RESULTS');
  console.log('   ' + '='.repeat(50));
  console.log(`   Posts scored:     ${fresh.length}`);
  console.log(`   Good matches:     ${goodMatch}`);
  console.log(`   Emails drafted:   ${withEmail}`);
  console.log(`   Added to tab:     ${added} (${skipped} duplicates)`);
  if (updated > 0) console.log(`   Re-drafted:       ${updated}`);
  console.log('\n   Review emails at /feed (npm run web).');
}

// ============================================================
// COMMAND: send
// ============================================================

async function cmdSend(options) {
  const username = await resolveCliUser(options.user, { command: 'send' });
  console.log(`\n   SEND — Approved emails for "${username}"\n`);

  const { fetchUserEmails } = await import('../../services/feed/posts-store.js');
  const approved = await fetchUserEmails(username, 'approved');

  if (approved.length === 0) {
    console.log('   No approved emails found.');
    console.log('   Approve emails at /feed first (npm run web).');
    return;
  }

  console.log(`   ${approved.length} approved email(s) ready:\n`);
  approved.forEach((c, i) => {
    console.log(`   ${i + 1}. ${c.job?.title || '?'} @ ${c.job?.company || '?'} → ${c.email.to}`);
    console.log(`      Score: ${c.score}/10 — ${c.matchReason || ''}`);
  });

  console.log('\n   To send these, use: node scripts/feed/send-emails.js');
}

// ============================================================
// COMMAND: help
// ============================================================

function cmdHelp() {
  console.log(`
   Feed Email Extractor CLI

   Commands:
     node scripts/feed/feed-cli.js parse [--file <path>]                  Parse LinkedIn data from clipboard or file
     node scripts/feed/feed-cli.js generate [--user "<name>"]             Phase 1: AI extract -> mongo posts
     node scripts/feed/feed-cli.js emails   [--user "<name>"] [--redraft] Phase 2+3: Score posts -> draft emails -> user_emails
     node scripts/feed/feed-cli.js send     [--user "<name>"]             List unsent approved emails
     npm run web                                             Start the server; the feed UI is at /feed

   --user is optional. It names the users.username doc key in mongo and
   defaults to the sole user in the database; pass it only while the
   database still holds several users.

   Workflow (terminal):
     1. Copy LinkedIn feed HTML or API JSON to clipboard
     2. node scripts/feed/feed-cli.js parse                    -> output/extract.json
     3. node scripts/feed/feed-cli.js generate                 -> AI extracts hiring posts -> mongo posts
     4. node scripts/feed/feed-cli.js emails                   -> scores + drafts -> mongo user_emails
     5. open /feed in the UI                      -> review & approve
     6. node scripts/feed/send-emails.js          -> send approved emails
  `);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const { command, options } = parseArgs();

  console.log('\n   +--------------------------------------------------+');
  console.log('   |          FEED EMAIL EXTRACTOR                     |');
  console.log('   +--------------------------------------------------+');

  try {
    // Load the mirror snapshots once at startup for commands that read posts
    // or user_emails. The server keeps the snapshots fresh every 30 s, so
    // worst case we're 30 s behind — load() also kicks an initial delta sync
    // in the background. Reading from the in-process Map then beats a full
    // Mongo find (~1-3 s on Atlas free tier for 12 k posts).
    if (command === 'emails' || command === 'send') {
      const { postsMirror, userEmailsMirror } = await import('../../services/mirror.js');
      await Promise.all([postsMirror.load(), userEmailsMirror.load()]);
      await Promise.all([postsMirror.syncNow(), userEmailsMirror.syncNow()]);
    } else if (command === 'generate') {
      const { postsMirror } = await import('../../services/mirror.js');
      await postsMirror.load();
      await postsMirror.syncNow();
    }
    switch (command) {
      case 'parse':
        await cmdParse(options);
        break;
      case 'generate':
        await cmdGenerate(options);
        break;
      case 'emails':
        await cmdEmails(options);
        break;
      case 'send':
        await cmdSend(options);
        break;
      case 'help':
      default:
        cmdHelp();
        break;
    }
  } catch (error) {
    console.error(`\n   ERROR: ${error.message}\n`);
    await closeDb();
    process.exit(1);
  }

  console.log('');
  // Close the mongo client so the open socket doesn't keep the event loop
  // alive past the work — without this the CLI hangs after printing results.
  await closeDb();
}

// Lazy import so we don't add yet another startup cost when the user just
// wants `--help`. Safe to call even when no command ever touched mongo.
async function closeDb() {
  try {
    const { close } = await import('../../services/db.js');
    await close();
  } catch { /* db.js missing or already closed — fine */ }
}

main();
