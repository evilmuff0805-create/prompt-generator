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

/* ── Plan → Paddle price ID (server-side, env-based) ── */
// Mirrors routes/paddle.js priceIdToPlan() so the webhook and this endpoint
// share a single source of truth (env). NEVER trust a client-supplied price ID
// for a money-moving call — the client only sends the plan name.
function planToPriceId(plan) {
  if (plan === 'pro')        return process.env.PADDLE_PRO_PRICE_ID || null;
  if (plan === 'enterprise') return process.env.PADDLE_ENTERPRISE_PRICE_ID || null;
  return null;
}

/* ── Build the Paddle subscription-update request body ── */
// Paddle requires the COMPLETE items list — omitted items are removed. Our
// subscriptions carry a single plan item, so the full list is just this one.
// Credits are NOT touched here; the subscription.updated webhook recalculates
// them via apply_plan_change (single source for credit changes).
function buildSubscriptionUpdateBody(priceId) {
  return {
    items: [{ price_id: priceId, quantity: 1 }],
    proration_billing_mode: 'prorated_immediately'
  };
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

/* ── POST /api/payment/change-plan ── */
// Actively asks Paddle to switch the user's subscription to a different plan
// (Pro <-> Enterprise) via PATCH /subscriptions/{id}. With proration_billing_mode
// = 'prorated_immediately', Paddle charges/credits the difference right away and
// emits subscription.updated, which our webhook handles to recalculate credits
// (apply_plan_change). This endpoint MUST NOT touch credits or plan in our DB —
// the webhook is the single source for those changes, preventing double-processing.
//
// body: { plan: 'pro' | 'enterprise', preview?: boolean }
//   preview: true  → PATCH /subscriptions/{id}/preview (no charge; returns proration)
//   preview: false → PATCH /subscriptions/{id}        (applies the change, real money)
const VALID_PLANS = ['pro', 'enterprise'];

async function handleChangePlan(req, res) {
  const targetPlan = req.body?.plan;
  const isPreview = req.body?.preview === true;

  // Guard 6: target plan must be a known paid plan
  if (!VALID_PLANS.includes(targetPlan)) {
    return res.status(400).json({ success: false, error: 'Invalid plan.', code: 'INVALID_PLAN' });
  }

  // Guard 5: API key must be configured
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    console.error('[payment/change-plan] PADDLE_API_KEY is not configured');
    return res.status(500).json({ success: false, error: 'Plan changes are temporarily unavailable.' });
  }

  // Map plan → price ID server-side (never trust client). Must be configured.
  const priceId = planToPriceId(targetPlan);
  if (!priceId) {
    console.error('[payment/change-plan] [CRITICAL] No price ID configured for plan=' + targetPlan + ' (check PADDLE_*_PRICE_ID env)');
    return res.status(500).json({ success: false, error: 'Plan changes are temporarily unavailable.' });
  }

  // Load the user's current plan + stored subscription ID
  const { data: profile, error } = await req.supabase
    .from('profiles')
    .select('plan, paddle_subscription_id')
    .eq('id', req.user.id)
    .single();

  if (error) {
    console.error('[payment/change-plan] Failed to load profile for userId=' + req.user.id + ':', error.message);
    return res.status(500).json({ success: false, error: 'Failed to load subscription details.' });
  }

  const currentPlan = profile?.plan;
  const subscriptionId = profile?.paddle_subscription_id;

  // Guard 4: free users have no subscription to change — they must use checkout
  if (currentPlan === 'free' || !currentPlan) {
    return res.status(400).json({ success: false, error: 'No active subscription to change.', code: 'NO_ACTIVE_SUBSCRIPTION' });
  }
  // Guard 2: must have a stored Paddle subscription ID
  if (!subscriptionId) {
    return res.status(404).json({ success: false, error: 'No active subscription found.', code: 'NO_SUBSCRIPTION' });
  }
  // Guard 3: target must differ from current (idempotency / double-submit block)
  if (targetPlan === currentPlan) {
    return res.status(400).json({ success: false, error: 'Already on this plan.', code: 'SAME_PLAN' });
  }

  // Build the Paddle request. Preview uses the same body on the /preview path.
  const body = buildSubscriptionUpdateBody(priceId);
  const path = isPreview
    ? `/subscriptions/${subscriptionId}/preview`
    : `/subscriptions/${subscriptionId}`;

  let paddleRes;
  try {
    paddleRes = await fetch(`${PADDLE_API_BASE}${path}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('[payment/change-plan] Paddle API request failed:', err.message);
    return res.status(502).json({ success: false, error: 'Could not reach subscription provider.' });
  }

  if (!paddleRes.ok) {
    const errBody = await paddleRes.text().catch(() => '');
    if (paddleRes.status === 403) {
      console.error('[payment/change-plan] [CRITICAL] Paddle 403 — API key likely missing subscription.write scope. body=' + errBody);
    } else {
      console.error('[payment/change-plan] Paddle update error status=' + paddleRes.status + ' body=' + errBody);
    }
    // Money-related: do not leak Paddle internals; our DB is left untouched
    // (plan stays in sync via webhook). Generic, safe message only.
    return res.status(502).json({ success: false, error: 'Could not change your plan. Please try again later.' });
  }

  const json = await paddleRes.json().catch(() => null);

  if (isPreview) {
    // Return the proration preview so the caller can show the upcoming charge.
    // No money moved, no DB change.
    return res.json({ success: true, preview: true, data: json?.data || null });
  }

  // Applied. Credits/plan are synced by the subscription.updated webhook — we
  // intentionally return without writing to our DB.
  console.log('[payment/change-plan] Plan change requested: userId=' + req.user.id + ' → ' + targetPlan + ' (subscription=' + subscriptionId + ')');
  return res.json({ success: true, plan: targetPlan });
}

router.post('/change-plan', authMiddleware, handleChangePlan);

module.exports = router;
module.exports.extractPortalUrl = extractPortalUrl;
module.exports.planToPriceId = planToPriceId;
module.exports.buildSubscriptionUpdateBody = buildSubscriptionUpdateBody;
module.exports.handleChangePlan = handleChangePlan;
