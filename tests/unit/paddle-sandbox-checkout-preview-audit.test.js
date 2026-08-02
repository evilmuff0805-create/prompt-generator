'use strict';

const {
  auditPaddleSandboxCheckoutPreview,
  buildSandboxCheckoutPreviewTargets,
  readSandboxCheckoutPreviewConfig
} = require('../../scripts/audit-paddle-sandbox-checkout-preview');

const SANDBOX_API_KEY =
  `pdl_sdbx_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_xyz`;
const LIVE_API_KEY =
  `pdl_live_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_xyz`;
const PRO_PRODUCT_ID = 'pro_01kz1c63973n5dhe85zzwem8sk';
const ENTERPRISE_PRODUCT_ID = 'pro_01kz1cee379z4e1ajk8tbxq2ks';

function baseEnv(overrides = {}) {
  return {
    PADDLE_SANDBOX_PREVIEW_CONFIRMED: 'true',
    PADDLE_API_BASE: 'https://sandbox-api.paddle.com',
    PADDLE_API_KEY: SANDBOX_API_KEY,
    PADDLE_PRO_PRICE_ID: 'pri_01kz1c64mvgy2g77zh9sa42xj9',
    PADDLE_PRO_1099_PRICE_ID: 'pri_01kz1ced16q6831vgfqabavydb',
    PADDLE_ENTERPRISE_PRICE_ID: 'pri_01kz1ceey4eeaktcjf9pw7qb7t',
    PADDLE_CATALOG_EXPECTED_TAX_MODE: 'location',
    PADDLE_PRO_999_EXPECTED_TAX_MODE: 'location',
    PADDLE_SANDBOX_PREVIEW_COUNTRY_CODE: 'US',
    PADDLE_SANDBOX_PREVIEW_POSTAL_CODE: '10001',
    ...overrides
  };
}

function moneyTotals({ subtotal, tax = '0' }) {
  const total = String(BigInt(subtotal) + BigInt(tax));
  return {
    subtotal,
    discount: '0',
    tax,
    total,
    credit: '0',
    credit_to_balance: '0',
    balance: total,
    grand_total: total,
    grand_total_tax: tax,
    fee: null,
    earnings: null,
    currency_code: 'USD'
  };
}

function matchingPreview(target, {
  requestId = `req_${target.key}`,
  productId = target.key.startsWith('pro.')
    ? PRO_PRODUCT_ID
    : ENTERPRISE_PRODUCT_ID,
  tax = '0'
} = {}) {
  const totals = moneyTotals({ subtotal: target.expected.unitAmount, tax });
  const lineTotals = {
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  };
  return {
    data: {
      customer_id: null,
      address_id: null,
      business_id: null,
      discount_id: null,
      currency_code: 'USD',
      address: { country_code: 'US', postal_code: '10001' },
      customer_ip_address: null,
      custom_data: null,
      items: [{
        price: {
          id: target.expected.priceId,
          product_id: productId,
          name: target.expected.priceName,
          description: target.expected.internalDescription,
          type: 'standard',
          billing_cycle: { interval: 'month', frequency: 1 },
          trial_period: null,
          tax_mode: target.expected.priceTaxMode,
          unit_price: {
            amount: target.expected.unitAmount,
            currency_code: 'USD'
          },
          unit_price_overrides: [],
          quantity: { minimum: 1, maximum: 1 },
          status: 'active'
        },
        quantity: 1,
        proration: null,
        include_in_totals: true
      }],
      details: {
        tax_rates_used: [{
          tax_rate: tax === '0' ? '0' : '0.08875',
          totals: { ...lineTotals }
        }],
        totals,
        line_items: [{
          price_id: target.expected.priceId,
          quantity: 1,
          tax_rate: tax === '0' ? '0' : '0.08875',
          unit_totals: { ...lineTotals },
          totals: { ...lineTotals },
          product: {
            id: productId,
            name: target.expected.productName,
            description: target.expected.productDescription,
            type: 'standard',
            tax_category: 'saas',
            status: 'active'
          },
          proration: null
        }]
      }
    },
    meta: { request_id: requestId }
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    json: jest.fn().mockResolvedValue(body)
  };
}

describe('Paddle Sandbox checkout preview audit', () => {
  test.each([
    ['confirmation', { PADDLE_SANDBOX_PREVIEW_CONFIRMED: 'false' }],
    ['exact Sandbox base', { PADDLE_API_BASE: 'https://api.paddle.com' }],
    ['modern Sandbox key', { PADDLE_API_KEY: LIVE_API_KEY }],
    ['un-padded key', { PADDLE_API_KEY: ` ${SANDBOX_API_KEY}` }],
    ['country code', { PADDLE_SANDBOX_PREVIEW_COUNTRY_CODE: 'us' }],
    ['postal code', { PADDLE_SANDBOX_PREVIEW_POSTAL_CODE: ' ' }]
  ])('rejects invalid %s before any network request', async (_label, overrides) => {
    const fetchImpl = jest.fn();
    await expect(auditPaddleSandboxCheckoutPreview({
      env: baseEnv(overrides),
      fetchImpl
    })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('builds three independent literal receipt contracts', () => {
    const targets = buildSandboxCheckoutPreviewTargets(baseEnv());
    expect(targets.map(({ key, expected }) => ({
      key,
      priceId: expected.priceId,
      productName: expected.productName,
      priceName: expected.priceName,
      unitAmount: expected.unitAmount,
      currencyCode: expected.currencyCode,
      billingCycle: expected.billingCycle,
      priceTaxMode: expected.priceTaxMode
    }))).toEqual([
      {
        key: 'pro.stable_999',
        priceId: 'pri_01kz1c64mvgy2g77zh9sa42xj9',
        productName: 'PromptGen AI Pro',
        priceName: 'Pro Monthly',
        unitAmount: '999',
        currencyCode: 'USD',
        billingCycle: { interval: 'month', frequency: 1 },
        priceTaxMode: 'location'
      },
      {
        key: 'pro.staged_1099',
        priceId: 'pri_01kz1ced16q6831vgfqabavydb',
        productName: 'PromptGen AI Pro',
        priceName: 'Pro Monthly',
        unitAmount: '1099',
        currencyCode: 'USD',
        billingCycle: { interval: 'month', frequency: 1 },
        priceTaxMode: 'location'
      },
      {
        key: 'enterprise.current',
        priceId: 'pri_01kz1ceey4eeaktcjf9pw7qb7t',
        productName: 'PromptGen AI Enterprise',
        priceName: 'Enterprise Monthly',
        unitAmount: '1999',
        currencyCode: 'USD',
        billingCycle: { interval: 'month', frequency: 1 },
        priceTaxMode: 'location'
      }
    ]);
  });

  test('previews all three prices without creating a transaction entity', async () => {
    const env = baseEnv();
    const targets = buildSandboxCheckoutPreviewTargets(env);
    const bodies = targets.map((target, index) => matchingPreview(target, {
      requestId: `req_${index + 1}`,
      tax: index === 0 ? '89' : '0'
    }));
    const fetchImpl = jest.fn(async (_url, _options) => jsonResponse(bodies.shift()));

    const report = await auditPaddleSandboxCheckoutPreview({ env, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [index, target] of targets.entries()) {
      const [url, request] = fetchImpl.mock.calls[index];
      expect(url).toBe('https://sandbox-api.paddle.com/transactions/preview');
      expect(request).toMatchObject({
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${SANDBOX_API_KEY}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Paddle-Version': '1'
        }
      });
      expect(JSON.parse(request.body)).toEqual({
        items: [{ price_id: target.expected.priceId, quantity: 1 }],
        address: { country_code: 'US', postal_code: '10001' },
        currency_code: 'USD'
      });
    }
    expect(report).toMatchObject({
      success: true,
      complete: true,
      mode: 'transaction-preview-no-entity',
      environment: 'sandbox',
      requiredScope: 'transaction.read',
      entityCreated: false,
      location: { countryCode: 'US', postalCode: '10001' }
    });
    expect(report.previews).toHaveLength(3);
    expect(report.previews[0]).toMatchObject({
      contract: 'pro.stable_999',
      productId: PRO_PRODUCT_ID,
      productName: 'PromptGen AI Pro',
      priceName: 'Pro Monthly',
      unitAmount: '999',
      billingCycle: { interval: 'month', frequency: 1 },
      totals: { subtotal: '999', tax: '89', total: '1088', currencyCode: 'USD' }
    });
    expect(JSON.stringify(report)).not.toContain(SANDBOX_API_KEY);
    expect(JSON.stringify(report)).not.toMatch(/customer_id|address_id|business_id/);
  });

  test('stops if Paddle unexpectedly returns a transaction ID', async () => {
    const env = baseEnv();
    const target = buildSandboxCheckoutPreviewTargets(env)[0];
    const response = matchingPreview(target);
    response.data.id = 'txn_01kz1c63973n5dhe85zzwem8sk';
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(response));

    await expect(auditPaddleSandboxCheckoutPreview({ env, fetchImpl }))
      .rejects.toMatchObject({ code: 'PADDLE_SANDBOX_PREVIEW_ENTITY_CREATED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['product name', (body) => { body.data.details.line_items[0].product.name = 'Wrong'; }],
    ['price name', (body) => { body.data.items[0].price.name = 'Annual'; }],
    ['billing cycle', (body) => { body.data.items[0].price.billing_cycle.interval = 'year'; }],
    ['unit amount', (body) => { body.data.items[0].price.unit_price.amount = '1'; }],
    ['trial', (body) => { body.data.items[0].price.trial_period = { interval: 'day', frequency: 7 }; }],
    ['tax mode', (body) => { body.data.items[0].price.tax_mode = 'external'; }],
    ['discount', (body) => {
      const details = body.data.details;
      for (const totals of [
        details.totals,
        details.line_items[0].unit_totals,
        details.line_items[0].totals
      ]) {
        totals.discount = '100';
        totals.total = '899';
      }
      details.totals.balance = '899';
      details.totals.grand_total = '899';
    }],
    ['subtotal', (body) => {
      const details = body.data.details;
      for (const totals of [
        details.totals,
        details.line_items[0].unit_totals,
        details.line_items[0].totals
      ]) {
        totals.subtotal = '899';
        totals.total = '899';
      }
      details.totals.balance = '899';
      details.totals.grand_total = '899';
    }],
    ['total arithmetic', (body) => { body.data.details.totals.total = '1'; }]
  ])('fails closed on %s drift', async (_label, mutate) => {
    const env = baseEnv();
    const target = buildSandboxCheckoutPreviewTargets(env)[0];
    const response = matchingPreview(target);
    mutate(response);
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(response));

    await expect(auditPaddleSandboxCheckoutPreview({ env, fetchImpl }))
      .rejects.toMatchObject({ code: 'PADDLE_SANDBOX_PREVIEW_CONTRACT_MISMATCH' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects reused provider evidence across previews', async () => {
    const env = baseEnv();
    const targets = buildSandboxCheckoutPreviewTargets(env);
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse(matchingPreview(targets[0], { requestId: 'req_same' })))
      .mockResolvedValueOnce(jsonResponse(matchingPreview(targets[1], { requestId: 'req_same' })));

    await expect(auditPaddleSandboxCheckoutPreview({ env, fetchImpl }))
      .rejects.toMatchObject({ code: 'PADDLE_SANDBOX_PREVIEW_EVIDENCE_REUSED' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('reports missing transaction.read permission without leaking provider body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({
      error: { detail: 'secret provider body' }
    }, { status: 403 }));

    await expect(auditPaddleSandboxCheckoutPreview({
      env: baseEnv(),
      fetchImpl
    })).rejects.toMatchObject({
      code: 'PADDLE_SANDBOX_PREVIEW_PERMISSION_DENIED',
      requiredScope: 'transaction.read'
    });
    await auditPaddleSandboxCheckoutPreview({
      env: baseEnv(),
      fetchImpl
    }).catch((error) => {
      expect(error.message).not.toContain('secret provider body');
      expect(JSON.stringify(error)).not.toContain(SANDBOX_API_KEY);
    });
  });

  test('does not retry an unknown network outcome', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    const fetchImpl = jest.fn().mockRejectedValue(timeout);

    await expect(auditPaddleSandboxCheckoutPreview({
      env: baseEnv(),
      fetchImpl
    })).rejects.toMatchObject({ code: 'PADDLE_SANDBOX_PREVIEW_TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('config parser returns only the constrained Sandbox boundary', () => {
    const config = readSandboxCheckoutPreviewConfig(baseEnv());
    expect(config).toEqual({
      apiBase: 'https://sandbox-api.paddle.com',
      apiKey: SANDBOX_API_KEY,
      address: { countryCode: 'US', postalCode: '10001' }
    });
  });
});
