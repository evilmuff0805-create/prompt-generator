'use strict';

const {
  auditPaddleCatalog,
  buildPaddleAuditTargets,
  collectMismatches
} = require('../../scripts/audit-paddle-catalog');
const { getPaddleCatalogMetadata } = require('../../lib/product-catalog');

describe('read-only Paddle catalog audit', () => {
  const baseExpected = getPaddleCatalogMetadata({
    PADDLE_PRO_PRICE_ID: 'pri_pro_live'
  }).pro;
  const expected = {
    ...baseExpected,
    productStatus: 'active',
    productType: 'standard',
    productTaxCategory: 'saas',
    priceStatus: 'active',
    priceType: 'standard',
    priceTaxMode: 'account_setting',
    trialPeriod: null
  };

  function matchingEntities(contract = expected, productId = 'pro_promptgen') {
    return {
      price: {
        product_id: productId,
        name: contract.priceName,
        description: contract.internalDescription,
        status: contract.priceStatus,
        type: contract.priceType,
        tax_mode: contract.priceTaxMode,
        trial_period: contract.trialPeriod,
        unit_price: { amount: contract.unitAmount, currency_code: contract.currencyCode },
        billing_cycle: { ...contract.billingCycle },
        quantity: { ...contract.quantity }
      },
      product: {
        name: contract.productName,
        description: contract.productDescription,
        status: contract.productStatus,
        type: contract.productType,
        tax_category: contract.productTaxCategory
      }
    };
  }

  test('canonical metadata와 일치하면 mismatch가 없다', () => {
    const { price, product } = matchingEntities();
    expect(collectMismatches('pro', expected, price, product)).toEqual([]);
  });

  test('문구와 금액 drift를 필드별로 보고한다', () => {
    const { price, product } = matchingEntities();
    product.description = 'Includes priority processing';
    price.unit_price.amount = '1999';

    expect(collectMismatches('pro', expected, price, product)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'product.description' }),
      expect.objectContaining({ field: 'price.unit_price.amount' })
    ]));
  });

  test('trial, quantity, item type, and tax contract drift를 필드별로 보고한다', () => {
    const { price, product } = matchingEntities();
    product.tax_category = 'standard';
    price.tax_mode = 'external';
    price.trial_period = { interval: 'day', frequency: 7 };
    price.quantity.maximum = 100;

    expect(collectMismatches('pro.current', expected, price, product)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'product.tax_category', expected: 'saas' }),
        expect.objectContaining({ field: 'price.tax_mode', expected: 'account_setting' }),
        expect.objectContaining({ field: 'price.trial_period', expected: null }),
        expect.objectContaining({ field: 'price.quantity.maximum', expected: 1 })
      ])
    );
  });

  test('staged USD 10.99 audit requires an explicit stable USD 9.99 status gate', () => {
    expect(() => buildPaddleAuditTargets({
      PRO_PRICE_1099_ENABLED: 'true',
      PADDLE_PRO_PRICE_ID: 'pri_pro_999',
      PADDLE_PRO_1099_PRICE_ID: 'pri_pro_1099',
      PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise'
    })).toThrow('PADDLE_PRO_999_EXPECTED_STATUS');
  });

  test('staged audit emits separate current, stable USD 9.99, and explicit legacy contracts', () => {
    const targets = buildPaddleAuditTargets({
      PRO_PRICE_1099_ENABLED: 'true',
      PADDLE_PRO_PRICE_ID: 'pri_pro_999',
      PADDLE_PRO_1099_PRICE_ID: 'pri_pro_1099',
      PADDLE_PRO_999_EXPECTED_STATUS: 'archived',
      PADDLE_PRO_LEGACY_PRICE_IDS: 'pri_pro_899',
      PADDLE_PRO_LEGACY_PRICE_EXPECTATIONS:
        '{"pri_pro_899":{"unitAmount":"899","status":"active","productStatus":"active"}}',
      PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise'
    });

    expect(targets.map(({ plan }) => plan)).toEqual([
      'pro.current',
      'enterprise.current',
      'pro.stable_999',
      'pro.legacy:pri_pro_899'
    ]);
    expect(targets.find(({ plan }) => plan === 'pro.current').expected).toEqual(
      expect.objectContaining({
        priceId: 'pri_pro_1099',
        unitAmount: '1099',
        priceStatus: 'active'
      })
    );
    expect(targets.find(({ plan }) => plan === 'pro.stable_999').expected).toEqual(
      expect.objectContaining({
        priceId: 'pri_pro_999',
        unitAmount: '999',
        priceStatus: 'archived',
        trialPeriod: null,
        priceTaxMode: 'account_setting',
        productTaxCategory: 'saas'
      })
    );
    expect(targets.find(({ plan }) => plan === 'pro.legacy:pri_pro_899').expected).toEqual(
      expect.objectContaining({
        priceId: 'pri_pro_899',
        unitAmount: '899',
        priceStatus: 'active'
      })
    );
  });

  test('legacy expectations must exactly cover explicit legacy IDs', () => {
    const env = {
      PRO_PRICE_1099_ENABLED: 'true',
      PADDLE_PRO_PRICE_ID: 'pri_pro_999',
      PADDLE_PRO_1099_PRICE_ID: 'pri_pro_1099',
      PADDLE_PRO_999_EXPECTED_STATUS: 'active',
      PADDLE_PRO_LEGACY_PRICE_IDS: 'pri_pro_899',
      PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise'
    };

    expect(() => buildPaddleAuditTargets(env)).toThrow(
      'PADDLE_PRO_LEGACY_PRICE_EXPECTATIONS must exactly cover'
    );
    expect(() => buildPaddleAuditTargets({
      ...env,
      PADDLE_PRO_LEGACY_PRICE_EXPECTATIONS:
        '{"pri_unknown":{"unitAmount":"799","status":"archived"}}'
    })).toThrow('missing: pri_pro_899; extra: pri_unknown');
  });

  test('full staged audit fetches and validates every current and legacy price', async () => {
    const env = {
      NODE_ENV: 'test',
      PADDLE_API_KEY: 'test-api-key',
      PADDLE_API_BASE: 'https://sandbox-api.paddle.test',
      PRO_PRICE_1099_ENABLED: 'true',
      PADDLE_PRO_PRICE_ID: 'pri_pro_999',
      PADDLE_PRO_1099_PRICE_ID: 'pri_pro_1099',
      PADDLE_PRO_999_EXPECTED_STATUS: 'active',
      PADDLE_PRO_LEGACY_PRICE_IDS: 'pri_pro_899',
      PADDLE_PRO_LEGACY_PRICE_EXPECTATIONS:
        '{"pri_pro_899":{"unitAmount":"899","status":"archived"}}',
      PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise'
    };
    const targets = buildPaddleAuditTargets(env);
    const entitiesByPath = new Map();
    for (const { expected: contract } of targets) {
      const productId = `pro_${contract.priceId}`;
      const { price, product } = matchingEntities(contract, productId);
      entitiesByPath.set(`/prices/${contract.priceId}`, price);
      entitiesByPath.set(`/products/${productId}`, product);
    }
    const requestedPaths = [];
    const fetchImpl = jest.fn(async (url) => {
      const path = new URL(url).pathname;
      requestedPaths.push(path);
      const data = entitiesByPath.get(path);
      return {
        ok: Boolean(data),
        status: data ? 200 : 404,
        json: async () => data ? { data } : { error: {} }
      };
    });

    await expect(auditPaddleCatalog({ env, fetchImpl })).resolves.toEqual([]);
    expect(requestedPaths.filter((path) => path.startsWith('/prices/'))).toEqual([
      '/prices/pri_pro_1099',
      '/prices/pri_enterprise',
      '/prices/pri_pro_999',
      '/prices/pri_pro_899'
    ]);
  });

  test('rejects an untrusted bearer-token destination before any catalog read', async () => {
    const fetchImpl = jest.fn();
    await expect(auditPaddleCatalog({
      env: {
        PADDLE_API_KEY: 'test-api-key',
        PADDLE_API_BASE: 'https://sandbox-api.paddle.com.attacker.example',
        PADDLE_PRO_PRICE_ID: 'pri_pro',
        PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise'
      },
      fetchImpl
    })).rejects.toThrow('PADDLE_API_BASE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
