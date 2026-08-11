'use strict';
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();
const { reportIncident } = require('../lib/incident-reporter');
const { recordServerEvent } = require('../lib/product-analytics');
const {
  PLAN_CREDITS,
  getPlanForPaddlePriceId
} = require('../lib/product-catalog');
const {
  getCreditPack,
  buildCreditPackReceiptContract,
  isCreditLedgerV2Enabled,
  parseExpiryDays
} = require('../lib/credit-pack-catalog');
const { parsePaddleTimestamp } = require('../lib/paddle-time');
const { getPaddleApiBase } = require('../lib/paddle-api');
const {
  parsePostgresMinorUnitAmount
} = require('../lib/paddle-money');

const PADDLE_API_BASE = getPaddleApiBase(process.env);
const CREDIT_PACK_HISTORY_ACTIONS = Object.freeze([
  'subscription_activated',
  'subscription_address_updated',
  'subscription_billing_cycle_updated',
  'subscription_billing_date_updated',
  'subscription_billing_details_updated',
  'subscription_business_added',
  'subscription_business_removed',
  'subscription_business_updated',
  'subscription_canceled',
  'subscription_collection_mode_updated',
  'subscription_consent_requirement_granted',
  'subscription_created',
  'subscription_currency_updated',
  'subscription_custom_data_updated',
  'subscription_customer_updated',
  'subscription_discount_added',
  'subscription_discount_expired',
  'subscription_discount_removed',
  'subscription_item_added',
  'subscription_item_quantity_updated',
  'subscription_item_removed',
  'subscription_one_off_charge_applied',
  'subscription_past_due',
  'subscription_paused',
  'subscription_payment_attempted',
  'subscription_payment_method_added',
  'subscription_payment_method_removed',
  'subscription_payment_method_updated',
  'subscription_renewed',
  'subscription_resumed',
  'subscription_scheduled_change_added',
  'subscription_scheduled_change_removed',
  'subscription_scheduled_change_updated'
]);
const CREDIT_PACK_HISTORY_ACTION_SET = new Set(CREDIT_PACK_HISTORY_ACTIONS);
const MAX_CREDIT_PACK_HISTORY_PAGES = 20;
const PADDLE_HISTORY_TIMEOUT_MS = 8000;

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
// Paddle may include more than one h1 while rotating secrets. Reject stale
// signatures before doing any money-moving work; the official SDK defaults to
// a five-second tolerance.
function verifyPaddleSignature(
  secret,
  rawBody,
  signatureHeader,
  nowMs = Date.now(),
  toleranceSeconds = 5
) {
  if (!secret || !signatureHeader) return false;
  const parts = new Map();
  signatureHeader.split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    const values = parts.get(key) || [];
    values.push(value);
    parts.set(key, values);
  });
  const tsValues = parts.get('ts') || [];
  const signatures = parts.get('h1') || [];
  if (tsValues.length !== 1 || signatures.length === 0) return false;

  const ts = tsValues[0];
  if (!/^\d+$/.test(ts)) return false;
  const timestampSeconds = Number(ts);
  const currentSeconds = Math.floor(Number(nowMs) / 1000);
  const tolerance = Number(toleranceSeconds);
  if (
    !Number.isSafeInteger(timestampSeconds)
    || !Number.isFinite(currentSeconds)
    || !Number.isFinite(tolerance)
    || tolerance < 0
    || Math.abs(currentSeconds - timestampSeconds) > tolerance
  ) {
    return false;
  }

  const signedPayload = ts + ':' + rawBody;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  return signatures.some(function (candidate) {
    if (!/^[a-f\d]{64}$/i.test(candidate)) return false;
    try {
      return crypto.timingSafeEqual(
        Buffer.from(digest, 'hex'),
        Buffer.from(candidate, 'hex')
      );
    } catch (_) {
      return false;
    }
  });
}

/* ── Plan mapping by Paddle price ID ── */
function priceIdToPlan(priceId, env = process.env) {
  return getPlanForPaddlePriceId(priceId, env);
}

function minorUnitAmountToInteger(value) {
  return parsePostgresMinorUnitAmount(value);
}

function parseCompletedCreditPackTotals(data, item) {
  const totals = data?.details?.totals;
  const lineItems = data?.details?.line_items;
  const lineItem = Array.isArray(lineItems) && lineItems.length === 1
    ? lineItems[0]
    : null;
  const capturedPayments = Array.isArray(data?.payments)
    ? data.payments.filter((payment) => payment?.status === 'captured')
    : [];
  const capturedPayment = capturedPayments.length === 1
    && parsePaddleTimestamp(capturedPayments[0]?.captured_at)
    ? capturedPayments[0]
    : null;
  const amountNames = [
    'subtotal',
    'discount',
    'tax',
    'total',
    'credit',
    'balance',
    'grand_total',
    'grand_total_tax'
  ];
  const actualTotals = {};
  for (const name of amountNames) {
    const amount = minorUnitAmountToInteger(totals?.[name]);
    if (amount === null) return null;
    actualTotals[name] = amount;
  }

  const lineTotalNames = ['subtotal', 'discount', 'tax', 'total'];
  const consistentLineTotals = lineTotalNames.every((name) => (
    minorUnitAmountToInteger(lineItem?.totals?.[name]) !== null
    && lineItem.totals[name] === totals[name]
  ));
  const optionalPaymentCurrencyMatches =
    capturedPayment?.currency_code === undefined
    || capturedPayment?.currency_code === 'USD';
  if (
    data?.currency_code !== 'USD'
    || totals?.currency_code !== 'USD'
    || !lineItem
    || lineItem.price_id !== item?.price?.id
    || lineItem.product?.id !== item?.price?.product_id
    || lineItem.quantity !== item?.quantity
    || !consistentLineTotals
    || actualTotals.balance !== 0
    || capturedPayment?.amount !== totals.grand_total
    || !optionalPaymentCurrencyMatches
  ) {
    return null;
  }

  return Object.freeze({
    subtotal: actualTotals.subtotal,
    discount: actualTotals.discount,
    tax: actualTotals.tax,
    total: actualTotals.total,
    credit: actualTotals.credit,
    balance: actualTotals.balance,
    grandTotal: actualTotals.grand_total,
    grandTotalTax: actualTotals.grand_total_tax
  });
}

function validateCompletedCreditPackTransaction(data, pack) {
  if (!data || !pack) return { valid: false, reason: 'missing_data' };
  if (!data.id || !data.customer_id || !data.subscription_id) {
    return { valid: false, reason: 'missing_identity' };
  }
  if (data.origin !== 'subscription_charge') {
    return { valid: false, reason: 'invalid_origin' };
  }
  if (
    data.status !== 'completed'
    || data.collection_mode !== 'automatic'
    || data.currency_code !== 'USD'
    || !parsePaddleTimestamp(data.created_at)
  ) {
    return { valid: false, reason: 'invalid_transaction_state' };
  }
  if (!Array.isArray(data.items) || data.items.length !== 1) {
    return { valid: false, reason: 'invalid_item_count' };
  }

  const item = data.items[0];
  const price = item?.price;
  const metadata = price?.custom_data;
  if (
    metadata?.promptgenKind !== 'credit_pack'
    || metadata?.promptgenPackKey !== pack.key
  ) {
    return { valid: false, reason: 'invalid_product_kind' };
  }
  if (
    typeof metadata?.promptgenPurchaseRequestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(metadata.promptgenPurchaseRequestId)
  ) {
    return { valid: false, reason: 'missing_purchase_request' };
  }
  if (
    item?.quantity !== 1
    || !price?.id
    || !price?.product_id
    || price?.type !== 'custom'
  ) {
    return { valid: false, reason: 'item_mismatch' };
  }
  if (price?.billing_cycle !== null) {
    return { valid: false, reason: 'not_one_time' };
  }
  const receipt = buildCreditPackReceiptContract(
    pack,
    parseExpiryDays(process.env.CREDIT_PACK_EXPIRY_DAYS)
  );
  if (
    price?.unit_price?.amount !== receipt.unitAmount
    || price?.unit_price?.currency_code !== receipt.currencyCode
    || price?.name !== receipt.priceName
    || price?.description !== receipt.internalDescription
  ) {
    return { valid: false, reason: 'catalog_price_mismatch' };
  }
  const capturedPayments = Array.isArray(data.payments)
    ? data.payments.filter((payment) => payment?.status === 'captured')
    : [];
  if (
    capturedPayments.length !== 1
    || !parsePaddleTimestamp(capturedPayments[0]?.captured_at)
  ) {
    return { valid: false, reason: 'invalid_payment_capture' };
  }
  const actualTotals = parseCompletedCreditPackTotals(data, item);
  return {
    valid: true,
    reason: actualTotals ? 'verified' : 'amount_contract_malformed',
    actualTotals
  };
}

async function loadCreditPackTemporalContext(supabase, requestId) {
  const { data, error } = await supabase
    .from('credit_pack_purchase_requests')
    .select(
      'request_id, customer_id, subscription_id, authorized_at, ' +
      'authorization_expires_at, eligibility_check_started_at'
    )
    .eq('request_id', requestId)
    .maybeSingle();

  if (error) {
    throw new Error('Credit pack authorization lookup failed: ' + error.message);
  }
  if (
    !data
    || data.request_id !== requestId
    || !parsePaddleTimestamp(data.authorized_at)
    || !parsePaddleTimestamp(data.authorization_expires_at)
    || !parsePaddleTimestamp(data.eligibility_check_started_at)
  ) {
    throw new Error('Credit pack authorization context is missing or invalid');
  }
  return data;
}

function buildCreditPackHistoryUrl({
  apiBase,
  subscriptionId,
  authorizedAt,
  completedAt
}) {
  const trustedApiBase = getPaddleApiBase({
    NODE_ENV: process.env.NODE_ENV,
    PADDLE_API_BASE: apiBase
  });
  const url = new URL(
    `/subscriptions/${encodeURIComponent(subscriptionId)}/history`,
    trustedApiBase
  );
  url.searchParams.set('occurred_at[GTE]', authorizedAt);
  url.searchParams.set('occurred_at[LTE]', completedAt);
  url.searchParams.set('per_page', '200');
  url.searchParams.set('order_by', 'id[DESC]');
  return url;
}

function validateCreditPackHistoryNextUrl(nextValue, expected) {
  if (typeof nextValue !== 'string' || !nextValue.trim()) return null;
  let next;
  try {
    next = new URL(nextValue);
  } catch (_) {
    return null;
  }
  const allowedKeys = new Set([
    'occurred_at[GTE]',
    'occurred_at[LTE]',
    'per_page',
    'order_by',
    'after'
  ]);
  const hasUnexpectedOrDuplicateParameter = [...next.searchParams.keys()]
    .some((key) => (
      !allowedKeys.has(key)
      || next.searchParams.getAll(key).length !== 1
    ));
  if (
    next.origin !== expected.origin
    || next.pathname !== expected.pathname
    || hasUnexpectedOrDuplicateParameter
    || next.searchParams.get('occurred_at[GTE]') !==
      expected.searchParams.get('occurred_at[GTE]')
    || next.searchParams.get('occurred_at[LTE]') !==
      expected.searchParams.get('occurred_at[LTE]')
    || next.searchParams.get('per_page') !== '200'
    || next.searchParams.get('order_by') !== 'id[DESC]'
    || !next.searchParams.get('after')
  ) {
    return null;
  }
  return next;
}

function classifyCreditPackHistoryEntry(entry, transactionId) {
  const action = entry?.detail?.action;
  if (!CREDIT_PACK_HISTORY_ACTION_SET.has(action)) {
    return 'ambiguous';
  }

  // An immediate one-off charge creates its own history entry. It is the only
  // action that is expected inside this narrow authorization window, and is
  // safe only when Paddle binds it to this exact completed transaction.
  if (action === 'subscription_one_off_charge_applied') {
    const effectiveFrom = entry?.detail?.effective_from;
    const historyTransactionId = entry?.detail?.transaction_id;
    if (
      typeof effectiveFrom !== 'string'
      || typeof historyTransactionId !== 'string'
      || !historyTransactionId.trim()
    ) {
      return 'ambiguous';
    }
    return effectiveFrom === 'immediately'
      && historyTransactionId === transactionId
      ? 'safe'
      : 'ineligible';
  }

  // Paddle defines subscription_payment_attempted as a failed payment.
  // Every other currently documented action is conservatively ineligible;
  // newly introduced actions remain ambiguous until explicitly reviewed.
  return 'ineligible';
}

function paddleTimestampToEpochNanoseconds(value) {
  const normalized = parsePaddleTimestamp(value);
  if (!normalized) return null;

  const match = normalized.match(
    /^(.+:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) return null;

  const wholeSecondMs = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isSafeInteger(wholeSecondMs)) return null;

  const fractionalNanoseconds = BigInt((match[2] || '').padEnd(9, '0'));
  return (BigInt(wholeSecondMs) * 1000000n) + fractionalNanoseconds;
}

function comparePaddleTimestamps(left, right) {
  const leftNanoseconds = paddleTimestampToEpochNanoseconds(left);
  const rightNanoseconds = paddleTimestampToEpochNanoseconds(right);
  if (leftNanoseconds === null || rightNanoseconds === null) return null;
  if (leftNanoseconds < rightNanoseconds) return -1;
  if (leftNanoseconds > rightNanoseconds) return 1;
  return 0;
}

async function verifyCreditPackSubscriptionHistory({
  apiKey,
  subscriptionId,
  transactionId,
  historyStartAt,
  authorizedAt,
  authorizationExpiresAt,
  completedAt,
  apiBase = PADDLE_API_BASE,
  fetchImpl = fetch
}) {
  const normalizedAuthorizedAt = parsePaddleTimestamp(authorizedAt);
  const normalizedHistoryStartAt = parsePaddleTimestamp(historyStartAt);
  const normalizedExpiresAt = parsePaddleTimestamp(authorizationExpiresAt);
  const normalizedCompletedAt = parsePaddleTimestamp(completedAt);
  if (
    !normalizedAuthorizedAt
    || !normalizedHistoryStartAt
    || !normalizedExpiresAt
    || !normalizedCompletedAt
    || typeof transactionId !== 'string'
    || !transactionId.trim()
  ) {
    return { status: 'ambiguous', requestId: null };
  }

  const completedVsAuthorized = comparePaddleTimestamps(
    normalizedCompletedAt,
    normalizedAuthorizedAt
  );
  const completedVsExpires = comparePaddleTimestamps(
    normalizedCompletedAt,
    normalizedExpiresAt
  );
  if (
    completedVsAuthorized === null
    || completedVsExpires === null
    || completedVsAuthorized < 0
    || completedVsExpires >= 0
  ) {
    return { status: 'not_checked', requestId: null };
  }
  if (!apiKey) {
    return { status: 'unavailable', requestId: null };
  }
  const historyStartVsAuthorized = comparePaddleTimestamps(
    normalizedHistoryStartAt,
    normalizedAuthorizedAt
  );
  if (historyStartVsAuthorized === null) {
    return { status: 'ambiguous', requestId: null };
  }
  const queryStartAt = historyStartVsAuthorized <= 0
    ? normalizedHistoryStartAt
    : normalizedAuthorizedAt;

  let firstUrl;
  try {
    firstUrl = buildCreditPackHistoryUrl({
      apiBase,
      subscriptionId,
      authorizedAt: queryStartAt,
      completedAt: normalizedCompletedAt
    });
  } catch (_) {
    return { status: 'unavailable', requestId: null };
  }
  let nextUrl = firstUrl;
  let firstRequestId = null;
  let firstIneligibleEvent = null;
  let safeEvent = null;

  for (let page = 0; page < MAX_CREDIT_PACK_HISTORY_PAGES; page += 1) {
    let response;
    try {
      response = await fetchImpl(nextUrl.toString(), {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(PADDLE_HISTORY_TIMEOUT_MS)
      });
    } catch (_) {
      return { status: 'unavailable', requestId: firstRequestId };
    }
    if (!response?.ok) {
      return { status: 'unavailable', requestId: firstRequestId };
    }

    const body = await response.json().catch(() => null);
    const requestId =
      typeof body?.meta?.request_id === 'string'
        ? body.meta.request_id.trim()
        : '';
    const pagination = body?.meta?.pagination;
    if (
      !Array.isArray(body?.data)
      || !requestId
      || requestId.length > 255
      || typeof pagination?.has_more !== 'boolean'
      || typeof pagination?.next !== 'string'
    ) {
      return {
        status: firstRequestId ? 'ambiguous' : 'unavailable',
        requestId: firstRequestId
      };
    }
    if (!firstRequestId) firstRequestId = requestId;

    for (const entry of body.data) {
      const eventId =
        typeof entry?.id === 'string' ? entry.id.trim() : '';
      const action = entry?.detail?.action;
      const occurredAt = parsePaddleTimestamp(entry?.occurred_at);
      if (
        !eventId
        || eventId.length > 255
        || entry?.subscription_id !== subscriptionId
        || !occurredAt
      ) {
        return { status: 'ambiguous', requestId: firstRequestId };
      }
      const occurredVsStart = comparePaddleTimestamps(occurredAt, queryStartAt);
      const occurredVsCompleted = comparePaddleTimestamps(
        occurredAt,
        normalizedCompletedAt
      );
      if (
        occurredVsStart === null
        || occurredVsCompleted === null
        || occurredVsStart < 0
        || occurredVsCompleted > 0
      ) {
        return { status: 'ambiguous', requestId: firstRequestId };
      }
      const classification = classifyCreditPackHistoryEntry(
        entry,
        transactionId
      );
      if (classification === 'ambiguous') {
        return { status: 'ambiguous', requestId: firstRequestId };
      }
      if (classification === 'ineligible' && !firstIneligibleEvent) {
        firstIneligibleEvent = {
          id: eventId,
          action,
          occurredAt
        };
      }
      if (classification === 'safe') {
        const safeVsAuthorized = comparePaddleTimestamps(
          occurredAt,
          normalizedAuthorizedAt
        );
        if (safeVsAuthorized === null || safeVsAuthorized < 0) {
          return { status: 'ambiguous', requestId: firstRequestId };
        }
        if (safeEvent) {
          return { status: 'ambiguous', requestId: firstRequestId };
        }
        safeEvent = {
          id: eventId,
          action,
          occurredAt
        };
      }
    }

    if (!pagination.has_more) {
      if (!safeEvent) {
        return { status: 'ambiguous', requestId: firstRequestId };
      }
      return firstIneligibleEvent
        ? {
            status: 'ineligible',
            requestId: firstRequestId,
            event: firstIneligibleEvent
          }
          : {
            status: 'eligible',
            requestId: firstRequestId,
            event: safeEvent
          };
    }

    nextUrl = validateCreditPackHistoryNextUrl(pagination.next, firstUrl);
    if (!nextUrl) {
      return { status: 'ambiguous', requestId: firstRequestId };
    }
  }

  return { status: 'ambiguous', requestId: firstRequestId };
}

async function grantCreditsForPack(
  supabase,
  data,
  pack,
  env = process.env,
  purchasedAt,
  providerEventId
) {
  const expiryDays = parseExpiryDays(env.CREDIT_PACK_EXPIRY_DAYS);
  const item = data?.items?.[0];
  const requestId = item?.price?.custom_data?.promptgenPurchaseRequestId;
  const normalizedPurchasedAt = parsePaddleOccurredAt(purchasedAt);
  const transactionCreatedAt = parsePaddleOccurredAt(data?.created_at);
  const capturedPayments = Array.isArray(data?.payments)
    ? data.payments.filter((payment) => payment?.status === 'captured')
    : [];
  const capturedAt = capturedPayments.length === 1
    ? parsePaddleOccurredAt(capturedPayments[0].captured_at)
    : null;
  const actualTotals = parseCompletedCreditPackTotals(data, item);
  if (!normalizedPurchasedAt) {
    throw new Error('Credit pack purchase is missing a valid Paddle occurred_at');
  }
  if (
    !transactionCreatedAt
    || !capturedAt
    || typeof providerEventId !== 'string'
    || !providerEventId.trim()
    || providerEventId.length > 255
  ) {
    throw new Error('Credit pack purchase is missing valid provider evidence');
  }

  const temporalContext = await loadCreditPackTemporalContext(
    supabase,
    requestId
  );
  if (
    temporalContext.customer_id !== data.customer_id
    || temporalContext.subscription_id !== data.subscription_id
  ) {
    throw new Error('Credit pack authorization binding does not match transaction');
  }

  const historyProof = await verifyCreditPackSubscriptionHistory({
    apiKey: env.PADDLE_API_KEY,
    subscriptionId: data.subscription_id,
    transactionId: data.id,
    historyStartAt: temporalContext.eligibility_check_started_at,
    authorizedAt: temporalContext.authorized_at,
    authorizationExpiresAt: temporalContext.authorization_expires_at,
    completedAt: normalizedPurchasedAt,
    apiBase: getPaddleApiBase(env)
  });

  const { data: result, error } = await supabase.rpc('apply_credit_pack_subscription_charge', {
    p_request_id: requestId,
    p_transaction_id: data.id,
    p_customer_id: data.customer_id,
    p_subscription_id: data.subscription_id,
    p_pack_key: pack.key,
    p_provider_price_id: item.price.id,
    p_provider_product_id: item.price.product_id,
    p_credits: pack.credits,
    p_unit_amount: pack.priceCents,
    p_currency_code: 'USD',
    p_actual_subtotal: actualTotals?.subtotal ?? null,
    p_actual_discount: actualTotals?.discount ?? null,
    p_actual_tax: actualTotals?.tax ?? null,
    p_actual_total: actualTotals?.total ?? null,
    p_actual_credit: actualTotals?.credit ?? null,
    p_actual_balance: actualTotals?.balance ?? null,
    p_actual_grand_total: actualTotals?.grandTotal ?? null,
    p_actual_grand_total_tax: actualTotals?.grandTotalTax ?? null,
    p_expiry_days: expiryDays,
    p_purchased_at: normalizedPurchasedAt,
    p_provider_event_id: providerEventId.trim(),
    p_transaction_created_at: transactionCreatedAt,
    p_captured_at: capturedAt,
    p_history_proof_status: historyProof.status,
    p_history_api_request_id: historyProof.requestId || null,
    p_history_event_id: historyProof.event?.id || null,
    p_history_event_action: historyProof.event?.action || null,
    p_history_event_occurred_at: historyProof.event?.occurredAt || null
  });

  if (error) {
    throw new Error('apply_credit_pack_subscription_charge RPC failed: ' + error.message);
  }
  if (
    result?.reconciliationSuperseded === true
    && result?.status === 'completed'
    && result?.entitlementGranted === true
  ) {
    const reconciliationIncident = await reportIncident({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'CREDIT_PACK_RECONCILIATION_SUPERSEDED',
      message: 'A signed completed payment superseded a definitive no-match reconciliation',
      fingerprint:
        `paddle-webhook:CREDIT_PACK_RECONCILIATION_SUPERSEDED:${data.id}`,
      context: {
        transactionId: data.id,
        requestId,
        providerEventId: providerEventId.trim(),
        userId: result.userId || null
      }
    });
    // The entitlement RPC may already have committed. Do not ACK until the
    // supersession is durable: a provider retry will hit the immutable payment
    // receipt, avoid a second grant, and retry this same incident fingerprint.
    if (reconciliationIncident?.persisted !== true) {
      throw webhookProcessingError(
        'CREDIT_PACK_RECONCILIATION_INCIDENT_PERSIST_FAILED',
        'Reconciliation supersession incident could not be persisted'
      );
    }
  }
  const lateReconciledPaymentWithheld =
    ['entitlement_withheld', 'duplicate'].includes(result?.reason)
    && result?.status === 'withheld'
    && result?.entitlementGranted === false
    && result?.reviewRequired === true
    && result?.withheldReason === 'late_payment_after_reconciled_no_match';
  if (lateReconciledPaymentWithheld) {
    const latePaymentIncident = await reportIncident({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'CREDIT_PACK_LATE_PAYMENT_REFUND_REVIEW_REQUIRED',
      message: 'A credit-pack payment arrived after definitive no-match reconciliation',
      fingerprint:
        `paddle-webhook:CREDIT_PACK_LATE_PAYMENT_REFUND_REVIEW_REQUIRED:${data.id}`,
      context: {
        transactionId: data.id,
        requestId,
        providerEventId: providerEventId.trim(),
        userId: result.userId || null,
        withheldReason: result.withheldReason,
        entitlementGranted: false,
        refundReviewRequired: true
      }
    });
    if (latePaymentIncident?.persisted !== true) {
      throw webhookProcessingError(
        'CREDIT_PACK_LATE_PAYMENT_INCIDENT_PERSIST_FAILED',
        'Late credit-pack payment refund-review incident could not be persisted'
      );
    }
    return result;
  }
  if (
    result?.reason === 'duplicate'
    && ['completed', 'withheld', 'refunded', 'chargeback'].includes(result?.status)
  ) {
    console.log('[paddle/webhook] Credit pack already applied for transaction_id=' + data.id);
    return result;
  }
  if (
    result?.reason === 'entitlement_withheld'
    && result?.status === 'withheld'
    && result?.entitlementGranted === false
    && result?.reviewRequired === true
  ) {
    await reportIncident({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'CREDIT_PACK_PURCHASE_WITHHELD',
      message: 'A completed credit-pack payment was withheld from entitlement',
      fingerprint: `paddle-webhook:CREDIT_PACK_PURCHASE_WITHHELD:${data.id}`,
      context: {
        transactionId: data.id,
        requestId,
        providerEventId: providerEventId.trim(),
        userId: result.userId || null,
        withheldReason: result.withheldReason || null,
        entitlementGranted: false,
        refundReviewRequired: false
      }
    });
    return result;
  }
  if (
    result?.reason === 'payment_refunded_before_entitlement'
    && result?.status === 'refunded'
    && result?.entitlementGranted === false
    && result?.reviewRequired === false
  ) {
    console.log(
      '[paddle/webhook] Credit-pack payment was already refunded before ' +
      'entitlement transaction_id=' + data.id
    );
    return result;
  }
  if (
    result?.reason === 'payment_chargeback_before_entitlement'
    && result?.status === 'chargeback'
    && result?.entitlementGranted === false
    && result?.reviewRequired === true
  ) {
    await reportIncident({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'CREDIT_PACK_PAYMENT_CHARGEBACK',
      message: 'A credit-pack payment chargeback preceded entitlement',
      fingerprint: `paddle-webhook:CREDIT_PACK_PAYMENT_CHARGEBACK:${data.id}`,
      context: {
        transactionId: data.id,
        requestId,
        providerEventId: providerEventId.trim(),
        userId: result.userId || null
      }
    });
    return result;
  }
  if (
    result?.applied !== true
    || result?.status !== 'completed'
    || result?.entitlementGranted !== true
  ) {
    throw new Error(
      'apply_credit_pack_subscription_charge returned an invalid outcome'
    );
  }

  console.log(
    '[paddle/webhook] Granted credit pack ' + pack.key +
    ' credits=' + pack.credits +
    ' userId=' + result.userId +
    ' transaction=' + data.id
  );
  await recordServerEvent({
    eventName: 'purchase_completed',
    userId: result.userId,
    properties: {
      plan: 'credit_pack',
      creditsGranted: pack.credits,
      transactionType: 'credit_pack'
    }
  });
  return result;
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function getSubscriptionCheckoutMetadata(data) {
  const metadata = data?.custom_data;
  if (metadata?.promptgenKind !== 'subscription_checkout') return null;
  const keys = Object.keys(metadata).sort();
  const expectedKeys = [
    'promptgenCheckoutAttemptId',
    'promptgenKind',
    'promptgenTargetPlan'
  ];
  if (
    keys.length !== expectedKeys.length
    || keys.some(function (key, index) { return key !== expectedKeys[index]; })
    || !isUuid(metadata?.promptgenCheckoutAttemptId)
    || !['pro', 'enterprise'].includes(metadata?.promptgenTargetPlan)
  ) {
    return null;
  }
  return {
    attemptId: metadata.promptgenCheckoutAttemptId,
    plan: metadata.promptgenTargetPlan
  };
}

function hasSubscriptionCheckoutMarker(data) {
  return data?.custom_data?.promptgenKind === 'subscription_checkout';
}

function hasCreditPackMarker(data) {
  return data?.items?.[0]?.price?.custom_data?.promptgenKind === 'credit_pack';
}

function validateCompletedSubscriptionCheckoutTransaction(data, attempt) {
  const metadata = getSubscriptionCheckoutMetadata(data);
  const isMetadataRecovery = [
    'charging',
    'provider_unknown',
    'reconciled_no_match',
    'account_deleted_review'
  ].includes(attempt?.status);
  const accountDeletedAttempt =
    attempt?.user_id == null
    && isUuid(attempt?.authorized_user_id);
  const mayHaveUnboundTransaction = [
    'charging',
    'provider_unknown',
    'reconciled_no_match'
  ].includes(attempt?.status);
  const requiresExactMetadata = isMetadataRecovery || accountDeletedAttempt;
  if (!attempt) return { valid: false, reason: 'missing_server_attempt' };
  if (hasCreditPackMarker(data)) {
    return { valid: false, reason: 'unexpected_credit_pack_marker' };
  }
  if (
    !data?.id
    || !data?.subscription_id
    || !data?.customer_id
    || data?.origin !== 'api'
    || data?.status !== 'completed'
    || data?.collection_mode !== 'automatic'
  ) {
    return { valid: false, reason: 'invalid_transaction_identity' };
  }
  if (!Array.isArray(data?.items) || data.items.length !== 1) {
    return { valid: false, reason: 'invalid_item_count' };
  }

  const item = data.items[0];
  const price = item?.price;
  const billingCycle = price?.billing_cycle;
  if (
    !isUuid(attempt?.attempt_id)
    || (
      requiresExactMetadata
        ? !isUuid(attempt?.authorized_user_id)
        : !attempt?.user_id
    )
    || (
      mayHaveUnboundTransaction
        ? (
          attempt?.transaction_id != null
          && attempt.transaction_id !== data.id
        )
        : attempt?.transaction_id !== data.id
    )
    || ![
      'bound',
      'charging',
      'provider_unknown',
      'reconciled_no_match',
      'account_deleted_review',
      'completed'
    ].includes(attempt?.status)
    || attempt?.expected_origin !== 'api'
    || !['pro', 'enterprise'].includes(attempt?.target_plan)
    || !Number.isInteger(attempt?.credits)
    || !Number.isInteger(attempt?.unit_amount)
    || attempt?.credits <= 0
    || attempt?.unit_amount <= 0
    || attempt?.currency_code !== 'USD'
  ) {
    return { valid: false, reason: 'invalid_server_attempt' };
  }
  if (
    hasSubscriptionCheckoutMarker(data)
    && !metadata
  ) {
    return { valid: false, reason: 'invalid_checkout_metadata' };
  }
  if (requiresExactMetadata && !metadata) {
    return { valid: false, reason: 'recovery_metadata_required' };
  }
  if (
    metadata
    && (
      metadata.attemptId !== attempt.attempt_id
      || metadata.plan !== attempt.target_plan
    )
  ) {
    return { valid: false, reason: 'checkout_metadata_mismatch' };
  }
  if (
    item?.quantity !== 1
    || price?.id !== attempt.price_id
    || price?.type !== 'standard'
    || price?.unit_price?.amount !== String(attempt.unit_amount)
    || price?.unit_price?.currency_code !== attempt.currency_code
    || billingCycle?.interval !== 'month'
    || billingCycle?.frequency !== 1
    || data?.currency_code !== attempt.currency_code
  ) {
    return { valid: false, reason: 'subscription_contract_mismatch' };
  }

  return {
    valid: true,
    reason: 'verified',
    metadata,
    contract: {
      attemptId: attempt.attempt_id,
      userId: attempt.user_id,
      plan: attempt.target_plan,
      priceId: attempt.price_id,
      credits: attempt.credits,
      unitAmount: String(attempt.unit_amount),
      currencyCode: attempt.currency_code,
      billingCycle: { interval: 'month', frequency: 1 },
      quantity: 1
    }
  };
}

const SUBSCRIPTION_CHECKOUT_ATTEMPT_SELECT = [
  'attempt_id',
  'user_id',
  'authorized_user_id',
  'transaction_id',
  'subscription_id',
  'customer_id',
  'target_plan',
  'price_id',
  'credits',
  'unit_amount',
  'currency_code',
  'expected_origin',
  'status'
].join(',');

async function findSubscriptionCheckoutAttemptByTransactionId(
  supabase,
  transactionId
) {
  if (!transactionId) return null;
  const { data: attempt, error } = await supabase
    .from('subscription_checkout_attempts')
    .select(SUBSCRIPTION_CHECKOUT_ATTEMPT_SELECT)
    .eq('transaction_id', transactionId)
    .maybeSingle();
  if (error) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_ATTEMPT_LOOKUP_FAILED',
      'Server-bound subscription checkout lookup failed'
    );
  }
  return attempt || null;
}

async function findRecoverableSubscriptionCheckoutAttemptByMetadata(
  supabase,
  data
) {
  if (data?.origin !== 'api') return null;
  const metadata = getSubscriptionCheckoutMetadata(data);
  if (!metadata) return null;

  const { data: attempt, error } = await supabase
    .from('subscription_checkout_attempts')
    .select(SUBSCRIPTION_CHECKOUT_ATTEMPT_SELECT)
    .eq('attempt_id', metadata.attemptId)
    .in('status', ['charging', 'provider_unknown', 'reconciled_no_match'])
    .maybeSingle();
  if (error) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_ATTEMPT_LOOKUP_FAILED',
      'Recoverable subscription checkout lookup failed'
    );
  }
  if (!attempt) return null;

  return validateCompletedSubscriptionCheckoutTransaction(data, attempt).valid
    ? attempt
    : null;
}

async function findCompletedSubscriptionCheckoutAttemptBySubscriptionId(
  supabase,
  subscriptionId
) {
  if (!subscriptionId) return null;
  const { data: attempt, error } = await supabase
    .from('subscription_checkout_attempts')
    .select(SUBSCRIPTION_CHECKOUT_ATTEMPT_SELECT)
    .eq('subscription_id', subscriptionId)
    .eq('status', 'completed')
    .maybeSingle();
  if (error) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_ATTEMPT_LOOKUP_FAILED',
      'Completed subscription checkout lookup failed'
    );
  }
  return attempt || null;
}

async function consumeSubscriptionCheckoutAttempt(
  supabase,
  data,
  occurredAt,
  serverAttempt = null
) {
  const attempt = serverAttempt
    || await findSubscriptionCheckoutAttemptByTransactionId(supabase, data?.id)
    || await findRecoverableSubscriptionCheckoutAttemptByMetadata(
      supabase,
      data
    );
  if (!attempt) {
    throw webhookProcessingError(
      'UNBOUND_SUBSCRIPTION_CHECKOUT_TRANSACTION',
      'Completed API transaction has no server-bound checkout attempt'
    );
  }
  const validation = validateCompletedSubscriptionCheckoutTransaction(data, attempt);
  if (!validation.valid) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_TRANSACTION_INVALID',
      `Completed subscription checkout failed validation: ${validation.reason}`
    );
  }
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_OCCURRED_AT_MISSING',
      'Completed subscription checkout is missing a valid occurred_at'
    );
  }

  const { contract } = validation;

  const { data: result, error } = await supabase.rpc(
    'consume_subscription_checkout_attempt',
    {
      p_attempt_id: attempt.attempt_id,
      p_transaction_id: data.id,
      p_subscription_id: data.subscription_id,
      p_customer_id: data.customer_id,
      p_origin: data.origin,
      p_transaction_status: data.status,
      p_plan: attempt.target_plan,
      p_price_id: contract.priceId,
      p_credits: contract.credits,
      p_unit_amount: Number(contract.unitAmount),
      p_currency_code: contract.currencyCode,
      p_quantity: 1,
      p_completed_at: occurredAt,
      p_skip_entitlement_mutation: isTestAccount(attempt.user_id)
    }
  );
  if (error) {
    throw new Error('consume_subscription_checkout_attempt RPC failed: ' + error.message);
  }
  const lateReconciledPayment =
    result?.reason === 'late_payment_after_reconciled_no_match';
  const validLateReconciledPayment =
    lateReconciledPayment
    && result?.status === 'reconciled_no_match'
    && result?.entitlementGranted === false
    && result?.refundReviewRequired === true
    && result?.withheldReason === 'late_payment_after_reconciled_no_match'
    && isUuid(result?.authorizedUserId)
    && [true, false].includes(result?.applied)
    && result?.transactionId === data.id
    && result?.subscriptionId === data.subscription_id;
  const accountDeletedPayment =
    result?.reason === 'payment_after_account_deleted';
  const validAccountDeletedPayment =
    accountDeletedPayment
    && result?.status === 'account_deleted_review'
    && result?.entitlementGranted === false
    && result?.refundReviewRequired === true
    && result?.withheldReason === 'payment_after_account_deleted'
    && isUuid(result?.authorizedUserId)
    && result?.userId == null
    && [true, false].includes(result?.applied)
    && result?.transactionId === data.id
    && result?.subscriptionId === data.subscription_id;
  const completedBeforeAccountDeleted =
    result?.reason === 'completed_before_account_deleted';
  const validCompletedBeforeAccountDeleted =
    completedBeforeAccountDeleted
    && result?.applied === false
    && result?.status === 'completed'
    && isUuid(result?.authorizedUserId)
    && result?.userId == null
    && result?.transactionId === data.id
    && result?.subscriptionId === data.subscription_id
    && result?.entitlementGranted === false
    && result?.refundReviewRequired === false;
  if (
    (lateReconciledPayment && !validLateReconciledPayment)
    || (accountDeletedPayment && !validAccountDeletedPayment)
    || (
      completedBeforeAccountDeleted
      && !validCompletedBeforeAccountDeleted
    )
    || (
      !lateReconciledPayment
      && !accountDeletedPayment
      && !completedBeforeAccountDeleted
      && (!result?.userId || !result?.status)
    )
  ) {
    throw new Error('consume_subscription_checkout_attempt returned an invalid outcome');
  }
  return {
    ...result,
    verifiedAttemptId: attempt.attempt_id,
    verifiedPlan: attempt.target_plan,
    verifiedCredits: attempt.credits
  };
}

async function reportLateReconciledSubscriptionCheckoutPayment(
  result,
  data,
  {
    requestId = null,
    eventId = null,
    providerEventId = null,
    incidentReporter = reportIncident
  } = {}
) {
  if (
    result?.reason !== 'late_payment_after_reconciled_no_match'
    || result?.status !== 'reconciled_no_match'
    || result?.entitlementGranted !== false
    || result?.refundReviewRequired !== true
    || result?.withheldReason !== 'late_payment_after_reconciled_no_match'
    || !isUuid(result?.authorizedUserId)
    || ![true, false].includes(result?.applied)
    || result?.transactionId !== data?.id
    || result?.subscriptionId !== data?.subscription_id
  ) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_LATE_PAYMENT_OUTCOME_INVALID',
      'Late reconciled subscription payment returned an invalid outcome'
    );
  }

  const incident = await incidentReporter({
    severity: 'critical',
    source: 'paddle-webhook',
    eventCode: 'SUBSCRIPTION_CHECKOUT_LATE_PAYMENT_REFUND_REVIEW_REQUIRED',
    message: 'A subscription payment arrived after definitive no-match reconciliation',
    fingerprint:
      `paddle-webhook:SUBSCRIPTION_CHECKOUT_LATE_PAYMENT_REFUND_REVIEW_REQUIRED:${data.id}`,
    context: {
      requestId,
      eventId,
      providerEventId,
      transactionId: data.id,
      subscriptionId: data.subscription_id,
      customerId: data.customer_id || null,
      attemptId: result.verifiedAttemptId || null,
      authorizedUserId: result.authorizedUserId,
      userId: result.userId || null,
      plan: result.verifiedPlan || null,
      entitlementGranted: false,
      refundReviewRequired: true,
      withheldReason: result.withheldReason,
      receiptInserted: result.applied === true
    }
  });

  if (incident?.persisted !== true) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_LATE_PAYMENT_INCIDENT_PERSIST_FAILED',
      'Late subscription payment refund-review incident could not be persisted'
    );
  }

  return incident;
}

async function reportDeletedAccountSubscriptionCheckoutPayment(
  result,
  data,
  {
    requestId = null,
    eventId = null,
    providerEventId = null,
    incidentReporter = reportIncident
  } = {}
) {
  if (
    result?.reason !== 'payment_after_account_deleted'
    || result?.status !== 'account_deleted_review'
    || result?.entitlementGranted !== false
    || result?.refundReviewRequired !== true
    || result?.withheldReason !== 'payment_after_account_deleted'
    || !isUuid(result?.authorizedUserId)
    || result?.userId != null
    || ![true, false].includes(result?.applied)
    || result?.transactionId !== data?.id
    || result?.subscriptionId !== data?.subscription_id
  ) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_ACCOUNT_DELETED_OUTCOME_INVALID',
      'Deleted-account subscription payment returned an invalid outcome'
    );
  }

  const incident = await incidentReporter({
    severity: 'critical',
    source: 'paddle-webhook',
    eventCode:
      'SUBSCRIPTION_CHECKOUT_ACCOUNT_DELETED_PAYMENT_REFUND_REVIEW_REQUIRED',
    message: 'A subscription payment arrived after its PromptGen account was deleted',
    fingerprint:
      `paddle-webhook:SUBSCRIPTION_CHECKOUT_ACCOUNT_DELETED_PAYMENT_REFUND_REVIEW_REQUIRED:${data.id}`,
    context: {
      requestId,
      eventId,
      providerEventId,
      transactionId: data.id,
      subscriptionId: data.subscription_id,
      customerId: data.customer_id || null,
      attemptId: result.verifiedAttemptId || null,
      authorizedUserId: result.authorizedUserId,
      userId: null,
      plan: result.verifiedPlan || null,
      entitlementGranted: false,
      refundReviewRequired: true,
      withheldReason: result.withheldReason,
      receiptInserted: result.applied === true
    }
  });

  if (incident?.persisted !== true) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_ACCOUNT_DELETED_INCIDENT_PERSIST_FAILED',
      'Deleted-account subscription payment incident could not be persisted'
    );
  }

  return incident;
}

async function resolveExistingSubscriptionOwner(
  supabase,
  { subscriptionId, customerId }
) {
  if (!subscriptionId || !customerId) return null;

  const { data: state, error: stateError } = await supabase
    .from('paddle_subscription_states')
    .select('user_id, customer_id')
    .eq('subscription_id', subscriptionId)
    .single();
  if (
    stateError
    || !state?.user_id
    || (state.customer_id && state.customer_id !== customerId)
  ) {
    return null;
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, paddle_customer_id, paddle_subscription_id')
    .eq('id', state.user_id)
    .single();
  if (
    profileError
    || !profile?.id
    || (
      profile.paddle_customer_id
      && profile.paddle_customer_id !== customerId
    )
  ) {
    return null;
  }
  // A trusted historical state row may belong to a subscription that has since
  // been replaced on the profile. Return its owner so the ordered reducer can
  // record the payment/snapshot and atomically withhold current entitlement.
  return profile.id;
}

async function resolveSubscriptionSnapshotOwner(supabase, data, plan) {
  const subscriptionId = data?.id;
  const customerId = data?.customer_id;
  const priceId = data?.items?.[0]?.price?.id;
  const existingOwner = await resolveExistingSubscriptionOwner(supabase, {
    subscriptionId,
    customerId
  });
  if (existingOwner) return existingOwner;

  const attempt = await findCompletedSubscriptionCheckoutAttemptBySubscriptionId(
    supabase,
    subscriptionId
  );
  if (!attempt) return null;
  if (
    attempt.subscription_id !== subscriptionId
    || attempt.customer_id !== customerId
    || attempt.target_plan !== plan
    || attempt.price_id !== priceId
    || attempt.expected_origin !== 'api'
    || attempt.status !== 'completed'
  ) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_RESOLUTION_CONFLICT',
      'Subscription snapshot conflicts with its server-bound checkout'
    );
  }

  const { data: result, error } = await supabase.rpc(
    'resolve_completed_subscription_checkout',
    {
      p_attempt_id: attempt.attempt_id,
      p_subscription_id: subscriptionId,
      p_customer_id: customerId,
      p_plan: plan,
      p_price_id: priceId
    }
  );
  if (error || !result?.userId) {
    throw webhookProcessingError(
      'SUBSCRIPTION_CHECKOUT_NOT_COMPLETED',
      'Subscription snapshot has no completed server-bound checkout'
    );
  }
  return result.userId;
}

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
//   'grant'  → a renewal for an already server-bound subscription
//   'defer'  → plan change (subscription_update): credit handling deferred to a
//              later step; plan itself is synced via the subscription.updated event
//   'reject' → a browser-created initial checkout that has no server attempt
//   'ignore' → not credit-related (payment-method change, unknown)
// API-origin initial purchases are validated and consumed through the checkout
// attempt RPC before this classifier runs.
function classifyTransactionOrigin(origin) {
  if (origin === 'subscription_update') return 'defer';
  if (origin === 'subscription_recurring') return 'grant';
  if (origin === 'checkout' || origin === 'web') return 'reject';
  return 'ignore';
}

function classifyCompletedTransactionRoute(
  data,
  {
    hasCheckoutAttempt = false,
    env = process.env
  } = {}
) {
  const originDecision = classifyTransactionOrigin(data?.origin);
  const subscriptionCheckoutMarked = hasSubscriptionCheckoutMarker(data);
  const creditPackMarked = hasCreditPackMarker(data);

  // Paddle may inherit the initial transaction custom_data onto renewals and
  // subscription updates. Origin is authoritative for those events, so the
  // inherited marker must never route them back through initial checkout.
  if (originDecision === 'grant') {
    return creditPackMarked
      ? 'invalid_promptgen_transaction'
      : 'subscription_recurring';
  }
  if (originDecision === 'defer') {
    return creditPackMarked
      ? 'invalid_promptgen_transaction'
      : 'subscription_update';
  }
  if (originDecision === 'reject') return 'direct_checkout_rejected';

  if (data?.origin === 'subscription_charge') {
    if (creditPackMarked) {
      const packKey = data?.items?.[0]?.price?.custom_data?.promptgenPackKey;
      return getCreditPack(packKey)
        ? 'credit_pack'
        : 'invalid_promptgen_transaction';
    }
    return subscriptionCheckoutMarked
      ? 'invalid_promptgen_transaction'
      : 'unbound_subscription_charge';
  }

  if (data?.origin === 'api') {
    if (creditPackMarked) return 'invalid_promptgen_transaction';
    if (hasCheckoutAttempt) return 'subscription_checkout';
    const knownPlan = priceIdToPlan(data?.items?.[0]?.price?.id, env);
    return (
      knownPlan
      || subscriptionCheckoutMarked
      || creditPackMarked
    )
      ? 'invalid_promptgen_transaction'
      : 'ignore';
  }

  return (subscriptionCheckoutMarked || creditPackMarked)
    ? 'invalid_promptgen_transaction'
    : 'ignore';
}

async function reportUnboundSubscriptionCharge(
  data,
  {
    requestId = null,
    eventId = null,
    providerEventId = null,
    incidentReporter = reportIncident
  } = {}
) {
  const transactionId = data?.id || null;
  const context = {
    requestId,
    eventId,
    providerEventId,
    transactionId,
    customerId: data?.customer_id || null,
    subscriptionId: data?.subscription_id || null,
    origin: data?.origin || null,
    itemCount: Array.isArray(data?.items) ? data.items.length : 0,
    entitlementGranted: false,
    purchaseReviewRequired: true
  };

  console.error(
    '[paddle/webhook] [CRITICAL] Markerless subscription charge withheld |',
    'transaction_id=' + (transactionId || 'n/a'),
    '| event_id=' + (providerEventId || eventId || 'n/a'),
    '| subscription_id=' + (context.subscriptionId || 'n/a')
  );

  const incident = await incidentReporter({
    severity: 'critical',
    source: 'paddle-webhook',
    eventCode: 'UNBOUND_SUBSCRIPTION_CHARGE',
    message: 'A markerless subscription charge was withheld for manual review',
    fingerprint:
      `paddle-webhook:UNBOUND_SUBSCRIPTION_CHARGE:${transactionId || providerEventId || eventId || 'unknown'}`,
    context
  });

  // Do not ACK the provider event until the review-required incident is
  // durable. Throwing leaves the webhook inbox retryable without granting any
  // entitlement.
  if (incident?.persisted !== true) {
    throw webhookProcessingError(
      'UNBOUND_SUBSCRIPTION_CHARGE_INCIDENT_PERSIST_FAILED',
      'Markerless subscription charge incident could not be persisted'
    );
  }
}

/* ── Reset credits on each subscription payment (initial + renewals) ── */
// Subscription (reset, no rollover): Paddle fires transaction.completed every
// billing cycle. The ordered wrapper locks the subscription lifecycle row before
// recording the immutable payment. A terminal subscription still records the
// transaction, but can never restore its entitlement.
async function grantCreditsForPurchase(
  supabase,
  transactionId,
  userId,
  plan,
  subscriptionId,
  customerId,
  {
    incidentReporter = reportIncident,
    requestId = null,
    notificationId = null,
    occurredAt = null
  } = {}
) {
  const credits = PLAN_CREDITS[plan] || 0;
  const skipCreditMutation = isTestAccount(userId);

  if (!subscriptionId || typeof subscriptionId !== 'string') {
    throw webhookProcessingError(
      'PAYMENT_SUBSCRIPTION_ID_MISSING',
      'Completed subscription payment is missing a subscription ID'
    );
  }
  if (!customerId || typeof customerId !== 'string') {
    throw webhookProcessingError(
      'PAYMENT_CUSTOMER_ID_MISSING',
      'Completed subscription payment is missing a customer ID'
    );
  }
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    throw webhookProcessingError(
      'PAYMENT_OCCURRED_AT_MISSING',
      'Completed subscription payment is missing a valid occurred_at'
    );
  }

  const { data: result, error } = await supabase.rpc('apply_ordered_subscription_payment', {
    p_transaction_id: transactionId,
    p_user_id: userId,
    p_plan: plan,
    p_amount: credits,
    p_subscription_id: subscriptionId,
    p_customer_id: customerId,
    p_occurred_at: occurredAt,
    p_skip_entitlement_mutation: skipCreditMutation
  });

  if (error) {
    throw new Error('apply_ordered_subscription_payment RPC failed: ' + error.message);
  }
  if (!result || typeof result.reason !== 'string') {
    throw new Error('apply_ordered_subscription_payment returned an invalid outcome');
  }

  if (result.reason === 'terminal_subscription') {
    console.error(
      '[paddle/webhook] [CRITICAL] Terminal subscription payment recorded without entitlement |',
      'transaction_id=' + transactionId,
      '| subscription_id=' + subscriptionId,
      '| userId=' + userId
    );
    await incidentReporter({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'TERMINAL_SUBSCRIPTION_PAYMENT_WITHHELD',
      message: 'A subscription payment was recorded after the subscription became terminal',
      fingerprint: `paddle-webhook:TERMINAL_SUBSCRIPTION_PAYMENT_WITHHELD:${transactionId}`,
      context: {
        requestId,
        notificationId,
        transactionId,
        subscriptionId,
        customerId,
        userId,
        plan,
        ledgerRecorded: true,
        entitlementGranted: false
      }
    });
    return result;
  }

  if (result.reason === 'superseded_subscription') {
    console.error(
      '[paddle/webhook] [CRITICAL] Superseded subscription payment recorded without entitlement |',
      'transaction_id=' + transactionId,
      '| subscription_id=' + subscriptionId,
      '| userId=' + userId
    );
    await incidentReporter({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'SUPERSEDED_SUBSCRIPTION_PAYMENT_WITHHELD',
      message: 'A payment for a superseded subscription was recorded without changing the current entitlement',
      fingerprint: `paddle-webhook:SUPERSEDED_SUBSCRIPTION_PAYMENT_WITHHELD:${transactionId}`,
      context: {
        requestId,
        notificationId,
        transactionId,
        subscriptionId,
        customerId,
        userId,
        plan,
        ledgerRecorded: true,
        entitlementGranted: false
      }
    });
    return result;
  }

  if (
    result.reason === 'stale_payment'
    || result.reason === 'ambiguous_payment_order'
  ) {
    const stale = result.reason === 'stale_payment';
    const eventCode = stale
      ? 'STALE_SUBSCRIPTION_PAYMENT_WITHHELD'
      : 'AMBIGUOUS_SUBSCRIPTION_PAYMENT_WITHHELD';
    console.error(
      '[paddle/webhook] [CRITICAL] Out-of-order subscription payment recorded without entitlement |',
      'reason=' + result.reason,
      '| transaction_id=' + transactionId,
      '| subscription_id=' + subscriptionId,
      '| userId=' + userId
    );
    await incidentReporter({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode,
      message: stale
        ? 'An older subscription payment was recorded without resetting current entitlement'
        : 'Equal-time subscription payments require reconciliation and did not change entitlement',
      fingerprint: `paddle-webhook:${eventCode}:${transactionId}`,
      context: {
        requestId,
        notificationId,
        transactionId,
        subscriptionId,
        customerId,
        userId,
        plan,
        occurredAt,
        ledgerRecorded: true,
        entitlementGranted: false
      }
    });
    return result;
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

/* ── Reduce subscription snapshots independently from transaction edges ── */
// Paddle does not guarantee webhook ordering. Subscription lifecycle snapshots
// therefore use a dedicated reducer instead of the immutable-event watermark
// used for transaction and adjustment IDs.
async function applyPaddleSubscriptionSnapshot(
  supabase,
  {
    subscriptionId,
    userId,
    customerId,
    status,
    plan,
    providerEventId,
    eventType,
    occurredAt
  },
  {
    incidentReporter = reportIncident,
    requestId = null,
    notificationId = null
  } = {}
) {
  const normalizedOccurredAt = parsePaddleOccurredAt(occurredAt);
  if (!subscriptionId || typeof subscriptionId !== 'string') {
    throw webhookProcessingError(
      'SUBSCRIPTION_ID_MISSING',
      'Subscription snapshot is missing a subscription ID'
    );
  }
  if (!providerEventId || typeof providerEventId !== 'string' || providerEventId.length > 255) {
    throw webhookProcessingError(
      'SUBSCRIPTION_EVENT_ID_INVALID',
      'Subscription snapshot is missing a valid Paddle event ID'
    );
  }
  if (!normalizedOccurredAt) {
    throw webhookProcessingError(
      'SUBSCRIPTION_OCCURRED_AT_INVALID',
      'Subscription snapshot is missing a valid occurred_at timestamp'
    );
  }
  if (!['active', 'trialing', 'past_due', 'paused', 'canceled'].includes(status)) {
    throw webhookProcessingError(
      'SUBSCRIPTION_STATUS_UNSUPPORTED',
      'Subscription snapshot has an unsupported lifecycle status'
    );
  }
  if (isActiveSubscription(status) && (!plan || !PLAN_CREDITS[plan])) {
    throw webhookProcessingError(
      'SUBSCRIPTION_PLAN_UNMAPPED',
      'Active subscription snapshot did not map to a PromptGen plan'
    );
  }

  const skipEntitlementMutation = isTestAccount(userId);
  const { data: result, error } = await supabase.rpc('apply_paddle_subscription_snapshot', {
    p_subscription_id: subscriptionId,
    p_user_id: userId,
    p_customer_id: customerId || null,
    p_status: status,
    p_plan: plan || null,
    p_allotment: isActiveSubscription(status) ? PLAN_CREDITS[plan] : 0,
    p_provider_event_id: providerEventId,
    p_event_type: eventType,
    p_occurred_at: normalizedOccurredAt,
    p_skip_entitlement_mutation: skipEntitlementMutation
  });

  if (error) {
    throw new Error('apply_paddle_subscription_snapshot RPC failed: ' + error.message);
  }
  const acceptedReasons = new Set([
    'duplicate',
    'stale',
    'cancellation_recorded_entitlement_skipped',
    'cancellation_recorded_superseded_subscription',
    'subscription_canceled',
    'terminal_subscription',
    'snapshot_recorded_entitlement_skipped',
    'snapshot_recorded_superseded_subscription',
    'subscription_entitlement_applied',
    'entitlement_preserved',
    'reconciliation_required'
  ]);
  if (!result || !acceptedReasons.has(result.reason)) {
    throw new Error('apply_paddle_subscription_snapshot returned an invalid outcome');
  }

  if (result.reason === 'terminal_subscription') {
    console.error(
      '[paddle/webhook] [CRITICAL] Terminal subscription snapshot refused entitlement revival |',
      'subscription_id=' + subscriptionId,
      '| status=' + status,
      '| event_id=' + providerEventId
    );
    await incidentReporter({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'TERMINAL_SUBSCRIPTION_SNAPSHOT_IGNORED',
      message: 'A non-canceled subscription snapshot arrived after terminal cancellation',
      fingerprint: `paddle-webhook:TERMINAL_SUBSCRIPTION_SNAPSHOT_IGNORED:${subscriptionId}:${providerEventId}`,
      context: {
        requestId,
        notificationId,
        providerEventId,
        eventType,
        occurredAt: normalizedOccurredAt,
        subscriptionId,
        customerId: customerId || null,
        userId,
        status,
        plan: plan || null
      }
    });
  }
  if (result.reason === 'reconciliation_required') {
    console.error(
      '[paddle/webhook] [CRITICAL] Equal-time subscription snapshots conflict |',
      'subscription_id=' + subscriptionId,
      '| status=' + status,
      '| event_id=' + providerEventId
    );
    await incidentReporter({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'SUBSCRIPTION_SNAPSHOT_RECONCILIATION_REQUIRED',
      message: 'Conflicting subscription snapshots share the same occurred_at timestamp',
      fingerprint:
        `paddle-webhook:SUBSCRIPTION_SNAPSHOT_RECONCILIATION_REQUIRED:${subscriptionId}:${providerEventId}`,
      context: {
        requestId,
        notificationId,
        providerEventId,
        eventType,
        occurredAt: normalizedOccurredAt,
        subscriptionId,
        customerId: customerId || null,
        userId,
        status,
        plan: plan || null
      }
    });
  }

  return result;
}

/* ── Record plan-upgrade transaction in purchases ledger (defer branch) ── */
// Inserts a ledger row for a plan-change transaction. Credits are NOT touched here —
// the ordered subscription snapshot reducer handles recalculation exclusively.
// UNIQUE(transaction_id) 23505 = idempotent skip (safe for Paddle re-delivery).
async function recordPlanUpgradePurchase(supabase, { transactionId, userId, plan, subscriptionId }) {
  const credits = PLAN_CREDITS[plan] || 0;
  const expected = {
    transaction_id: transactionId,
    user_id: userId,
    plan,
    credits_granted: credits,
    status: 'completed',
    subscription_id: subscriptionId || null,
    transaction_type: 'plan_upgrade'
  };
  const { error } = await supabase
    .from('purchases')
    .insert(expected);

  if (error) {
    if (error.code === '23505') {
      const { data: existing, error: lookupError } = await supabase
        .from('purchases')
        .select(
          'transaction_id, user_id, plan, credits_granted, status, subscription_id, transaction_type'
        )
        .eq('transaction_id', transactionId)
        .single();
      const contractMatches = !lookupError
        && existing
        && Object.keys(expected).every(function (key) {
          return existing[key] === expected[key];
        });
      if (!contractMatches) {
        throw new Error(
          'Plan upgrade duplicate contract conflict for transaction_id=' + transactionId
        );
      }
      console.log(
        '[paddle/webhook] Validated duplicate plan_upgrade for transaction_id=' +
        transactionId + ', skipping'
      );
      return existing;
    }
    throw new Error('Failed to record plan_upgrade purchase: ' + error.message);
  }

  console.log('[paddle/webhook] Recorded plan_upgrade: transaction_id=' + transactionId + ' plan=' + plan + ' userId=' + userId);
  return expected;
}

async function applyCreditPackAdjustment(
  supabase,
  data,
  { providerEventId = null, occurredAt = null } = {}
) {
  if (!isCreditLedgerV2Enabled()) {
    return { matched: false, applied: false, reason: 'ledger_disabled' };
  }

  const adjustmentId = data?.id;
  const transactionId = data?.transaction_id;
  if (!adjustmentId || !transactionId) {
    return { matched: false, applied: false, reason: 'missing_identity' };
  }
  const normalizedOccurredAt = parsePaddleOccurredAt(occurredAt);
  if (
    typeof providerEventId !== 'string'
    || !providerEventId.trim()
    || providerEventId.length > 255
    || !normalizedOccurredAt
  ) {
    throw new Error('Credit-pack adjustment is missing valid provider evidence');
  }

  const { data: result, error } = await supabase.rpc('apply_credit_pack_adjustment_v2', {
    p_adjustment_id: adjustmentId,
    p_provider_event_id: providerEventId.trim(),
    p_transaction_id: transactionId,
    p_action: data?.action || 'unknown',
    p_adjustment_type: data?.type || null,
    p_status: data?.status || 'unknown',
    p_occurred_at: normalizedOccurredAt
  });

  if (error) {
    throw new Error('apply_credit_pack_adjustment_v2 RPC failed: ' + error.message);
  }
  if (!result?.matched) {
    return result || { matched: false, applied: false };
  }

  if (result.reviewRequired) {
    await reportIncident({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'CREDIT_PACK_ADJUSTMENT_REQUIRES_REVIEW',
      message: 'A credit-pack adjustment requires manual credit reconciliation',
      fingerprint: `paddle-webhook:CREDIT_PACK_ADJUSTMENT_REQUIRES_REVIEW:${adjustmentId}`,
      context: {
        adjustmentId,
        transactionId,
        action: data?.action || null,
        adjustmentType: data?.type || null,
        status: data?.status || null,
        unrecoveredCredits: result.unrecoveredCredits || 0,
        userId: result.userId || null
      }
    });
  }

  console.log(
    '[paddle/webhook] Credit-pack adjustment handled transaction=' + transactionId +
    ' action=' + (data?.action || 'unknown') +
    ' status=' + (data?.status || 'unknown') +
    ' result=' + (result.reason || 'unknown')
  );
  return result;
}

// Paddle exposes chargeback lifecycle events through adjustment.data.action.
// A reversal may arrive either as its own *_reverse adjustment or as an update
// that marks the original adjustment status as reversed. Neither shape is safe
// to translate into an entitlement mutation without source-aware reconciliation.
const PADDLE_CHARGEBACK_ADJUSTMENT_ACTIONS = Object.freeze({
  chargeback: Object.freeze({ family: 'chargeback', isWarning: false, reverseAction: false }),
  chargeback_warning: Object.freeze({ family: 'chargeback_warning', isWarning: true, reverseAction: false }),
  chargeback_reverse: Object.freeze({ family: 'chargeback', isWarning: false, reverseAction: true }),
  chargeback_warning_reverse: Object.freeze({ family: 'chargeback_warning', isWarning: true, reverseAction: true })
});

function classifyChargebackAdjustment(data) {
  const action = data?.action;
  const definition = PADDLE_CHARGEBACK_ADJUSTMENT_ACTIONS[action];
  if (!definition) return null;

  const reversedStatus = data?.status === 'reversed';
  return {
    action,
    family: definition.family,
    isWarning: definition.isWarning,
    isReversal: definition.reverseAction || reversedStatus,
    reversalSource: definition.reverseAction
      ? 'reverse_action'
      : (reversedStatus ? 'reversed_status' : null)
  };
}

async function reportNonCreditPackChargebackAdjustment(
  data,
  {
    requestId = null,
    eventId = null,
    providerEventId = null,
    eventType = null,
    occurredAt = null,
    incidentReporter = reportIncident
  } = {}
) {
  const classification = classifyChargebackAdjustment(data);
  if (!classification) return { handled: false };

  const adjustmentId = data?.id || null;
  const transactionId = data?.transaction_id || null;
  const subscriptionId = data?.subscription_id || null;
  const incidentIdentity = adjustmentId || transactionId || providerEventId || eventId || 'unknown';
  const incidentState = classification.isReversal ? 'reversal' : 'forward';
  const incident = await incidentReporter({
    severity: 'critical',
    source: 'paddle-webhook',
    eventCode: 'NON_CREDIT_PACK_CHARGEBACK_REQUIRES_REVIEW',
    message: 'A non-credit-pack chargeback-family adjustment requires manual review',
    fingerprint:
      `paddle-webhook:NON_CREDIT_PACK_CHARGEBACK_REQUIRES_REVIEW:${incidentIdentity}:${classification.action}:${incidentState}`,
    context: {
      requestId,
      eventId,
      providerEventId,
      eventType,
      occurredAt,
      adjustmentId,
      transactionId,
      subscriptionId,
      customerId: data?.customer_id || null,
      action: classification.action,
      adjustmentType: data?.type || null,
      status: data?.status || null,
      family: classification.family,
      isWarning: classification.isWarning,
      isReversal: classification.isReversal,
      reversalSource: classification.reversalSource,
      manualReviewRequired: true,
      creditMutationApplied: false,
      entitlementMutationApplied: false
    }
  });

  // The event must remain retryable until the idempotent incident fingerprint
  // is durable. No credit debit or entitlement restoration occurs on this path.
  if (incident?.persisted !== true) {
    throw webhookProcessingError(
      'NON_CREDIT_PACK_CHARGEBACK_INCIDENT_PERSIST_FAILED',
      'Non-credit-pack chargeback incident could not be persisted'
    );
  }

  console.error(
    '[paddle/webhook] [CRITICAL] Non-credit-pack chargeback held for manual review |',
    'adjustment_id=' + (adjustmentId || 'n/a'),
    '| transaction_id=' + (transactionId || 'n/a'),
    '| subscription_id=' + (subscriptionId || 'n/a'),
    '| action=' + classification.action
  );
  return { handled: true, manualReviewRequired: true, classification };
}

async function handleNonCreditPackAdjustment(
  supabase,
  data,
  {
    refundHandler = revokeCreditsForRefund,
    ...incidentOptions
  } = {}
) {
  const chargebackReview = await reportNonCreditPackChargebackAdjustment(
    data,
    incidentOptions
  );
  if (chargebackReview.handled) return chargebackReview;

  const action = data?.action;
  const status = data?.status;
  const transactionId = data?.transaction_id;

  // Preserve the existing approved refund/credit behavior unchanged.
  if (action !== 'refund' && action !== 'credit') {
    console.log('[paddle/webhook] Adjustment action \'' + action + '\' is not a refund/credit, ignoring');
    return { handled: false, reason: 'unsupported_action' };
  }
  if (status !== 'approved') {
    console.log('[paddle/webhook] Adjustment status \'' + status + '\' is not approved, ignoring');
    return { handled: false, reason: 'not_approved' };
  }
  if (!transactionId) {
    console.error('[paddle/webhook] No transaction_id in adjustment payload — cannot process refund');
    throw webhookProcessingError(
      'REFUND_TRANSACTION_ID_MISSING',
      'Approved refund is missing a transaction ID'
    );
  }

  const result = await refundHandler(supabase, transactionId, data?.type);
  return { handled: true, reason: 'refund_or_credit_applied', result };
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
    if (!isCreditLedgerV2Enabled()) {
      throw webhookProcessingError(
        'PLAN_CHANGE_REFUND_LEDGER_REQUIRED',
        'Plan-change refunds require the source-aware credit ledger'
      );
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

    if (result?.reason === 'manual_review_required') {
      console.error(
        '[paddle/webhook] [CRITICAL] plan_upgrade refund requires immutable-snapshot review |',
        'transaction_id=' + transactionId,
        '| userId=' + purchase.user_id,
        '| reason=' + (result.reviewReason || 'unknown')
      );
      await reportIncident({
        severity: 'critical',
        source: 'paddle-webhook',
        eventCode: 'PLAN_CHANGE_REFUND_REQUIRES_REVIEW',
        message: 'A refunded plan change cannot be restored without an immutable pre-change credit snapshot',
        fingerprint: `paddle-webhook:PLAN_CHANGE_REFUND_REQUIRES_REVIEW:${transactionId}`,
        context: {
          transactionId,
          userId: purchase.user_id,
          reviewReason: result.reviewReason || 'unknown',
          currentCredits: result.newBalance
        }
      });
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
    } else if (result?.reason === 'duplicate') {
      console.log('[paddle/webhook] Plan-change refund already recorded: ' + transactionId);
    } else {
      throw webhookProcessingError(
        'PLAN_CHANGE_REFUND_RESULT_INVALID',
        'Plan-change refund returned an unsupported reconciliation result'
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
  } else if (result?.reason === 'credits_used' || result?.reason === 'purchase_lot_missing') {
    console.error(
      '[paddle/webhook] [CRITICAL] Subscription refund requires manual credit review |',
      'transaction_id=' + transactionId,
      '| userId=' + purchase.user_id,
      '| reason=' + result.reason
    );
    await reportIncident({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'SUBSCRIPTION_REFUND_REQUIRES_REVIEW',
      message: 'A subscription refund could not be reconciled automatically',
      fingerprint: `paddle-webhook:SUBSCRIPTION_REFUND_REQUIRES_REVIEW:${transactionId}`,
      context: {
        transactionId,
        userId: purchase.user_id,
        reason: result.reason,
        grantedCredits: purchase.credits_granted,
        currentCredits: result.newBalance
      }
    });
  } else if (result?.reason === 'superseded_payment_refunded') {
    console.log(
      '[paddle/webhook] Historical subscription payment refunded without touching the current credit lot ' +
      'transaction=' + transactionId + ' userId=' + purchase.user_id
    );
  } else {
    console.log('[paddle/webhook] Revoked ' + purchase.credits_granted + ' credits from userId=' + purchase.user_id + ' for refunded transaction=' + transactionId);
  }
  return result;
}

const WEBHOOK_LEASE_SECONDS = 300;

function getPaddleOrderingTarget(payload) {
  const eventType = payload?.event_type;
  const data = payload?.data;

  if (eventType === 'transaction.completed') {
    return data?.id
      ? { entityType: 'transaction', entityId: data.id }
      : { invalid: true };
  }

  if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') {
    return data?.id
      ? { entityType: 'adjustment', entityId: data.id }
      : { invalid: true };
  }

  return null;
}

function parsePaddleOccurredAt(value) {
  return parsePaddleTimestamp(value);
}

async function claimPaddleEventOrder(supabase, payload, claimToken) {
  const target = getPaddleOrderingTarget(payload);
  if (!target) return { outcome: 'not_required' };
  if (target.invalid) return { outcome: 'invalid' };

  const providerEventId = payload?.event_id;
  const occurredAt = parsePaddleOccurredAt(payload?.occurred_at);
  if (
    typeof providerEventId !== 'string'
    || !providerEventId.trim()
    || providerEventId.length > 255
    || !occurredAt
  ) {
    return { outcome: 'invalid' };
  }

  const { data, error } = await supabase.rpc('claim_paddle_event_order', {
    p_provider_event_id: providerEventId,
    p_event_type: payload.event_type,
    p_entity_type: target.entityType,
    p_entity_id: target.entityId,
    p_occurred_at: occurredAt,
    p_claim_token: claimToken,
    p_lease_seconds: WEBHOOK_LEASE_SECONDS
  });
  if (error) {
    throw new Error('claim_paddle_event_order RPC failed: ' + error.message);
  }
  if (!data || !['claimed', 'completed', 'stale', 'busy', 'ambiguous'].includes(data.outcome)) {
    throw new Error('claim_paddle_event_order returned an invalid outcome');
  }
  return { ...data, target, providerEventId };
}

async function completePaddleEventOrder(supabase, ordering, claimToken) {
  if (ordering?.outcome !== 'claimed') return;
  const { data, error } = await supabase.rpc('complete_paddle_event_order', {
    p_entity_type: ordering.target.entityType,
    p_entity_id: ordering.target.entityId,
    p_provider_event_id: ordering.providerEventId,
    p_claim_token: claimToken
  });
  if (error) {
    throw new Error('complete_paddle_event_order RPC failed: ' + error.message);
  }
  if (data !== true) {
    throw webhookProcessingError(
      'PADDLE_ORDER_CLAIM_LOST',
      'Paddle event ordering claim was lost before completion'
    );
  }
}

async function failPaddleEventOrder(supabase, ordering, claimToken) {
  if (ordering?.outcome !== 'claimed') return true;
  const { data, error } = await supabase.rpc('fail_paddle_event_order', {
    p_entity_type: ordering.target.entityType,
    p_entity_id: ordering.target.entityId,
    p_provider_event_id: ordering.providerEventId,
    p_claim_token: claimToken
  });
  if (error) {
    throw new Error('fail_paddle_event_order RPC failed: ' + error.message);
  }
  return data === true;
}

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

  let ordering;
  try {
    ordering = await claimPaddleEventOrder(supabase, payload, claimToken);
  } catch (error) {
    console.error('[paddle/webhook] Failed to claim event order:', eventId, '—', error.message);
    try {
      await failPaddleWebhookEvent(supabase, eventId, claimToken, error);
    } catch (failError) {
      console.error('[paddle/webhook] Failed to persist ordering-claim failure:', eventId, '—', failError.message);
    }
    await incidentReporter({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'PADDLE_EVENT_ORDER_CLAIM_FAILED',
      message: error.message,
      fingerprint: `paddle-webhook:PADDLE_EVENT_ORDER_CLAIM_FAILED:${eventId}`,
      context: {
        requestId,
        eventId,
        providerEventId: payload?.event_id || null,
        eventType,
        error
      }
    });
    return {
      statusCode: 503,
      body: 'Webhook temporarily unavailable',
      outcome: 'order_claim_failed',
      retryAfter: '5'
    };
  }

  if (ordering.outcome === 'invalid') {
    const error = webhookProcessingError(
      'PADDLE_EVENT_ORDER_METADATA_INVALID',
      'Ordered Paddle event is missing a valid event_id, occurred_at, or entity identifier'
    );
    await failPaddleWebhookEvent(supabase, eventId, claimToken, error).catch(() => false);
    await incidentReporter({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: error.code,
      message: error.message,
      fingerprint: `paddle-webhook:${error.code}:${eventId}`,
      context: {
        requestId,
        eventId,
        providerEventId: payload?.event_id || null,
        occurredAt: payload?.occurred_at || null,
        eventType
      }
    });
    return { statusCode: 500, body: 'Internal error', outcome: 'invalid_order_metadata' };
  }

  if (ordering.outcome === 'ambiguous') {
    const error = webhookProcessingError(
      'PADDLE_EVENT_ORDER_AMBIGUOUS',
      'Paddle events have an ambiguous immutable-entity order and require reconciliation'
    );
    await failPaddleWebhookEvent(supabase, eventId, claimToken, error).catch(() => false);
    await incidentReporter({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: error.code,
      message: error.message,
      fingerprint: `paddle-webhook:${error.code}:${ordering.target?.entityType || 'unknown'}:${ordering.target?.entityId || eventId}`,
      context: {
        requestId,
        eventId,
        providerEventId: payload?.event_id || null,
        eventType,
        entityType: ordering.target?.entityType || null,
        entityId: ordering.target?.entityId || null,
        lastEventId: ordering.lastEventId || null,
        lastOccurredAt: ordering.lastOccurredAt || null,
        pendingEventId: ordering.pendingEventId || null,
        pendingOccurredAt: ordering.pendingOccurredAt || null,
        reconciliationRequired: ordering.reconciliationRequired === true
      }
    });
    return {
      statusCode: 503,
      body: 'Webhook reconciliation required',
      outcome: 'order_ambiguous',
      retryAfter: '30'
    };
  }

  if (ordering.outcome === 'busy') {
    const leaseExpired = ordering.leaseExpired === true;
    const error = webhookProcessingError(
      leaseExpired ? 'PADDLE_EVENT_ORDER_LEASE_EXPIRED' : 'PADDLE_ENTITY_EVENT_BUSY',
      leaseExpired
        ? 'A Paddle event ordering lease expired and requires operator reconciliation'
        : 'A related Paddle entity event is still processing'
    );
    await failPaddleWebhookEvent(supabase, eventId, claimToken, error).catch(() => false);
    if (leaseExpired) {
      await incidentReporter({
        severity: 'critical',
        source: 'paddle-webhook',
        eventCode: error.code,
        message: error.message,
        fingerprint: `paddle-webhook:${error.code}:${ordering.target?.entityType || 'unknown'}:${ordering.target?.entityId || eventId}`,
        context: {
          requestId,
          eventId,
          providerEventId: payload?.event_id || null,
          eventType,
          entityType: ordering.target?.entityType || null,
          entityId: ordering.target?.entityId || null,
          pendingEventId: ordering.pendingEventId || null,
          pendingClaimedAt: ordering.pendingClaimedAt || null,
          leaseExpiresAt: ordering.leaseExpiresAt || null,
          leaseExpired: true
        }
      });
    }
    return {
      statusCode: 503,
      body: leaseExpired
        ? 'Webhook reconciliation required'
        : 'Related event already processing',
      outcome: leaseExpired ? 'order_lease_expired' : 'order_busy',
      retryAfter: leaseExpired ? '30' : '5'
    };
  }

  if (ordering.outcome === 'stale' || ordering.outcome === 'completed') {
    console.log(
      '[paddle/webhook] Ignoring stale/semantic duplicate event:',
      payload?.event_id,
      '| notification:',
      eventId
    );
    await completePaddleWebhookEvent(supabase, eventId, claimToken);
    return {
      statusCode: 200,
      body: 'OK',
      outcome: ordering.outcome === 'stale' ? 'stale' : 'semantic_duplicate'
    };
  }

  try {
    await processEvent();
    await completePaddleEventOrder(supabase, ordering, claimToken);
    await completePaddleWebhookEvent(supabase, eventId, claimToken);
    return { statusCode: 200, body: 'OK', outcome: 'completed' };
  } catch (error) {
    console.error('[paddle/webhook] Error processing event:', eventType, '—', error.message);
    try {
      const released = await failPaddleEventOrder(supabase, ordering, claimToken);
      if (!released) {
        console.error('[paddle/webhook] Could not release event ordering claim:', eventId);
      }
    } catch (orderFailError) {
      console.error('[paddle/webhook] Failed to release event ordering claim:', eventId, '—', orderFailError.message);
    }
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
      context: {
        requestId,
        eventId,
        providerEventId: payload?.event_id || null,
        eventType,
        error
      }
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
        const priceId = data?.items?.[0]?.price?.id;
        const creditPackMetadata = data?.items?.[0]?.price?.custom_data;
        const creditPack = creditPackMetadata?.promptgenKind === 'credit_pack'
          ? getCreditPack(creditPackMetadata?.promptgenPackKey)
          : null;
        let checkoutAttempt = null;
        if (data?.origin === 'api') {
          checkoutAttempt = await findSubscriptionCheckoutAttemptByTransactionId(
            adminClient,
            transactionId
          );
          if (!checkoutAttempt) {
            checkoutAttempt =
              await findRecoverableSubscriptionCheckoutAttemptByMetadata(
                adminClient,
                data
              );
          }
        }
        const transactionRoute = classifyCompletedTransactionRoute(data, {
          hasCheckoutAttempt: Boolean(checkoutAttempt)
        });

        // Credit packs are immediate one-time charges attached to an existing
        // active subscription. Their inline custom price carries an opaque,
        // server-created request ID; no reusable catalog Price ID is exposed.
        if (transactionRoute === 'credit_pack') {
          if (!creditPack) {
            await reportIncident({
              severity: 'critical',
              source: 'paddle-webhook',
              eventCode: 'CREDIT_PACK_TRANSACTION_INVALID',
              message: 'A completed transaction carried an unknown PromptGen credit-pack marker',
              fingerprint: `paddle-webhook:CREDIT_PACK_TRANSACTION_INVALID:${transactionId || eventId || 'unknown'}`,
              context: {
                requestId: req.id,
                eventId,
                transactionId,
                priceId,
                packKey: creditPackMetadata?.promptgenPackKey || null,
                reason: 'unknown_pack_key'
              }
            });
            throw webhookProcessingError(
              'CREDIT_PACK_TRANSACTION_INVALID',
              'Completed credit pack transaction has an unknown pack key'
            );
          }
          if (!isCreditLedgerV2Enabled()) {
            await reportIncident({
              severity: 'critical',
              source: 'paddle-webhook',
              eventCode: 'CREDIT_PACK_LEDGER_DISABLED',
              message: 'A paid credit pack arrived while the isolated ledger was disabled',
              fingerprint: `paddle-webhook:CREDIT_PACK_LEDGER_DISABLED:${transactionId || eventId || 'unknown'}`,
              context: {
                requestId: req.id,
                eventId,
                transactionId,
                priceId,
                purchaseRequestId:
                  creditPackMetadata?.promptgenPurchaseRequestId || null
              }
            });
            throw webhookProcessingError(
              'CREDIT_PACK_LEDGER_DISABLED',
              'Credit pack fulfillment is disabled'
            );
          }

          const validation = validateCompletedCreditPackTransaction(data, creditPack);
          if (!validation.valid) {
            await reportIncident({
              severity: 'critical',
              source: 'paddle-webhook',
              eventCode: 'CREDIT_PACK_TRANSACTION_INVALID',
              message: 'A completed credit pack transaction failed server contract validation',
              fingerprint: `paddle-webhook:CREDIT_PACK_TRANSACTION_INVALID:${transactionId || eventId || 'unknown'}`,
              context: {
                httpRequestId: req.id,
                eventId,
                transactionId,
                priceId,
                purchaseRequestId:
                  creditPackMetadata?.promptgenPurchaseRequestId || null,
                reason: validation.reason
              }
            });
            throw webhookProcessingError(
              'CREDIT_PACK_TRANSACTION_INVALID',
              'Completed credit pack transaction failed validation'
            );
          }

          await grantCreditsForPack(
            adminClient,
            data,
            creditPack,
            process.env,
            payload?.occurred_at,
            payload?.event_id
          );
          return;
        }

        if (transactionRoute === 'subscription_checkout') {
          const validation = validateCompletedSubscriptionCheckoutTransaction(
            data,
            checkoutAttempt
          );
          if (!validation.valid) {
            await reportIncident({
              severity: 'critical',
              source: 'paddle-webhook',
              eventCode: 'SUBSCRIPTION_CHECKOUT_TRANSACTION_INVALID',
              message: 'A completed subscription checkout failed the server-bound contract',
              fingerprint: `paddle-webhook:SUBSCRIPTION_CHECKOUT_TRANSACTION_INVALID:${transactionId || eventId || 'unknown'}`,
              context: {
                requestId: req.id,
                eventId,
                transactionId,
                subscriptionId: data?.subscription_id || null,
                customerId: data?.customer_id || null,
                origin: data?.origin || null,
                attemptId: checkoutAttempt?.attempt_id || null,
                reason: validation.reason
              }
            });
            throw webhookProcessingError(
              'SUBSCRIPTION_CHECKOUT_TRANSACTION_INVALID',
              'Completed subscription checkout failed validation'
            );
          }

          const result = await consumeSubscriptionCheckoutAttempt(
            adminClient,
            data,
            payload?.occurred_at,
            checkoutAttempt
          );
          if (result.reason === 'completed_before_account_deleted') {
            // This is an exact semantic replay of a transaction whose original
            // entitlement was already committed before account deletion. It is
            // neither a new purchase nor a refund-review event.
          } else if (result.reason === 'late_payment_after_reconciled_no_match') {
            await reportLateReconciledSubscriptionCheckoutPayment(
              result,
              data,
              {
                requestId: req.id,
                eventId,
                providerEventId: payload?.event_id
              }
            );
          } else if (result.reason === 'payment_after_account_deleted') {
            await reportDeletedAccountSubscriptionCheckoutPayment(
              result,
              data,
              {
                requestId: req.id,
                eventId,
                providerEventId: payload?.event_id
              }
            );
          } else if (result.reason === 'terminal_subscription') {
            await reportIncident({
              severity: 'critical',
              source: 'paddle-webhook',
              eventCode: 'TERMINAL_SUBSCRIPTION_PAYMENT_WITHHELD',
              message: 'A server-bound checkout completed after its subscription became terminal',
              fingerprint: `paddle-webhook:TERMINAL_SUBSCRIPTION_PAYMENT_WITHHELD:${transactionId}`,
              context: {
                requestId: req.id,
                eventId,
                transactionId,
                subscriptionId: data.subscription_id,
                customerId: data.customer_id,
                userId: result.userId,
                plan: result.verifiedPlan,
                attemptId: result.verifiedAttemptId,
                ledgerRecorded: true,
                entitlementGranted: false
              }
            });
          } else if (result.reason !== 'duplicate') {
            await recordServerEvent({
              eventName: 'purchase_completed',
              userId: result.userId,
              properties: {
                plan: result.verifiedPlan,
                creditsGranted: result.verifiedCredits,
                transactionType: 'subscription_payment'
              }
            });
          }
          return;
        }

        if (transactionRoute === 'invalid_promptgen_transaction') {
          const creditPackMarked = hasCreditPackMarker(data);
          const subscriptionCheckoutMarked = hasSubscriptionCheckoutMarker(data);
          const incidentCode = creditPackMarked
            ? 'CREDIT_PACK_TRANSACTION_INVALID'
            : 'SUBSCRIPTION_CHECKOUT_TRANSACTION_INVALID';
          await reportIncident({
            severity: 'critical',
            source: 'paddle-webhook',
            eventCode: incidentCode,
            message: 'A PromptGen-marked or known-plan transaction could not be server-bound',
            fingerprint: `paddle-webhook:${incidentCode}:${transactionId || eventId || 'unknown'}`,
            context: {
              requestId: req.id,
              eventId,
              transactionId,
              subscriptionId: data?.subscription_id || null,
              customerId: data?.customer_id || null,
              origin: data?.origin || null,
              priceId: priceId || null,
              subscriptionCheckoutMarked,
              creditPackMarked,
              entitlementGranted: false
            }
          });
          throw webhookProcessingError(
            incidentCode,
            'PromptGen transaction could not be matched to its server-bound request'
          );
        }

        if (transactionRoute === 'unbound_subscription_charge') {
          await reportUnboundSubscriptionCharge(data, {
            requestId: req.id,
            eventId,
            providerEventId: payload?.event_id
          });
          return;
        }

        const plan = (
          transactionRoute === 'subscription_update'
          || transactionRoute === 'subscription_recurring'
        )
          ? priceIdToPlan(priceId)
          : null;

        // Origin is evaluated before inherited custom_data. Initial API
        // checkouts are handled above from their server-bound transaction ID;
        // only renewals reach the grant path below.
        if (transactionRoute === 'direct_checkout_rejected') {
          console.error(
            '[paddle/webhook] [CRITICAL] Direct browser subscription checkout rejected |',
            'transaction_id=' + (transactionId || 'n/a'),
            '| origin=' + (data?.origin || 'n/a'),
            '| subscription_id=' + (data?.subscription_id || 'n/a')
          );
          await reportIncident({
            severity: 'critical',
            source: 'paddle-webhook',
            eventCode: 'UNBOUND_SUBSCRIPTION_CHECKOUT',
            message: 'A direct browser-created subscription payment was withheld',
            fingerprint: `paddle-webhook:UNBOUND_SUBSCRIPTION_CHECKOUT:${transactionId || eventId || 'unknown'}`,
            context: {
              requestId: req.id,
              eventId,
              transactionId,
              subscriptionId: data?.subscription_id || null,
              customerId: data?.customer_id || null,
              origin: data?.origin || null,
              priceId: priceId || null,
              entitlementGranted: false,
              refundReviewRequired: true
            }
          });
          return;
        }
        if (transactionRoute === 'subscription_update') {
          // Record plan-change transaction in the purchases ledger for refund tracking.
          // Credits are NOT changed here; the ordered subscription snapshot
          // reducer is the only lifecycle entitlement mutation path.
          const supabase = adminClient;
          const deferUserId = await resolveExistingSubscriptionOwner(supabase, {
            subscriptionId: data?.subscription_id,
            customerId: data?.customer_id
          });

          if (!deferUserId) {
            console.error(
              '[paddle/webhook] [CRITICAL] transaction.completed defer — userId 특정 불가',
              '(server subscription binding 조회 실패) — 원장 기록 불가 |',
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
        if (transactionRoute === 'ignore') {
          console.warn(
            '[paddle/webhook] transaction.completed origin=' + (data?.origin || 'undefined') +
            ' — not a credit-granting origin, ignoring |',
            'transaction_id=' + transactionId
          );
          return;
        }
        // transactionRoute === 'subscription_recurring' → renewal for an
        // already bound subscription.
        const userId = await resolveExistingSubscriptionOwner(adminClient, {
          subscriptionId: data?.subscription_id,
          customerId: data?.customer_id
        });
        if (!userId) {
          throw webhookProcessingError(
            'PAYMENT_USER_UNRESOLVED',
            'Completed renewal is not bound to a PromptGen subscription owner'
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
            '| customer_id=' + (data?.customer_id || 'n/a')
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
        if (!data?.subscription_id) {
          console.error('[paddle/webhook] No subscription_id in completed subscription payment');
          throw webhookProcessingError(
            'PAYMENT_SUBSCRIPTION_ID_MISSING',
            'Completed subscription payment is missing a subscription ID'
          );
        }
        if (!data?.customer_id) {
          console.error('[paddle/webhook] No customer_id in completed subscription payment');
          throw webhookProcessingError(
            'PAYMENT_CUSTOMER_ID_MISSING',
            'Completed subscription payment is missing a customer ID'
          );
        }

        const supabase = adminClient;
        await grantCreditsForPurchase(
          supabase,
          transactionId,
          userId,
          plan,
          data.subscription_id,
          data.customer_id,
          {
            requestId: req.id,
            notificationId: eventId,
            occurredAt: payload?.occurred_at
          }
        );
        // Do not rewrite profile provider IDs here. The ordered payment RPC
        // verifies that this recurring subscription is still the profile's
        // current binding. Initial server checkout is the only flow allowed to
        // atomically rebind those IDs via consume_subscription_checkout_attempt.

      } else if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') {
        // Credit-pack adjustments are source-aware and may need to be recorded
        // before approval (adjustment.created pending -> adjustment.updated
        // approved). Try that ledger first; unmatched subscription adjustments
        // continue through the legacy purchase-refund path below.
        const data = payload?.data;
        const supabase = adminClient;

        const packAdjustment = await applyCreditPackAdjustment(supabase, data, {
          providerEventId: payload?.event_id,
          occurredAt: payload?.occurred_at
        });
        if (packAdjustment?.matched) {
          return;
        }

        // Chargebacks and their warning/reversal variants are financially
        // significant even when they do not belong to a credit pack. Preserve
        // the opaque provider IDs for idempotent manual review, but never infer
        // a credit debit or entitlement restoration from the monetary event.
        await handleNonCreditPackAdjustment(supabase, data, {
          requestId: req.id,
          eventId,
          providerEventId: payload?.event_id,
          eventType,
          occurredAt: payload?.occurred_at
        });

      } else if (eventType === 'subscription.updated' || eventType === 'subscription.canceled') {
        const data = payload?.data;
        const supabase = adminClient;
        const customerId = data?.customer_id;
        const subscriptionId = data?.id;
        // A cancellation is terminal regardless of which subscription webhook
        // carries it. The explicit canceled event is authoritative even when its
        // payload omits or misstates `status`.
        const subscriptionStatus = eventType === 'subscription.canceled'
          ? 'canceled'
          : data?.status;
        const priceId = data?.items?.[0]?.price?.id;
        const mappedPlan = priceIdToPlan(priceId);
        const userId = await resolveSubscriptionSnapshotOwner(
          supabase,
          data,
          mappedPlan
        );

        if (!userId) {
          const incidentCode = eventType === 'subscription.canceled'
            ? 'CANCELLATION_USER_UNRESOLVED'
            : 'SUBSCRIPTION_USER_UNRESOLVED';
          console.error(
            '[paddle/webhook] [CRITICAL] ' + eventType + ' — userId 특정 불가 |',
            'subscription_id=' + (subscriptionId || 'n/a'),
            '| customer_id=' + (customerId || 'n/a')
          );
          await reportIncident({
            severity: 'critical',
            source: 'paddle-webhook',
            eventCode: incidentCode,
            message: 'Subscription snapshot could not be matched to a user',
            fingerprint: `paddle-webhook:${incidentCode}:${subscriptionId || eventId || 'unknown'}`,
            context: {
              requestId: req.id,
              eventId,
              providerEventId: payload?.event_id || null,
              eventType,
              subscriptionId: subscriptionId || null,
              customerId: customerId || null,
              status: subscriptionStatus || null
            }
          });
          throw webhookProcessingError(
            incidentCode,
            'Subscription snapshot could not be matched to a user'
          );
        }

        const plan = isActiveSubscription(subscriptionStatus)
          ? mappedPlan
          : null;

        if (isActiveSubscription(subscriptionStatus) && !plan) {
          console.error(
            '[paddle/webhook] [CRITICAL] Active subscription priceId did not map to a plan |',
            'priceId=' + priceId,
            '| subscription_id=' + (subscriptionId || 'n/a'),
            '| userId=' + userId
          );
          await reportIncident({
            severity: 'critical',
            source: 'paddle-webhook',
            eventCode: 'SUBSCRIPTION_PLAN_UNMAPPED',
            message: 'Active subscription snapshot price ID did not map to a PromptGen plan',
            fingerprint: `paddle-webhook:SUBSCRIPTION_PLAN_UNMAPPED:${subscriptionId || eventId || 'unknown'}`,
            context: {
              requestId: req.id,
              eventId,
              providerEventId: payload?.event_id || null,
              eventType,
              subscriptionId: subscriptionId || null,
              userId,
              status: subscriptionStatus,
              priceId
            }
          });
          throw webhookProcessingError(
            'SUBSCRIPTION_PLAN_UNMAPPED',
            'Active subscription snapshot price ID did not map to a PromptGen plan'
          );
        }

        await applyPaddleSubscriptionSnapshot(
          supabase,
          {
            subscriptionId,
            userId,
            customerId,
            status: subscriptionStatus,
            plan,
            providerEventId: payload?.event_id,
            eventType,
            occurredAt: payload?.occurred_at
          },
          {
            requestId: req.id,
            notificationId: eventId
          }
        );

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
module.exports.classifyCompletedTransactionRoute =
  classifyCompletedTransactionRoute;
module.exports.reportUnboundSubscriptionCharge =
  reportUnboundSubscriptionCharge;
module.exports.isActiveSubscription = isActiveSubscription;
module.exports.isTestAccount = isTestAccount;
module.exports.getSubscriptionCheckoutMetadata = getSubscriptionCheckoutMetadata;
module.exports.validateCompletedSubscriptionCheckoutTransaction =
  validateCompletedSubscriptionCheckoutTransaction;
module.exports.consumeSubscriptionCheckoutAttempt =
  consumeSubscriptionCheckoutAttempt;
module.exports.findSubscriptionCheckoutAttemptByTransactionId =
  findSubscriptionCheckoutAttemptByTransactionId;
module.exports.findRecoverableSubscriptionCheckoutAttemptByMetadata =
  findRecoverableSubscriptionCheckoutAttemptByMetadata;
module.exports.findCompletedSubscriptionCheckoutAttemptBySubscriptionId =
  findCompletedSubscriptionCheckoutAttemptBySubscriptionId;
module.exports.reportLateReconciledSubscriptionCheckoutPayment =
  reportLateReconciledSubscriptionCheckoutPayment;
module.exports.reportDeletedAccountSubscriptionCheckoutPayment =
  reportDeletedAccountSubscriptionCheckoutPayment;
module.exports.resolveExistingSubscriptionOwner =
  resolveExistingSubscriptionOwner;
module.exports.resolveSubscriptionSnapshotOwner =
  resolveSubscriptionSnapshotOwner;
module.exports.recordPlanUpgradePurchase = recordPlanUpgradePurchase;
module.exports.derivePreviousPlan = derivePreviousPlan;
module.exports.grantCreditsForPurchase = grantCreditsForPurchase;
module.exports.applyPaddleSubscriptionSnapshot = applyPaddleSubscriptionSnapshot;
module.exports.revokeCreditsForRefund = revokeCreditsForRefund;
module.exports.sanitizeWebhookError = sanitizeWebhookError;
module.exports.claimPaddleWebhookEvent = claimPaddleWebhookEvent;
module.exports.completePaddleWebhookEvent = completePaddleWebhookEvent;
module.exports.failPaddleWebhookEvent = failPaddleWebhookEvent;
module.exports.executePaddleWebhook = executePaddleWebhook;
module.exports.getPaddleOrderingTarget = getPaddleOrderingTarget;
module.exports.parsePaddleOccurredAt = parsePaddleOccurredAt;
module.exports.priceIdToPlan = priceIdToPlan;
module.exports.verifyPaddleSignature = verifyPaddleSignature;
module.exports.validateCompletedCreditPackTransaction = validateCompletedCreditPackTransaction;
module.exports.buildCreditPackHistoryUrl = buildCreditPackHistoryUrl;
module.exports.validateCreditPackHistoryNextUrl = validateCreditPackHistoryNextUrl;
module.exports.verifyCreditPackSubscriptionHistory =
  verifyCreditPackSubscriptionHistory;
module.exports.loadCreditPackTemporalContext = loadCreditPackTemporalContext;
module.exports.grantCreditsForPack = grantCreditsForPack;
module.exports.applyCreditPackAdjustment = applyCreditPackAdjustment;
module.exports.classifyChargebackAdjustment = classifyChargebackAdjustment;
module.exports.reportNonCreditPackChargebackAdjustment =
  reportNonCreditPackChargebackAdjustment;
module.exports.handleNonCreditPackAdjustment = handleNonCreditPackAdjustment;
