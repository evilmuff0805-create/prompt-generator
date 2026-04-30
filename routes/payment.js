require('dotenv').config();
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const LS_API_BASE = 'https://api.lemonsqueezy.com/v1';

function lsHeaders() {
  return {
    'Accept': 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`
  };
}

function makeAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return createClient(process.env.SUPABASE_URL, key, {
    auth: { persistSession: false }
  });
}

function makeUserClient(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false }
  });
}

async function verifyToken(token) {
  const base = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false }
  });
  const { data: { user }, error } = await base.auth.getUser(token);
  return { user, error };
}

function variantToPlan(variantId) {
  const id = String(variantId);
  if (id === String(process.env.LEMONSQUEEZY_PRO_VARIANT_ID)) return 'pro';
  if (id === String(process.env.LEMONSQUEEZY_ENTERPRISE_VARIANT_ID)) return 'enterprise';
  return null;
}

/* ── POST /api/payment/checkout ── */
router.post('/checkout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  const { user, error: userError } = await verifyToken(token);
  if (userError || !user) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  const { plan } = req.body;
  let variantId;
  if (plan === 'pro') {
    variantId = process.env.LEMONSQUEEZY_PRO_VARIANT_ID;
  } else if (plan === 'enterprise') {
    variantId = process.env.LEMONSQUEEZY_ENTERPRISE_VARIANT_ID;
  } else {
    return res.status(400).json({ success: false, error: 'Invalid plan. Must be "pro" or "enterprise"' });
  }

  const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const body = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email: user.email,
            custom: { user_id: user.id }
          },
          product_options: {
            redirect_url: `${baseUrl}/?payment=success&plan=${plan}`
          }
        },
        relationships: {
          store: {
            data: { type: 'stores', id: String(process.env.LEMONSQUEEZY_STORE_ID) }
          },
          variant: {
            data: { type: 'variants', id: String(variantId) }
          }
        }
      }
    };

    const lsRes = await fetch(`${LS_API_BASE}/checkouts`, {
      method: 'POST',
      headers: lsHeaders(),
      body: JSON.stringify(body)
    });

    if (!lsRes.ok) {
      const errText = await lsRes.text();
      console.error('[checkout] Lemon Squeezy error:', lsRes.status, errText);
      return res.status(502).json({ success: false, error: 'Failed to create checkout session' });
    }

    const data = await lsRes.json();
    const checkoutUrl = data?.data?.attributes?.url;
    if (!checkoutUrl || !checkoutUrl.startsWith('https://')) {
      console.error('[checkout] Invalid or missing checkout URL:', checkoutUrl);
      return res.status(502).json({ success: false, error: 'No checkout URL in response' });
    }

    res.json({ success: true, checkout_url: checkoutUrl });
  } catch (err) {
    console.error('[checkout] Error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ── POST /api/payment/webhook ── */
router.post('/webhook', async (req, res) => {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const signature = req.headers['x-signature'];

  if (!secret) {
    console.error('[webhook] LEMONSQUEEZY_WEBHOOK_SECRET is not configured — rejecting all webhooks');
    return res.status(500).send('Webhook secret not configured');
  }
  if (!signature) {
    console.warn('[webhook] Missing x-signature header — possible spoofed request');
    return res.status(401).send('Missing signature');
  }
  const rawBody = req.rawBody;
  if (!rawBody) {
    console.warn('[webhook] rawBody not available — ensure express.json verify is set up');
    return res.status(400).send('Raw body not available');
  }
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
    console.warn('[webhook] Signature mismatch — possible spoofed request');
    return res.status(401).send('Invalid signature');
  }

  const payload = req.body;
  const eventName = payload?.meta?.event_name;
  const eventId = payload?.meta?.event_id || payload?.data?.id;
  console.log('[webhook] Event received:', eventName, '| id:', eventId);

  // 리플레이 공격 방지: 동일 event_id 중복 처리 차단
  if (eventId) {
    try {
      const adminClient = makeAdminClient();
      const { error: dupError } = await adminClient
        .from('webhook_events')
        .insert({ event_id: String(eventId) });
      if (dupError) {
        if (dupError.code === '23505') {
          console.log('[webhook] Duplicate event_id, skipping:', eventId);
          return res.status(200).send('OK');
        }
        console.error('[webhook] Failed to record event_id:', dupError.message);
      }
    } catch (err) {
      console.error('[webhook] Replay check failed:', err.message);
    }
  }

  const ACTIVE_EVENTS = [
    'subscription_created',
    'subscription_updated',
    'subscription_resumed',
    'subscription_unpaused'
  ];
  const CANCEL_EVENTS = ['subscription_cancelled', 'subscription_expired'];

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (ACTIVE_EVENTS.includes(eventName)) {
    const attrs = payload?.data?.attributes;
    const variantId = attrs?.variant_id;
    const rawEmail = attrs?.user_email;
    const userEmail = EMAIL_RE.test(rawEmail) ? rawEmail : null;
    const userId = payload?.meta?.custom_data?.user_id || null;
    const status = attrs?.status;

    if (!userId && !userEmail) {
      console.error('[webhook] No userId or valid email in payload — cannot update plan');
      return res.status(200).send('OK');
    }

    const plan = variantToPlan(variantId);
    if (!plan) {
      console.warn('[webhook] Unknown variant ID:', variantId);
      return res.status(200).send('OK');
    }

    const isActive = ['active', 'on_trial'].includes(status);
    await updateUserPlan(userId, userEmail, isActive ? plan : 'free');

  } else if (CANCEL_EVENTS.includes(eventName)) {
    const attrs = payload?.data?.attributes;
    const rawEmail = attrs?.user_email;
    const userEmail = EMAIL_RE.test(rawEmail) ? rawEmail : null;
    const userId = payload?.meta?.custom_data?.user_id || null;

    if (!userId && !userEmail) {
      console.error('[webhook] No userId or valid email in cancel payload');
      return res.status(200).send('OK');
    }
    await updateUserPlan(userId, userEmail, 'free');

  } else {
    console.warn('[webhook] Unrecognized event name — ignoring:', eventName);
  }

  res.status(200).send('OK');
});

const PLAN_CREDITS = { pro: 1000, enterprise: 4000, paid: 1000 };

async function updateUserPlan(userId, email, plan) {
  const supabase = makeAdminClient();
  const updateData = { plan };
  if (PLAN_CREDITS[plan]) {
    updateData.credits = PLAN_CREDITS[plan];
  } else {
    updateData.credits = 0;
  }

  if (userId) {
    const { error } = await supabase.from('profiles').update(updateData).eq('id', userId);
    if (!error) {
      console.log(`[webhook] Plan updated to '${plan}' (credits=${updateData.credits}) for user_id=${userId}`);
      return;
    }
    console.error('[webhook] Update by userId failed:', error.message);
  }

  if (email) {
    const { error } = await supabase.from('profiles').update(updateData).eq('email', email);
    if (!error) {
      console.log(`[webhook] Plan updated to '${plan}' (credits=${updateData.credits}) for email=${email}`);
      return;
    }
    console.error('[webhook] Update by email failed:', error.message);
  }

  console.error('[webhook] Could not update plan — no userId or email matched');
}

/* ── GET /api/payment/status ── */
router.get('/status', async (req, res) => {
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
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('plan')
    .eq('id', user.id)
    .single();

  if (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch subscription status' });
  }

  res.json({ success: true, plan: profile.plan });
});

module.exports = router;
