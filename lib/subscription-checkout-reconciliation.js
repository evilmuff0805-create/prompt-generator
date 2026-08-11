'use strict';

const { getPaddleApiBase } = require('./paddle-api');
const { parsePaddleTimestamp } = require('./paddle-time');

const MAX_AUDIT_PAGES = 256;
const DEFAULT_TIMEOUT_MS = 8000;
const PAGE_SIZE = '30';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PADDLE_TRANSACTION_ID_PATTERN = /^txn_[a-z\d]{26}$/;
const PADDLE_SUBSCRIPTION_ID_PATTERN = /^sub_[a-z\d]{26}$/;
const PADDLE_CUSTOMER_ID_PATTERN = /^ctm_[a-z\d]{26}$/;
const PADDLE_PRICE_ID_PATTERN = /^pri_[a-z\d]{26}$/;
const TRANSACTION_STATUSES = new Set([
  'draft',
  'ready',
  'billed',
  'paid',
  'completed',
  'canceled',
  'past_due'
]);

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value, maxLength = 255) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function timestamp(value) {
  const parsed = parsePaddleTimestamp(value);
  return parsed ? new Date(parsed).toISOString() : null;
}

function normalizeExpectedContract(options) {
  const attemptId = text(options?.attemptId, 64);
  const userId = text(options?.userId, 64);
  const targetPlan = text(options?.targetPlan, 32);
  const priceId = text(options?.priceId);
  const currencyCode = text(options?.currencyCode, 3);
  const expectedOrigin = text(options?.expectedOrigin, 32);
  const expectedCustomerId = options?.expectedCustomerId == null
    ? null
    : text(options.expectedCustomerId);
  const credits = Number(options?.credits);
  const unitAmount = Number(options?.unitAmount);
  const windowStartAt = timestamp(options?.windowStartAt);
  const windowEndAt = timestamp(options?.windowEndAt);
  const checkedAt = timestamp(options?.checkedAt);
  if (
    !attemptId
    || !UUID_PATTERN.test(attemptId)
    || !userId
    || !UUID_PATTERN.test(userId)
    || !['pro', 'enterprise'].includes(targetPlan)
    || !priceId
    || !PADDLE_PRICE_ID_PATTERN.test(priceId)
    || !Number.isSafeInteger(credits)
    || credits <= 0
    || !Number.isSafeInteger(unitAmount)
    || unitAmount <= 0
    || currencyCode !== 'USD'
    || expectedOrigin !== 'api'
    || (expectedCustomerId && !PADDLE_CUSTOMER_ID_PATTERN.test(expectedCustomerId))
    || !windowStartAt
    || !windowEndAt
    || !checkedAt
    || windowEndAt !== checkedAt
    || Date.parse(windowEndAt) < Date.parse(windowStartAt)
  ) {
    return null;
  }
  return Object.freeze({
    attemptId: attemptId.toLowerCase(),
    userId: userId.toLowerCase(),
    targetPlan,
    priceId,
    credits,
    unitAmount: String(unitAmount),
    currencyCode,
    expectedOrigin,
    expectedCustomerId,
    windowStartAt,
    windowEndAt,
    checkedAt
  });
}

function buildSubscriptionCheckoutTransactionListUrl(expected, apiBase) {
  const trustedApiBase = getPaddleApiBase({
    NODE_ENV: process.env.NODE_ENV,
    PADDLE_API_BASE: apiBase
  });
  const url = new URL('/transactions', trustedApiBase);
  url.searchParams.set('created_at[GTE]', expected.windowStartAt);
  url.searchParams.set('created_at[LTE]', expected.windowEndAt);
  url.searchParams.set('origin', expected.expectedOrigin);
  url.searchParams.set('per_page', PAGE_SIZE);
  url.searchParams.set('order_by', 'id[DESC]');
  return url;
}

function validateTransactionNextUrl(nextValue, firstUrl, expectedAfter) {
  if (typeof nextValue !== 'string' || !nextValue.trim()) return null;
  let nextUrl;
  try {
    nextUrl = new URL(nextValue);
  } catch (_) {
    return null;
  }
  const fixedKeys = [
    'created_at[GTE]',
    'created_at[LTE]',
    'origin',
    'per_page',
    'order_by'
  ];
  const allowed = new Set([...fixedKeys, 'after']);
  const keys = [...nextUrl.searchParams.keys()];
  const after = text(nextUrl.searchParams.get('after'));
  if (
    nextUrl.username
    || nextUrl.password
    || nextUrl.hash
    || nextUrl.origin !== firstUrl.origin
    || nextUrl.pathname !== firstUrl.pathname
    || keys.some((key) => (
      !allowed.has(key)
      || nextUrl.searchParams.getAll(key).length !== 1
    ))
    || fixedKeys.some((key) => (
      nextUrl.searchParams.get(key) !== firstUrl.searchParams.get(key)
    ))
    || !after
    || !PADDLE_TRANSACTION_ID_PATTERN.test(after)
    || after !== expectedAfter
  ) {
    return null;
  }
  return nextUrl;
}

function subscriptionMarker(customData, expected) {
  if (!isRecord(customData)) {
    return {
      exact: false,
      partial: false,
      differentAttempt: false,
      attemptId: null,
      kind: null,
      plan: null
    };
  }
  const attemptId = typeof customData.promptgenCheckoutAttemptId === 'string'
    ? customData.promptgenCheckoutAttemptId
    : null;
  const kind = typeof customData.promptgenKind === 'string'
    ? customData.promptgenKind
    : null;
  const plan = typeof customData.promptgenTargetPlan === 'string'
    ? customData.promptgenTargetPlan
    : null;
  const exactKeys = Object.keys(customData).sort().join(',')
    === [
      'promptgenCheckoutAttemptId',
      'promptgenKind',
      'promptgenTargetPlan'
    ].sort().join(',');
  const exact = exactKeys
    && attemptId === expected.attemptId
    && kind === 'subscription_checkout'
    && plan === expected.targetPlan;
  const differentAttempt = Boolean(
    attemptId
    && UUID_PATTERN.test(attemptId)
    && attemptId.toLowerCase() !== expected.attemptId
  );
  const partial = !exact && (
    attemptId === expected.attemptId
    || (
      !differentAttempt
      && kind === 'subscription_checkout'
      && plan === expected.targetPlan
    )
  );
  return { exact, partial, differentAttempt, attemptId, kind, plan };
}

function priceContractMatches(transaction, expected) {
  const item = Array.isArray(transaction?.items)
    && transaction.items.length === 1
    ? transaction.items[0]
    : null;
  const price = item?.price;
  return Boolean(
    item?.quantity === 1
    && price?.id === expected.priceId
    && price?.type === 'standard'
    && price?.unit_price?.amount === expected.unitAmount
    && price?.unit_price?.currency_code === expected.currencyCode
    && price?.billing_cycle?.interval === 'month'
    && price?.billing_cycle?.frequency === 1
    && transaction?.currency_code === expected.currencyCode
    && transaction?.collection_mode === 'automatic'
  );
}

function classifySubscriptionCheckoutTransaction(transaction, expected) {
  const marker = subscriptionMarker(transaction?.custom_data, expected);
  const createdAt = timestamp(transaction?.created_at);
  const idValid = typeof transaction?.id === 'string'
    && PADDLE_TRANSACTION_ID_PATTERN.test(transaction.id);
  const inWindow = createdAt
    && Date.parse(createdAt) >= Date.parse(expected.windowStartAt)
    && Date.parse(createdAt) <= Date.parse(expected.windowEndAt);
  const statusValid = TRANSACTION_STATUSES.has(transaction?.status);
  const customerValid = typeof transaction?.customer_id === 'string'
    && PADDLE_CUSTOMER_ID_PATTERN.test(transaction.customer_id)
    && (
      !expected.expectedCustomerId
      || transaction.customer_id === expected.expectedCustomerId
    );
  const identityEnvelope = transaction?.origin === expected.expectedOrigin
    && customerValid;
  const priceMatches = priceContractMatches(transaction, expected);

  if (!marker.exact) {
    // A valid, server-minted attempt ID identifies a different checkout even
    // when that checkout happens to use the same plan and price. Treating it as
    // markerless evidence would make unrelated customer traffic permanently
    // block this attempt's conservative no-match reconciliation.
    if (marker.differentAttempt) {
      return { classification: 'irrelevant', reason: 'different_attempt' };
    }
    if (marker.partial) {
      return { classification: 'partial', reason: 'partial_attempt_marker' };
    }
    const markerlessCandidate = idValid
      && inWindow
      && statusValid
      && identityEnvelope
      && priceMatches;
    return markerlessCandidate
      ? { classification: 'partial', reason: 'missing_exact_attempt_marker' }
      : { classification: 'irrelevant', reason: 'different_attempt' };
  }
  if (!idValid || !inWindow || !statusValid) {
    return { classification: 'partial', reason: 'invalid_transaction_envelope' };
  }
  if (!identityEnvelope) {
    return { classification: 'partial', reason: 'customer_or_origin_mismatch' };
  }
  if (!priceMatches) {
    return { classification: 'partial', reason: 'subscription_contract_mismatch' };
  }
  if (
    transaction.status === 'completed'
    && (
      typeof transaction.subscription_id !== 'string'
      || !PADDLE_SUBSCRIPTION_ID_PATTERN.test(transaction.subscription_id)
    )
  ) {
    return { classification: 'partial', reason: 'completed_identity_incomplete' };
  }
  return {
    classification: 'match',
    transaction: Object.freeze({
      id: transaction.id,
      status: transaction.status,
      createdAt,
      subscriptionId: transaction.subscription_id || null,
      customerId: transaction.customer_id,
      attemptId: expected.attemptId,
      targetPlan: expected.targetPlan,
      priceId: expected.priceId,
      unitAmount: expected.unitAmount,
      currencyCode: expected.currencyCode
    })
  };
}

function result(status, reason, expected, scan, details = {}, complete = false) {
  return Object.freeze({
    status,
    reason,
    evidence: expected ? Object.freeze({
      scanComplete: complete,
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
      checkedAt: expected.checkedAt,
      pagesScanned: scan.pagesScanned,
      transactionsScanned: scan.transactionsScanned,
      apiRequestIds: Object.freeze([...scan.apiRequestIds])
    }) : null,
    ...details
  });
}

function paginationEnvelopeValid(body) {
  const requestId = text(body?.meta?.request_id);
  const pagination = body?.meta?.pagination;
  return Boolean(
    Array.isArray(body?.data)
    && requestId
    && UUID_PATTERN.test(requestId)
    && isRecord(pagination)
    && pagination.per_page === Number(PAGE_SIZE)
    && typeof pagination.has_more === 'boolean'
    && typeof pagination.next === 'string'
    && body.data.length <= Number(PAGE_SIZE)
    && (!pagination.has_more || body.data.length > 0)
  );
}

async function reconcileSubscriptionCheckout(options = {}) {
  const expected = normalizeExpectedContract(options);
  const scan = { pagesScanned: 0, transactionsScanned: 0, apiRequestIds: [] };
  if (!expected) return result('ambiguous', 'invalid_expected_contract', null, scan);
  const apiKey = text(options.apiKey, 2000);
  const fetchImpl = options.fetchImpl || global.fetch;
  const maxPages = options.maxPages === undefined
    ? MAX_AUDIT_PAGES
    : options.maxPages;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs)
    && options.timeoutMs > 0
    && options.timeoutMs <= 60000
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  if (
    !apiKey
    || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(maxPages)
    || maxPages <= 0
    || maxPages > MAX_AUDIT_PAGES
  ) {
    return result('ambiguous', 'invalid_scan_configuration', expected, scan);
  }

  let firstUrl;
  try {
    firstUrl = buildSubscriptionCheckoutTransactionListUrl(
      expected,
      options.apiBase
    );
  } catch (_) {
    return result('ambiguous', 'untrusted_api_base', expected, scan);
  }
  let nextUrl = firstUrl;
  const seenUrls = new Set();
  const seenTransactions = new Set();
  const seenCursors = new Set();
  const seenRequestIds = new Set();
  const matches = [];
  let partialEvidence = null;

  for (let page = 0; page < maxPages; page += 1) {
    const requestUrl = nextUrl.toString();
    if (seenUrls.has(requestUrl)) {
      return result('ambiguous', 'pagination_loop', expected, scan);
    }
    seenUrls.add(requestUrl);
    let response;
    try {
      response = await fetchImpl(requestUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Skip-Count': 'true'
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error'
      });
    } catch (_) {
      return result('ambiguous', 'provider_unavailable', expected, scan);
    }
    if (!response?.ok) {
      return result('ambiguous', 'provider_unavailable', expected, scan, {
        httpStatus: Number.isSafeInteger(response?.status) ? response.status : null
      });
    }
    let body;
    try {
      body = await response.json();
    } catch (_) {
      return result('ambiguous', 'malformed_provider_response', expected, scan);
    }
    if (!paginationEnvelopeValid(body)) {
      return result('ambiguous', 'malformed_provider_response', expected, scan);
    }
    const providerRequestId = body.meta.request_id.toLowerCase();
    if (seenRequestIds.has(providerRequestId)) {
      return result('ambiguous', 'duplicate_provider_request_id', expected, scan);
    }
    seenRequestIds.add(providerRequestId);
    scan.pagesScanned += 1;
    scan.transactionsScanned += body.data.length;
    scan.apiRequestIds.push(providerRequestId);

    for (const transaction of body.data) {
      if (
        typeof transaction?.id !== 'string'
        || !PADDLE_TRANSACTION_ID_PATTERN.test(transaction.id)
        || seenTransactions.has(transaction.id)
      ) {
        return result(
          'ambiguous',
          'duplicate_or_invalid_transaction',
          expected,
          scan
        );
      }
      seenTransactions.add(transaction.id);
      const classification = classifySubscriptionCheckoutTransaction(
        transaction,
        expected
      );
      if (classification.classification === 'partial' && !partialEvidence) {
        partialEvidence = Object.freeze({
          transactionId: transaction.id,
          reason: classification.reason
        });
      }
      if (classification.classification === 'match') {
        matches.push(classification.transaction);
      }
    }

    if (!body.meta.pagination.has_more) {
      if (partialEvidence) {
        return result(
          'ambiguous',
          'partial_evidence',
          expected,
          scan,
          { partialEvidence },
          true
        );
      }
      if (matches.length > 1) {
        return result('ambiguous', 'multiple_matches', expected, scan, {
          transactionIds: Object.freeze(matches.map((match) => match.id))
        }, true);
      }
      if (matches.length === 1) {
        return result('matched', 'exact_attempt_transaction_found', expected, scan, {
          transaction: matches[0]
        }, true);
      }
      return result(
        'definitive_no_match',
        'complete_scan_no_match',
        expected,
        scan,
        {},
        true
      );
    }
    const expectedAfter = body.data[body.data.length - 1]?.id;
    const validatedNext = validateTransactionNextUrl(
      body.meta.pagination.next,
      firstUrl,
      expectedAfter
    );
    if (!validatedNext) {
      return result('ambiguous', 'untrusted_pagination_url', expected, scan);
    }
    const after = validatedNext.searchParams.get('after');
    if (seenCursors.has(after)) {
      return result('ambiguous', 'pagination_loop', expected, scan);
    }
    seenCursors.add(after);
    nextUrl = validatedNext;
  }
  return result('ambiguous', 'pagination_incomplete', expected, scan);
}

module.exports = {
  buildSubscriptionCheckoutTransactionListUrl,
  classifySubscriptionCheckoutTransaction,
  reconcileSubscriptionCheckout,
  validateTransactionNextUrl
};
