'use strict';
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();
const { reportIncident } = require('../lib/incident-reporter');
const { recordServerEvent } = require('../lib/product-analytics');

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

/* ── Test-account whitelist (env-managed, no code deploy) ── */
// Accounts in TEST_ACCOUNT_USER_IDS (comma-separated user_id list) are FROZEN:
// every webhook plan/credits mutation is skipped so their plan/credits stay
// exactly as set manually. Parsing is safe by default — unset/empty → empty set
// → nobody is whitelisted. Pure function (envStr injectable) for testability.
function isTestAccount(userId, envStr = process.env.TEST_ACCOUNT_USER_IDS) {
  if (!userId || !envStr) return false;
  const ids = String(envStr)
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  return ids.indexOf(String(userId).trim()) !== -1;
}

/* ── Check if subscription status allows plan changes ── */
// Only 'active' and 'trialing' subscriptions should have their plan/credits
// recalculated. When Paddle fires subscription.updated + subscription.canceled
// together (e.g. immediate cancel), the two events can race. If updated arrives
// after canceled has already set plan=free/credits=0, applying a plan change
// would re-grant credits to a canceled account. Guarding on status prevents that.
function isActiveSubscription(status) {
  return status === 'active' || status === 'trialing';
}

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
// billing cycle. apply_subscription_payment atomically records the transaction
// and SETs credits to the plan allotment, so retries cannot reset twice.
async function grantCreditsForPurchase(supabase, transactionId, userId, plan) {
  const credits = PLAN_CREDITS[plan] || 0;
  const skipCreditMutation = isTestAccount(userId);
  const { data: result, error } = await supabase.rpc('apply_subscription_payment', {
    p_transaction_id: transactionId,
    p_user_id: userId,
    p_plan: plan,
    p_amount: credits,
    p_skip_credit_mutation: skipCreditMutation
  });

  if (error) {
    throw new Error('apply_subscription_payment RPC failed: ' + error.message);
  }

  if (result?.reason === 'duplicate') {
    console.log('[paddle/webhook] Payment already applied for transaction_id=' + transactionId + ', skipping reset');
    return result;
  }

  if (skipCreditMutation) {
    console.warn('[paddle/webhook] [TEST_ACCOUNT] grant_credits 스킵(결제해도 크레딧 미지급) userId=' + userId + ' transaction=' + transactionId);
    return result;
  }

  console.log('[paddle/webhook] Reset credits to ' + credits + ' (' + plan + ') for userId=' + userId + ' transaction=' + transactionId);
  await recordServerEvent({
    eventName: 'purchase_completed',
    userId,
    properties: {
      plan,
      creditsGranted: credits,
      transactionType: 'subscription_payment'
    }
  });
  return result;
}

/* ── Record plan-upgrade transaction in purchases ledger (defer branch) ── */
// Inserts a ledger row for a plan-change transaction. Credits are NOT touched here —
// apply_plan_change in subscription.updated handles credit recalculation exclusively.
// UNIQUE(transaction_id) 23505 = idempotent skip (safe for Paddle re-delivery).
async function recordPlanUpgradePurchase(supabase, { transactionId, userId, plan, subscriptionId }) {
  const credits = PLAN_CREDITS[plan] || 0;
  const { error } = await supabase
    .from('purchases')
    .insert({
      transaction_id:   transactionId,
      user_id:          userId,
      plan,
      credits_granted:  credits,
      status:           'completed',
      subscription_id:  subscriptionId || null,
      transaction_type: 'plan_upgrade'
    });

  if (error) {
    if (error.code === '23505') {
      console.log('[paddle/webhook] plan_upgrade already recorded for transaction_id=' + transactionId + ', skipping');
      return;
    }
    throw new Error('Failed to record plan_upgrade purchase: ' + error.message);
  }

  console.log('[paddle/webhook] Recorded plan_upgrade: transaction_id=' + transactionId + ' plan=' + plan + ' userId=' + userId);
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
    throw new Error('Failed to save Paddle subscription IDs: ' + error.message);
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
  // Whitelist: frozen account — skip plan/credit recalculation.
  if (isTestAccount(userId)) {
    console.warn('[paddle/webhook] [TEST_ACCOUNT] apply_plan_change 스킵(plan 변경 무시) userId=' + userId + ' plan=' + plan);
    return null;
  }

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
  // Whitelist: frozen account — do not expire.
  if (isTestAccount(userId)) {
    console.warn('[paddle/webhook] [TEST_ACCOUNT] expireSubscription 스킵(취소돼도 plan/credits 유지) userId=' + userId);
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .update({ plan: 'free', credits: 0 })
    .eq('id', userId);

  if (error) {
    throw new Error('Failed to expire subscription: ' + error.message);
  }

  console.log('[paddle/webhook] Subscription expired (plan=free, credits=0) for userId=' + userId);
}

/* ── Derive the plan in effect BEFORE a given plan-change row ── */
// previous_plan = result plan of the immediately-prior ledger row for the same
// subscription_id (ordered by the monotonic purchase id). No prior row → 'free'. This avoids
// reverse-inference: the value comes from committed history, not a guess.
// LIMITATION: the ledger records upgrades + new purchases only (not downgrades),
// so a downgrade between two upgrades is invisible here.
async function derivePreviousPlan(supabase, { subscriptionId, beforeId }) {
  if (!subscriptionId) return 'free';
  const { data: prior, error } = await supabase
    .from('purchases')
    .select('plan, created_at, id')
    .eq('subscription_id', subscriptionId)
    .lt('id', beforeId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error('Failed to derive previous plan: ' + error.message);
  }
  return prior?.plan || 'free';
}

/* ── Revoke credits on refund ── */
// adjustmentType: Paddle adjustment.data.type — 'full' | 'partial' (may be undefined).
async function revokeCreditsForRefund(supabase, transactionId, adjustmentType) {
  // Look up original purchase by transaction_id
  const { data: purchase, error: lookupError } = await supabase
    .from('purchases')
    .select('id, user_id, credits_granted, status, transaction_type, subscription_id, created_at')
    .eq('transaction_id', transactionId)
    .single();

  if (lookupError || !purchase) {
    throw new Error('Purchase record not found for transaction_id=' + transactionId);
  }

  if (purchase.status === 'refunded') {
    console.log('[paddle/webhook] Purchase already refunded for transaction_id=' + transactionId + ', skipping');
    return { applied: false, reason: 'duplicate' };
  }

  // Partial refunds have no safe credit mapping. Never revoke a full allotment for
  // a partial monetary refund; leave the account untouched and require review.
  if (adjustmentType !== 'full') {
    console.error(
      '[paddle/webhook] [CRITICAL] 부분환불(type=' + (adjustmentType || 'n/a') +
      ') — credit mapping 불가, 스킵(운영자 수동 처리 필요) |',
      'transaction_id=' + transactionId,
      '| userId=' + purchase.user_id
    );
    await reportIncident({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'PARTIAL_REFUND_REQUIRES_REVIEW',
      message: 'A partial refund cannot be mapped safely to PromptGen credits',
      fingerprint: `paddle-webhook:PARTIAL_REFUND_REQUIRES_REVIEW:${transactionId}`,
      context: {
        transactionId,
        userId: purchase.user_id,
        transactionType: purchase.transaction_type || null,
        adjustmentType: adjustmentType || null
      }
    });
    return { action: 'partial_skip' };
  }

  // Whitelist: record the full refund in the purchase ledger, but keep the
  // account's plan/credits frozen.
  if (isTestAccount(purchase.user_id)) {
    const { data: result, error: rpcError } = await supabase.rpc('apply_purchase_refund', {
      p_transaction_id: transactionId,
      p_previous_plan: null,
      p_previous_allotment: null,
      p_skip_credit_mutation: true
    });
    if (rpcError) {
      throw new Error('apply_purchase_refund RPC failed: ' + rpcError.message);
    }
    console.warn('[paddle/webhook] [TEST_ACCOUNT] 환불 원장만 반영(plan/credits 유지) userId=' + purchase.user_id + ' transaction=' + transactionId);
    return { action: 'test_account_skip', result };
  }

  // ── plan_upgrade refund: atomically restore plan and mark the purchase refunded ──
  if (purchase.transaction_type === 'plan_upgrade') {

    const previousPlan = await derivePreviousPlan(supabase, {
      subscriptionId: purchase.subscription_id,
      beforeId: purchase.id
    });
    const previousAllotment = PLAN_CREDITS[previousPlan] || 0;

    const { data: result, error: rpcError } = await supabase.rpc('apply_purchase_refund', {
      p_transaction_id: transactionId,
      p_previous_plan: previousPlan,
      p_previous_allotment: previousAllotment,
      p_skip_credit_mutation: false
    });

    if (rpcError) {
      throw new Error('apply_purchase_refund RPC failed: ' + rpcError.message);
    }

    if (result?.reason === 'plan_restored') {
      console.log(
        '[paddle/webhook] plan_upgrade 환불 복원 완료: plan→' + previousPlan +
        ' credits=' + result.newBalance + ' userId=' + purchase.user_id + ' transaction=' + transactionId
      );
    } else if (result?.reason === 'credits_used') {
      // Policy violation: credits were used but a refund was issued (operator error).
      // Leave plan/credits untouched — do not compound the mistake. Flag loudly.
      console.error(
        '[paddle/webhook] [CRITICAL] 정책위반 환불 — 크레딧 사용된 계정이 환불됨, plan 복원 스킵(무변경) |',
        'transaction_id=' + transactionId,
        '| userId=' + purchase.user_id,
        '| current_credits=' + result.newBalance,
        '| granted=' + purchase.credits_granted
      );
      await reportIncident({
        severity: 'critical',
        source: 'paddle-webhook',
        eventCode: 'REFUND_AFTER_CREDIT_USAGE',
        message: 'A refunded plan upgrade had already-used credits and requires manual review',
        fingerprint: `paddle-webhook:REFUND_AFTER_CREDIT_USAGE:${transactionId}`,
        context: {
          transactionId,
          userId: purchase.user_id,
          currentCredits: result.newBalance,
          grantedCredits: purchase.credits_granted
        }
      });
    } else {
      // account_free (already canceled) — free-guard prevented plan resurrection.
      console.warn(
        '[paddle/webhook] plan_upgrade 환불 — 계정이 이미 free(취소됨), plan 복원 스킵 |',
        'transaction_id=' + transactionId,
        '| userId=' + purchase.user_id,
        '| reason=' + (result?.reason || 'unknown')
      );
    }
    return result;
  }

  const { data: result, error: rpcError } = await supabase.rpc('apply_purchase_refund', {
    p_transaction_id: transactionId,
    p_previous_plan: null,
    p_previous_allotment: null,
    p_skip_credit_mutation: false
  });

  if (rpcError) {
    throw new Error('apply_purchase_refund RPC failed: ' + rpcError.message);
  }

  if (result?.reason === 'duplicate') {
    console.log('[paddle/webhook] Purchase already refunded for transaction_id=' + transactionId + ', skipping');
  } else {
    console.log('[paddle/webhook] Revoked ' + purchase.credits_granted + ' credits from userId=' + purchase.user_id + ' for refunded transaction=' + transactionId);
  }
  return result;
}

const WEBHOOK_LEASE_SECONDS = 300;

function webhookProcessingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizeWebhookError(error) {
  const code = String(error?.code || error?.name || 'WEBHOOK_PROCESSING_ERROR')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80);
  const message = String(error?.message || 'Unknown webhook error')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 800);
  return code + ': ' + message;
}

async function claimPaddleWebhookEvent(supabase, eventId, claimToken) {
  const { data, error } = await supabase.rpc('claim_paddle_webhook_event', {
    p_event_id: eventId,
    p_claim_token: claimToken,
    p_lease_seconds: WEBHOOK_LEASE_SECONDS
  });
  if (error) {
    throw new Error('claim_paddle_webhook_event RPC failed: ' + error.message);
  }
  if (!data || !['claimed', 'completed', 'busy'].includes(data.outcome)) {
    throw new Error('claim_paddle_webhook_event returned an invalid outcome');
  }
  return data;
}

async function completePaddleWebhookEvent(supabase, eventId, claimToken) {
  const { data, error } = await supabase.rpc('complete_paddle_webhook_event', {
    p_event_id: eventId,
    p_claim_token: claimToken
  });
  if (error) {
    throw new Error('complete_paddle_webhook_event RPC failed: ' + error.message);
  }
  if (data !== true) {
    const claimError = new Error('Paddle webhook claim was lost before completion');
    claimError.code = 'WEBHOOK_CLAIM_LOST';
    throw claimError;
  }
}

async function failPaddleWebhookEvent(supabase, eventId, claimToken, error) {
  const sanitizedError = sanitizeWebhookError(error);
  const { data, error: rpcError } = await supabase.rpc('fail_paddle_webhook_event', {
    p_event_id: eventId,
    p_claim_token: claimToken,
    p_error: sanitizedError
  });
  if (rpcError) {
    throw new Error('fail_paddle_webhook_event RPC failed: ' + rpcError.message);
  }
  return data === true;
}

async function executePaddleWebhook({
  payload,
  requestId,
  supabase,
  processEvent,
  incidentReporter = reportIncident,
  claimToken = crypto.randomUUID()
}) {
  const eventType = payload?.event_type;
  const eventId = payload?.notification_id;

  if (!eventId || typeof eventId !== 'string' || !eventId.trim() || eventId.length > 255) {
    console.error('[paddle/webhook] notification_id is required for durable processing');
    return { statusCode: 400, body: 'Missing notification_id', outcome: 'invalid' };
  }
  if (!eventType || typeof eventType !== 'string') {
    console.error('[paddle/webhook] event_type is required for durable processing');
    return { statusCode: 400, body: 'Missing event_type', outcome: 'invalid' };
  }

  let claim;
  try {
    claim = await claimPaddleWebhookEvent(supabase, eventId, claimToken);
  } catch (error) {
    console.error('[paddle/webhook] Failed to claim event:', eventId, '—', error.message);
    await incidentReporter({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'PADDLE_EVENT_CLAIM_FAILED',
      message: error.message,
      fingerprint: `paddle-webhook:PADDLE_EVENT_CLAIM_FAILED:${eventId}`,
      context: { requestId, eventId, eventType, error }
    });
    return { statusCode: 503, body: 'Webhook temporarily unavailable', outcome: 'claim_failed', retryAfter: '5' };
  }

  if (claim.outcome === 'completed') {
    console.log('[paddle/webhook] Completed duplicate event, acknowledging:', eventId);
    return { statusCode: 200, body: 'OK', outcome: 'duplicate' };
  }
  if (claim.outcome === 'busy') {
    console.warn('[paddle/webhook] Concurrent event delivery is still processing:', eventId);
    return { statusCode: 503, body: 'Event already processing', outcome: 'busy', retryAfter: '5' };
  }

  try {
    await processEvent();
    await completePaddleWebhookEvent(supabase, eventId, claimToken);
    return { statusCode: 200, body: 'OK', outcome: 'completed' };
  } catch (error) {
    console.error('[paddle/webhook] Error processing event:', eventType, '—', error.message);
    try {
      const failed = await failPaddleWebhookEvent(supabase, eventId, claimToken, error);
      if (!failed) {
        console.error('[paddle/webhook] Could not mark failed event because the claim was lost:', eventId);
      }
    } catch (failError) {
      console.error('[paddle/webhook] Failed to persist retryable event failure:', eventId, '—', failError.message);
    }

    await incidentReporter({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'PADDLE_EVENT_PROCESSING_FAILED',
      message: error.message,
      fingerprint: `paddle-webhook:PADDLE_EVENT_PROCESSING_FAILED:${eventId}`,
      context: { requestId, eventId, eventType, error }
    });
    return { statusCode: 500, body: 'Internal error', outcome: 'failed' };
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
    const eventId = payload?.notification_id;
    console.log('[paddle/webhook] Event received:', eventType, '| id:', eventId);

    let adminClient;
    try {
      adminClient = makeAdminClient();
    } catch (error) {
      console.error('[paddle/webhook] Admin client initialization failed:', error.message);
      return res.status(503).send('Webhook temporarily unavailable');
    }

    const execution = await executePaddleWebhook({
      payload,
      requestId: req.id,
      supabase: adminClient,
      processEvent: async function () {
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
          // Record plan-change transaction in the purchases ledger for refund tracking.
          // Credits are NOT changed here — apply_plan_change in subscription.updated handles that.
          const supabase = adminClient;
          let deferUserId = userId;

          // userId fallback: same pattern as subscription.updated handler
          if (!deferUserId) {
            const customerId = data?.customer_id;
            if (customerId) {
              const { data: profile, error: lookupError } = await supabase
                .from('profiles')
                .select('id')
                .eq('paddle_customer_id', customerId)
                .single();
              if (!lookupError && profile?.id) {
                deferUserId = profile.id;
                console.log('[paddle/webhook] defer — resolved userId=' + deferUserId + ' from paddle_customer_id=' + customerId);
              }
            }
          }

          if (!deferUserId) {
            console.error(
              '[paddle/webhook] [CRITICAL] transaction.completed defer — userId 특정 불가',
              '(custom_data.userId 없음, paddle_customer_id 조회 실패) — 원장 기록 불가 |',
              'transaction_id=' + (transactionId || 'n/a'),
              '| customer_id=' + (data?.customer_id || 'n/a')
            );
            await reportIncident({
              severity: 'critical',
              source: 'paddle-webhook',
              eventCode: 'PAYMENT_USER_UNRESOLVED',
              message: 'Plan-change transaction could not be matched to a user',
              fingerprint: `paddle-webhook:PAYMENT_USER_UNRESOLVED:${transactionId || eventId || 'unknown'}`,
              context: {
                requestId: req.id,
                eventId,
                transactionId,
                customerId: data?.customer_id || null
              }
            });
            throw webhookProcessingError(
              'PAYMENT_USER_UNRESOLVED',
              'Plan-change transaction could not be matched to a user'
            );
          }

          if (plan && transactionId && data?.subscription_id) {
            await recordPlanUpgradePurchase(supabase, {
              transactionId,
              userId: deferUserId,
              plan,
              subscriptionId: data?.subscription_id
            });
          } else {
            console.warn(
              '[paddle/webhook] defer — plan, transactionId 또는 subscriptionId 없어 원장 기록 생략 |',
              'plan=' + plan,
              '| transaction_id=' + (transactionId || 'n/a'),
              '| subscription_id=' + (data?.subscription_id || 'n/a')
            );
            throw webhookProcessingError(
              'PAYMENT_LEDGER_DATA_MISSING',
              'Plan-change transaction is missing a mapped plan, transaction ID, or subscription ID'
            );
          }
          return;
        }
        if (decision === 'ignore') {
          console.warn(
            '[paddle/webhook] transaction.completed origin=' + (data?.origin || 'undefined') +
            ' — not a credit-granting origin, ignoring |',
            'transaction_id=' + transactionId,
            '| userId=' + (userId || 'n/a')
          );
          return;
        }
        // decision === 'grant' → existing behavior below (UNCHANGED)

        if (!userId) {
          console.error('[paddle/webhook] No userId in custom_data — cannot grant credits');
          throw webhookProcessingError(
            'PAYMENT_USER_UNRESOLVED',
            'Completed subscription payment is missing custom_data.userId'
          );
        }
        if (!plan) {
          // 결제는 성공했으나 priceId 가 env(PADDLE_*_PRICE_ID) 와 매칭 실패.
          // 크레딧이 지급되지 않으므로 매출 손실로 이어질 수 있는 치명적 케이스.
          // Keep the durable inbox in failed state so a corrected price mapping can be replayed.
          console.error(
            '[paddle/webhook] [CRITICAL] 결제 성공했으나 plan 매칭 실패 — 크레딧 미지급, 매출 손실 가능 |',
            'priceId=' + priceId,
            '| transaction_id=' + transactionId,
            '| userId=' + userId,
            '| customer_id=' + (data?.customer_id || 'n/a'),
            '| customer_email=' + (data?.customer?.email || 'n/a (payload 에 미포함)')
          );
          await reportIncident({
            severity: 'critical',
            source: 'paddle-webhook',
            eventCode: 'PAYMENT_PLAN_UNMAPPED',
            message: 'A completed payment price ID did not map to a PromptGen plan',
            fingerprint: `paddle-webhook:PAYMENT_PLAN_UNMAPPED:${transactionId || eventId || 'unknown'}`,
            context: {
              requestId: req.id,
              eventId,
              transactionId,
              userId,
              priceId,
              customerId: data?.customer_id || null
            }
          });
          throw webhookProcessingError(
            'PAYMENT_PLAN_UNMAPPED',
            'Completed payment price ID did not map to a PromptGen plan'
          );
        }
        if (!transactionId) {
          console.error('[paddle/webhook] No transaction id in payload — cannot record purchase');
          throw webhookProcessingError(
            'PAYMENT_TRANSACTION_ID_MISSING',
            'Completed subscription payment is missing a transaction ID'
          );
        }

        const supabase = adminClient;
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
          return;
        }
        if (status !== 'approved') {
          console.log('[paddle/webhook] Adjustment status \'' + status + '\' is not approved, ignoring');
          return;
        }
        if (!transactionId) {
          console.error('[paddle/webhook] No transaction_id in adjustment payload — cannot process refund');
          throw webhookProcessingError(
            'REFUND_TRANSACTION_ID_MISSING',
            'Approved refund is missing a transaction ID'
          );
        }

        const supabase = adminClient;
        await revokeCreditsForRefund(supabase, transactionId, data?.type);

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
        const supabase = adminClient;
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
          await reportIncident({
            severity: 'critical',
            source: 'paddle-webhook',
            eventCode: 'SUBSCRIPTION_USER_UNRESOLVED',
            message: 'Subscription update could not be matched to a user',
            fingerprint: `paddle-webhook:SUBSCRIPTION_USER_UNRESOLVED:${data?.id || eventId || 'unknown'}`,
            context: {
              requestId: req.id,
              eventId,
              subscriptionId: data?.id || null,
              customerId: data?.customer_id || null
            }
          });
          throw webhookProcessingError(
            'SUBSCRIPTION_USER_UNRESOLVED',
            'Subscription update could not be matched to a user'
          );
        }
        if (!plan) {
          // priceId가 env(PADDLE_*_PRICE_ID)와 매칭 실패 — plan 동기화 불가.
          // Keep the durable inbox in failed state so a corrected price mapping can be replayed.
          console.error(
            '[paddle/webhook] [CRITICAL] subscription.updated priceId가 plan 매칭 실패 — plan 동기화 불가 |',
            'priceId=' + priceId,
            '| subscription_id=' + (data?.id || 'n/a'),
            '| userId=' + userId
          );
          await reportIncident({
            severity: 'critical',
            source: 'paddle-webhook',
            eventCode: 'SUBSCRIPTION_PLAN_UNMAPPED',
            message: 'Subscription update price ID did not map to a PromptGen plan',
            fingerprint: `paddle-webhook:SUBSCRIPTION_PLAN_UNMAPPED:${data?.id || eventId || 'unknown'}`,
            context: {
              requestId: req.id,
              eventId,
              subscriptionId: data?.id || null,
              userId,
              priceId
            }
          });
          throw webhookProcessingError(
            'SUBSCRIPTION_PLAN_UNMAPPED',
            'Subscription update price ID did not map to a PromptGen plan'
          );
        }

        // Guard: skip plan change for non-active subscriptions.
        // Prevents a late subscription.updated (status=canceled) from re-granting
        // credits after subscription.canceled already set plan=free.
        const subscriptionStatus = data?.status;
        if (!isActiveSubscription(subscriptionStatus)) {
          console.log(
            '[paddle/webhook] subscription.updated status=' + subscriptionStatus +
            ' — not active/trialing, skipping plan change |',
            'subscription_id=' + (data?.id || 'n/a'),
            '| userId=' + userId
          );
          return;
        }

        // transaction.completed records plan-change transaction IDs separately;
        // if a refund arrives first, the durable inbox keeps it failed until the
        // matching purchase row exists and the event can be replayed safely.
        await applyPlanChange(supabase, userId, plan);

      } else if (eventType === 'subscription.canceled') {
        // End-of-period cancellation took effect — revoke access
        const data = payload?.data;
        let userId = data?.custom_data?.userId;

        // userId fallback: same pattern as subscription.updated handler — if
        // custom_data.userId is absent, look up the profile by paddle_customer_id
        // stored during the initial purchase.
        const supabase = adminClient;
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
              console.log('[paddle/webhook] subscription.canceled — resolved userId=' + userId + ' from paddle_customer_id=' + customerId);
            }
          }
        }

        if (!userId) {
          // Both custom_data.userId and paddle_customer_id lookup failed — cannot
          // identify the user. Log as CRITICAL (no change made).
          console.error(
            '[paddle/webhook] [CRITICAL] subscription.canceled — userId 특정 불가',
            '(custom_data.userId 없음, paddle_customer_id 조회 실패) — 구독 만료 처리 생략 |',
            'subscription_id=' + (data?.id || 'n/a'),
            '| customer_id=' + (data?.customer_id || 'n/a')
          );
          await reportIncident({
            severity: 'critical',
            source: 'paddle-webhook',
            eventCode: 'CANCELLATION_USER_UNRESOLVED',
            message: 'Subscription cancellation could not be matched to a user',
            fingerprint: `paddle-webhook:CANCELLATION_USER_UNRESOLVED:${data?.id || eventId || 'unknown'}`,
            context: {
              requestId: req.id,
              eventId,
              subscriptionId: data?.id || null,
              customerId: data?.customer_id || null
            }
          });
          throw webhookProcessingError(
            'CANCELLATION_USER_UNRESOLVED',
            'Subscription cancellation could not be matched to a user'
          );
        }

        await expireSubscription(supabase, userId);

      } else {
        console.log('[paddle/webhook] Unhandled event type, ignoring:', eventType);
      }
      }
    });

    if (execution.retryAfter) {
      res.set('Retry-After', execution.retryAfter);
    }
    return res.status(execution.statusCode).send(execution.body);
  }
);

module.exports = router;
module.exports.classifyTransactionOrigin = classifyTransactionOrigin;
module.exports.isActiveSubscription = isActiveSubscription;
module.exports.isTestAccount = isTestAccount;
module.exports.recordPlanUpgradePurchase = recordPlanUpgradePurchase;
module.exports.derivePreviousPlan = derivePreviousPlan;
module.exports.syncPlanFromSubscription = syncPlanFromSubscription;
module.exports.applyPlanChange = applyPlanChange;
module.exports.grantCreditsForPurchase = grantCreditsForPurchase;
module.exports.revokeCreditsForRefund = revokeCreditsForRefund;
module.exports.saveSubscriptionIds = saveSubscriptionIds;
module.exports.sanitizeWebhookError = sanitizeWebhookError;
module.exports.claimPaddleWebhookEvent = claimPaddleWebhookEvent;
module.exports.completePaddleWebhookEvent = completePaddleWebhookEvent;
module.exports.failPaddleWebhookEvent = failPaddleWebhookEvent;
module.exports.executePaddleWebhook = executePaddleWebhook;
