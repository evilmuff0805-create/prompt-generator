'use strict';

const MAX_INPUT_PIXELS = 40_000_000;
const REPRESENTATIVE_COLOR_SIZE = 64;

const STANDARD_ASPECT_RATIOS = Object.freeze([
  Object.freeze({ label: '1:1', value: 1 }),
  Object.freeze({ label: '16:9', value: 16 / 9 }),
  Object.freeze({ label: '9:16', value: 9 / 16 }),
  Object.freeze({ label: '4:3', value: 4 / 3 }),
  Object.freeze({ label: '3:4', value: 3 / 4 }),
  Object.freeze({ label: '4:5', value: 4 / 5 }),
  Object.freeze({ label: '5:4', value: 5 / 4 }),
  Object.freeze({ label: '3:2', value: 3 / 2 }),
  Object.freeze({ label: '2:3', value: 2 / 3 }),
  Object.freeze({ label: '21:9', value: 21 / 9 })
]);

function isImageMetadataShadowEnabled(env = process.env) {
  return String(env.GEMINI_IMAGE_METADATA_SHADOW_ENABLED || '').trim().toLowerCase() === 'true';
}

function classifyAspectRatio(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const actual = width / height;
  return STANDARD_ASPECT_RATIOS.reduce((closest, candidate) => {
    const distance = Math.abs(Math.log(actual / candidate.value));
    return distance < closest.distance ? { label: candidate.label, distance } : closest;
  }, { label: null, distance: Number.POSITIVE_INFINITY }).label;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function getDisplayDimensions(metadata = {}) {
  const sourceWidth = positiveInteger(metadata.width);
  const sourceHeight = positiveInteger(metadata.pageHeight) || positiveInteger(metadata.height);
  const autoOrientWidth = positiveInteger(metadata.autoOrient?.width);
  const autoOrientHeight = positiveInteger(metadata.autoOrient?.height);

  if (autoOrientWidth && autoOrientHeight) {
    return { sourceWidth, sourceHeight, displayWidth: autoOrientWidth, displayHeight: autoOrientHeight };
  }

  const orientation = positiveInteger(metadata.orientation) || 1;
  const swapsAxes = orientation >= 5 && orientation <= 8;
  return {
    sourceWidth,
    sourceHeight,
    displayWidth: swapsAxes ? sourceHeight : sourceWidth,
    displayHeight: swapsAxes ? sourceWidth : sourceHeight
  };
}

function rgbToHex(color = {}) {
  const channels = ['r', 'g', 'b'].map((channel) => {
    const value = color[channel];
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(255, Math.round(value)));
  });
  if (channels.some((value) => value == null)) return null;
  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function normalizeImageMetadata(metadata, representativeHex) {
  const dimensions = getDisplayDimensions(metadata);
  const pages = positiveInteger(metadata.pages) || 1;
  return {
    format: typeof metadata.format === 'string' ? metadata.format : 'unknown',
    ...dimensions,
    orientation: positiveInteger(metadata.orientation) || 1,
    aspectRatio: classifyAspectRatio(dimensions.displayWidth, dimensions.displayHeight),
    pages,
    animated: pages > 1,
    hasAlpha: metadata.hasAlpha === true,
    representativeHex: representativeHex || null
  };
}

function createExtractionError(code, cause) {
  const error = new Error(code === 'IMAGE_METADATA_INPUT_INVALID'
    ? 'Image metadata input is invalid'
    : 'Image metadata extraction failed');
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function extractImageShadowMetadata(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw createExtractionError('IMAGE_METADATA_INPUT_INVALID');
  }

  try {
    // Lazy-loading keeps the default-OFF path free from native image work.
    const sharp = require('sharp');
    const inputOptions = {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
      pages: 1,
      sequentialRead: true
    };
    const metadata = await sharp(inputBuffer, inputOptions).metadata();

    // stats() describes its direct input, so materialize a tiny, oriented,
    // alpha-free sRGB image before calculating the representative colour.
    const representativeInput = await sharp(inputBuffer, inputOptions)
      .autoOrient()
      .resize({
        width: REPRESENTATIVE_COLOR_SIZE,
        height: REPRESENTATIVE_COLOR_SIZE,
        fit: 'inside',
        withoutEnlargement: true
      })
      .removeAlpha()
      .toColourspace('srgb')
      .png()
      .toBuffer();
    const stats = await sharp(representativeInput, {
      failOn: 'error',
      limitInputPixels: REPRESENTATIVE_COLOR_SIZE * REPRESENTATIVE_COLOR_SIZE
    }).stats();

    return normalizeImageMetadata(metadata, rgbToHex(stats.dominant));
  } catch (error) {
    if (error?.code === 'IMAGE_METADATA_INPUT_INVALID') throw error;
    throw createExtractionError('IMAGE_METADATA_EXTRACTION_FAILED', error);
  }
}

module.exports = {
  MAX_INPUT_PIXELS,
  REPRESENTATIVE_COLOR_SIZE,
  classifyAspectRatio,
  extractImageShadowMetadata,
  getDisplayDimensions,
  isImageMetadataShadowEnabled,
  normalizeImageMetadata,
  rgbToHex
};
