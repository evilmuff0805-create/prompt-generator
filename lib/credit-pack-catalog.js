'use strict';

const CREDIT_PACKS = Object.freeze({
  usage_600: Object.freeze({
    key: 'usage_600',
    credits: 600,
    priceUsd: 10,
    priceCents: 1000
  }),
  usage_1500: Object.freeze({
    key: 'usage_1500',
    credits: 1500,
    priceUsd: 20,
    priceCents: 2000
  }),
  usage_3000: Object.freeze({
    key: 'usage_3000',
    credits: 3000,
    priceUsd: 40,
    priceCents: 4000
  })
});

function isEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function isCreditLedgerV2Enabled(env = process.env) {
  return isEnabled(env.CREDIT_LEDGER_V2_ENABLED);
}

function isCreditPackPurchasesEnabled(env = process.env) {
  return isEnabled(env.CREDIT_PACK_PURCHASES_ENABLED);
}

function getCreditPack(packKey, env = process.env) {
  const definition = CREDIT_PACKS[String(packKey || '')];
  if (!definition) return null;
  return { ...definition };
}

function parseExpiryDays(value) {
  if (value == null || String(value).trim() === '') return 365;
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed === 365 && String(parsed) === String(value).trim()) {
    return 365;
  }
  const error = new Error(
    '[credit-packs] CREDIT_PACK_EXPIRY_DAYS must be exactly 365 to match the customer contract'
  );
  error.code = 'CREDIT_PACK_EXPIRY_CONTRACT_MISMATCH';
  throw error;
}

function buildCreditPackReceiptContract(definition, expiryDays) {
  const creditsLabel = definition.credits.toLocaleString('en-US');
  const priceLabel = definition.priceUsd.toFixed(2);
  return Object.freeze({
    productName: `PromptGen AI Usage Add-on — ${creditsLabel} Credits`,
    productDescription:
      `One-time purchase of ${creditsLabel} PromptGen usage credits. ` +
      `An active paid subscription is required. Credits expire ${expiryDays} days after purchase. ` +
      'PromptGen use only; non-transferable; no cash value.',
    priceName: `${creditsLabel} Credits - One-time`,
    internalDescription:
      `${creditsLabel} PromptGen usage credits - $${priceLabel} one-time - ` +
      `active paid subscription required - expires after ${expiryDays} days - ` +
      'PromptGen use only - non-transferable - no cash value',
    unitAmount: String(definition.priceCents),
    currencyCode: 'USD',
    billingCycle: null,
    quantity: Object.freeze({ minimum: 1, maximum: 1 })
  });
}

function getCreditPackCatalogMetadata(env = process.env) {
  const expiryDays = parseExpiryDays(env.CREDIT_PACK_EXPIRY_DAYS);
  return Object.freeze(Object.fromEntries(
    Object.keys(CREDIT_PACKS).map((key) => {
      const pack = getCreditPack(key, env);
      return [key, Object.freeze({
        key,
        credits: pack.credits,
        priceUsd: pack.priceUsd,
        expiryDays,
        ...buildCreditPackReceiptContract(pack, expiryDays)
      })];
    })
  ));
}

function validateCreditPackConfiguration(env = process.env, reservedPriceIds = []) {
  const enabled = isCreditPackPurchasesEnabled(env);
  const ledgerEnabled = isCreditLedgerV2Enabled(env);

  if (enabled && !ledgerEnabled) {
    const error = new Error(
      '[credit-packs] CREDIT_PACK_PURCHASES_ENABLED requires CREDIT_LEDGER_V2_ENABLED'
    );
    error.code = 'CREDIT_PACK_LEDGER_REQUIRED';
    throw error;
  }

  if (
    enabled
    && String(env.PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED || '')
      .trim()
      .toLowerCase() !== 'true'
  ) {
    const error = new Error(
      '[credit-packs] CREDIT_PACK_PURCHASES_ENABLED requires written confirmation of PADDLE_CREDIT_PACK_TAX_CATEGORY'
    );
    error.code = 'CREDIT_PACK_TAX_CATEGORY_CONFIRMATION_REQUIRED';
    throw error;
  }

  return {
    enabled,
    ledgerEnabled,
    expiryDays: parseExpiryDays(env.CREDIT_PACK_EXPIRY_DAYS),
    // Add-ons use a server-only, transaction-specific non-catalog price.
    // There is intentionally no reusable Paddle Price ID for Paddle.js to
    // discover or invoke directly.
    pricingMode: 'subscription_charge_non_catalog'
  };
}

function getPublicCreditPackCatalog(env = process.env) {
  const enabled = isCreditPackPurchasesEnabled(env) && isCreditLedgerV2Enabled(env);
  return {
    enabled,
    eligibility: 'active_paid_subscription',
    expiryDays: parseExpiryDays(env.CREDIT_PACK_EXPIRY_DAYS),
    packs: enabled
      ? Object.values(CREDIT_PACKS).map(({ key, credits, priceUsd }) => ({
        key,
        credits,
        priceUsd,
        currencyCode: 'USD'
      }))
      : []
  };
}

module.exports = {
  CREDIT_PACKS,
  isCreditLedgerV2Enabled,
  isCreditPackPurchasesEnabled,
  getCreditPack,
  parseExpiryDays,
  buildCreditPackReceiptContract,
  getCreditPackCatalogMetadata,
  validateCreditPackConfiguration,
  getPublicCreditPackCatalog
};
