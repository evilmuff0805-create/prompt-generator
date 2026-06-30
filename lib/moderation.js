'use strict';

const { moderateText, moderateImage } = require('./openai-client');

// Only these OpenAI moderation categories cause a block. Fictional violence,
// gore, harassment, hate, and illicit categories are intentionally NOT blocked
// (creative scenarios like sword battles must pass). sexual/minors is always
// blocked and can never pass. Exact keys per omni-moderation-latest.
const BLOCKED_CATEGORIES = [
  'sexual',
  'sexual/minors',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions'
];

// Returns true if any BLOCKED category is flagged (true) in the categories object.
function hasBlockedCategory(categories) {
  if (!categories) return false;
  return BLOCKED_CATEGORIES.some((key) => categories[key] === true);
}

/**
 * Run text moderation then image moderation (if imageUrl provided).
 * Blocking is category-selective: only sexual / sexual:minors / self-harm
 * categories block; other flags (violence, hate, harassment, illicit) pass.
 * Fails closed: any error is treated as flagged (reason='moderation_error').
 * Returns { flagged: bool, reason: string }.
 */
async function moderateContent({ text, imageUrl }) {
  try {
    if (text && text.length > 0) {
      const textResult = await moderateText(text);
      if (hasBlockedCategory(textResult.categories)) {
        return { flagged: true, reason: 'text_flagged' };
      }
    }

    if (imageUrl) {
      const imageResult = await moderateImage(imageUrl);
      if (hasBlockedCategory(imageResult.categories)) {
        return { flagged: true, reason: 'image_flagged' };
      }
    }

    return { flagged: false, reason: null };
  } catch (err) {
    // fail-closed: moderation error → treat as flagged
    console.error('[moderation] error:', err.message);
    return { flagged: true, reason: 'moderation_error' };
  }
}

module.exports = { moderateContent, hasBlockedCategory, BLOCKED_CATEGORIES };
