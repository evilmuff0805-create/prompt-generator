'use strict';
require('dotenv').config();

const {
  getPaddleCatalogMetadata,
  isPro1099Enabled
} = require('../lib/product-catalog');
const {
  DEFAULT_PADDLE_API_BASE,
  getPaddleApiBase
} = require('../lib/paddle-api');

const ALLOWED_STATUSES = new Set(['active', 'archived']);
const DEFAULT_AUDIT_CONTRACT = Object.freeze({
  productStatus: 'active',
  productType: 'standard',
  productTaxCategory: 'saas',
  priceStatus: 'active',
  priceType: 'standard',
  priceTaxMode: 'account_setting',
  trialPeriod: null
});

async function getPaddleEntity(
  path,
  apiKey,
  fetchImpl = fetch,
  apiBase = DEFAULT_PADDLE_API_BASE
) {
  const response = await fetchImpl(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data) {
    throw new Error(`Paddle read failed (${response.status}) for ${path}`);
  }
  return body.data;
}

function parsePriceIdList(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(value
    .split(',')
    .map((priceId) => priceId.trim())
    .filter(Boolean))];
}

function parseExpectedStatus(value, variableName) {
  const status = String(value || '').trim().toLowerCase();
  if (!ALLOWED_STATUSES.has(status)) {
    throw new Error(
      `${variableName} must be explicitly set to active or archived before the staged Pro audit can pass.`
    );
  }
  return status;
}

function parseLegacyPriceExpectations(env, legacyPriceIds) {
  const variableName = 'PADDLE_PRO_LEGACY_PRICE_EXPECTATIONS';
  const raw = String(env[variableName] || '').trim();
  let parsed = {};

  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      throw new Error(`${variableName} must be valid JSON.`);
    }
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${variableName} must be a JSON object keyed by Paddle price ID.`);
  }

  const configuredIds = Object.keys(parsed);
  const missingIds = legacyPriceIds.filter((priceId) => !Object.hasOwn(parsed, priceId));
  const extraIds = configuredIds.filter((priceId) => !legacyPriceIds.includes(priceId));
  if (missingIds.length > 0 || extraIds.length > 0) {
    throw new Error(
      `${variableName} must exactly cover PADDLE_PRO_LEGACY_PRICE_IDS ` +
      `(missing: ${missingIds.join(', ') || 'none'}; extra: ${extraIds.join(', ') || 'none'}).`
    );
  }

  return Object.fromEntries(legacyPriceIds.map((priceId) => {
    const expectation = parsed[priceId];
    if (!expectation || Array.isArray(expectation) || typeof expectation !== 'object') {
      throw new Error(`${variableName}.${priceId} must be an object.`);
    }
    const unknownFields = Object.keys(expectation)
      .filter((field) => !['status', 'unitAmount', 'productStatus'].includes(field));
    if (unknownFields.length > 0) {
      throw new Error(
        `${variableName}.${priceId} has unsupported fields: ${unknownFields.join(', ')}.`
      );
    }

    const unitAmount = String(expectation.unitAmount ?? '').trim();
    if (!/^[1-9]\d*$/.test(unitAmount)) {
      throw new Error(`${variableName}.${priceId}.unitAmount must be a positive integer in cents.`);
    }

    return [priceId, {
      unitAmount,
      priceStatus: parseExpectedStatus(
        expectation.status,
        `${variableName}.${priceId}.status`
      ),
      productStatus: expectation.productStatus == null
        ? DEFAULT_AUDIT_CONTRACT.productStatus
        : parseExpectedStatus(
          expectation.productStatus,
          `${variableName}.${priceId}.productStatus`
        )
    }];
  }));
}

function withAuditContract(expected, overrides = {}) {
  return {
    ...expected,
    ...DEFAULT_AUDIT_CONTRACT,
    ...overrides
  };
}

function withProUnitAmount(expected, { priceId, unitAmount, priceStatus, productStatus }) {
  const monthlyPriceUsd = Number(unitAmount) / 100;
  return withAuditContract({
    ...expected,
    priceId,
    monthlyPriceUsd,
    unitAmount,
    internalDescription: expected.internalDescription.replace(
      /\$\d+\.\d{2}\/month/,
      `$${monthlyPriceUsd.toFixed(2)}/month`
    )
  }, {
    priceStatus,
    productStatus
  });
}

function buildPaddleAuditTargets(env = process.env) {
  const currentMetadata = getPaddleCatalogMetadata(env);
  const targets = Object.entries(currentMetadata).map(([plan, expected]) => ({
    plan: `${plan}.current`,
    expected: withAuditContract(expected)
  }));

  if (!isPro1099Enabled(env)) return targets;

  const stablePriceId = String(env.PADDLE_PRO_PRICE_ID || '').trim();
  const stagedPriceId = String(env.PADDLE_PRO_1099_PRICE_ID || '').trim();
  const legacyPriceIds = parsePriceIdList(env.PADDLE_PRO_LEGACY_PRICE_IDS);
  if (!stablePriceId) {
    throw new Error('PADDLE_PRO_PRICE_ID is required for the staged Pro catalog audit.');
  }
  if (legacyPriceIds.includes(stablePriceId) || legacyPriceIds.includes(stagedPriceId)) {
    throw new Error(
      'PADDLE_PRO_LEGACY_PRICE_IDS must not repeat the stable or staged Pro price ID.'
    );
  }

  const stableMetadata = getPaddleCatalogMetadata({
    ...env,
    PRO_PRICE_1099_ENABLED: 'false'
  }).pro;
  targets.push({
    plan: 'pro.stable_999',
    expected: withProUnitAmount(stableMetadata, {
      priceId: stablePriceId,
      unitAmount: '999',
      priceStatus: parseExpectedStatus(
        env.PADDLE_PRO_999_EXPECTED_STATUS,
        'PADDLE_PRO_999_EXPECTED_STATUS'
      ),
      productStatus: DEFAULT_AUDIT_CONTRACT.productStatus
    })
  });

  const legacyExpectations = parseLegacyPriceExpectations(env, legacyPriceIds);
  for (const priceId of legacyPriceIds) {
    targets.push({
      plan: `pro.legacy:${priceId}`,
      expected: withProUnitAmount(stableMetadata, {
        priceId,
        ...legacyExpectations[priceId]
      })
    });
  }

  return targets;
}

function collectMismatches(plan, expected, price, product) {
  const checks = [
    ['product.name', product.name, expected.productName],
    ['product.description', product.description, expected.productDescription],
    ['product.status', product.status, expected.productStatus],
    ['product.type', product.type, expected.productType],
    ['product.tax_category', product.tax_category, expected.productTaxCategory],
    ['price.name', price.name, expected.priceName],
    ['price.description', price.description, expected.internalDescription],
    ['price.status', price.status, expected.priceStatus],
    ['price.type', price.type, expected.priceType],
    ['price.tax_mode', price.tax_mode, expected.priceTaxMode],
    ['price.trial_period', price.trial_period, expected.trialPeriod],
    ['price.unit_price.amount', price.unit_price?.amount, expected.unitAmount],
    ['price.unit_price.currency_code', price.unit_price?.currency_code, expected.currencyCode],
    ['price.billing_cycle.interval', price.billing_cycle?.interval, expected.billingCycle.interval],
    ['price.billing_cycle.frequency', price.billing_cycle?.frequency, expected.billingCycle.frequency],
    ['price.quantity.minimum', price.quantity?.minimum, expected.quantity.minimum],
    ['price.quantity.maximum', price.quantity?.maximum, expected.quantity.maximum]
  ];

  return checks
    .filter(([, actual, wanted]) => actual !== wanted)
    .map(([field, actual, wanted]) => ({ plan, field, actual, expected: wanted }));
}

async function auditPaddleCatalog({ env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = env.PADDLE_API_KEY;
  if (!apiKey) throw new Error('PADDLE_API_KEY is required for the read-only catalog audit.');

  const targets = buildPaddleAuditTargets(env);
  const mismatches = [];
  const apiBase = getPaddleApiBase(env);

  for (const { plan, expected } of targets) {
    if (!expected.priceId) {
      mismatches.push({ plan, field: 'price.id', actual: null, expected: 'configured Paddle price ID' });
      continue;
    }
    const price = await getPaddleEntity(`/prices/${expected.priceId}`, apiKey, fetchImpl, apiBase);
    const product = await getPaddleEntity(`/products/${price.product_id}`, apiKey, fetchImpl, apiBase);
    mismatches.push(...collectMismatches(plan, expected, price, product));
  }

  return mismatches;
}

if (require.main === module) {
  auditPaddleCatalog()
    .then((mismatches) => {
      if (mismatches.length) {
        console.error(JSON.stringify({ success: false, mismatches }, null, 2));
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ success: true, plans: ['pro', 'enterprise'] }));
    })
    .catch((error) => {
      console.error(`[paddle-catalog-audit] ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  auditPaddleCatalog,
  buildPaddleAuditTargets,
  collectMismatches,
  parseLegacyPriceExpectations
};
