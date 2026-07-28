'use strict';

const crypto = require('crypto');
const {
  buildCreditPackChargeBody,
  validateCreditPackChargeResponse,
  parseCreditPackPreviewResponse,
  handleCreditPackPreview,
  handleCreditPackPurchase,
  handlePendingCreditPackPurchase,
  handleCreditPackPurchaseStatus
} = require('../../routes/payment');

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const PACK = {
  key: 'usage_600',
  credits: 600,
  priceUsd: 10,
  priceCents: 1000
};
const PUBLIC_PACK = {
  key: 'usage_600',
  credits: 600,
  priceUsd: 10,
  currencyCode: 'USD'
};

function jsonResponse(ok, status, body) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(
      typeof body === 'string' ? body : JSON.stringify(body)
    )
  };
}

function makeProfileClient(profile, error = null) {
  const single = jest.fn().mockResolvedValue({ data: profile, error });
  const chain = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    single
  };
  return {
    from: jest.fn(() => chain)
  };
}

function makeStatusClient(row, error = null) {
  const chain = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    maybeSingle: jest.fn().mockResolvedValue({ data: row, error })
  };
  return {
    from: jest.fn(() => chain),
    chain
  };
}

function makeResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    set: jest.fn((name, value) => {
      res.headers[name] = value;
      return res;
    }),
    status: jest.fn((statusCode) => {
      res.statusCode = statusCode;
      return res;
    }),
    json: jest.fn((body) => {
      res.body = body;
      return res;
    })
  };
  return res;
}

function eligibleSubscription(overrides = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    customer_id: 'ctm_1',
    collection_mode: 'automatic',
    currency_code: 'USD',
    scheduled_change: null,
    items: [{
      quantity: 1,
      price: { id: 'pri_pro_current' }
    }],
    ...overrides
  };
}

function previewData(overrides = {}) {
  const base = {
    id: 'sub_1',
    status: 'active',
    customer_id: 'ctm_1',
    currency_code: 'USD',
    immediate_transaction: {
      details: {
        currency_code: 'USD',
        line_items: [{
          price_id: null,
          product: { id: null },
          quantity: 1,
          totals: { subtotal: '1000' }
        }],
        totals: {
          subtotal: '1000',
          discount: '0',
          tax: '100',
          total: '1100',
          credit: '0',
          balance: '1100',
          grand_total: '1100',
          grand_total_tax: '100'
        }
      }
    }
  };
  return {
    ...base,
    ...overrides
  };
}

function expectedPreview() {
  return {
    currencyCode: 'USD',
    subtotal: '1000',
    discount: '0',
    tax: '100',
    total: '1100',
    credit: '0',
    balance: '1100',
    grandTotal: '1100',
    grandTotalTax: '100'
  };
}

function makePurchaseRequest(adminClient, body = {}) {
  return {
    body: {
      packKey: 'usage_600',
      confirmedGrandTotal: '1100',
      confirmedCurrencyCode: 'USD',
      ...body
    },
    user: { id: 'user_1' },
    paymentAdminClient: adminClient,
    supabase: makeProfileClient({
      plan: 'pro',
      paddle_customer_id: 'ctm_1',
      paddle_subscription_id: 'sub_1'
    })
  };
}

function makeAdminRpc(events = []) {
  return jest.fn(async (name, args) => {
    events.push(`rpc:${name}`);
    if (name === 'create_credit_pack_purchase_request') {
      return {
        data: {
          applied: true,
          reason: 'purchase_request_created',
          requestId: args.p_request_id,
          status: 'created',
          packKey: args.p_pack_key,
          credits: args.p_credits,
          unitAmount: args.p_unit_amount
        },
        error: null
      };
    }
    if (name === 'transition_credit_pack_purchase_request') {
      return {
        data: {
          applied: true,
          reason: 'request_transitioned',
          status: args.p_status
        },
        error: null
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
}

describe('credit pack subscription-charge boundary', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let randomUuidSpy;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PADDLE_API_KEY: 'test-api-key',
      PADDLE_PRO_PRICE_ID: 'pri_pro_current',
      PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise_current',
      PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas',
      CREDIT_LEDGER_V2_ENABLED: 'true',
      CREDIT_PACK_PURCHASES_ENABLED: 'true',
      CREDIT_PACK_EXPIRY_DAYS: '365'
    };
    global.fetch = jest.fn();
    randomUuidSpy = jest.spyOn(crypto, 'randomUUID').mockReturnValue(REQUEST_ID);
  });

  afterEach(() => {
    randomUuidSpy.mockRestore();
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  test.each([
    ['preview', handleCreditPackPreview],
    ['purchase', handleCreditPackPurchase]
  ])('%s is fail-closed before profile or Paddle access', async (_label, handler) => {
    process.env.CREDIT_PACK_PURCHASES_ENABLED = 'false';
    const req = {
      body: { packKey: 'usage_600' },
      user: { id: 'user_1' },
      supabase: makeProfileClient(null)
    };
    const res = makeResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('CREDIT_PACKS_UNAVAILABLE');
    expect(req.supabase.from).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('builds one inline non-catalog item with immutable receipt metadata', () => {
    const body = buildCreditPackChargeBody({
      pack: PACK,
      requestId: REQUEST_ID,
      expiryDays: 365,
      taxCategory: 'saas'
    });

    expect(body).toEqual({
      effective_from: 'immediately',
      items: [{
        quantity: 1,
        price: {
          description:
            '600 PromptGen usage credits - $10.00 one-time - ' +
            'active paid subscription required - expires after 365 days - ' +
            'PromptGen use only - non-transferable - no cash value',
          name: '600 Credits - One-time',
          billing_cycle: null,
          tax_mode: 'account_setting',
          unit_price: {
            amount: '1000',
            currency_code: 'USD'
          },
          quantity: { minimum: 1, maximum: 1 },
          custom_data: {
            promptgenKind: 'credit_pack',
            promptgenPackKey: 'usage_600',
            promptgenPurchaseRequestId: REQUEST_ID
          },
          product: {
            name: 'PromptGen AI Usage Add-on — 600 Credits',
            description:
              'One-time purchase of 600 PromptGen usage credits. ' +
              'An active paid subscription is required. Credits expire 365 days after purchase. ' +
              'PromptGen use only; non-transferable; no cash value.',
            tax_category: 'saas',
            custom_data: {
              promptgenKind: 'credit_pack',
              promptgenPackKey: 'usage_600',
              promptgenPurchaseRequestId: REQUEST_ID
            }
          }
        }
      }],
      on_payment_failure: 'prevent_change'
    });
    expect(JSON.stringify(body)).not.toMatch(/price_id|pri_pack_/);
  });

  test('validates the returned subscription identity after an immediate charge', () => {
    expect(validateCreditPackChargeResponse({
      id: 'sub_1',
      customer_id: 'ctm_1',
      status: 'active'
    }, {
      subscriptionId: 'sub_1',
      customerId: 'ctm_1'
    })).toBe(true);

    expect(validateCreditPackChargeResponse({
      id: 'sub_1',
      customer_id: 'ctm_attacker',
      status: 'active'
    }, {
      subscriptionId: 'sub_1',
      customerId: 'ctm_1'
    })).toBe(false);
  });

  test('accepts only a one-line USD preview with the exact pack subtotal', () => {
    expect(parseCreditPackPreviewResponse(previewData(), {
      subscriptionId: 'sub_1',
      customerId: 'ctm_1',
      pack: PACK
    })).toEqual(expectedPreview());
  });

  test.each([
    ['catalog price ID', {
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          line_items: [{
            price_id: 'pri_reusable',
            product: { id: null },
            quantity: 1,
            totals: { subtotal: '1000' }
          }]
        }
      }
    }],
    ['catalog product ID', {
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          line_items: [{
            price_id: null,
            product: { id: 'pro_reusable' },
            quantity: 1,
            totals: { subtotal: '1000' }
          }]
        }
      }
    }],
    ['wrong pack subtotal', {
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          line_items: [{
            price_id: null,
            product: { id: null },
            quantity: 1,
            totals: { subtotal: '999' }
          }]
        }
      }
    }],
    ['non-minor-unit total', {
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          totals: {
            ...previewData().immediate_transaction.details.totals,
            grand_total: '11.00'
          }
        }
      }
    }]
  ])('rejects a preview containing %s', (_label, overrides) => {
    expect(parseCreditPackPreviewResponse(previewData(overrides), {
      subscriptionId: 'sub_1',
      customerId: 'ctm_1',
      pack: PACK
    })).toBeNull();
  });

  test('preview verifies eligibility and returns provider-calculated tax totals', async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse(true, 200, {
        data: eligibleSubscription()
      }))
      .mockResolvedValueOnce(jsonResponse(true, 200, {
        data: previewData()
      }));
    const req = {
      body: { packKey: 'usage_600' },
      user: { id: 'user_1' },
      supabase: makeProfileClient({
        plan: 'pro',
        paddle_customer_id: 'ctm_1',
        paddle_subscription_id: 'sub_1'
      })
    };
    const res = makeResponse();

    await handleCreditPackPreview(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      pack: PUBLIC_PACK,
      expiryDays: 365,
      preview: expectedPreview()
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0])
      .toBe('https://api.paddle.com/subscriptions/sub_1');
    expect(global.fetch.mock.calls[1][0])
      .toBe('https://api.paddle.com/subscriptions/sub_1/charge/preview');

    const previewBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(previewBody.items).toHaveLength(1);
    expect(previewBody.items[0].price.custom_data.promptgenPurchaseRequestId)
      .toBe(REQUEST_ID);
    expect(JSON.stringify(previewBody)).not.toMatch(/price_id|pri_pack_/);
  });

  test.each([
    ['trialing status', { status: 'trialing' }],
    ['manual collection', { collection_mode: 'manual' }],
    ['non-USD currency', { currency_code: 'EUR' }],
    ['scheduled cancellation', {
      scheduled_change: { action: 'cancel', effective_at: '2026-08-01T00:00:00Z' }
    }],
    ['multiple plan items', {
      items: [
        { quantity: 1, price: { id: 'pri_pro_current' } },
        { quantity: 1, price: { id: 'pri_extra' } }
      ]
    }],
    ['different paid plan price', {
      items: [{ quantity: 1, price: { id: 'pri_enterprise_current' } }]
    }]
  ])('purchase rejects %s before preview, request creation, or charge', async (
    _label,
    subscriptionOverrides
  ) => {
    const rpc = makeAdminRpc();
    global.fetch.mockResolvedValueOnce(jsonResponse(true, 200, {
      data: eligibleSubscription(subscriptionOverrides)
    }));
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ACTIVE_SUBSCRIPTION_REQUIRED');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('requires an explicit valid preview confirmation before provider access', async () => {
    const rpc = makeAdminRpc();
    const req = makePurchaseRequest({ rpc }, {
      confirmedGrandTotal: '11.00'
    });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PREVIEW_CONFIRMATION_REQUIRED');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test('changed tax-inclusive total blocks request creation and money movement', async () => {
    const rpc = makeAdminRpc();
    const changedPreview = previewData({
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          totals: {
            ...previewData().immediate_transaction.details.totals,
            tax: '200',
            total: '1200',
            balance: '1200',
            grand_total: '1200',
            grand_total_tax: '200'
          }
        }
      }
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse(true, 200, {
        data: eligibleSubscription()
      }))
      .mockResolvedValueOnce(jsonResponse(true, 200, {
        data: changedPreview
      }));
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CREDIT_PACK_TOTAL_CHANGED');
    expect(res.body.preview.grandTotal).toBe('1200');
    expect(rpc).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge')))
      .toBe(false);
  });

  test('re-previews, creates the durable request, then issues exactly one charge', async () => {
    const events = [];
    const rpc = makeAdminRpc(events);
    global.fetch.mockImplementation(async (url) => {
      if (url.endsWith('/charge/preview')) {
        events.push('paddle:preview');
        return jsonResponse(true, 200, { data: previewData() });
      }
      if (url.endsWith('/charge')) {
        events.push('paddle:charge');
        return jsonResponse(true, 200, {
          data: {
            id: 'sub_1',
            customer_id: 'ctm_1',
            status: 'active'
          }
        });
      }
      events.push('paddle:subscription');
      return jsonResponse(true, 200, { data: eligibleSubscription() });
    });
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'submitted',
      pack: PUBLIC_PACK
    });
    expect(events).toEqual([
      'paddle:subscription',
      'paddle:preview',
      'rpc:create_credit_pack_purchase_request',
      'paddle:charge',
      'rpc:transition_credit_pack_purchase_request'
    ]);

    expect(rpc).toHaveBeenNthCalledWith(
      1,
      'create_credit_pack_purchase_request',
      {
        p_request_id: REQUEST_ID,
        p_user_id: 'user_1',
        p_customer_id: 'ctm_1',
        p_subscription_id: 'sub_1',
        p_pack_key: 'usage_600',
        p_credits: 600,
        p_unit_amount: 1000,
        p_currency_code: 'USD',
        p_expiry_days: 365
      }
    );
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      'transition_credit_pack_purchase_request',
      {
        p_request_id: REQUEST_ID,
        p_user_id: 'user_1',
        p_status: 'submitted',
        p_provider_error_code: null
      }
    );

    const previewBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    const chargeBody = JSON.parse(global.fetch.mock.calls[2][1].body);
    expect(chargeBody).toEqual(previewBody);
    expect(JSON.stringify(chargeBody)).not.toMatch(/price_id|pri_pack_/);
  });

  test('an existing open request is returned without issuing another charge', async () => {
    const rpc = jest.fn(async (name) => {
      expect(name).toBe('create_credit_pack_purchase_request');
      return {
        data: {
          applied: false,
          reason: 'duplicate_pending',
          requestId: '223e4567-e89b-42d3-a456-426614174000',
          status: 'provider_unknown',
          packKey: 'usage_600',
          credits: 600,
          unitAmount: 1000
        },
        error: null
      };
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse(true, 200, {
        data: eligibleSubscription()
      }))
      .mockResolvedValueOnce(jsonResponse(true, 200, {
        data: previewData()
      }));
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      success: true,
      purchaseRequestId: '223e4567-e89b-42d3-a456-426614174000',
      status: 'provider_unknown',
      code: 'PURCHASE_ALREADY_PENDING'
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge')))
      .toBe(false);
  });

  test('a network-unknown charge is persisted and never automatically retried', async () => {
    const events = [];
    const rpc = makeAdminRpc(events);
    global.fetch.mockImplementation(async (url) => {
      if (url.endsWith('/charge/preview')) {
        return jsonResponse(true, 200, { data: previewData() });
      }
      if (url.endsWith('/charge')) {
        events.push('paddle:charge');
        throw new Error('socket closed after request');
      }
      return jsonResponse(true, 200, { data: eligibleSubscription() });
    });
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'provider_unknown',
      code: 'PURCHASE_CONFIRMATION_PENDING'
    });
    expect(events.filter((event) => event === 'paddle:charge')).toHaveLength(1);
    expect(rpc).toHaveBeenLastCalledWith(
      'transition_credit_pack_purchase_request',
      expect.objectContaining({
        p_request_id: REQUEST_ID,
        p_status: 'provider_unknown',
        p_provider_error_code: 'network_error'
      })
    );
  });

  test.each([
    ['provider 4xx', 422, 'failed', 409, 'CREDIT_PACK_CHARGE_REJECTED'],
    ['provider 5xx', 503, 'provider_unknown', 202, 'PURCHASE_CONFIRMATION_PENDING']
  ])('%s is classified without retrying the charge', async (
    _label,
    providerStatus,
    persistedStatus,
    responseStatus,
    responseCode
  ) => {
    const rpc = makeAdminRpc();
    global.fetch
      .mockResolvedValueOnce(jsonResponse(true, 200, {
        data: eligibleSubscription()
      }))
      .mockResolvedValueOnce(jsonResponse(true, 200, {
        data: previewData()
      }))
      .mockResolvedValueOnce(jsonResponse(false, providerStatus, {
        error: { code: 'provider_rejected' }
      }));
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(responseStatus);
    expect(res.body.code).toBe(responseCode);
    expect(global.fetch.mock.calls.filter(([url]) => url.endsWith('/charge')))
      .toHaveLength(1);
    expect(rpc).toHaveBeenLastCalledWith(
      'transition_credit_pack_purchase_request',
      expect.objectContaining({
        p_status: persistedStatus,
        p_provider_error_code: 'provider_rejected'
      })
    );
  });

  test('lost-response recovery returns only the newest owner-scoped pending request', async () => {
    const row = {
      request_id: REQUEST_ID,
      status: 'provider_unknown',
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      created_at: '2026-07-28T10:00:00.000Z',
      completed_at: null,
      transaction_id: 'txn_must_not_be_selected',
      provider_error_code: 'private_diagnostic'
    };
    const client = makeStatusClient(row);
    const req = {
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handlePendingCreditPackPurchase(req, res);

    expect(client.chain.eq).toHaveBeenCalledWith('user_id', 'user_1');
    expect(client.chain.in).toHaveBeenCalledWith(
      'status',
      ['created', 'submitted', 'provider_unknown']
    );
    expect(client.chain.order).toHaveBeenCalledWith(
      'created_at',
      { ascending: false }
    );
    expect(client.chain.limit).toHaveBeenCalledWith(1);
    expect(res.body).toEqual({
      success: true,
      purchase: {
        purchaseRequestId: REQUEST_ID,
        status: 'provider_unknown',
        pack: PUBLIC_PACK,
        createdAt: '2026-07-28T10:00:00.000Z',
        completedAt: null
      }
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /txn_must_not_be_selected|private_diagnostic|customer_id|subscription_id/
    );
  });

  test('lost-response recovery returns null when the user has no open request', async () => {
    const client = makeStatusClient(null);
    const req = {
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handlePendingCreditPackPurchase(req, res);

    expect(res.body).toEqual({ success: true, purchase: null });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test('status lookup is owner-scoped and returns no Paddle identifiers', async () => {
    const row = {
      request_id: REQUEST_ID,
      status: 'completed',
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      created_at: '2026-07-28T10:00:00.000Z',
      completed_at: '2026-07-28T10:00:05.000Z',
      transaction_id: 'txn_must_not_be_selected',
      provider_price_id: 'pri_must_not_be_selected'
    };
    const client = makeStatusClient(row);
    const req = {
      params: { requestId: REQUEST_ID },
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handleCreditPackPurchaseStatus(req, res);

    expect(client.from).toHaveBeenCalledWith('credit_pack_purchase_requests');
    expect(client.chain.select).toHaveBeenCalledWith(
      'request_id, status, pack_key, credits, unit_amount, currency_code, created_at, completed_at'
    );
    expect(client.chain.eq).toHaveBeenNthCalledWith(1, 'request_id', REQUEST_ID);
    expect(client.chain.eq).toHaveBeenNthCalledWith(2, 'user_id', 'user_1');
    expect(res.body).toEqual({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'completed',
      pack: PUBLIC_PACK,
      createdAt: '2026-07-28T10:00:00.000Z',
      completedAt: '2026-07-28T10:00:05.000Z'
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /txn_must_not_be_selected|pri_must_not_be_selected|customer_id|subscription_id/
    );
  });
});
