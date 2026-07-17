'use strict';
require('dotenv').config();

const { getPaddleCatalogMetadata } = require('../lib/product-catalog');

const PADDLE_API_BASE = process.env.PADDLE_API_BASE || 'https://api.paddle.com';

async function getPaddleEntity(path, apiKey, fetchImpl = fetch) {
  const response = await fetchImpl(`${PADDLE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data) {
    throw new Error(`Paddle read failed (${response.status}) for ${path}`);
  }
  return body.data;
}

function collectMismatches(plan, expected, price, product) {
  const checks = [
    ['product.name', product.name, expected.productName],
    ['product.description', product.description, expected.productDescription],
    ['product.status', product.status, 'active'],
    ['price.name', price.name, expected.priceName],
    ['price.description', price.description, expected.internalDescription],
    ['price.status', price.status, 'active'],
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

  const metadata = getPaddleCatalogMetadata(env);
  const mismatches = [];

  for (const [plan, expected] of Object.entries(metadata)) {
    if (!expected.priceId) {
      mismatches.push({ plan, field: 'price.id', actual: null, expected: 'configured Paddle price ID' });
      continue;
    }
    const price = await getPaddleEntity(`/prices/${expected.priceId}`, apiKey, fetchImpl);
    const product = await getPaddleEntity(`/products/${price.product_id}`, apiKey, fetchImpl);
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

module.exports = { auditPaddleCatalog, collectMismatches };
