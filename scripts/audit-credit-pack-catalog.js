'use strict';
require('dotenv').config();

const {
  getCreditPackCatalogMetadata
} = require('../lib/credit-pack-catalog');

const LEGACY_PRICE_VARIABLES = Object.freeze({
  usage_600: 'PADDLE_CREDIT_PACK_600_LEGACY_PRICE_IDS',
  usage_1500: 'PADDLE_CREDIT_PACK_1500_LEGACY_PRICE_IDS',
  usage_3000: 'PADDLE_CREDIT_PACK_3000_LEGACY_PRICE_IDS'
});

function parsePriceIds(value) {
  return [...new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

async function getPaddlePrice(priceId, apiKey, apiBase, fetchImpl = fetch) {
  const response = await fetchImpl(`${apiBase}/prices/${priceId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data) {
    throw new Error(`Paddle read failed (${response.status}) for price ${priceId}`);
  }
  return body.data;
}

function collectArchivedPriceMismatches(packKey, priceId, price) {
  const checks = [
    ['price.id', price?.id, priceId],
    ['price.status', price?.status, 'archived'],
    ['price.billing_cycle', price?.billing_cycle, null]
  ];
  return checks
    .filter(([, actual, expected]) => actual !== expected)
    .map(([field, actual, expected]) => ({
      packKey,
      priceId,
      field,
      actual,
      expected
    }));
}

function collectLegacyPriceIds(env) {
  const owners = new Map();
  for (const [packKey, variableName] of Object.entries(LEGACY_PRICE_VARIABLES)) {
    for (const priceId of parsePriceIds(env[variableName])) {
      if (owners.has(priceId) && owners.get(priceId) !== packKey) {
        throw new Error(
          `Legacy add-on price ${priceId} is assigned to multiple packs.`
        );
      }
      owners.set(priceId, packKey);
    }
  }
  return [...owners.entries()].map(([priceId, packKey]) => ({ priceId, packKey }));
}

async function auditCreditPackCatalog({ env = process.env, fetchImpl = fetch } = {}) {
  // This also verifies the immutable local receipt/amount/expiry contract.
  getCreditPackCatalogMetadata(env);

  const legacyPrices = collectLegacyPriceIds(env);
  if (legacyPrices.length === 0) return [];

  const apiKey = env.PADDLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'PADDLE_API_KEY is required when legacy add-on Price IDs are configured.'
    );
  }

  const apiBase = env.PADDLE_API_BASE || 'https://api.paddle.com';
  const mismatches = [];
  for (const { priceId, packKey } of legacyPrices) {
    const price = await getPaddlePrice(priceId, apiKey, apiBase, fetchImpl);
    mismatches.push(...collectArchivedPriceMismatches(packKey, priceId, price));
  }
  return mismatches;
}

if (require.main === module) {
  auditCreditPackCatalog()
    .then((mismatches) => {
      if (mismatches.length) {
        console.error(JSON.stringify({ success: false, mismatches }, null, 2));
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({
        success: true,
        pricingMode: 'subscription_charge_non_catalog',
        legacyReusablePrices: 'archived-or-none',
        mode: 'read-only'
      }));
    })
    .catch((error) => {
      console.error(`[credit-pack-catalog-audit] ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  LEGACY_PRICE_VARIABLES,
  parsePriceIds,
  collectLegacyPriceIds,
  collectArchivedPriceMismatches,
  auditCreditPackCatalog
};
