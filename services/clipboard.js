/**
 * Clipboard Service - Simple clipboard reading
 * Let the AI do the heavy lifting of understanding job descriptions
 */

import clipboardy from 'clipboardy';

/**
 * Read text content from system clipboard
 * @returns {Promise<string>} Clipboard text content
 */
export async function readClipboard() {
  console.log('📋 Reading job description from clipboard...');

  try {
    const text = await clipboardy.read();

    if (!text || text.trim().length === 0) {
      throw new Error('Clipboard is empty. Please copy a job description first.');
    }

    const trimmed = text.trim();
    console.log(`✅ Read ${trimmed.length} characters from clipboard`);

    return trimmed;
  } catch (error) {
    if (error.message.includes('Clipboard is empty')) {
      throw error;
    }
    throw new Error(`Failed to read clipboard: ${error.message}`);
  }
}

// Scraped HTML/JS fragments that ride along when a JD is copied out of a
// career site — inline handlers, style attributes, hydration blobs.
const MARKUP_LINE = [
  /<\/?[a-z][^>]*>/i,
  /\b(?:onclick|onmousedown|mousedown|lyte-[a-z-]*|final-style|final-class|data-[a-z-]+)\s*=/i,
  /\b(?:window\.__|__INITIAL_STATE__|apply\(record\.id)/,
  /(?:background-color|border-color)\s*:\s*#[0-9a-f]{3,8}/i,
  /\bcheck\(event\)/,
];

// Job-board UI chrome. These matter more than they look: several are
// imperative sentences aimed at an AI ("Tailor my resume", "Help me stand
// out", "Use AI to assess how you fit"). Pasted verbatim into a prompt they
// read as instructions rather than data, which is exactly the confusion we
// don't want the model spending reasoning on.
const CHROME_LINE = [
  /^(?:yes|no|save|saved|apply|applied|easy apply|simplify|v\d+)$/i,
  /^(?:show|see) (?:match details|more|less)$/i,
  /^(?:tailor my resume|help me stand out|use ai to assess how you fit)$/i,
  /^did you finish applying\??$/i,
  /^you'll find this job under .*job tracker.*$/i,
  /^get ai-powered advice\b.*$/i,
  /^reactivate premium\b.*$/i,
  /^\d{1,3}%$/,
  /^resume match$/i,
  /^\d+ of \d+ keywords?$/i,
];

/**
 * Strip job-board UI chrome and scraped markup from a pasted job description.
 *
 * Keeps every line that could plausibly be part of the actual posting — this
 * is deliberately conservative, since dropping a real requirement is far worse
 * than leaving a stray line in.
 *
 * @param {string} text - raw pasted job description
 * @returns {string} the posting with chrome and markup removed
 */
export function sanitizeJobDescription(text) {
  if (typeof text !== 'string') return '';

  const kept = text.split(/\r\n?|\n/).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // blank runs get collapsed below
    if (MARKUP_LINE.some((re) => re.test(trimmed))) return false;
    if (CHROME_LINE.some((re) => re.test(trimmed))) return false;
    return true;
  });

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Basic validation - just check it's not too short
 * AI will handle actual content understanding
 * @param {string} text - Clipboard content
 * @returns {boolean} Whether content meets minimum requirements
 */
export function validateJobDescription(text) {
  const minLength = 100;

  if (text.length < minLength) {
    console.warn(`⚠️  Warning: Content seems short (${text.length} chars). Is this a complete job description?`);
    return false;
  }

  console.log('✅ Content length OK - AI will analyze the job description');
  return true;
}

export default { readClipboard, validateJobDescription, sanitizeJobDescription };
