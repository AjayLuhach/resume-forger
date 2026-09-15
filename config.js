/**
 * Configuration for Resume Forge: env-driven paths, output naming and the
 * AI provider / tailoring settings.
 *
 * Nothing here knows who the user is. Identity comes from the session or an
 * explicit username at the call site (services/users/current.js); the
 * candidate profile is loaded from the `users` collection by
 * services/feed/feed-config.js `loadCandidate(username)`.
 */

import "dotenv/config";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { homedir } from "os";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Where tailored resumes are written. OUTPUT_DIR in .env wins (absolute, or
// `~`-prefixed, or relative to the repo root); the default is a folder of its
// own inside the user's Downloads, so PDFs land somewhere a person actually
// looks, never inside the repo or a temp directory. The batch outbox
// (`a-tailored-resumes/`) is created underneath it.
const outputDir = process.env.OUTPUT_DIR
  ? process.env.OUTPUT_DIR.startsWith("/") ||
    process.env.OUTPUT_DIR.startsWith("~")
    ? process.env.OUTPUT_DIR.replace(/^~/, homedir())
    : join(__dirname, process.env.OUTPUT_DIR)
  : join(homedir(), "Downloads", "resume-forge");

/**
 * Build output filename from the candidate's name and the tailored role
 * e.g. "Jane Doe" + "Backend Engineer" → "Jane Doe_Backend Engineer"
 */
function buildOutputBasename(name, role) {
  // Sanitize for filesystem and for HTTP: drop characters not allowed in
  // filenames, and fold anything outside printable ASCII (job titles love
  // en dashes) to '-' — a non-Latin-1 byte in a Content-Disposition header
  // makes Node throw and the download 500s.
  const sanitize = (str) =>
    str.replace(/[<>:"/\\|?*]/g, "").replace(/[^\x20-\x7e]+/g, "-").replace(/-{2,}/g, "-").trim();
  const safeName = sanitize(name || "Resume");
  const safeRole = sanitize(role || "Resume");
  return `${safeName}_${safeRole}`;
}

export const config = {
  // Paths
  paths: {
    template: join(__dirname, "template.docx"),
    outputDir: outputDir,
    getOutputPaths: (name, role) => {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      const basename = buildOutputBasename(name, role);
      return {
        docx: join(outputDir, `${basename}.docx`),
        pdf: join(outputDir, `${basename}.pdf`),
      };
    },
  },

  // AI Configuration
  // Set AI_PROVIDER env var to switch: 'bedrock' | 'gemini'
  // To add a new provider: see services/providers/README or extend BaseProvider
  ai: {
    provider: process.env.AI_PROVIDER || "bedrock",

    // ─────────────────────────────────────────────────────────
    // GEMINI CONFIG (Google AI - Free tier with rate limits)
    // Required: GEMINI_API_KEY
    // ─────────────────────────────────────────────────────────
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || "",
      // Model pool for rotation (ordered by preference, auto-rotates on rate limit)
      models: {
        analysis: [
          "gemini-2.5-pro",
          "gemini-3-pro-preview",
          "gemini-2.5-flash",
          "gemini-3-flash-preview",
          "gemini-2.0-flash",
          "gemini-2.0-flash-lite",
        ],
        rewrite: [
          "gemini-2.5-pro",
          "gemini-3-pro-preview",
          "gemini-2.5-flash",
          "gemini-3-flash-preview",
          "gemini-2.0-flash",
          "gemini-2.0-flash-lite",
        ],
      },
      rateLimitCooldown: 60000,
    },

    // ─────────────────────────────────────────────────────────
    // BEDROCK CONFIG — two transports, chosen by BEDROCK_TRANSPORT
    //
    //   aws    = SigV4 + Converse API. Needs AWS credentials. Reaches every
    //            model the account is granted (Anthropic/Titan/Llama included).
    //   mantle = OpenAI-compatible endpoint behind a bearer key. Needs
    //            BEDROCK_API_KEY. Open-weight models only.
    //
    // mantle was added in 2026-07 as a workaround for dead IAM keys, not as a
    // migration — so both stay live and the switch is one env var. Unset,
    // it infers: bearer key present → mantle, otherwise aws.
    // Alias maps live per-transport in bedrock-transport.js, because the model
    // IDs genuinely differ between them.
    // ─────────────────────────────────────────────────────────
    bedrock: {
      // 'aws' | 'mantle' | unset (infer from which credential is present)
      transport: process.env.BEDROCK_TRANSPORT || null,
      region: process.env.AWS_REGION || "us-east-1",
      // Alias or full model ID. Unset → the active transport's own default
      // ('deepseek' on mantle, 'haiku' on aws), since an alias valid on one
      // transport may not exist on the other.
      modelId: process.env.BEDROCK_MODEL || null,

      // NOTE: there is deliberately no alias map here. Each transport owns
      // its own (bedrock-aws.js / mantle-client.js) because the model IDs are
      // mutually invalid — `us.anthropic...-v1:0` on aws, bare ids on mantle —
      // and a single list would be wrong for one of them. Ask
      // bedrock-transport.js for aliases or the curated tailoring picker.

      maxTokens: {
        analysis: 32768,
        rewrite: 32768,
      },
    },
  },

  // Tailoring mode: 'strict' (default) or 'ats_max'
  // strict  = honest, conservative, exact keyword matching
  // ats_max = honest, but strategically lenient for ATS keyword coverage at big companies
  tailoring: {
    mode: process.env.TAILORING_MODE || "strict",
    // Default model override for ats_max mode (null = use same as strict)
    // 'sonnet' is gone — mantle has no Anthropic models. Mistral Large 3 is
    // the strongest open-weight model on the endpoint, so it takes the
    // "spend more for a better rewrite" slot.
    atsMaxModel: process.env.ATS_MAX_MODEL || "mistral",
  },

  // Output options
  output: {
    // Set to false to skip PDF conversion and keep DOCX only
    convertToPdf: true,
  },

  // LibreOffice path (only needed if convertToPdf is true)
  libreOffice: {
    command: "libreoffice",
  },
};

export default config;
