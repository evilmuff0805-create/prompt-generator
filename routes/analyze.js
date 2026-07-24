const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { analyzeImage } = require('../services/geminiService');
const { recordServerEvent } = require('../lib/product-analytics');
const authMiddleware = require('../middleware/auth');
const { ANALYSIS_CREDIT_COST } = require('../lib/product-catalog');
const {
  reserveAnalysisOperation,
  completeAnalysisOperation,
  refundAnalysisOperation,
  sweepStaleAnalysisOperations
} = require('../lib/analysis-credit-operations');

const router = express.Router();

function makeAdminClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  return createClient(process.env.SUPABASE_URL, serviceKey, {
    auth: { persistSession: false }
  });
}

const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, uniqueName);
  }
});

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// 파일 매직바이트 시그니처 (MIME 스푸핑 방지)
const MAGIC_SIGNATURES = {
  'image/jpeg': { offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
  'image/png':  { offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47] },
  'image/gif':  { offset: 0, bytes: [0x47, 0x49, 0x46] },
  'image/webp': { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // RIFF????WEBP
};

function verifyMagicBytes(buffer, mimeType) {
  const sig = MAGIC_SIGNATURES[mimeType];
  if (!sig) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buffer[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return true;
}

function createAnalysisUpload(options = {}) {
  const storageEngine = options.storage || storage;
  const maxFileSize = options.maxFileSize || 20 * 1024 * 1024;

  return multer({
    storage: storageEngine,
    fileFilter: (req, file, cb) => {
      if (ALLOWED_MIMES.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'));
      }
    },
    limits: { fileSize: maxFileSize }
  });
}

const upload = createAnalysisUpload();

router.post('/analyze', authMiddleware, upload.single('image'), async (req, res, next) => {
  const filePath = req.file?.path;
  let operationId = null;
  let operationReserved = false;
  let adminClient = null;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file provided' });
    }

    const requestedOperationId = req.get('X-Analysis-Operation-Id');
    if (requestedOperationId && !UUID_PATTERN.test(requestedOperationId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid analysis operation ID',
        code: 'INVALID_OPERATION_ID'
      });
    }
    operationId = requestedOperationId || randomUUID();

    const today = new Date().toISOString().split('T')[0];

    adminClient = makeAdminClient();
    if (!adminClient) {
      console.error('[analyze] SUPABASE_SERVICE_ROLE_KEY is not configured');
      return res.status(500).json({ success: false, error: 'Server configuration error' });
    }

    // Reject spoofed content before reserving a credit or a free daily slot.
    const imageBuffer = fs.readFileSync(filePath);
    const mimeType = req.file.mimetype;
    if (!verifyMagicBytes(imageBuffer, mimeType)) {
      return res.status(400).json({ success: false, error: 'Invalid image file content' });
    }

    // Fetch user profile
    let { data: profile, error: profileError } = await adminClient
      .from('profiles')
      .select('plan, credits, daily_used, last_reset_date')
      .eq('id', req.user.id)
      .single();

    // 프로필이 없으면 자동 생성 (PGRST116: no rows)
    if (profileError?.code === 'PGRST116') {
      const { data: newProfile, error: insertError } = await adminClient
        .from('profiles')
        .insert({ id: req.user.id, plan: 'free', credits: 0, daily_used: 0, last_reset_date: today })
        .select('plan, credits, daily_used, last_reset_date')
        .single();
      if (insertError) {
        console.error('[analyze] profile insert error:', insertError.message);
        return res.status(500).json({ success: false, error: 'Failed to create user profile' });
      }
      profile = newProfile;
      profileError = null;
    }

    if (profileError || !profile) {
      console.error('[analyze] profile fetch error:', profileError?.message, '| code:', profileError?.code);
      return res.status(500).json({ success: false, error: 'Failed to fetch user profile' });
    }

    // Opportunistically recover reservations orphaned by a previous process
    // crash. Failure is logged but does not block the current request.
    try {
      await sweepStaleAnalysisOperations(adminClient);
    } catch (sweepError) {
      console.error('[analyze] stale reservation sweep failed:', sweepError.message);
    }

    let reservation;
    try {
      reservation = await reserveAnalysisOperation(adminClient, {
        operationId,
        userId: req.user.id,
        creditCost: ANALYSIS_CREDIT_COST
      });
    } catch (reserveError) {
      if (reserveError.code === 'DAILY_LIMIT') {
        return res.status(403).json({
          success: false,
          error: '무료 플랜의 일일 생성 한도에 도달했습니다.',
          code: 'DAILY_LIMIT'
        });
      }
      if (reserveError.code === 'INSUFFICIENT_CREDITS') {
        return res.status(403).json({
          success: false,
          error: 'Not enough credits',
          code: 'NO_CREDITS'
        });
      }
      throw reserveError;
    }

    if (reservation?.status === 'completed' && reservation.result) {
      return res.json({
        success: true,
        ...reservation.result,
        analysisOperationId: operationId,
        cached: true
      });
    }

    if (reservation?.status === 'reserved' && reservation.isNew === false) {
      return res.status(409).json({
        success: false,
        error: 'This analysis is already in progress',
        code: 'ANALYSIS_IN_PROGRESS',
        analysisOperationId: operationId
      });
    }

    operationReserved = true;
    const base64Image = imageBuffer.toString('base64');
    const result = await analyzeImage(base64Image, mimeType);

    await completeAnalysisOperation(adminClient, {
      operationId,
      userId: req.user.id,
      result
    });
    operationReserved = false;

    // Idempotent history writes: a transport retry of a completed operation
    // cannot create duplicate prompt or usage rows.
    const { error: usageLogError } = await adminClient
      .from('usage_logs')
      .upsert(
        { user_id: req.user.id, analysis_operation_id: operationId },
        { onConflict: 'analysis_operation_id', ignoreDuplicates: true }
      );
    if (usageLogError) {
      console.error('[analyze] usage_logs insert failed:', usageLogError.message, '| user:', req.user.id);
    }

    const { error: promptError } = await adminClient
      .from('prompts')
      .upsert(
        {
          user_id: req.user.id,
          prompt: result.prompt || '',
          analysis: result.analysis || {},
          analysis_operation_id: operationId
        },
        { onConflict: 'analysis_operation_id', ignoreDuplicates: true }
      );
    if (promptError) {
      console.error('[analyze] prompts history insert failed:', promptError.message, '| user:', req.user.id);
    }

    await recordServerEvent({
      eventName: 'analysis_succeeded',
      userId: req.user.id,
      properties: {
        plan: profile.plan || 'free',
        creditsCharged: Number(reservation?.chargedAmount) || 0,
        creditPolicyVersion: 2
      }
    });

    res.json({
      success: true,
      ...result,
      analysisOperationId: operationId,
      cached: false
    });
  } catch (err) {
    if (operationReserved && adminClient && operationId) {
      try {
        const refund = await refundAnalysisOperation(adminClient, {
          operationId,
          userId: req.user.id,
          reason: err?.code || err?.name || 'analysis_failed'
        });
        console.warn('[analyze] reserved operation refunded:', operationId, '| applied:', refund?.refunded === true);
      } catch (refundError) {
        console.error('[analyze] CRITICAL refund failed:', operationId, refundError.message);
      }
    }
    next(err);
  } finally {
    if (filePath) {
      fs.unlink(filePath, (err) => {
        if (err) console.error('[analyze] Failed to delete temp file:', filePath, err.message);
      });
    }
  }
});

router._uploadSecurity = {
  createAnalysisUpload,
  verifyMagicBytes,
  allowedMimes: new Set(ALLOWED_MIMES)
};

module.exports = router;
