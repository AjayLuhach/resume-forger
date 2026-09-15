/**
 * AWS Bedrock AI Provider (mantle endpoint)
 *
 * 2026-07: migrated off the SigV4 Converse API — the IAM keys went dead
 * (UnrecognizedClientException). Now talks to the OpenAI-compatible mantle
 * endpoint with a bearer key; see services/providers/mantle-client.js.
 *
 * Supports the open-weight catalogue: DeepSeek, Mistral, GLM, Qwen, Gemma.
 * NOT Claude — mantle hosts no Anthropic models.
 *
 * Required env vars: BEDROCK_API_KEY
 * Optional: BEDROCK_BASE_URL (default: ap-south-1 / Mumbai),
 *           BEDROCK_MODEL (default: deepseek)
 */

import config from "../../config.js";
import { BaseProvider } from "./base-provider.js";
import {
  bedrockChat,
  activeTransport,
  modelAliases,
  tailorModels,
  defaultModel,
  isConfigured as transportConfigured,
} from "./bedrock-transport.js";

export class BedrockProvider extends BaseProvider {
  constructor(modelOverride) {
    super("bedrock");

    const bedrockConfig = config.ai.bedrock;
    // Aliases are per-transport — mantle ids carry no `us.` prefix or `-v1:0`
    // suffix, AWS ids require both — so ask the transport rather than config.
    this.transport = activeTransport();
    const aliases = modelAliases(this.transport);
    const rawModelId = modelOverride || bedrockConfig.modelId || defaultModel(this.transport);

    this.modelId = aliases[rawModelId] || rawModelId;
    // Label for logs and the apply page's ATS pill. When a full model id is
    // passed rather than an alias, reverse-look it up: splitting on "." and
    // taking the last piece turned "deepseek.v3.2" into "2".
    this.modelLabel = aliases[rawModelId]
      ? rawModelId
      : Object.entries(aliases).find(([, id]) => id === this.modelId)?.[0] || this.modelId;
    this.maxTokens = bedrockConfig.maxTokens || {
      analysis: 8192,
      rewrite: 8192,
    };
  }

  getModelLabel() {
    return this.modelLabel;
  }

  getModelId() {
    return this.modelId;
  }

  /** Which transport answered — surfaced in logs and /api/models. */
  getTransport() {
    return this.transport;
  }

  async invoke(systemPrompt, messages, stepName) {
    const maxTokens = this.maxTokens[stepName] || 8000;

    try {
      const { text, usage, truncated } = await bedrockChat({
        model: this.modelId,
        system: systemPrompt,
        messages,
        maxTokens,
        temperature: 0.1,
        region: config.ai.bedrock.region,
        // Tailoring prompts are long and the rewrite step can run for a while;
        // the mantle client default (120 s) is tight for a 32K-token
        // completion. Ignored by the AWS transport, which has its own timeouts.
        timeoutMs: 300000,
        label: `tailor:${stepName}`,
      });

      console.log(`   📊 ${stepName}: ${usage.inputTokens} in → ${usage.outputTokens} out (limit: ${maxTokens})${truncated ? ' ⚠️ TRUNCATED' : ''}`);

      if (truncated) {
        console.warn(`   ⚠️  Response truncated in ${stepName} — output hit ${maxTokens} token limit. JSON may be incomplete.`);
      }

      if (!text) throw new Error("Empty response from Bedrock mantle endpoint");

      return text;
    } catch (error) {
      console.error(`Bedrock API error (${stepName}):`, error.message);
      throw error;
    }
  }

  /**
   * Check if Bedrock credentials are configured
   */
  static isConfigured() {
    return transportConfigured();
  }

  /**
   * Get available model aliases
   */
  static getModels() {
    const transport = activeTransport();
    const aliases = modelAliases(transport);
    const raw = config.ai.bedrock.modelId || defaultModel(transport);
    const fallback = aliases[raw]
      ? raw
      : Object.entries(aliases).find(([, id]) => id === raw)?.[0] || raw;
    return {
      // The curated tailoring list, not every resolvable alias — see
      // bedrock-transport.js `tailorModels`.
      models: tailorModels(transport),
      default: fallback,
      transport,
    };
  }
}

export default BedrockProvider;
