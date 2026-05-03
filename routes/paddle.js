'use strict';
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

/* ── Supabase admin client ── */
function makeAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return createClient(process.env.SUPABASE_URL, key, {
    auth: { persistSession: false }
  });
}

/* ── Paddle signature verification ── */
// Header format: Paddle-Signature: ts=1696150526;h1=<hmac_hex>
// Signed payload: timestamp + ":" + rawBody  (NO "ts=" prefix)
function verifyPaddleSignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const parts = {};
  signatureHeader.split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    parts[part.slice(0, idx)] = part.slice(idx + 1);
  });
  const ts = parts['ts'];
  const h1 = parts['h1'];
  if (!ts || !h1) return false;

  const signedPayload = ts + ':' + rawBody;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(h1));
  } catch (_) {
    return false;
  }
}

/* ── Plan mapping by Paddle price ID ── */
function priceIdToPlan(priceId) {
  if (priceId === process.env.PADDLE_PRO_PRICE_ID) return 'pro';
  if (priceId === process.env.PADDLE_ENTERPRISE_PRICE_ID) return 'enterprise';
  return null;
}

const PLAN_CREDITS = { pro: 1000, enterprise: 4000 };

/* ── DB update ── */
async function updateUserPlan(userId, plan) {
  const supabase = makeAdminClient();
  const credits = PLAN_CREDITS[plan] || 0;
  const { error } = await supabase
    .from('profiles')
    .update({ plan, credits })
    .eq('id', userId);
  if (error) {
    console.error('[paddle/webhook] Failed to update plan for userId=' + userId + ':', error.message);
  } else {
    console.log('[paddle/webhook] Plan updated to \'' + plan + '\' (credits=' + credits + ') for userId=' + userId);
  }
}

/* ── POST /api/paddle/webhook ── */
// express.raw() applied at ROUTE LEVEL so it runs before global express.json()
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async function (req, res) {
    // Guard: body must be a raw Buffer
    if (!Buffer.isBuffer(req.body)) {
      console.error('[paddle/webhook] req.body is not a Buffer — check middleware order');
      return res.status(400).send('Invalid body');
    }

    const rawBody = req.body.toString('utf8');
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    const signatureHeader = req.headers['paddle-signature'];

    if (!secret) {
      console.error('[paddle/webhook] PADDLE_WEBHOOK_SECRET is not configured — rejecting all webhooks');
      return res.status(500).send('Webhook secret not configured');
    }
    if (!signatureHeader) {
      console.warn('[paddle/webhook] Missing Paddle-Signature header — possible spoofed request');
      return res.status(401).send('Missing signature');
    }
    if (!verifyPaddleSignature(secret, rawBody, signatureHeader)) {
      console.warn('[paddle/webhook] Signature mismatch — possible spoofed request');
      return res.status(401).send('Invalid signature');
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      return res.status(400).send('Invalid JSON payload');
    }

    const eventType = payload?.event_type;
    const eventId = payload?.notification_id || payload?.data?.id;
    console.log('[paddle/webhook] Event received:', eventType, '| id:', eventId);

    // Replay attack prevention: deduplicate by event_id
    if (eventId) {
      try {
        const adminClient = makeAdminClient();
        const { error: dupError } = await adminClient
          .from('webhook_events')
          .insert({ event_id: String(eventId) });
        if (dupError) {
          if (dupError.code === '23505') {
            console.log('[paddle/webhook] Duplicate event_id, skipping:', eventId);
            return res.status(200).send('OK');
          }
          console.error('[paddle/webhook] Failed to record event_id:', dupError.message);
        }
      } catch (err) {
        console.error('[paddle/webhook] Replay check failed:', err.message);
      }
    }

    // Only transaction.completed triggers credit grant (one-time purchase)
    if (eventType === 'transaction.completed') {
      const data = payload?.data;
      const userId = data?.custom_data?.userId;
      const priceId = data?.items?.[0]?.price?.id;
      const plan = priceIdToPlan(priceId);

      if (!userId) {
        console.error('[paddle/webhook] No userId in custom_data — cannot update plan');
        return res.status(200).send('OK');
      }
      if (!plan) {
        console.warn('[paddle/webhook] Unknown priceId:', priceId, '— ignoring');
        return res.status(200).send('OK');
      }

      await updateUserPlan(userId, plan);
    } else {
      // All other events (subscription.*, refund.*, etc.): log only, no DB update
      console.log('[paddle/webhook] Unhandled event type, ignoring:', eventType);
    }

    return res.status(200).send('OK');
  }
);

module.exports = router;
