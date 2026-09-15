/**
 * LinkedIn HTML Parser
 * Parses copied LinkedIn feed HTML into normalized post format.
 */

import * as cheerio from "cheerio";

// Clean text by stripping HTML comments and excess whitespace
function cleanText(text) {
  if (!text) return null;
  return text.replace(/<!---->/g, "").replace(/\s+/g, " ").trim() || null;
}

// Extract text from a cheerio element, ignoring visually-hidden duplicates
function visibleText(el) {
  const clone = el.clone();
  clone.find(".visually-hidden").remove();
  return cleanText(clone.text());
}

/**
 * Parse LinkedIn HTML string into normalized posts.
 * @param {string} html - The raw HTML string
 * @returns {{ posts: object[] }} - Array of normalized post objects
 */
export function parseHTML(html) {
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const posts = [];

  const articles = $('[role="article"][data-urn^="urn:li:activity:"]');

  articles.each((_i, article) => {
    const $article = $(article);
    const activityUrn = $article.attr("data-urn");
    const activityId = activityUrn?.replace("urn:li:activity:", "") || null;
    if (!activityId) return;

    // === AUTHOR ===
    const actorContainer = $article.find(".update-components-actor__container").first();
    const profileLink = actorContainer.find("a.update-components-actor__meta-link").first();
    const profileUrl = profileLink.attr("href") || null;

    const nameEl = actorContainer.find(".update-components-actor__title").first();
    const name = visibleText(nameEl.find('[dir="ltr"]').first());

    const headlineEl = actorContainer.find(".update-components-actor__description").first();
    const headline = visibleText(headlineEl);

    const followBtn = $article.find('button[aria-label^="Follow "]').first();
    const followName = followBtn.attr("aria-label")?.replace("Follow ", "") || null;

    // Posted time
    const subDescEl = $article.find(".update-components-actor__sub-description").first();
    const postedAgo = visibleText(subDescEl);

    // === POST CONTENT ===
    const commentaryEl = $article.find(".update-components-update-v2__commentary").first();
    let postText = null;
    if (commentaryEl.length) {
      const textSpan = commentaryEl.find("span.break-words span[dir='ltr']").first();
      if (textSpan.length) {
        let rawHtml = textSpan.html() || "";
        rawHtml = rawHtml.replace(/<span><br><\/span>/g, "\n");
        rawHtml = rawHtml.replace(/<br\s*\/?>/g, "\n");
        const $temp = cheerio.load(rawHtml);
        postText = $temp.text()
          .replace(/<!---->/g, "")
          .replace(/hashtag\n?/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim() || null;
      }
    }

    // Extract hashtags
    const hashtags = [];
    commentaryEl.find('a[href*="keywords=%23"]').each((_j, el) => {
      const href = $(el).attr("href");
      const match = href?.match(/keywords=%23([^&]+)/);
      if (match) hashtags.push(`#${decodeURIComponent(match[1])}`);
    });

    // === JOB CARD ===
    let job = null;
    const entityEl = $article.find(".update-components-entity").first();
    if (entityEl.length) {
      const jobUrl = entityEl.find("a.update-components-entity__content").first().attr("href")?.replace(/&amp;/g, "&") || null;
      const jobTitle = cleanText(entityEl.find(".update-components-entity__title").first().text());
      const jobSubtitle = cleanText(entityEl.find(".update-components-entity__subtitle").first().text());
      const jobLocation = cleanText(entityEl.find(".update-components-entity__description").first().text());

      job = {
        title: jobTitle,
        company: jobSubtitle?.replace(/^Job by\s*/i, "") || null,
        location: jobLocation,
        jobUrl,
      };
    }

    // === ENGAGEMENT ===
    const socialCountsEl = $article.find(".social-details-social-counts").first();

    const reactionsLabel = socialCountsEl.find('[aria-label$="reactions"], [aria-label$="reaction"]').first().attr("aria-label") || "";
    const reactions = parseInt(reactionsLabel.match(/(\d[\d,]*)/)?.[1]?.replace(/,/g, ""), 10) || 0;

    const commentsLabel = socialCountsEl.find('[aria-label*="comment"]').first().attr("aria-label") || "";
    const comments = parseInt(commentsLabel.match(/(\d[\d,]*)/)?.[1]?.replace(/,/g, ""), 10) || 0;

    const repostsLabel = socialCountsEl.find('[aria-label*="repost"]').first().attr("aria-label") || "";
    const reposts = parseInt(repostsLabel.match(/(\d[\d,]*)/)?.[1]?.replace(/,/g, ""), 10) || 0;

    posts.push({
      id: activityId,
      source: "html",
      extractedAt: now,
      processed: false,

      author: {
        name: name || followName,
        headline,
        profileUrl: profileUrl?.replace(/&amp;/g, "&") || null,
      },

      post: {
        text: postText,
        postedAgo,
        hashtags,
      },

      job,

      engagement: { reactions, comments, reposts },
    });
  });

  return { posts };
}
