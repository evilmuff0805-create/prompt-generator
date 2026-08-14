'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const {
  reconcileSubscriptionCheckout
} = require('../lib/subscription-checkout-reconciliation');
const {
  DEFAULT_EXPECTED_SUPABASE_PROJECT_REF,
  MAX_EVIDENCE_AGE_MS,
  ReconciliationOperatorError,
  catalogEvidenceIsIndependent,
  evidenceScansAreIndependent,
  readRequiredEnvironment,
  reconciliationEvidenceHash
} = require('./reconcile-credit-pack-purchase');
const { DEFAULT_PADDLE_API_BASE } = require('../lib/paddle-api');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PADDLE_PRICE_ID_PATTERN = /^pri_[a-z\d]{26}$/;
const PADDLE_PRODUCT_ID_PATTERN = /^pro_[a-z\d]{26}$/;
const PADDLE_CUSTOMER_ID_PATTERN = /^ctm_[a-z\d]{26}$/;
const RECONCILIATION_DELAY_MS = 72 * 60 * 60 * 1000;
const FINALIZATION_DELAY_MS = 24 * 60 * 60 * 1000;
const PADDLE_BINDING_TIMEOUT_MS = 10_000;
const ATTEMPT_COLUMNS = [
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
  'status',
  'provider_error_code',
  'provider_mutation_started_at',
  'provider_unknown_at',
  'created_at',
  'updated_at',
  'failed_at',
  'review_required',
  'reconciliation_decision',
  'reconciliation_previous_status',
  'reconciliation_closed_at'
].join(',');
const SCAN_COLUMNS = [
  'attempt_id',
  'authorized_user_id',
  'scan_ordinal',
  'expected_status',
  'checked_at',
  'window_start',
  'window_end',
  'pages_scanned',
  'transactions_scanned',
  'provider_request_ids',
  'catalog_request_id',
  'contract_fingerprint',
  'evidence_hash',
  'audit_reference',
  'recorded_at'
].join(',');

function fail(code, message) {
  throw new ReconciliationOperatorError(code, message);
}

function text(value, maxLength = 255) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function uuid(value) {
  const normalized = text(value, 64);
  return normalized && UUID_PATTERN.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function createServiceRoleClient(config, createClientImpl = createClient) {
  return createClientImpl(config.supabaseUrl, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    }
  });
}

async function readAttempt(supabase, attemptId) {
  let response;
  try {
    response = await supabase
      .from('subscription_checkout_attempts')
      .select(ATTEMPT_COLUMNS)
      .eq('attempt_id', attemptId)
      .single();
  } catch (_) {
    fail('RECONCILIATION_ATTEMPT_READ_FAILED', 'The checkout attempt could not be read.');
  }
  if (response?.error || !response?.data) {
    fail('RECONCILIATION_ATTEMPT_NOT_FOUND', 'Exactly one checkout attempt is required.');
  }
  return response.data;
}

async function readScan(supabase, attemptId, ordinal) {
  let response;
  try {
    response = await supabase
      .from('subscription_checkout_reconciliation_scans')
      .select(SCAN_COLUMNS)
      .eq('attempt_id', attemptId)
      .eq('scan_ordinal', ordinal)
      .maybeSingle();
  } catch (_) {
    fail('RECONCILIATION_SCAN_READ_FAILED', 'The persisted reconciliation scan could not be read.');
  }
  if (response?.error) {
    fail('RECONCILIATION_SCAN_READ_FAILED', 'The persisted reconciliation scan could not be read.');
  }
  return response?.data || null;
}

async function readFirstScan(supabase, attemptId) {
  return readScan(supabase, attemptId, 1);
}

async function readFinalScan(supabase, attemptId) {
  return readScan(supabase, attemptId, 2);
}

function normalizeAttempt(
  row,
  attemptId,
  checkedAt,
  { terminalNoMatch = false } = {}
) {
  const rowStatus = text(row?.status, 64);
  const previousStatus = text(row?.reconciliation_previous_status, 64);
  const normalized = {
    attemptId: uuid(row?.attempt_id),
    userId: uuid(row?.authorized_user_id),
    status: terminalNoMatch ? previousStatus : rowStatus,
    targetPlan: text(row?.target_plan, 32),
    priceId: text(row?.price_id),
    credits: Number(row?.credits),
    unitAmount: Number(row?.unit_amount),
    currencyCode: text(row?.currency_code, 3),
    expectedOrigin: text(row?.expected_origin, 32),
    expectedCustomerId: row?.customer_id == null ? null : text(row.customer_id),
    createdAt: timestamp(row?.created_at),
    providerMutationStartedAt: timestamp(row?.provider_mutation_started_at),
    providerUnknownAt: row?.provider_unknown_at == null
      ? null
      : timestamp(row.provider_unknown_at),
    checkedAt,
    windowStartAt: timestamp(row?.created_at),
    windowEndAt: checkedAt,
    terminalNoMatch,
    closedAt: terminalNoMatch
      ? timestamp(row?.reconciliation_closed_at)
      : null
  };
  const delayAnchorAt = normalized.providerUnknownAt
    || normalized.providerMutationStartedAt;
  if (
    normalized.attemptId !== attemptId
    || !normalized.userId
    || (row?.user_id != null && uuid(row.user_id) !== normalized.userId)
    || !['charging', 'provider_unknown'].includes(normalized.status)
    || row?.transaction_id != null
    || row?.subscription_id != null
    || row?.customer_id != null
    || !['pro', 'enterprise'].includes(normalized.targetPlan)
    || !normalized.priceId
    || !PADDLE_PRICE_ID_PATTERN.test(normalized.priceId)
    || !Number.isSafeInteger(normalized.credits)
    || normalized.credits <= 0
    || !Number.isSafeInteger(normalized.unitAmount)
    || normalized.unitAmount <= 0
    || normalized.currencyCode !== 'USD'
    || normalized.expectedOrigin !== 'api'
    || !normalized.createdAt
    || !normalized.providerMutationStartedAt
    || (row?.provider_unknown_at != null && !normalized.providerUnknownAt)
    || (
      normalized.providerUnknownAt
      && Date.parse(normalized.providerUnknownAt)
        < Date.parse(normalized.providerMutationStartedAt)
    )
    || Date.parse(normalized.providerMutationStartedAt)
      < Date.parse(normalized.createdAt)
    || Date.parse(checkedAt)
      < Date.parse(delayAnchorAt) + RECONCILIATION_DELAY_MS
  ) {
    fail(
      'RECONCILIATION_ATTEMPT_CONTRACT_INVALID',
      'The unresolved checkout attempt contract is incomplete or not yet eligible.'
    );
  }
  if (terminalNoMatch) {
    const failedAt = timestamp(row?.failed_at);
    const updatedAt = timestamp(row?.updated_at);
    if (
      rowStatus !== 'reconciled_no_match'
      || row?.provider_error_code !== 'reconciled_definitive_no_match'
      || row?.review_required !== true
      || row?.reconciliation_decision !== 'definitive_no_match'
      || previousStatus !== normalized.status
      || !normalized.closedAt
      || !failedAt
      || failedAt !== normalized.closedAt
      || !updatedAt
      || updatedAt !== normalized.closedAt
      || Date.parse(normalized.closedAt) < Date.parse(checkedAt)
    ) {
      fail(
        'RECONCILIATION_ATTEMPT_CONTRACT_INVALID',
        'The terminal checkout reconciliation contract is incomplete.'
      );
    }
  } else if (
    rowStatus !== normalized.status
    || row?.reconciliation_decision != null
    || row?.reconciliation_previous_status != null
    || row?.reconciliation_closed_at != null
  ) {
    fail(
      'RECONCILIATION_ATTEMPT_CONTRACT_INVALID',
      'The unresolved checkout attempt contract is inconsistent.'
    );
  }
  return Object.freeze(normalized);
}

function contractFingerprint(expected) {
  return sha256Json({
    attemptId: expected.attemptId,
    userId: expected.userId,
    targetPlan: expected.targetPlan,
    priceId: expected.priceId,
    credits: expected.credits,
    unitAmount: String(expected.unitAmount),
    currencyCode: expected.currencyCode,
    expectedOrigin: expected.expectedOrigin,
    expectedCustomerId: expected.expectedCustomerId,
    windowStartAt: expected.windowStartAt,
    providerMutationStartedAt: expected.providerMutationStartedAt,
    providerUnknownAt: expected.providerUnknownAt
  });
}

function evidenceMatches(evidence, expected) {
  return Boolean(
    evidence?.scanComplete === true
    && evidence.attemptId === expected.attemptId
    && evidence.userId === expected.userId
    && evidence.targetPlan === expected.targetPlan
    && evidence.priceId === expected.priceId
    && evidence.credits === expected.credits
    && evidence.unitAmount === String(expected.unitAmount)
    && evidence.currencyCode === expected.currencyCode
    && evidence.expectedOrigin === expected.expectedOrigin
    && evidence.expectedCustomerId === expected.expectedCustomerId
    && evidence.windowStartAt === expected.windowStartAt
    && evidence.windowEndAt === expected.checkedAt
    && evidence.checkedAt === expected.checkedAt
    && Number.isSafeInteger(evidence.pagesScanned)
    && evidence.pagesScanned > 0
    && evidence.pagesScanned <= 256
    && Number.isSafeInteger(evidence.transactionsScanned)
    && evidence.transactionsScanned >= 0
    && evidence.transactionsScanned <= evidence.pagesScanned * 30
    && Array.isArray(evidence.apiRequestIds)
    && evidence.apiRequestIds.length === evidence.pagesScanned
    && evidence.apiRequestIds.every((value) => uuid(value))
    && new Set(evidence.apiRequestIds).size === evidence.apiRequestIds.length
  );
}

function normalizeScan(row, expected, ordinal) {
  if (!row) return null;
  const checkedAt = timestamp(row.checked_at);
  const windowStartAt = timestamp(row.window_start);
  const windowEndAt = timestamp(row.window_end);
  const evidence = {
    scanComplete: true,
    attemptId: expected.attemptId,
    userId: expected.userId,
    targetPlan: expected.targetPlan,
    priceId: expected.priceId,
    credits: expected.credits,
    unitAmount: String(expected.unitAmount),
    currencyCode: expected.currencyCode,
    expectedOrigin: expected.expectedOrigin,
    expectedCustomerId: expected.expectedCustomerId,
    windowStartAt,
    windowEndAt,
    checkedAt,
    pagesScanned: Number(row.pages_scanned),
    transactionsScanned: Number(row.transactions_scanned),
    apiRequestIds: Array.isArray(row.provider_request_ids)
      ? row.provider_request_ids.map(uuid)
      : []
  };
  const catalogRequestId = uuid(row.catalog_request_id);
  const fingerprint = contractFingerprint(expected);
  const evidenceHash = reconciliationEvidenceHash({
    expectedStatus: row.expected_status,
    evidence,
    catalogRequestId,
    contractFingerprint: fingerprint
  });
  if (
    uuid(row.attempt_id) !== expected.attemptId
    || uuid(row.authorized_user_id) !== expected.userId
    || row.scan_ordinal !== ordinal
    || row.expected_status !== expected.status
    || !evidenceMatches(evidence, { ...expected, checkedAt })
    || !catalogRequestId
    || row.contract_fingerprint !== fingerprint
    || row.evidence_hash !== evidenceHash
    || !/^pgsr_[0-9a-f-]{36}$/i.test(row.audit_reference || '')
    || !timestamp(row.recorded_at)
    || Date.parse(timestamp(row.recorded_at)) < Date.parse(checkedAt)
  ) {
    fail(
      'RECONCILIATION_SCAN_CONTRACT_INVALID',
      'The persisted first subscription reconciliation scan is incomplete.'
    );
  }
  return Object.freeze({
    expectedStatus: row.expected_status,
    evidence: Object.freeze({
      ...evidence,
      apiRequestIds: Object.freeze([...evidence.apiRequestIds])
    }),
    catalogRequestId,
    contractFingerprint: fingerprint,
    evidenceHash,
    auditReference: row.audit_reference,
    recordedAt: timestamp(row.recorded_at)
  });
}

function normalizeFirstScan(row, expected) {
  return normalizeScan(row, expected, 1);
}

function normalizeFinalScan(row, expected) {
  return normalizeScan(row, expected, 2);
}

function finalizationEligibleAt(firstScan) {
  const anchor = Math.max(
    Date.parse(firstScan.evidence.checkedAt),
    Date.parse(firstScan.recordedAt)
  );
  return new Date(anchor + FINALIZATION_DELAY_MS).toISOString();
}

function validateTerminalNoMatch(expected, firstScan, finalScan) {
  if (!firstScan || !finalScan) {
    fail(
      'RECONCILIATION_SCAN_CONTRACT_INVALID',
      'Both immutable reconciliation scans are required for a terminal attempt.'
    );
  }
  const eligibleAt = finalizationEligibleAt(firstScan);
  if (
    Date.parse(finalScan.evidence.checkedAt) < Date.parse(eligibleAt)
    || Date.parse(expected.closedAt) < Date.parse(eligibleAt)
    || firstScan.expectedStatus !== expected.status
    || finalScan.expectedStatus !== expected.status
    || firstScan.contractFingerprint !== finalScan.contractFingerprint
    || !evidenceScansAreIndependent(firstScan.evidence, finalScan.evidence)
    || firstScan.catalogRequestId === finalScan.catalogRequestId
    || finalScan.evidence.apiRequestIds.includes(firstScan.catalogRequestId)
    || firstScan.evidence.apiRequestIds.includes(finalScan.catalogRequestId)
  ) {
    fail(
      'RECONCILIATION_SCAN_CONTRACT_INVALID',
      'The terminal checkout reconciliation evidence is inconsistent.'
    );
  }
  return Object.freeze({
    ok: true,
    mode: 'idempotent',
    outcome: 'definitive_no_match',
    attemptId: expected.attemptId,
    status: 'reconciled_no_match',
    reviewRequired: true,
    previousStatus: expected.status,
    firstEvidence: evidenceSummary(firstScan.evidence),
    evidence: evidenceSummary(finalScan.evidence),
    auditReference: finalScan.auditReference,
    closedAt: expected.closedAt
  });
}

async function verifyPriceBinding({ apiKey, apiBase, expected, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(
      `${apiBase}/prices/${encodeURIComponent(expected.priceId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        redirect: 'error',
        signal: AbortSignal.timeout(PADDLE_BINDING_TIMEOUT_MS)
      }
    );
  } catch (_) {
    fail('RECONCILIATION_PADDLE_BINDING_UNVERIFIED', 'The Paddle price binding could not be verified.');
  }
  if (!response?.ok) {
    fail('RECONCILIATION_PADDLE_BINDING_UNVERIFIED', 'The Paddle price binding could not be verified.');
  }
  let body;
  try {
    body = await response.json();
  } catch (_) {
    fail('RECONCILIATION_PADDLE_BINDING_UNVERIFIED', 'The Paddle price binding could not be verified.');
  }
  const price = body?.data;
  const requestId = uuid(body?.meta?.request_id);
  if (
    price?.id !== expected.priceId
    || price?.type !== 'standard'
    || typeof price?.product_id !== 'string'
    || !PADDLE_PRODUCT_ID_PATTERN.test(price.product_id)
    || price?.unit_price?.amount !== String(expected.unitAmount)
    || price?.unit_price?.currency_code !== expected.currencyCode
    || price?.billing_cycle?.interval !== 'month'
    || price?.billing_cycle?.frequency !== 1
    || !requestId
  ) {
    fail('RECONCILIATION_PADDLE_BINDING_UNVERIFIED', 'The Paddle price binding could not be verified.');
  }
  return Object.freeze({ priceId: expected.priceId, providerRequestId: requestId });
}

function scanOptions(config, expected, fetchImpl) {
  return {
    apiKey: config.paddleApiKey,
    apiBase: config.paddleApiBase,
    fetchImpl,
    attemptId: expected.attemptId,
    userId: expected.userId,
    targetPlan: expected.targetPlan,
    priceId: expected.priceId,
    credits: expected.credits,
    unitAmount: expected.unitAmount,
    currencyCode: expected.currencyCode,
    expectedOrigin: expected.expectedOrigin,
    expectedCustomerId: expected.expectedCustomerId,
    windowStartAt: expected.windowStartAt,
    windowEndAt: expected.windowEndAt,
    checkedAt: expected.checkedAt
  };
}

function exactNoMatch(result, expected) {
  if (
    result?.status !== 'definitive_no_match'
    || result?.reason !== 'complete_scan_no_match'
    || !evidenceMatches(result.evidence, expected)
  ) {
    fail('RECONCILIATION_EVIDENCE_INVALID', 'The provider scan did not produce exact complete no-match evidence.');
  }
  return Object.freeze({
    ...result.evidence,
    apiRequestIds: Object.freeze(result.evidence.apiRequestIds.map(uuid))
  });
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

function safeResult(
  attemptId,
  result,
  catalogRequestId,
  currentStatus,
  mode = 'non-closing'
) {
  return Object.freeze({
    ok: true,
    mode,
    outcome: result?.status || 'ambiguous',
    reason: result?.reason || 'unknown',
    attemptId,
    status: currentStatus,
    writesApplied: false,
    transactionId: result?.transaction?.id || null,
    evidence: result?.evidence ? evidenceSummary(result.evidence) : null,
    catalogRequestId
  });
}

function auditReference(factory) {
  const value = text(factory(), 255);
  if (!value || !/^pgsr_[0-9a-f-]{36}$/i.test(value)) {
    fail('RECONCILIATION_AUDIT_REFERENCE_INVALID', 'The audit reference is invalid.');
  }
  return value;
}

function rpcArguments(expected, evidence, bindingRequestId, fingerprint, hash, audit) {
  return {
    p_attempt_id: expected.attemptId,
    p_expected_status: expected.status,
    p_checked_at: evidence.checkedAt,
    p_window_start: evidence.windowStartAt,
    p_window_end: evidence.windowEndAt,
    p_pages_scanned: evidence.pagesScanned,
    p_transactions_scanned: evidence.transactionsScanned,
    p_provider_request_ids: [...evidence.apiRequestIds],
    p_catalog_request_id: bindingRequestId,
    p_contract_fingerprint: fingerprint,
    p_evidence_hash: hash,
    p_audit_reference: audit
  };
}

async function callRpc({ supabase, rpcName, expected, evidence, bindingRequestId, fingerprint, hash, audit }) {
  let response;
  try {
    response = await supabase.rpc(
      rpcName,
      rpcArguments(expected, evidence, bindingRequestId, fingerprint, hash, audit)
    );
  } catch (_) {
    fail('RECONCILIATION_RPC_FAILED', 'The reconciliation RPC failed.');
  }
  if (response?.error || !response?.data) {
    fail('RECONCILIATION_RPC_FAILED', 'The reconciliation RPC failed.');
  }
  return response.data;
}

async function recordFirstScan(args) {
  const result = await callRpc({
    ...args,
    rpcName: 'record_subscription_checkout_no_match_scan'
  });
  const checkedAt = timestamp(result?.firstCheckedAt);
  const recordedAt = timestamp(result?.firstRecordedAt);
  const valid = uuid(result?.attemptId) === args.expected.attemptId
    && result?.status === args.expected.status
    && result?.scanOrdinal === 1
    && checkedAt === args.evidence.checkedAt
    && recordedAt
    && Date.parse(recordedAt) >= Date.parse(checkedAt);
  if (
    !valid
    || !(
      (result.applied === true && result.reason === 'reconciliation_scan_recorded')
      || (result.applied === false && result.reason === 'reconciliation_scan_duplicate')
    )
  ) {
    fail('RECONCILIATION_RPC_REJECTED', 'The first scan record was rejected.');
  }
  return Object.freeze({
    ok: true,
    mode: result.applied ? 'first-scan-recorded' : 'idempotent',
    outcome: 'definitive_no_match',
    attemptId: args.expected.attemptId,
    status: args.expected.status,
    firstRecordedAt: recordedAt,
    finalizationEligibleAt: finalizationEligibleAt({
      evidence: { checkedAt },
      recordedAt
    }),
    evidence: evidenceSummary(args.evidence),
    auditReference: args.audit,
    catalogRequestId: args.bindingRequestId
  });
}

async function finalizeNoMatch(args) {
  const result = await callRpc({
    ...args,
    rpcName: 'finalize_subscription_checkout_no_match'
  });
  const valid = uuid(result?.attemptId) === args.expected.attemptId
    && result?.status === 'reconciled_no_match'
    && result?.reviewRequired === true
    && result?.reconciliationDecision === 'definitive_no_match'
    && timestamp(result?.firstCheckedAt)
    && timestamp(result?.checkedAt) === args.evidence.checkedAt
    && timestamp(result?.closedAt);
  if (
    !valid
    || !(
      (result.applied === true && result.reason === 'attempt_reconciled_no_match')
      || (result.applied === false && result.reason === 'reconciliation_duplicate')
    )
  ) {
    fail('RECONCILIATION_RPC_REJECTED', 'The final reconciliation was rejected.');
  }
  return Object.freeze({
    ok: true,
    mode: result.applied ? 'finalized' : 'idempotent',
    outcome: 'definitive_no_match',
    attemptId: args.expected.attemptId,
    status: 'reconciled_no_match',
    reviewRequired: true,
    evidence: evidenceSummary(args.evidence),
    auditReference: args.audit,
    catalogRequestId: args.bindingRequestId,
    closedAt: timestamp(result.closedAt)
  });
}

async function runSubscriptionCheckoutReconciliation(options = {}) {
  const attemptId = uuid(options.attemptId);
  if (!attemptId) fail('RECONCILIATION_ATTEMPT_ID_INVALID', '--attempt-id must be a valid UUID.');
  if (options.apply !== undefined && typeof options.apply !== 'boolean') {
    fail('RECONCILIATION_ARGUMENT_INVALID', '--apply must be a boolean switch.');
  }
  const config = readRequiredEnvironment(options.env || process.env, {
    apply: options.apply === true
  });
  const nowImpl = options.now || (() => new Date());
  const checkedAt = timestamp(nowImpl());
  if (!checkedAt) fail('RECONCILIATION_CLOCK_INVALID', 'The operator clock is invalid.');
  const supabase = createServiceRoleClient(
    config,
    options.createClientImpl || createClient
  );
  const row = await readAttempt(supabase, attemptId);
  const terminalNoMatch = row?.status === 'reconciled_no_match';
  const firstScanRow = await readFirstScan(supabase, attemptId);
  const finalScanRow = terminalNoMatch
    ? await readFinalScan(supabase, attemptId)
    : null;
  const contractCheckedAt = terminalNoMatch
    ? timestamp(finalScanRow?.checked_at)
    : checkedAt;
  if (!contractCheckedAt) {
    fail(
      'RECONCILIATION_SCAN_CONTRACT_INVALID',
      'The terminal checkout reconciliation is missing its final scan.'
    );
  }
  const expected = normalizeAttempt(row, attemptId, contractCheckedAt, {
    terminalNoMatch
  });
  const firstScan = normalizeFirstScan(firstScanRow, expected);
  if (terminalNoMatch) {
    const finalScan = normalizeFinalScan(finalScanRow, expected);
    return validateTerminalNoMatch(expected, firstScan, finalScan);
  }
  if (
    firstScan
    && Date.parse(checkedAt)
      < Date.parse(finalizationEligibleAt(firstScan))
  ) {
    fail(
      'RECONCILIATION_FINALIZATION_DELAY_ACTIVE',
      'The persisted first scan must be at least 24 hours old before finalization.'
    );
  }
  const fetchImpl = options.fetchImpl || global.fetch;
  const binding = await verifyPriceBinding({
    apiKey: config.paddleApiKey,
    apiBase: config.paddleApiBase,
    expected,
    fetchImpl
  });
  const reconcileImpl = options.reconcileImpl || reconcileSubscriptionCheckout;
  const scanResult = await reconcileImpl(scanOptions(config, expected, fetchImpl));

  if (firstScan) {
    if (scanResult?.status !== 'definitive_no_match') {
      return safeResult(
        attemptId,
        scanResult,
        binding.providerRequestId,
        expected.status,
        'finalization-blocked'
      );
    }
    const evidence = exactNoMatch(scanResult, expected);
    if (
      !evidenceScansAreIndependent(firstScan.evidence, evidence)
      || !catalogEvidenceIsIndependent(evidence, binding.providerRequestId)
      || firstScan.catalogRequestId === binding.providerRequestId
      || evidence.apiRequestIds.includes(firstScan.catalogRequestId)
      || firstScan.evidence.apiRequestIds.includes(binding.providerRequestId)
    ) {
      fail('RECONCILIATION_FINAL_SCAN_NOT_INDEPENDENT', 'The final scan is not independent from the persisted first scan.');
    }
    const fingerprint = contractFingerprint(expected);
    const hash = reconciliationEvidenceHash({
      expectedStatus: expected.status,
      evidence,
      catalogRequestId: binding.providerRequestId,
      contractFingerprint: fingerprint
    });
    if (!options.apply) {
      return Object.freeze({
        ok: true,
        mode: 'dry-run-finalization',
        outcome: 'definitive_no_match',
        attemptId,
        readyToApply: (
          config.supabaseProjectRef === DEFAULT_EXPECTED_SUPABASE_PROJECT_REF
          && config.paddleKeyEnvironment === 'live'
          && config.paddleApiBase === DEFAULT_PADDLE_API_BASE
        ),
        firstEvidence: evidenceSummary(firstScan.evidence),
        evidence: evidenceSummary(evidence),
        catalogRequestId: binding.providerRequestId
      });
    }
    const completedAt = timestamp(nowImpl());
    if (
      !completedAt
      || Date.parse(completedAt) < Date.parse(evidence.checkedAt)
      || Date.parse(completedAt) - Date.parse(evidence.checkedAt) > MAX_EVIDENCE_AGE_MS
    ) {
      fail('RECONCILIATION_EVIDENCE_STALE', 'The provider evidence is too old to apply safely.');
    }
    return finalizeNoMatch({
      supabase,
      expected,
      evidence,
      bindingRequestId: binding.providerRequestId,
      fingerprint,
      hash,
      audit: auditReference(options.auditReferenceFactory || (() => `pgsr_${crypto.randomUUID()}`))
    });
  }

  if (scanResult?.status !== 'definitive_no_match') {
    return safeResult(
      attemptId,
      scanResult,
      binding.providerRequestId,
      expected.status
    );
  }
  const firstEvidence = exactNoMatch(scanResult, expected);
  if (!options.apply) {
    return Object.freeze({
      ok: true,
      mode: 'dry-run',
      outcome: 'definitive_no_match',
      attemptId,
      readyToApply: (
        config.supabaseProjectRef === DEFAULT_EXPECTED_SUPABASE_PROJECT_REF
        && config.paddleKeyEnvironment === 'live'
        && config.paddleApiBase === DEFAULT_PADDLE_API_BASE
      ),
      evidence: evidenceSummary(firstEvidence),
      catalogRequestId: binding.providerRequestId
    });
  }

  const confirmationAt = timestamp(nowImpl());
  if (!confirmationAt || Date.parse(confirmationAt) < Date.parse(checkedAt)) {
    fail('RECONCILIATION_CLOCK_INVALID', 'The operator clock is invalid.');
  }
  const confirmationExpected = normalizeAttempt(row, attemptId, confirmationAt);
  const confirmationResult = await reconcileImpl(
    scanOptions(config, confirmationExpected, fetchImpl)
  );
  if (confirmationResult?.status !== 'definitive_no_match') {
    return safeResult(
      attemptId,
      confirmationResult,
      binding.providerRequestId,
      confirmationExpected.status
    );
  }
  const evidence = exactNoMatch(confirmationResult, confirmationExpected);
  if (!evidenceScansAreIndependent(firstEvidence, evidence)) {
    fail('RECONCILIATION_CONFIRMATION_SCAN_NOT_INDEPENDENT', 'The confirmation scan is not independent.');
  }
  if (!catalogEvidenceIsIndependent(evidence, binding.providerRequestId)) {
    fail(
      'RECONCILIATION_CATALOG_EVIDENCE_NOT_INDEPENDENT',
      'The Paddle catalog request cannot be reused as transaction scan evidence.'
    );
  }
  const completedAt = timestamp(nowImpl());
  if (
    !completedAt
    || Date.parse(completedAt) < Date.parse(evidence.checkedAt)
    || Date.parse(completedAt) - Date.parse(evidence.checkedAt) > MAX_EVIDENCE_AGE_MS
  ) {
    fail('RECONCILIATION_EVIDENCE_STALE', 'The provider evidence is too old to apply safely.');
  }
  const fingerprint = contractFingerprint(confirmationExpected);
  const hash = reconciliationEvidenceHash({
    expectedStatus: confirmationExpected.status,
    evidence,
    catalogRequestId: binding.providerRequestId,
    contractFingerprint: fingerprint
  });
  return recordFirstScan({
    supabase,
    expected: confirmationExpected,
    evidence,
    bindingRequestId: binding.providerRequestId,
    fingerprint,
    hash,
    audit: auditReference(options.auditReferenceFactory || (() => `pgsr_${crypto.randomUUID()}`))
  });
}

function parseCliArguments(argv) {
  let attemptId = null;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      if (apply) fail('RECONCILIATION_ARGUMENT_INVALID', '--apply may only be provided once.');
      apply = true;
      continue;
    }
    if (argument === '--attempt-id') {
      if (attemptId !== null || index + 1 >= argv.length) {
        fail('RECONCILIATION_ARGUMENT_INVALID', '--attempt-id must be provided exactly once.');
      }
      attemptId = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith('--attempt-id=')) {
      if (attemptId !== null) {
        fail('RECONCILIATION_ARGUMENT_INVALID', '--attempt-id must be provided exactly once.');
      }
      attemptId = argument.slice('--attempt-id='.length);
      continue;
    }
    fail('RECONCILIATION_ARGUMENT_INVALID', 'Only --attempt-id and --apply are supported.');
  }
  if (attemptId === null) fail('RECONCILIATION_ATTEMPT_ID_REQUIRED', '--attempt-id is required.');
  return Object.freeze({ attemptId, apply });
}

async function main(argv = process.argv.slice(2)) {
  return runSubscriptionCheckoutReconciliation(parseCliArguments(argv));
}

if (require.main === module) {
  require('dotenv').config();
  main()
    .then((value) => console.log(JSON.stringify(value, null, 2)))
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
  ATTEMPT_COLUMNS,
  FINALIZATION_DELAY_MS,
  RECONCILIATION_DELAY_MS,
  SCAN_COLUMNS,
  contractFingerprint,
  evidenceMatches,
  finalizeNoMatch,
  main,
  normalizeAttempt,
  normalizeFinalScan,
  normalizeFirstScan,
  parseCliArguments,
  readAttempt,
  readFinalScan,
  readFirstScan,
  readScan,
  recordFirstScan,
  runSubscriptionCheckoutReconciliation,
  validateTerminalNoMatch,
  verifyPriceBinding
};
