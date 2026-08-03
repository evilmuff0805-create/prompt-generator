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
const { parsePaddleTimestamp } = require('../lib/paddle-time');
const {
  getPaddleApiBase,
  PADDLE_SANDBOX_API_BASE
} = require('../lib/paddle-api');
const {
  MAX_POSTGRES_INTEGER,
  isPostgresMinorUnitAmount
} = require('../lib/paddle-money');

const PADDLE_API_BASE = getPaddleApiBase(process.env);
const PADDLE_READ_TIMEOUT_MS = 8000;
const PADDLE_CHARGE_TIMEOUT_MS = 15000;
const CREDIT_PACK_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDIT_PACK_TERMINAL_RECOVERY_WINDOW_MS = 60 * 60 * 1000;

function isSandboxSubscriptionCheckoutConfirmed(env = process.env) {
  return getPaddleApiBase(env) !== PADDLE_SANDBOX_API_BASE
    || String(env.PADDLE_SANDBOX_CHECKOUT_CONFIRMED || '').trim().toLowerCase() === 'true';
}

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

function approvedCreditPackPreviewAmounts(approvedPreview) {
  const approvedAmounts = parseMinorUnitAmountRecord(approvedPreview, [
    'subtotal',
    'discount',
    'tax',
    'total',
    'credit',
    'balance',
    'grandTotal',
    'grandTotalTax'
  ]);
  if (!approvedAmounts) {
    throw new Error('Approved Paddle preview totals are invalid');
  }
  return approvedAmounts;
}

async function beginCreditPackPurchasePreview(supabase, {
  requestId,
  userId,
  customerId,
  subscriptionId,
  pack,
  expiryDays,
  providerSubscriptionUpdatedAt,
  providerPlanPriceId,
  eligibilityCheckStartedAt
}) {
  const { data, error } = await supabase.rpc('begin_credit_pack_purchase_preview', {
    p_request_id: requestId,
    p_user_id: userId,
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
    p_pack_key: pack.key,
    p_credits: pack.credits,
    p_unit_amount: pack.priceCents,
    p_currency_code: 'USD',
    p_expiry_days: expiryDays,
    p_provider_subscription_updated_at: providerSubscriptionUpdatedAt,
    p_provider_plan_price_id: providerPlanPriceId,
    p_eligibility_check_started_at: eligibilityCheckStartedAt
  });

  if (error) {
    throw new Error('begin_credit_pack_purchase_preview RPC failed: ' + error.message);
  }
  const validOutcome = data && (
    (
      data.applied === true
      && data.reason === 'purchase_preview_reserved'
      && data.status === 'previewing'
      && data.confirmationVersion === 0
    )
    || (
      data.applied === false
      && data.reason === 'duplicate_pending'
      && [
        'previewing',
        'created',
        'charging',
        'submitted',
        'provider_unknown'
      ].includes(data.status)
    )
    || (
      data.applied === false
      && data.reason === 'purchase_review_required'
      && data.status === 'withheld'
    )
  );
  const validRequestReference =
    data.reason === 'purchase_review_required'
      ? data.requestId == null || isCreditPackRequestId(data.requestId)
      : isCreditPackRequestId(data.requestId);
  if (!validOutcome || !validRequestReference) {
    throw new Error('begin_credit_pack_purchase_preview returned an invalid outcome');
  }
  return data;
}

async function finalizeCreditPackPurchasePreview(supabase, {
  requestId,
  userId,
  expectedConfirmationVersion,
  approvedPreview,
  providerApiRequestId
}) {
  const approvedAmounts = approvedCreditPackPreviewAmounts(approvedPreview);
  const { data, error } = await supabase.rpc(
    'finalize_credit_pack_purchase_preview',
    {
      p_request_id: requestId,
      p_user_id: userId,
      p_expected_confirmation_version: expectedConfirmationVersion,
      p_approved_subtotal: approvedAmounts.subtotal,
      p_approved_discount: approvedAmounts.discount,
      p_approved_tax: approvedAmounts.tax,
      p_approved_total: approvedAmounts.total,
      p_approved_credit: approvedAmounts.credit,
      p_approved_balance: approvedAmounts.balance,
      p_approved_grand_total: approvedAmounts.grandTotal,
      p_approved_grand_total_tax: approvedAmounts.grandTotalTax,
      p_provider_api_request_id: providerApiRequestId
    }
  );

  if (error) {
    throw new Error('finalize_credit_pack_purchase_preview RPC failed: ' + error.message);
  }
  const validOutcome = data && (
    (
      data.applied === true
      && [
        'purchase_preview_finalized',
        'purchase_confirmation_refreshed'
      ].includes(data.reason)
      && data.status === 'created'
      && Number.isInteger(data.confirmationVersion)
      && data.confirmationVersion >= 1
    )
    || (
      data.applied === false
      && [
        'duplicate_or_ambiguous',
        'already_finalized',
        'authorization_expired',
        'confirmation_version_mismatch'
      ].includes(data.reason)
      && typeof data.status === 'string'
    )
  );
  if (!validOutcome || data.requestId !== requestId) {
    throw new Error('finalize_credit_pack_purchase_preview returned an invalid outcome');
  }
  return data;
}

async function claimCreditPackPurchaseRequest(supabase, {
  requestId,
  userId,
  customerId,
  subscriptionId,
  packKey,
  expectedConfirmationVersion
}) {
  const { data, error } = await supabase.rpc(
    'claim_credit_pack_purchase_request',
    {
      p_request_id: requestId,
      p_user_id: userId,
      p_customer_id: customerId,
      p_subscription_id: subscriptionId,
      p_pack_key: packKey,
      p_expected_confirmation_version: expectedConfirmationVersion
    }
  );
  if (error) {
    throw new Error('claim_credit_pack_purchase_request RPC failed: ' + error.message);
  }
  const validOutcome = data && (
    (
      data.applied === true
      && data.reason === 'purchase_request_claimed'
      && data.status === 'charging'
    )
    || (
      data.applied === false
      && [
        'duplicate_or_ambiguous',
        'already_finalized',
        'authorization_expired',
        'confirmation_version_mismatch',
        'purchase_review_required',
        'subscription_reconfirmation_required'
      ].includes(data.reason)
      && typeof data.status === 'string'
      && (
        ![
          'purchase_review_required',
          'subscription_reconfirmation_required'
        ].includes(data.reason)
        || (
          data.status === 'created'
          && data.cancellable === true
          && data.cancelReason === 'confirmation_rejected'
        )
      )
    )
  );
  if (!validOutcome || data.requestId !== requestId) {
    throw new Error('claim_credit_pack_purchase_request returned an invalid outcome');
  }
  return data;
}

async function cancelCreditPackPurchaseRequest(supabase, {
  requestId,
  userId,
  reason
}) {
  const { data, error } = await supabase.rpc(
    'cancel_credit_pack_purchase_request',
    {
      p_request_id: requestId,
      p_user_id: userId,
      p_reason: reason
    }
  );
  if (error) {
    throw new Error('cancel_credit_pack_purchase_request RPC failed: ' + error.message);
  }
  if (
    !data
    || data.requestId !== requestId
    || ![
      'purchase_request_cancelled',
      'reconciliation_required',
      'already_finalized',
      'duplicate'
    ].includes(data.reason)
    || typeof data.status !== 'string'
  ) {
    throw new Error('cancel_credit_pack_purchase_request returned an invalid outcome');
  }
  return data;
}

async function expireCreditPackPurchaseRequest(supabase, {
  requestId,
  userId
}) {
  const { data, error } = await supabase.rpc(
    'expire_credit_pack_purchase_request',
    {
      p_request_id: requestId,
      p_user_id: userId
    }
  );
  if (error) {
    throw new Error('expire_credit_pack_purchase_request RPC failed: ' + error.message);
  }
  if (
    !data
    || data.requestId !== requestId
    || ![
      'purchase_request_expired',
      'authorization_active',
      'reconciliation_required',
      'already_finalized',
      'duplicate'
    ].includes(data.reason)
    || typeof data.status !== 'string'
  ) {
    throw new Error('expire_credit_pack_purchase_request returned an invalid outcome');
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
  return isPostgresMinorUnitAmount(value);
}

function parseMinorUnitAmountRecord(source, names) {
  if (!source || !Array.isArray(names)) return null;
  const parsed = {};
  for (const name of names) {
    if (!isMinorUnitAmount(source[name])) return null;
    parsed[name] = Number(source[name]);
  }
  return parsed;
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
  const parsedTotals = parseMinorUnitAmountRecord(totals, [
    'subtotal',
    'discount',
    'tax',
    'total',
    'credit',
    'balance',
    'grand_total',
    'grand_total_tax'
  ]);
  const subtotalPlusTax = parsedTotals
    ? parsedTotals.subtotal + parsedTotals.tax
    : null;

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
    && parsedTotals
    && totals.subtotal === expectedSubtotal
    && subtotalPlusTax <= MAX_POSTGRES_INTEGER
    && parsedTotals.discount === 0
    && parsedTotals.credit === 0
    && parsedTotals.total === subtotalPlusTax
    && parsedTotals.grand_total === parsedTotals.total
    && parsedTotals.balance === parsedTotals.grand_total
    && parsedTotals.grand_total_tax === parsedTotals.tax;

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

  const eligibilityCheckStartedAt = new Date().toISOString();
  let subscriptionResponse;
  try {
    subscriptionResponse = await fetch(`${PADDLE_API_BASE}/subscriptions/${subscriptionId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(PADDLE_READ_TIMEOUT_MS)
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
  const providerSubscriptionUpdatedAt = parsePaddleTimestamp(
    subscription?.updated_at
  );
  const providerApiRequestId =
    typeof subscriptionJson?.meta?.request_id === 'string'
      ? subscriptionJson.meta.request_id.trim()
      : '';
  const hasSinglePlanItem = Array.isArray(subscription?.items)
    && subscription.items.length === 1
    && subscription.items[0]?.quantity === 1
    && subscription.items[0]?.status === 'active'
    && subscription.items[0]?.recurring === true;
  const subscriptionPlan = hasSinglePlanItem
    ? getPlanForPaddlePriceId(subscription.items[0]?.price?.id)
    : null;
  const subscriptionEligible = subscription?.id === subscriptionId
    && subscription?.status === 'active'
    && subscription?.collection_mode === 'automatic'
    && subscription?.currency_code === 'USD'
    && subscription?.scheduled_change == null
    && subscription?.customer_id === customerId
    && subscriptionPlan === expectedPlan
    && providerSubscriptionUpdatedAt
    && providerApiRequestId
    && providerApiRequestId.length <= 255;

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
    subscription,
    providerSubscriptionUpdatedAt,
    providerApiRequestId,
    providerPlanPriceId: subscription.items[0].price.id,
    eligibilityCheckStartedAt
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
        body: JSON.stringify(chargeBody),
        signal: AbortSignal.timeout(PADDLE_READ_TIMEOUT_MS)
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
  const providerApiRequestId =
    typeof previewJson?.meta?.request_id === 'string'
      ? previewJson.meta.request_id.trim()
      : '';
  const preview = parseCreditPackPreviewResponse(previewJson?.data, {
    customerId,
    subscriptionId,
    pack
  });
  if (
    !preview
    || !providerApiRequestId
    || providerApiRequestId.length > 255
  ) {
    throw creditPackHttpError(
      502,
      'INVALID_PADDLE_PREVIEW',
      'The billing provider returned an invalid add-on total.'
    );
  }
  return { preview, providerApiRequestId };
}

/* ── Build the Paddle subscription-update request body ── */
// Paddle requires the COMPLETE items list — omitted items are removed. Our
// subscriptions carry a single plan item, so the full list is just this one.
// Credits are NOT touched here; the ordered subscription snapshot reducer is
// the single lifecycle source for plan and credit changes.
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
  if (!isSandboxSubscriptionCheckoutConfirmed(process.env)) {
    return res.status(503).json({
      success: false,
      error: 'Checkout is temporarily unavailable.',
      code: 'SANDBOX_CHECKOUT_NOT_CONFIRMED'
    });
  }
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
    code: 'CREDIT_PACKS_UNAVAILABLE',
    chargeMayHaveRun: false
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

function isCreditPackRequestId(value) {
  return typeof value === 'string'
    && CREDIT_PACK_REQUEST_ID_PATTERN.test(value);
}

function isRecoverableCreditPackPurchase(data, nowMs = Date.now()) {
  if (!data) return false;
  if (data.review_required === true) {
    return true;
  }
  if (
    [
      'previewing',
      'created',
      'charging',
      'submitted',
      'provider_unknown',
      'withheld',
      'chargeback'
    ]
      .includes(data.status)
  ) {
    return true;
  }
  if (!['completed', 'refunded', 'failed'].includes(data.status)) {
    return false;
  }

  const terminalTimestamp = data.status === 'failed'
    ? data.reconciliation_closed_at || data.created_at
    : data.completed_at;
  const terminalAtMs = Date.parse(terminalTimestamp);
  return Number.isFinite(terminalAtMs)
    && terminalAtMs >= nowMs - CREDIT_PACK_TERMINAL_RECOVERY_WINDOW_MS;
}

function creditPackStatePack(state) {
  return creditPackResponsePack({
    key: state.packKey,
    credits: state.credits,
    priceUsd: state.unitAmount / 100
  });
}

function creditPackStateMayHaveCharged(status) {
  return [
    'charging',
    'submitted',
    'provider_unknown',
    'completed',
    'withheld',
    'refunded',
    'chargeback'
  ].includes(status);
}

function sendCreditPackPendingResponse(res, state, options = {}) {
  const isReview = state.status === 'withheld';
  const code = options.code || (
    isReview ? 'PURCHASE_REVIEW_REQUIRED' : 'PURCHASE_ALREADY_PENDING'
  );
  const success = options.success ?? !isReview;
  const body = {
    success,
    purchaseRequestId: state.requestId,
    status: state.status,
    code
  };
  if (state.packKey && state.credits && state.unitAmount) {
    body.pack = creditPackStatePack(state);
  }
  if (Number.isInteger(state.confirmationVersion)) {
    body.confirmationVersion = state.confirmationVersion;
  }
  if (creditPackStateMayHaveCharged(state.status)) {
    body.chargeMayHaveRun = true;
  }
  return res.status(state.status === 'withheld' ? 409 : 202).json(body);
}

async function respondAfterUnchargedCreditPackFailure(res, {
  adminClient,
  userId,
  requestId,
  cancellationReason,
  statusCode,
  error,
  code
}) {
  let cancellation;
  try {
    cancellation = await cancelCreditPackPurchaseRequest(adminClient, {
      requestId,
      userId,
      reason: cancellationReason
    });
  } catch (cancellationError) {
    console.error(
      '[payment/credit-packs] Could not confirm uncharged request cancellation:',
      cancellationError.message
    );
  }

  if (cancellation?.status === 'failed') {
    return res.status(statusCode).json({
      success: false,
      purchaseRequestId: requestId,
      status: 'failed',
      error,
      code,
      chargeMayHaveRun: false
    });
  }

  if (cancellation && creditPackStateMayHaveCharged(cancellation.status)) {
    return sendCreditPackPendingResponse(res, cancellation, {
      code: 'PURCHASE_CONFIRMATION_PENDING'
    });
  }

  return res.status(503).json({
    success: false,
    purchaseRequestId: requestId,
    status: cancellation?.status || 'unknown',
    error: 'Could not confirm the uncharged purchase request was released.',
    code: 'PURCHASE_RECOVERY_REQUIRED'
  });
}

/* ── POST /api/payment/credit-packs/preview ── */
// Reserves one owner-scoped request before Paddle calculates tax. The
// reservation closes the cross-tab race while keeping money movement
// impossible until a later, exact-version purchase claim.
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
      code: 'CREDIT_PACKS_UNAVAILABLE',
      chargeMayHaveRun: false
    });
  }

  const pack = getCreditPack(req.body?.packKey);
  if (!pack) {
    return res.status(400).json({
      success: false,
      error: 'Invalid usage add-on.',
      code: 'INVALID_CREDIT_PACK',
      chargeMayHaveRun: false
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
      code: error.code || 'SUBSCRIPTION_CHECK_FAILED',
      chargeMayHaveRun: false
    });
  }

  const requestId = crypto.randomUUID();
  const expiryDays = parseExpiryDays(process.env.CREDIT_PACK_EXPIRY_DAYS);
  const adminClient = req.paymentAdminClient || makePaymentAdminClient();
  let requestState;
  try {
    requestState = await beginCreditPackPurchasePreview(adminClient, {
      requestId,
      userId: req.user.id,
      customerId: eligibility.customerId,
      subscriptionId: eligibility.subscriptionId,
      pack,
      expiryDays,
      providerSubscriptionUpdatedAt:
        eligibility.providerSubscriptionUpdatedAt,
      providerPlanPriceId: eligibility.providerPlanPriceId,
      eligibilityCheckStartedAt: eligibility.eligibilityCheckStartedAt
    });
  } catch (error) {
    console.error(
      '[payment/credit-packs] Preview reservation failed:',
      error.message
    );
    return res.status(503).json({
      success: false,
      purchaseRequestId: requestId,
      status: 'unknown',
      error: 'Could not reserve the billing preview.',
      code: 'PURCHASE_REQUEST_UNAVAILABLE',
      chargeMayHaveRun: false
    });
  }

  if (requestState.reason === 'purchase_review_required') {
    return sendCreditPackPendingResponse(res, requestState, {
      code: 'PURCHASE_REVIEW_REQUIRED',
      success: false
    });
  }
  if (requestState.reason === 'duplicate_pending') {
    return sendCreditPackPendingResponse(res, requestState);
  }

  let previewBody;
  try {
    previewBody = buildCreditPackChargeBody({
      pack,
      requestId,
      expiryDays,
      taxCategory: process.env.PADDLE_CREDIT_PACK_TAX_CATEGORY
    });
  } catch (error) {
    console.error(
      '[payment/credit-packs] Preview configuration is invalid:',
      error.message
    );
    return respondAfterUnchargedCreditPackFailure(res, {
      adminClient,
      userId: req.user.id,
      requestId,
      cancellationReason: 'preview_unavailable',
      statusCode: 503,
      error: 'Usage add-ons are temporarily unavailable.',
      code: error.code || 'CREDIT_PACK_CONFIGURATION_INVALID'
    });
  }

  let providerPreview;
  try {
    providerPreview = await requestCreditPackPreview({
      apiKey,
      subscriptionId: eligibility.subscriptionId,
      customerId: eligibility.customerId,
      pack,
      chargeBody: previewBody
    });
  } catch (error) {
    return respondAfterUnchargedCreditPackFailure(res, {
      adminClient,
      userId: req.user.id,
      requestId,
      cancellationReason: 'preview_failed',
      statusCode: error.statusCode || 502,
      error: error.message,
      code: error.code || 'PADDLE_UNAVAILABLE'
    });
  }

  let finalized;
  try {
    finalized = await finalizeCreditPackPurchasePreview(adminClient, {
      requestId,
      userId: req.user.id,
      expectedConfirmationVersion: 0,
      approvedPreview: providerPreview.preview,
      providerApiRequestId: providerPreview.providerApiRequestId
    });
  } catch (error) {
    console.error(
      '[payment/credit-packs] Preview finalization failed:',
      error.message
    );
    return respondAfterUnchargedCreditPackFailure(res, {
      adminClient,
      userId: req.user.id,
      requestId,
      cancellationReason: 'preview_unavailable',
      statusCode: 503,
      error: 'Could not finalize the billing preview.',
      code: 'PURCHASE_REQUEST_UNAVAILABLE'
    });
  }
  if (finalized.applied !== true) {
    if (finalized.reason === 'authorization_expired') {
      return respondAfterUnchargedCreditPackFailure(res, {
        adminClient,
        userId: req.user.id,
        requestId,
        cancellationReason: 'confirmation_rejected',
        statusCode: 409,
        error: 'The billing preview expired.',
        code: 'CREDIT_PACK_PREVIEW_EXPIRED'
      });
    }
    return sendCreditPackPendingResponse(res, finalized);
  }

  return res.json({
    success: true,
    purchaseRequestId: requestId,
    status: 'created',
    confirmationVersion: finalized.confirmationVersion,
    pack: creditPackResponsePack(pack),
    expiryDays,
    authorizationExpiresAt: finalized.authorizationExpiresAt,
    preview: providerPreview.preview
  });
}

/* ── POST /api/payment/credit-packs/purchase ── */
// Dormant by default. The server re-previews the exact tax-inclusive total,
// compares it with the customer's explicit confirmation, atomically claims
// the reserved request, and only then charges the active subscription once.
async function handleCreditPackPurchase(req, res) {
  res.set('Cache-Control', 'no-store');

  const requestId = req.body?.purchaseRequestId;
  const adminClient = req.paymentAdminClient || (
    isCreditPackRequestId(requestId) && isCreditLedgerV2Enabled()
      ? makePaymentAdminClient()
      : null
  );

  if (!isCreditPackPurchasesEnabled() || !isCreditLedgerV2Enabled()) {
    if (adminClient && isCreditPackRequestId(requestId)) {
      return respondAfterUnchargedCreditPackFailure(res, {
        adminClient,
        userId: req.user.id,
        requestId,
        cancellationReason: 'confirmation_rejected',
        statusCode: 404,
        error: 'Usage add-ons are not available.',
        code: 'CREDIT_PACKS_UNAVAILABLE'
      });
    }
    return creditPackFeatureUnavailable(res);
  }

  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    console.error('[payment/credit-packs] PADDLE_API_KEY is not configured');
    if (adminClient && isCreditPackRequestId(requestId)) {
      return respondAfterUnchargedCreditPackFailure(res, {
        adminClient,
        userId: req.user.id,
        requestId,
        cancellationReason: 'preview_unavailable',
        statusCode: 503,
        error: 'Usage add-ons are temporarily unavailable.',
        code: 'CREDIT_PACKS_UNAVAILABLE'
      });
    }
    return res.status(503).json({
      success: false,
      error: 'Usage add-ons are temporarily unavailable.',
      code: 'CREDIT_PACKS_UNAVAILABLE',
      chargeMayHaveRun: false
    });
  }

  const pack = getCreditPack(req.body?.packKey);
  if (!pack) {
    if (adminClient && isCreditPackRequestId(requestId)) {
      return respondAfterUnchargedCreditPackFailure(res, {
        adminClient,
        userId: req.user.id,
        requestId,
        cancellationReason: 'confirmation_rejected',
        statusCode: 400,
        error: 'Invalid usage add-on.',
        code: 'INVALID_CREDIT_PACK'
      });
    }
    return res.status(400).json({
      success: false,
      error: 'Invalid usage add-on.',
      code: 'INVALID_CREDIT_PACK',
      chargeMayHaveRun: false
    });
  }

  const confirmedGrandTotal = req.body?.confirmedGrandTotal;
  const confirmedCurrencyCode = req.body?.confirmedCurrencyCode;
  const confirmationVersion = req.body?.confirmationVersion;
  if (
    !isMinorUnitAmount(confirmedGrandTotal)
    || confirmedCurrencyCode !== 'USD'
    || !isCreditPackRequestId(requestId)
    || !Number.isInteger(confirmationVersion)
    || confirmationVersion < 1
    || confirmationVersion > MAX_POSTGRES_INTEGER
  ) {
    if (adminClient && isCreditPackRequestId(requestId)) {
      return respondAfterUnchargedCreditPackFailure(res, {
        adminClient,
        userId: req.user.id,
        requestId,
        cancellationReason: 'confirmation_rejected',
        statusCode: 400,
        error: 'A valid billing preview must be confirmed before purchase.',
        code: 'PREVIEW_CONFIRMATION_REQUIRED'
      });
    }
    return res.status(400).json({
      success: false,
      error: 'A valid billing preview must be confirmed before purchase.',
      code: 'PREVIEW_CONFIRMATION_REQUIRED',
      chargeMayHaveRun: false
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
    return respondAfterUnchargedCreditPackFailure(res, {
      adminClient,
      userId: req.user.id,
      requestId,
      cancellationReason: 'confirmation_rejected',
      statusCode: error.statusCode || 500,
      error: error.message,
      code: error.code || 'SUBSCRIPTION_CHECK_FAILED'
    });
  }
  const { customerId, subscriptionId } = eligibility;

  const expiryDays = parseExpiryDays(process.env.CREDIT_PACK_EXPIRY_DAYS);
  let chargeBody;
  try {
    chargeBody = buildCreditPackChargeBody({
      pack,
      requestId,
      expiryDays,
      taxCategory: process.env.PADDLE_CREDIT_PACK_TAX_CATEGORY
    });
  } catch (error) {
    console.error(
      '[payment/credit-packs] Purchase configuration is invalid:',
      error.message
    );
    return respondAfterUnchargedCreditPackFailure(res, {
      adminClient,
      userId: req.user.id,
      requestId,
      cancellationReason: 'preview_unavailable',
      statusCode: 503,
      error: 'Usage add-ons are temporarily unavailable.',
      code: error.code || 'CREDIT_PACK_CONFIGURATION_INVALID'
    });
  }

  let providerPreview;
  try {
    providerPreview = await requestCreditPackPreview({
      apiKey,
      subscriptionId,
      customerId,
      pack,
      chargeBody
    });
  } catch (error) {
    return respondAfterUnchargedCreditPackFailure(res, {
      adminClient,
      userId: req.user.id,
      requestId,
      cancellationReason: 'preview_failed',
      statusCode: error.statusCode || 502,
      error: error.message,
      code: error.code || 'PADDLE_UNAVAILABLE'
    });
  }
  const freshPreview = providerPreview.preview;

  if (
    freshPreview.currencyCode !== confirmedCurrencyCode
    || freshPreview.grandTotal !== confirmedGrandTotal
  ) {
    let refreshed;
    try {
      refreshed = await finalizeCreditPackPurchasePreview(adminClient, {
        requestId,
        userId: req.user.id,
        expectedConfirmationVersion: confirmationVersion,
        approvedPreview: freshPreview,
        providerApiRequestId: providerPreview.providerApiRequestId
      });
    } catch (error) {
      console.error(
        '[payment/credit-packs] Changed-total finalization failed:',
        error.message
      );
      return res.status(503).json({
        success: false,
        purchaseRequestId: requestId,
        status: 'created',
        error: 'Could not save the updated billing preview.',
        code: 'PURCHASE_RECOVERY_REQUIRED'
      });
    }
    if (refreshed.applied !== true) {
      if (refreshed.reason === 'authorization_expired') {
        return respondAfterUnchargedCreditPackFailure(res, {
          adminClient,
          userId: req.user.id,
          requestId,
          cancellationReason: 'confirmation_rejected',
          statusCode: 409,
          error: 'The billing preview expired.',
          code: 'CREDIT_PACK_PREVIEW_EXPIRED'
        });
      }
      return sendCreditPackPendingResponse(res, refreshed);
    }
    return res.status(409).json({
      success: false,
      error: 'The final billing total changed. Review the updated total before purchasing.',
      code: 'CREDIT_PACK_TOTAL_CHANGED',
      chargeMayHaveRun: false,
      purchaseRequestId: requestId,
      status: 'created',
      confirmationVersion: refreshed.confirmationVersion,
      pack: creditPackResponsePack(pack),
      expiryDays,
      authorizationExpiresAt: refreshed.authorizationExpiresAt,
      preview: freshPreview
    });
  }

  let claimState;
  try {
    claimState = await claimCreditPackPurchaseRequest(adminClient, {
      requestId,
      userId: req.user.id,
      customerId,
      subscriptionId,
      packKey: pack.key,
      expectedConfirmationVersion: confirmationVersion
    });
  } catch (error) {
    // The claim RPC may have committed even when its response was lost. Since
    // charging is the point of no automatic retry, never call Paddle here.
    console.error('[payment/credit-packs] Purchase claim outcome is unknown:', error.message);
    return res.status(202).json({
      success: true,
      purchaseRequestId: requestId,
      status: 'charging',
      code: 'PURCHASE_CONFIRMATION_PENDING',
      chargeMayHaveRun: true,
      pack: creditPackResponsePack(pack)
    });
  }

  if (claimState.applied !== true) {
    if (claimState.reason === 'authorization_expired') {
      let expired;
      try {
        expired = await expireCreditPackPurchaseRequest(adminClient, {
          requestId,
          userId: req.user.id
        });
      } catch (error) {
        console.error(
          '[payment/credit-packs] Expired authorization could not be closed:',
          error.message
        );
      }
      if (expired?.status === 'failed') {
        return res.status(409).json({
          success: false,
          purchaseRequestId: requestId,
          status: 'failed',
          error: 'The billing preview expired.',
          code: 'CREDIT_PACK_PREVIEW_EXPIRED',
          chargeMayHaveRun: false
        });
      }
      return res.status(503).json({
        success: false,
        purchaseRequestId: requestId,
        status: expired?.status || claimState.status,
        error: 'Could not close the expired billing preview.',
        code: 'PURCHASE_RECOVERY_REQUIRED'
      });
    }
    if (claimState.reason === 'confirmation_version_mismatch') {
      let recoveryRow = null;
      try {
        const recoveryResult = await loadOwnerCreditPackPurchaseData(
          adminClient,
          req.user.id,
          requestId
        );
        if (recoveryResult.error) {
          throw new Error(recoveryResult.error.message);
        }
        recoveryRow = await expireCreditPackAuthorizationIfNeeded(
          adminClient,
          req.user.id,
          recoveryResult.data
        );
      } catch (error) {
        console.error(
          '[payment/credit-packs] Changed confirmation recovery failed:',
          error.message
        );
      }
      if (recoveryRow?.status === 'created') {
        return res.status(409).json({
          success: false,
          ...creditPackPurchaseStatusPayload(recoveryRow),
          error: 'The billing total changed. Review it again before purchasing.',
          code: 'CREDIT_PACK_TOTAL_CHANGED',
          chargeMayHaveRun: false
        });
      }
      return res.status(409).json({
        success: false,
        purchaseRequestId: requestId,
        status: recoveryRow?.status || claimState.status,
        error: 'Could not recover the updated billing confirmation.',
        code: 'PURCHASE_RECOVERY_REQUIRED'
      });
    }
    if (claimState.reason === 'purchase_review_required') {
      return respondAfterUnchargedCreditPackFailure(res, {
        adminClient,
        userId: req.user.id,
        requestId,
        cancellationReason: claimState.cancelReason,
        statusCode: 409,
        error: 'A previous usage add-on purchase requires review.',
        code: 'PURCHASE_REVIEW_REQUIRED'
      });
    }
    if (claimState.reason === 'subscription_reconfirmation_required') {
      return respondAfterUnchargedCreditPackFailure(res, {
        adminClient,
        userId: req.user.id,
        requestId,
        cancellationReason: claimState.cancelReason,
        statusCode: 409,
        error: 'Your subscription changed. Start a new billing preview.',
        code: 'SUBSCRIPTION_RECONFIRMATION_REQUIRED'
      });
    }
    return sendCreditPackPendingResponse(res, {
      ...claimState,
      packKey: pack.key,
      credits: pack.credits,
      unitAmount: pack.priceCents
    });
  }

  let claimedAmounts = null;
  try {
    claimedAmounts = approvedCreditPackPreviewAmounts({
      subtotal: String(claimState.approvedSubtotal),
      discount: String(claimState.approvedDiscount),
      tax: String(claimState.approvedTax),
      total: String(claimState.approvedTotal),
      credit: String(claimState.approvedCredit),
      balance: String(claimState.approvedBalance),
      grandTotal: String(claimState.approvedGrandTotal),
      grandTotalTax: String(claimState.approvedGrandTotalTax)
    });
  } catch (_) {
    claimedAmounts = null;
  }
  if (
    !claimedAmounts
    || claimState.confirmationVersion !== confirmationVersion
    || claimState.packKey !== pack.key
    || claimState.credits !== pack.credits
    || claimState.unitAmount !== pack.priceCents
    || claimState.currencyCode !== 'USD'
    || claimedAmounts.subtotal !== Number(freshPreview.subtotal)
    || claimedAmounts.discount !== Number(freshPreview.discount)
    || claimedAmounts.tax !== Number(freshPreview.tax)
    || claimedAmounts.total !== Number(freshPreview.total)
    || claimedAmounts.credit !== Number(freshPreview.credit)
    || claimedAmounts.balance !== Number(freshPreview.balance)
    || claimedAmounts.grandTotal !== Number(freshPreview.grandTotal)
    || claimedAmounts.grandTotalTax !== Number(freshPreview.grandTotalTax)
  ) {
    console.error('[payment/credit-packs] Claimed request contract is invalid');
    await transitionCreditPackPurchaseRequest(adminClient, {
      requestId,
      userId: req.user.id,
      status: 'provider_unknown',
      providerErrorCode: 'claim_contract_mismatch'
    }).catch((transitionError) => {
      console.error(
        '[payment/credit-packs] Could not persist invalid claim outcome:',
        transitionError.message
      );
    });
    return res.status(202).json({
      success: true,
      purchaseRequestId: requestId,
      status: 'provider_unknown',
      code: 'PURCHASE_CONFIRMATION_PENDING',
      chargeMayHaveRun: true,
      pack: creditPackResponsePack(pack)
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
        body: JSON.stringify(chargeBody),
        signal: AbortSignal.timeout(PADDLE_CHARGE_TIMEOUT_MS)
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
      providerErrorCode:
        error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? 'timeout'
          : 'network_error'
    }).catch((transitionError) => {
      console.error('[payment/credit-packs] Could not persist unknown outcome:', transitionError.message);
    });
    return res.status(202).json({
      success: true,
      purchaseRequestId: requestId,
      status: 'provider_unknown',
      code: 'PURCHASE_CONFIRMATION_PENDING',
      chargeMayHaveRun: true,
      pack: creditPackResponsePack(pack)
    });
  }

  if (!chargeResponse.ok) {
    const errorBody = await chargeResponse.text().catch(() => '');
    const errorCode = extractPaddleErrorCode(errorBody)
      || `http_${chargeResponse.status}`;
    console.error(
      '[payment/credit-packs] Paddle charge rejected status=' +
      chargeResponse.status + ' code=' + errorCode
    );
    await transitionCreditPackPurchaseRequest(adminClient, {
      requestId,
      userId: req.user.id,
      status: 'provider_unknown',
      providerErrorCode: String(errorCode).slice(0, 255)
    }).catch((transitionError) => {
      console.error('[payment/credit-packs] Could not persist rejected outcome:', transitionError.message);
    });
    return res.status(202).json({
      success: true,
      purchaseRequestId: requestId,
      status: 'provider_unknown',
      error: 'Purchase confirmation is pending.',
      code: 'PURCHASE_CONFIRMATION_PENDING',
      chargeMayHaveRun: true,
      pack: creditPackResponsePack(pack)
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
      chargeMayHaveRun: true,
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
  const payload = {
    purchaseRequestId: data.request_id,
    status: data.status,
    pack: {
      key: data.pack_key,
      credits: data.credits,
      priceUsd: data.unit_amount / 100,
      currencyCode: data.currency_code
    },
    createdAt: data.created_at,
    completedAt: data.completed_at,
    reviewRequired:
      data.review_required === true
      || ['withheld', 'chargeback'].includes(data.status)
  };
  if (['previewing', 'created'].includes(data.status)) {
    payload.confirmationVersion = data.confirmation_version;
    payload.expiryDays = data.expiry_days;
    payload.authorizationExpiresAt = data.authorization_expires_at;
  }
  if (
    data.status === 'created'
    && Number.isInteger(data.confirmation_version)
    && data.confirmation_version >= 1
    && [
      data.approved_subtotal,
      data.approved_discount,
      data.approved_tax,
      data.approved_total,
      data.approved_credit,
      data.approved_balance,
      data.approved_grand_total,
      data.approved_grand_total_tax
    ].every((amount) => (
      Number.isInteger(amount)
      && amount >= 0
      && amount <= MAX_POSTGRES_INTEGER
    ))
  ) {
    payload.preview = {
      currencyCode: data.currency_code,
      subtotal: String(data.approved_subtotal),
      discount: String(data.approved_discount),
      tax: String(data.approved_tax),
      total: String(data.approved_total),
      credit: String(data.approved_credit),
      balance: String(data.approved_balance),
      grandTotal: String(data.approved_grand_total),
      grandTotalTax: String(data.approved_grand_total_tax)
    };
  }
  return payload;
}

const CREDIT_PACK_STATUS_SELECT = [
  'request_id',
  'status',
  'review_required',
  'pack_key',
  'credits',
  'unit_amount',
  'currency_code',
  'confirmation_version',
  'expiry_days',
  'approved_subtotal',
  'approved_discount',
  'approved_tax',
  'approved_total',
  'approved_credit',
  'approved_balance',
  'approved_grand_total',
  'approved_grand_total_tax',
  'authorization_expires_at',
  'reconciliation_closed_at',
  'created_at',
  'completed_at'
].join(', ');

function loadOwnerCreditPackPurchaseData(
  adminClient,
  userId,
  requestId
) {
  return adminClient
    .from('credit_pack_purchase_requests')
    .select(CREDIT_PACK_STATUS_SELECT)
    .eq('request_id', requestId)
    .eq('authorized_user_id', userId)
    .maybeSingle();
}

async function expireCreditPackAuthorizationIfNeeded(
  adminClient,
  userId,
  data,
  nowMs = Date.now()
) {
  if (!data || !['previewing', 'created'].includes(data.status)) {
    return data;
  }
  const expiresAtMs = Date.parse(data.authorization_expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) {
    return data;
  }

  try {
    const expiration = await expireCreditPackPurchaseRequest(adminClient, {
      requestId: data.request_id,
      userId
    });
    if (expiration.status === 'failed') {
      return { ...data, status: 'failed' };
    }
    if (expiration.status && expiration.status !== data.status) {
      return { ...data, status: expiration.status };
    }
  } catch (error) {
    console.error(
      '[payment/credit-packs] Expired authorization close failed:',
      error.message
    );
  }
  return data;
}

/* ── GET /api/payment/credit-packs/purchase/pending ── */
// Recovers a request even when the charge response was lost before the browser
// learned its opaque ID. This endpoint is owner-scoped and returns the newest
// unresolved/review-locked request or a very recent terminal result. Returning
// a recent completion closes the fast-webhook race where a lost POST response
// otherwise makes the browser believe no purchase happened.
async function handlePendingCreditPackPurchase(req, res) {
  res.set('Cache-Control', 'no-store');
  // Recovery must remain available when the sales kill switch is off.
  if (!isCreditLedgerV2Enabled()) {
    return creditPackFeatureUnavailable(res);
  }

  const adminClient = req.paymentAdminClient || makePaymentAdminClient();
  const { data, error } = await adminClient
    .from('credit_pack_purchase_requests')
    .select(CREDIT_PACK_STATUS_SELECT)
    .eq('authorized_user_id', req.user.id)
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

  const currentData = await expireCreditPackAuthorizationIfNeeded(
    adminClient,
    req.user.id,
    data
  );
  return res.json({
    success: true,
    purchase: isRecoverableCreditPackPurchase(currentData)
      ? creditPackPurchaseStatusPayload(currentData)
      : null
  });
}

/* ── GET /api/payment/credit-packs/purchase/:requestId ── */
// Reload-safe, server-authoritative state. The browser never receives Paddle
// IDs or provider diagnostics and cannot read another user's request.
async function handleCreditPackPurchaseStatus(req, res) {
  res.set('Cache-Control', 'no-store');
  // Recovery must remain available when the sales kill switch is off.
  if (!isCreditLedgerV2Enabled()) {
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
    .select(CREDIT_PACK_STATUS_SELECT)
    .eq('request_id', requestId)
    .eq('authorized_user_id', req.user.id)
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

  const currentData = await expireCreditPackAuthorizationIfNeeded(
    adminClient,
    req.user.id,
    data
  );
  return res.json({
    success: true,
    ...creditPackPurchaseStatusPayload(currentData)
  });
}

/* ── POST /api/payment/credit-packs/purchase/:requestId/cancel ── */
// Cancellation is permitted only before the atomic created -> charging claim.
// The exact failed + chargeMayHaveRun:false contract is the browser's sole
// authority to release its local recovery lock.
async function handleCancelCreditPackPurchase(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!isCreditLedgerV2Enabled()) {
    return creditPackFeatureUnavailable(res);
  }

  const requestId = String(req.params?.requestId || '');
  if (!isCreditPackRequestId(requestId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid purchase request.',
      code: 'INVALID_PURCHASE_REQUEST'
    });
  }

  const adminClient = req.paymentAdminClient || makePaymentAdminClient();
  let cancellation;
  try {
    cancellation = await cancelCreditPackPurchaseRequest(adminClient, {
      requestId,
      userId: req.user.id,
      reason: 'client_cancelled'
    });
  } catch (error) {
    console.error('[payment/credit-packs] Purchase cancellation failed:', error.message);
    return res.status(503).json({
      success: false,
      purchaseRequestId: requestId,
      status: 'unknown',
      error: 'Could not confirm the purchase request was cancelled.',
      code: 'PURCHASE_CANCELLATION_UNCONFIRMED'
    });
  }

  if (cancellation.status === 'failed') {
    return res.json({
      success: true,
      purchaseRequestId: requestId,
      status: 'failed',
      chargeMayHaveRun: false
    });
  }

  const body = {
    success: false,
    purchaseRequestId: requestId,
    status: cancellation.status,
    error: 'This purchase can no longer be safely cancelled.',
    code: 'PURCHASE_CANCELLATION_UNSAFE'
  };
  if (creditPackStateMayHaveCharged(cancellation.status)) {
    body.chargeMayHaveRun = true;
  }
  return res.status(409).json(body);
}

router.post('/credit-packs/preview', authMiddleware, handleCreditPackPreview);
router.post('/credit-packs/purchase', authMiddleware, handleCreditPackPurchase);
router.post(
  '/credit-packs/purchase/:requestId/cancel',
  authMiddleware,
  handleCancelCreditPackPurchase
);
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
module.exports.isSandboxSubscriptionCheckoutConfirmed =
  isSandboxSubscriptionCheckoutConfirmed;
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
module.exports.handleCancelCreditPackPurchase = handleCancelCreditPackPurchase;
module.exports.beginCreditPackPurchasePreview = beginCreditPackPurchasePreview;
module.exports.finalizeCreditPackPurchasePreview =
  finalizeCreditPackPurchasePreview;
module.exports.claimCreditPackPurchaseRequest = claimCreditPackPurchaseRequest;
module.exports.cancelCreditPackPurchaseRequest = cancelCreditPackPurchaseRequest;
module.exports.expireCreditPackPurchaseRequest = expireCreditPackPurchaseRequest;
module.exports.transitionCreditPackPurchaseRequest = transitionCreditPackPurchaseRequest;
