// Lightweight Bedrock invoker for the scanner pipeline.
//
// The main tailor pipeline uses services/providers/bedrock.js (a class with
// step-aware token budgets). The scanner only needs single-prompt → text, so
// this stays a thin shim over the shared mantle client.
//
// 2026-07: switched off the SigV4 bedrock-runtime path — the old IAM keys now
// return UnrecognizedClientException, so every scan was failing. Transport,
// auth, aliases and retry all live in services/providers/mantle-client.js now.
import { bedrockChat, resolveModel } from '../providers/bedrock-transport.js';

export { resolveModel };

// Default scanner model. Gemma 3 27B is fast and cheap — good for the
// high-volume "should I bother applying?" workflow. Override via SCANNER_MODEL_ID.
export const DEFAULT_SCANNER_MODEL = resolveModel(process.env.SCANNER_MODEL_ID || 'gemma');

export async function invokeModel(prompt, options = {}) {
  const { text } = await bedrockChat({
    model: options.modelId || DEFAULT_SCANNER_MODEL,
    prompt,
    maxTokens: options.maxTokens || 4096,
    temperature: options.temperature ?? 0.1,
    timeoutMs: options.timeoutMs,
    label: 'scanner',
  });
  return text;
}

export function parseJSON(text) {
  let cleaned = String(text || '').trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return JSON.parse(cleaned.trim());
}
