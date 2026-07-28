'use strict';
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');
const {
  getPaddlePriceId,
  getPlanForPaddlePriceId,
  getPaddleCatalogMetadata,
  isPaidPlan
} = require('../lib/product-catalog');
const {
  getCreditPack,
  buildCreditPackReceiptContract,
  isCreditLedgerV2Enabled,
  isCreditPackPurchasesEnabled,
  parseExpiryDays
} = require('../lib/credit-pack-catalog');

const PADDLE_API_BASE = process.env.PADDLE_API_BASE || 'https://api.paddle.com';

function makePaymentAdminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

async function createSubscriptionCheckoutAttempt(supabase, {
  attemptId,
  userId,
  plan,
  contract
}) {
  const { data, error } = await supabase.rpc('create_subscription_checkout_attempt', {
    p_attempt_id: attemptId,
    p_user_id: userId,
    p_target_plan: plan,
    p_price_id: contract.priceId,
    p_credits: contract.credits,
    p_unit_amount: Number(contract.unitAmount),
    p_currency_code: contract.currencyCode
  });
  if (error) {
    throw new Error('create_subscription_checkout_attempt RPC failed: ' + error.message);
  }
  if (
    !data
    || !['checkout_attempt_created', 'duplicate_pending'].includes(data.reason)
    || !['created', 'bound', 'provider_unknown', 'completed'].includes(data.status)
  ) {
    throw new Error('create_subscription_checkout_attempt returned an invalid outcome');
  }
  return data;
}

async function bindSubscriptionCheckoutTransaction(supabase, {
  attemptId,
  userId,
  transactionId,
  plan,
  contract
}) {
  const { data, error } = await supabase.rpc('bind_subscription_checkout_transaction', {
    p_attempt_id: attemptId,
    p_user_id: userId,
    p_transaction_id: transactionId,
    p_origin: 'api',
    p_plan: plan,
    p_price_id: contract.priceId,
    p_credits: contract.credits,
    p_unit_amount: Number(contract.unitAmount),
    p_currency_code: contract.currencyCode,
    p_quantity: 1
  });
  if (error) {
    throw new Error('bind_subscription_checkout_transaction RPC failed: ' + error.message);
  }
  if (
    !data
    || !['transaction_bound', 'duplicate', 'already_completed'].includes(data.reason)
    || data.transactionId !== transactionId
  ) {
    throw new Error('bind_subscription_checkout_transaction returned an invalid outcome');
  }
  return data;
}

async function transitionSubscriptionCheckoutAttempt(
  supabase,
  { attemptId, userId, status, providerErrorCode = null }
) {
  const { data, error } = await supabase.rpc('transition_subscription_checkout_attempt', {
    p_attempt_id: attemptId,
    p_user_id: userId,
    p_status: status,
    p_provider_error_code: providerErrorCode
  });
  if (error) {
    throw new Error('transition_subscription_checkout_attempt RPC failed: ' + error.message);
  }
  return data;
}

async function createCreditPackPurchaseRequest(supabase, {
  requestId,
  userId,
  customerId,
  subscriptionId,
  pack,
  expiryDays
}) {
  const { data, error } = await supabase.rpc('create_credit_pack_purchase_request', {
    p_request_id: requestId,
    p_user_id: userId,
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
    p_pack_key: pack.key,
    p_credits: pack.credits,
    p_unit_amount: pack.priceCents,
    p_currency_code: 'USD',
    p_expiry_days: expiryDays
  });

  if (error) {
    throw new Error('create_credit_pack_purchase_request RPC failed: ' + error.message);
  }
  if (
    !data
    || !['purchase_request_created', 'duplicate_pending'].includes(data.reason)
    || !['created', 'submitted', 'provider_unknown', 'completed'].includes(data.status)
  ) {
    throw new Error('create_credit_pack_purchase_request returned an invalid outcome');
  }
  return data;
}

async function transitionCreditPackPurchaseRequest(
  supabase,
  { requestId, userId, status, providerErrorCode = null }
) {
  const { data, error } = await supabase.rpc('transition_credit_pack_purchase_request', {
    p_request_id: requestId,
    p_user_id: userId,
    p_status: status,
    p_provider_error_code: providerErrorCode
  });
  if (error) {
    throw new Error('transition_credit_pack_purchase_request RPC failed: ' + error.message);
  }
  return data;
}

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
  return getPaddlePriceId(plan);
}

function normalizePaidPlan(plan) {
  const normalized = String(plan || '').toLowerCase();
  return normalized === 'paid' ? 'pro' : normalized;
}

function buildSubscriptionCheckoutTransactionBody({ attemptId, plan, contract }) {
  return {
    items: [{
      price_id: contract.priceId,
      quantity: 1
    }],
    collection_mode: 'automatic',
    custom_data: {
      promptgenKind: 'subscription_checkout',
      promptgenCheckoutAttemptId: attemptId,
      promptgenTargetPlan: plan
    }
  };
}

function validateCreatedSubscriptionTransaction(data, expected) {
  const item = Array.isArray(data?.items) && data.items.length === 1
    ? data.items[0]
    : null;
  const metadata = data?.custom_data;
  const metadataKeys = metadata && typeof metadata === 'object'
    ? Object.keys(metadata).sort()
    : [];
  return Boolean(
    data
    && typeof data.id === 'string'
    && data.id.trim()
    && ['draft', 'ready'].includes(data.status)
    && data.origin === 'api'
    && data.collection_mode === 'automatic'
    && data.currency_code === expected.contract.currencyCode
    && item?.quantity === 1
    && item?.price?.id === expected.contract.priceId
    && item?.price?.unit_price?.amount === expected.contract.unitAmount
    && item?.price?.unit_price?.currency_code === expected.contract.currencyCode
    && metadata?.promptgenKind === 'subscription_checkout'
    && metadata?.promptgenCheckoutAttemptId === expected.attemptId
    && metadata?.promptgenTargetPlan === expected.plan
    && metadataKeys.length === 3
    && metadataKeys[0] === 'promptgenCheckoutAttemptId'
    && metadataKeys[1] === 'promptgenKind'
    && metadataKeys[2] === 'promptgenTargetPlan'
  );
}

function buildCreditPackChargeBody({
  pack,
  requestId,
  expiryDays,
  taxCategory
}) {
  const confirmedTaxCategory = String(taxCategory || '').trim();
  if (!confirmedTaxCategory) {
    const error = new Error('Confirmed Paddle tax category is required');
    error.code = 'CREDIT_PACK_TAX_CATEGORY_REQUIRED';
    throw error;
  }
  const receipt = buildCreditPackReceiptContract(pack, expiryDays);
  const immutableMetadata = {
    promptgenKind: 'credit_pack',
    promptgenPackKey: pack.key,
    promptgenPurchaseRequestId: requestId
  };
  return {
    effective_from: 'immediately',
    items: [{
      quantity: 1,
      price: {
        description: receipt.internalDescription,
        name: receipt.priceName,
        billing_cycle: null,
        tax_mode: 'account_setting',
        unit_price: {
          amount: receipt.unitAmount,
          currency_code: receipt.currencyCode
        },
        quantity: receipt.quantity,
        custom_data: immutableMetadata,
        product: {
          name: receipt.productName,
          description: receipt.productDescription,
          tax_category: confirmedTaxCategory,
          custom_data: immutableMetadata
        }
      }
    }],
    on_payment_failure: 'prevent_change'
  };
}

function validateCreditPackChargeResponse(data, expected) {
  return Boolean(
    data
    && data.id === expected.subscriptionId
    && data.customer_id === expected.customerId
    && data.status === 'active'
  );
}

function isMinorUnitAmount(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function parseCreditPackPreviewResponse(data, expected) {
  const transaction = data?.immediate_transaction;
  const details = transaction?.details;
  const totals = details?.totals;
  const lineItems = details?.line_items;
  const lineItem = Array.isArray(lineItems) && lineItems.length === 1
    ? lineItems[0]
    : null;
  const expectedSubtotal = String(expected.pack.priceCents);

  const validIdentity = data
    && data.id === expected.subscriptionId
    && data.customer_id === expected.customerId
    && data.status === 'active'
    && data.currency_code === 'USD';
  const validCustomLineItem = lineItem
    && lineItem.price_id === null
    && lineItem.quantity === 1
    && lineItem.product?.id === null
    && lineItem.totals?.subtotal === expectedSubtotal;
  const validTotals = details?.currency_code === 'USD'
    && [
      totals?.subtotal,
      totals?.discount,
      totals?.tax,
      totals?.total,
      totals?.credit,
      totals?.balance,
      totals?.grand_total,
      totals?.grand_total_tax
    ].every(isMinorUnitAmount)
    && totals.subtotal === expectedSubtotal;

  if (!validIdentity || !validCustomLineItem || !validTotals) {
    return null;
  }

  return Object.freeze({
    currencyCode: details.currency_code,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total,
    credit: totals.credit,
    balance: totals.balance,
    grandTotal: totals.grand_total,
    grandTotalTax: totals.grand_total_tax
  });
}

function creditPackHttpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

async function loadEligibleCreditPackSubscription(req, apiKey) {
  const { data: profile, error: profileError } = await req.supabase
    .from('profiles')
    .select('plan, paddle_customer_id, paddle_subscription_id')
    .eq('id', req.user.id)
    .single();

  if (profileError) {
    throw creditPackHttpError(
      500,
      'SUBSCRIPTION_CHECK_FAILED',
      'Could not verify subscription eligibility.'
    );
  }

  const expectedPlan = normalizePaidPlan(profile?.plan);
  const customerId = profile?.paddle_customer_id;
  const subscriptionId = profile?.paddle_subscription_id;
  if (!isPaidPlan(expectedPlan) || !customerId || !subscriptionId) {
    throw creditPackHttpError(
      403,
      'ACTIVE_SUBSCRIPTION_REQUIRED',
      'An active paid subscription is required.'
    );
  }

  let subscriptionResponse;
  try {
    subscriptionResponse = await fetch(`${PADDLE_API_BASE}/subscriptions/${subscriptionId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    throw creditPackHttpError(
      502,
      'PADDLE_UNAVAILABLE',
      'Could not verify subscription eligibility.'
    );
  }

  if (!subscriptionResponse.ok) {
    throw creditPackHttpError(
      502,
      'PADDLE_UNAVAILABLE',
      'Could not verify subscription eligibility.'
    );
  }

  const subscriptionJson = await subscriptionResponse.json().catch(() => null);
  const subscription = subscriptionJson?.data;
  const hasSinglePlanItem = Array.isArray(subscription?.items)
    && subscription.items.length === 1
    && subscription.items[0]?.quantity === 1;
  const subscriptionPlan = hasSinglePlanItem
    ? getPlanForPaddlePriceId(subscription.items[0]?.price?.id)
    : null;
  const subscriptionEligible = subscription?.status === 'active'
    && subscription?.collection_mode === 'automatic'
    && subscription?.currency_code === 'USD'
    && subscription?.scheduled_change == null
    && subscription?.customer_id === customerId
    && subscriptionPlan === expectedPlan;

  if (!subscriptionEligible) {
    throw creditPackHttpError(
      403,
      'ACTIVE_SUBSCRIPTION_REQUIRED',
      'An active USD paid subscription without a pending lifecycle change is required.'
    );
  }

  return {
    profile,
    expectedPlan,
    customerId,
    subscriptionId,
    subscription
  };
}

async function requestCreditPackPreview({
  apiKey,
  subscriptionId,
  customerId,
  pack,
  chargeBody
}) {
  let previewResponse;
  try {
    previewResponse = await fetch(
      `${PADDLE_API_BASE}/subscriptions/${subscriptionId}/charge/preview`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chargeBody)
      }
    );
  } catch (_) {
    throw creditPackHttpError(
      502,
      'PADDLE_UNAVAILABLE',
      'Could not calculate the add-on total.'
    );
  }

  if (!previewResponse.ok) {
    const errorBody = await previewResponse.text().catch(() => '');
    const providerCode = extractPaddleErrorCode(errorBody);
    console.error(
      '[payment/credit-packs] Paddle preview rejected status=' +
      previewResponse.status + ' code=' + (providerCode || 'unknown')
    );
    const rejected = previewResponse.status >= 400 && previewResponse.status < 500;
    throw creditPackHttpError(
      rejected ? 409 : 502,
      rejected ? 'CREDIT_PACK_PREVIEW_REJECTED' : 'PADDLE_UNAVAILABLE',
      rejected
        ? 'This add-on cannot be charged to the subscription right now.'
        : 'Could not calculate the add-on total.'
    );
  }

  const previewJson = await previewResponse.json().catch(() => null);
  const preview = parseCreditPackPreviewResponse(previewJson?.data, {
    customerId,
    subscriptionId,
    pack
  });
  if (!preview) {
    throw creditPackHttpError(
      502,
      'INVALID_PADDLE_PREVIEW',
      'The billing provider returned an invalid add-on total.'
    );
  }
  return preview;
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

/* ── Read a Paddle error code without exposing provider details ── */
// Paddle returns structured JSON for rejected subscription updates. We only
// inspect the stable machine code; callers still receive our sanitized errors.
function extractPaddleErrorCode(body) {
  if (typeof body !== 'string' || !body.trim()) return null;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.error?.code === 'string' ? parsed.error.code : null;
  } catch (_) {
    return null;
  }
}

function sanitizeChangePlanPreview(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const currencyCode = data.currency_code;
  if (typeof currencyCode !== 'string' || !/^[A-Z]{3}$/.test(currencyCode)) {
    return null;
  }

  const immediateGrandTotal =
    data.immediate_transaction?.details?.totals?.grand_total;
  const recurringGrandTotal =
    data.recurring_transaction_details?.totals?.grand_total;
  const hasImmediate = isMinorUnitAmount(immediateGrandTotal);
  const hasRecurring = isMinorUnitAmount(recurringGrandTotal);
  if (!hasImmediate && !hasRecurring) return null;

  return {
    currency_code: currencyCode,
    immediate_transaction: hasImmediate
      ? {
          details: {
            totals: {
              grand_total: immediateGrandTotal
            }
          }
        }
      : null,
    recurring_transaction_details: hasRecurring
      ? {
          totals: {
            grand_total: recurringGrandTotal
          }
        }
      : null
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

/* ── POST /api/payment/checkout ── */
// Creates the immutable Paddle transaction on the server. The browser supplies
// only a plan name and receives a transaction ID after the authenticated user,
// selected catalog price, and API origin have been durably bound.
async function handleSubscriptionCheckout(req, res) {
  res.set('Cache-Control', 'no-store');
  const plan = String(req.body?.plan || '').toLowerCase();
  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid plan.',
      code: 'INVALID_PLAN'
    });
  }

  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    console.error('[payment/checkout] PADDLE_API_KEY is not configured');
    return res.status(503).json({
      success: false,
      error: 'Checkout is temporarily unavailable.',
      code: 'CHECKOUT_UNAVAILABLE'
    });
  }

  let contract;
  try {
    contract = getPaddleCatalogMetadata(process.env)[plan];
  } catch (error) {
    console.error('[payment/checkout] Catalog contract is invalid:', error.message);
    return res.status(503).json({
      success: false,
      error: 'Checkout is temporarily unavailable.',
      code: 'CHECKOUT_UNAVAILABLE'
    });
  }
  if (
    !contract?.priceId
    || !contract?.credits
    || !isMinorUnitAmount(contract?.unitAmount)
    || contract?.currencyCode !== 'USD'
  ) {
    console.error('[payment/checkout] Catalog contract is incomplete for plan=' + plan);
    return res.status(503).json({
      success: false,
      error: 'Checkout is temporarily unavailable.',
      code: 'CHECKOUT_UNAVAILABLE'
    });
  }

  const attemptId = crypto.randomUUID();
  const adminClient = req.paymentAdminClient || makePaymentAdminClient();
  let attempt;
  try {
    attempt = await createSubscriptionCheckoutAttempt(adminClient, {
      attemptId,
      userId: req.user.id,
      plan,
      contract
    });
  } catch (error) {
    console.error('[payment/checkout] Attempt creation failed:', error.message);
    const conflict = /ACTIVE_SUBSCRIPTION|RECONCILIATION|duplicate/i.test(error.message);
    return res.status(conflict ? 409 : 503).json({
      success: false,
      error: conflict
        ? 'An existing subscription or checkout must be reconciled first.'
        : 'Checkout is temporarily unavailable.',
      code: conflict ? 'SUBSCRIPTION_ALREADY_EXISTS' : 'CHECKOUT_UNAVAILABLE'
    });
  }

  if (attempt.reason === 'duplicate_pending') {
    if (attempt.targetPlan !== plan) {
      return res.status(409).json({
        success: false,
        checkoutAttemptId: attempt.attemptId,
        error: 'Another checkout is already in progress.',
        code: 'CHECKOUT_ALREADY_PENDING'
      });
    }
    if (attempt.status === 'bound' && attempt.transactionId) {
      return res.json({
        success: true,
        checkoutAttemptId: attempt.attemptId,
        transactionId: attempt.transactionId
      });
    }
    return res.status(202).json({
      success: true,
      checkoutAttemptId: attempt.attemptId,
      status: attempt.status,
      code: 'CHECKOUT_CONFIRMATION_PENDING'
    });
  }

  const transactionBody = buildSubscriptionCheckoutTransactionBody({
    attemptId,
    plan,
    contract
  });

  let paddleResponse;
  try {
    paddleResponse = await fetch(`${PADDLE_API_BASE}/transactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(transactionBody)
    });
  } catch (error) {
    console.error('[payment/checkout] Paddle transaction outcome is unknown:', error.message);
    await transitionSubscriptionCheckoutAttempt(adminClient, {
      attemptId,
      userId: req.user.id,
      status: 'provider_unknown',
      providerErrorCode: 'network_error'
    }).catch((transitionError) => {
      console.error('[payment/checkout] Could not persist unknown outcome:', transitionError.message);
    });
    return res.status(202).json({
      success: true,
      checkoutAttemptId: attemptId,
      status: 'provider_unknown',
      code: 'CHECKOUT_CONFIRMATION_PENDING'
    });
  }

  if (!paddleResponse.ok) {
    const errorBody = await paddleResponse.text().catch(() => '');
    const providerCode = extractPaddleErrorCode(errorBody)
      || `http_${paddleResponse.status}`;
    const definitive = paddleResponse.status >= 400 && paddleResponse.status < 500;
    console.error(
      '[payment/checkout] Paddle transaction rejected status=' +
      paddleResponse.status + ' code=' + providerCode
    );
    await transitionSubscriptionCheckoutAttempt(adminClient, {
      attemptId,
      userId: req.user.id,
      status: definitive ? 'failed' : 'provider_unknown',
      providerErrorCode: providerCode
    }).catch((transitionError) => {
      console.error('[payment/checkout] Could not persist provider outcome:', transitionError.message);
    });
    return res.status(definitive ? 409 : 202).json({
      success: !definitive,
      checkoutAttemptId: attemptId,
      status: definitive ? 'failed' : 'provider_unknown',
      error: definitive ? 'Checkout was not accepted.' : undefined,
      code: definitive ? 'CHECKOUT_REJECTED' : 'CHECKOUT_CONFIRMATION_PENDING'
    });
  }

  const paddleJson = await paddleResponse.json().catch(() => null);
  const transaction = paddleJson?.data;
  if (!validateCreatedSubscriptionTransaction(transaction, {
    attemptId,
    plan,
    contract
  })) {
    console.error('[payment/checkout] [CRITICAL] Paddle returned an invalid transaction contract');
    await transitionSubscriptionCheckoutAttempt(adminClient, {
      attemptId,
      userId: req.user.id,
      status: 'provider_unknown',
      providerErrorCode: 'invalid_transaction_response'
    }).catch((transitionError) => {
      console.error('[payment/checkout] Could not quarantine invalid transaction:', transitionError.message);
    });
    return res.status(202).json({
      success: true,
      checkoutAttemptId: attemptId,
      status: 'provider_unknown',
      code: 'CHECKOUT_CONFIRMATION_PENDING'
    });
  }

  try {
    await bindSubscriptionCheckoutTransaction(adminClient, {
      attemptId,
      userId: req.user.id,
      transactionId: transaction.id,
      plan,
      contract
    });
  } catch (error) {
    // Never expose an unbound transaction to Checkout. It may exist in Paddle
    // but cannot grant entitlement until an operator reconciles the attempt.
    console.error(
      '[payment/checkout] [CRITICAL] Provider transaction could not be bound:',
      error.message
    );
    await transitionSubscriptionCheckoutAttempt(adminClient, {
      attemptId,
      userId: req.user.id,
      status: 'provider_unknown',
      providerErrorCode: 'binding_failed'
    }).catch(() => {});
    return res.status(202).json({
      success: true,
      checkoutAttemptId: attemptId,
      status: 'provider_unknown',
      code: 'CHECKOUT_CONFIRMATION_PENDING'
    });
  }

  return res.status(201).json({
    success: true,
    checkoutAttemptId: attemptId,
    transactionId: transaction.id
  });
}

router.post('/checkout', authMiddleware, handleSubscriptionCheckout);

/* ── POST /api/payment/cancel ── */
// Generates an authenticated Paddle customer portal session and returns a deep
// link to the cancellation flow. The actual cancellation happens in Paddle's
// hosted portal; we sync state later via the subscription.canceled webhook.
router.post('/cancel', authMiddleware, async (req, res) => {
  res.set('Cache-Control', 'no-store');
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
    const providerCode = extractPaddleErrorCode(body) || 'unknown';
    console.error(
      '[payment/cancel] Paddle portal-session error status=' +
      portalRes.status + ' code=' + providerCode
    );
    return res.status(502).json({ success: false, error: 'Could not create subscription portal session.' });
  }

  const json = await portalRes.json().catch(() => null);
  const url = extractPortalUrl(json, subscriptionId);

  if (!url) {
    console.error('[payment/cancel] Paddle portal-session response did not contain an allowed URL');
    return res.status(502).json({ success: false, error: 'Subscription portal returned no link.' });
  }

  return res.json({ success: true, url });
});

/* ── POST /api/payment/change-plan ── */
// Preview remains read-only. The real prorated mutation is intentionally
// disabled until it has the same request-first, provider_unknown, and webhook
// reconciliation guarantees as subscription checkout and usage add-ons.
//
// body: { plan: 'pro' | 'enterprise', preview?: boolean }
//   preview: true  → PATCH /subscriptions/{id}/preview (no charge; returns proration)
//   preview: false → fail closed; manage the subscription in Paddle's portal
const VALID_PLANS = ['pro', 'enterprise'];

async function handleChangePlan(req, res) {
  res.set?.('Cache-Control', 'no-store');
  const targetPlan = req.body?.plan;
  const isPreview = req.body?.preview === true;

  // Guard 6: target plan must be a known paid plan
  if (!VALID_PLANS.includes(targetPlan)) {
    return res.status(400).json({ success: false, error: 'Invalid plan.', code: 'INVALID_PLAN' });
  }

  if (!isPreview) {
    return res.status(409).json({
      success: false,
      error: 'Plan changes must be completed through subscription management.',
      code: 'PLAN_CHANGE_MUTATION_DISABLED'
    });
  }

  // Read-only preview still requires Paddle access.
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
  const path = `/subscriptions/${subscriptionId}/preview`;

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
    console.error(
      '[payment/change-plan] Paddle preview request failed code=' +
      String(err?.code || err?.name || 'network_error')
    );
    return res.status(502).json({ success: false, error: 'Could not reach subscription provider.' });
  }

  if (!paddleRes.ok) {
    const errBody = await paddleRes.text().catch(() => '');
    const paddleErrorCode = extractPaddleErrorCode(errBody);
    if (paddleRes.status === 403) {
      console.error(
        '[payment/change-plan] [CRITICAL] Paddle preview forbidden status=403 code=' +
        (paddleErrorCode || 'unknown')
      );
    } else {
      console.error(
        '[payment/change-plan] Paddle preview rejected status=' +
        paddleRes.status + ' code=' + (paddleErrorCode || 'unknown')
      );
    }

    // Paddle cancellations are permanent. This exact provider code is the only
    // rejected-change case that may safely offer a brand-new checkout. Keeping
    // all other 4xx responses generic prevents duplicate active subscriptions.
    if (paddleErrorCode === 'subscription_update_when_canceled') {
      return res.status(409).json({
        success: false,
        error: 'Your previous subscription is canceled. Start a new subscription to continue.',
        code: 'SUBSCRIPTION_CANCELED'
      });
    }

    // Money-related: do not leak Paddle internals; our DB is left untouched
    // (plan stays in sync via webhook). All other rejected changes remain
    // provider-agnostic and must not route the user into a new checkout.
    const rejected = [400, 404, 409, 422].includes(paddleRes.status);
    return res.status(502).json({
      success: false,
      error: rejected
        ? 'This subscription cannot be changed right now. Please manage the existing subscription or try again later.'
        : 'Could not change your plan. Please try again later.',
      code: rejected ? 'PADDLE_CHANGE_REJECTED' : 'PADDLE_UNAVAILABLE'
    });
  }

  const json = await paddleRes.json().catch(() => null);
  const preview = sanitizeChangePlanPreview(json?.data);
  if (!preview) {
    console.error('[payment/change-plan] Paddle returned an invalid preview contract');
    return res.status(502).json({
      success: false,
      error: 'Could not calculate the plan change.',
      code: 'INVALID_CHANGE_PREVIEW'
    });
  }

  // Return only display totals. Never expose Paddle's raw customer,
  // transaction, address, business, or provider identifiers to the browser.
  return res.json({ success: true, preview: true, data: preview });
}

router.post('/change-plan', authMiddleware, handleChangePlan);

function creditPackFeatureUnavailable(res) {
  return res.status(404).json({
    success: false,
    error: 'Usage add-ons are not available.',
    code: 'CREDIT_PACKS_UNAVAILABLE'
  });
}

function creditPackResponsePack(pack) {
  return {
    key: pack.key,
    credits: pack.credits,
    priceUsd: pack.priceUsd,
    currencyCode: 'USD'
  };
}

/* ── POST /api/payment/credit-packs/preview ── */
// Calculates tax and the final amount against the authenticated subscriber's
// billing details. No purchase request is created and no money moves.
async function handleCreditPackPreview(req, res) {
  res.set('Cache-Control', 'no-store');

  if (!isCreditPackPurchasesEnabled() || !isCreditLedgerV2Enabled()) {
    return creditPackFeatureUnavailable(res);
  }

  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    console.error('[payment/credit-packs] PADDLE_API_KEY is not configured');
    return res.status(503).json({
      success: false,
      error: 'Usage add-ons are temporarily unavailable.',
      code: 'CREDIT_PACKS_UNAVAILABLE'
    });
  }

  const pack = getCreditPack(req.body?.packKey);
  if (!pack) {
    return res.status(400).json({
      success: false,
      error: 'Invalid usage add-on.',
      code: 'INVALID_CREDIT_PACK'
    });
  }

  let eligibility;
  try {
    eligibility = await loadEligibleCreditPackSubscription(req, apiKey);
  } catch (error) {
    console.error(
      '[payment/credit-packs] Preview eligibility failed userId=' +
      req.user.id + ' code=' + (error.code || 'unknown')
    );
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      code: error.code || 'SUBSCRIPTION_CHECK_FAILED'
    });
  }

  const expiryDays = parseExpiryDays(process.env.CREDIT_PACK_EXPIRY_DAYS);
  const previewBody = buildCreditPackChargeBody({
    pack,
    requestId: crypto.randomUUID(),
    expiryDays,
    taxCategory: process.env.PADDLE_CREDIT_PACK_TAX_CATEGORY
  });

  let preview;
  try {
    preview = await requestCreditPackPreview({
      apiKey,
      subscriptionId: eligibility.subscriptionId,
      customerId: eligibility.customerId,
      pack,
      chargeBody: previewBody
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      success: false,
      error: error.message,
      code: error.code || 'PADDLE_UNAVAILABLE'
    });
  }

  return res.json({
    success: true,
    pack: creditPackResponsePack(pack),
    expiryDays,
    preview
  });
}

/* ── POST /api/payment/credit-packs/purchase ── */
// Dormant by default. The server re-previews the exact tax-inclusive total,
// compares it with the customer's explicit confirmation, records a durable
// request, and only then charges the authenticated active subscription once.
async function handleCreditPackPurchase(req, res) {
  res.set('Cache-Control', 'no-store');

  if (!isCreditPackPurchasesEnabled() || !isCreditLedgerV2Enabled()) {
    return creditPackFeatureUnavailable(res);
  }

  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    console.error('[payment/credit-packs] PADDLE_API_KEY is not configured');
    return res.status(503).json({
      success: false,
      error: 'Usage add-ons are temporarily unavailable.',
      code: 'CREDIT_PACKS_UNAVAILABLE'
    });
  }

  const pack = getCreditPack(req.body?.packKey);
  if (!pack) {
    return res.status(400).json({
      success: false,
      error: 'Invalid usage add-on.',
      code: 'INVALID_CREDIT_PACK'
    });
  }

  const confirmedGrandTotal = req.body?.confirmedGrandTotal;
  const confirmedCurrencyCode = req.body?.confirmedCurrencyCode;
  if (
    !isMinorUnitAmount(confirmedGrandTotal)
    || confirmedCurrencyCode !== 'USD'
  ) {
    return res.status(400).json({
      success: false,
      error: 'A valid billing preview must be confirmed before purchase.',
      code: 'PREVIEW_CONFIRMATION_REQUIRED'
    });
  }

  let eligibility;
  try {
    eligibility = await loadEligibleCreditPackSubscription(req, apiKey);
  } catch (error) {
    console.error(
      '[payment/credit-packs] Eligibility check failed userId=' +
      req.user.id + ' code=' + (error.code || 'unknown')
    );
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      code: error.code || 'SUBSCRIPTION_CHECK_FAILED'
    });
  }
  const { customerId, subscriptionId } = eligibility;

  const requestId = crypto.randomUUID();
  const expiryDays = parseExpiryDays(process.env.CREDIT_PACK_EXPIRY_DAYS);
  const chargeBody = buildCreditPackChargeBody({
    pack,
    requestId,
    expiryDays,
    taxCategory: process.env.PADDLE_CREDIT_PACK_TAX_CATEGORY
  });

  let freshPreview;
  try {
    freshPreview = await requestCreditPackPreview({
      apiKey,
      subscriptionId,
      customerId,
      pack,
      chargeBody
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      success: false,
      error: error.message,
      code: error.code || 'PADDLE_UNAVAILABLE'
    });
  }

  if (
    freshPreview.currencyCode !== confirmedCurrencyCode
    || freshPreview.grandTotal !== confirmedGrandTotal
  ) {
    return res.status(409).json({
      success: false,
      error: 'The final billing total changed. Review the updated total before purchasing.',
      code: 'CREDIT_PACK_TOTAL_CHANGED',
      pack: creditPackResponsePack(pack),
      expiryDays,
      preview: freshPreview
    });
  }

  const adminClient = req.paymentAdminClient || makePaymentAdminClient();
  let requestState;
  try {
    requestState = await createCreditPackPurchaseRequest(adminClient, {
      requestId,
      userId: req.user.id,
      customerId,
      subscriptionId,
      pack,
      expiryDays
    });
  } catch (error) {
    console.error('[payment/credit-packs] Purchase request registration failed:', error.message);
    return res.status(503).json({
      success: false,
      error: 'Could not start the purchase.',
      code: 'PURCHASE_REQUEST_UNAVAILABLE'
    });
  }

  if (requestState.reason === 'duplicate_pending') {
    return res.status(202).json({
      success: true,
      purchaseRequestId: requestState.requestId,
      status: requestState.status,
      code: 'PURCHASE_ALREADY_PENDING',
      pack: creditPackResponsePack({
        key: requestState.packKey,
        credits: requestState.credits,
        priceUsd: requestState.unitAmount / 100
      })
    });
  }

  let chargeResponse;
  try {
    chargeResponse = await fetch(
      `${PADDLE_API_BASE}/subscriptions/${subscriptionId}/charge`,
      {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
        body: JSON.stringify(chargeBody)
      }
    );
  } catch (error) {
    // Paddle does not offer a general idempotency key for this mutation. A
    // network failure is therefore an unknown outcome: never retry the charge
    // automatically. The durable request is reconciled against
    // subscription_charge transactions by its opaque request ID.
    console.error('[payment/credit-packs] Paddle charge outcome is unknown:', error.message);
    await transitionCreditPackPurchaseRequest(adminClient, {
      requestId,
      userId: req.user.id,
      status: 'provider_unknown',
      providerErrorCode: 'network_error'
    }).catch((transitionError) => {
      console.error('[payment/credit-packs] Could not persist unknown outcome:', transitionError.message);
    });
    return res.status(202).json({
      success: true,
      purchaseRequestId: requestId,
      status: 'provider_unknown',
      code: 'PURCHASE_CONFIRMATION_PENDING',
      pack: creditPackResponsePack(pack)
    });
  }

  if (!chargeResponse.ok) {
    const errorBody = await chargeResponse.text().catch(() => '');
    const errorCode = extractPaddleErrorCode(errorBody)
      || `http_${chargeResponse.status}`;
    const definitive = chargeResponse.status >= 400 && chargeResponse.status < 500;
    console.error(
      '[payment/credit-packs] Paddle charge rejected status=' +
      chargeResponse.status + ' code=' + errorCode
    );
    await transitionCreditPackPurchaseRequest(adminClient, {
      requestId,
      userId: req.user.id,
      status: definitive ? 'failed' : 'provider_unknown',
      providerErrorCode: errorCode
    }).catch((transitionError) => {
      console.error('[payment/credit-packs] Could not persist rejected outcome:', transitionError.message);
    });
    return res.status(definitive ? 409 : 202).json({
      success: false,
      purchaseRequestId: requestId,
      error: definitive
        ? 'The add-on charge was not accepted.'
        : 'Purchase confirmation is pending.',
      code: definitive ? 'CREDIT_PACK_CHARGE_REJECTED' : 'PURCHASE_CONFIRMATION_PENDING'
    });
  }

  const chargeJson = await chargeResponse.json().catch(() => null);
  const chargedSubscription = chargeJson?.data;
  if (!validateCreditPackChargeResponse(chargedSubscription, {
    customerId,
    subscriptionId
  })) {
    console.error('[payment/credit-packs] Paddle returned an invalid charge response');
    await transitionCreditPackPurchaseRequest(adminClient, {
      requestId,
      userId: req.user.id,
      status: 'provider_unknown',
      providerErrorCode: 'invalid_charge_response'
    }).catch((transitionError) => {
      console.error('[payment/credit-packs] Could not persist invalid response:', transitionError.message);
    });
    return res.status(202).json({
      success: true,
      purchaseRequestId: requestId,
      status: 'provider_unknown',
      code: 'PURCHASE_CONFIRMATION_PENDING',
      pack: creditPackResponsePack(pack)
    });
  }

  try {
    await transitionCreditPackPurchaseRequest(adminClient, {
      requestId,
      userId: req.user.id,
      status: 'submitted'
    });
  } catch (error) {
    // The charge may already be completed. Keep the original request ID and
    // let the signed webhook/reconciler bind it; never issue a second charge.
    console.error('[payment/credit-packs] Charge accepted but state transition failed:', error.message);
  }

  return res.status(202).json({
    success: true,
    purchaseRequestId: requestId,
    status: 'submitted',
    pack: creditPackResponsePack(pack)
  });
}

function creditPackPurchaseStatusPayload(data) {
  return {
    purchaseRequestId: data.request_id,
    status: data.status,
    pack: {
      key: data.pack_key,
      credits: data.credits,
      priceUsd: data.unit_amount / 100,
      currencyCode: data.currency_code
    },
    createdAt: data.created_at,
    completedAt: data.completed_at
  };
}

/* ── GET /api/payment/credit-packs/purchase/pending ── */
// Recovers a request even when the charge response was lost before the browser
// learned its opaque ID. This endpoint is owner-scoped and returns only the
// newest non-terminal request, never provider identifiers or diagnostics.
async function handlePendingCreditPackPurchase(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!isCreditPackPurchasesEnabled() || !isCreditLedgerV2Enabled()) {
    return creditPackFeatureUnavailable(res);
  }

  const adminClient = req.paymentAdminClient || makePaymentAdminClient();
  const { data, error } = await adminClient
    .from('credit_pack_purchase_requests')
    .select(
      'request_id, status, pack_key, credits, unit_amount, currency_code, created_at, completed_at'
    )
    .eq('user_id', req.user.id)
    .in('status', ['created', 'submitted', 'provider_unknown'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[payment/credit-packs] Purchase status lookup failed:', error.message);
    return res.status(503).json({
      success: false,
      error: 'Could not check the purchase status.',
      code: 'PURCHASE_STATUS_UNAVAILABLE'
    });
  }

  return res.json({
    success: true,
    purchase: data ? creditPackPurchaseStatusPayload(data) : null
  });
}

/* ── GET /api/payment/credit-packs/purchase/:requestId ── */
// Reload-safe, server-authoritative state. The browser never receives Paddle
// IDs or provider diagnostics and cannot read another user's request.
async function handleCreditPackPurchaseStatus(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!isCreditPackPurchasesEnabled() || !isCreditLedgerV2Enabled()) {
    return creditPackFeatureUnavailable(res);
  }

  const requestId = String(req.params?.requestId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid purchase request.',
      code: 'INVALID_PURCHASE_REQUEST'
    });
  }

  const adminClient = req.paymentAdminClient || makePaymentAdminClient();
  const { data, error } = await adminClient
    .from('credit_pack_purchase_requests')
    .select(
      'request_id, status, pack_key, credits, unit_amount, currency_code, created_at, completed_at'
    )
    .eq('request_id', requestId)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error) {
    console.error('[payment/credit-packs] Purchase status lookup failed:', error.message);
    return res.status(503).json({
      success: false,
      error: 'Could not check the purchase status.',
      code: 'PURCHASE_STATUS_UNAVAILABLE'
    });
  }
  if (!data) {
    return res.status(404).json({
      success: false,
      error: 'Purchase request not found.',
      code: 'PURCHASE_REQUEST_NOT_FOUND'
    });
  }

  return res.json({
    success: true,
    ...creditPackPurchaseStatusPayload(data)
  });
}

router.post('/credit-packs/preview', authMiddleware, handleCreditPackPreview);
router.post('/credit-packs/purchase', authMiddleware, handleCreditPackPurchase);
router.get(
  '/credit-packs/purchase/pending',
  authMiddleware,
  handlePendingCreditPackPurchase
);
router.get(
  '/credit-packs/purchase/:requestId',
  authMiddleware,
  handleCreditPackPurchaseStatus
);

module.exports = router;
module.exports.extractPortalUrl = extractPortalUrl;
module.exports.planToPriceId = planToPriceId;
module.exports.buildSubscriptionCheckoutTransactionBody =
  buildSubscriptionCheckoutTransactionBody;
module.exports.validateCreatedSubscriptionTransaction =
  validateCreatedSubscriptionTransaction;
module.exports.handleSubscriptionCheckout = handleSubscriptionCheckout;
module.exports.createSubscriptionCheckoutAttempt =
  createSubscriptionCheckoutAttempt;
module.exports.bindSubscriptionCheckoutTransaction =
  bindSubscriptionCheckoutTransaction;
module.exports.transitionSubscriptionCheckoutAttempt =
  transitionSubscriptionCheckoutAttempt;
module.exports.buildSubscriptionUpdateBody = buildSubscriptionUpdateBody;
module.exports.extractPaddleErrorCode = extractPaddleErrorCode;
module.exports.sanitizeChangePlanPreview = sanitizeChangePlanPreview;
module.exports.handleChangePlan = handleChangePlan;
module.exports.normalizePaidPlan = normalizePaidPlan;
module.exports.buildCreditPackChargeBody = buildCreditPackChargeBody;
module.exports.validateCreditPackChargeResponse = validateCreditPackChargeResponse;
module.exports.parseCreditPackPreviewResponse = parseCreditPackPreviewResponse;
module.exports.handleCreditPackPreview = handleCreditPackPreview;
module.exports.handleCreditPackPurchase = handleCreditPackPurchase;
module.exports.handlePendingCreditPackPurchase = handlePendingCreditPackPurchase;
module.exports.handleCreditPackPurchaseStatus = handleCreditPackPurchaseStatus;
module.exports.createCreditPackPurchaseRequest = createCreditPackPurchaseRequest;
module.exports.transitionCreditPackPurchaseRequest = transitionCreditPackPurchaseRequest;
