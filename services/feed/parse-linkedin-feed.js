/**
 * LinkedIn Feed/Search API Response Parser
 * Parses GraphQL/REST API JSON responses into normalized post format.
 */

// Build lookup map from included entities by $type
function buildLookup(included, type) {
  const map = {};
  for (const item of included) {
    if (item["$type"] === type) {
      map[item.entityUrn] = item;
    }
  }
  return map;
}

// Extract hashtag names from commentary attributesV2
function extractInlineHashtags(commentary) {
  const hashtags = [];
  const attrs = commentary?.text?.attributesV2 || [];
  for (const attr of attrs) {
    const hashtagRef = attr.detailData?.["*hashtag"];
    if (hashtagRef) {
      const match = hashtagRef.match(/urn:li:fsd_hashtag:\(([^,]+),/);
      if (match) hashtags.push(`#${match[1]}`);
    }
  }
  return hashtags;
}

/**
 * Parse LinkedIn API/GraphQL response JSON into normalized posts.
 * @param {object} raw - The raw API response (parsed JSON object)
 * @returns {{ posts: object[] }} - Array of normalized post objects
 */
export function parseFeedJSON(raw) {
  const included = raw.included || [];

  // Determine search items source
  let searchItems = [];
  const data = raw?.data?.data;
  if (data?.searchDashClustersByAll) {
    const elements = data.searchDashClustersByAll.elements || [];
    for (const el of elements) {
      if (el.items) searchItems.push(...el.items);
    }
  } else if (data?.feedDashMainFeedByMainFeed) {
    const elements = data.feedDashMainFeedByMainFeed.elements || [];
    for (const el of elements) {
      if (el.items) searchItems.push(...el.items);
      else searchItems.push({ item: { searchFeedUpdate: { "*update": el.entityUrn } } });
    }
  }

  if (searchItems.length === 0) {
    return { posts: [] };
  }

  const activityCountsMap = buildLookup(included, "com.linkedin.voyager.dash.feed.SocialActivityCounts");

  // Collect all updates keyed by entityUrn
  const updateMap = {};
  for (const item of included) {
    if (item["$type"] === "com.linkedin.voyager.dash.feed.Update") {
      updateMap[item.entityUrn] = item;
    }
  }

  const now = new Date().toISOString();

  const posts = searchItems.map((searchItem) => {
    const updateUrn = searchItem.item?.searchFeedUpdate?.["*update"];
    if (!updateUrn) return null;

    const update = updateMap[updateUrn];
    if (!update) return null;

    const actor = update.actor;
    const commentary = update.commentary;
    const metadata = update.metadata;
    const entityComponent = update.content?.entityComponent;

    const activityUrn = metadata?.backendUrn || null;
    const activityId = activityUrn?.replace("urn:li:activity:", "") || null;
    if (!activityId) return null;

    // Find social counts
    const countsUrn = `urn:li:fsd_socialActivityCounts:${activityUrn}`;
    const shareUrn = metadata?.shareUrn;
    const countsUrnAlt = shareUrn ? `urn:li:fsd_socialActivityCounts:${shareUrn}` : null;
    let socialCounts = activityCountsMap[countsUrn] || activityCountsMap[countsUrnAlt] || null;

    if (!socialCounts) {
      for (const item of included) {
        if (item["$type"] === "com.linkedin.voyager.dash.feed.SocialActivityCounts") {
          if (item.urn === activityUrn || item.urn === shareUrn) {
            socialCounts = item;
            break;
          }
        }
      }
    }

    return {
      id: activityId,
      source: "api",
      extractedAt: now,
      processed: false,

      author: {
        name: actor?.name?.text || null,
        headline: actor?.description?.text || null,
        profileUrl: actor?.navigationContext?.actionTarget || null,
      },

      post: {
        text: commentary?.text?.text || null,
        postedAgo: actor?.subDescription?.text?.trim() || null,
        hashtags: extractInlineHashtags(commentary),
      },

      job: entityComponent
        ? {
            title: entityComponent.title?.text || null,
            company: entityComponent.subtitle?.text?.replace("Job by ", "") || null,
            location: null,
            jobUrl: entityComponent.ctaButton?.navigationContext?.actionTarget || null,
          }
        : null,

      engagement: socialCounts
        ? {
            reactions: socialCounts.numLikes || 0,
            comments: socialCounts.numComments || 0,
            reposts: socialCounts.numShares || 0,
          }
        : { reactions: 0, comments: 0, reposts: 0 },
    };
  });

  return { posts: posts.filter(Boolean) };
}
