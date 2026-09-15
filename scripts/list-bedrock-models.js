#!/usr/bin/env node

/**
 * List the models available on the Bedrock mantle endpoint (BEDROCK_BASE_URL).
 *
 * The catalogue differs per region, so this is the way to find out what the
 * region in your .env actually offers before picking BEDROCK_MODEL /
 * BEDROCK_MODEL_ID / SCANNER_MODEL_ID. To reach a model by a short alias,
 * add it to the alias map of the transport you use
 * (services/providers/mantle-client.js or services/providers/bedrock-aws.js).
 *
 * Usage:
 *   node scripts/list-bedrock-models.js              # list all   (or: npm run models)
 *   node scripts/list-bedrock-models.js qwen         # filter by name
 *   node scripts/list-bedrock-models.js deepseek     # filter by name
 */

import 'dotenv/config';
import { listModels, MANTLE_BASE_URL, MODEL_ALIASES } from '../services/providers/mantle-client.js';

const filter = process.argv[2]?.toLowerCase() || '';

try {
  const all = await listModels();
  const models = all.filter((id) => !filter || id.toLowerCase().includes(filter));

  if (models.length === 0) {
    console.log(filter ? `No models matching "${filter}"` : 'No models found');
    process.exit(0);
  }

  // Reverse the alias map so each model can show the shorthand that reaches it.
  const aliasFor = {};
  for (const [alias, id] of Object.entries(MODEL_ALIASES)) {
    (aliasFor[id] = aliasFor[id] || []).push(alias);
  }

  console.log(`\n  Bedrock mantle models — ${MANTLE_BASE_URL}${filter ? ` — filter: "${filter}"` : ''}\n`);
  const maxId = Math.max(...models.map((id) => id.length));
  models.forEach((id) => {
    const alias = aliasFor[id] ? `  (alias: ${aliasFor[id].join(', ')})` : '';
    console.log(`  ${id.padEnd(maxId + 2)}${alias}`);
  });
  console.log(`\n  ${models.length} model(s) found${filter ? ` of ${all.length}` : ''}\n`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
