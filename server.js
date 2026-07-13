require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');
const logger = require('./lib/logger');

const app = express();
const PORT = process.env.PORT || 3000;

/* ── Trust Proxy (Railway/reverse proxy 환경) ── */
app.set('trust proxy', 1);

/* ── Rate Limiters ── */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1분
  max: 60,                   // 분당 60 요청
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,                   // 분석은 분당 10회 제한
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many analysis requests, please slow down.' }
});

const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { accepted: false, code: 'ANALYTICS_RATE_LIMITED' }
});

/* ── Correlation ID + structured API access log ── */
app.use((req, res, next) => {
  const requestId = logger.createRequestId(req.headers['x-request-id']);
  const startedAt = process.hrtime.bigint();

  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);

  res.on('finish', () => {
    if (req.path === '/api/health') return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info('http.request.completed', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs)
    });
  });

  next();
});

/* ── Paddle webhook router — MUST be mounted before express.json() ── */
/* express.raw() is applied at route level inside paddle.js.            */
/* If express.json() runs first, req.body becomes a parsed object       */
/* (not a Buffer), breaking HMAC signature verification.                */
const paddleRouter = require('./routes/paddle');
app.use('/api/paddle', paddleRouter);

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

/* ── Security Headers ── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net https://cdn.paddle.com https://*.paddle.com https://static.cloudflareinsights.com; " +
    "style-src 'self' 'unsafe-inline' https://cdn.paddle.com https://*.paddle.com https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com https://cdn.paddle.com https://*.paddle.com; " +
    "img-src 'self' data: blob: https://*.paddle.com https://cdn.paddle.com https://*.supabase.co https://*.googleusercontent.com; " +
    "media-src 'self' blob:; " +
    "connect-src 'self' https://*.supabase.co https://*.paddle.com https://cdn.paddle.com; " +
    "frame-src https://*.paddle.com; " +
    "frame-ancestors 'none';"
  );
  next();
});

app.use(express.static('public'));

const analyzeRouter = require('./routes/analyze');
const paymentRouter = require('./routes/payment');
const storyboardRouter = require('./routes/storyboard');
const analyticsRouter = require('./routes/analytics');
app.use('/api/analyze', analyzeLimiter);   // 분석 엔드포인트에 엄격한 제한
app.use('/api/analytics', analyticsLimiter, analyticsRouter);
app.use('/api', apiLimiter);               // 나머지 API 전체에 일반 제한
app.use('/api', analyzeRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/storyboard', storyboardRouter);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || null,
    timestamp: new Date().toISOString()
  });
});

/* ── Helper: get user-scoped Supabase client ── */
function makeUserClient(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false }
  });
}

// All profile mutations must flow through the server's service-role client.
// Browser JWT clients are intentionally read-only for profile data.
function makeAdminClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  return createClient(process.env.SUPABASE_URL, serviceKey, {
    auth: { persistSession: false }
  });
}

async function verifyToken(token) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('[verifyToken] SUPABASE_URL or SUPABASE_ANON_KEY is missing from environment');
  }
  const base = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false }
  });
  const { data: { user }, error } = await base.auth.getUser(token);
  if (error) {
    console.error('[verifyToken] getUser error:', error.message, '| status:', error.status);
  }
  return { user, error };
}

/* ── GET /api/user/profile ── */
app.get('/api/user/profile', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  const { user, error: userError } = await verifyToken(token);
  if (userError || !user) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  const supabase = makeUserClient(token);
  const today = new Date().toISOString().split('T')[0];

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('plan, credits, daily_used, last_reset_date')
    .eq('id', user.id)
    .single();

  if (profileError) {
    console.error('[GET /api/user/profile] profiles query error:', profileError.message, '| code:', profileError.code, '| details:', profileError.details, '| hint:', profileError.hint, '| user_id:', user.id);

    // PGRST116: 행이 없음 → 프로필 자동 생성 후 반환
    if (profileError.code === 'PGRST116') {
      const adminClient = makeAdminClient();
      if (!adminClient) {
        console.error('[GET /api/user/profile] SUPABASE_SERVICE_ROLE_KEY is not configured');
        return res.status(500).json({ success: false, error: 'Server configuration error' });
      }
      const { data: newProfile, error: insertError } = await adminClient
        .from('profiles')
        .insert({ id: user.id, plan: 'free', credits: 0, daily_used: 0, last_reset_date: new Date().toISOString().split('T')[0] })
        .select('plan, credits, daily_used, last_reset_date')
        .single();

      if (insertError) {
        console.error('[GET /api/user/profile] profile insert error:', insertError.message, '| code:', insertError.code);
        return res.status(500).json({ success: false, error: 'Failed to create profile' });
      }

      return res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          full_name: user.user_metadata?.full_name || user.email,
          avatar_url: user.user_metadata?.avatar_url || null
        },
        plan: newProfile.plan,
        credits: newProfile.credits,
        daily_used: newProfile.daily_used
      });
    }

    return res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }

  // Auto-reset daily usage on new day
  let dailyUsed = profile.daily_used;
  if (profile.last_reset_date !== today) {
    const adminClient = makeAdminClient();
    if (!adminClient) {
      console.error('[GET /api/user/profile] SUPABASE_SERVICE_ROLE_KEY is not configured');
      return res.status(500).json({ success: false, error: 'Server configuration error' });
    }
    const { error: resetError } = await adminClient.from('profiles')
      .update({ daily_used: 0, last_reset_date: today })
      .eq('id', user.id);
    if (resetError) {
      console.error('[GET /api/user/profile] daily reset update failed:', resetError.message, '| user:', user.id);
      return res.status(500).json({ success: false, error: 'Failed to reset daily usage' });
    }
    dailyUsed = 0;
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.user_metadata?.full_name || user.email,
      avatar_url: user.user_metadata?.avatar_url || null
    },
    plan: profile.plan,
    credits: profile.credits,
    daily_used: dailyUsed
  });
});


/* ── GET /api/user/history ── */
app.get('/api/user/history', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  const { user, error: userError } = await verifyToken(token);
  if (userError || !user) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  const supabase = makeUserClient(token);
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  const { data, error } = await supabase
    .from('prompts')
    .select('id, prompt, analysis, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[GET /api/user/history] error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }

  res.json({ success: true, history: data || [] });
});

/* ── DELETE /api/user/history/:id ── */
app.delete('/api/user/history/:id', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  const { user, error: userError } = await verifyToken(token);
  if (userError || !user) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) {
    return res.status(400).json({ success: false, error: 'Invalid id' });
  }

  const supabase = makeUserClient(token);
  const { error } = await supabase
    .from('prompts')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id); // RLS + 명시적 user_id 체크

  if (error) {
    console.error('[DELETE /api/user/history] error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to delete history item' });
  }

  res.json({ success: true });
});

app.get('/frame', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'frame.html'));
});

app.get('/storyboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'storyboard.html'));
});

app.get('/storyboard/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'storyboard-history.html'));
});

app.get('/storyboard/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'storyboard-result.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  logger.error('http.request.failed', {
    requestId: req.id,
    method: req.method,
    path: req.path,
    statusCode: err.status || 500,
    error: err
  });
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
    requestId: req.id
  });
});

const storyboardWorker = require('./lib/storyboard-worker');
const cleanupScheduler = require('./lib/cleanup-scheduler');

const server = app.listen(PORT, () => {
  logger.info('server.started', {
    port: Number(PORT),
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || null
  });
  storyboardWorker.start();
  cleanupScheduler.start();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown.started', { signal });
  cleanupScheduler.stop();

  const forceExit = setTimeout(() => {
    logger.critical('server.shutdown.timeout', { signal });
    process.exit(1);
  }, 30000);
  forceExit.unref?.();

  const httpClosed = new Promise(resolve => server.close(resolve));
  await Promise.allSettled([
    httpClosed,
    storyboardWorker.stop(25000)
  ]);

  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
