'use strict';

const OpenAI = require('openai');
const { toFile } = require('openai');
const logger = require('./logger');

const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL;
const TEXT_REASONING_EFFORT = String(
  process.env.OPENAI_TEXT_REASONING_EFFORT || 'medium'
).trim().toLowerCase();
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const MODERATION_MODEL = 'omni-moderation-latest';
const ALLOWED_REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh']);

if (!TEXT_MODEL) {
  throw new Error('OPENAI_TEXT_MODEL is not set. Complete Phase 0 model verification first.');
}
if (!ALLOWED_REASONING_EFFORTS.has(TEXT_REASONING_EFFORT)) {
  throw new Error(
    `OPENAI_TEXT_REASONING_EFFORT must be one of: ${[...ALLOWED_REASONING_EFFORTS].join(', ')}`
  );
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SHOT_REQUIRED_FIELDS = Object.freeze([
  'shotNumber',
  'narrativeBeat',
  'description',
  'cameraAngle',
  'action',
  'emotion',
  'lighting',
  'colorGrade',
  'durationSeconds',
  'videoPrompt'
]);

function buildStoryboardResponseFormat(cutCount) {
  const textField = { type: 'string' };

  return {
    type: 'json_schema',
    json_schema: {
      name: `storyboard_${cutCount}_shots`,
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['characters', 'shots'],
        properties: {
          characters: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['role', 'name'],
              properties: {
                role: textField,
                name: textField
              }
            }
          },
          shots: {
            type: 'array',
            minItems: cutCount,
            maxItems: cutCount,
            items: {
              type: 'object',
              additionalProperties: false,
              required: SHOT_REQUIRED_FIELDS,
              properties: {
                shotNumber: { type: 'integer', minimum: 1, maximum: cutCount },
                narrativeBeat: textField,
                description: textField,
                cameraAngle: textField,
                action: textField,
                emotion: textField,
                lighting: textField,
                colorGrade: textField,
                durationSeconds: { type: 'number', minimum: 0.1, maximum: 15 },
                videoPrompt: textField
              }
            }
          }
        }
      }
    }
  };
}

function normalizeStoryboardData(data) {
  if (!data || !Array.isArray(data.characters) || !Array.isArray(data.shots)) {
    throw new SyntaxError('Storyboard response does not match the required shape');
  }

  const characterEntries = [];
  const roles = new Set();
  for (const character of data.characters) {
    const role = typeof character?.role === 'string' ? character.role.trim() : '';
    const name = typeof character?.name === 'string' ? character.name.trim() : '';
    if (!role || !name || roles.has(role)) {
      throw new SyntaxError('Storyboard response contains invalid or duplicate characters');
    }
    roles.add(role);
    characterEntries.push([role, name]);
  }

  return {
    ...data,
    characters: Object.fromEntries(characterEntries)
  };
}

/**
 * Stage 1+2 (merged): generate scenario breakdown + per-shot video prompts.
 * Returns parsed JSON with { shots, characters }.
 */
async function generateStoryboardData({ scenario, genres, style, cutCount, systemPrompt }) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await openai.chat.completions.create({
        model: TEXT_MODEL,
        reasoning_effort: TEXT_REASONING_EFFORT,
        max_completion_tokens: 4000,
        response_format: buildStoryboardResponseFormat(cutCount),
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Scenario: ${scenario}\nGenres: ${genres.join(', ')}\nStyle: ${style}\nCuts: ${cutCount}`
          }
        ]
      });

      const message = response.choices?.[0]?.message;
      if (message?.refusal) {
        const refusal = new Error('The Storyboard request was refused by the text model');
        refusal.code = 'OPENAI_TEXT_REFUSED';
        throw refusal;
      }
      if (typeof message?.content !== 'string') {
        throw new SyntaxError('Storyboard response did not contain JSON text');
      }

      const data = normalizeStoryboardData(JSON.parse(message.content));
      logger.info('storyboard.text.generated', {
        model: response.model || TEXT_MODEL,
        reasoningEffort: TEXT_REASONING_EFFORT,
        attempt,
        durationMs: Date.now() - startedAt,
        usage: {
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
          totalTokens: response.usage?.total_tokens
        }
      });
      return data;
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
  if (lastError?.code === 'OPENAI_TEXT_REFUSED') {
    error.code = 'OPENAI_TEXT_REFUSED';
  } else if (lastError?.status === 429) {
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
