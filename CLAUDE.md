# CLAUDE.md

Orientation for Claude / Claude Code agents working in this repo. Read this
first — README.md is for humans; this file calls out the architectural
invariants that aren't obvious from the code.

## What this is now (rewritten 2026-09-15)

A **single-user, single-database** job-search toolkit. One person clones it,
fills `.env` with their own Mongo URI and AI keys, creates **one** account, and
runs it alone. It used to be a two-person shared deployment (two operators on
one Atlas cluster, each running their own server); that model was removed on
2026-09-15 and must not creep back. The only cross-person mechanism left is **peer job
sources** (below), which is read-only and lives in a local file.

Things that were **deliberately removed** — do not reintroduce:

- A second user in the same DB: user tabs / "All Users" views, per-user
  columns, `?user=` / `body.user` / `?owner=` overrides ("cross-user help"),
  `listKnownUsers`, `/api/apply/users` enumeration, connection owner pills,
  the extension's "Scrape identity" dropdown.
- The `joinedAt` shared-pool cutoff. A single-user DB shows every row. The
  field still exists on old user docs; nothing reads it.
- Identity from env (`RESUME_USER` etc.), from a file
  (`services/scanner/candidate-profile.json` was one person's real profile,
  loaded at module init — the exact anti-pattern), from
  `personalInfo.name`, or from nickname maps.
- Operator-specific constants in code: `CONFIRMED_REAL` (a personal
  `cannotClaim` override in tailor-batch), the employer name in
  `location-filter.js`, `~/Music` output paths, a personal test inbox,
  committed session cookies in the perf scripts, "MERN" as the default
  role/stack in prompts and filenames.
- One-shot migration scripts tied to the original laptops
  (`migrate-scanner-data.js`, `import-friend-connects.js`, the `backfill-*`
  repairs).

## The one rule: single-operator identity

`services/users/current.js` is the only identity source. Resolution order,
everywhere:

1. the signed session cookie (`readSessionCookie(req.headers.cookie).u`);
2. the **sole** document in `users` (`getSoleUser()`), used by paths that
   have no cookie: the extension's `/api/ext/*`, CLIs run without `--user`,
   the peer-sync loop, boot checks;
3. `null` → the caller answers 400 / "run /setup", never guesses.

| Context | Call |
|---|---|
| Express handler | `await resolveUsername(req)` or `await requireUsername(req, res)` |
| feed router (`scripts/feed/dashboard-server.js`, raw http) | `resolveOperator(req)` → `resolveUsername(req)` |
| `/api/ext/*` (mounted before the auth gate) | `resolveUsername` / `requireUsername` |
| CLIs (`scripts/feed/feed-cli.js`, `scripts/feed/send-emails.js`) | `await resolveCliUser(flags.user, { command })` — `--user` is optional |

A DB that still holds several users (a legacy shared deployment) is
tolerated: cookies and `--user` keep working, and only the cookie-less paths
refuse, naming the candidates. Nothing silently picks one.

If you find yourself writing `req.query.user`, stop.

### First run

`GET /api/setup` says whether a user exists. With none, HTML requests redirect
to `/setup`, which POSTs `/api/setup { username, email, password }` — that
calls `createUser()` in `services/auth/auth-store.js` (the same writer
`scripts/create-user.js` uses), refuses once any user exists, and logs the
new user in. Then `/resume.html` is where the tailor + feed JSONs get pasted.
`create-user.js` no longer defaults the password to `<name>@123`; pass
`--password` or take the generated one it prints once. `SESSION_SECRET`
unset → a random per-boot secret and a loud warning (sessions die on restart).

## Architecture at a glance

- **`server.js` on port 5003**, Express 5. Mounts `feedHandler` (from
  `scripts/feed/dashboard-server.js`) at `/feed` and `/posts` behind the auth
  gate, `/api/ext/*` (the extension's API) **before** the gate, and the peer
  sources router at `/api/settings/peers` after the gate and after the global
  JSON parser. Settings routes registered above the gate self-check the
  cookie — keep that pattern if you add one there.
- **Feed UI is two URLs, one HTML file** — `/feed` and `/posts` both serve
  `public/feed.html`; it reads `window.location.pathname` at init.
- **CLIs are spawned by the UI**: `scripts/feed/feed-cli.js parse / generate / emails`,
  `scripts/feed/send-emails.js`. They default to the sole user.
- **One email queue.** The tailor flow's drafted email (when a JD names a
  recruiter) is written into `user_emails` by `pushTailorEmail()` with
  `source: 'tailor'`, `variantId` and `postId: 'tailor:<variantId>'`, so the
  Outreach → Emails page lists, approves and sends it like any feed draft;
  `email-sender.js` attaches the tailored variant's PDF instead of the master
  resume when `variantId` is set. The separate Outbox page is gone;
  `contact-logger.js` still records the contact for the Contacts page.
  The "Add posts" clipboard button is gone too — posts arrive via the
  extension's feed capture.
- **Plain HTML/CSS/JS frontend** — no React, no build step. `public/app.css`
  is the only stylesheet (`feed.css` was dead and is gone).
- **Extension** (`extension/`) talks to `http://localhost:5003/api/ext` via
  its background worker (fetch with `credentials: 'include'`). It carries no
  identity; the server resolves the owner. **The port has one source of
  truth per side**: `PORT` in `.env` (`.env.example` ships 5003) and the
  popup's "Server port" setting (`chrome.storage.local.forgeServerPort`,
  default 5003). The manifest permits any localhost port; content.js builds
  URLs against the default origin and `background.js` rewrites them to the
  configured port, so content scripts must never call `fetch()` on the
  server directly. A mismatch is silent on both sides — the boot banner
  says so whenever `PORT` is not 5003.

## The in-memory mirror (READ THIS BEFORE TOUCHING ANY READ/WRITE PATH)

Atlas free-tier RTT (~200–500 ms per call) was killing the UX. Reads serve
from an in-process JavaScript Map; Mongo stays authoritative.

### What's mirrored
`job_tracker`, `user_emails`, `posts`, `connections`, `user_connects`,
`user_inbox`, `high_salary_companies`. Registry at the bottom of
`services/mirror.js`; new mirrored collections also go in
`STAMPED_COLLECTIONS` in `services/db.js`. Stamping and mirroring are
decoupled: `scanner_filters`, `scanner_searches`, `feed_sources` are stamped
(audit timestamps) but not mirrored (config-shaped, one doc).

### Read path
Every slow endpoint checks the mirror first:

```js
if (mirror.loaded) {
  return mirror.filter(predicate).sort(...).slice(...);
}
// fallback: the original Mongo query, used during the startup window
```

**Do not delete the Mongo fallback.**

### Write path — the `col()` Proxy
`services/db.js` wraps `col(name)` for every stamped collection in a Proxy
that auto-stamps every write: update-style ops get
`$currentDate: { updatedAt: true }` + `$setOnInsert: { createdAt }`;
insert/replace-style ops get `createdAt` + `updatedAt` injected into the doc
(caller-supplied values win). **You do not add timestamps by hand.**

Two facts that bit the peer importer and will bite you:

- **`job_tracker.createdAt` is an ISO *string*** on every row (job-store
  writes it in `$setOnInsert` and the caller wins), while `updatedAt` is a
  BSON `Date` and `analyzedAt` an ISO string. A `{ createdAt: { $gt: <Date> } }`
  filter matches nothing. Sort/cursor on `updatedAt`, never `createdAt`.
- **`insertOne` through the Proxy returns nothing useful to the caller**:
  `_stampDoc` copies the doc, so the driver puts `_id` on the copy. Never
  hand pre-insert objects to `mirror.set/applyMany` — re-read the rows
  (`find({ jobLink: { $in } })`) and pass those, like every job-store writer.

After the Mongo write, mutation functions call `mirror.set(doc)` /
`mirror.applyMany(docs)` with the post-write docs.

### Delta sync and snapshots
Every 15 s each mirror pulls docs newer than the last seen `updatedAt`
(with an `_id` tiebreaker — the `$gte` boundary re-pull was fixed on
2026-09-15). It exists so a server that restarts, or a CLI child process
reading snapshots, converges with what the server wrote; there is no second
server on the same DB any more.

Snapshots persist to **`data/mirrors/<host>__<db>/<collection>.json`** every
30 s and on SIGTERM. The directory is keyed by `dbIdentity()` from
`services/db.js`, so pointing `MONGO_URI` at a local copy can never boot from
the remote cluster's snapshot. A flat legacy `data/mirrors/<name>.json` is
ignored with a warning telling you where to move it. `MIRROR_DIR` overrides
the whole path. `scripts/dump-mirrors.js` writes to the same place.

### Live updates — SSE
`GET /api/events` streams every mirror change (local write, delta absorb,
bulk import — peer imports included). `apply.html` and `feed.html` listen and
debounce-refetch.

## Peer job sources (added 2026-09-15)

Other people running this tool can share their scraped + analyzed
`job_tracker` rows. The user pastes a friend's Mongo connection string on
`/settings` → "Shared job sources"; every 30 s the server pulls new rows into
the local `job_tracker` as **pending** rows for triage, so nobody scrapes the
same postings twice.

- **Config is local**: `data/peers.json` (gitignored, `0600`, tmp+rename
  writes). Never in the DB, never in the users doc, never logged. URIs are
  parsed with the driver's `ConnectionString`, query options are
  allow-listed, and every response/log uses `.redact()`. Sending back the
  redacted URI on PUT means "unchanged".
- **Code**: `services/peers/peers-config.js` (file), `sanitize.js` (pure:
  whitelist copy, caps, `normalizeJobLink`), `peer-sync.js` (loop + Mongo
  clients), `routes.js` (express Router). `startPeerSync()` /
  `stopPeerSync()` are called only from `server.js` (spawned CLIs must not
  open peer connections).
- **What is pulled**: rows with a string `analyzedAt`, a `jobText`, not
  `rowStatus: 'rejected'` (per-peer `includePeerRejected` opt-in imports those
  as rejected with `rejectedBy: 'peer:<label>'`), inside a per-peer
  `windowDays` window (default 30). Blocklist stubs (no JD, "Auto-skipped")
  and rows under 200 chars of JD are skipped and counted.
- **Cursor** is `(updatedAt, _id)` with `$gt` / tiebreak semantics, sorted the
  same way, persisted only after the local writes resolve; at most 2 × 500
  rows per tick, one in-flight sync per peer, `setTimeout` re-armed in
  `finally` (never an overlapping `setInterval`).
- **Sanitize**: strict whitelist (never `users`, `rowStatus`, `rejected*`,
  `blockedReasons`, `connectNote*`, `_id`, timestamps, derived facets), size
  caps, `^https?://` on links, canonical `jobLink`
  (`https://www.linkedin.com/jobs/view/<id>/`, tracking params stripped; the
  raw one is kept as `importedFrom.peerJobLink`), derived facets recomputed
  locally with `deriveRowFacets()` from job-store. Rows whose `jobId` already
  exists locally are skipped.
- **Local write**: one `bulkWrite` per batch through `col('job_tracker')`:
  `updateOne { $setOnInsert: row, upsert: true }` keyed on the unique
  `jobLink` (insert-only — a local row always wins), plus a fill-in `$set` of
  analysis fields for local rows that have no `analyzedAt`. Then re-read and
  `applyMany`, `invalidateMatchIndex({})`. The **local** `scanner_filters`
  (`applyFilterRules`, exported from `services/scanner/index.js`) run at
  import and write the same rejected tuple the block-company route writes
  (`rejectedBy: 'system:peer-import'`).
- **Provenance**: `importedFrom: { peerId, label, at, peerJobLink,
  peerCreatedAt, peerAnalyzedAt, peerRowStatus }`, included by `hydrate()`.
  The peer's `verdict / score / key_skills_*` are **their** analysis, against
  their profile — `/apply` shows a "↓ label" pill and a "Re-analyze against
  my profile" button (`POST /api/apply/jobs/reanalyze { jobLinks }`), and the
  extension re-analyzes an imported row the first time the user opens it.
  `upsertScannedJob` and `clearScannerData` `$unset` `importedFrom` when a
  local analysis lands, so the pill never lies.
- **Sharing your own DB**: an Atlas **custom role** with only `find` on
  `<db>.job_tracker` — never the built-in `read` role, which also exposes
  `users.emailConfig.smtp.pass` (plain text), auth hashes and fetched mail.
  `POST /:id/test` probes `users` and returns `scopeWarning` if the credential
  can read it. The other side must allow-list your IP under Network Access;
  a bare selection timeout is almost always that.
- **Removing a peer** (`DELETE /:id?purge=1`) can also delete its untouched
  imported rows (no `users` entry, `rejectedBy` null / system / peer) from
  Mongo and the mirror. Deletions never propagate otherwise.
- **Migration from the old shared DB** is *not* the sync loop's job: use
  `scripts/seed-local-from-remote.js --user "<name>"`, which copies one user's
  full slice (including their applied history) into a fresh DB.

## Candidate profile and preferences

`loadCandidate(username)` in `services/feed/feed-config.js` is the single
candidate shape every prompt consumes (feedData preferred, tailor `data`
fallback). It now carries `preferences`, merged over `DEFAULT_PREFERENCES`:

```
country 'India', currency 'INR', salaryUnit 'LPA', usdRate 85, minSalary 6,
maxExperienceGap 1, rejectWalkIn, rejectContract, rejectIntern, rejectStaffing (all true),
excludeCompanies [<current employer>], noticePeriod null
```

Stored at `users.<u>.feedData.preferences` (optional; validated by
`resume-validator.js`; documented in the FEED_EXAMPLE on `/resume.html`).
`checkLocation(text, prefs)`, `extractPhase1(posts, candidate)`,
`scoreContact(extracted, candidate)` and every prompt read from it. Defaults
reproduce the original behaviour with one deliberate change: the scoring
salary floor is `minSalary` (6) instead of a separate hardcoded 7. The
extraction prompt's experience rule keeps the old strictness: posts asking
for `floor(years + maxExperienceGap) + 1`+ years are dropped (the original
"4+ years" for a ~3-year candidate). `meta.cannotClaim` is now honoured
verbatim by batch tailoring — an operator whose
stored list still bans real skills must prune it on `/resume.html`.

**Be honest about what is still India-centric by default**: the feed
pipeline normalises salaries to LPA (`parseSalaryToLPA`, `USD_TO_LOCAL = 85`),
`location-filter.js` rejects non-India locations when `country` is `'India'`
(any other value skips that block), `company-filter.js` and
the `high_salary_companies` collection (empty on a fresh install; edited from
the Posts page) are India-weighted, and the platform list knows Naukri/Instahyre/Cutshort. Field
names like `salaryMinLPA` are storage schema — do not rename them; treat LPA
as "the normalised annual unit".

The scanner's `analyzeJob` takes `candidate` (may be `null` → the prompt
renders without the candidate section) and `opts { skipConnectNote,
referencePostedAt }`. Prompts derive the role line from `candidate.stack` /
`currentTitle`; there is no literal stack anywhere in code.

## Testing against a local copy (read before running anything)

Test against a local mongod, never the remote cluster:

```
npm run seed:local -- --user "<name>" --apply --drop   # newest 3000 rows of each big collection, one user
npm run web:local                                       # MONGO_URI=mongodb://127.0.0.1:27017 MONGO_DB=forge_local
```

The seed keeps only that user's `users.<u>` sub-docs on job rows, so the copy
looks like a fresh single-user install with history. Snapshots land in
`data/mirrors/127.0.0.1_27017__forge_local/` (the slug replaces `:` with
`_`). The remote cluster is a natural
"peer" for testing the import path (its credential will trip the scope
warning, which is correct). There is no test suite in the public tree; verify
changes against this local copy.

## Operational scripts

| Script | Purpose |
|---|---|
| `scripts/seed-local-from-remote.js` | One user's slice of a big DB → a local test DB (`npm run seed:local`). |
| `scripts/create-user.js` | Create the single account from the terminal (or use `/setup`). Refuses a second user; `--password` alone resets the sole user's password. |
| `scripts/ensure-indexes.js` | Idempotent indexes for a fresh DB (`updatedAt`/`createdAt` on mirrored collections, `jobLink` unique, `postId` unique, …). |
| `scripts/dump-mirrors.js` | Force a full snapshot dump into the per-DB mirror dir. |
| `scripts/list-bedrock-models.js` | `npm run models` — what the configured Bedrock region offers. |

## Things that look weird but are correct

- **`services/db.js` `col()` returns a Proxy for stamped collections.** Stick
  to the method API; `instanceof Collection` fails.
- **`scripts/feed/dashboard-server.js` has no auth check of its own** —
  server.js wraps the mount in `requireAuthRaw` and attaches `req.user`.
- **`auth.createdAt` is when the auth record was set.** `joinedAt` is legacy.
- **`approvedBy` on `user_emails` is a source tag** (`""`, `"Claude"`,
  `"Dashboard"`), not identity. `rejectedBy` on `job_tracker` is either the
  username, `system:block-company`, `system:peer-import` or `peer:<label>`.
- **`users.<username>` on job rows is still a map**, with exactly one key.
  Flattening it would touch `buildMatcher`, the `apply_<Name>_1` index,
  `hydrate`, `coerceUserSub` and apply.html for no functional gain.
- **`owners` on `connections` is still an array**, always `[localUser]`.
- **`</script>` inside a JS comment terminates the script tag.** Reword any
  comment that needs the closing tag. Diagnose with
  `[...document.querySelectorAll('script:not([src])')].forEach(s => { try { new Function(s.textContent); } catch (e) { console.error(e.message); } })`.
- **`listJobs({ user, status: 'pending' })` returns 0.** `user` scopes to the
  APPLIED pipeline; the triage queue is `{ user: null, statusUser }`.
- **The feed CLI loads mirror snapshots at startup** (`postsMirror.load()`),
  reading the disk snapshot the server flushes every 30 s; its timers are
  `unref`'d so it exits.
- **Stray exports / PDFs at the repo root are not the app.** `*.pdf` is
  gitignored; do not commit personal files.

## Bedrock has two transports (added 2026-08)

`BEDROCK_TRANSPORT` picks one; unset, it infers from which credential exists
(bearer key → `mantle`, else `aws`).

| | `aws` | `mantle` |
|---|---|---|
| protocol | SigV4 + Converse API | OpenAI-compatible `/v1/chat/completions` |
| auth | AWS credential chain | `BEDROCK_API_KEY` bearer token |
| models | everything the account is granted | **depends on the region** |
| model ids | `us.` prefix + `-v1:0` suffix required | both forbidden |

### The mantle catalogue is per-region (corrected 2026-08-13)

Measured live, same API key:

| region | models | notable |
|---|---:|---|
| `ap-south-1` | 38 | open-weight only |
| **`us-east-1`** | **55** | **Claude Opus 5 / Sonnet 5 / Haiku 4.5 / Fable 5, GPT-5.4–5.6, Grok 4.3, Gemma 4** |
| `us-west-2` | 47 | Gemma 4, no Anthropic |
| `ap-northeast-1` | 41 | open-weight only |
| `eu-central-1` | 33 | Gemma 4, no Anthropic |
| `eu-west-1` | 35 | open-weight only |

Switch with `BEDROCK_BASE_URL=https://bedrock-mantle.<region>.api.aws/v1`.
A model absent from the configured region returns a 404 naming it, which is
why `resolveModel` passes unknown input through unchanged.

**Pick the region nearest the operator; leaving it is not free.** Measured on
the same model: TTFT 1018 → 1932 ms across regions. Always run the incumbent
in the target region too, or the cross-region RTT gets charged to the new
model.

`status: "available"` in `/v1/models` means neither entitled nor callable
(`anthropic.*` → 403, `openai.gpt-5.6-*` → 401 on the original account).
`google.gemma-4-*` works only on the **second API surface** — see
`usesOpenAISurface` in `mantle-client.js`:

| surface | models | token param | temperature |
|---|---|---|---|
| `/v1/chat/completions` | deepseek, gemma-3, qwen, mistral… | `max_tokens` | honoured |
| `/openai/v1/chat/completions` | gemma-4 | `max_completion_tokens` | **rejected** |

A model on the wrong surface returns 400 "isn't supported on this route".

Because the model IDs are mutually invalid, **each transport owns its own
alias map** (`bedrock-aws.js` / `mantle-client.js`); ask
`bedrock-transport.js`. Every caller goes through `bedrockChat()` and cannot
tell which transport answered.

## Batch tailoring from the apply queue (added 2026-08)

`services/apply/tailor-batch.js` + `/api/apply/tailor/*`. **A loop around the
existing tailoring pipeline, not a second engine.** JD comes from
`job_tracker.jobText`; PDFs land in `<OUTPUT_DIR>/a-tailored-resumes/<Company>/`
(`OUTPUT_DIR` defaults to `~/Downloads/resume-forge`, never the repo or a temp dir)
(the outbox root — `OUT_ROOT` derives from `config.paths.outputDir`, so the
original operator's `~/Music/a-tailored-resumes` is unchanged); the variant
is stamped with `jobId` / `jobLink` / `pdfPath`. Runs live in an in-process
`Map` and die with the process.

`cannotClaim` is used **as stored**. The former in-memory relaxation
(`CONFIRMED_REAL`) was one person's correction and is gone; fix your list on
`/resume.html`.

### Measuring tailoring quality (read before "improving" the prompt)

The measurement harness is not in the public tree, but its method and
numbers are: it imported the lexicon from `services/pipeline/jd-tech.js`
(a harness with its own copy drifted and produced wrong numbers for months).
Three metrics: **coverage** (share of the
JD's technologies on the page; denominator includes ones the candidate lacks),
**claimable coverage** (the real number), **depth** (share of matched
technologies inside a bullet / summary / project rather than only on the
skills line). **The noise floor is ±4 points at n=10** — run each JD twice per
model, pool hits and totals, never average per-job percentages.

Numbers (2026-08-12, 5 JDs × 2 reps, fixed lexicon): deepseek.v3.2 ~90%
claimable / ~70% depth; qwen3-235b ~93% / ~79%.

Already tested — do not re-derive: (1) step 1 does not under-extract;
(2) lifting `keywords.slice(0, 30)` filled the prompt but did not move
on-page coverage — the page is full; (3) the MUST COVER / LEAVE OUT block
**matters** (removing it costs 4–8 points) once the lexicon has bare
React/Node/Vue/Mongo; (4) the evidence rule ("name 2-3 technologies inside
each bullet") took depth 74% → 84%.

The lexicon is load-bearing: bare forms come **after** multi-word entries
with matched spans blanked, so `React Native` no longer implies `React`.
`Next`, `Nest`, `Spring` are deliberately absent as bare forms.

### Reading the ATS score
`services/pipeline/ats-scorer.js` returns `overallScore`, `keywordExact`,
`found`, `missing`, `totalKeywords`, `hardReject`, `penalties` — no `total`,
`score` or `verdict`. `overallScore` can be **NaN** on an empty keyword list;
read through `Number.isFinite`. **Never rank models by this score**: each
model's analysis step picks its own keyword list.

## The resume is typeset, not templated (added 2026-08-30)

`services/pipeline/html-resume.js`: Chrome renders an HTML page and
`page.pdf()` writes it; `document.js` + `template.docx` + LibreOffice are the
fallback and the `.docx` download. `render-resume.js` picks; `RESUME_RENDERER=docx`
forces the fallback. A template cannot count pages, Chrome can: lay out in
the A4 printable box, binary-search the `--k` multiplier (0.82–1.16), walk the
`TRIMS` ladder only if `K_MIN` still overflows (the current role always
survives), then count `/Type /Page` in the PDF and step down if it spilled.

- `skl` stays one comma-separated string (the scorer matches against it);
  `skill-groups.js` groups it at render time, its lexicon outranks the
  candidate's own buckets, one-skill rows fold into neighbours (two passes,
  one absorb each), the catch-all row is capped at `PRACTICES_MAX` for
  display only.
- Bold is deterministic (tailored skills incl. `.js`-stripped and
  parenthetical variants, quantified metrics, a leading `Label:`).
- Header links print as labels with real hrefs.
- One shared browser with `MAX_PAGES` concurrent pages (15 concurrent renders
  85 s → 6.3 s); idle-closed, `unref`'d, relaunched on `disconnected`.
- The batch does NOT put HTML renders through `queueConversion` (that queue
  exists for `soffice` profile locks).

## The skills line is settled in code, not by the model (added 2026-08-30)

`services/pipeline/skill-line.js` runs on `skl` after the rewrite and before
scoring: (1) keep what the candidate has; (2) add a JD term only if the
posting names it AND the candidate owns it; (3) rank by first mention in the
JD. Retention floor = technologies the rest of the page already claims ∩
owned skills; `coreSkills` supplements. A/B on 12 stored variants with the
analysis held fixed: 55.7% → 56.0%, no cost. Do not compare ATS scores from
two live runs. `findTechWithPositions` in jd-tech.js is what makes ordering
possible; one entry can name several technologies; `cannotClaim` is filtered
here too.

## The connect pipeline — outreach for posts with no email (added 2026-08)

~40% of the hiring pool has no email; `/connects` is the LinkedIn-invite
path. `services/feed/connects-store.js` (`user_connects`, keyed
`(username, postId)`, mirrored). Three states `invited → connected →
messaged`; acceptance is detected passively when the extension's
connections-page scrape calls `markAcceptedFromConnections`. No invitation
note by design; `connect-message.js` drafts the follow-up from the post, with
a deterministic fallback that never invents facts about the candidate.
Profiles match on the slug (`profileKey`), never the raw URL. **Degree is the
routing field** (1st message, 2nd invite, 3rd usually not).

**Auto-connect (added 2026-09-15).** The Posts page's "Auto-connect N" button
queues the visible connectable posts as invited, then hands their profile
URLs to the extension via `window.postMessage({ type: 'forge:auto-connect' })`
(content.js listens on localhost and relays to `background.js`). The worker
opens ONE profile tab at a time with `#fgconnect` (latched into
`sessionStorage` by inject.js because LinkedIn strips the hash), waits for the
content script's verdict, closes the tab, pauses 4–5 s, next (the queue is
deduped by profile slug). On the tab the
script clicks Connect (top card, else the "More" menu entry), then "Send
without a note", and POSTs `/api/ext/connects/auto-result { profileUrl,
result }` — `sent | pending | already-connected | limit | not-found | error`.
`markAutoConnect()` flips the connects row (`limit` also empties the queue).
Failures keep their tab open for a human. Nothing is ever typed into
LinkedIn; a bare request is exactly what the operator sent by hand before.

- **The invite modal is not in the light DOM.** The profile page is the React
  UI; the "Add a note" modal is the Ember UI (booted in a `/preload/` iframe)
  mounted in a shadow root. Every lookup walks the document, readable
  iframes and every shadow root (`chrome.dom.openOrClosedShadowRoot`) — a
  plain `querySelectorAll` finds no dialog at all.
- **`invited` is not proof a request went out** — the Posts page writes it
  before the extension runs. `sent` / `pending` stamp `inviteConfirmedAt`;
  `isInviteDone()` (that stamp, a sent/pending/already-connected auto result,
  or `connected`/`messaged`) marks a person done. The posts API attaches
  `connect: { status, autoResult, done }` per poster **by profileKey**, and
  `connectableNow()` skips done people, so a Pending profile is never opened
  again.

### The parser regression that hid all of this
LinkedIn inserted the connection-degree badge as its own paragraph;
`extractAuthor` read `headerPs[1]`, so 11,614 of 17,016 pool posts stored
`headline: "• 3rd+"`. Fixed by matching header paragraphs **by shape, never
by index** (real headlines 23% → 97%). A parser test locked it in (tests are not in the public tree). The rendered HTML has essentially
no activity ids (`postUrl` null for ~84%); `parseContentSearchSDUI` returns 0
posts since the RSC stream inverted — fixing it is the only route to post
permalinks. Treat `poster.headline` on pre-2026-08-13 posts as unreliable.

## Common operations

- **Onboard**: `/setup` in the browser, or
  `node scripts/create-user.js --username "Jane Doe" --email jane@example.com --password '…'`.
- **Add a mongo collection**: reads/writes via `col('name')`; indexes belong
  in `scripts/ensure-indexes.js`, not boot code; if it will exceed ~1k rows,
  register a mirror, add to `STAMPED_COLLECTIONS`, wire reads to
  `mirror.loaded`, writes to `mirror.set`.
- **"I changed code and nothing's faster"**: Node doesn't hot-reload ESM.
  Restart. Check the boot log for `[mirror] <name> loaded N docs`.
- **"The extension says analyze failed with 'No user'"**: the DB has zero or
  several users — open `/setup`, or log in so the cookie decides.

## Open follow-ups

1. `posts` could be shared across peers the same way as `job_tracker`
   (identity-free, keyed by `postId`); the sanitizer pattern carries over.
2. Cold-start preload of the per-owner connection match index (~2.5 s on
   the first `/api/apply/jobs?includeRefs=1`).
3. `MAX_PAGES` in `html-resume.js` was picked, not measured.
4. `parseContentSearchSDUI` (post permalinks) — see the connect pipeline.
5. Git history still contains the original operators' PII (the deleted
   profile JSON, committed session cookies, names in migration scripts).
   Publishing the repo means rewriting history or starting from a squashed
   commit, and rotating `SESSION_SECRET`.
