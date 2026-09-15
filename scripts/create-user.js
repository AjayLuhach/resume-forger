// Create the user for this database, or reset that user's credentials.
//
// Resume Forge is single-user: one person, one database. The first run
// creates the user (the /setup page does the same thing from the browser);
// running it again with the SAME --username rewrites the email + password
// and leaves the resume payloads, SMTP config and history alone. A second,
// different username is refused — point a new person at their own database.
//
// Usage:
//   node scripts/create-user.js --username "Jane Doe" --email jane@example.com
//   node scripts/create-user.js --username "Jane Doe" --email jane@example.com --password "s3cret-phrase"
//   node scripts/create-user.js --password "new-password"      # reset: the database already knows who you are
//
// Without --password a random one is generated and printed ONCE — copy it,
// then change it from /settings after the first login. There is no
// guessable default.
import 'dotenv/config';
import crypto from 'crypto';
import { close } from '../services/db.js';
import { createUser, setUserPassword } from '../services/auth/auth-store.js';
import { listUsernames } from '../services/users/current.js';

const args = process.argv.slice(2);
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const username = (getFlag('--username') || '').trim();
const email = (getFlag('--email') || '').trim();
const passwordArg = getFlag('--password');
const usage = () => {
  console.error('Usage: node scripts/create-user.js --username "<name>" --email <email> [--password <pw>]   # create');
  console.error('       node scripts/create-user.js --password "<new password>"                             # reset the existing user');
};

const existing = await listUsernames({ fresh: true });

// Password reset: no name or email needed — the database has exactly one
// user and that is who you are. Everything else on the doc is untouched.
if (!username && !email) {
  if (existing.length !== 1) {
    if (existing.length === 0) console.error('No user exists yet — create one:');
    else console.error(`Several users exist (${existing.map((n) => `"${n}"`).join(', ')}) — pass --username to pick one:`);
    usage();
    await close();
    process.exit(1);
  }
  const who = existing[0];
  const generatedReset = !passwordArg;
  const next = passwordArg || crypto.randomBytes(9).toString('base64url');
  try {
    await setUserPassword(who, next);
    console.log(`Password reset for "${who}"`);
    console.log(generatedReset
      ? `  Login password: ${next}   (generated — shown once, change it under /settings)`
      : '  Login password: (as given)');
  } catch (e) {
    console.error(`reset failed: ${e.message}`);
    await close();
    process.exit(1);
  }
  await close();
  process.exit(0);
}

if (!username || !email) {
  usage();
  await close();
  process.exit(1);
}
const isReset = existing.includes(username);
if (existing.length && !isReset) {
  console.error(`This database already has a user: ${existing.map((n) => `"${n}"`).join(', ')}.`);
  console.error('Resume Forge is single-user — re-run with that --username to reset its credentials,');
  console.error('or point MONGO_URI / MONGO_DB at a database of your own.');
  await close();
  process.exit(1);
}

// 9 random bytes → 12 base64url chars: enough entropy for a local tool, short
// enough to type from the terminal into the login form.
const generated = !passwordArg;
const plain = passwordArg || crypto.randomBytes(9).toString('base64url');

try {
  const r = await createUser({ username, email, password: plain, allowExisting: isReset });
  console.log(r.created ? `Created user "${r.username}"` : `Reset credentials for existing user "${r.username}"`);
  console.log(`  Login email:    ${r.email}`);
  if (generated) {
    console.log(`  Login password: ${plain}   (generated — shown once, change it under /settings)`);
  } else {
    console.log('  Login password: (as given)');
  }
  console.log(`  Index ensured:  job_tracker.apply_${username.replace(/\s+/g, '_')}_1`);
  if (r.created) {
    console.log('\nNext: start the server (npm run web), sign in, and paste your resume JSONs on /resume.html.');
  }
} catch (e) {
  console.error(`create-user failed: ${e.message}`);
  await close();
  process.exit(1);
}

await close();
