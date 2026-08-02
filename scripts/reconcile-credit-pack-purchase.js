'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const {
  reconcileCreditPackPurchase
} = require('../lib/credit-pack-reconciliation');
const {
  DEFAULT_PADDLE_API_BASE,
  getPaddleApiBase
} = require('../lib/paddle-api');

const PURCHASE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PADDLE_CUSTOMER_ID_PATTERN = /^ctm_[a-z\d]{26}$/;
const PADDLE_SUBSCRIPTION_ID_PATTERN = /^sub_[a-z\d]{26}$/;
const PADDLE_PRICE_ID_PATTERN = /^pri_[a-z\d]{26}$/;
const DEFAULT_EXPECTED_SUPABASE_PROJECT_REF = 'kzlovmcghswprasjaeeo';
const PADDLE_SANDBOX_API_BASE = 'https://sandbox-api.paddle.com';
const SANDBOX_SUPABASE_PROJECT_REFS_ENV =
  'CREDIT_PACK_RECONCILIATION_SANDBOX_PROJECT_REFS';
const SUPABASE_PROJECT_REF_PATTERN =
  /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;
const MAX_SANDBOX_SUPABASE_PROJECT_REFS = 32;
const PADDLE_BINDING_TIMEOUT_MS = 10_000;
const RECONCILABLE_STATUSES = new Set([
  'charging',
  'submitted',
  'provider_unknown'
]);
const RECONCILIATION_DELAY_MS = 72 * 60 * 60 * 1000;
const MAX_EVIDENCE_AGE_MS = 2 * 60 * 1000;
const PURCHASE_REQUEST_COLUMNS = [
  'request_id',
  'authorized_user_id',
  'status',
  'customer_id',
  'subscription_id',
  'provider_plan_price_id',
  'pack_key',
  'currency_code',
  'unit_amount',
  'approved_subtotal',
  'approved_discount',
  'approved_tax',
  'approved_total',
  'approved_credit',
  'approved_balance',
  'approved_grand_total',
  'approved_grand_total_tax',
  'eligibility_check_started_at',
  'eligible_snapshot_occurred_at',
  'authorized_at',
  'authorization_expires_at',
  'provider_error_code',
  'review_required',
  'reconciliation_decision',
  'reconciliation_previous_status',
  'reconciliation_checked_at',
  'reconciliation_window_start',
  'reconciliation_window_end',
  'reconciliation_pages_scanned',
  'reconciliation_transactions_scanned',
  'reconciliation_provider_request_ids',
  'reconciliation_audit_reference',
  'reconciliation_closed_at'
].join(',');

class ReconciliationOperatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconciliationOperatorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReconciliationOperatorError(code, message);
}

function normalizeNonEmptyString(value, maxLength = 255) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function normalizeUuid(value) {
  const normalized = normalizeNonEmptyString(value, 64);
  return normalized && PURCHASE_REQUEST_ID_PATTERN.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function normalizeTimestamp(value) {
  if (
    value instanceof Date
    && Number.isFinite(value.getTime())
  ) {
    return value.toISOString();
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeMinorUnit(value, { positive = false } = {}) {
  const numberValue = typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (
    !Number.isSafeInteger(numberValue)
    || numberValue < 0
    || (positive && numberValue === 0)
  ) {
    return null;
  }
  return String(numberValue);
}

function getPaddleApiKeyEnvironment(apiKey) {
  if (apiKey.startsWith('pdl_live_apikey_')) return 'live';
  if (apiKey.startsWith('pdl_sdbx_apikey_')) return 'sandbox';
  return 'legacy';
}

function parseSandboxSupabaseProjectRefAllowlist(value) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(
      'RECONCILIATION_SANDBOX_PROJECT_ALLOWLIST_REQUIRED',
      `${SANDBOX_SUPABASE_PROJECT_REFS_ENV} must explicitly allow the Sandbox Supabase project.`
    );
  }
  if (value.length > 2048) {
    fail(
      'RECONCILIATION_SANDBOX_PROJECT_ALLOWLIST_INVALID',
      `${SANDBOX_SUPABASE_PROJECT_REFS_ENV} must contain only exact Supabase project refs.`
    );
  }

  const projectRefs = value
    .split(',')
    .map((projectRef) => projectRef.trim().toLowerCase());
  if (
    projectRefs.length > MAX_SANDBOX_SUPABASE_PROJECT_REFS
    || projectRefs.some(
      (projectRef) => (
        !SUPABASE_PROJECT_REF_PATTERN.test(projectRef)
        || projectRef === DEFAULT_EXPECTED_SUPABASE_PROJECT_REF
      )
    )
  ) {
    fail(
      'RECONCILIATION_SANDBOX_PROJECT_ALLOWLIST_INVALID',
      `${SANDBOX_SUPABASE_PROJECT_REFS_ENV} must contain only exact non-production Supabase project refs.`
    );
  }

  return new Set(projectRefs);
}

function readRequiredEnvironment(env, { apply = false } = {}) {
  const supabaseUrl = normalizeNonEmptyString(env?.SUPABASE_URL, 2048);
  const serviceRoleKey = normalizeNonEmptyString(
    env?.SUPABASE_SERVICE_ROLE_KEY,
    8192
  );
  const paddleApiKey = normalizeNonEmptyString(env?.PADDLE_API_KEY, 8192);

  if (!supabaseUrl || !serviceRoleKey || !paddleApiKey) {
    fail(
      'RECONCILIATION_ENVIRONMENT_MISSING',
      'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and PADDLE_API_KEY are required.'
    );
  }

  let parsedSupabaseUrl;
  try {
    parsedSupabaseUrl = new URL(supabaseUrl);
  } catch (_) {
    fail(
      'RECONCILIATION_ENVIRONMENT_INVALID',
      'SUPABASE_URL must be a valid HTTPS URL.'
    );
  }
  if (
    parsedSupabaseUrl.protocol !== 'https:'
    || parsedSupabaseUrl.username
    || parsedSupabaseUrl.password
    || parsedSupabaseUrl.port
    || parsedSupabaseUrl.pathname !== '/'
    || parsedSupabaseUrl.search
    || parsedSupabaseUrl.hash
    || !/^[a-z\d-]+\.supabase\.co$/i.test(parsedSupabaseUrl.hostname)
  ) {
    fail(
      'RECONCILIATION_ENVIRONMENT_INVALID',
      'SUPABASE_URL must be a valid HTTPS URL.'
    );
  }
  const supabaseProjectRef = parsedSupabaseUrl.hostname
    .split('.')[0]
    .toLowerCase();

  let paddleApiBase;
  try {
    paddleApiBase = getPaddleApiBase(env);
  } catch (_) {
    fail(
      'RECONCILIATION_ENVIRONMENT_INVALID',
      'PADDLE_API_BASE must be an exact trusted Paddle API origin.'
    );
  }
  if (
    paddleApiBase !== DEFAULT_PADDLE_API_BASE
    && paddleApiBase !== PADDLE_SANDBOX_API_BASE
  ) {
    fail(
      'RECONCILIATION_ENVIRONMENT_INVALID',
      'PADDLE_API_BASE must be the exact production or Sandbox Paddle API origin.'
    );
  }
  const paddleKeyEnvironment = getPaddleApiKeyEnvironment(paddleApiKey);
  const expectedPaddleApiBase = paddleKeyEnvironment === 'live'
    ? DEFAULT_PADDLE_API_BASE
    : paddleKeyEnvironment === 'sandbox'
      ? PADDLE_SANDBOX_API_BASE
      : null;
  if (
    (expectedPaddleApiBase && paddleApiBase !== expectedPaddleApiBase)
    || (
      paddleApiBase === PADDLE_SANDBOX_API_BASE
      && paddleKeyEnvironment !== 'sandbox'
    )
  ) {
    fail(
      'RECONCILIATION_PADDLE_ENVIRONMENT_MISMATCH',
      'The Paddle API key environment does not match PADDLE_API_BASE.'
    );
  }
  if (
    apply
    && (
      paddleKeyEnvironment !== 'live'
      || paddleApiBase !== DEFAULT_PADDLE_API_BASE
      || supabaseProjectRef !== DEFAULT_EXPECTED_SUPABASE_PROJECT_REF
    )
  ) {
    fail(
      'RECONCILIATION_APPLY_ENVIRONMENT_UNSAFE',
      'Applying reconciliation requires the PromptGen production Supabase project, a modern live Paddle API key, and the production Paddle API origin.'
    );
  }
  if (!apply && paddleApiBase === DEFAULT_PADDLE_API_BASE) {
    if (supabaseProjectRef !== DEFAULT_EXPECTED_SUPABASE_PROJECT_REF) {
      fail(
        'RECONCILIATION_SUPABASE_PROJECT_MISMATCH',
        'The live reconciliation operator is restricted to the PromptGen Supabase project.'
      );
    }
  }
  if (!apply && paddleApiBase === PADDLE_SANDBOX_API_BASE) {
    if (supabaseProjectRef === DEFAULT_EXPECTED_SUPABASE_PROJECT_REF) {
      fail(
        'RECONCILIATION_SUPABASE_PROJECT_MISMATCH',
        'Sandbox reconciliation cannot read the PromptGen production Supabase project.'
      );
    }
    const allowedSandboxProjectRefs =
      parseSandboxSupabaseProjectRefAllowlist(
        env?.[SANDBOX_SUPABASE_PROJECT_REFS_ENV]
      );
    if (!allowedSandboxProjectRefs.has(supabaseProjectRef)) {
      fail(
        'RECONCILIATION_SUPABASE_PROJECT_MISMATCH',
        'The Sandbox Supabase project is not explicitly allowlisted.'
      );
    }
  }

  return Object.freeze({
    supabaseUrl: parsedSupabaseUrl.toString().replace(/\/$/, ''),
    supabaseProjectRef,
    serviceRoleKey,
    paddleApiKey,
    paddleApiBase,
    paddleKeyEnvironment
  });
}

function createServiceRoleClient(config, createClientImpl = createClient) {
  return createClientImpl(
    config.supabaseUrl,
    config.serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false
      }
    }
  );
}

async function readPurchaseRequest(supabase, requestId) {
  let response;
  try {
    response = await supabase
      .from('credit_pack_purchase_requests')
      .select(PURCHASE_REQUEST_COLUMNS)
      .eq('request_id', requestId)
      .single();
  } catch (_) {
    fail(
      'RECONCILIATION_REQUEST_READ_FAILED',
      'The purchase request could not be read.'
    );
  }

  if (response?.error || !response?.data) {
    fail(
      'RECONCILIATION_REQUEST_NOT_FOUND',
      'Exactly one purchase request is required.'
    );
  }
  return response.data;
}

function normalizePurchaseContract(row, requestId, checkedAt) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    fail(
      'RECONCILIATION_REQUEST_CONTRACT_INVALID',
      'The purchase request contract is incomplete.'
    );
  }

  const normalizedRequestId = normalizeUuid(row.request_id);
  const authorizedUserId = normalizeUuid(row.authorized_user_id);
  const status = normalizeNonEmptyString(row.status, 64);
  const customerId = normalizeNonEmptyString(row.customer_id);
  const subscriptionId = normalizeNonEmptyString(row.subscription_id);
  const providerPlanPriceId = normalizeNonEmptyString(
    row.provider_plan_price_id
  );
  const packKey = normalizeNonEmptyString(row.pack_key, 100);
  const currencyCode = normalizeNonEmptyString(row.currency_code, 3);
  const unitAmount = normalizeMinorUnit(row.unit_amount, { positive: true });
  const subtotal = normalizeMinorUnit(row.approved_subtotal);
  const discount = normalizeMinorUnit(row.approved_discount);
  const tax = normalizeMinorUnit(row.approved_tax);
  const total = normalizeMinorUnit(row.approved_total);
  const credit = normalizeMinorUnit(row.approved_credit);
  const balance = normalizeMinorUnit(row.approved_balance);
  const grandTotal = normalizeMinorUnit(row.approved_grand_total);
  const grandTotalTax = normalizeMinorUnit(
    row.approved_grand_total_tax
  );
  const windowStartAt = normalizeTimestamp(
    row.eligibility_check_started_at
  );
  const eligibleSnapshotOccurredAt = normalizeTimestamp(
    row.eligible_snapshot_occurred_at
  );
  const authorizedAt = normalizeTimestamp(row.authorized_at);
  const authorizationExpiresAt = normalizeTimestamp(
    row.authorization_expires_at
  );

  if (
    !normalizedRequestId
    || normalizedRequestId !== requestId
    || !authorizedUserId
    || !status
    || !customerId
    || !PADDLE_CUSTOMER_ID_PATTERN.test(customerId)
    || !subscriptionId
    || !PADDLE_SUBSCRIPTION_ID_PATTERN.test(subscriptionId)
    || !providerPlanPriceId
    || !PADDLE_PRICE_ID_PATTERN.test(providerPlanPriceId)
    || !packKey
    || currencyCode !== 'USD'
    || unitAmount === null
    || subtotal === null
    || discount === null
    || tax === null
    || total === null
    || credit === null
    || balance === null
    || grandTotal === null
    || grandTotalTax === null
    || !windowStartAt
    || !eligibleSnapshotOccurredAt
    || !authorizedAt
    || !authorizationExpiresAt
  ) {
    fail(
      'RECONCILIATION_REQUEST_CONTRACT_INVALID',
      'The purchase request contract is incomplete.'
    );
  }
  if (!RECONCILABLE_STATUSES.has(status)) {
    fail(
      'RECONCILIATION_STATUS_NOT_ALLOWED',
      'Only charging, submitted, or provider_unknown requests can be inspected.'
    );
  }

  const windowStartMs = Date.parse(windowStartAt);
  const snapshotMs = Date.parse(eligibleSnapshotOccurredAt);
  const authorizedMs = Date.parse(authorizedAt);
  const expiresMs = Date.parse(authorizationExpiresAt);
  const checkedMs = Date.parse(checkedAt);
  if (
    windowStartMs > authorizedMs
    || snapshotMs > authorizedMs
    || expiresMs - authorizedMs !== 15 * 60 * 1000
  ) {
    fail(
      'RECONCILIATION_REQUEST_CONTRACT_INVALID',
      'The purchase request timing contract is inconsistent.'
    );
  }
  if (checkedMs < expiresMs + RECONCILIATION_DELAY_MS) {
    fail(
      'RECONCILIATION_DELAY_ACTIVE',
      'The request is not eligible for reconciliation yet.'
    );
  }

  const amountContractIsExact = (
    subtotal === unitAmount
    && discount === '0'
    && credit === '0'
    && Number(total) === Number(subtotal) + Number(tax)
    && grandTotal === total
    && balance === grandTotal
    && grandTotalTax === tax
  );
  if (!amountContractIsExact) {
    fail(
      'RECONCILIATION_REQUEST_CONTRACT_INVALID',
      'The approved amount contract is inconsistent.'
    );
  }

  return Object.freeze({
    purchaseRequestId: normalizedRequestId,
    authorizedUserId,
    expectedStatus: status,
    customerId,
    subscriptionId,
    providerPlanPriceId,
    packKey,
    currencyCode,
    unitAmount,
    subtotal,
    discount,
    tax,
    total,
    credit,
    balance,
    grandTotal,
    grandTotalTax,
    windowStartAt,
    authorizedAt,
    authorizationExpiresAt,
    windowEndAt: checkedAt,
    checkedAt
  });
}

function normalizePersistedNoMatch(row, expected) {
  const decision = normalizeNonEmptyString(row.reconciliation_decision, 64);
  if (!decision) return null;

  const previousStatus = normalizeNonEmptyString(
    row.reconciliation_previous_status,
    64
  );
  const providerErrorCode = normalizeNonEmptyString(
    row.provider_error_code,
    255
  );
  const checkedAt = normalizeTimestamp(row.reconciliation_checked_at);
  const windowStartAt = normalizeTimestamp(
    row.reconciliation_window_start
  );
  const windowEndAt = normalizeTimestamp(row.reconciliation_window_end);
  const closedAt = normalizeTimestamp(row.reconciliation_closed_at);
  const pagesScanned = Number(row.reconciliation_pages_scanned);
  const transactionsScanned = Number(
    row.reconciliation_transactions_scanned
  );
  const apiRequestIds = Array.isArray(
    row.reconciliation_provider_request_ids
  )
    ? row.reconciliation_provider_request_ids.map(normalizeUuid)
    : [];
  const auditReference = normalizeNonEmptyString(
    row.reconciliation_audit_reference
  );
  const evidence = {
    scanComplete: true,
    purchaseRequestId: expected.purchaseRequestId,
    subscriptionId: expected.subscriptionId,
    customerId: expected.customerId,
    packKey: expected.packKey,
    currencyCode: expected.currencyCode,
    unitAmount: expected.unitAmount,
    subtotal: expected.subtotal,
    discount: expected.discount,
    tax: expected.tax,
    total: expected.total,
    credit: expected.credit,
    balance: expected.balance,
    grandTotal: expected.grandTotal,
    grandTotalTax: expected.grandTotalTax,
    windowStartAt,
    windowEndAt,
    checkedAt,
    pagesScanned,
    transactionsScanned,
    apiRequestIds
  };

  if (
    decision !== 'definitive_no_match'
    || expected.expectedStatus !== 'provider_unknown'
    || row.review_required !== true
    || !RECONCILABLE_STATUSES.has(previousStatus)
    || providerErrorCode !== 'reconciled_no_match_review_locked'
    || !checkedAt
    || !windowStartAt
    || windowStartAt !== expected.windowStartAt
    || !windowEndAt
    || windowEndAt !== checkedAt
    || !closedAt
    || Date.parse(closedAt) < Date.parse(checkedAt)
    || Date.parse(closedAt) > Date.parse(expected.checkedAt)
    || Date.parse(checkedAt) <
      Date.parse(expected.authorizationExpiresAt) + RECONCILIATION_DELAY_MS
    || !Number.isSafeInteger(pagesScanned)
    || pagesScanned <= 0
    || pagesScanned > 256
    || !Number.isSafeInteger(transactionsScanned)
    || transactionsScanned < 0
    || transactionsScanned > pagesScanned * 30
    || apiRequestIds.length !== pagesScanned
    || apiRequestIds.some((value) => !value)
    || new Set(apiRequestIds).size !== apiRequestIds.length
    || !auditReference
    || !/^pgcr_[0-9a-f-]{36}$/i.test(auditReference)
    || !evidenceContractMatches(evidence, {
      ...expected,
      windowEndAt,
      checkedAt
    })
  ) {
    fail(
      'RECONCILIATION_REQUEST_CONTRACT_INVALID',
      'The persisted reconciliation evidence is incomplete.'
    );
  }

  return Object.freeze({
    previousStatus,
    reviewRequired: true,
    evidence: Object.freeze({
      ...evidence,
      apiRequestIds: Object.freeze([...apiRequestIds])
    }),
    auditReference,
    closedAt
  });
}

async function verifyPaddleSubscriptionBinding({
  apiKey,
  apiBase,
  expected,
  fetchImpl = global.fetch
}) {
  if (typeof fetchImpl !== 'function') {
    fail(
      'RECONCILIATION_PADDLE_BINDING_UNVERIFIED',
      'The Paddle subscription binding could not be verified.'
    );
  }

  let response;
  try {
    response = await fetchImpl(
      `${apiBase}/subscriptions/${encodeURIComponent(expected.subscriptionId)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        redirect: 'error',
        signal: AbortSignal.timeout(PADDLE_BINDING_TIMEOUT_MS)
      }
    );
  } catch (_) {
    fail(
      'RECONCILIATION_PADDLE_BINDING_UNVERIFIED',
      'The Paddle subscription binding could not be verified.'
    );
  }

  if (!response?.ok) {
    fail(
      'RECONCILIATION_PADDLE_BINDING_UNVERIFIED',
      'The Paddle subscription binding could not be verified.'
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (_) {
    fail(
      'RECONCILIATION_PADDLE_BINDING_UNVERIFIED',
      'The Paddle subscription binding could not be verified.'
    );
  }

  const subscription = body?.data;
  const providerRequestId = normalizeUuid(body?.meta?.request_id);
  const matchingPriceItems = Array.isArray(subscription?.items)
    ? subscription.items.filter(
      (item) => item?.price?.id === expected.providerPlanPriceId
    )
    : [];
  if (
    subscription?.id !== expected.subscriptionId
    || subscription?.customer_id !== expected.customerId
    || matchingPriceItems.length !== 1
    || !providerRequestId
  ) {
    fail(
      'RECONCILIATION_PADDLE_BINDING_UNVERIFIED',
      'The Paddle subscription binding could not be verified.'
    );
  }

  return Object.freeze({
    subscriptionId: expected.subscriptionId,
    customerId: expected.customerId,
    providerPlanPriceId: expected.providerPlanPriceId,
    providerRequestId
  });
}

function evidenceContractMatches(evidence, expected) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return false;
  }

  const scalarFields = [
    'purchaseRequestId',
    'subscriptionId',
    'customerId',
    'packKey',
    'currencyCode',
    'unitAmount',
    'subtotal',
    'discount',
    'tax',
    'total',
    'credit',
    'balance',
    'grandTotal',
    'grandTotalTax',
    'windowStartAt',
    'windowEndAt',
    'checkedAt'
  ];
  if (
    evidence.scanComplete !== true
    || scalarFields.some((field) => evidence[field] !== expected[field])
    || !Number.isSafeInteger(evidence.pagesScanned)
    || evidence.pagesScanned <= 0
    || !Number.isSafeInteger(evidence.transactionsScanned)
    || evidence.transactionsScanned < 0
    || evidence.transactionsScanned > evidence.pagesScanned * 30
    || !Array.isArray(evidence.apiRequestIds)
    || evidence.apiRequestIds.length !== evidence.pagesScanned
    || evidence.apiRequestIds.length > 256
  ) {
    return false;
  }

  const normalizedProviderRequestIds = evidence.apiRequestIds.map(
    (value) => normalizeUuid(value)
  );
  return normalizedProviderRequestIds.every(Boolean)
    && new Set(normalizedProviderRequestIds).size
      === normalizedProviderRequestIds.length;
}

function evidenceSummary(evidence) {
  return Object.freeze({
    checkedAt: evidence.checkedAt,
    windowStartAt: evidence.windowStartAt,
    windowEndAt: evidence.windowEndAt,
    pagesScanned: evidence.pagesScanned,
    transactionsScanned: evidence.transactionsScanned,
    providerRequestCount: evidence.apiRequestIds.length
  });
}

function reconciliationScanOptions({
  config,
  expected,
  fetchImpl
}) {
  return {
    apiKey: config.paddleApiKey,
    apiBase: config.paddleApiBase,
    fetchImpl,
    purchaseRequestId: expected.purchaseRequestId,
    subscriptionId: expected.subscriptionId,
    customerId: expected.customerId,
    packKey: expected.packKey,
    currencyCode: expected.currencyCode,
    unitAmount: expected.unitAmount,
    subtotal: expected.subtotal,
    discount: expected.discount,
    tax: expected.tax,
    total: expected.total,
    credit: expected.credit,
    balance: expected.balance,
    grandTotal: expected.grandTotal,
    grandTotalTax: expected.grandTotalTax,
    windowStartAt: expected.windowStartAt,
    windowEndAt: expected.windowEndAt,
    checkedAt: expected.checkedAt
  };
}

function requireExactNoMatchEvidence(result, expected) {
  if (
    result?.status !== 'definitive_no_match'
    || result.reason !== 'complete_scan_no_match'
    || !evidenceContractMatches(result.evidence, expected)
  ) {
    fail(
      'RECONCILIATION_EVIDENCE_UNSAFE',
      'The provider scan did not return complete, exact evidence.'
    );
  }
  return result.evidence;
}

function evidenceScansAreIndependent(firstEvidence, secondEvidence) {
  const firstRequestIds = new Set(firstEvidence.apiRequestIds);
  return secondEvidence.apiRequestIds.every(
    (requestId) => !firstRequestIds.has(requestId)
  );
}

function safeNonClosingResult(requestId, result, paddleBindingRequestId) {
  const evidence = result?.evidence;
  const summary = evidence && typeof evidence === 'object'
    ? {
      pagesScanned: Number.isSafeInteger(evidence.pagesScanned)
        ? evidence.pagesScanned
        : 0,
      transactionsScanned: Number.isSafeInteger(evidence.transactionsScanned)
        ? evidence.transactionsScanned
        : 0
    }
    : { pagesScanned: 0, transactionsScanned: 0 };

  if (result?.status === 'matched') {
    return Object.freeze({
      ok: true,
      mode: 'read-only',
      outcome: 'matched',
      requestId,
      paddleBindingRequestId,
      transactionId: normalizeNonEmptyString(result?.transaction?.id) || null,
      ...summary
    });
  }
  return Object.freeze({
    ok: true,
    mode: 'read-only',
    outcome: 'ambiguous',
    requestId,
    paddleBindingRequestId,
    reason: normalizeNonEmptyString(result?.reason, 100)
      || 'invalid_reconciliation_result',
    ...summary
  });
}

function validateAuditReference(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized || !/^pgcr_[0-9a-f-]{36}$/i.test(normalized)) {
    fail(
      'RECONCILIATION_AUDIT_REFERENCE_INVALID',
      'An opaque reconciliation audit reference is required.'
    );
  }
  return normalized;
}

async function applyDefinitiveNoMatch({
  supabase,
  expected,
  evidence,
  auditReference,
  paddleBindingRequestId
}) {
  let response;
  try {
    response = await supabase.rpc(
      'reconcile_credit_pack_purchase_no_match',
      {
        p_request_id: expected.purchaseRequestId,
        p_user_id: expected.authorizedUserId,
        p_expected_status: expected.expectedStatus,
        p_evidence_result: 'definitive_no_match',
        p_checked_at: evidence.checkedAt,
        p_window_start: evidence.windowStartAt,
        p_window_end: evidence.windowEndAt,
        p_pages_scanned: evidence.pagesScanned,
        p_transactions_scanned: evidence.transactionsScanned,
        p_provider_request_ids: [...evidence.apiRequestIds],
        p_audit_reference: auditReference
      }
    );
  } catch (_) {
    fail(
      'RECONCILIATION_RPC_FAILED',
      'The reconciliation decision was not applied.'
    );
  }
  if (response?.error || !response?.data) {
    fail(
      'RECONCILIATION_RPC_FAILED',
      'The reconciliation decision was not applied.'
    );
  }

  const result = response.data;
  const requestId = normalizeUuid(result?.requestId);
  const decision = normalizeNonEmptyString(
    result?.reconciliationDecision,
    64
  );
  if (requestId !== expected.purchaseRequestId) {
    fail(
      'RECONCILIATION_RPC_CONTRACT_INVALID',
      'The reconciliation RPC returned an unexpected request.'
    );
  }
  if (
    result.applied === true
    && result.reason === 'request_reconciled_no_match'
    && result.status === 'provider_unknown'
    && result.reviewRequired === true
    && decision === 'definitive_no_match'
  ) {
    return Object.freeze({
      ok: true,
      mode: 'applied',
      outcome: 'definitive_no_match',
      requestId: expected.purchaseRequestId,
      status: 'provider_unknown',
      reviewRequired: true,
      reviewLocked: true,
      evidence: evidenceSummary(evidence),
      auditReference,
      paddleBindingRequestId
    });
  }
  if (
    result.applied === false
    && result.reason === 'reconciliation_duplicate'
    && result.status === 'provider_unknown'
    && decision === 'definitive_no_match'
  ) {
    return Object.freeze({
      ok: true,
      mode: 'idempotent',
      outcome: 'definitive_no_match',
      requestId: expected.purchaseRequestId,
      status: 'provider_unknown',
      reviewRequired: true,
      reviewLocked: true,
      evidence: evidenceSummary(evidence),
      auditReference,
      paddleBindingRequestId
    });
  }

  fail(
    'RECONCILIATION_RPC_REJECTED',
    'The reconciliation RPC rejected the state transition.'
  );
}

async function runCreditPackReconciliation(options = {}) {
  const requestId = normalizeUuid(options.requestId);
  if (!requestId) {
    fail(
      'RECONCILIATION_REQUEST_ID_INVALID',
      '--request-id must be a valid UUID.'
    );
  }
  if (
    options.apply !== undefined
    && typeof options.apply !== 'boolean'
  ) {
    fail(
      'RECONCILIATION_ARGUMENT_INVALID',
      '--apply must be a boolean switch.'
    );
  }

  const config = readRequiredEnvironment(
    options.env || process.env,
    { apply: options.apply === true }
  );
  const nowImpl = options.now || (() => new Date());
  const firstNow = normalizeTimestamp(nowImpl());
  if (!firstNow) {
    fail(
      'RECONCILIATION_CLOCK_INVALID',
      'The operator clock returned an invalid timestamp.'
    );
  }

  const supabase = createServiceRoleClient(
    config,
    options.createClientImpl || createClient
  );
  const row = await readPurchaseRequest(supabase, requestId);
  const expected = normalizePurchaseContract(row, requestId, firstNow);
  const persistedNoMatch = normalizePersistedNoMatch(row, expected);
  const fetchImpl = options.fetchImpl || global.fetch;
  const paddleBinding = await verifyPaddleSubscriptionBinding({
    apiKey: config.paddleApiKey,
    apiBase: config.paddleApiBase,
    expected,
    fetchImpl
  });
  const reconcileImpl = options.reconcileImpl
    || reconcileCreditPackPurchase;
  const scanOptions = reconciliationScanOptions({
    config,
    expected,
    fetchImpl
  });
  const result = await reconcileImpl(scanOptions);

  if (persistedNoMatch) {
    if (result?.status !== 'definitive_no_match') {
      const revalidation = safeNonClosingResult(
        requestId,
        result,
        paddleBinding.providerRequestId
      );
      return Object.freeze({
        ...revalidation,
        mode: 'revalidation',
        status: 'provider_unknown',
        reviewRequired: true,
        reviewLocked: true,
        previousStatus: persistedNoMatch.previousStatus,
        requiresSignedWebhookReplay: result?.status === 'matched',
        auditReference: persistedNoMatch.auditReference,
        closedAt: persistedNoMatch.closedAt
      });
    }
    const revalidatedEvidence = requireExactNoMatchEvidence(
      result,
      expected
    );
    return Object.freeze({
      ok: true,
      mode: 'idempotent',
      outcome: 'definitive_no_match',
      requestId,
      status: 'provider_unknown',
      reviewRequired: true,
      reviewLocked: true,
      previousStatus: persistedNoMatch.previousStatus,
      revalidated: true,
      evidence: evidenceSummary(revalidatedEvidence),
      persistedEvidence: evidenceSummary(persistedNoMatch.evidence),
      paddleBindingRequestId: paddleBinding.providerRequestId,
      auditReference: persistedNoMatch.auditReference,
      closedAt: persistedNoMatch.closedAt
    });
  }

  if (result?.status !== 'definitive_no_match') {
    return safeNonClosingResult(
      requestId,
      result,
      paddleBinding.providerRequestId
    );
  }
  const firstEvidence = requireExactNoMatchEvidence(result, expected);

  if (!options.apply) {
    return Object.freeze({
      ok: true,
      mode: 'dry-run',
      outcome: 'definitive_no_match',
      requestId,
      readyToApply: (
        config.supabaseProjectRef === DEFAULT_EXPECTED_SUPABASE_PROJECT_REF
        && config.paddleKeyEnvironment === 'live'
        && config.paddleApiBase === DEFAULT_PADDLE_API_BASE
      ),
      paddleBindingRequestId: paddleBinding.providerRequestId,
      evidence: evidenceSummary(firstEvidence)
    });
  }

  // A write-capable run must repeat the complete broad transaction scan
  // immediately before the database CAS. Distinct Paddle response request IDs
  // prove this was a new provider read rather than reused evidence. Any late
  // match or partial evidence prevents the reconciliation write.
  const confirmationNow = normalizeTimestamp(nowImpl());
  if (
    !confirmationNow
    || Date.parse(confirmationNow) < Date.parse(expected.checkedAt)
  ) {
    fail(
      'RECONCILIATION_CLOCK_INVALID',
      'The operator clock returned an invalid timestamp.'
    );
  }
  const confirmationExpected = normalizePurchaseContract(
    row,
    requestId,
    confirmationNow
  );
  const confirmationScanOptions = reconciliationScanOptions({
    config,
    expected: confirmationExpected,
    fetchImpl
  });
  const confirmationResult = await reconcileImpl(confirmationScanOptions);
  if (confirmationResult?.status !== 'definitive_no_match') {
    return safeNonClosingResult(
      requestId,
      confirmationResult,
      paddleBinding.providerRequestId
    );
  }
  const confirmationEvidence = requireExactNoMatchEvidence(
    confirmationResult,
    confirmationExpected
  );
  if (!evidenceScansAreIndependent(firstEvidence, confirmationEvidence)) {
    fail(
      'RECONCILIATION_CONFIRMATION_SCAN_NOT_INDEPENDENT',
      'The confirmation scan did not provide independent Paddle evidence.'
    );
  }

  const completedAt = normalizeTimestamp(nowImpl());
  if (
    !completedAt
    || Date.parse(completedAt) < Date.parse(confirmationEvidence.checkedAt)
    || Date.parse(completedAt) - Date.parse(confirmationEvidence.checkedAt)
      > MAX_EVIDENCE_AGE_MS
  ) {
    fail(
      'RECONCILIATION_EVIDENCE_STALE',
      'The provider evidence is too old to apply safely.'
    );
  }

  const auditReferenceFactory = options.auditReferenceFactory
    || (() => `pgcr_${crypto.randomUUID()}`);
  const auditReference = validateAuditReference(
    auditReferenceFactory()
  );
  return applyDefinitiveNoMatch({
    supabase,
    expected: confirmationExpected,
    evidence: confirmationEvidence,
    auditReference,
    paddleBindingRequestId: paddleBinding.providerRequestId
  });
}

function parseCliArguments(argv) {
  let requestId = null;
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      if (apply) {
        fail(
          'RECONCILIATION_ARGUMENT_INVALID',
          '--apply may only be provided once.'
        );
      }
      apply = true;
      continue;
    }
    if (argument === '--request-id') {
      if (requestId !== null || index + 1 >= argv.length) {
        fail(
          'RECONCILIATION_ARGUMENT_INVALID',
          '--request-id must be provided exactly once.'
        );
      }
      requestId = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith('--request-id=')) {
      if (requestId !== null) {
        fail(
          'RECONCILIATION_ARGUMENT_INVALID',
          '--request-id must be provided exactly once.'
        );
      }
      requestId = argument.slice('--request-id='.length);
      continue;
    }
    fail(
      'RECONCILIATION_ARGUMENT_INVALID',
      'Only --request-id and --apply are supported.'
    );
  }

  if (requestId === null) {
    fail(
      'RECONCILIATION_REQUEST_ID_REQUIRED',
      '--request-id is required.'
    );
  }
  return Object.freeze({ requestId, apply });
}

async function main(argv = process.argv.slice(2)) {
  const cliOptions = parseCliArguments(argv);
  return runCreditPackReconciliation(cliOptions);
}

if (require.main === module) {
  require('dotenv').config();
  main()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      const code = error instanceof ReconciliationOperatorError
        ? error.code
        : 'RECONCILIATION_OPERATOR_FAILED';
      const message = error instanceof ReconciliationOperatorError
        ? error.message
        : 'The reconciliation operator failed.';
      console.error(JSON.stringify({ ok: false, code, message }));
      process.exitCode = 1;
    });
}

module.exports = {
  MAX_EVIDENCE_AGE_MS,
  DEFAULT_EXPECTED_SUPABASE_PROJECT_REF,
  SANDBOX_SUPABASE_PROJECT_REFS_ENV,
  PADDLE_BINDING_TIMEOUT_MS,
  PURCHASE_REQUEST_COLUMNS,
  RECONCILIATION_DELAY_MS,
  ReconciliationOperatorError,
  applyDefinitiveNoMatch,
  evidenceContractMatches,
  evidenceScansAreIndependent,
  main,
  normalizePurchaseContract,
  normalizePersistedNoMatch,
  parseCliArguments,
  parseSandboxSupabaseProjectRefAllowlist,
  readRequiredEnvironment,
  readPurchaseRequest,
  reconciliationScanOptions,
  runCreditPackReconciliation,
  verifyPaddleSubscriptionBinding
};
