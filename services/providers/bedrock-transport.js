/**
 * Which Bedrock do we mean?
 *
 * Two transports reach Bedrock models and they are not interchangeable:
 *
 *   `aws`    — the real thing. SigV4 + the Converse API, credentials from the
 *              standard AWS chain. Reaches every model the account is granted,
 *              Anthropic/Titan/Llama included.
 *   `mantle` — an OpenAI-compatible /v1/chat/completions endpoint behind a
 *              bearer key. Added in 2026-07 when the IAM keys started
 *              returning UnrecognizedClientException and every SigV4 call was
 *              failing. Open-weight models ONLY.
 *
 * The mantle switch was a workaround for broken credentials, not a decision to
 * leave AWS — so this module keeps both live and picks one from env rather
 * than having the choice welded into each call site. Restoring working IAM
 * keys is then a one-line `.env` change, not a revert.
 *
 * Model IDs differ between the two (mantle has no `us.` region prefix and no
 * `-v1:0` suffix), which is why each transport owns its own alias map instead
 * of sharing one. Ask this module for the alias list; never hardcode it.
 *
 * Callers use `bedrockChat()` and stay ignorant of which transport answered —
 * both return `{ text, model, finishReason, truncated, usage }`.
 */

import config from '../../config.js';
import * as mantle from './mantle-client.js';
import * as aws from './bedrock-aws.js';

export const TRANSPORTS = ['mantle', 'aws'];

/**
 * The active transport.
 *
 * Explicit `BEDROCK_TRANSPORT` wins. With nothing set we infer from which
 * credential is present, so an existing install keeps working untouched: a
 * bearer key means mantle was deliberately configured, otherwise fall back to
 * the AWS chain.
 */
export function activeTransport() {
  const want = String(process.env.BEDROCK_TRANSPORT || config.ai?.bedrock?.transport || '')
    .toLowerCase().trim();
  if (TRANSPORTS.includes(want)) return want;
  return process.env.BEDROCK_API_KEY ? 'mantle' : 'aws';
}

const impl = (name) => (name === 'aws' ? aws : mantle);

/** Alias → model id map for a transport. The full RESOLUTION map. */
export const modelAliases = (t = activeTransport()) => impl(t).MODEL_ALIASES;

/**
 * The subset worth offering in the tailor UI, best first.
 *
 * Not the same as `modelAliases`: that one must keep every id the feed and
 * scanner reference (gemma, qwen32, …) so they still resolve, but a coder- or
 * vision-tuned model writing a resume is a bad default to put in front of
 * someone. Anthropic entries only appear on the `aws` transport, because
 * mantle genuinely cannot serve them.
 */
export const tailorModels = (t = activeTransport()) => impl(t).TAILOR_MODELS;

/** Resolve an alias or pass a full model id through, per transport. */
export const resolveModel = (input, t = activeTransport()) => impl(t).resolveModel(input);

/** Is this transport usable right now? */
export const isConfigured = (t = activeTransport()) =>
  (t === 'aws' ? aws.isConfigured() : mantle.isMantleConfigured());

/** The model to use when the caller names none. */
export function defaultModel(t = activeTransport()) {
  const configured = config.ai?.bedrock?.modelId;
  if (configured && modelAliases(t)[configured]) return configured;
  return t === 'aws' ? 'haiku' : 'deepseek';
}

/**
 * One chat completion against whichever transport is active.
 * Options are the union of both clients'; each ignores what it doesn't use
 * (`region` is meaningless to mantle, `timeoutMs` to the AWS SDK).
 */
export async function bedrockChat(opts = {}) {
  const t = opts.transport || activeTransport();
  return t === 'aws' ? aws.converseChat(opts) : mantle.mantleChat(opts);
}

/** Live model catalogue for a transport. */
export async function listModels(t = activeTransport()) {
  return t === 'aws' ? aws.listModels(config.ai?.bedrock?.region) : mantle.listModels();
}

/** Everything the UI needs to render the model picker and say what's running. */
export function transportInfo() {
  const active = activeTransport();
  return {
    active,
    configured: isConfigured(active),
    models: tailorModels(active),
    default: defaultModel(active),
    available: TRANSPORTS.map((t) => ({
      name: t,
      configured: isConfigured(t),
      models: tailorModels(t),
    })),
  };
}

export default {
  TRANSPORTS, activeTransport, bedrockChat, listModels, modelAliases, tailorModels,
  resolveModel, isConfigured, defaultModel, transportInfo,
};
