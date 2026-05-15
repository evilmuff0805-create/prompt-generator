'use strict';

const { createClient } = require('@supabase/supabase-js');
const { generateStoryboardData, generateStoryboardGrid } = require('./openai-client');
const { buildSystemPrompt } = require('./prompts/storyboard-system');

const ECU_CU_VALUES = new Set(['ECU', 'CU', 'Extreme Close-Up', 'Close-Up', 'extreme close-up', 'close-up']);
const DURATION_CUE_RE = /~?\d+\s*(?:seconds?|secs?|s\b)|over\s+\d+/i;

// ============================================================
// Stage 1+2: Scenario → structured shots + video prompts
// ============================================================

function validateStoryboardData(data, cutCount) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    return ['Response is not an object'];
  }

  const shots = data.shots;
  if (!Array.isArray(shots) || shots.length !== cutCount) {
    errors.push(`Expected ${cutCount} shots, got ${shots?.length ?? 0}`);
    return errors;
  }

  const angles = shots.map(s => (s.cameraAngle || '').trim());
  const uniqueAngles = new Set(angles.map(a => a.toLowerCase()));
  if (uniqueAngles.size !== cutCount) {
    errors.push(`Camera angles not unique: ${angles.join(', ')}`);
  }

  if (cutCount === 9) {
    const shot5Angle = (shots[4]?.cameraAngle || '').trim();
    if (!ECU_CU_VALUES.has(shot5Angle) && !ECU_CU_VALUES.has(shot5Angle.toLowerCase())) {
      errors.push(`Shot 5 must be ECU or CU, got: "${shot5Angle}"`);
    }
  }

  shots.forEach((shot, i) => {
    const prompt = shot.videoPrompt || '';
    if (!prompt.includes('16:9')) errors.push(`Shot ${i + 1}: missing "16:9"`);
    if (!prompt.toLowerCase().includes('cinematic 24fps')) errors.push(`Shot ${i + 1}: missing "cinematic 24fps"`);
    if (!DURATION_CUE_RE.test(prompt)) errors.push(`Shot ${i + 1}: missing duration cue`);
  });

  return errors;
}

async function generateScenarioAndPrompts({ scenario, genres, style, cutCount }) {
  const systemPrompt = buildSystemPrompt({ style, cutCount });
  let lastValidationErrors;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const data = await generateStoryboardData({ scenario, genres, style, cutCount, systemPrompt });
    const errors = validateStoryboardData(data, cutCount);

    if (errors.length === 0) {
      return data;
    }

    lastValidationErrors = errors;

    if (attempt === 2) {
      break;
    }
    // Second attempt: log and retry (generateStoryboardData already retries on JSON failure)
    console.warn(`[storyboard-engine] Validation failed (attempt ${attempt}):`, errors);
  }

  const err = new Error(`Storyboard validation failed after 2 attempts: ${lastValidationErrors.join('; ')}`);
  err.code = 'VALIDATION_FAILED';
  throw err;
}

// ============================================================
// Stage 3: Grid image generation + Storage upload
// ============================================================

function getAdminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

/**
 * Fetch reference images from Supabase, returning base64 data URLs.
 */
async function fetchReferenceImages(refIds, userId) {
  if (!refIds || refIds.length === 0) return [];

  const admin = getAdminClient();
  const { data: rows, error } = await admin
    .from('reference_images')
    .select('id, storage_path, mime_type')
    .in('id', refIds)
    .eq('user_id', userId);

  if (error) {
    const err = new Error(error.message);
    err.code = 'REF_FETCH_ERROR';
    throw err;
  }

  const buffers = [];
  for (const row of rows) {
    const { data: signedData, error: signErr } = await admin.storage
      .from('reference-images')
      .createSignedUrl(row.storage_path, 3600);

    if (signErr) {
      const err = new Error(signErr.message);
      err.code = 'REF_SIGN_ERROR';
      throw err;
    }

    const res = await fetch(signedData.signedUrl);
    if (!res.ok) {
      const err = new Error(`Failed to fetch reference image ${row.id}: ${res.status}`);
      err.code = 'REF_DOWNLOAD_ERROR';
      throw err;
    }

    const arrayBuffer = await res.arrayBuffer();
    buffers.push({ buffer: Buffer.from(arrayBuffer), mimeType: row.mime_type || 'image/png' });
  }

  return buffers;
}

/**
 * Build the grid generation prompt from shot data.
 */
function buildGridPrompt(data, style, cutCount) {
  const shots = data.shots;
  const shotDescriptions = shots.map((s, i) =>
    `Shot ${i + 1} [${s.cameraAngle}]: ${s.description}. ${s.action}. Emotion: ${s.emotion}.`
  ).join('\n');

  const characters = data.characters
    ? 'Characters: ' + Object.entries(data.characters).map(([role, name]) => `${role}=${name}`).join(', ') + '.\n'
    : '';

  return `Create a ${cutCount === 9 ? '3×3' : '2×2'} storyboard grid image. ${cutCount} panels arranged left-to-right, top-to-bottom. Each panel shows a distinct cinematic shot. Style: ${style}. 16:9 aspect ratio per panel. No text, labels, or numbers in the image. High quality.

${characters}${shotDescriptions}`;
}

/**
 * Generate grid PNG and upload to Supabase Storage via service_role.
 * Returns the storage path.
 */
async function generateGridImage({ prompt, refImageIds, cutCount, userId, storyboardId }) {
  const refBuffers = refImageIds && refImageIds.length > 0
    ? await fetchReferenceImages(refImageIds, userId)
    : [];

  const b64 = await generateStoryboardGrid({
    prompt,
    refImageBuffers: refBuffers,
    cutCount
  });

  let buffer = Buffer.from(b64, 'base64');
  const storagePath = `${userId}/${storyboardId}/grid.png`;

  try {
    const admin = getAdminClient();
    const { error } = await admin.storage
      .from('storyboards')
      .upload(storagePath, buffer, { contentType: 'image/png', upsert: false });

    if (error) {
      const err = new Error(error.message);
      err.code = 'STORAGE_UPLOAD_ERROR';
      throw err;
    }

    return storagePath;
  } finally {
    buffer = null;
  }
}

module.exports = {
  generateScenarioAndPrompts,
  buildGridPrompt,
  generateGridImage,
  fetchReferenceImages
};
