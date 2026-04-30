const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { analyzeImage } = require('../services/geminiService');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

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

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'));
    }
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

router.post('/analyze', authMiddleware, upload.single('image'), async (req, res, next) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file provided' });
    }

    const today = new Date().toISOString().split('T')[0];

    // Fetch user profile
    const { data: profile, error: profileError } = await req.supabase
      .from('profiles')
      .select('plan, credits, daily_used, last_reset_date')
      .eq('id', req.user.id)
      .single();

    if (profileError || !profile) {
      return res.status(500).json({ success: false, error: 'Failed to fetch user profile' });
    }

    // Reset daily usage if new day
    let dailyUsed = profile.daily_used;
    if (profile.last_reset_date !== today) {
      await req.supabase
        .from('profiles')
        .update({ daily_used: 0, last_reset_date: today })
        .eq('id', req.user.id);
      dailyUsed = 0;
    }

    // Check limits
    const isPaidPlan = ['pro', 'enterprise', 'paid'].includes(profile.plan);

    if (!isPaidPlan && dailyUsed >= 1) {
      return res.status(403).json({
        success: false,
        error: '무료 플랜의 일일 생성 한도에 도달했습니다.',
        code: 'DAILY_LIMIT'
      });
    }

    if (isPaidPlan && (profile.credits || 0) < 10) {
      return res.status(403).json({
        success: false,
        error: 'Not enough credits',
        code: 'NO_CREDITS'
      });
    }

    // 파일 매직바이트 검증 (MIME 스푸핑 방지)
    const imageBuffer = fs.readFileSync(filePath);
    const mimeType = req.file.mimetype;
    if (!verifyMagicBytes(imageBuffer, mimeType)) {
      return res.status(400).json({ success: false, error: 'Invalid image file content' });
    }

    const base64Image = imageBuffer.toString('base64');

    const result = await analyzeImage(base64Image, mimeType);

    // 원자적 크레딧 차감 (레이스 컨디션 방지)
    if (isPaidPlan) {
      const { data: remaining, error: rpcError } = await req.supabase
        .rpc('deduct_credits', { p_user_id: req.user.id, p_amount: 10 });
      if (rpcError) {
        console.error('[analyze] deduct_credits RPC error:', rpcError.message);
        return res.status(500).json({ success: false, error: 'Failed to deduct credits' });
      }
      if (remaining === -1) {
        return res.status(403).json({ success: false, error: 'Not enough credits', code: 'NO_CREDITS' });
      }
    } else {
      await req.supabase
        .from('profiles')
        .update({ daily_used: dailyUsed + 1 })
        .eq('id', req.user.id);
    }

    // Log usage
    await req.supabase
      .from('usage_logs')
      .insert({ user_id: req.user.id });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  } finally {
    if (filePath) {
      fs.unlink(filePath, (err) => {
        if (err) console.error('[analyze] Failed to delete temp file:', filePath, err.message);
      });
    }
  }
});

module.exports = router;
