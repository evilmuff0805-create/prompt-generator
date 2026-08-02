'use strict';

require('dotenv').config();

const {
  getPaddleCatalogMetadata,
  validatePaddlePriceMappings
} = require('../lib/product-catalog');
const {
  MODERN_PADDLE_API_KEY_PATTERN,
  PADDLE_ENVIRONMENTS,
  PADDLE_SANDBOX_API_BASE,
  getPaddleApiKeyEnvironment
} = require('../lib/paddle-api');
const { parseExpectedTaxMode } = require('./audit-paddle-catalog');

const PADDLE_API_VERSION = '1';
const PREVIEW_PATH = '/transactions/preview';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const PRICE_ID_PATTERN = /^pri_[a-z\d]{26}$/;
const PRODUCT_ID_PATTERN = /^pro_[a-z\d]{26}$/;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const POSTAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{0,19}$/;
const MONEY_PATTERN = /^\d+$/;

class PaddleSandboxCheckoutPreviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PaddleSandboxCheckoutPreviewError';
    this.code = code;
    this.requiredScope = details.requiredScope || null;
    this.httpStatus = Number.isInteger(details.httpStatus)
      ? details.httpStatus
      : null;
  }
}

function previewError(code, message, details = {}) {
  return new PaddleSandboxCheckoutPreviewError(code, message, details);
}

function contractMismatch(contract, field) {
  return previewError(
    'PADDLE_SANDBOX_PREVIEW_CONTRACT_MISMATCH',
    `Paddle preview did not match ${contract} (${field}).`
  );
}

function readSandboxCheckoutPreviewConfig(env = process.env) {
  if (env.PADDLE_SANDBOX_PREVIEW_CONFIRMED !== 'true') {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_NOT_CONFIRMED',
      'PADDLE_SANDBOX_PREVIEW_CONFIRMED must be explicitly set to true.'
    );
  }
  if (env.PADDLE_API_BASE !== PADDLE_SANDBOX_API_BASE) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_BASE_REJECTED',
      'PADDLE_API_BASE must exactly match the Paddle Sandbox API base.'
    );
  }

  const rawApiKey = typeof env.PADDLE_API_KEY === 'string'
    ? env.PADDLE_API_KEY
    : '';
  const apiKey = rawApiKey.trim();
  if (
    rawApiKey !== apiKey
    || !MODERN_PADDLE_API_KEY_PATTERN.test(apiKey)
    || getPaddleApiKeyEnvironment(apiKey) !== PADDLE_ENVIRONMENTS.sandbox
  ) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_KEY_REJECTED',
      'PADDLE_API_KEY must be a modern Paddle Sandbox API key.'
    );
  }

  const rawCountryCode = typeof env.PADDLE_SANDBOX_PREVIEW_COUNTRY_CODE === 'string'
    ? env.PADDLE_SANDBOX_PREVIEW_COUNTRY_CODE
    : '';
  const rawPostalCode = typeof env.PADDLE_SANDBOX_PREVIEW_POSTAL_CODE === 'string'
    ? env.PADDLE_SANDBOX_PREVIEW_POSTAL_CODE
    : '';
  if (
    rawCountryCode !== rawCountryCode.trim()
    || !COUNTRY_CODE_PATTERN.test(rawCountryCode)
  ) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_COUNTRY_INVALID',
      'PADDLE_SANDBOX_PREVIEW_COUNTRY_CODE must be an uppercase two-letter country code.'
    );
  }
  if (
    rawPostalCode !== rawPostalCode.trim()
    || !POSTAL_CODE_PATTERN.test(rawPostalCode)
  ) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_POSTAL_CODE_INVALID',
      'PADDLE_SANDBOX_PREVIEW_POSTAL_CODE must be an explicit non-sensitive test postal code.'
    );
  }

  return Object.freeze({
    apiBase: PADDLE_SANDBOX_API_BASE,
    apiKey,
    address: Object.freeze({
      countryCode: rawCountryCode,
      postalCode: rawPostalCode
    })
  });
}

function buildSandboxCheckoutPreviewTargets(env = process.env) {
  const stableEnv = {
    ...env,
    PRO_PRICE_1099_ENABLED: 'false'
  };
  const stagedEnv = {
    ...env,
    PRO_PRICE_1099_ENABLED: 'true'
  };
  validatePaddlePriceMappings(stagedEnv);

  const stableMetadata = getPaddleCatalogMetadata(stableEnv);
  const stagedMetadata = getPaddleCatalogMetadata(stagedEnv);
  const currentTaxMode = parseExpectedTaxMode(
    env.PADDLE_CATALOG_EXPECTED_TAX_MODE,
    'PADDLE_CATALOG_EXPECTED_TAX_MODE'
  );
  const stableTaxMode = parseExpectedTaxMode(
    env.PADDLE_PRO_999_EXPECTED_TAX_MODE,
    'PADDLE_PRO_999_EXPECTED_TAX_MODE',
    currentTaxMode
  );

  const targets = [
    {
      key: 'pro.stable_999',
      expected: {
        ...stableMetadata.pro,
        priceTaxMode: stableTaxMode
      }
    },
    {
      key: 'pro.staged_1099',
      expected: {
        ...stagedMetadata.pro,
        priceTaxMode: currentTaxMode
      }
    },
    {
      key: 'enterprise.current',
      expected: {
        ...stableMetadata.enterprise,
        priceTaxMode: currentTaxMode
      }
    }
  ].map(({ key, expected }) => Object.freeze({
    key,
    expected: Object.freeze(expected)
  }));

  const priceIds = targets.map(({ expected }) => expected.priceId);
  if (
    priceIds.some((priceId) => !PRICE_ID_PATTERN.test(priceId || ''))
    || new Set(priceIds).size !== priceIds.length
  ) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_PRICE_IDS_INVALID',
      'The three Sandbox preview price IDs must be present, valid, and distinct.'
    );
  }
  return Object.freeze(targets);
}

function buildPreviewBody(target, address) {
  return {
    items: [{ price_id: target.expected.priceId, quantity: 1 }],
    address: {
      country_code: address.countryCode,
      postal_code: address.postalCode
    },
    currency_code: 'USD'
  };
}

function assertObject(value, contract, field) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw contractMismatch(contract, field);
  }
  return value;
}

function assertExact(actual, expected, contract, field) {
  if (actual !== expected) throw contractMismatch(contract, field);
}

function readMoney(value, contract, field) {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) {
    throw contractMismatch(contract, field);
  }
  return BigInt(value);
}

function readLineTotals(value, contract, field) {
  const totals = assertObject(value, contract, field);
  const subtotal = readMoney(totals.subtotal, contract, `${field}.subtotal`);
  const discount = readMoney(totals.discount, contract, `${field}.discount`);
  const tax = readMoney(totals.tax, contract, `${field}.tax`);
  const total = readMoney(totals.total, contract, `${field}.total`);
  if (subtotal < discount || subtotal - discount + tax !== total) {
    throw contractMismatch(contract, `${field}.arithmetic`);
  }
  return {
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  };
}

function readPreviewTotals(value, contract) {
  const totals = assertObject(value, contract, 'details.totals');
  const lineTotals = readLineTotals(totals, contract, 'details.totals');
  const credit = readMoney(totals.credit, contract, 'details.totals.credit');
  const creditToBalance = readMoney(
    totals.credit_to_balance,
    contract,
    'details.totals.credit_to_balance'
  );
  const balance = readMoney(totals.balance, contract, 'details.totals.balance');
  const grandTotal = readMoney(
    totals.grand_total,
    contract,
    'details.totals.grand_total'
  );
  const grandTotalTax = readMoney(
    totals.grand_total_tax,
    contract,
    'details.totals.grand_total_tax'
  );
  if (
    credit !== 0n
    || creditToBalance !== 0n
    || grandTotal !== BigInt(lineTotals.total)
    || balance !== grandTotal
    || grandTotalTax !== BigInt(lineTotals.tax)
    || totals.fee !== null
    || totals.earnings !== null
    || totals.currency_code !== 'USD'
  ) {
    throw contractMismatch(contract, 'details.totals.checkout_contract');
  }
  return {
    subtotal: lineTotals.subtotal,
    discount: lineTotals.discount,
    tax: lineTotals.tax,
    total: lineTotals.total,
    currencyCode: totals.currency_code
  };
}

function assertSameLineTotals(actual, expected, contract, field) {
  for (const key of ['subtotal', 'discount', 'tax', 'total']) {
    assertExact(actual[key], expected[key], contract, `${field}.${key}`);
  }
}

function parsePreviewResponse(body, target, config) {
  const contract = target.key;
  const envelope = assertObject(body, contract, 'response');
  const data = assertObject(envelope.data, contract, 'data');
  const meta = assertObject(envelope.meta, contract, 'meta');
  const requestId = typeof meta.request_id === 'string'
    ? meta.request_id.trim()
    : '';
  if (!requestId || requestId.length > 200) {
    throw contractMismatch(contract, 'meta.request_id');
  }

  if (data.id != null) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_ENTITY_CREATED',
      'Paddle unexpectedly returned a transaction ID for a preview-only request.'
    );
  }

  for (const field of [
    'customer_id',
    'address_id',
    'business_id',
    'discount_id',
    'customer_ip_address',
    'custom_data'
  ]) {
    assertExact(data[field], null, contract, field);
  }
  assertExact(data.currency_code, 'USD', contract, 'currency_code');
  const responseAddress = assertObject(data.address, contract, 'address');
  assertExact(
    responseAddress.country_code,
    config.address.countryCode,
    contract,
    'address.country_code'
  );
  assertExact(
    responseAddress.postal_code,
    config.address.postalCode,
    contract,
    'address.postal_code'
  );

  if (!Array.isArray(data.items) || data.items.length !== 1) {
    throw contractMismatch(contract, 'items.length');
  }
  const item = assertObject(data.items[0], contract, 'items[0]');
  const price = assertObject(item.price, contract, 'items[0].price');
  assertExact(price.id, target.expected.priceId, contract, 'price.id');
  if (!PRODUCT_ID_PATTERN.test(price.product_id || '')) {
    throw contractMismatch(contract, 'price.product_id');
  }
  assertExact(price.name, target.expected.priceName, contract, 'price.name');
  assertExact(
    price.description,
    target.expected.internalDescription,
    contract,
    'price.description'
  );
  assertExact(price.type, 'standard', contract, 'price.type');
  const billingCycle = assertObject(
    price.billing_cycle,
    contract,
    'price.billing_cycle'
  );
  assertExact(
    billingCycle.interval,
    target.expected.billingCycle.interval,
    contract,
    'price.billing_cycle.interval'
  );
  assertExact(
    billingCycle.frequency,
    target.expected.billingCycle.frequency,
    contract,
    'price.billing_cycle.frequency'
  );
  assertExact(price.trial_period, null, contract, 'price.trial_period');
  assertExact(
    price.tax_mode,
    target.expected.priceTaxMode,
    contract,
    'price.tax_mode'
  );
  const unitPrice = assertObject(price.unit_price, contract, 'price.unit_price');
  assertExact(
    unitPrice.amount,
    target.expected.unitAmount,
    contract,
    'price.unit_price.amount'
  );
  assertExact(
    unitPrice.currency_code,
    target.expected.currencyCode,
    contract,
    'price.unit_price.currency_code'
  );
  if (!Array.isArray(price.unit_price_overrides) || price.unit_price_overrides.length !== 0) {
    throw contractMismatch(contract, 'price.unit_price_overrides');
  }
  const quantity = assertObject(price.quantity, contract, 'price.quantity');
  assertExact(quantity.minimum, 1, contract, 'price.quantity.minimum');
  assertExact(quantity.maximum, 1, contract, 'price.quantity.maximum');
  assertExact(price.status, 'active', contract, 'price.status');
  assertExact(item.quantity, 1, contract, 'items[0].quantity');
  assertExact(item.proration, null, contract, 'items[0].proration');
  assertExact(item.include_in_totals, true, contract, 'items[0].include_in_totals');

  const details = assertObject(data.details, contract, 'details');
  if (!Array.isArray(details.tax_rates_used)) {
    throw contractMismatch(contract, 'details.tax_rates_used');
  }
  const totals = readPreviewTotals(details.totals, contract);
  assertExact(
    totals.subtotal,
    target.expected.unitAmount,
    contract,
    'details.totals.subtotal_list_price'
  );
  assertExact(totals.discount, '0', contract, 'details.totals.discount');
  if (!Array.isArray(details.line_items) || details.line_items.length !== 1) {
    throw contractMismatch(contract, 'details.line_items.length');
  }
  const lineItem = assertObject(details.line_items[0], contract, 'details.line_items[0]');
  assertExact(
    lineItem.price_id,
    target.expected.priceId,
    contract,
    'line_item.price_id'
  );
  assertExact(lineItem.quantity, 1, contract, 'line_item.quantity');
  assertExact(lineItem.proration, null, contract, 'line_item.proration');
  const unitTotals = readLineTotals(
    lineItem.unit_totals,
    contract,
    'line_item.unit_totals'
  );
  const lineTotals = readLineTotals(
    lineItem.totals,
    contract,
    'line_item.totals'
  );
  assertSameLineTotals(unitTotals, lineTotals, contract, 'line_item.unit_totals');
  assertSameLineTotals(lineTotals, totals, contract, 'line_item.totals');

  const product = assertObject(lineItem.product, contract, 'line_item.product');
  assertExact(product.id, price.product_id, contract, 'product.id');
  assertExact(product.name, target.expected.productName, contract, 'product.name');
  assertExact(
    product.description,
    target.expected.productDescription,
    contract,
    'product.description'
  );
  assertExact(product.type, 'standard', contract, 'product.type');
  assertExact(product.tax_category, 'saas', contract, 'product.tax_category');
  assertExact(product.status, 'active', contract, 'product.status');

  return Object.freeze({
    contract,
    requestId,
    priceId: price.id,
    productId: product.id,
    productName: product.name,
    priceName: price.name,
    unitAmount: unitPrice.amount,
    currencyCode: unitPrice.currency_code,
    billingCycle: Object.freeze({
      interval: billingCycle.interval,
      frequency: billingCycle.frequency
    }),
    taxMode: price.tax_mode,
    totals: Object.freeze(totals)
  });
}

async function requestPreview(target, config, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(`${config.apiBase}${PREVIEW_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Paddle-Version': PADDLE_API_VERSION
      },
      body: JSON.stringify(buildPreviewBody(target, config.address)),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    throw previewError(
      timedOut
        ? 'PADDLE_SANDBOX_PREVIEW_TIMEOUT'
        : 'PADDLE_SANDBOX_PREVIEW_REQUEST_FAILED',
      timedOut
        ? 'Paddle Sandbox checkout preview timed out.'
        : 'Paddle Sandbox checkout preview request failed.'
    );
  }

  if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_MALFORMED_RESPONSE',
      'Paddle Sandbox checkout preview returned an invalid response.'
    );
  }
  if (response.redirected === true) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_REDIRECT_REJECTED',
      'Paddle Sandbox checkout preview returned a redirect.'
    );
  }
  if (!response.ok) {
    const code = response.status === 403
      ? 'PADDLE_SANDBOX_PREVIEW_PERMISSION_DENIED'
      : response.status === 401
        ? 'PADDLE_SANDBOX_PREVIEW_AUTHENTICATION_FAILED'
        : 'PADDLE_SANDBOX_PREVIEW_HTTP_ERROR';
    throw previewError(
      code,
      response.status === 403
        ? 'Paddle Sandbox checkout preview requires transaction.read permission.'
        : 'Paddle Sandbox checkout preview returned a non-success status.',
      { httpStatus: response.status, requiredScope: 'transaction.read' }
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (_) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_MALFORMED_RESPONSE',
      'Paddle Sandbox checkout preview returned invalid JSON.'
    );
  }
  return parsePreviewResponse(body, target, config);
}

async function auditPaddleSandboxCheckoutPreview({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const config = readSandboxCheckoutPreviewConfig(env);
  const targets = buildSandboxCheckoutPreviewTargets(env);
  if (typeof fetchImpl !== 'function') {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_FETCH_INVALID',
      'A fetch implementation is required.'
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_TIMEOUT_INVALID',
      `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`
    );
  }

  const previews = [];
  const requestIds = new Set();
  for (const target of targets) {
    const preview = await requestPreview(target, config, fetchImpl, timeoutMs);
    if (requestIds.has(preview.requestId)) {
      throw previewError(
        'PADDLE_SANDBOX_PREVIEW_EVIDENCE_REUSED',
        'Paddle Sandbox checkout previews reused provider evidence.'
      );
    }
    requestIds.add(preview.requestId);
    previews.push(preview);
  }

  if (
    previews[0].productId !== previews[1].productId
    || previews[0].productId === previews[2].productId
  ) {
    throw previewError(
      'PADDLE_SANDBOX_PREVIEW_PRODUCT_LINKAGE_INVALID',
      'Paddle Sandbox checkout preview product linkage is invalid.'
    );
  }

  return Object.freeze({
    success: true,
    complete: true,
    mode: 'transaction-preview-no-entity',
    environment: 'sandbox',
    requiredScope: 'transaction.read',
    entityCreated: false,
    location: Object.freeze({
      countryCode: config.address.countryCode,
      postalCode: config.address.postalCode
    }),
    previews: Object.freeze(previews)
  });
}

if (require.main === module) {
  auditPaddleSandboxCheckoutPreview()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((error) => {
      const safe = error instanceof PaddleSandboxCheckoutPreviewError
        ? error
        : previewError(
          'PADDLE_SANDBOX_PREVIEW_INTERNAL_ERROR',
          'Paddle Sandbox checkout preview audit stopped because of an internal error.'
        );
      console.error(JSON.stringify({
        success: false,
        complete: false,
        mode: 'transaction-preview-no-entity',
        environment: 'sandbox',
        error: {
          code: safe.code,
          message: safe.message,
          ...(safe.requiredScope ? { requiredScope: safe.requiredScope } : {}),
          ...(safe.httpStatus == null ? {} : { httpStatus: safe.httpStatus })
        }
      }, null, 2));
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  PaddleSandboxCheckoutPreviewError,
  auditPaddleSandboxCheckoutPreview,
  buildSandboxCheckoutPreviewTargets,
  buildPreviewBody,
  parsePreviewResponse,
  readSandboxCheckoutPreviewConfig
};
