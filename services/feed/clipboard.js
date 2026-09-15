/**
 * Clipboard Service - Read and auto-detect LinkedIn data format
 *
 * HTML parsers are versioned and tried newest-first:
 *   v2 — 2025+ React-based markup (role="listitem", expandable-text-box)
 *   v1 — Legacy markup (role="article", data-urn, update-components-*)
 */

import clipboardy from 'clipboardy';
import { parseFeedJSON } from './parse-linkedin-feed.js';
import { parseHTMLv2, isV2Html } from './parse-linkedin-html-v2.js';
import { parseHTML as parseHTMLv1 } from './parse-linkedin-html-v1.js';

/**
 * Ordered list of HTML parsers — newest first.
 * Each entry: { name, detect(html) -> bool, parse(html) -> {posts} }
 */
const htmlParsers = [
  {
    name: 'v2',
    detect: isV2Html,
    parse: parseHTMLv2,
  },
  {
    name: 'v1',
    detect: (html) =>
      html.includes('role="article"') || html.includes('data-urn="urn:li:activity:'),
    parse: parseHTMLv1,
  },
];

/**
 * Read text from system clipboard
 * @returns {Promise<string>} clipboard contents
 */
export async function readClipboard() {
  console.log('   Reading from clipboard...');
  try {
    const text = await clipboardy.read();
    if (!text || text.trim().length === 0) {
      throw new Error('Clipboard is empty');
    }
    return text.trim();
  } catch (error) {
    if (error.message === 'Clipboard is empty') throw error;
    throw new Error(
      'Could not read clipboard.\n' +
      'Copy LinkedIn feed data (HTML or API JSON) to your clipboard and try again.'
    );
  }
}

/**
 * Try each HTML parser in order. Returns the first one that detects
 * the format and produces posts, or falls back to brute-force trying all.
 */
function parseHTMLAuto(html) {
  // 1. Try parsers whose detect() returns true
  for (const parser of htmlParsers) {
    if (parser.detect(html)) {
      console.log(`   Detected: LinkedIn HTML (${parser.name})`);
      const result = parser.parse(html);
      if (result.posts.length > 0) return result;
      console.log(`   Parser ${parser.name} matched but returned 0 posts, trying next...`);
    }
  }

  // 2. Fallback: try every parser regardless of detect()
  for (const parser of htmlParsers) {
    try {
      const result = parser.parse(html);
      if (result.posts.length > 0) {
        console.log(`   Fallback: LinkedIn HTML (${parser.name}) found ${result.posts.length} posts`);
        return result;
      }
    } catch {
      // parser threw — skip
    }
  }

  // Nothing worked
  return { posts: [] };
}

/**
 * Auto-detect format and parse into normalized posts.
 * Supports: LinkedIn HTML (v1/v2), LinkedIn API JSON, raw text.
 * @param {string} text - raw input text
 * @returns {{ posts: object[], source: string }}
 */
export function detectAndParse(text) {
  if (text.length < 20) {
    throw new Error('Input is too short to be feed data.');
  }

  // Check if it looks like HTML
  const trimmed = text.trimStart();
  const looksLikeHtml =
    trimmed.startsWith('<') ||
    trimmed.includes('role="article"') ||
    trimmed.includes('data-urn="urn:li:activity:') ||
    trimmed.includes('data-testid="expandable-text-box"') ||
    trimmed.includes('role="listitem"');

  if (looksLikeHtml) {
    const result = parseHTMLAuto(text);
    return { ...result, source: 'html' };
  }

  // Try to parse as JSON
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON, not HTML — raw text
    console.log('   Detected: Raw text (not JSON or HTML)');
    return { posts: [], source: 'raw', rawText: text };
  }

  // Check if it's a LinkedIn API response
  const data = parsed?.data?.data;
  if (data && (data.searchDashClustersByAll || data.feedDashMainFeedByMainFeed) && parsed.included) {
    console.log('   Detected: LinkedIn API JSON');
    const result = parseFeedJSON(parsed);
    return { ...result, source: 'api' };
  }

  // Check if it's already a posts array or object with posts
  if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].id) {
    console.log('   Detected: Posts array JSON');
    const now = new Date().toISOString();
    const posts = parsed.map(p => ({
      id: p.id,
      source: 'json',
      extractedAt: now,
      processed: false,
      author: p.author || { name: null, headline: null, profileUrl: null },
      post: { text: p.content || p.text || null, postedAgo: null, hashtags: [] },
      job: p.job || null,
      engagement: { reactions: p.reactions || 0, comments: p.comments || 0, reposts: p.reposts || 0 },
    }));
    return { posts, source: 'json' };
  }

  if (parsed.posts && Array.isArray(parsed.posts)) {
    console.log('   Detected: Posts object JSON');
    const now = new Date().toISOString();
    const posts = parsed.posts.map(p => ({
      id: p.id,
      source: 'json',
      extractedAt: now,
      processed: false,
      author: p.author || { name: null, headline: null, profileUrl: null },
      post: { text: p.content || p.text || null, postedAgo: null, hashtags: [] },
      job: p.job || null,
      engagement: { reactions: p.reactions || 0, comments: p.comments || 0, reposts: p.reposts || 0 },
    }));
    return { posts, source: 'json' };
  }

  // Unknown JSON
  console.log('   Detected: Unknown JSON format');
  return { posts: [], source: 'unknown', rawJson: parsed };
}
