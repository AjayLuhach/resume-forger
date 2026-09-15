/**
 * Classic AWS Bedrock transport — SigV4 + the Converse API.
 *
 * This is the original path, kept alive alongside the mantle endpoint because
 * the mantle move was a workaround, not a migration: in 2026-07 the IAM keys
 * started returning UnrecognizedClientException and every SigV4 call failed.
 * When working credentials exist, this transport is strictly more capable —
 * Anthropic, Titan and Llama models are only reachable here.
 *
 * Deliberately exposes the SAME shape as `mantleChat` in mantle-client.js
 * (`{ text, model, finishReason, truncated, usage }`), so callers switch
 * transports without knowing which one they got. See bedrock-transport.js.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

// Aliases → real Bedrock model IDs. Note these differ from mantle's: the
// region prefix (`us.`) and version suffix (`-v1:0`) are required here and
// forbidden there, which is exactly why the two maps can't be shared.
export const MODEL_ALIASES = {
  haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  sonnet: 'us.anthropic.claude-sonnet-4-6',
  deepseek: 'deepseek.v3.2',
  qwen: 'qwen.qwen3-vl-235b-a22b',
  glm: 'zai.glm-4.7',
  gemma: 'google.gemma-3-27b-it',
  llama: 'meta.llama3-1-70b-instruct-v1:0',
  mistral: 'mistral.mistral-large-2407-v1:0',
  titan: 'amazon.titan-text-premier-v1:0',
};

/**
 * Tailoring-worthy subset of the above, best first. Titan and Llama resolve
 * for other callers but are not competitive at structured resume rewriting,
 * and gemma is the feed/scanner workhorse rather than a tailoring model.
 *
 * Anthropic models are reachable ONLY on this transport — that is the main
 * reason to switch back to `aws` once IAM credentials work again.
 */
export const TAILOR_MODELS = ['haiku', 'sonnet', 'deepseek', 'glm', 'qwen', 'mistral'];

export const resolveModel = (input) => {
  const key = String(input || '').toLowerCase().trim();
  return MODEL_ALIASES[key] || input;
};

/**
 * Credentials come from the standard AWS chain (env, ~/.aws, instance role),
 * so "configured" means the SDK can find *something* — an explicit key pair in
 * env is the common case here and the only one we can check cheaply.
 */
export const isConfigured = () =>
  !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  || !!process.env.AWS_PROFILE
  || !!process.env.AWS_ROLE_ARN;

let client = null;
const getClient = (region) => {
  if (!client) client = new BedrockRuntimeClient({ region });
  return client;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Throttling and transient 5xx are worth another go; a bad model id or bad
// credentials are not, and retrying them just delays the real error.
const RETRYABLE = new Set([
  'ThrottlingException',
  'ServiceUnavailableException',
  'InternalServerException',
  'ModelTimeoutException',
  'ModelNotReadyException',
]);

/**
 * One Converse call. Signature mirrors `mantleChat`.
 *
 * @returns {Promise<{text, model, finishReason, truncated, usage}>}
 */
export async function converseChat({
  model,
  system,
  messages,
  prompt,
  maxTokens = 4096,
  temperature = 0.1,
  topP,
  region = process.env.AWS_REGION || 'us-east-1',
  retries = 2,
  label = 'bedrock',
} = {}) {
  const modelId = resolveModel(model);
  if (!modelId) throw new Error(`${label}: no model specified`);

  const source = messages?.length
    ? messages
    : prompt
      ? [{ role: 'user', content: prompt }]
      : [];
  if (!source.length) throw new Error(`${label}: no prompt or messages provided`);

  // Converse wants content as an array of blocks; callers written against the
  // mantle client pass plain strings, so accept both.
  const converseMessages = source.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? [{ text: m.content }]
      : Array.isArray(m.content) ? m.content : [{ text: String(m.content ?? '') }],
  }));

  const inferenceConfig = { maxTokens, temperature };
  if (topP !== undefined) inferenceConfig.topP = topP;

  const command = new ConverseCommand({
    modelId,
    ...(system ? { system: [{ text: system }] } : {}),
    messages: converseMessages,
    inferenceConfig,
  });

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await getClient(region).send(command);
      const text = (response.output?.message?.content || [])
        .map((b) => b.text || '')
        .join('');
      return {
        text,
        model: modelId,
        finishReason: response.stopReason || null,
        truncated: response.stopReason === 'max_tokens',
        usage: {
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
          totalTokens: response.usage?.totalTokens ?? 0,
        },
      };
    } catch (e) {
      lastErr = new Error(`${label}: Bedrock ${e.name || 'error'} (${modelId}): ${e.message}`);
      if (RETRYABLE.has(e.name) && attempt < retries) {
        const waitMs = 2000 * (attempt + 1);
        console.log(`   ${label}: ${e.name}, retrying in ${waitMs / 1000}s...`);
        await sleep(waitMs);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

/** Model ids this account can actually invoke, sorted. */
export async function listModels(region = process.env.AWS_REGION || 'us-east-1') {
  const { BedrockClient, ListFoundationModelsCommand } = await import('@aws-sdk/client-bedrock');
  const c = new BedrockClient({ region });
  const out = await c.send(new ListFoundationModelsCommand({}));
  return (out.modelSummaries || []).map((m) => m.modelId).sort();
}

export default { converseChat, listModels, resolveModel, isConfigured, MODEL_ALIASES, TAILOR_MODELS };
