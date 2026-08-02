'use strict';

const crypto = require('crypto');
const {
  buildSubscriptionCheckoutTransactionBody,
  validateCreatedSubscriptionTransaction,
  handleSubscriptionCheckout,
  createSubscriptionCheckoutAttempt,
  bindSubscriptionCheckoutTransaction,
  transitionSubscriptionCheckoutAttempt
} = require('../../routes/payment');

const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174000';
const TRANSACTION_ID = 'txn_subscription_checkout_1';
const USER_ID = 'user_1';
const PRO_CONTRACT = Object.freeze({
  priceId: 'pri_pro_1099',
  credits: 600,
  unitAmount: '1099',
  currencyCode: 'USD'
});

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

function validTransaction(overrides = {}) {
  const base = {
    id: TRANSACTION_ID,
    status: 'draft',
    origin: 'api',
    collection_mode: 'automatic',
    currency_code: 'USD',
    items: [{
      quantity: 1,
      price: {
        id: PRO_CONTRACT.priceId,
        unit_price: {
          amount: PRO_CONTRACT.unitAmount,
          currency_code: PRO_CONTRACT.currencyCode
        }
      }
    }],
    custom_data: {
      promptgenKind: 'subscription_checkout',
      promptgenCheckoutAttemptId: ATTEMPT_ID,
      promptgenTargetPlan: 'pro'
    }
  };
  return {
    ...base,
    ...overrides
  };
}

function createdAttempt(overrides = {}) {
  return {
    applied: true,
    reason: 'checkout_attempt_created',
    attemptId: ATTEMPT_ID,
    targetPlan: 'pro',
    status: 'created',
    transactionId: null,
    ...overrides
  };
}

function makeAdminClient({
  createResult = createdAttempt(),
  createError = null,
  bindResult = {
    applied: true,
    reason: 'transaction_bound',
    attemptId: ATTEMPT_ID,
    status: 'bound',
    transactionId: TRANSACTION_ID
  },
  bindError = null,
  transitionResult = {
    applied: true,
    reason: 'attempt_transitioned'
  },
  transitionError = null,
  events = []
} = {}) {
  const rpc = jest.fn(async (name) => {
    events.push(`rpc:${name}`);
    if (name === 'create_subscription_checkout_attempt') {
      return { data: createResult, error: createError };
    }
    if (name === 'bind_subscription_checkout_transaction') {
      return { data: bindResult, error: bindError };
    }
    if (name === 'transition_subscription_checkout_attempt') {
      return { data: transitionResult, error: transitionError };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
  return { rpc };
}

function makeRequest(adminClient, body = {}) {
  return {
    body: {
      plan: 'pro',
      ...body
    },
    user: { id: USER_ID },
    paymentAdminClient: adminClient
  };
}

describe('authenticated server-created subscription checkout', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  let randomUuidSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PADDLE_API_KEY: 'test-api-key',
      PADDLE_PRO_PRICE_ID: 'pri_pro_999',
      PADDLE_PRO_1099_PRICE_ID: PRO_CONTRACT.priceId,
      PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise_1999',
      PRO_PRICE_1099_ENABLED: 'true'
    };
    global.fetch = jest.fn();
    randomUuidSpy = jest.spyOn(crypto, 'randomUUID').mockReturnValue(ATTEMPT_ID);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    randomUuidSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  test('builds exactly one server-selected recurring item and no client ownership data', () => {
    const body = buildSubscriptionCheckoutTransactionBody({
      attemptId: ATTEMPT_ID,
      plan: 'pro',
      contract: PRO_CONTRACT
    });

    expect(body).toEqual({
      items: [{
        price_id: PRO_CONTRACT.priceId,
        quantity: 1
      }],
      collection_mode: 'automatic',
      custom_data: {
        promptgenKind: 'subscription_checkout',
        promptgenCheckoutAttemptId: ATTEMPT_ID,
        promptgenTargetPlan: 'pro'
      }
    });
    expect(Object.keys(body.custom_data).sort()).toEqual([
      'promptgenCheckoutAttemptId',
      'promptgenKind',
      'promptgenTargetPlan'
    ]);
    expect(JSON.stringify(body)).not.toMatch(/userId|user_id|email/i);
  });

  test('accepts only the exact API transaction contract', () => {
    expect(validateCreatedSubscriptionTransaction(validTransaction(), {
      attemptId: ATTEMPT_ID,
      plan: 'pro',
      contract: PRO_CONTRACT
    })).toBe(true);
  });

  test.each([
    ['web origin', { origin: 'web' }],
    ['manual collection', { collection_mode: 'manual' }],
    ['wrong currency', { currency_code: 'EUR' }],
    ['unexpected status', { status: 'completed' }],
    ['missing transaction ID', { id: '' }],
    ['multiple items', {
      items: [
        validTransaction().items[0],
        validTransaction().items[0]
      ]
    }],
    ['wrong price', {
      items: [{
        ...validTransaction().items[0],
        price: {
          ...validTransaction().items[0].price,
          id: 'pri_attacker'
        }
      }]
    }],
    ['wrong quantity', {
      items: [{
        ...validTransaction().items[0],
        quantity: 2
      }]
    }],
    ['wrong amount', {
      items: [{
        ...validTransaction().items[0],
        price: {
          ...validTransaction().items[0].price,
          unit_price: {
            ...validTransaction().items[0].price.unit_price,
            amount: '1'
          }
        }
      }]
    }],
    ['wrong metadata plan', {
      custom_data: {
        ...validTransaction().custom_data,
        promptgenTargetPlan: 'enterprise'
      }
    }],
    ['client user ownership metadata', {
      custom_data: {
        ...validTransaction().custom_data,
        userId: 'victim_user'
      }
    }],
    ['client email ownership metadata', {
      custom_data: {
        ...validTransaction().custom_data,
        email: 'victim@example.com'
      }
    }]
  ])('rejects %s', (_label, overrides) => {
    expect(validateCreatedSubscriptionTransaction(
      validTransaction(overrides),
      {
        attemptId: ATTEMPT_ID,
        plan: 'pro',
        contract: PRO_CONTRACT
      }
    )).toBe(false);
  });

  test('RPC helpers bind immutable user, plan, price, credit, amount, and currency fields', async () => {
    const adminClient = makeAdminClient();

    await createSubscriptionCheckoutAttempt(adminClient, {
      attemptId: ATTEMPT_ID,
      userId: USER_ID,
      plan: 'pro',
      contract: PRO_CONTRACT
    });
    await bindSubscriptionCheckoutTransaction(adminClient, {
      attemptId: ATTEMPT_ID,
      userId: USER_ID,
      transactionId: TRANSACTION_ID,
      plan: 'pro',
      contract: PRO_CONTRACT
    });
    await transitionSubscriptionCheckoutAttempt(adminClient, {
      attemptId: ATTEMPT_ID,
      userId: USER_ID,
      status: 'provider_unknown',
      providerErrorCode: 'network_error'
    });

    expect(adminClient.rpc).toHaveBeenNthCalledWith(
      1,
      'create_subscription_checkout_attempt',
      {
        p_attempt_id: ATTEMPT_ID,
        p_user_id: USER_ID,
        p_target_plan: 'pro',
        p_price_id: PRO_CONTRACT.priceId,
        p_credits: 600,
        p_unit_amount: 1099,
        p_currency_code: 'USD'
      }
    );
    expect(adminClient.rpc).toHaveBeenNthCalledWith(
      2,
      'bind_subscription_checkout_transaction',
      {
        p_attempt_id: ATTEMPT_ID,
        p_user_id: USER_ID,
        p_transaction_id: TRANSACTION_ID,
        p_origin: 'api',
        p_plan: 'pro',
        p_price_id: PRO_CONTRACT.priceId,
        p_credits: 600,
        p_unit_amount: 1099,
        p_currency_code: 'USD',
        p_quantity: 1
      }
    );
    expect(adminClient.rpc).toHaveBeenNthCalledWith(
      3,
      'transition_subscription_checkout_attempt',
      {
        p_attempt_id: ATTEMPT_ID,
        p_user_id: USER_ID,
        p_status: 'provider_unknown',
        p_provider_error_code: 'network_error'
      }
    );
  });

  test('durably creates an attempt before exactly one Paddle transaction, then binds it', async () => {
    const events = [];
    const adminClient = makeAdminClient({ events });
    global.fetch.mockImplementation(async () => {
      events.push('paddle:create_transaction');
      return jsonResponse(true, 201, { data: validTransaction() });
    });
    const req = makeRequest(adminClient, {
      // These attacker-controlled values must be ignored.
      priceId: 'pri_attacker',
      userId: 'victim_user',
      email: 'victim@example.com'
    });
    const res = makeResponse();

    await handleSubscriptionCheckout(req, res);

    expect(events).toEqual([
      'rpc:create_subscription_checkout_attempt',
      'paddle:create_transaction',
      'rpc:bind_subscription_checkout_transaction'
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toMatch(/\/transactions$/);
    const request = global.fetch.mock.calls[0][1];
    expect(request.method).toBe('POST');
    expect(request.headers.Authorization).toBe('Bearer test-api-key');
    expect(JSON.parse(request.body)).toEqual({
      items: [{ price_id: PRO_CONTRACT.priceId, quantity: 1 }],
      collection_mode: 'automatic',
      custom_data: {
        promptgenKind: 'subscription_checkout',
        promptgenCheckoutAttemptId: ATTEMPT_ID,
        promptgenTargetPlan: 'pro'
      }
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).toEqual({
      success: true,
      checkoutAttemptId: ATTEMPT_ID,
      transactionId: TRANSACTION_ID
    });
  });

  test('returns an already-bound same-plan transaction without another Paddle call', async () => {
    const existingAttemptId = '223e4567-e89b-42d3-a456-426614174000';
    const adminClient = makeAdminClient({
      createResult: createdAttempt({
        applied: false,
        reason: 'duplicate_pending',
        attemptId: existingAttemptId,
        targetPlan: 'pro',
        status: 'bound',
        transactionId: TRANSACTION_ID
      })
    });
    const res = makeResponse();

    await handleSubscriptionCheckout(makeRequest(adminClient), res);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(adminClient.rpc).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      checkoutAttemptId: existingAttemptId,
      transactionId: TRANSACTION_ID
    });
  });

  test.each(['created', 'provider_unknown'])(
    'returns an existing same-plan %s attempt as pending without charging again',
    async (status) => {
      const existingAttemptId = '223e4567-e89b-42d3-a456-426614174000';
      const adminClient = makeAdminClient({
        createResult: createdAttempt({
          applied: false,
          reason: 'duplicate_pending',
          attemptId: existingAttemptId,
          targetPlan: 'pro',
          status,
          transactionId: null
        })
      });
      const res = makeResponse();

      await handleSubscriptionCheckout(makeRequest(adminClient), res);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(adminClient.rpc).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(202);
      expect(res.body).toMatchObject({
        success: true,
        checkoutAttemptId: existingAttemptId,
        status,
        code: 'CHECKOUT_CONFIRMATION_PENDING'
      });
      expect(res.body).not.toHaveProperty('transactionId');
    }
  );

  test('rejects a different-plan open attempt without a Paddle call', async () => {
    const adminClient = makeAdminClient({
      createResult: createdAttempt({
        applied: false,
        reason: 'duplicate_pending',
        attemptId: '223e4567-e89b-42d3-a456-426614174000',
        targetPlan: 'enterprise',
        status: 'created'
      })
    });
    const res = makeResponse();

    await handleSubscriptionCheckout(makeRequest(adminClient), res);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CHECKOUT_ALREADY_PENDING');
    expect(res.body).not.toHaveProperty('transactionId');
  });

  test('rejects invalid plans before DB or Paddle access', async () => {
    const adminClient = makeAdminClient();
    const res = makeResponse();

    await handleSubscriptionCheckout(
      makeRequest(adminClient, { plan: 'free' }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_PLAN');
    expect(adminClient.rpc).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('blocks Paddle Sandbox checkout until the operator explicitly confirms it', async () => {
    process.env.PADDLE_API_BASE = 'https://sandbox-api.paddle.com';
    process.env.PADDLE_SANDBOX_CHECKOUT_CONFIRMED = 'false';
    const adminClient = makeAdminClient();
    const res = makeResponse();

    await handleSubscriptionCheckout(makeRequest(adminClient), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: 'Checkout is temporarily unavailable.',
      code: 'SANDBOX_CHECKOUT_NOT_CONFIRMED'
    });
    expect(adminClient.rpc).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('fails closed when the DB rejects an active or reconciling subscription', async () => {
    const adminClient = makeAdminClient({
      createError: {
        message: 'SUBSCRIPTION_CHECKOUT_ACTIVE_SUBSCRIPTION_REQUIRES_RECONCILIATION'
      }
    });
    const res = makeResponse();

    await handleSubscriptionCheckout(makeRequest(adminClient), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('SUBSCRIPTION_ALREADY_EXISTS');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a network-unknown outcome is persisted and the transaction is never retried', async () => {
    const adminClient = makeAdminClient();
    global.fetch.mockRejectedValue(new Error('socket closed after request'));
    const res = makeResponse();

    await handleSubscriptionCheckout(makeRequest(adminClient), res);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(adminClient.rpc).toHaveBeenLastCalledWith(
      'transition_subscription_checkout_attempt',
      {
        p_attempt_id: ATTEMPT_ID,
        p_user_id: USER_ID,
        p_status: 'provider_unknown',
        p_provider_error_code: 'network_error'
      }
    );
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      success: true,
      checkoutAttemptId: ATTEMPT_ID,
      status: 'provider_unknown',
      code: 'CHECKOUT_CONFIRMATION_PENDING'
    });
    expect(res.body).not.toHaveProperty('transactionId');
  });

  test.each([
    ['provider 4xx', 422, 'failed', 409, false, 'CHECKOUT_REJECTED'],
    [
      'provider 5xx',
      503,
      'provider_unknown',
      202,
      true,
      'CHECKOUT_CONFIRMATION_PENDING'
    ]
  ])('%s is classified without retrying', async (
    _label,
    providerStatus,
    persistedStatus,
    responseStatus,
    success,
    responseCode
  ) => {
    const adminClient = makeAdminClient();
    global.fetch.mockResolvedValue(jsonResponse(false, providerStatus, {
      error: {
        code: 'provider_rejected',
        detail: 'sensitive provider message'
      }
    }));
    const res = makeResponse();

    await handleSubscriptionCheckout(makeRequest(adminClient), res);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(adminClient.rpc).toHaveBeenLastCalledWith(
      'transition_subscription_checkout_attempt',
      expect.objectContaining({
        p_attempt_id: ATTEMPT_ID,
        p_user_id: USER_ID,
        p_status: persistedStatus,
        p_provider_error_code: 'provider_rejected'
      })
    );
    expect(res.statusCode).toBe(responseStatus);
    expect(res.body).toMatchObject({
      success,
      checkoutAttemptId: ATTEMPT_ID,
      status: persistedStatus,
      code: responseCode
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /sensitive provider message|provider_rejected/
    );
    expect(res.body).not.toHaveProperty('transactionId');
  });

  test('an invalid provider transaction is quarantined without exposing a checkout ID', async () => {
    const adminClient = makeAdminClient();
    global.fetch.mockResolvedValue(jsonResponse(true, 201, {
      data: validTransaction({ origin: 'web' })
    }));
    const res = makeResponse();

    await handleSubscriptionCheckout(makeRequest(adminClient), res);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(adminClient.rpc).toHaveBeenLastCalledWith(
      'transition_subscription_checkout_attempt',
      expect.objectContaining({
        p_status: 'provider_unknown',
        p_provider_error_code: 'invalid_transaction_response'
      })
    );
    expect(res.statusCode).toBe(202);
    expect(res.body.code).toBe('CHECKOUT_CONFIRMATION_PENDING');
    expect(res.body).not.toHaveProperty('transactionId');
  });

  test('a binding failure quarantines the attempt and never exposes the unbound transaction', async () => {
    const adminClient = makeAdminClient({
      bindError: { message: 'database unavailable' }
    });
    global.fetch.mockResolvedValue(jsonResponse(true, 201, {
      data: validTransaction()
    }));
    const res = makeResponse();

    await handleSubscriptionCheckout(makeRequest(adminClient), res);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(adminClient.rpc).toHaveBeenLastCalledWith(
      'transition_subscription_checkout_attempt',
      expect.objectContaining({
        p_status: 'provider_unknown',
        p_provider_error_code: 'binding_failed'
      })
    );
    expect(res.statusCode).toBe(202);
    expect(res.body.code).toBe('CHECKOUT_CONFIRMATION_PENDING');
    expect(res.body).not.toHaveProperty('transactionId');
  });
});
