'use strict';

const {
  CREDIT_PACKS,
  isCreditLedgerV2Enabled,
  isCreditPackPurchasesEnabled,
  getCreditPack,
  parseExpiryDays,
  getCreditPackCatalogMetadata,
  validateCreditPackConfiguration,
  getPublicCreditPackCatalog
} = require('../../lib/credit-pack-catalog');

describe('credit pack catalog', () => {
  const enabledEnv = {
    CREDIT_LEDGER_V2_ENABLED: 'true',
    CREDIT_PACK_PURCHASES_ENABLED: 'true',
    CREDIT_PACK_EXPIRY_DAYS: '365',
    PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas',
    PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true'
  };

  test('uses the approved provisional ladder without reusable Paddle price IDs', () => {
    expect(CREDIT_PACKS).toMatchObject({
      usage_600: { credits: 600, priceUsd: 10, priceCents: 1000 },
      usage_1500: { credits: 1500, priceUsd: 20, priceCents: 2000 },
      usage_3000: { credits: 3000, priceUsd: 40, priceCents: 4000 }
    });
    expect(getCreditPack('usage_600', enabledEnv)).toEqual({
      key: 'usage_600',
      credits: 600,
      priceUsd: 10,
      priceCents: 1000
    });
    expect(JSON.stringify(CREDIT_PACKS)).not.toMatch(/priceId|pri_/);
  });

  test('is disabled by default and exposes no purchasable pack', () => {
    expect(isCreditLedgerV2Enabled({})).toBe(false);
    expect(isCreditPackPurchasesEnabled({})).toBe(false);
    expect(getPublicCreditPackCatalog({})).toEqual({
      enabled: false,
      eligibility: 'active_paid_subscription',
      expiryDays: 365,
      packs: []
    });
  });

  test('requires the isolated ledger and selects transaction-specific non-catalog pricing', () => {
    expect(() => validateCreditPackConfiguration({
      CREDIT_PACK_PURCHASES_ENABLED: 'true'
    })).toThrow('requires CREDIT_LEDGER_V2_ENABLED');

    expect(() => validateCreditPackConfiguration({
      ...enabledEnv,
      PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'false'
    })).toThrow('requires written confirmation');

    expect(validateCreditPackConfiguration(enabledEnv)).toEqual({
      enabled: true,
      ledgerEnabled: true,
      expiryDays: 365,
      pricingMode: 'subscription_charge_non_catalog'
    });
  });

  test('public catalog never exposes provider price IDs', () => {
    const catalog = getPublicCreditPackCatalog(enabledEnv);
    expect(catalog.enabled).toBe(true);
    expect(catalog.packs).toEqual([
      { key: 'usage_600', credits: 600, priceUsd: 10, currencyCode: 'USD' },
      { key: 'usage_1500', credits: 1500, priceUsd: 20, currencyCode: 'USD' },
      { key: 'usage_3000', credits: 3000, priceUsd: 40, currencyCode: 'USD' }
    ]);
    expect(JSON.stringify(catalog)).not.toMatch(/pri_pack_/);
    expect(JSON.stringify(catalog)).not.toMatch(/productName|priceName|internalDescription/);
  });

  test('defines the exact receipt and inline one-time price contract', () => {
    const metadata = getCreditPackCatalogMetadata(enabledEnv);

    expect(metadata.usage_600).toMatchObject({
      key: 'usage_600',
      productName: 'PromptGen AI Usage Add-on — 600 Credits',
      productDescription:
        'One-time purchase of 600 PromptGen usage credits. ' +
        'An active paid subscription is required. Credits expire 365 days after purchase. ' +
        'PromptGen use only; non-transferable; no cash value.',
      priceName: '600 Credits - One-time',
      unitAmount: '1000',
      currencyCode: 'USD',
      billingCycle: null,
      quantity: { minimum: 1, maximum: 1 }
    });
    expect(metadata.usage_1500.productName).toContain('1,500 Credits');
    expect(metadata.usage_3000.unitAmount).toBe('4000');
    expect(JSON.stringify(metadata)).not.toMatch(/priceId|legacyPriceIds|pri_/);
  });

  test('expiry guard is fixed to the customer-visible 365-day contract', () => {
    expect(parseExpiryDays(undefined)).toBe(365);
    expect(parseExpiryDays('365')).toBe(365);
    expect(() => parseExpiryDays('29')).toThrow('must be exactly 365');
    expect(() => parseExpiryDays('366')).toThrow('must be exactly 365');
    expect(() => parseExpiryDays('3651')).toThrow('must be exactly 365');
  });
});
