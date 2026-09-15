# Resume Forge

**Your own AI job-search engine.** Paste a job description, get a one-page
resume tailored to it. Let a browser extension score every LinkedIn job you
open against *your* profile. Turn hiring posts into personalised outreach
emails. Track it all on one board — on your machine, in your database, with
your API keys.

Single user, single database, no SaaS, no telemetry.

## What it does

| Flow | In short |
|---|---|
| **Tailor** | JD in → ATS-optimised, one-page PDF out (typeset in Chrome, fits by construction), plus an email and a LinkedIn DM. |
| **Scan** | The Chrome extension reads any LinkedIn job page, scores it against your resume, and shows a verdict badge right on the page. Batch-capture whole search results and open the good ones. |
| **Apply** | A board of every analysed job: pending → applied → interviewing, with reject rules, company blocklists, connection hints and batch tailoring straight from the queue. |
| **Outreach** | Capture LinkedIn hiring posts, score them, draft emails you approve and send over your own SMTP. Posts with no email get a connection-request queue instead. |
| **Peers** | Friends running Resume Forge can share their already-scanned jobs with you (read-only, 30-second sync) so nobody scrapes the same postings twice. |

## Quick start

You need **Node 24+**, a **MongoDB** (Atlas free tier or a local `mongod`),
**Chrome**, and one AI key (AWS Bedrock or Google Gemini).

```bash
git clone <this repo> resume-forge && cd resume-forge
npm install
cp .env.example .env        # then fill in the values below
npm run web                 # http://localhost:5003
```

1. Open the URL. The first visit takes you to **/setup** — create your one
   account.
2. On **Resume**, paste your resume as JSON (the page has the schema and a
   prompt you can hand to any AI to convert your existing resume).
3. Load the extension: `chrome://extensions` → Developer mode → *Load
   unpacked* → the `extension/` folder. If you changed `PORT`, type it into
   the extension popup.
4. Open a LinkedIn job page. The badge appears. Everything else lives in the
   sidebar.

## Configuration (`.env`)

Only infrastructure goes in `.env`. Who you are, your SMTP and your resume
live in the database (set on `/setup`, `/settings`, `/resume.html`).

| Key | What |
|---|---|
| `MONGO_URI`, `MONGO_DB` | Your database. Atlas free tier works; so does `mongodb://127.0.0.1:27017`. |
| `AI_PROVIDER` | `bedrock` or `gemini`. |
| `BEDROCK_API_KEY`, `BEDROCK_BASE_URL` | Bedrock "mantle" endpoint (bearer key). Or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for the IAM route. Pick the region nearest you — the model catalogue differs per region. |
| `GEMINI_API_KEY` | If you chose Gemini. |
| `SESSION_SECRET` | `openssl rand -hex 32`. Blank means a random key per boot. |
| `PORT` | Default 5003. Match it in the extension popup. |
| `OUTPUT_DIR` | Where PDFs land. Default `~/Downloads/resume-forge`. |

Every key is documented inline in [`.env.example`](.env.example).

## Sharing jobs with a friend

Settings → **Shared job sources** → paste their connection string. It is
stored in `data/peers.json` on your machine only. To share *your* database,
create an Atlas user with a custom role that can only `find` on
`<db>.job_tracker` (never the built-in `read` role — it exposes your SMTP
password) and allow-list their IP.

## Learn more

The **About** page inside the app (`/about.html`) documents every screen,
the resume JSON schemas, the preferences block (salary unit, country, reject
rules — India-centric by default, all configurable), the peer sync, the CLIs
and the MongoDB collections. For contributors, `CLAUDE.md` records the
architecture and the invariants that are not obvious from the code.

## Testing against a copy of your data

```bash
npm run seed:local -- --user "<your name>" --apply --drop   # slice of your DB → local mongod
npm run web:local                                            # run against it
```

## License

MIT — see [LICENSE](LICENSE).
