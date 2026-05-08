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
const { processStoryboardAsync, fetchStoryboard, markFailed } = require('../lib/storyboard-processor');
const semaphore = require('../lib/semaphore');

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

function getAdminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
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

async function countActiveJobs(userId) {
  const admin = getAdminClient();
  const { count } = await admin
    .from('storyboards')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'processing');
  return count || 0;
}

function getStepLabel(step) {
  const labels = {
    analyzing_scenario: 'Analyzing your scenario...',
    generating_grid: 'Generating storyboard grid...',
    finalizing: 'Finalizing results...'
  };
  return labels[step] || 'Processing...';
}

function estimateRemaining(sb) {
  if (sb.status !== 'processing') return 0;
  const elapsed = (Date.now() - new Date(sb.created_at).getTime()) / 1000;
  return Math.max(0, Math.round(90 - elapsed));
}

// ============================================================
// CRITICAL: Route registration order must be preserved.
// Static paths BEFORE /:id to prevent /list matching as id="list".
// ============================================================

// POST /generate
router.post('/generate', requireAuth, async (req, res) => {
  const userId = req.user.id;

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

    // 6. Concurrent job limit
    const activeCount = await countActiveJobs(userId);
    const maxConcurrent = parseInt(process.env.STORYBOARD_MAX_CONCURRENT_JOBS || '5', 10);
    if (activeCount >= maxConcurrent) {
      return res.status(429).json({ code: 'TOO_MANY_CONCURRENT_JOBS' });
    }

    // 7. Moderation on scenario text (pre-deduction — no charge on rejection)
    const modResult = await moderateContent({ text: scenario });
    if (modResult.flagged) {
      return res.status(422).json({ code: 'MODERATION_REJECTED', message: 'Content flagged by safety system.' });
    }

    // 8. Credit balance check
    const cost = parseInt(process.env.STORYBOARD_CREDIT_COST || '250', 10);
    if (profile.credits < cost) {
      return res.status(402).json({ code: 'INSUFFICIENT_CREDITS', required: cost, available: profile.credits });
    }

    // 9. Insert storyboard row (status=pending)
    const storyboardId = `sb_${randomUUID().replace(/-/g, '')}`;
    const admin = getAdminClient();
    const { error: insertErr } = await admin.from('storyboards').insert({
      id: storyboardId,
      user_id: userId,
      scenario,
      genres,
      style,
      cut_count: cutCount,
      reference_image_ids: referenceImageIds,
      status: 'pending',
      credits_used: cost
    });

    if (insertErr) {
      console.error('[storyboard] insert error:', insertErr.message);
      return res.status(500).json({ code: 'INTERNAL_ERROR' });
    }

    // 10. Atomic credit deduction
    try {
      await creditManager.deductStoryboardCredits(userId, cost, storyboardId);
    } catch (deductErr) {
      await admin.from('storyboards').delete().eq('id', storyboardId);
      if (deductErr.code === 'INSUFFICIENT_CREDITS') {
        return res.status(402).json({ code: 'INSUFFICIENT_CREDITS' });
      }
      throw deductErr;
    }

    // 11. Fire async (do not await) — semaphore gates concurrency
    semaphore.run(() => processStoryboardAsync(storyboardId)).catch(err => {
      console.error('[storyboard] async job error:', err.message);
    });

    return res.status(200).json({
      success: true,
      storyboard: {
        id: storyboardId,
        status: 'processing',
        estimatedSeconds: 90,
        creditsUsed: cost,
        remainingCredits: profile.credits - cost
      }
    });
  } catch (err) {
    console.error('[storyboard /generate] error:', err.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR' });
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
      return res.status(500).json({ code: 'INTERNAL_ERROR' });
    }

    // Insert reference_images row with 24h expiry
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await admin.from('reference_images').insert({
      id: refId,
      user_id: userId,
      storage_path: storagePath,
      mime_type: 'image/png',
      file_size: resizedBuffer.length,
      expires_at: expiresAt
    });

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
      .select('id, user_id, status, progress, current_step, created_at, credits_used')
      .eq('id', storyboardId)
      .eq('user_id', userId)
      .single();

    if (error || !sb) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    // Lazy watchdog: detect stuck jobs
    const timeoutMin = parseInt(process.env.STORYBOARD_STUCK_JOB_TIMEOUT_MINUTES || '5', 10);
    if (sb.status === 'processing' &&
        new Date(sb.created_at) < new Date(Date.now() - timeoutMin * 60 * 1000)) {
      // Atomic mark-failed: only refund if we actually changed a row
      const changed = await markFailed(storyboardId, 'Job timed out (stuck)');
      if (changed) {
        try {
          const creditMgr = require('../lib/credit-manager');
          await creditMgr.refundStoryboardCredits(
            sb.user_id,
            sb.credits_used,
            storyboardId,
            'stuck_job_timeout'
          );
        } catch (refErr) {
          console.error('[storyboard watchdog] refund error:', refErr.message);
        }
      }

      // Re-fetch after update
      const { data: updated } = await admin
        .from('storyboards')
        .select('id, user_id, status, progress, current_step, created_at, credits_used')
        .eq('id', storyboardId)
        .single();

      const latest = updated || { ...sb, status: 'failed' };
      return res.json({
        id: latest.id,
        status: latest.status,
        progress: latest.progress || 0,
        currentStep: latest.current_step,
        stepLabel: getStepLabel(latest.current_step),
        estimatedSecondsRemaining: 0
      });
    }

    return res.json({
      id: sb.id,
      status: sb.status,
      progress: sb.progress || 0,
      currentStep: sb.current_step,
      stepLabel: getStepLabel(sb.current_step),
      estimatedSecondsRemaining: estimateRemaining(sb)
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

    // Soft-delete
    await admin
      .from('storyboards')
      .update({ deleted_at: new Date().toISOString(), status: 'deleted' })
      .eq('id', storyboardId);

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
