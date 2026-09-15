/**
 * Extract Store - Manages persistent output/extract.json
 * Handles append with deduplication and processed state tracking.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// services/feed/ → climb two levels to reach the repo root's output/.
const EXTRACT_PATH = path.join(__dirname, '..', '..', 'output', 'extract.json');

function ensureOutputDir() {
  const dir = path.dirname(EXTRACT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load existing extract data or return empty structure.
 */
export function loadExtract() {
  ensureOutputDir();
  if (!fs.existsSync(EXTRACT_PATH)) {
    return { lastUpdated: null, totalPosts: 0, posts: [] };
  }
  try {
    const raw = fs.readFileSync(EXTRACT_PATH, 'utf-8').trim();
    if (!raw) return { lastUpdated: null, totalPosts: 0, posts: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.posts)) {
      return { lastUpdated: null, totalPosts: 0, posts: [] };
    }
    return parsed;
  } catch {
    return { lastUpdated: null, totalPosts: 0, posts: [] };
  }
}

/**
 * Save extract data to file.
 */
export function saveExtract(data) {
  ensureOutputDir();
  fs.writeFileSync(EXTRACT_PATH, JSON.stringify(data, null, 2));
}

/**
 * Append new posts, deduplicating by id.
 * @param {object[]} newPosts - Array of normalized post objects
 * @returns {{ added: number, skipped: number, total: number }}
 */
export function appendPosts(newPosts) {
  const data = loadExtract();
  const existingIds = new Set(data.posts.map(p => p.id));

  let added = 0;
  let skipped = 0;

  for (const post of newPosts) {
    if (existingIds.has(post.id)) {
      skipped++;
    } else {
      data.posts.push(post);
      existingIds.add(post.id);
      added++;
    }
  }

  data.lastUpdated = new Date().toISOString();
  data.totalPosts = data.posts.length;
  saveExtract(data);

  return { added, skipped, total: data.totalPosts };
}

/**
 * Get all posts that haven't been processed by AI yet.
 */
export function getUnprocessedPosts() {
  const data = loadExtract();
  return data.posts.filter(p => !p.processed);
}

/**
 * Mark posts as processed by their IDs.
 * @param {string[]} postIds
 */
export function markProcessed(postIds) {
  const data = loadExtract();
  const idSet = new Set(postIds);
  for (const post of data.posts) {
    if (idSet.has(post.id)) {
      post.processed = true;
    }
  }
  data.lastUpdated = new Date().toISOString();
  saveExtract(data);
}
