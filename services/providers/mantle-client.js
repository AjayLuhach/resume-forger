// Shared client for the Bedrock "mantle" endpoint — OpenAI-compatible, bearer
// key (BEDROCK_API_KEY), no SigV4. Added 2026-07 when the IAM keys started
// returning UnrecognizedClientException; tailor, feed and scanner all use it.
// Model ids drop the us./global. prefix and the -v1:0 suffix.
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

export const MANTLE_BASE_URL = (
  process.env.BEDROCK_BASE_URL || 'https://bedrock-mantle.ap-south-1.api.aws/v1'
).replace(/\/+$/, '');

// Root without /v1 — the second surface lives at /openai/v1.
export const MANTLE_HOST = MANTLE_BASE_URL.replace(/\/v1$/, '');

// Gemma 4 is served only by /openai/v1; everything else only by /v1. The two
// surfaces are mutually exclusive — wrong one returns 400, not a 404.
export const usesOpenAISurface = (modelId) => /^google\.gemma-4/.test(String(modelId || ''));

// Canonical aliases → mantle model IDs. The catalogue is PER-REGION: Mumbai
// (default) serves 38 open-weight models, us-east-1 serves 55 including
// Anthropic/GPT/Grok/Gemma-4. Switch with BEDROCK_BASE_URL; a model your
// region lacks 404s by name. Anthropic and GPT are listed but 403/401
// "not available for this account" until enabled in the console.
export const MODEL_ALIASES = {
  gemma:    'google.gemma-3-27b-it',                  // 128K ctx, 8K out, multimodal
  gemma12:  'google.gemma-3-12b-it',
  // ── Gemma 4 — us-east-1 / us-west-2 / eu-central-1 only ──
  gemma4:   'google.gemma-4-31b',
  gemma4moe:'google.gemma-4-26b-a4b',
  // ── Anthropic — us-east-1 only ──
  haiku:    'anthropic.claude-haiku-4-5',
  sonnet:   'anthropic.claude-sonnet-5',
  opus:     'anthropic.claude-opus-5',
  // ── OpenAI / xAI — us-east-1 only ──
  luna:     'openai.gpt-5.6-luna',                    // cheapest of the 5.6 line
  terra:    'openai.gpt-5.6-terra',
  sol:      'openai.gpt-5.6-sol',
  grok:     'xai.grok-4.3',
  deepseek: 'deepseek.v3.2',
  mistral:  'mistral.mistral-large-3-675b-instruct',
  glm:      'zai.glm-5',
  glm47:    'zai.glm-4.7',
  glmflash: 'zai.glm-4.7-flash',
  // The plain instruct model, not the -vl vision variant that used to sit here.
  // The benchmark below measured this one; pointing the alias at the VL model
  // meant picking "qwen" in the UI ran something that was never tested.
  qwen:     'qwen.qwen3-235b-a22b-2507',
  qwenvl:   'qwen.qwen3-vl-235b-a22b-instruct',
  qwen32:   'qwen.qwen3-32b',
  qwencoder:'qwen.qwen3-coder-480b-a35b-instruct',
  kimi:     'moonshotai.kimi-k2.5',
};

// Subset worth offering in the tailor picker — ranked 2026-08-08 on JD-technology
// coverage against one fixed lexicon (deepseek 74% / glm47 72% / qwen 66% /
// mistral 65%), chosen on worst case, not mean. `haiku` is absent because
// us-east-1 lists it but does not entitle it.
export const TAILOR_MODELS = ['deepseek', 'glm47', 'qwen', 'mistral', 'glm'];

export const resolveModel = (input) => {
  const key = String(input || '').toLowerCase().trim();
  return MODEL_ALIASES[key] || input;
};

export const isMantleConfigured = () => !!process.env.BEDROCK_API_KEY;

const getApiKey = () => {
  const key = process.env.BEDROCK_API_KEY;
  if (!key) {
    throw new Error(
      'BEDROCK_API_KEY is not set.\n' +
      'Add to .env:\n' +
      '  BEDROCK_BASE_URL=https://bedrock-mantle.ap-south-1.api.aws/v1\n' +
      '  BEDROCK_API_KEY=<your mantle API key>'
    );
  }
  return key;
};

// Reasoning models (kimi, minimax, glm-thinking) can return content:null when
// the token budget was spent thinking — fall back to reasoning_content so the
// caller gets something useful instead of "undefined".
const extractText = (body) => {
  const choice = body?.choices?.[0];
  if (!choice) return JSON.stringify(body);
  return choice.message?.content || choice.message?.reasoning_content || choice.text || '';
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One chat completion. Pass `prompt` for single-turn or `messages` for a chat;
// `model` takes an alias or a full id. Returns
// { text, model, finishReason, truncated, usage }.
export async function mantleChat({
  model,
  system,
  messages,
  prompt,
  maxTokens = 4096,
  temperature = 0.1,
  topP,
  timeoutMs = 120000,
  retries = 2,
  label = 'mantle',
} = {}) {
  const apiKey = getApiKey();
  const modelId = resolveModel(model);
  if (!modelId) throw new Error(`${label}: no model specified`);

  const chat = [];
  if (system) chat.push({ role: 'system', content: system });
  if (messages?.length) {
    for (const m of messages) {
      // Bedrock Converse used content arrays ([{text}]); mantle wants a plain
      // string. Flatten so callers migrating off Converse keep working.
      const content = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c) => c?.text ?? '').join('')
          : String(m.content ?? '');
      chat.push({ role: m.role, content });
    }
  } else if (prompt) {
    chat.push({ role: 'user', content: prompt });
  }
  if (!chat.length) throw new Error(`${label}: no prompt or messages provided`);

  // The /openai surface also renames max_tokens → max_completion_tokens.
  const openaiSurface = usesOpenAISurface(modelId);
  const url = openaiSurface
    ? `${MANTLE_HOST}/openai/v1/chat/completions`
    : `${MANTLE_BASE_URL}/chat/completions`;

  const payload = { model: modelId, messages: chat };
  payload[openaiSurface ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
  if (openaiSurface) {
    // This surface rejects any temperature but its default, so omit it —
    // callers asking for a low one silently get the model's default.
    if (topP !== undefined) payload.top_p = topP;
  } else {
    payload.temperature = temperature;
    if (topP !== undefined) payload.top_p = topP;
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Network error / timeout — retryable.
      lastErr = new Error(`${label}: request failed (${modelId}): ${e.message}`);
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw lastErr;
    }

    const raw = await response.text();

    if (!response.ok) {
      // Surface the API's own message — an expired key, an unknown model and a
      // rate limit are indistinguishable from a bare status code.
      let detail = raw.slice(0, 300);
      try { detail = JSON.parse(raw).error?.message || detail; } catch { /* keep raw */ }
      const retryable = response.status === 429 || response.status >= 500;
      lastErr = new Error(`${label}: Bedrock ${response.status} (${modelId}): ${detail}`);
      if (retryable && attempt < retries) {
        const waitMs = response.status === 429 ? 10000 * (attempt + 1) : 2000 * (attempt + 1);
        console.log(`   ${label}: HTTP ${response.status}, retrying in ${waitMs / 1000}s...`);
        await sleep(waitMs);
        continue;
      }
      throw lastErr;
    }

    const body = JSON.parse(raw);
    const finishReason = body?.choices?.[0]?.finish_reason || null;
    return {
      text: extractText(body),
      model: body?.model || modelId,
      finishReason,
      truncated: finishReason === 'length',
      usage: {
        inputTokens: body?.usage?.prompt_tokens ?? 0,
        outputTokens: body?.usage?.completion_tokens ?? 0,
        totalTokens: body?.usage?.total_tokens ?? 0,
      },
    };
  }
  throw lastErr;
}

/** Live model catalogue — ids only, sorted. */
export async function listModels() {
  const response = await fetch(`${MANTLE_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`mantle: model list failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
  const body = await response.json();
  return (body.data || []).map((m) => m.id).sort();
}

export default { mantleChat, listModels, resolveModel, isMantleConfigured, MODEL_ALIASES, TAILOR_MODELS, MANTLE_BASE_URL };
