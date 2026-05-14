'use strict';

const { moderateText, moderateImage } = require('./openai-client');

/**
 * Run text moderation then image moderation (if imageUrl provided).
 * Fails closed: any error is treated as flagged.
 * Returns { flagged: bool, reason: string }.
 */
async function moderateContent({ text, imageUrl }) {
  try {
    if (text && text.length > 0) {
      const textResult = await moderateText(text);
      if (textResult.flagged) {
        return { flagged: true, reason: 'text_flagged' };
      }
    }

    if (imageUrl) {
      const imageResult = await moderateImage(imageUrl);
      if (imageResult.flagged) {
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

module.exports = { moderateContent };
