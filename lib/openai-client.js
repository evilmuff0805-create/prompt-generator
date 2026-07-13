'use strict';

const OpenAI = require('openai');
const { toFile } = require('openai');

const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const MODERATION_MODEL = 'omni-moderation-latest';

if (!TEXT_MODEL) {
  throw new Error('OPENAI_TEXT_MODEL is not set. Complete Phase 0 model verification first.');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Stage 1+2 (merged): generate scenario breakdown + per-shot video prompts.
 * Returns parsed JSON with { shots, characters }.
 */
async function generateStoryboardData({ scenario, genres, style, cutCount, systemPrompt }) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: TEXT_MODEL,
        max_completion_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Scenario: ${scenario}\nGenres: ${genres.join(', ')}\nStyle: ${style}\nCuts: ${cutCount}`
          }
        ]
      });

      const raw = response.choices[0].message.content;
      return JSON.parse(raw);
    } catch (err) {
      lastError = err;
      if (attempt === 1 && err instanceof SyntaxError) {
        // Retry on JSON parse failure
        continue;
      }
      break;
    }
  }

  const error = new Error(lastError?.message || 'GPT call failed after 2 attempts');
  error.status = lastError?.status;
  if (lastError?.status === 429) {
    error.code = 'OPENAI_RATE_LIMIT';
  } else if (lastError?.status === 400) {
    error.code = 'OPENAI_TEXT_INVALID_REQUEST';
  } else if (
    lastError?.code === 'ECONNABORTED'
    || lastError?.code === 'ETIMEDOUT'
    || lastError?.name === 'AbortError'
  ) {
    error.code = 'OPENAI_TIMEOUT';
  } else {
    error.code = 'OPENAI_TEXT_FAILED';
  }
  throw error;
}

/**
 * Stage 3: generate the grid PNG.
 * Branches on reference image count:
 *   0 refs  → POST /v1/images/generations
 *   1-4refs → POST /v1/images/edits (images[] array)
 * Returns base64 PNG string (caller must free ASAP).
 */
async function generateStoryboardGrid({ prompt, refImageBuffers, cutCount }) {
  const size = cutCount === 9 ? '1536x1024' : '1024x1024';
  const hasRefs = refImageBuffers && refImageBuffers.length > 0;

  try {
    let response;

    if (!hasRefs) {
      response = await openai.images.generate({
        model: IMAGE_MODEL,
        prompt,
        size,
        quality: 'high',
        n: 1,
        output_format: 'png'
      });
    } else {
      const imageFiles = await Promise.all(
        refImageBuffers.map((item, i) =>
          toFile(item.buffer, `ref_${i}.png`, { type: item.mimeType })
        )
      );
      response = await openai.images.edit({
        model: IMAGE_MODEL,
        prompt,
        image: imageFiles,
        size,
        quality: 'high',
        input_fidelity: 'high',
        n: 1,
        output_format: 'png'
      });
    }

    return response.data[0].b64_json;
  } catch (err) {
    const error = new Error(err.message);
    if (err.status === 429) {
      error.code = 'OPENAI_RATE_LIMIT';
    } else if (err.status === 400) {
      error.code = 'OPENAI_INVALID_REQUEST';
    } else if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      error.code = 'OPENAI_TIMEOUT';
    } else {
      error.code = 'OPENAI_IMAGE_FAILED';
    }
    throw error;
  }
}

/**
 * Moderate a text string. Returns { flagged: bool, categories: {} }.
 */
async function moderateText(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await openai.moderations.create({
      model: MODERATION_MODEL,
      input: text
    }, { signal: controller.signal });

    const result = response.results[0];
    return { flagged: result.flagged, categories: result.categories, category_scores: result.category_scores };
  } catch (err) {
    // fail-closed: treat timeout/error as flagged
    const error = new Error(err.message);
    error.code = 'MODERATION_ERROR';
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Moderate an image by URL. Returns { flagged: bool, categories: {} }.
 */
async function moderateImage(imageUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await openai.moderations.create({
      model: MODERATION_MODEL,
      input: [{ type: 'image_url', image_url: { url: imageUrl } }]
    }, { signal: controller.signal });

    const result = response.results[0];
    return { flagged: result.flagged, categories: result.categories, category_scores: result.category_scores };
  } catch (err) {
    const error = new Error(err.message);
    error.code = 'MODERATION_ERROR';
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateStoryboardData, generateStoryboardGrid, moderateText, moderateImage };
