'use strict';

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const requireAuth = require('../middleware/auth');
const creditManager = require('../lib/credit-manager');
const { moderateContent } = require('../lib/moderation');
const jobStore = require('../lib/storyboard-job-store');
const storyboardWorker = require('../lib/storyboard-worker');

// Multer: memory storage, 10MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.STORYBOARD_MAX_FILE_SIZE_MB || '10', 10) * 1024 * 1024 }
});

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VALID_GENRES = new Set(['Romance', 'Drama', 'Thriller', 'Comedy', 'Action', 'Horror', 'Sci-Fi', 'Fantasy', 'Mystery']);
const VALID_STYLES = new Set(['Pixar 3D', 'Cinematic', 'Documentary', 'Animation']);

// Simple in-memory rate limiter per userId+action
const rateLimitMap = new Map();

function checkRateLimit(userId, action, windowSeconds) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (entry && now - entry.ts < windowSeconds * 1000) {
    return false;
  }
  rateLimitMap.set(key, { ts: now });
  return true;
}

// Roll back a rate-limit stamp set earlier in this request. Used when a request
// passes the rate-limit gate but then fails (moderation/validation/credits/etc.)
// so failed attempts don't consume the cooldown — only successful generations do.
function clearRateLimit(userId, action) {
  rateLimitMap.delete(`${userId}:${action}`);
}

function getAdminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

// Single source of truth for the storyboard credit cost. The same value drives
// the actual deduction (/generate) AND the UI display (/config), so changing
// STORYBOARD_CREDIT_COST in the environment updates both together.
function getStoryboardCost() {
  return parseInt(process.env.STORYBOARD_CREDIT_COST || '120', 10);
}

function validateInput(body) {
  const errors = [];
  const { scenario, genres, style, cutCount, referenceImageIds } = body;

  if (typeof scenario !== 'string' || scenario.length < 50 || scenario.length > 2000) {
    errors.push('scenario must be 50-2000 characters');
  }
  if (!Array.isArray(genres) || genres.length < 1 || genres.length > 3 || genres.some(g => !VALID_GENRES.has(g))) {
    errors.push('genres must be 1-3 valid genre strings');
  }
  if (!VALID_STYLES.has(style)) {
    errors.push(`style must be one of: ${[...VALID_STYLES].join(', ')}`);
  }
  if (cutCount !== 4 && cutCount !== 9) {
    errors.push('cutCount must be 4 or 9');
  }
  if (referenceImageIds !== undefined) {
    if (!Array.isArray(referenceImageIds) || referenceImageIds.length > 4) {
      errors.push('referenceImageIds must be an array of at most 4 IDs');
    }
  }

  return { ok: errors.length === 0, errors };
}


function getStepLabel(step) {
  const labels = {
    analyzing_scenario: 'Analyzing your scenario...',
    generating_grid: 'Generating storyboard grid...',
    finalizing: 'Finalizing results...',
    retry_wait: 'Temporary issue detected. Retrying safely...'
  };
  return labels[step] || 'Processing...';
}

function estimateRemaining(sb) {
  if (sb.status === 'pending') {
    const retryDelay = Math.max(0, (new Date(sb.next_attempt_at).getTime() - Date.now()) / 1000);
    return Math.round(retryDelay + 90);
  }
  if (sb.status !== 'processing') return 0;
  const startedAt = sb.updated_at || sb.created_at;
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
  return Math.max(0, Math.round(90 - elapsed));
}

// ============================================================
// CRITICAL: Route registration order must be preserved.
// Static paths BEFORE /:id to prevent /list matching as id="list".
// ============================================================

// GET /config — public UI config (no auth: the plan gate shows the cost to
// logged-out users too). Cost comes from the same helper /generate deducts with.
router.get('/config', (req, res) => {
  res.json({ success: true, storyboardCost: getStoryboardCost() });
});

// POST /generate
router.post('/generate', requireAuth, async (req, res) => {
  const userId = req.user.id;

  // Rate-limit rollback bookkeeping: we stamp the cooldown at the gate (so a
  // rapid double-submit is blocked synchronously), but roll it back unless the
  // generation actually starts — failed/blocked attempts must not cost 60s.
  let rateLimitStamped = false;
  let rateLimitCommitted = false;

  try {
    // 1. Single profile query: plan + credits
    const profile = await creditManager.getProfileWithCredits(userId);
    if (!profile) return res.status(404).json({ code: 'USER_NOT_FOUND' });

    // 2. Plan whitelist
    if (!creditManager.canUseStoryboard(profile)) {
      return res.status(403).json({ code: 'PLAN_NOT_ALLOWED', message: 'Upgrade to Pro or higher to use Storyboard.' });
    }

    // 3. Rate limit: 1 per STORYBOARD_RATE_LIMIT_SECONDS
    const rateLimitSec = parseInt(process.env.STORYBOARD_RATE_LIMIT_SECONDS || '60', 10);
    if (!checkRateLimit(userId, 'storyboard_generate', rateLimitSec)) {
      return res.status(429).json({ code: 'RATE_LIMITED', message: `Wait ${rateLimitSec}s between requests.` });
    }
    rateLimitStamped = true; // we set the cooldown; finally rolls it back unless committed

    // 4. Input validation
    const { scenario, genres, style, cutCount, referenceImageIds = [] } = req.body;
    const validation = validateInput({ scenario, genres, style, cutCount, referenceImageIds });
    if (!validation.ok) {
      return res.status(400).json({ code: 'INVALID_INPUT', errors: validation.errors });
    }

    // 5. Reference image expiry pre-check (10-min buffer)
    if (referenceImageIds.length > 0) {
      const admin = getAdminClient();
      const { data: refs, error: refErr } = await admin
        .from('reference_images')
        .select('id, expires_at')
        .in('id', referenceImageIds)
        .eq('user_id', userId);

      if (refErr || !refs || refs.length !== referenceImageIds.length) {
        return res.status(400).json({ code: 'INVALID_INPUT', message: 'One or more reference image IDs are invalid.' });
      }

      const bufferMs = parseInt(process.env.STORYBOARD_REF_EXPIRY_BUFFER_MINUTES || '10', 10) * 60 * 1000;
      const cutoff = new Date(Date.now() + bufferMs);
      const expiringSoon = refs.find(r => new Date(r.expires_at) < cutoff);
      if (expiringSoon) {
        return res.status(400).json({ code: 'REFERENCE_EXPIRED_SOON', message: 'One or more reference images expire too soon. Please re-upload.' });
      }
    }


    // 6. Moderation on scenario text (pre-deduction — no charge on rejection)
    const modResult = await moderateContent({ text: scenario });
    if (modResult.flagged) {
      if (modResult.reason === 'moderation_error') {
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: `Moderation service error — please try again.` });
      }
      return res.status(422).json({ code: 'MODERATION_REJECTED', message: 'Content flagged by safety system.' });
    }

    // 7. Atomically insert the durable job and deduct credits. The RPC also
    // serializes per-user submissions and enforces the active-job limit.
    const cost = getStoryboardCost();
    const storyboardId = `sb_${randomUUID().replace(/-/g, '')}`;
    const maxConcurrent = parseInt(process.env.STORYBOARD_MAX_CONCURRENT_JOBS || '5', 10);
    const maxAttempts = parseInt(process.env.STORYBOARD_MAX_ATTEMPTS || '3', 10);

    let enqueueResult;
    try {
      enqueueResult = await jobStore.enqueueJob({
        id: storyboardId,
        userId,
        scenario,
        genres,
        style,
        cutCount,
        referenceImageIds,
        creditCost: cost,
        maxConcurrent,
        maxAttempts
      });
    } catch (queueErr) {
      if (queueErr.code === 'INSUFFICIENT_CREDITS') {
        return res.status(402).json({ code: 'INSUFFICIENT_CREDITS' });
      }
      if (queueErr.code === 'PLAN_NOT_ALLOWED') {
        return res.status(403).json({ code: 'PLAN_NOT_ALLOWED' });
      }
      if (queueErr.code === 'TOO_MANY_CONCURRENT_JOBS') {
        return res.status(429).json({ code: 'TOO_MANY_CONCURRENT_JOBS' });
      }
      if (queueErr.code === 'USER_NOT_FOUND') {
        return res.status(404).json({ code: 'USER_NOT_FOUND' });
      }
      console.error('[storyboard] durable enqueue error:', queueErr.message);
      return res.status(503).json({
        code: 'QUEUE_UNAVAILABLE',
        message: 'Queue confirmation is unavailable. Check Storyboard history before retrying.'
      });
    }

    // Wake this instance for low latency; any healthy instance may claim the row.
    storyboardWorker.wake();

    // Generation committed — keep the cooldown stamp (throttles only on success).
    rateLimitCommitted = true;

    return res.status(200).json({
      success: true,
      storyboard: {
        id: storyboardId,
        status: 'pending',
        estimatedSeconds: 90,
        creditsUsed: cost,
        remainingCredits: enqueueResult.newBalance
      }
    });
  } catch (err) {
    console.error('[storyboard /generate] error:', err.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR' });
  } finally {
    // Roll back the cooldown if we stamped it but generation never started
    // (moderation/validation/credit/concurrency failures, or any exception).
    if (rateLimitStamped && !rateLimitCommitted) {
      clearRateLimit(userId, 'storyboard_generate');
    }
  }
});

// POST /upload-reference
router.post('/upload-reference', requireAuth, upload.single('image'), async (req, res) => {
  const userId = req.user.id;

  try {
    // Plan whitelist
    const profile = await creditManager.getProfileWithCredits(userId);
    if (!creditManager.canUseStoryboard(profile)) {
      return res.status(403).json({ code: 'PLAN_NOT_ALLOWED' });
    }

    // Rate limit: 5 per minute
    if (!checkRateLimit(userId, 'upload_reference', 12)) {
      return res.status(429).json({ code: 'RATE_LIMITED' });
    }

    if (!req.file) {
      return res.status(400).json({ code: 'INVALID_INPUT', message: 'No file uploaded.' });
    }

    // MIME validation
    const detectedMime = req.file.mimetype;
    if (!ALLOWED_MIME_TYPES.has(detectedMime)) {
      return res.status(400).json({ code: 'INVALID_MIME', message: 'Only JPEG, PNG, and WebP are allowed.' });
    }

    // Sharp resize to 1024×1024 PNG
    let resizedBuffer;
    try {
      resizedBuffer = await sharp(req.file.buffer)
        .resize(1024, 1024, { fit: 'cover' })
        .png()
        .toBuffer();
    } catch (sharpErr) {
      return res.status(400).json({ code: 'INVALID_IMAGE', message: 'Could not process image.' });
    }

    // Moderation: convert buffer to data URL for moderation
    const b64Preview = resizedBuffer.toString('base64');
    const dataUrl = `data:image/png;base64,${b64Preview}`;
    const modResult = await moderateContent({ text: '', imageUrl: dataUrl });
    if (modResult.flagged) {
      return res.status(422).json({ code: 'MODERATION_REJECTED', message: 'Image flagged by safety system.' });
    }

    // Upload via service_role (never client-side)
    const refId = `ref_${randomUUID().replace(/-/g, '')}`;
    const storagePath = `${userId}/${refId}.png`;
    const admin = getAdminClient();

    const { error: uploadErr } = await admin.storage
      .from('reference-images')
      .upload(storagePath, resizedBuffer, { contentType: 'image/png', upsert: false });

    if (uploadErr) {
      console.error('[storyboard] ref upload error:', uploadErr.message);
      return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to upload reference image. Please try again.' });
    }

    // Insert reference_images row with 24h expiry
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { error: insertErr } = await admin.from('reference_images').insert({
      id: refId,
      user_id: userId,
      storage_path: storagePath,
      mime_type: 'image/png',
      file_size: resizedBuffer.length,
      expires_at: expiresAt
    });

    if (insertErr) {
      console.error('[storyboard] ref insert error:', insertErr.message);
      await admin.storage.from('reference-images').remove([storagePath]);
      return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to save reference image. Please try again.' });
    }

    // Return signed preview URL (1h)
    const { data: signedData } = await admin.storage
      .from('reference-images')
      .createSignedUrl(storagePath, 3600);

    return res.status(200).json({
      success: true,
      referenceImage: {
        id: refId,
        previewUrl: signedData?.signedUrl,
        expiresAt
      }
    });
  } catch (err) {
    console.error('[storyboard /upload-reference] error:', err.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR' });
  }
});

// GET /list — MUST be before /:id
router.get('/list', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(20, parseInt(req.query.limit || '10', 10));
  const offset = (page - 1) * limit;

  try {
    const admin = getAdminClient();
    const { data, count, error } = await admin
      .from('storyboards')
      .select('id, status, style, cut_count, genres, created_at, expires_at, grid_storage_path', { count: 'exact' })
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ code: 'INTERNAL_ERROR' });
    }

    // Generate signed thumbnail URLs for completed items
    const items = await Promise.all((data || []).map(async (sb) => {
      let thumbnailUrl = null;
      if (sb.status === 'completed' && sb.grid_storage_path) {
        const { data: signed } = await admin.storage
          .from('storyboards')
          .createSignedUrl(sb.grid_storage_path, 3600);
        thumbnailUrl = signed?.signedUrl || null;
      }
      return { ...sb, thumbnailUrl };
    }));

    return res.json({ success: true, items, total: count, page, limit });
  } catch (err) {
    console.error('[storyboard /list] error:', err.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR' });
  }
});

// GET /:id/status — MUST be before /:id
router.get('/:id/status', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const storyboardId = req.params.id;

  try {
    const admin = getAdminClient();
    const { data: sb, error } = await admin
      .from('storyboards')
      .select('id, status, progress, current_step, created_at, updated_at, error_message, attempt_count, max_attempts, next_attempt_at')
      .eq('id', storyboardId)
      .eq('user_id', userId)
      .single();

    if (error || !sb) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    return res.json({
      id: sb.id,
      status: sb.status,
      progress: sb.progress || 0,
      currentStep: sb.current_step,
      stepLabel: getStepLabel(sb.current_step),
      estimatedSecondsRemaining: estimateRemaining(sb),
      errorMessage: sb.status === 'failed' ? sb.error_message : null,
      attempt: sb.attempt_count || 0,
      maxAttempts: sb.max_attempts || 0,
      retryAt: sb.status === 'pending' ? sb.next_attempt_at : null
    });
  } catch (err) {
    console.error('[storyboard /:id/status] error:', err.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR' });
  }
});

// GET /:id — full result
router.get('/:id', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const storyboardId = req.params.id;

  try {
    const admin = getAdminClient();
    const { data: sb, error } = await admin
      .from('storyboards')
      .select('*')
      .eq('id', storyboardId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .single();

    if (error || !sb) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    let gridUrl = null;
    if (sb.status === 'completed' && sb.grid_storage_path) {
      const { data: signed } = await admin.storage
        .from('storyboards')
        .createSignedUrl(sb.grid_storage_path, 3600);
      gridUrl = signed?.signedUrl || null;
    }

    return res.json({
      success: true,
      storyboard: {
        id: sb.id,
        status: sb.status,
        scenario: sb.scenario,
        genres: sb.genres,
        style: sb.style,
        cutCount: sb.cut_count,
        shots: sb.shots,
        characters: sb.characters,
        gridUrl,
        creditsUsed: sb.credits_used,
        createdAt: sb.created_at,
        expiresAt: sb.expires_at,
        errorMessage: sb.error_message
      }
    });
  } catch (err) {
    console.error('[storyboard /:id] error:', err.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR' });
  }
});

// DELETE /:id — soft-delete + immediate Storage removal
router.delete('/:id', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const storyboardId = req.params.id;

  try {
    const admin = getAdminClient();
    const { data: sb, error } = await admin
      .from('storyboards')
      .select('id, user_id, grid_storage_path')
      .eq('id', storyboardId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .single();

    if (error || !sb) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    // Soft-delete — must not silently fail (user would see success:true while
    // the storyboard is still listed).
    const { error: deleteErr } = await admin
      .from('storyboards')
      .update({ deleted_at: new Date().toISOString(), status: 'deleted' })
      .eq('id', storyboardId);
    if (deleteErr) {
      console.error('[storyboard DELETE /:id] soft-delete failed:', deleteErr.message, '| id:', storyboardId);
      return res.status(500).json({ code: 'INTERNAL_ERROR' });
    }

    // Immediate Storage file removal (best-effort)
    if (sb.grid_storage_path) {
      await admin.storage.from('storyboards').remove([sb.grid_storage_path]);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[storyboard DELETE /:id] error:', err.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
