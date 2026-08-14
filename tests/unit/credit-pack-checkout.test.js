'use strict';

const crypto = require('crypto');
const {
  buildCreditPackChargeBody,
  validateCreditPackChargeResponse,
  parseCreditPackPreviewResponse,
  handleCreditPackPreview,
  handleCreditPackPurchase,
  handlePendingCreditPackPurchase,
  handleCreditPackPurchaseStatus,
  handleCancelCreditPackPurchase
} = require('../../routes/payment');

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const SUBSCRIPTION_UPDATED_AT = '2026-07-28T09:59:30.123456Z';
const SUBSCRIPTION_API_REQUEST_ID = 'req_subscription_lookup_1';
const PREVIEW_API_REQUEST_ID = 'req_credit_pack_preview_1';
const AUTHORIZATION_EXPIRES_AT = '2026-07-28T10:15:00.000Z';
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
    updated_at: SUBSCRIPTION_UPDATED_AT,
    customer_id: 'ctm_1',
    collection_mode: 'automatic',
    currency_code: 'USD',
    scheduled_change: null,
    items: [{
      quantity: 1,
      status: 'active',
      recurring: true,
      price: { id: 'pri_pro_current' }
    }],
    ...overrides
  };
}

function eligibleSubscriptionResponse(overrides = {}) {
  return {
    data: eligibleSubscription(overrides),
    meta: { request_id: SUBSCRIPTION_API_REQUEST_ID }
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

function previewApiResponse(data = previewData()) {
  return jsonResponse(true, 200, {
    data,
    meta: { request_id: PREVIEW_API_REQUEST_ID }
  });
}

function makePurchaseRequest(adminClient, body = {}) {
  return {
    body: {
      packKey: 'usage_600',
      purchaseRequestId: REQUEST_ID,
      confirmedGrandTotal: '1100',
      confirmedCurrencyCode: 'USD',
      confirmationVersion: 1,
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
    if (name === 'begin_credit_pack_purchase_preview') {
      return {
        data: {
          applied: true,
          reason: 'purchase_preview_reserved',
          requestId: args.p_request_id,
          status: 'previewing',
          packKey: args.p_pack_key,
          credits: args.p_credits,
          unitAmount: args.p_unit_amount,
          confirmationVersion: 0,
          authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT
        },
        error: null
      };
    }
    if (name === 'finalize_credit_pack_purchase_preview') {
      return {
        data: {
          applied: true,
          reason: args.p_expected_confirmation_version === 0
            ? 'purchase_preview_finalized'
            : 'purchase_confirmation_refreshed',
          requestId: args.p_request_id,
          status: 'created',
          confirmationVersion: args.p_expected_confirmation_version + 1,
          approvedSubtotal: args.p_approved_subtotal,
          approvedDiscount: args.p_approved_discount,
          approvedTax: args.p_approved_tax,
          approvedTotal: args.p_approved_total,
          approvedCredit: args.p_approved_credit,
          approvedBalance: args.p_approved_balance,
          approvedGrandTotal: args.p_approved_grand_total,
          approvedGrandTotalTax: args.p_approved_grand_total_tax,
          authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT
        },
        error: null
      };
    }
    if (name === 'claim_credit_pack_purchase_request') {
      return {
        data: {
          applied: true,
          reason: 'purchase_request_claimed',
          requestId: args.p_request_id,
          status: 'charging',
          packKey: args.p_pack_key,
          credits: 600,
          unitAmount: 1000,
          currencyCode: 'USD',
          confirmationVersion: args.p_expected_confirmation_version,
          approvedSubtotal: 1000,
          approvedDiscount: 0,
          approvedTax: 100,
          approvedTotal: 1100,
          approvedCredit: 0,
          approvedBalance: 1100,
          approvedGrandTotal: 1100,
          approvedGrandTotalTax: 100,
          providerApiRequestId: PREVIEW_API_REQUEST_ID,
          authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT
        },
        error: null
      };
    }
    if (name === 'cancel_credit_pack_purchase_request') {
      return {
        data: {
          applied: true,
          reason: 'purchase_request_cancelled',
          requestId: args.p_request_id,
          status: 'failed'
        },
        error: null
      };
    }
    if (name === 'expire_credit_pack_purchase_request') {
      return {
        data: {
          applied: true,
          reason: 'purchase_request_expired',
          requestId: args.p_request_id,
          status: 'failed'
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
      PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true',
      PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED: 'true',
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
    }],
    ['total above the PostgreSQL integer boundary', {
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          totals: {
            ...previewData().immediate_transaction.details.totals,
            grand_total: '2147483648'
          }
        }
      }
    }],
    ['an unapproved discount', {
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          totals: {
            ...previewData().immediate_transaction.details.totals,
            discount: '100',
            total: '1000',
            balance: '1000',
            grand_total: '1000'
          }
        }
      }
    }],
    ['an unapproved customer credit', {
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          totals: {
            ...previewData().immediate_transaction.details.totals,
            credit: '100',
            balance: '1000'
          }
        }
      }
    }],
    ['inconsistent total arithmetic', {
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          totals: {
            ...previewData().immediate_transaction.details.totals,
            total: '1099'
          }
        }
      }
    }],
    ['subtotal-plus-tax integer overflow', {
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          totals: {
            ...previewData().immediate_transaction.details.totals,
            tax: '2147483647',
            total: '2147483647',
            balance: '2147483647',
            grand_total: '2147483647',
            grand_total_tax: '2147483647'
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
    const events = [];
    const rpc = makeAdminRpc(events);
    global.fetch
      .mockImplementationOnce(async () => {
        events.push('paddle:subscription');
        return jsonResponse(true, 200, {
        ...eligibleSubscriptionResponse()
        });
      })
      .mockImplementationOnce(async () => {
        events.push('paddle:preview');
        return previewApiResponse();
      });
    const req = {
      body: { packKey: 'usage_600' },
      user: { id: 'user_1' },
      paymentAdminClient: { rpc },
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
      purchaseRequestId: REQUEST_ID,
      status: 'created',
      confirmationVersion: 1,
      pack: PUBLIC_PACK,
      expiryDays: 365,
      authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT,
      preview: expectedPreview()
    });
    expect(events).toEqual([
      'paddle:subscription',
      'rpc:begin_credit_pack_purchase_preview',
      'paddle:preview',
      'rpc:finalize_credit_pack_purchase_preview'
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0])
      .toBe('https://api.paddle.com/subscriptions/sub_1');
    expect(global.fetch.mock.calls[1][0])
      .toBe('https://api.paddle.com/subscriptions/sub_1/charge/preview');
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(global.fetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);

    const previewBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(previewBody.items).toHaveLength(1);
    expect(previewBody.items[0].price.custom_data.promptgenPurchaseRequestId)
      .toBe(REQUEST_ID);
    expect(JSON.stringify(previewBody)).not.toMatch(/price_id|pri_pack_/);
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      'begin_credit_pack_purchase_preview',
      {
        p_request_id: REQUEST_ID,
        p_user_id: 'user_1',
        p_customer_id: 'ctm_1',
        p_subscription_id: 'sub_1',
        p_pack_key: 'usage_600',
        p_credits: 600,
        p_unit_amount: 1000,
        p_currency_code: 'USD',
        p_expiry_days: 365,
        p_provider_subscription_updated_at: SUBSCRIPTION_UPDATED_AT,
        p_provider_plan_price_id: 'pri_pro_current',
        p_eligibility_check_started_at: expect.any(String)
      }
    );
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      'finalize_credit_pack_purchase_preview',
      expect.objectContaining({
        p_request_id: REQUEST_ID,
        p_user_id: 'user_1',
        p_expected_confirmation_version: 0,
        p_provider_api_request_id: PREVIEW_API_REQUEST_ID
      })
    );
  });

  test('a concurrent preview reservation returns recovery without Paddle preview', async () => {
    const existingRequestId = '223e4567-e89b-42d3-a456-426614174000';
    const rpc = jest.fn(async (name) => {
      expect(name).toBe('begin_credit_pack_purchase_preview');
      return {
        data: {
          applied: false,
          reason: 'duplicate_pending',
          requestId: existingRequestId,
          status: 'created',
          packKey: 'usage_600',
          credits: 600,
          unitAmount: 1000,
          confirmationVersion: 1
        },
        error: null
      };
    });
    global.fetch.mockResolvedValueOnce(jsonResponse(
      true,
      200,
      eligibleSubscriptionResponse()
    ));
    const req = {
      body: { packKey: 'usage_600' },
      user: { id: 'user_1' },
      paymentAdminClient: { rpc },
      supabase: makeProfileClient({
        plan: 'pro',
        paddle_customer_id: 'ctm_1',
        paddle_subscription_id: 'sub_1'
      })
    };
    const res = makeResponse();

    await handleCreditPackPreview(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      success: true,
      purchaseRequestId: existingRequestId,
      status: 'created',
      confirmationVersion: 1,
      code: 'PURCHASE_ALREADY_PENDING'
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge/preview')))
      .toBe(false);
  });

  test('Paddle preview failure atomically cancels the uncharged reservation', async () => {
    const events = [];
    const rpc = makeAdminRpc(events);
    global.fetch
      .mockResolvedValueOnce(jsonResponse(
        true,
        200,
        eligibleSubscriptionResponse()
      ))
      .mockResolvedValueOnce(jsonResponse(false, 503, {
        error: { code: 'provider_unavailable' }
      }));
    const req = {
      body: { packKey: 'usage_600' },
      user: { id: 'user_1' },
      paymentAdminClient: { rpc },
      supabase: makeProfileClient({
        plan: 'pro',
        paddle_customer_id: 'ctm_1',
        paddle_subscription_id: 'sub_1'
      })
    };
    const res = makeResponse();

    await handleCreditPackPreview(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({
      success: false,
      purchaseRequestId: REQUEST_ID,
      status: 'failed',
      code: 'PADDLE_UNAVAILABLE',
      chargeMayHaveRun: false
    });
    expect(events).toEqual([
      'rpc:begin_credit_pack_purchase_preview',
      'rpc:cancel_credit_pack_purchase_request'
    ]);
    expect(rpc).toHaveBeenLastCalledWith(
      'cancel_credit_pack_purchase_request',
      {
        p_request_id: REQUEST_ID,
        p_user_id: 'user_1',
        p_reason: 'preview_failed'
      }
    );
  });

  test('a timed-out subscription eligibility read fails closed', async () => {
    const error = new Error('Paddle read timed out');
    error.name = 'TimeoutError';
    global.fetch.mockRejectedValueOnce(error);
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

    expect(res.statusCode).toBe(502);
    expect(res.body.code).toBe('PADDLE_UNAVAILABLE');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ['different subscription identity', { id: 'sub_attacker' }],
    ['trialing status', { status: 'trialing' }],
    ['manual collection', { collection_mode: 'manual' }],
    ['non-USD currency', { currency_code: 'EUR' }],
    ['scheduled cancellation', {
      scheduled_change: { action: 'cancel', effective_at: '2026-08-01T00:00:00Z' }
    }],
    ['multiple plan items', {
      items: [
        {
          quantity: 1,
          status: 'active',
          recurring: true,
          price: { id: 'pri_pro_current' }
        },
        {
          quantity: 1,
          status: 'active',
          recurring: true,
          price: { id: 'pri_extra' }
        }
      ]
    }],
    ['inactive plan item', {
      items: [{
        quantity: 1,
        status: 'inactive',
        recurring: true,
        price: { id: 'pri_pro_current' }
      }]
    }],
    ['non-recurring plan item', {
      items: [{
        quantity: 1,
        status: 'active',
        recurring: false,
        price: { id: 'pri_pro_current' }
      }]
    }],
    ['different paid plan price', {
      items: [{
        quantity: 1,
        status: 'active',
        recurring: true,
        price: { id: 'pri_enterprise_current' }
      }]
    }]
  ])('purchase rejects %s before preview, request creation, or charge', async (
    _label,
    subscriptionOverrides
  ) => {
    const rpc = makeAdminRpc();
    global.fetch.mockResolvedValueOnce(jsonResponse(true, 200, {
      ...eligibleSubscriptionResponse(subscriptionOverrides)
    }));
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ACTIVE_SUBSCRIPTION_REQUIRED');
    expect(res.body.chargeMayHaveRun).toBe(false);
    expect(res.body.status).toBe('failed');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'cancel_credit_pack_purchase_request',
      expect.objectContaining({ p_reason: 'confirmation_rejected' })
    );
  });

  test.each([
    ['subscription updated_at', {
      data: eligibleSubscription({ updated_at: null }),
      meta: { request_id: SUBSCRIPTION_API_REQUEST_ID }
    }],
    ['Paddle API request provenance', {
      data: eligibleSubscription(),
      meta: {}
    }]
  ])('purchase rejects a subscription response missing %s', async (
    _label,
    subscriptionResponse
  ) => {
    const rpc = makeAdminRpc();
    global.fetch.mockResolvedValueOnce(
      jsonResponse(true, 200, subscriptionResponse)
    );
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('ACTIVE_SUBSCRIPTION_REQUIRED');
    expect(res.body.chargeMayHaveRun).toBe(false);
    expect(res.body.status).toBe('failed');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'cancel_credit_pack_purchase_request',
      expect.objectContaining({ p_reason: 'confirmation_rejected' })
    );
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
    expect(res.body.chargeMayHaveRun).toBe(false);
    expect(res.body.status).toBe('failed');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      'cancel_credit_pack_purchase_request',
      expect.objectContaining({ p_reason: 'confirmation_rejected' })
    );
  });

  test('requires the exact server-issued request token before provider access', async () => {
    const rpc = makeAdminRpc();
    const req = makePurchaseRequest({ rpc }, {
      purchaseRequestId: 'not-a-server-request-id'
    });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PREVIEW_CONFIRMATION_REQUIRED');
    expect(res.body.chargeMayHaveRun).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test('requires the exact positive confirmation version before provider access', async () => {
    const rpc = makeAdminRpc();
    const req = makePurchaseRequest({ rpc }, {
      confirmationVersion: 0
    });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      code: 'PREVIEW_CONFIRMATION_REQUIRED',
      purchaseRequestId: REQUEST_ID,
      status: 'failed',
      chargeMayHaveRun: false
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      'cancel_credit_pack_purchase_request',
      expect.objectContaining({ p_reason: 'confirmation_rejected' })
    );
  });

  test('rejects an oversized preview confirmation before provider access', async () => {
    const rpc = makeAdminRpc();
    const req = makePurchaseRequest({ rpc }, {
      confirmedGrandTotal: '2147483648'
    });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PREVIEW_CONFIRMATION_REQUIRED');
    expect(res.body.chargeMayHaveRun).toBe(false);
    expect(res.body.status).toBe('failed');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      'cancel_credit_pack_purchase_request',
      expect.objectContaining({ p_reason: 'confirmation_rejected' })
    );
  });

  test('changed total refreshes the same confirmation without claiming or charging', async () => {
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
        ...eligibleSubscriptionResponse()
      }))
      .mockResolvedValueOnce(previewApiResponse(changedPreview));
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CREDIT_PACK_TOTAL_CHANGED');
    expect(res.body.chargeMayHaveRun).toBe(false);
    expect(res.body.purchaseRequestId).toBe(REQUEST_ID);
    expect(res.body.status).toBe('created');
    expect(res.body.confirmationVersion).toBe(2);
    expect(res.body.preview.grandTotal).toBe('1200');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'finalize_credit_pack_purchase_preview',
      expect.objectContaining({
        p_request_id: REQUEST_ID,
        p_expected_confirmation_version: 1,
        p_approved_grand_total: 1200,
        p_provider_api_request_id: PREVIEW_API_REQUEST_ID
      })
    );
    expect(rpc).not.toHaveBeenCalledWith(
      'claim_credit_pack_purchase_request',
      expect.anything()
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge')))
      .toBe(false);
  });

  test.each([
    ['discount', {
      discount: '100',
      total: '1000',
      balance: '1000',
      grand_total: '1000'
    }],
    ['customer credit', {
      credit: '100',
      balance: '1000'
    }]
  ])('unapproved %s cancels the uncharged request before money movement', async (
    _label,
    totalsOverrides
  ) => {
    const rpc = makeAdminRpc();
    const invalidPreview = previewData({
      immediate_transaction: {
        details: {
          ...previewData().immediate_transaction.details,
          totals: {
            ...previewData().immediate_transaction.details.totals,
            ...totalsOverrides
          }
        }
      }
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse(true, 200, {
        ...eligibleSubscriptionResponse()
      }))
      .mockResolvedValueOnce(previewApiResponse(invalidPreview));
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.code).toBe('INVALID_PADDLE_PREVIEW');
    expect(res.body.status).toBe('failed');
    expect(res.body.chargeMayHaveRun).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'cancel_credit_pack_purchase_request',
      expect.objectContaining({
        p_request_id: REQUEST_ID,
        p_reason: 'preview_failed'
      })
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge')))
      .toBe(false);
  });

  test('re-previews, atomically claims, then issues exactly one charge', async () => {
    const events = [];
    const rpc = makeAdminRpc(events);
    global.fetch.mockImplementation(async (url) => {
      if (url.endsWith('/charge/preview')) {
        events.push('paddle:preview');
        return previewApiResponse();
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
      return jsonResponse(true, 200, eligibleSubscriptionResponse());
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
      'rpc:claim_credit_pack_purchase_request',
      'paddle:charge',
      'rpc:transition_credit_pack_purchase_request'
    ]);

    expect(rpc).toHaveBeenNthCalledWith(
      1,
      'claim_credit_pack_purchase_request',
      {
        p_request_id: REQUEST_ID,
        p_user_id: 'user_1',
        p_customer_id: 'ctm_1',
        p_subscription_id: 'sub_1',
        p_pack_key: 'usage_600',
        p_expected_confirmation_version: 1
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
    expect(
      rpc.mock.calls.filter(([name]) => (
        name === 'claim_credit_pack_purchase_request'
      ))
    ).toHaveLength(1);
    expect(
      global.fetch.mock.calls.filter(([url]) => url.endsWith('/charge'))
    ).toHaveLength(1);

    const previewBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    const chargeBody = JSON.parse(global.fetch.mock.calls[2][1].body);
    expect(chargeBody).toEqual(previewBody);
    expect(JSON.stringify(chargeBody)).not.toMatch(/price_id|pri_pack_/);
  });

  test('an existing open request is returned without issuing another charge', async () => {
    const rpc = jest.fn(async (name) => {
      expect(name).toBe('claim_credit_pack_purchase_request');
      return {
        data: {
          applied: false,
          reason: 'duplicate_or_ambiguous',
          requestId: REQUEST_ID,
          status: 'provider_unknown',
          confirmationVersion: 1
        },
        error: null
      };
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse(true, 200, {
        ...eligibleSubscriptionResponse()
      }))
      .mockResolvedValueOnce(previewApiResponse());
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'provider_unknown',
      code: 'PURCHASE_ALREADY_PENDING',
      chargeMayHaveRun: true
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge')))
      .toBe(false);
  });

  test('an ambiguous claim response never calls Paddle charge', async () => {
    const rpc = jest.fn(async (name) => {
      expect(name).toBe('claim_credit_pack_purchase_request');
      throw new Error('claim response lost after commit');
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse(
        true,
        200,
        eligibleSubscriptionResponse()
      ))
      .mockResolvedValueOnce(previewApiResponse());
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'charging',
      code: 'PURCHASE_CONFIRMATION_PENDING',
      chargeMayHaveRun: true
    });
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge')))
      .toBe(false);
  });

  test('a stale confirmation version returns the exact recoverable preview', async () => {
    const row = {
      request_id: REQUEST_ID,
      status: 'created',
      review_required: false,
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      confirmation_version: 2,
      expiry_days: 365,
      approved_subtotal: 1000,
      approved_discount: 0,
      approved_tax: 200,
      approved_total: 1200,
      approved_credit: 0,
      approved_balance: 1200,
      approved_grand_total: 1200,
      approved_grand_total_tax: 200,
      authorization_expires_at: '2099-07-28T10:15:00.000Z',
      created_at: '2026-07-28T10:00:00.000Z',
      completed_at: null
    };
    const client = makeStatusClient(row);
    client.rpc = jest.fn(async (name) => {
      expect(name).toBe('claim_credit_pack_purchase_request');
      return {
        data: {
          applied: false,
          reason: 'confirmation_version_mismatch',
          requestId: REQUEST_ID,
          status: 'created',
          confirmationVersion: 2,
          approvedSubtotal: 1000,
          approvedDiscount: 0,
          approvedTax: 200,
          approvedTotal: 1200,
          approvedCredit: 0,
          approvedBalance: 1200,
          approvedGrandTotal: 1200,
          approvedGrandTotalTax: 200
        },
        error: null
      };
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse(
        true,
        200,
        eligibleSubscriptionResponse()
      ))
      .mockResolvedValueOnce(previewApiResponse());
    const req = makePurchaseRequest(client);
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      purchaseRequestId: REQUEST_ID,
      status: 'created',
      confirmationVersion: 2,
      expiryDays: 365,
      authorizationExpiresAt: '2099-07-28T10:15:00.000Z',
      code: 'CREDIT_PACK_TOTAL_CHANGED',
      chargeMayHaveRun: false,
      preview: {
        currencyCode: 'USD',
        grandTotal: '1200',
        grandTotalTax: '200'
      }
    });
    expect(client.chain.eq).toHaveBeenNthCalledWith(
      1,
      'request_id',
      REQUEST_ID
    );
    expect(client.chain.eq).toHaveBeenNthCalledWith(
      2,
      'authorized_user_id',
      'user_1'
    );
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge')))
      .toBe(false);
  });

  test('an unresolved withheld purchase blocks another charge for manual review', async () => {
    const rpc = jest.fn(async (name) => {
      expect(name).toBe('claim_credit_pack_purchase_request');
      return {
        data: {
          applied: false,
          reason: 'already_finalized',
          requestId: REQUEST_ID,
          status: 'withheld',
          confirmationVersion: 1
        },
        error: null
      };
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse(
        true,
        200,
        eligibleSubscriptionResponse()
      ))
      .mockResolvedValueOnce(previewApiResponse());
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      success: false,
      purchaseRequestId: REQUEST_ID,
      status: 'withheld',
      code: 'PURCHASE_REVIEW_REQUIRED',
      confirmationVersion: 1,
      chargeMayHaveRun: true,
      pack: PUBLIC_PACK
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge')))
      .toBe(false);
  });

  test.each([
    [
      'review state changed',
      'purchase_review_required',
      'PURCHASE_REVIEW_REQUIRED',
      'A previous usage add-on purchase requires review.'
    ],
    [
      'subscription state changed',
      'subscription_reconfirmation_required',
      'SUBSCRIPTION_RECONFIRMATION_REQUIRED',
      'Your subscription changed. Start a new billing preview.'
    ]
  ])('%s after preview cancels the uncharged request before returning', async (
    _label,
    reason,
    responseCode,
    responseError
  ) => {
    const events = [];
    const rpc = jest.fn(async (name, args) => {
      events.push(`rpc:${name}`);
      if (name === 'claim_credit_pack_purchase_request') {
        return {
          data: {
            applied: false,
            reason,
            requestId: REQUEST_ID,
            status: 'created',
            confirmationVersion: 1,
            cancellable: true,
            cancelReason: 'confirmation_rejected'
          },
          error: null
        };
      }
      if (name === 'cancel_credit_pack_purchase_request') {
        expect(args).toEqual({
          p_request_id: REQUEST_ID,
          p_user_id: 'user_1',
          p_reason: 'confirmation_rejected'
        });
        return {
          data: {
            applied: true,
            reason: 'purchase_request_cancelled',
            requestId: REQUEST_ID,
            status: 'failed'
          },
          error: null
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse(
        true,
        200,
        eligibleSubscriptionResponse()
      ))
      .mockResolvedValueOnce(previewApiResponse());
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      success: false,
      purchaseRequestId: REQUEST_ID,
      status: 'failed',
      error: responseError,
      code: responseCode,
      chargeMayHaveRun: false
    });
    expect(events).toEqual([
      'rpc:claim_credit_pack_purchase_request',
      'rpc:cancel_credit_pack_purchase_request'
    ]);
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge')))
      .toBe(false);
  });

  test('an invalid claim-side cancellation contract is treated as unknown and never charged', async () => {
    const rpc = jest.fn(async (name) => {
      expect(name).toBe('claim_credit_pack_purchase_request');
      return {
        data: {
          applied: false,
          reason: 'subscription_reconfirmation_required',
          requestId: REQUEST_ID,
          status: 'created',
          confirmationVersion: 1,
          cancellable: false,
          cancelReason: 'confirmation_rejected'
        },
        error: null
      };
    });
    global.fetch
      .mockResolvedValueOnce(jsonResponse(
        true,
        200,
        eligibleSubscriptionResponse()
      ))
      .mockResolvedValueOnce(previewApiResponse());
    const req = makePurchaseRequest({ rpc });
    const res = makeResponse();

    await handleCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'charging',
      code: 'PURCHASE_CONFIRMATION_PENDING',
      chargeMayHaveRun: true
    });
    expect(global.fetch.mock.calls.some(([url]) => url.endsWith('/charge')))
      .toBe(false);
  });

  test('a timed-out charge is persisted as provider-unknown and never retried', async () => {
    const events = [];
    const rpc = makeAdminRpc(events);
    global.fetch.mockImplementation(async (url) => {
      if (url.endsWith('/charge/preview')) {
        return previewApiResponse();
      }
      if (url.endsWith('/charge')) {
        events.push('paddle:charge');
        const error = new Error('Paddle charge timed out after request');
        error.name = 'TimeoutError';
        throw error;
      }
      return jsonResponse(true, 200, eligibleSubscriptionResponse());
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
        p_provider_error_code: 'timeout'
      })
    );
    const chargeCall = global.fetch.mock.calls.find(([url]) => url.endsWith('/charge'));
    expect(chargeCall[1].signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ['provider 4xx', 422, 'provider_unknown', 202, 'PURCHASE_CONFIRMATION_PENDING'],
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
        ...eligibleSubscriptionResponse()
      }))
      .mockResolvedValueOnce(previewApiResponse())
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

  test('lost-response recovery remains available with the sales kill switch off', async () => {
    process.env.CREDIT_PACK_PURCHASES_ENABLED = 'false';
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

    expect(client.chain.eq).toHaveBeenCalledWith(
      'authorized_user_id',
      'user_1'
    );
    expect(client.chain.in).not.toHaveBeenCalled();
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
        completedAt: null,
        reviewRequired: false
      }
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /txn_must_not_be_selected|private_diagnostic|customer_id|subscription_id/
    );
  });

  test('a reconciled provider-unknown request remains visible and review-locked', async () => {
    process.env.CREDIT_PACK_PURCHASES_ENABLED = 'false';
    const row = {
      request_id: REQUEST_ID,
      status: 'provider_unknown',
      review_required: true,
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      reconciliation_closed_at: new Date().toISOString(),
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: null
    };
    const client = makeStatusClient(row);
    const req = {
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handlePendingCreditPackPurchase(req, res);

    expect(res.body).toEqual({
      success: true,
      purchase: {
        purchaseRequestId: REQUEST_ID,
        status: 'provider_unknown',
        pack: PUBLIC_PACK,
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: null,
        reviewRequired: true
      }
    });
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

  test('lost-response recovery returns a recent fast completion', async () => {
    const completedAt = new Date().toISOString();
    const row = {
      request_id: REQUEST_ID,
      status: 'completed',
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      created_at: completedAt,
      completed_at: completedAt
    };
    const client = makeStatusClient(row);
    const req = {
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handlePendingCreditPackPurchase(req, res);

    expect(res.body).toEqual({
      success: true,
      purchase: {
        purchaseRequestId: REQUEST_ID,
        status: 'completed',
        pack: PUBLIC_PACK,
        createdAt: completedAt,
        completedAt,
        reviewRequired: false
      }
    });
  });

  test('lost-response recovery does not replay a stale terminal result', async () => {
    const row = {
      request_id: REQUEST_ID,
      status: 'completed',
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:01.000Z'
    };
    const client = makeStatusClient(row);
    const req = {
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handlePendingCreditPackPurchase(req, res);

    expect(res.body).toEqual({ success: true, purchase: null });
  });

  test('a newly reconciled failure remains recoverable even when its request is old', async () => {
    const reconciliationClosedAt = new Date().toISOString();
    const row = {
      request_id: REQUEST_ID,
      status: 'failed',
      review_required: false,
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      reconciliation_closed_at: reconciliationClosedAt,
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: null
    };
    const client = makeStatusClient(row);
    const req = {
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handlePendingCreditPackPurchase(req, res);

    expect(res.body).toEqual({
      success: true,
      purchase: {
        purchaseRequestId: REQUEST_ID,
        status: 'failed',
        pack: PUBLIC_PACK,
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: null,
        reviewRequired: false
      }
    });
    expect(res.body.purchase).not.toHaveProperty('reconciliationClosedAt');
  });

  test('lost-response recovery keeps a stale refunded request with a durable review lock', async () => {
    const row = {
      request_id: REQUEST_ID,
      status: 'refunded',
      review_required: true,
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      created_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:01.000Z'
    };
    const client = makeStatusClient(row);
    const req = {
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handlePendingCreditPackPurchase(req, res);

    expect(res.body).toEqual({
      success: true,
      purchase: {
        purchaseRequestId: REQUEST_ID,
        status: 'refunded',
        pack: PUBLIC_PACK,
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
        reviewRequired: true
      }
    });
  });

  test('lost-response recovery exposes a withheld purchase as review-required', async () => {
    const row = {
      request_id: REQUEST_ID,
      status: 'withheld',
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      created_at: '2026-07-28T10:00:00.000Z',
      completed_at: '2026-07-28T10:00:05.000Z',
      transaction_id: 'txn_must_not_be_selected',
      withheld_reason: 'private_diagnostic'
    };
    const client = makeStatusClient(row);
    const req = {
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handlePendingCreditPackPurchase(req, res);

    expect(res.body).toEqual({
      success: true,
      purchase: {
        purchaseRequestId: REQUEST_ID,
        status: 'withheld',
        pack: PUBLIC_PACK,
        createdAt: '2026-07-28T10:00:00.000Z',
        completedAt: '2026-07-28T10:00:05.000Z',
        reviewRequired: true
      }
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /txn_must_not_be_selected|private_diagnostic|withheld_reason/
    );
  });

  test('created status exposes the exact recoverable confirmation contract', async () => {
    const row = {
      request_id: REQUEST_ID,
      status: 'created',
      review_required: false,
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      confirmation_version: 2,
      expiry_days: 365,
      approved_subtotal: 1000,
      approved_discount: 0,
      approved_tax: 200,
      approved_total: 1200,
      approved_credit: 0,
      approved_balance: 1200,
      approved_grand_total: 1200,
      approved_grand_total_tax: 200,
      authorization_expires_at: '2099-07-28T10:15:00.000Z',
      created_at: '2026-07-28T10:00:00.000Z',
      completed_at: null
    };
    const client = makeStatusClient(row);
    const req = {
      params: { requestId: REQUEST_ID },
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handleCreditPackPurchaseStatus(req, res);

    expect(res.body).toEqual({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'created',
      pack: PUBLIC_PACK,
      createdAt: '2026-07-28T10:00:00.000Z',
      completedAt: null,
      reviewRequired: false,
      confirmationVersion: 2,
      expiryDays: 365,
      authorizationExpiresAt: '2099-07-28T10:15:00.000Z',
      preview: {
        ...expectedPreview(),
        tax: '200',
        total: '1200',
        balance: '1200',
        grandTotal: '1200',
        grandTotalTax: '200'
      }
    });
  });

  test('expired created status is closed before it is returned', async () => {
    const row = {
      request_id: REQUEST_ID,
      status: 'created',
      review_required: false,
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      confirmation_version: 1,
      expiry_days: 365,
      authorization_expires_at: '2020-07-28T10:15:00.000Z',
      created_at: new Date().toISOString(),
      completed_at: null
    };
    const client = makeStatusClient(row);
    client.rpc = jest.fn().mockResolvedValue({
      data: {
        applied: true,
        reason: 'purchase_request_expired',
        requestId: REQUEST_ID,
        status: 'failed'
      },
      error: null
    });
    const req = {
      params: { requestId: REQUEST_ID },
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handleCreditPackPurchaseStatus(req, res);

    expect(client.rpc).toHaveBeenCalledWith(
      'expire_credit_pack_purchase_request',
      {
        p_request_id: REQUEST_ID,
        p_user_id: 'user_1'
      }
    );
    expect(res.body).toMatchObject({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'failed'
    });
    expect(res.body).not.toHaveProperty('confirmationVersion');
    expect(res.body).not.toHaveProperty('preview');
  });

  test('pre-claim cancellation returns the sole safe unlock contract', async () => {
    const rpc = makeAdminRpc();
    const req = {
      params: { requestId: REQUEST_ID },
      user: { id: 'user_1' },
      paymentAdminClient: { rpc }
    };
    const res = makeResponse();

    await handleCancelCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'failed',
      chargeMayHaveRun: false
    });
    expect(rpc).toHaveBeenCalledWith(
      'cancel_credit_pack_purchase_request',
      {
        p_request_id: REQUEST_ID,
        p_user_id: 'user_1',
        p_reason: 'client_cancelled'
      }
    );
  });

  test('charging cancellation is refused without releasing the recovery lock', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: {
        applied: false,
        reason: 'reconciliation_required',
        requestId: REQUEST_ID,
        status: 'charging'
      },
      error: null
    });
    const req = {
      params: { requestId: REQUEST_ID },
      user: { id: 'user_1' },
      paymentAdminClient: { rpc }
    };
    const res = makeResponse();

    await handleCancelCreditPackPurchase(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      success: false,
      purchaseRequestId: REQUEST_ID,
      status: 'charging',
      error: 'This purchase can no longer be safely cancelled.',
      code: 'PURCHASE_CANCELLATION_UNSAFE',
      chargeMayHaveRun: true
    });
  });

  test('status lookup remains owner-scoped with the sales kill switch off', async () => {
    process.env.CREDIT_PACK_PURCHASES_ENABLED = 'false';
    const row = {
      request_id: REQUEST_ID,
      status: 'withheld',
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      created_at: '2026-07-28T10:00:00.000Z',
      completed_at: '2026-07-28T10:00:05.000Z',
      transaction_id: 'txn_must_not_be_selected',
      provider_price_id: 'pri_must_not_be_selected',
      withheld_reason: 'authorization_expired'
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
      'request_id, status, review_required, pack_key, credits, unit_amount, ' +
      'currency_code, confirmation_version, expiry_days, approved_subtotal, ' +
      'approved_discount, approved_tax, approved_total, approved_credit, ' +
      'approved_balance, approved_grand_total, approved_grand_total_tax, ' +
      'authorization_expires_at, reconciliation_closed_at, created_at, ' +
      'completed_at'
    );
    expect(client.chain.eq).toHaveBeenNthCalledWith(1, 'request_id', REQUEST_ID);
    expect(client.chain.eq).toHaveBeenNthCalledWith(
      2,
      'authorized_user_id',
      'user_1'
    );
    expect(res.body).toEqual({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'withheld',
      pack: PUBLIC_PACK,
      createdAt: '2026-07-28T10:00:00.000Z',
      completedAt: '2026-07-28T10:00:05.000Z',
      reviewRequired: true
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /txn_must_not_be_selected|pri_must_not_be_selected|authorization_expired|customer_id|subscription_id/
    );
  });

  test('status lookup exposes chargeback as a distinct terminal review state', async () => {
    const row = {
      request_id: REQUEST_ID,
      status: 'chargeback',
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      created_at: '2026-07-28T10:00:00.000Z',
      completed_at: '2026-07-28T10:00:05.000Z'
    };
    const client = makeStatusClient(row);
    const req = {
      params: { requestId: REQUEST_ID },
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handleCreditPackPurchaseStatus(req, res);

    expect(res.body).toEqual({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'chargeback',
      pack: PUBLIC_PACK,
      createdAt: '2026-07-28T10:00:00.000Z',
      completedAt: '2026-07-28T10:00:05.000Z',
      reviewRequired: true
    });
  });

  test('status lookup keeps a refunded request locked when consumed credits require review', async () => {
    const row = {
      request_id: REQUEST_ID,
      status: 'refunded',
      review_required: true,
      pack_key: 'usage_600',
      credits: 600,
      unit_amount: 1000,
      currency_code: 'USD',
      created_at: '2026-07-28T10:00:00.000Z',
      completed_at: '2026-07-28T10:00:05.000Z'
    };
    const client = makeStatusClient(row);
    const req = {
      params: { requestId: REQUEST_ID },
      user: { id: 'user_1' },
      paymentAdminClient: client
    };
    const res = makeResponse();

    await handleCreditPackPurchaseStatus(req, res);

    expect(res.body).toEqual({
      success: true,
      purchaseRequestId: REQUEST_ID,
      status: 'refunded',
      pack: PUBLIC_PACK,
      createdAt: '2026-07-28T10:00:00.000Z',
      completedAt: '2026-07-28T10:00:05.000Z',
      reviewRequired: true
    });
  });
});
