'use strict';
require('dotenv').config();
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');

const PADDLE_API_BASE = process.env.PADDLE_API_BASE || 'https://api.paddle.com';

/* ── Pick the best portal URL from a Paddle portal-session response ── */
// Prefer the per-subscription cancel deep link; fall back to the general
// overview page. Returns null if neither is present.
function extractPortalUrl(paddleResponse, subscriptionId) {
  const urls = paddleResponse?.data?.urls;
  if (!urls) return null;
  const sub = Array.isArray(urls.subscriptions)
    ? urls.subscriptions.find((s) => s.id === subscriptionId)
    : null;
  return (sub && sub.cancel_subscription) || urls.general?.overview || null;
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

/* ── POST /api/payment/cancel ── */
// Generates an authenticated Paddle customer portal session and returns a deep
// link to the cancellation flow. The actual cancellation happens in Paddle's
// hosted portal; we sync state later via the subscription.canceled webhook.
router.post('/cancel', authMiddleware, async (req, res) => {
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    console.error('[payment/cancel] PADDLE_API_KEY is not configured');
    return res.status(500).json({ success: false, error: 'Subscription management is temporarily unavailable.' });
  }

  // Load the user's stored Paddle identifiers (saved by transaction.completed webhook)
  const { data: profile, error } = await req.supabase
    .from('profiles')
    .select('paddle_customer_id, paddle_subscription_id')
    .eq('id', req.user.id)
    .single();

  if (error) {
    console.error('[payment/cancel] Failed to load profile for userId=' + req.user.id + ':', error.message);
    return res.status(500).json({ success: false, error: 'Failed to load subscription details.' });
  }

  const customerId = profile?.paddle_customer_id;
  const subscriptionId = profile?.paddle_subscription_id;

  if (!customerId) {
    return res.status(404).json({ success: false, error: 'No active subscription found.', code: 'NO_SUBSCRIPTION' });
  }

  // Create a customer portal session (temporary — must not be cached)
  let portalRes;
  try {
    portalRes = await fetch(`${PADDLE_API_BASE}/customers/${customerId}/portal-sessions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(subscriptionId ? { subscription_ids: [subscriptionId] } : {})
    });
  } catch (err) {
    console.error('[payment/cancel] Paddle API request failed:', err.message);
    return res.status(502).json({ success: false, error: 'Could not reach subscription provider.' });
  }

  if (!portalRes.ok) {
    const body = await portalRes.text().catch(() => '');
    console.error('[payment/cancel] Paddle portal-session error status=' + portalRes.status + ' body=' + body);
    return res.status(502).json({ success: false, error: 'Could not create subscription portal session.' });
  }

  const json = await portalRes.json().catch(() => null);
  const url = extractPortalUrl(json, subscriptionId);

  if (!url) {
    console.error('[payment/cancel] No portal URL in Paddle response:', JSON.stringify(json));
    return res.status(502).json({ success: false, error: 'Subscription portal returned no link.' });
  }

  return res.json({ success: true, url });
});

module.exports = router;
module.exports.extractPortalUrl = extractPortalUrl;
