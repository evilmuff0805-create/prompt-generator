'use strict';

const { createClient } = require('@supabase/supabase-js');
const { generateStoryboardData, generateStoryboardGrid } = require('./openai-client');
const { buildSystemPrompt } = require('./prompts/storyboard-system');
const STYLE_TEMPLATES = require('./prompts/style-templates');

const ECU_CU_VALUES = new Set(['ECU', 'CU', 'Extreme Close-Up', 'Close-Up', 'extreme close-up', 'close-up']);
// Decimal-aware: per-shot budgets like "~1.5 seconds" (9 cuts) must match.
const DURATION_CUE_RE = /~?\d+(?:\.\d+)?\s*(?:seconds?|secs?|s\b)|over\s+\d+(?:\.\d+)?/i;
// Seedance 2.0 hard cap: total video length. Small epsilon absorbs float artifacts
// (e.g. 1.7*3 + 1.65*6). Kept in sync with prompts/storyboard-system.js.
const MAX_TOTAL_SECONDS = 15;
const SUM_EPSILON = 0.001;

// ============================================================
// Stage 1+2: Scenario → structured shots + video prompts
// ============================================================

function validateStoryboardData(data, cutCount, style) {
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
    if (style === 'Cinematic' && !prompt.toLowerCase().includes('ultra-realistic')) {
      errors.push(`Shot ${i + 1}: missing "ultra-realistic" for Cinematic style`);
    }
    if (!DURATION_CUE_RE.test(prompt)) errors.push(`Shot ${i + 1}: missing duration cue`);
    if (typeof shot.durationSeconds !== 'number' || !isFinite(shot.durationSeconds) || shot.durationSeconds <= 0) {
      errors.push(`Shot ${i + 1}: durationSeconds must be a positive number, got: ${JSON.stringify(shot.durationSeconds)}`);
    }
  });

  // Seedance 15s cap: reject if per-shot durations sum past the budget.
  // Only meaningful when every shot has a valid number (individual errors above cover the rest).
  const allNumeric = shots.every(s => typeof s.durationSeconds === 'number' && isFinite(s.durationSeconds) && s.durationSeconds > 0);
  if (allNumeric) {
    const total = shots.reduce((sum, s) => sum + s.durationSeconds, 0);
    if (total > MAX_TOTAL_SECONDS + SUM_EPSILON) {
      errors.push(`Total duration ${total.toFixed(2)}s exceeds Seedance ${MAX_TOTAL_SECONDS}s cap`);
    }
  }

  return errors;
}

async function generateScenarioAndPrompts({ scenario, genres, style, cutCount }) {
  const systemPrompt = buildSystemPrompt({ style, cutCount });
  let lastValidationErrors;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const data = await generateStoryboardData({ scenario, genres, style, cutCount, systemPrompt });
    const errors = validateStoryboardData(data, cutCount, style);

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
  const template = STYLE_TEMPLATES[style];
  const styleDirective = template?.realismConstraint
    ? `Style: ${style}. Mandatory realism: ${template.realismConstraint}.`
    : `Style: ${style}.`;
  const continuityDirective = template?.continuityConstraint
    ? ` Mandatory physical continuity: ${template.continuityConstraint}. Preserve prior-panel state unless the described action explicitly changes it.`
    : '';
  const frameSafetyDirective = template?.frameSafetyConstraint
    ? ` Mandatory framing: ${template.frameSafetyConstraint}.`
    : '';
  const shotDescriptions = shots.map((s, i) =>
    `Shot ${i + 1} [${s.cameraAngle}]: ${s.description}. ${s.action}. Emotion: ${s.emotion}.`
      + (template?.continuityConstraint ? ` Lighting: ${s.lighting}. Color grade: ${s.colorGrade}.` : '')
  ).join('\n');

  const characters = data.characters
    ? 'Characters: ' + Object.entries(data.characters).map(([role, name]) => `${role}=${name}`).join(', ') + '.\n'
    : '';

  return `Create a ${cutCount === 9 ? '3×3' : '2×2'} storyboard grid image. ${cutCount} panels arranged left-to-right, top-to-bottom. Each panel shows a distinct cinematic shot. ${styleDirective}${continuityDirective}${frameSafetyDirective} 16:9 aspect ratio per panel. No text, labels, or numbers in the image. High quality.

${characters}${shotDescriptions}`;
}

/**
 * Generate grid PNG and upload to Supabase Storage via service_role.
 * Returns the storage path.
 */
async function generateGridImage({ prompt, refImageIds, cutCount, userId, storyboardId, attemptToken }) {
  const refBuffers = refImageIds && refImageIds.length > 0
    ? await fetchReferenceImages(refImageIds, userId)
    : [];

  const b64 = await generateStoryboardGrid({
    prompt,
    refImageBuffers: refBuffers,
    cutCount
  });

  let buffer = Buffer.from(b64, 'base64');
  // A unique path per claim prevents a stale worker from overwriting the grid
  // adopted by a newer attempt. The processor deletes paths whose fenced
  // completion is rejected.
  const safeAttemptToken = String(attemptToken || 'legacy')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);
  const storagePath = `${userId}/${storyboardId}/grid-${safeAttemptToken}.png`;

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
  fetchReferenceImages,
  validateStoryboardData
};
