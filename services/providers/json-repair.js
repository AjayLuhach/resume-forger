/**
 * Tolerant JSON parsing for LLM output.
 *
 * Open-weight models (mistral / deepseek / gemma via mantle) are noticeably
 * looser than Claude about JSON hygiene. Three failure modes show up in
 * practice, all of which `JSON.parse` rejects outright:
 *
 *   1. Raw control characters inside a string value — a literal newline or
 *      tab that should have been "\n" / "\t". This is what produced
 *      "Bad control character in string literal in JSON at position 3981".
 *      It happens most when the model echoes text back from the pasted job
 *      description, since scraped career-site HTML carries stray \r, \v,
 *      \f and NBSP-adjacent junk.
 *   2. Prose before/after the JSON object ("Here is the JSON: {...}").
 *   3. Truncation — the completion hit the max-tokens cap mid-object.
 *
 * `parseLooseJSON` tries strict parse first and only escalates through the
 * repairs on failure, so well-formed output takes the fast path unchanged.
 */

const CONTROL_ESCAPES = {
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

// C0 minus \n and \t, plus DEL and the C1 block.
// eslint-disable-next-line no-control-regex
const JUNK_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Strip control characters from free text before it goes into a prompt.
 * Keeps \n and \t (meaningful layout), drops the rest of C0 plus DEL and
 * the C1 block that scraped HTML tends to smuggle in.
 *
 * Prompt-input hygiene: whatever we don't send, the model can't echo back
 * into a string literal and break the response JSON.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripControlChars(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\r\n?/g, '\n').replace(JUNK_CONTROL_CHARS, '');
}

/** Remove ```json fences and surrounding prose whitespace. */
function stripFences(text) {
  let out = String(text ?? '').trim();
  if (out.startsWith('```json')) out = out.slice(7);
  else if (out.startsWith('```')) out = out.slice(3);
  if (out.endsWith('```')) out = out.slice(0, -3);
  return out.trim();
}

/**
 * Slice out the first complete JSON object/array, ignoring braces that live
 * inside string literals. Returns the tail from the opening brace when no
 * matching close exists (truncated output) so the repair pass can finish it.
 */
function extractJsonBlock(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }

  return text.slice(start);
}

/**
 * Escape raw control characters that appear inside string literals.
 * Structural whitespace between tokens is left alone.
 */
function escapeControlChars(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }

    const code = text.charCodeAt(i);
    if (code < 0x20) {
      out += CONTROL_ESCAPES[ch] || `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }

  return out;
}

/**
 * Close off output that stopped mid-document. Drops a dangling string or
 * key fragment, trims the trailing comma, then closes open containers in
 * the order they were opened.
 */
function repairTruncation(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
    } else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  let out = text;
  // Ended mid-string → rewind past the whole unterminated value.
  if (inString && stringStart !== -1) out = out.slice(0, stringStart);
  out = out.trimEnd();
  // ...which can leave a dangling `"key":` or `"key"` behind.
  out = out.replace(/,?\s*"[^"]*"\s*:\s*$/, '');
  out = out.replace(/[,:]\s*$/, '');

  while (stack.length) out += stack.pop();
  return out;
}

/**
 * Parse LLM output into an object, repairing common malformations.
 *
 * @param {string} response - raw model text
 * @param {string} [step] - label used in the diagnostic log on total failure
 * @returns {any} parsed value
 * @throws {SyntaxError} the original parse error if no repair succeeds
 */
export function parseLooseJSON(response, step = '') {
  const text = stripFences(response);

  try {
    return JSON.parse(text);
  } catch (firstError) {
    const block = extractJsonBlock(text);

    const candidates = [];
    if (block && block !== text) candidates.push(block);
    const base = block || text;
    candidates.push(escapeControlChars(base));
    candidates.push(repairTruncation(escapeControlChars(base)));

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (step) console.log(`   ↻ Repaired malformed JSON in ${step} (${firstError.message})`);
        return parsed;
      } catch { /* try the next repair */ }
    }

    console.error(`\nJSON Parse Error in ${step}: ${firstError.message}`);
    console.error('Raw response (first 500 chars):');
    console.error(text.substring(0, 500));
    throw firstError;
  }
}

export default { parseLooseJSON, stripControlChars };
