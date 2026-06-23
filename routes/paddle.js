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

/* ── Route a transaction.completed event by its `data.origin` ── */
// Returns one of:
//   'grant'  → new purchase or renewal: existing credit grant/reset (unchanged)
//   'defer'  → plan change (subscription_update): credit handling deferred to a
//              later step; plan itself is synced via the subscription.updated event
//   'ignore' → not credit-related (one-time charge, payment-method change, unknown)
// NOTE: Both 'checkout' and 'web' are treated as new-purchase origins because
// Paddle's documented value for a Paddle.js checkout is ambiguous across docs
// (changelog says "checkout"; the origin enum uses "web"). Covering both keeps
// the new-subscription grant working regardless of which one is emitted.
function classifyTransactionOrigin(origin) {
  if (origin === 'subscription_update') return 'defer';
  if (origin === 'checkout' || origin === 'web' || origin === 'subscription_recurring') return 'grant';
  return 'ignore';
}

/* ── Reset credits on each subscription payment (initial + renewals) ── */
// Subscription (reset, no rollover): Paddle fires transaction.completed every
// billing cycle. grant_credits RPC SETs credits to the plan allotment (not +=),
// so each renewal resets the balance to e.g. 1000 instead of accumulating.
async function grantCreditsForPurchase(supabase, transactionId, userId, plan) {
  const credits = PLAN_CREDITS[plan] || 0;

  // Record payment in ledger first (idempotency guard via UNIQUE on transaction_id).
  // Each billing cycle has a distinct transaction_id → one ledger row per payment.
  const { error: insertError } = await supabase
    .from('purchases')
    .insert({
      transaction_id: transactionId,
      user_id: userId,
      plan,
      credits_granted: credits,
      status: 'completed'
    });

  if (insertError) {
    if (insertError.code === '23505') {
      console.log('[paddle/webhook] Payment already recorded for transaction_id=' + transactionId + ', skipping reset');
      return;
    }
    throw new Error('Failed to insert purchase record: ' + insertError.message);
  }

  // Atomically reset credits to the plan allotment via RPC
  const { error: rpcError } = await supabase.rpc('grant_credits', {
    p_user_id: userId,
    p_plan: plan,
    p_amount: credits
  });

  if (rpcError) {
    throw new Error('grant_credits RPC failed: ' + rpcError.message);
  }

  console.log('[paddle/webhook] Reset credits to ' + credits + ' (' + plan + ') for userId=' + userId + ' transaction=' + transactionId);
}

/* ── Store Paddle customer/subscription IDs for future portal session use ── */
async function saveSubscriptionIds(supabase, { userId, customerId, subscriptionId }) {
  const updates = {};
  if (customerId)     updates.paddle_customer_id     = customerId;
  if (subscriptionId) updates.paddle_subscription_id = subscriptionId;
  if (Object.keys(updates).length === 0) return;

  const { error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId);

  if (error) {
    // Credit grant already succeeded — log only, do not throw (keeps webhook 200 OK)
    console.error('[paddle/webhook] Failed to save Paddle IDs for userId=' + userId + ':', error.message);
  }
}

/* ── Sync plan on subscription change (subscription.updated) ── */
// Fired on any subscription change, including plan up/downgrades. We update only
// the plan column here; credit recalculation is intentionally deferred to a later
// step. A downgrade may not emit a transaction.completed, so this keeps the DB
// plan in sync regardless. Re-writing the same plan is harmless (idempotent).
async function syncPlanFromSubscription(supabase, userId, plan) {
  const { error } = await supabase
    .from('profiles')
    .update({ plan })
    .eq('id', userId);

  if (error) {
    throw new Error('Failed to sync plan from subscription.updated: ' + error.message);
  }

  console.log('[paddle/webhook] Synced plan=' + plan + ' for userId=' + userId + ' (subscription.updated)');
}

/* ── Apply plan change with credit recalculation (subscription.updated, Step 2) ── */
// Calls the apply_plan_change Postgres RPC which atomically:
//   - Reads current plan + credits (FOR UPDATE lock)
//   - Upgrade  → resets credits to full allotment
//   - Downgrade → credits = min(remaining, new allotment)
//   - Same plan → credits unchanged (idempotent re-delivery safe)
// Returns the new credits value.
async function applyPlanChange(supabase, userId, plan) {
  const allotment = PLAN_CREDITS[plan];
  const { data, error } = await supabase.rpc('apply_plan_change', {
    p_user_id: userId,
    p_new_plan: plan,
    p_new_allotment: allotment
  });

  if (error) {
    throw new Error('apply_plan_change RPC failed: ' + error.message);
  }

  console.log('[paddle/webhook] Plan change applied: plan=' + plan + ' credits=' + data + ' userId=' + userId);
  return data;
}

/* ── Expire subscription at period end (subscription.canceled) ── */
// Paddle fires subscription.canceled when an end-of-period cancellation actually
// takes effect (status → canceled). At that point the user loses access:
// plan → free, credits → 0.
async function expireSubscription(supabase, userId) {
  const { error } = await supabase
    .from('profiles')
    .update({ plan: 'free', credits: 0 })
    .eq('id', userId);

  if (error) {
    throw new Error('Failed to expire subscription: ' + error.message);
  }

  console.log('[paddle/webhook] Subscription expired (plan=free, credits=0) for userId=' + userId);
}

/* ── Revoke credits on refund ── */
async function revokeCreditsForRefund(supabase, transactionId) {
  // Look up original purchase by transaction_id
  const { data: purchase, error: lookupError } = await supabase
    .from('purchases')
    .select('id, user_id, credits_granted, status')
    .eq('transaction_id', transactionId)
    .single();

  if (lookupError || !purchase) {
    console.error('[paddle/webhook] No purchase record found for transaction_id=' + transactionId + ' — cannot revoke credits');
    return;
  }

  if (purchase.status === 'refunded') {
    console.log('[paddle/webhook] Purchase already refunded for transaction_id=' + transactionId + ', skipping');
    return;
  }

  // Mark purchase as refunded
  const { error: updateError } = await supabase
    .from('purchases')
    .update({ status: 'refunded' })
    .eq('id', purchase.id);

  if (updateError) {
    throw new Error('Failed to mark purchase as refunded: ' + updateError.message);
  }

  // Atomically deduct credits via RPC
  const { error: rpcError } = await supabase.rpc('revoke_credits', {
    p_user_id: purchase.user_id,
    p_amount: purchase.credits_granted
  });

  if (rpcError) {
    throw new Error('revoke_credits RPC failed: ' + rpcError.message);
  }

  console.log('[paddle/webhook] Revoked ' + purchase.credits_granted + ' credits from userId=' + purchase.user_id + ' for refunded transaction=' + transactionId);
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

    try {
      if (eventType === 'transaction.completed') {
        const data = payload?.data;
        const transactionId = data?.id;
        const userId = data?.custom_data?.userId;
        const priceId = data?.items?.[0]?.price?.id;
        const plan = priceIdToPlan(priceId);

        // ── Origin routing (overlaid on top of the existing grant flow) ──
        // Only 'grant' origins (new purchase / renewal) fall through to the
        // unchanged credit logic below. Plan changes are deferred; everything
        // else is ignored. This must not alter the checkout/recurring behavior.
        const decision = classifyTransactionOrigin(data?.origin);
        if (decision === 'defer') {
          console.log(
            '[paddle/webhook] transaction.completed origin=subscription_update (plan change) — credit handling deferred to next step |',
            'transaction_id=' + transactionId,
            '| userId=' + (userId || 'n/a')
          );
          return res.status(200).send('OK');
        }
        if (decision === 'ignore') {
          console.warn(
            '[paddle/webhook] transaction.completed origin=' + (data?.origin || 'undefined') +
            ' — not a credit-granting origin, ignoring |',
            'transaction_id=' + transactionId,
            '| userId=' + (userId || 'n/a')
          );
          return res.status(200).send('OK');
        }
        // decision === 'grant' → existing behavior below (UNCHANGED)

        if (!userId) {
          console.error('[paddle/webhook] No userId in custom_data — cannot grant credits');
          return res.status(200).send('OK');
        }
        if (!plan) {
          // 결제는 성공했으나 priceId 가 env(PADDLE_*_PRICE_ID) 와 매칭 실패.
          // 크레딧이 지급되지 않으므로 매출 손실로 이어질 수 있는 치명적 케이스.
          // 200 OK 는 유지 (Paddle 재전송 폭주 방지) — 대신 역추적 가능한 식별자를 error 로 남긴다.
          console.error(
            '[paddle/webhook] [CRITICAL] 결제 성공했으나 plan 매칭 실패 — 크레딧 미지급, 매출 손실 가능 |',
            'priceId=' + priceId,
            '| transaction_id=' + transactionId,
            '| userId=' + userId,
            '| customer_id=' + (data?.customer_id || 'n/a'),
            '| customer_email=' + (data?.customer?.email || 'n/a (payload 에 미포함)')
          );
          return res.status(200).send('OK');
        }
        if (!transactionId) {
          console.error('[paddle/webhook] No transaction id in payload — cannot record purchase');
          return res.status(200).send('OK');
        }

        const supabase = makeAdminClient();
        await grantCreditsForPurchase(supabase, transactionId, userId, plan);
        await saveSubscriptionIds(supabase, {
          userId,
          customerId: data?.customer_id,
          subscriptionId: data?.subscription_id,
        });

      } else if (eventType === 'adjustment.created') {
        // Refund event — no userId in payload, must look up via purchases table
        const data = payload?.data;
        const action = data?.action;
        const status = data?.status;
        const transactionId = data?.transaction_id;

        // Only process approved credit refunds
        if (action !== 'refund' && action !== 'credit') {
          console.log('[paddle/webhook] Adjustment action \'' + action + '\' is not a refund/credit, ignoring');
          return res.status(200).send('OK');
        }
        if (status !== 'approved') {
          console.log('[paddle/webhook] Adjustment status \'' + status + '\' is not approved, ignoring');
          return res.status(200).send('OK');
        }
        if (!transactionId) {
          console.error('[paddle/webhook] No transaction_id in adjustment payload — cannot process refund');
          return res.status(200).send('OK');
        }

        const supabase = makeAdminClient();
        await revokeCreditsForRefund(supabase, transactionId);

      } else if (eventType === 'subscription.updated') {
        // Subscription changed (incl. plan up/downgrade).
        // Atomically recalculates credits via apply_plan_change RPC.
        const data = payload?.data;
        let userId = data?.custom_data?.userId;
        const priceId = data?.items?.[0]?.price?.id;
        const plan = priceIdToPlan(priceId);

        // userId fallback: if custom_data.userId is absent (e.g. older Paddle checkout
        // sessions before we started embedding it), look up the profile by the
        // paddle_customer_id stored during the initial purchase.
        const supabase = makeAdminClient();
        if (!userId) {
          const customerId = data?.customer_id;
          if (customerId) {
            const { data: profile, error: lookupError } = await supabase
              .from('profiles')
              .select('id')
              .eq('paddle_customer_id', customerId)
              .single();
            if (!lookupError && profile?.id) {
              userId = profile.id;
              console.log('[paddle/webhook] subscription.updated — resolved userId=' + userId + ' from paddle_customer_id=' + customerId);
            }
          }
        }

        if (!userId) {
          // Both custom_data.userId and paddle_customer_id lookup failed — cannot
          // identify the user. Log as CRITICAL (no credit change made).
          console.error(
            '[paddle/webhook] [CRITICAL] subscription.updated — userId 특정 불가',
            '(custom_data.userId 없음, paddle_customer_id 조회 실패) — 크레딧 변경 생략 |',
            'subscription_id=' + (data?.id || 'n/a'),
            '| customer_id=' + (data?.customer_id || 'n/a')
          );
          return res.status(200).send('OK');
        }
        if (!plan) {
          // priceId가 env(PADDLE_*_PRICE_ID)와 매칭 실패 — plan 동기화 불가.
          // 200 OK 유지(재전송 폭주 방지) + 역추적 식별자를 error로 남긴다.
          console.error(
            '[paddle/webhook] [CRITICAL] subscription.updated priceId가 plan 매칭 실패 — plan 동기화 불가 |',
            'priceId=' + priceId,
            '| subscription_id=' + (data?.id || 'n/a'),
            '| userId=' + userId
          );
          return res.status(200).send('OK');
        }

        // KNOWN LIMITATION: if Paddle issues a credit_to_balance adjustment for a
        // downgrade, the resulting adjustment.created event will not find a matching
        // purchases row (plan changes have no transaction_id in the ledger), so
        // revokeCreditsForRefund silently exits. Credits are not double-deducted, but
        // the adjustment goes unlogged in the purchases table.
        await applyPlanChange(supabase, userId, plan);

      } else if (eventType === 'subscription.canceled') {
        // End-of-period cancellation took effect — revoke access
        const data = payload?.data;
        const userId = data?.custom_data?.userId;

        if (!userId) {
          console.error('[paddle/webhook] No userId in subscription custom_data — cannot expire subscription');
          return res.status(200).send('OK');
        }

        const supabase = makeAdminClient();
        await expireSubscription(supabase, userId);

      } else {
        console.log('[paddle/webhook] Unhandled event type, ignoring:', eventType);
      }
    } catch (err) {
      console.error('[paddle/webhook] Error processing event:', eventType, '—', err.message);
      return res.status(500).send('Internal error');
    }

    return res.status(200).send('OK');
  }
);

module.exports = router;
module.exports.classifyTransactionOrigin = classifyTransactionOrigin;
module.exports.syncPlanFromSubscription = syncPlanFromSubscription;
module.exports.applyPlanChange = applyPlanChange;
