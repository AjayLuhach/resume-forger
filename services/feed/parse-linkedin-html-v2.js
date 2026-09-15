// LinkedIn HTML parser for the React markup (2025+). CSS classes are hashed,
// so everything keys off semantic attributes: posts are role="listitem", text
// is data-testid="expandable-text-box", the author name comes off the "Follow
// <name>" button, and activity ids out of the rehydration script.

import * as cheerio from "cheerio";
import crypto from "crypto";

// Activity ids come from reaction state keyed "reactionState-urn:li:activity:<id>",
// collected in first-seen order so they line up with the DOM posts.
function extractActivityIds(html) {
  const ids = [];
  const re = /reactionState-urn:li:activity:(\d{17,20})/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

// Deterministic fallback id when no real activity id is available.
function fallbackId(authorName, postText) {
  const input = `${authorName || ""}::${(postText || "").substring(0, 200)}`;
  return "gen-" + crypto.createHash("sha256").update(input).digest("hex").substring(0, 16);
}

// Strip excess whitespace.
function cleanText(text) {
  if (!text) return null;
  return text.replace(/\s+/g, " ").trim() || null;
}

// Post body, preserving line breaks.
function extractPostText($, textBoxEl) {
  let rawHtml = textBoxEl.html() || "";
  rawHtml = rawHtml.replace(/<br\s*\/?>/g, "\n");
  const $temp = cheerio.load(rawHtml);
  return (
    $temp
      .text()
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || null
  );
}

/**
 * Extract hashtags from links with keywords=%23.
 */
function extractHashtags($, container) {
  const hashtags = [];
  container.find('a[href*="keywords=%23"]').each((_j, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/keywords=%23([^&]+)/);
    if (match) hashtags.push(`#${decodeURIComponent(match[1])}`);
  });
  return hashtags;
}

/**
 * Extract engagement counts from paragraph text like "19 reactions19".
 */
function extractEngagement($, container) {
  let reactions = 0;
  let comments = 0;
  let reposts = 0;

  container.find("p").each((_i, el) => {
    const text = $(el).text().trim();
    const rMatch = text.match(/^(\d[\d,]*)\s*reaction/);
    if (rMatch) reactions = parseInt(rMatch[1].replace(/,/g, ""), 10) || 0;
    const cMatch = text.match(/^(\d[\d,]*)\s*comment/);
    if (cMatch) comments = parseInt(cMatch[1].replace(/,/g, ""), 10) || 0;
    const rpMatch = text.match(/^(\d[\d,]*)\s*repost/);
    if (rpMatch) reposts = parseInt(rpMatch[1].replace(/,/g, ""), 10) || 0;
  });

  return { reactions, comments, reposts };
}

// LinkedIn injected this badge between the name and the headline, which
// silently pushed every headline out of the slot a fixed-index read used.
const DEGREE_ONLY_RE = /^[\s•·|]*(1st|2nd|3rd)\+?[\s•·|]*$/i;
// Relative timestamps: "23h • Edited •", "3d •", "2w", "1mo".
const POSTED_AGO_RE = /^\d+\s*(s|m|h|d|w|mo|y|yr)\b/i;

const isDegreeOnly = (t) => DEGREE_ONLY_RE.test(t);
const isPostedAgo = (t) => POSTED_AGO_RE.test(t);

// Degree drives outreach routing: 1st can be messaged, 2nd is worth an
// invite, 3rd usually isn't.
function extractDegree(headerPs) {
  for (const t of headerPs) {
    const m = t.match(/(^|[\s•·|])(1st|2nd|3rd)\+?([\s•·|]|$)/i);
    if (m) return m[2].toLowerCase();
  }
  return null;
}

// Author fields from the header paragraphs. Order is NOT fixed, so match by
// shape not index: badge and timestamp by pattern, headline as the first
// paragraph that is neither.
function extractAuthor($, container, postText) {
  // Primary: "Follow <name>" button
  const followBtn = container
    .find('button[aria-label^="Follow "]')
    .first();
  const followName = followBtn.attr("aria-label")?.replace("Follow ", "") || null;

  // Person link if there is one, else the company page.
  const profileLink = container.find('a[href*="linkedin.com/in/"]').first();
  const companyLink = container.find('a[href*="linkedin.com/company/"]').first();
  let profileUrl = profileLink.attr("href") || companyLink.attr("href") || null;
  // Strip query params from profile URL for cleanliness
  if (profileUrl) {
    try {
      const u = new URL(profileUrl);
      profileUrl = u.origin + u.pathname;
    } catch {}
  }

  // Headline and posted time from paragraphs
  // Collect non-empty paragraph texts from the top of the post (before the text box)
  const textBox = container.find('[data-testid="expandable-text-box"]').first();
  const headerPs = [];
  container.find("p").each((_i, el) => {
    const p = $(el);
    // Stop once we reach paragraphs after the text box
    if (textBox.length && p.closest('[data-testid="expandable-text-box"]').length) return;
    const text = cleanText(p.text());
    if (text) headerPs.push(text);
  });

  // Follow button is the cleaner source but is absent on some posts.
  const nameLine = headerPs[0] || null;
  let name = followName || nameLine;
  if (name) {
    // "Uzma Syed  • 3rd+" → "Uzma Syed"
    name = cleanText(name.replace(/[\s•·|]*(1st|2nd|3rd)\+?[\s•·|]*$/i, ""));
  }

  const degree = extractDegree(headerPs);

  // First paragraph that isn't the name, badge or timestamp. Company posts
  // have no headline at all, hence the body check — without it the loop
  // falls through and returns the post text as the headline.
  const body = String(postText || "").replace(/\s+/g, " ").trim().toLowerCase();
  let headline = null;
  for (const t of headerPs.slice(1)) {
    if (isDegreeOnly(t) || isPostedAgo(t)) continue;
    if (name && cleanText(t) === name) continue;
    const norm = t.replace(/\s+/g, " ").trim().toLowerCase();
    if (body && norm.length > 20 && body.startsWith(norm.slice(0, 40))) continue;
    headline = t;
    break;
  }

  const postedAgo = headerPs.find(isPostedAgo) || null;

  return { name, headline, degree, profileUrl, postedAgo };
}

// Parse a rendered LinkedIn page into normalized posts.
export function parseHTMLv2(html) {
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const posts = [];

  // Extract activity IDs from the rehydration script
  const activityIds = extractActivityIds(html);

  // Each feed post sits in a role="listitem" and contains an expandable-text-box
  const listitems = $("[role=listitem]");
  let postIndex = 0;

  listitems.each((_i, el) => {
    const container = $(el);
    const textBox = container
      .find('[data-testid="expandable-text-box"]')
      .first();
    if (!textBox.length) return; // Not a post (e.g. ad placeholder)

    // Post text — read first so the author extractor can tell a real headline
    // apart from the body text leaking into the header paragraphs.
    const postText = extractPostText($, textBox);

    // Author
    const { name, headline, degree, profileUrl, postedAgo } = extractAuthor($, container, postText);

    // Permalink, when the card carries one. Read from inside THIS container so
    // the id belongs to this post; the ordered `activityIds` mapping below is a
    // positional guess and mis-assigns whenever the two lists drift.
    const permalink = container
      .find('a[href*="/feed/update/urn:li:activity:"]')
      .first()
      .attr("href") || null;
    const ownId = permalink?.match(/urn:li:activity:(\d{17,20})/)?.[1] || null;
    const postUrl = ownId
      ? `https://www.linkedin.com/feed/update/urn:li:activity:${ownId}/`
      : null;

    // Activity ID: this post's own permalink, then ordered mapping, then fallback
    const activityId =
      ownId || activityIds[postIndex] || fallbackId(name, postText);

    // Hashtags
    const hashtags = extractHashtags($, container);

    // Engagement
    const engagement = extractEngagement($, container);

    posts.push({
      id: activityId,
      source: "html",
      extractedAt: now,
      processed: false,

      author: {
        name,
        headline,
        degree,
        profileUrl,
      },

      post: {
        text: postText,
        postedAgo: cleanText(postedAgo),
        url: postUrl,
        hashtags,
      },

      job: null, // Job cards need further investigation for v2 markup

      engagement,
    });

    postIndex++;
  });

  return { posts };
}

/**
 * Quick check: does this HTML look like v2 LinkedIn markup?
 */
export function isV2Html(html) {
  // v2 has no role="article" but has expandable-text-box and role="listitem"
  return (
    !html.includes('role="article"') &&
    html.includes('data-testid="expandable-text-box"') &&
    html.includes('role="listitem"')
  );
}
