'use strict';

const { getPaddleApiBase } = require('./paddle-api');
const { parsePostgresMinorUnitAmount } = require('./paddle-money');
const { parsePaddleTimestamp } = require('./paddle-time');

const MAX_AUDIT_PAGES = 256;
const DEFAULT_MAX_PAGES = MAX_AUDIT_PAGES;
const DEFAULT_TIMEOUT_MS = 8000;
const PADDLE_TRANSACTION_PAGE_SIZE = '30';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PADDLE_TRANSACTION_ID_PATTERN = /^txn_[a-z\d]{26}$/;
const PADDLE_SUBSCRIPTION_ID_PATTERN = /^sub_[a-z\d]{26}$/;
const PADDLE_CUSTOMER_ID_PATTERN = /^ctm_[a-z\d]{26}$/;
const PADDLE_PRICE_ID_PATTERN = /^pri_[a-z\d]{26}$/;
const PADDLE_PRODUCT_ID_PATTERN = /^pro_[a-z\d]{26}$/;
const TRANSACTION_STATUSES = new Set([
  'draft',
  'ready',
  'billed',
  'paid',
  'completed',
  'canceled',
  'past_due'
]);

function reconciliationResult(status, reason, details = {}) {
  return Object.freeze({
    status,
    reason,
    ...details
  });
}

function ambiguous(reason, details = {}) {
  return reconciliationResult('ambiguous', reason, details);
}

function isRecord(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
  );
}

function normalizeNonEmptyString(value, maxLength = 255) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function normalizeMinorUnitAmount(value) {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : value;
  return parsePostgresMinorUnitAmount(normalized) === null
    ? null
    : normalized;
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

function normalizeObservedAt(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return parsePaddleTimestamp(value);
}

function normalizeExpectedContract(options) {
  const purchaseRequestId = normalizeNonEmptyString(
    options?.purchaseRequestId,
    64
  );
  const subscriptionId = normalizeNonEmptyString(options?.subscriptionId);
  const customerId = normalizeNonEmptyString(options?.customerId);
  const packKey = normalizeNonEmptyString(options?.packKey, 100);
  const currencyCode = normalizeNonEmptyString(options?.currencyCode, 3);
  const unitAmount = normalizeMinorUnitAmount(options?.unitAmount);
  const subtotal = normalizeMinorUnitAmount(options?.subtotal);
  const discount = normalizeMinorUnitAmount(options?.discount);
  const tax = normalizeMinorUnitAmount(options?.tax);
  const total = normalizeMinorUnitAmount(options?.total);
  const credit = normalizeMinorUnitAmount(options?.credit);
  const balance = normalizeMinorUnitAmount(options?.balance);
  const grandTotal = normalizeMinorUnitAmount(options?.grandTotal);
  const grandTotalTax = normalizeMinorUnitAmount(options?.grandTotalTax);
  const windowStartAt = parsePaddleTimestamp(options?.windowStartAt);
  const windowEndAt = parsePaddleTimestamp(options?.windowEndAt);
  const checkedAt = normalizeObservedAt(options?.checkedAt);

  if (
    !purchaseRequestId
    || !UUID_PATTERN.test(purchaseRequestId)
    || !subscriptionId
    || !PADDLE_SUBSCRIPTION_ID_PATTERN.test(subscriptionId)
    || !customerId
    || !PADDLE_CUSTOMER_ID_PATTERN.test(customerId)
    || !packKey
    || !currencyCode
    || !/^[A-Z]{3}$/.test(currencyCode)
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
    || !windowEndAt
    || !checkedAt
  ) {
    return null;
  }

  const endVsStart = comparePaddleTimestamps(windowEndAt, windowStartAt);
  const endVsChecked = comparePaddleTimestamps(windowEndAt, checkedAt);
  const unitAmountValue = parsePostgresMinorUnitAmount(unitAmount);
  const subtotalValue = parsePostgresMinorUnitAmount(subtotal);
  const discountValue = parsePostgresMinorUnitAmount(discount);
  const taxValue = parsePostgresMinorUnitAmount(tax);
  const totalValue = parsePostgresMinorUnitAmount(total);
  const creditValue = parsePostgresMinorUnitAmount(credit);
  const balanceValue = parsePostgresMinorUnitAmount(balance);
  const grandTotalValue = parsePostgresMinorUnitAmount(grandTotal);
  const grandTotalTaxValue = parsePostgresMinorUnitAmount(grandTotalTax);
  if (
    endVsStart === null
    || endVsChecked === null
    || endVsStart < 0
    || endVsChecked !== 0
    || subtotalValue !== unitAmountValue
    || subtotalValue - discountValue + taxValue !== totalValue
    || creditValue > totalValue
    || totalValue - creditValue !== grandTotalValue
    || balanceValue !== grandTotalValue
    || grandTotalTaxValue > taxValue
  ) {
    return null;
  }

  return Object.freeze({
    purchaseRequestId,
    subscriptionId,
    customerId,
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
    windowEndAt,
    checkedAt
  });
}

function buildCreditPackTransactionListUrl(expected, apiBase) {
  const trustedApiBase = getPaddleApiBase({
    NODE_ENV: process.env.NODE_ENV,
    PADDLE_API_BASE: apiBase
  });
  const url = new URL('/transactions', trustedApiBase);
  url.searchParams.set('created_at[GTE]', expected.windowStartAt);
  url.searchParams.set('created_at[LTE]', expected.windowEndAt);
  url.searchParams.set('per_page', PADDLE_TRANSACTION_PAGE_SIZE);
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
    'per_page',
    'order_by'
  ];
  const allowedKeys = new Set([...fixedKeys, 'after']);
  const keys = [...nextUrl.searchParams.keys()];
  const hasUnexpectedOrDuplicateParameter = keys.some((key) => (
    !allowedKeys.has(key)
    || nextUrl.searchParams.getAll(key).length !== 1
  ));
  const fixedFiltersMatch = fixedKeys.every((key) => (
    nextUrl.searchParams.get(key) === firstUrl.searchParams.get(key)
  ));
  const after = normalizeNonEmptyString(
    nextUrl.searchParams.get('after'),
    255
  );
  const normalizedExpectedAfter = normalizeNonEmptyString(expectedAfter, 255);

  if (
    nextUrl.username
    || nextUrl.password
    || nextUrl.hash
    || nextUrl.origin !== firstUrl.origin
    || nextUrl.pathname !== firstUrl.pathname
    || hasUnexpectedOrDuplicateParameter
    || !fixedFiltersMatch
    || !after
    || !PADDLE_TRANSACTION_ID_PATTERN.test(after)
    || !normalizedExpectedAfter
    || after !== normalizedExpectedAfter
  ) {
    return null;
  }
  return nextUrl;
}

function metadataMarker(metadata) {
  if (metadata === null || metadata === undefined) {
    return { valid: true, requestId: null, kind: null, packKey: null };
  }
  if (!isRecord(metadata)) {
    return { valid: false, requestId: null, kind: null, packKey: null };
  }
  const requestId = metadata.promptgenPurchaseRequestId;
  return {
    valid: true,
    requestId: typeof requestId === 'string' ? requestId : null,
    kind: typeof metadata.promptgenKind === 'string'
      ? metadata.promptgenKind
      : null,
    packKey: typeof metadata.promptgenPackKey === 'string'
      ? metadata.promptgenPackKey
      : null
  };
}

function hasPartialPackMarker(marker, expected) {
  return marker.kind === 'credit_pack'
    && marker.packKey === expected.packKey
    && !marker.requestId;
}

function transactionScanEnvelopeIsValid(transaction, expected) {
  const createdAt = parsePaddleTimestamp(transaction?.created_at);
  const createdVsStart = createdAt
    ? comparePaddleTimestamps(createdAt, expected.windowStartAt)
    : null;
  const createdVsEnd = createdAt
    ? comparePaddleTimestamps(createdAt, expected.windowEndAt)
    : null;
  return Boolean(
    isRecord(transaction)
    && typeof transaction.id === 'string'
    && PADDLE_TRANSACTION_ID_PATTERN.test(transaction.id)
    && TRANSACTION_STATUSES.has(transaction?.status)
    && createdAt
    && createdVsStart !== null
    && createdVsEnd !== null
    && createdVsStart >= 0
    && createdVsEnd <= 0
    && Array.isArray(transaction?.items)
    && transaction.items.length > 0
    && transaction.items.length <= 100
  );
}

function exactTransactionEnvelopeMatches(transaction, expected) {
  return Boolean(
    transaction.subscription_id === expected.subscriptionId
    && transaction.customer_id === expected.customerId
    && transaction.origin === 'subscription_charge'
    && transaction.items.length === 1
  );
}

function exactAmountContractMatches(transaction, item, expected) {
  const price = item?.price;
  const totals = transaction?.details?.totals;
  const lineItems = transaction?.details?.line_items;
  const lineItem = Array.isArray(lineItems) && lineItems.length === 1
    ? lineItems[0]
    : null;
  const subtotal = parsePostgresMinorUnitAmount(totals?.subtotal);
  const discount = parsePostgresMinorUnitAmount(totals?.discount);
  const tax = parsePostgresMinorUnitAmount(totals?.tax);
  const total = parsePostgresMinorUnitAmount(totals?.total);
  const credit = parsePostgresMinorUnitAmount(totals?.credit);
  const balance = parsePostgresMinorUnitAmount(totals?.balance);
  const grandTotal = parsePostgresMinorUnitAmount(totals?.grand_total);
  const grandTotalTax = parsePostgresMinorUnitAmount(totals?.grand_total_tax);
  const lineSubtotal = parsePostgresMinorUnitAmount(
    lineItem?.totals?.subtotal
  );
  const lineDiscount = parsePostgresMinorUnitAmount(
    lineItem?.totals?.discount
  );
  const lineTax = parsePostgresMinorUnitAmount(lineItem?.totals?.tax);
  const lineTotal = parsePostgresMinorUnitAmount(lineItem?.totals?.total);

  if (
    subtotal === null
    || discount === null
    || tax === null
    || total === null
    || credit === null
    || balance === null
    || grandTotal === null
    || grandTotalTax === null
    || lineSubtotal === null
    || lineDiscount === null
    || lineTax === null
    || lineTotal === null
  ) {
    return false;
  }

  return Boolean(
    transaction.currency_code === expected.currencyCode
    && transaction.collection_mode === 'automatic'
    && price?.type === 'custom'
    && price?.billing_cycle === null
    && typeof price?.id === 'string'
    && PADDLE_PRICE_ID_PATTERN.test(price.id)
    && typeof price?.product_id === 'string'
    && PADDLE_PRODUCT_ID_PATTERN.test(price.product_id)
    && price?.unit_price?.amount === expected.unitAmount
    && price?.unit_price?.currency_code === expected.currencyCode
    && item?.quantity === 1
    && totals?.currency_code === expected.currencyCode
    && totals.subtotal === expected.subtotal
    && totals.discount === expected.discount
    && totals.tax === expected.tax
    && totals.total === expected.total
    && totals.credit === expected.credit
    && totals.grand_total === expected.grandTotal
    && totals.grand_total_tax === expected.grandTotalTax
    && subtotal - discount + tax === total
    && credit <= total
    && total - credit === grandTotal
    && grandTotalTax <= tax
    && (transaction.status !== 'completed' || balance === 0)
    && lineItem?.price_id === price.id
    && PADDLE_PRICE_ID_PATTERN.test(lineItem.price_id)
    && lineItem?.product?.id === price.product_id
    && PADDLE_PRODUCT_ID_PATTERN.test(lineItem.product.id)
    && lineItem?.quantity === 1
    && lineSubtotal === subtotal
    && lineDiscount === discount
    && lineTax === tax
    && lineTotal === total
  );
}

function classifyCreditPackTransaction(transaction, expected) {
  if (!transactionScanEnvelopeIsValid(transaction, expected)) {
    return { classification: 'partial', reason: 'invalid_transaction_envelope' };
  }

  const topMarker = metadataMarker(transaction.custom_data);
  if (!topMarker.valid) {
    return { classification: 'partial', reason: 'malformed_top_level_metadata' };
  }

  const itemMarkers = [];
  for (const item of transaction.items) {
    if (!isRecord(item?.price)) {
      return { classification: 'partial', reason: 'malformed_item' };
    }
    const marker = metadataMarker(item.price.custom_data);
    if (!marker.valid) {
      return { classification: 'partial', reason: 'malformed_item_metadata' };
    }
    itemMarkers.push(marker);
  }

  const exactTopMarker =
    topMarker.requestId === expected.purchaseRequestId;
  const exactItemIndexes = [];
  itemMarkers.forEach((marker, index) => {
    if (marker.requestId === expected.purchaseRequestId) {
      exactItemIndexes.push(index);
    }
  });
  const hasPartialMarker = hasPartialPackMarker(topMarker, expected)
    || itemMarkers.some((marker) => hasPartialPackMarker(marker, expected));

  if (!exactTopMarker && exactItemIndexes.length === 0) {
    const hasAnyRequestMarker = Boolean(topMarker.requestId)
      || itemMarkers.some((marker) => Boolean(marker.requestId));
    const markerlessExactEnvelope = !hasAnyRequestMarker
      && exactTransactionEnvelopeMatches(transaction, expected);
    // A subscription-charge transaction with the exact customer,
    // subscription, origin, and one-item envelope may be the missing request
    // even when Paddle omitted our marker or its totals differ. Treat it as
    // partial evidence before amount validation so an accepted payment can
    // never be closed as a definitive no-match merely because tax or totals
    // changed.
    return hasPartialMarker || markerlessExactEnvelope
      ? { classification: 'partial', reason: 'missing_exact_request_marker' }
      : { classification: 'irrelevant', reason: 'different_request' };
  }

  if (
    exactItemIndexes.length !== 1
    || transaction.items.length !== 1
    || exactItemIndexes[0] !== 0
  ) {
    return { classification: 'partial', reason: 'non_unique_request_marker' };
  }

  if (!exactTransactionEnvelopeMatches(transaction, expected)) {
    return { classification: 'partial', reason: 'identity_contract_mismatch' };
  }

  const itemMarker = itemMarkers[0];
  if (
    itemMarker.kind !== 'credit_pack'
    || itemMarker.packKey !== expected.packKey
  ) {
    return { classification: 'partial', reason: 'pack_metadata_mismatch' };
  }

  if (
    topMarker.requestId
    && topMarker.requestId !== expected.purchaseRequestId
  ) {
    return { classification: 'partial', reason: 'conflicting_request_marker' };
  }
  if (
    exactTopMarker
    && (
      topMarker.kind !== 'credit_pack'
      || topMarker.packKey !== expected.packKey
    )
  ) {
    return { classification: 'partial', reason: 'top_metadata_mismatch' };
  }

  if (!exactAmountContractMatches(transaction, transaction.items[0], expected)) {
    return { classification: 'partial', reason: 'amount_contract_mismatch' };
  }

  return {
    classification: 'match',
    transaction: Object.freeze({
      id: transaction.id,
      status: transaction.status,
      createdAt: transaction.created_at,
      subscriptionId: transaction.subscription_id,
      customerId: transaction.customer_id,
      currencyCode: transaction.currency_code,
      unitAmount: expected.unitAmount,
      grandTotal: expected.grandTotal,
      packKey: expected.packKey,
      purchaseRequestId: expected.purchaseRequestId
    })
  };
}

function validPaginationEnvelope(body) {
  const requestId = normalizeNonEmptyString(body?.meta?.request_id);
  const pagination = body?.meta?.pagination;
  return Boolean(
    Array.isArray(body?.data)
    && requestId
    && body.meta.request_id === requestId
    && UUID_PATTERN.test(requestId)
    && isRecord(pagination)
    && pagination.per_page === Number(PADDLE_TRANSACTION_PAGE_SIZE)
    && typeof pagination.has_more === 'boolean'
    && typeof pagination.next === 'string'
    && body.data.length <= Number(PADDLE_TRANSACTION_PAGE_SIZE)
    && (!pagination.has_more || body.data.length > 0)
  );
}

function buildReconciliationEvidence(expected, scan, scanComplete = false) {
  if (!expected) return null;
  return Object.freeze({
    scanComplete: scanComplete === true,
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
    checkedAt: expected.checkedAt,
    pagesScanned: scan.pagesScanned,
    transactionsScanned: scan.transactionsScanned,
    apiRequestIds: Object.freeze([...scan.apiRequestIds])
  });
}

function resultWithEvidence(
  status,
  reason,
  expected,
  scan,
  details = {},
  scanComplete = false
) {
  return reconciliationResult(status, reason, {
    evidence: buildReconciliationEvidence(expected, scan, scanComplete),
    ...details
  });
}

async function reconcileCreditPackPurchase(options = {}) {
  const expected = normalizeExpectedContract(options);
  if (!expected) {
    return ambiguous('invalid_expected_contract', {
      evidence: null
    });
  }

  const scan = {
    pagesScanned: 0,
    transactionsScanned: 0,
    apiRequestIds: []
  };

  const apiKey = normalizeNonEmptyString(options.apiKey, 2000);
  const fetchImpl = options.fetchImpl || global.fetch;
  const maxPagesWasProvided = options.maxPages !== undefined;
  const maxPagesIsValid = Number.isSafeInteger(options.maxPages)
    && options.maxPages > 0
    && options.maxPages <= MAX_AUDIT_PAGES;
  if (maxPagesWasProvided && !maxPagesIsValid) {
    return resultWithEvidence(
      'ambiguous',
      'invalid_scan_configuration',
      expected,
      scan
    );
  }
  const maxPages = maxPagesIsValid ? options.maxPages : DEFAULT_MAX_PAGES;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs)
    && options.timeoutMs > 0
    && options.timeoutMs <= 60000
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  if (!apiKey || typeof fetchImpl !== 'function') {
    return resultWithEvidence(
      'ambiguous',
      'provider_unavailable',
      expected,
      scan
    );
  }

  let firstUrl;
  try {
    firstUrl = buildCreditPackTransactionListUrl(
      expected,
      options.apiBase
    );
  } catch (_) {
    return resultWithEvidence(
      'ambiguous',
      'untrusted_api_base',
      expected,
      scan
    );
  }

  let nextUrl = firstUrl;
  const seenUrls = new Set();
  const seenTransactionIds = new Set();
  const seenAfterCursors = new Set();
  const seenApiRequestIds = new Set();
  const matches = [];
  let partialEvidence = null;

  for (let page = 0; page < maxPages; page += 1) {
    const requestUrl = nextUrl.toString();
    if (seenUrls.has(requestUrl)) {
      return resultWithEvidence(
        'ambiguous',
        'pagination_loop',
        expected,
        scan
      );
    }
    seenUrls.add(requestUrl);

    let response;
    try {
      response = await fetchImpl(requestUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Skip-Count': 'true'
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error'
      });
    } catch (_) {
      return resultWithEvidence(
        'ambiguous',
        'provider_unavailable',
        expected,
        scan
      );
    }
    if (!response?.ok) {
      return resultWithEvidence(
        'ambiguous',
        'provider_unavailable',
        expected,
        scan,
        {
          httpStatus: Number.isSafeInteger(response?.status)
            ? response.status
            : null
        }
      );
    }

    let body;
    try {
      body = await response.json();
    } catch (_) {
      return resultWithEvidence(
        'ambiguous',
        'malformed_provider_response',
        expected,
        scan
      );
    }
    if (!validPaginationEnvelope(body)) {
      return resultWithEvidence(
        'ambiguous',
        'malformed_provider_response',
        expected,
        scan
      );
    }

    const providerRequestId = body.meta.request_id;
    if (seenApiRequestIds.has(providerRequestId)) {
      return resultWithEvidence(
        'ambiguous',
        'duplicate_provider_request_id',
        expected,
        scan
      );
    }
    seenApiRequestIds.add(providerRequestId);
    scan.pagesScanned += 1;
    scan.transactionsScanned += body.data.length;
    scan.apiRequestIds.push(providerRequestId);

    for (const transaction of body.data) {
      const transactionId = transaction?.id;
      if (
        typeof transactionId !== 'string'
        || !PADDLE_TRANSACTION_ID_PATTERN.test(transactionId)
        || seenTransactionIds.has(transactionId)
      ) {
        return resultWithEvidence(
          'ambiguous',
          'duplicate_or_invalid_transaction',
          expected,
          scan
        );
      }
      seenTransactionIds.add(transactionId);

      const classification = classifyCreditPackTransaction(
        transaction,
        expected
      );
      if (
        classification.classification === 'partial'
        && !partialEvidence
      ) {
        partialEvidence = Object.freeze({
          transactionId,
          reason: classification.reason
        });
      }
      if (classification.classification === 'match') {
        matches.push(classification.transaction);
      }
    }

    if (!body.meta.pagination.has_more) {
      if (partialEvidence) {
        return resultWithEvidence(
          'ambiguous',
          'partial_evidence',
          expected,
          scan,
          { partialEvidence },
          true
        );
      }
      if (matches.length > 1) {
        return resultWithEvidence(
          'ambiguous',
          'multiple_matches',
          expected,
          scan,
          {
            transactionIds: Object.freeze(
              matches.map((match) => match.id)
            )
          },
          true
        );
      }
      if (matches.length === 1) {
        return resultWithEvidence(
          'matched',
          'exact_match',
          expected,
          scan,
          { transaction: matches[0] },
          true
        );
      }
      return resultWithEvidence(
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
      return resultWithEvidence(
        'ambiguous',
        'untrusted_pagination_url',
        expected,
        scan
      );
    }
    const after = validatedNext.searchParams.get('after');
    if (seenAfterCursors.has(after)) {
      return resultWithEvidence(
        'ambiguous',
        'pagination_loop',
        expected,
        scan
      );
    }
    seenAfterCursors.add(after);
    nextUrl = validatedNext;
  }

  return resultWithEvidence(
    'ambiguous',
    'pagination_incomplete',
    expected,
    scan
  );
}

module.exports = {
  buildCreditPackTransactionListUrl,
  classifyCreditPackTransaction,
  reconcileCreditPackPurchase,
  validateTransactionNextUrl
};
