'use strict';

const crypto = require('crypto');
const http = require('http');
const express = require('express');

const mockCreateClient = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args) => mockCreateClient(...args)
}));

const paddleRouter = require('../../routes/paddle');
const {
  getSubscriptionCheckoutMetadata,
  validateCompletedSubscriptionCheckoutTransaction,
  findRecoverableSubscriptionCheckoutAttemptByMetadata,
  consumeSubscriptionCheckoutAttempt,
  reportLateReconciledSubscriptionCheckoutPayment,
  reportDeletedAccountSubscriptionCheckoutPayment,
  classifyCompletedTransactionRoute,
  resolveExistingSubscriptionOwner,
  resolveSubscriptionSnapshotOwner
} = paddleRouter;
const { _setAdminClientForTests } = require('../../lib/incident-reporter');

const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '223e4567-e89b-42d3-a456-426614174000';
const ENV = {
  PRO_PRICE_1099_ENABLED: 'true',
  PADDLE_PRO_PRICE_ID: 'pri_pro_999',
  PADDLE_PRO_1099_PRICE_ID: 'pri_pro_1099',
  PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise',
  PADDLE_PRO_PRICE_USD: '9.99',
  PADDLE_ENTERPRISE_PRICE_USD: '19.99'
};

function checkoutAttempt(overrides = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    user_id: USER_ID,
    authorized_user_id: USER_ID,
    transaction_id: 'txn_secure_checkout',
    subscription_id: null,
    customer_id: null,
    target_plan: 'pro',
    price_id: 'pri_pro_1099',
    credits: 600,
    unit_amount: 1099,
    currency_code: 'USD',
    expected_origin: 'api',
    status: 'bound',
    ...overrides
  };
}

function completedCheckout(overrides = {}) {
  return {
    id: 'txn_secure_checkout',
    status: 'completed',
    origin: 'api',
    collection_mode: 'automatic',
    currency_code: 'USD',
    subscription_id: 'sub_secure_checkout',
    customer_id: 'ctm_secure_checkout',
    custom_data: {
      promptgenKind: 'subscription_checkout',
      promptgenCheckoutAttemptId: ATTEMPT_ID,
      promptgenTargetPlan: 'pro'
    },
    items: [{
      quantity: 1,
      price: {
        id: 'pri_pro_1099',
        type: 'standard',
        unit_price: { amount: '1099', currency_code: 'USD' },
        billing_cycle: { interval: 'month', frequency: 1 }
      }
    }],
    ...overrides
  };
}

function buildSignatureHeader(secret, rawBody, timestamp) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}:${rawBody}`)
    .digest('hex');
  return `ts=${timestamp};h1=${signature}`;
}

function startWebhookServer() {
  const app = express();
  app.use('/api/paddle', paddleRouter);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopWebhookServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function postSignedWebhook(server, rawBody, signature) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/paddle/webhook',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(rawBody),
        'paddle-signature': signature
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.on('error', reject);
    request.end(rawBody);
  });
}

function makeQueryClient(handler, rpcResult = {
  data: {
    applied: true,
    reason: 'payment_applied',
    userId: USER_ID,
    status: 'completed',
    targetPlan: 'pro'
  },
  error: null
}) {
  return {
    from: jest.fn((table) => {
      const filters = {};
      const builder = {
        select: jest.fn(() => builder),
        eq: jest.fn((column, value) => {
          filters[column] = value;
          return builder;
        }),
        in: jest.fn((column, values) => {
          filters[column] = values;
          return builder;
        }),
        single: jest.fn(() => handler({ table, filters, mode: 'single' })),
        maybeSingle: jest.fn(() => handler({
          table,
          filters,
          mode: 'maybeSingle'
        }))
      };
      return builder;
    }),
    rpc: jest.fn().mockResolvedValue(rpcResult)
  };
}

describe('server-bound subscription checkout webhook contract', () => {
  test('accepts exact optional metadata and validates against the immutable attempt row', () => {
    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout(),
      checkoutAttempt()
    )).toMatchObject({
      valid: true,
      metadata: { attemptId: ATTEMPT_ID, plan: 'pro' },
      contract: {
        attemptId: ATTEMPT_ID,
        priceId: 'pri_pro_1099',
        unitAmount: '1099',
        credits: 600
      }
    });

    expect(getSubscriptionCheckoutMetadata({
      custom_data: {
        promptgenKind: 'subscription_checkout',
        promptgenCheckoutAttemptId: ATTEMPT_ID,
        promptgenTargetPlan: 'pro',
        userId: USER_ID
      }
    })).toBeNull();
  });

  test('removed or unrelated custom_data cannot remove a valid server transaction binding', () => {
    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout({ custom_data: undefined }),
      checkoutAttempt()
    ).valid).toBe(true);

    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout({ custom_data: { providerNote: 'changed upstream' } }),
      checkoutAttempt()
    ).valid).toBe(true);
  });

  test('a present subscription-checkout marker is an exact integrity signal', () => {
    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout({
        custom_data: {
          promptgenKind: 'subscription_checkout',
          promptgenCheckoutAttemptId:
            '323e4567-e89b-42d3-a456-426614174000',
          promptgenTargetPlan: 'pro'
        }
      }),
      checkoutAttempt()
    )).toMatchObject({
      valid: false,
      reason: 'checkout_metadata_mismatch'
    });

    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout({
        custom_data: {
          promptgenKind: 'subscription_checkout',
          promptgenCheckoutAttemptId: ATTEMPT_ID,
          promptgenTargetPlan: 'pro',
          extra: 'not-allowed'
        }
      }),
      checkoutAttempt()
    )).toMatchObject({
      valid: false,
      reason: 'invalid_checkout_metadata'
    });
  });

  test.each([
    ['web origin', { origin: 'web' }, {}, 'invalid_transaction_identity'],
    ['wrong price', {
      items: [{
        quantity: 1,
        price: {
          id: 'pri_pro_999',
          type: 'standard',
          unit_price: { amount: '999', currency_code: 'USD' },
          billing_cycle: { interval: 'month', frequency: 1 }
        }
      }]
    }, {}, 'subscription_contract_mismatch'],
    ['wrong amount', {
      items: [{
        quantity: 1,
        price: {
          id: 'pri_pro_1099',
          type: 'standard',
          unit_price: { amount: '999', currency_code: 'USD' },
          billing_cycle: { interval: 'month', frequency: 1 }
        }
      }]
    }, {}, 'subscription_contract_mismatch'],
    ['multiple items', {
      items: completedCheckout().items.concat(completedCheckout().items)
    }, {}, 'invalid_item_count'],
    ['credit-pack marker on a subscription item', {
      items: [{
        ...completedCheckout().items[0],
        price: {
          ...completedCheckout().items[0].price,
          custom_data: {
            promptgenKind: 'credit_pack',
            promptgenPackKey: 'usage_unknown'
          }
        }
      }]
    }, {}, 'unexpected_credit_pack_marker'],
    ['unbound transaction ID', {}, {
      transaction_id: 'txn_other'
    }, 'invalid_server_attempt']
  ])('rejects %s', (_label, transactionOverride, attemptOverride, reason) => {
    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout(transactionOverride),
      checkoutAttempt(attemptOverride)
    )).toMatchObject({ valid: false, reason });
  });

  test('honors the immutable stored credit contract across a future catalog cutover', () => {
    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout(),
      checkoutAttempt({ credits: 550 })
    )).toMatchObject({
      valid: true,
      contract: { credits: 550 }
    });
  });

  test('$9.99 attempt still completes after the runtime catalog cuts over to $10.99', () => {
    const legacyTransaction = completedCheckout({
      custom_data: undefined,
      items: [{
        quantity: 1,
        price: {
          id: 'pri_pro_999',
          type: 'standard',
          unit_price: { amount: '999', currency_code: 'USD' },
          billing_cycle: { interval: 'month', frequency: 1 }
        }
      }]
    });
    const legacyAttempt = checkoutAttempt({
      price_id: 'pri_pro_999',
      unit_amount: 999
    });

    expect(validateCompletedSubscriptionCheckoutTransaction(
      legacyTransaction,
      legacyAttempt
    )).toMatchObject({
      valid: true,
      contract: { priceId: 'pri_pro_999', unitAmount: '999' }
    });
  });

  test.each(['charging', 'provider_unknown'])(
    'accepts %s only with exact recovery metadata and immutable contract',
    (status) => {
    const attempt = checkoutAttempt({
      transaction_id: null,
      status
    });

    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout(),
      attempt
    )).toMatchObject({ valid: true });
    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout({ custom_data: undefined }),
      attempt
    )).toMatchObject({
      valid: false,
      reason: 'recovery_metadata_required'
    });
    }
  );

  test('transaction miss falls back only to the metadata-bound recoverable attempt', async () => {
    const attempt = checkoutAttempt({
      transaction_id: null,
      status: 'provider_unknown'
    });
    const supabase = makeQueryClient(async ({ table, filters, mode }) => {
      expect(table).toBe('subscription_checkout_attempts');
      expect(mode).toBe('maybeSingle');
      expect(filters).toEqual({
        attempt_id: ATTEMPT_ID,
        status: ['charging', 'provider_unknown', 'reconciled_no_match']
      });
      return { data: attempt, error: null };
    });

    await expect(findRecoverableSubscriptionCheckoutAttemptByMetadata(
      supabase,
      completedCheckout()
    )).resolves.toEqual(attempt);

    await expect(findRecoverableSubscriptionCheckoutAttemptByMetadata(
      supabase,
      completedCheckout({ custom_data: undefined })
    )).resolves.toBeNull();
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  test('metadata fallback rejects a recoverable row whose stored contract differs', async () => {
    const supabase = makeQueryClient(async () => ({
      data: checkoutAttempt({
        transaction_id: null,
        status: 'reconciled_no_match',
        unit_amount: 999
      }),
      error: null
    }));

    await expect(findRecoverableSubscriptionCheckoutAttemptByMetadata(
      supabase,
      completedCheckout()
    )).resolves.toBeNull();
  });

  test('resolves by transaction_id then consumes the stored immutable contract', async () => {
    const attempt = checkoutAttempt();
    const supabase = makeQueryClient(async ({ table, filters, mode }) => {
      expect(table).toBe('subscription_checkout_attempts');
      expect(mode).toBe('maybeSingle');
      expect(filters).toEqual({ transaction_id: 'txn_secure_checkout' });
      return { data: attempt, error: null };
    });

    await expect(consumeSubscriptionCheckoutAttempt(
      supabase,
      completedCheckout({ custom_data: undefined }),
      '2026-07-28T00:00:00.000Z'
    )).resolves.toMatchObject({
      userId: USER_ID,
      status: 'completed',
      verifiedAttemptId: ATTEMPT_ID,
      verifiedPlan: 'pro',
      verifiedCredits: 600
    });

    expect(supabase.rpc).toHaveBeenCalledWith(
      'consume_subscription_checkout_attempt',
      expect.objectContaining({
        p_attempt_id: ATTEMPT_ID,
        p_transaction_id: 'txn_secure_checkout',
        p_subscription_id: 'sub_secure_checkout',
        p_customer_id: 'ctm_secure_checkout',
        p_origin: 'api',
        p_transaction_status: 'completed',
        p_plan: 'pro',
        p_price_id: 'pri_pro_1099',
        p_credits: 600,
        p_unit_amount: 1099,
        p_currency_code: 'USD',
        p_quantity: 1,
        p_completed_at: '2026-07-28T00:00:00.000Z'
      })
    );
  });

  test('a completed API transaction with no server-bound transaction row is rejected', async () => {
    const supabase = makeQueryClient(async () => ({ data: null, error: null }));

    await expect(consumeSubscriptionCheckoutAttempt(
      supabase,
      completedCheckout(),
      '2026-07-28T00:00:00.000Z'
    )).rejects.toMatchObject({
      code: 'UNBOUND_SUBSCRIPTION_CHECKOUT_TRANSACTION'
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('accepts the exact terminal late-payment tombstone outcome without entitlement', async () => {
    const attempt = checkoutAttempt({
      user_id: null,
      transaction_id: null,
      status: 'reconciled_no_match'
    });
    const supabase = makeQueryClient(async () => {
      throw new Error('Unexpected lookup');
    }, {
      data: {
        applied: true,
        reason: 'late_payment_after_reconciled_no_match',
        status: 'reconciled_no_match',
        entitlementGranted: false,
        refundReviewRequired: true,
        withheldReason: 'late_payment_after_reconciled_no_match',
        authorizedUserId: USER_ID,
        userId: null,
        transactionId: 'txn_secure_checkout',
        subscriptionId: 'sub_secure_checkout'
      },
      error: null
    });

    await expect(consumeSubscriptionCheckoutAttempt(
      supabase,
      completedCheckout(),
      '2026-07-28T00:00:00.000Z',
      attempt
    )).resolves.toMatchObject({
      reason: 'late_payment_after_reconciled_no_match',
      entitlementGranted: false,
      refundReviewRequired: true,
      authorizedUserId: USER_ID,
      userId: null,
      verifiedAttemptId: ATTEMPT_ID
    });
  });

  test('deleted-account tombstone is recovered only from immutable authorized_user_id', async () => {
    const attempt = checkoutAttempt({
      user_id: null,
      authorized_user_id: USER_ID,
      transaction_id: null,
      status: 'reconciled_no_match'
    });
    const supabase = makeQueryClient(async () => ({ data: attempt, error: null }));

    await expect(findRecoverableSubscriptionCheckoutAttemptByMetadata(
      supabase,
      completedCheckout()
    )).resolves.toEqual(attempt);

    await expect(findRecoverableSubscriptionCheckoutAttemptByMetadata(
      makeQueryClient(async () => ({
        data: { ...attempt, authorized_user_id: null },
        error: null
      })),
      completedCheckout()
    )).resolves.toBeNull();
  });

  test('late reconciled payment persists a dedicated refund-review incident', async () => {
    const incidentReporter = jest.fn().mockResolvedValue({ persisted: true });
    const result = {
      applied: false,
      reason: 'late_payment_after_reconciled_no_match',
      status: 'reconciled_no_match',
      entitlementGranted: false,
      refundReviewRequired: true,
      withheldReason: 'late_payment_after_reconciled_no_match',
      authorizedUserId: USER_ID,
      userId: null,
      transactionId: 'txn_secure_checkout',
      subscriptionId: 'sub_secure_checkout',
      verifiedAttemptId: ATTEMPT_ID,
      verifiedPlan: 'pro'
    };

    await expect(reportLateReconciledSubscriptionCheckoutPayment(
      result,
      completedCheckout(),
      {
        requestId: 'http_request_1',
        eventId: 'notification_1',
        providerEventId: 'event_1',
        incidentReporter
      }
    )).resolves.toEqual({ persisted: true });
    expect(incidentReporter).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'SUBSCRIPTION_CHECKOUT_LATE_PAYMENT_REFUND_REVIEW_REQUIRED',
      context: expect.objectContaining({
        transactionId: 'txn_secure_checkout',
        subscriptionId: 'sub_secure_checkout',
        authorizedUserId: USER_ID,
        userId: null,
        entitlementGranted: false,
        refundReviewRequired: true
      })
    }));
  });

  test('late reconciled payment is retryable until its incident is durable', async () => {
    const result = {
      applied: true,
      reason: 'late_payment_after_reconciled_no_match',
      status: 'reconciled_no_match',
      entitlementGranted: false,
      refundReviewRequired: true,
      withheldReason: 'late_payment_after_reconciled_no_match',
      authorizedUserId: USER_ID,
      userId: USER_ID,
      transactionId: 'txn_secure_checkout',
      subscriptionId: 'sub_secure_checkout'
    };

    await expect(reportLateReconciledSubscriptionCheckoutPayment(
      result,
      completedCheckout(),
      {
        incidentReporter: jest.fn().mockResolvedValue({ persisted: false })
      }
    )).rejects.toMatchObject({
      code: 'SUBSCRIPTION_CHECKOUT_LATE_PAYMENT_INCIDENT_PERSIST_FAILED'
    });
  });

  test.each(['charging', 'provider_unknown'])(
    'account-deleted %s completion is accepted only as no-entitlement review',
    async (status) => {
    const attempt = checkoutAttempt({
      user_id: null,
      authorized_user_id: USER_ID,
      transaction_id: null,
      status
    });
    const supabase = makeQueryClient(async () => {
      throw new Error('Unexpected lookup');
    }, {
      data: {
        applied: true,
        reason: 'payment_after_account_deleted',
        status: 'account_deleted_review',
        entitlementGranted: false,
        refundReviewRequired: true,
        withheldReason: 'payment_after_account_deleted',
        authorizedUserId: USER_ID,
        userId: null,
        transactionId: 'txn_secure_checkout',
        subscriptionId: 'sub_secure_checkout'
      },
      error: null
    });

    await expect(consumeSubscriptionCheckoutAttempt(
      supabase,
      completedCheckout(),
      '2026-07-28T00:00:00.000Z',
      attempt
    )).resolves.toMatchObject({
      reason: 'payment_after_account_deleted',
      status: 'account_deleted_review',
      entitlementGranted: false,
      refundReviewRequired: true,
      authorizedUserId: USER_ID,
      userId: null
    });
    }
  );

  test('account-deleted bound completion requires exact transaction metadata and durable review incident', async () => {
    const attempt = checkoutAttempt({
      user_id: null,
      authorized_user_id: USER_ID,
      status: 'bound'
    });
    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout(),
      attempt
    )).toMatchObject({ valid: true });
    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout({ custom_data: undefined }),
      attempt
    )).toMatchObject({
      valid: false,
      reason: 'recovery_metadata_required'
    });

    const rpcOutcome = {
      applied: true,
      reason: 'payment_after_account_deleted',
      status: 'account_deleted_review',
      entitlementGranted: false,
      refundReviewRequired: true,
      withheldReason: 'payment_after_account_deleted',
      authorizedUserId: USER_ID,
      userId: null,
      transactionId: 'txn_secure_checkout',
      subscriptionId: 'sub_secure_checkout'
    };
    const supabase = makeQueryClient(async () => {
      throw new Error('Unexpected lookup');
    }, { data: rpcOutcome, error: null });
    const result = await consumeSubscriptionCheckoutAttempt(
      supabase,
      completedCheckout(),
      '2026-07-28T00:00:00.000Z',
      attempt
    );
    const incidentReporter = jest.fn().mockResolvedValue({ persisted: true });

    await expect(reportDeletedAccountSubscriptionCheckoutPayment(
      result,
      completedCheckout(),
      { incidentReporter }
    )).resolves.toEqual({ persisted: true });
    expect(incidentReporter).toHaveBeenCalledWith(expect.objectContaining({
      eventCode:
        'SUBSCRIPTION_CHECKOUT_ACCOUNT_DELETED_PAYMENT_REFUND_REVIEW_REQUIRED',
      context: expect.objectContaining({
        authorizedUserId: USER_ID,
        userId: null,
        entitlementGranted: false,
        refundReviewRequired: true
      })
    }));
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  test('account-deleted exact replay is accepted only through its bound transaction and metadata', () => {
    const attempt = checkoutAttempt({
      user_id: null,
      authorized_user_id: USER_ID,
      status: 'account_deleted_review'
    });

    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout(),
      attempt
    )).toMatchObject({ valid: true });
    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout({ custom_data: undefined }),
      attempt
    )).toMatchObject({
      valid: false,
      reason: 'recovery_metadata_required'
    });
    expect(validateCompletedSubscriptionCheckoutTransaction(
      completedCheckout(),
      { ...attempt, transaction_id: 'txn_other' }
    )).toMatchObject({
      valid: false,
      reason: 'invalid_server_attempt'
    });
  });

  test('completed-before-deletion semantic replay is acknowledged without new entitlement or refund review', async () => {
    const attempt = checkoutAttempt({
      user_id: null,
      authorized_user_id: USER_ID,
      status: 'completed',
      subscription_id: 'sub_secure_checkout',
      customer_id: 'ctm_secure_checkout'
    });
    const replayOutcome = {
      applied: false,
      reason: 'completed_before_account_deleted',
      status: 'completed',
      authorizedUserId: USER_ID,
      userId: null,
      transactionId: 'txn_secure_checkout',
      subscriptionId: 'sub_secure_checkout',
      entitlementGranted: false,
      refundReviewRequired: false
    };
    const supabase = makeQueryClient(async () => {
      throw new Error('Unexpected lookup');
    }, { data: replayOutcome, error: null });

    await expect(consumeSubscriptionCheckoutAttempt(
      supabase,
      completedCheckout(),
      '2026-07-28T00:00:00.000Z',
      attempt
    )).resolves.toMatchObject({
      ...replayOutcome,
      verifiedAttemptId: ATTEMPT_ID,
      verifiedPlan: 'pro'
    });
  });

  test('completed-before-deletion replay rejects any refund-review mutation', async () => {
    const attempt = checkoutAttempt({
      user_id: null,
      authorized_user_id: USER_ID,
      status: 'completed'
    });
    const supabase = makeQueryClient(async () => {
      throw new Error('Unexpected lookup');
    }, {
      data: {
        applied: false,
        reason: 'completed_before_account_deleted',
        status: 'completed',
        authorizedUserId: USER_ID,
        userId: null,
        transactionId: 'txn_secure_checkout',
        subscriptionId: 'sub_secure_checkout',
        entitlementGranted: false,
        refundReviewRequired: true
      },
      error: null
    });

    await expect(consumeSubscriptionCheckoutAttempt(
      supabase,
      completedCheckout(),
      '2026-07-28T00:00:00.000Z',
      attempt
    )).rejects.toThrow(
      'consume_subscription_checkout_attempt returned an invalid outcome'
    );
  });

  test('account-deleted payment requires a durable dedicated refund-review incident', async () => {
    const result = {
      applied: false,
      reason: 'payment_after_account_deleted',
      status: 'account_deleted_review',
      entitlementGranted: false,
      refundReviewRequired: true,
      withheldReason: 'payment_after_account_deleted',
      authorizedUserId: USER_ID,
      userId: null,
      transactionId: 'txn_secure_checkout',
      subscriptionId: 'sub_secure_checkout',
      verifiedAttemptId: ATTEMPT_ID,
      verifiedPlan: 'pro'
    };
    const persistedReporter = jest.fn().mockResolvedValue({ persisted: true });

    await expect(reportDeletedAccountSubscriptionCheckoutPayment(
      result,
      completedCheckout(),
      { incidentReporter: persistedReporter }
    )).resolves.toEqual({ persisted: true });
    expect(persistedReporter).toHaveBeenCalledWith(expect.objectContaining({
      eventCode:
        'SUBSCRIPTION_CHECKOUT_ACCOUNT_DELETED_PAYMENT_REFUND_REVIEW_REQUIRED',
      context: expect.objectContaining({
        authorizedUserId: USER_ID,
        userId: null,
        entitlementGranted: false,
        refundReviewRequired: true
      })
    }));

    await expect(reportDeletedAccountSubscriptionCheckoutPayment(
      result,
      completedCheckout(),
      {
        incidentReporter: jest.fn().mockResolvedValue({ persisted: false })
      }
    )).rejects.toMatchObject({
      code: 'SUBSCRIPTION_CHECKOUT_ACCOUNT_DELETED_INCIDENT_PERSIST_FAILED'
    });
  });
});

describe('signed subscription checkout incident durability', () => {
  const webhookSecret = 'subscription-checkout-retry-secret';
  const originalEnvironment = {
    OPS_ALERT_WEBHOOK_URL: process.env.OPS_ALERT_WEBHOOK_URL,
    PADDLE_WEBHOOK_SECRET: process.env.PADDLE_WEBHOOK_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL
  };

  beforeEach(() => {
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    process.env.PADDLE_WEBHOOK_SECRET = webhookSecret;
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    mockCreateClient.mockReset();
  });

  afterEach(() => {
    _setAdminClientForTests(null);
  });

  afterAll(() => {
    Object.entries(originalEnvironment).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  test.each([
    {
      label: 'late reconciled payment',
      initialAttempt: checkoutAttempt({
        transaction_id: null,
        status: 'reconciled_no_match'
      }),
      replayAttempt: checkoutAttempt({
        status: 'reconciled_no_match',
        subscription_id: 'sub_secure_checkout',
        customer_id: 'ctm_secure_checkout'
      }),
      reason: 'late_payment_after_reconciled_no_match',
      terminalStatus: 'reconciled_no_match',
      withheldReason: 'late_payment_after_reconciled_no_match',
      incidentCode: 'SUBSCRIPTION_CHECKOUT_LATE_PAYMENT_REFUND_REVIEW_REQUIRED',
      userId: USER_ID
    },
    {
      label: 'account-deleted payment',
      initialAttempt: checkoutAttempt({
        user_id: null,
        transaction_id: null,
        status: 'charging'
      }),
      replayAttempt: checkoutAttempt({
        user_id: null,
        status: 'account_deleted_review',
        subscription_id: 'sub_secure_checkout',
        customer_id: 'ctm_secure_checkout'
      }),
      reason: 'payment_after_account_deleted',
      terminalStatus: 'account_deleted_review',
      withheldReason: 'payment_after_account_deleted',
      incidentCode:
        'SUBSCRIPTION_CHECKOUT_ACCOUNT_DELETED_PAYMENT_REFUND_REVIEW_REQUIRED',
      userId: null
    }
  ])(
    '$label signed duplicate retries incident persistence before ACK',
    async ({
      initialAttempt,
      replayAttempt,
      reason,
      terminalStatus,
      withheldReason,
      incidentCode,
      userId
    }) => {
      let consumeCalls = 0;
      let dedicatedIncidentCalls = 0;
      const outcomes = [true, false].map(applied => ({
        applied,
        reason,
        status: terminalStatus,
        entitlementGranted: false,
        refundReviewRequired: true,
        withheldReason,
        authorizedUserId: USER_ID,
        userId,
        transactionId: 'txn_secure_checkout',
        subscriptionId: 'sub_secure_checkout'
      }));
      const adminClient = {
        from: jest.fn(table => {
          const filters = {};
          const builder = {
            select: jest.fn(() => builder),
            eq: jest.fn((column, value) => {
              filters[column] = value;
              return builder;
            }),
            in: jest.fn((column, values) => {
              filters[column] = values;
              return builder;
            }),
            maybeSingle: jest.fn(async () => {
              expect(table).toBe('subscription_checkout_attempts');
              if (filters.transaction_id) {
                return {
                  data: consumeCalls === 0 ? null : replayAttempt,
                  error: null
                };
              }
              expect(filters).toMatchObject({
                attempt_id: ATTEMPT_ID,
                status: ['charging', 'provider_unknown', 'reconciled_no_match']
              });
              return { data: initialAttempt, error: null };
            })
          };
          return builder;
        }),
        rpc: jest.fn(async (name, params) => {
          if (name === 'claim_paddle_webhook_event') {
            return { data: { outcome: 'claimed' }, error: null };
          }
          if (name === 'claim_paddle_event_order') {
            return { data: { outcome: 'claimed' }, error: null };
          }
          if (name === 'consume_subscription_checkout_attempt') {
            const outcome = outcomes[consumeCalls];
            consumeCalls += 1;
            return { data: outcome, error: null };
          }
          if (name === 'record_ops_incident') {
            if (params.p_event_code === incidentCode) {
              dedicatedIncidentCalls += 1;
              if (dedicatedIncidentCalls === 1) {
                return {
                  data: null,
                  error: { message: 'simulated incident persistence failure' }
                };
              }
            }
            return {
              data: { id: 'incident_1', occurrenceCount: 1 },
              error: null
            };
          }
          if (
            name === 'fail_paddle_event_order'
            || name === 'fail_paddle_webhook_event'
            || name === 'complete_paddle_event_order'
            || name === 'complete_paddle_webhook_event'
          ) {
            return { data: true, error: null };
          }
          throw new Error(`Unexpected RPC: ${name}`);
        })
      };
      mockCreateClient.mockReturnValue(adminClient);
      _setAdminClientForTests(adminClient);

      const payload = {
        notification_id: `ntf_${terminalStatus}_incident_retry`,
        event_id: `evt_${terminalStatus}_incident_retry`,
        event_type: 'transaction.completed',
        occurred_at: new Date().toISOString(),
        data: completedCheckout()
      };
      const rawBody = JSON.stringify(payload);
      const signature = buildSignatureHeader(
        webhookSecret,
        rawBody,
        Math.floor(Date.now() / 1000)
      );
      const server = await startWebhookServer();

      try {
        const first = await postSignedWebhook(server, rawBody, signature);
        expect(first).toEqual({ statusCode: 500, body: 'Internal error' });
        const firstRpcNames = adminClient.rpc.mock.calls.map(([name]) => name);
        expect(firstRpcNames).toContain('fail_paddle_event_order');
        expect(firstRpcNames).toContain('fail_paddle_webhook_event');
        expect(firstRpcNames).not.toContain('complete_paddle_event_order');
        expect(firstRpcNames).not.toContain('complete_paddle_webhook_event');

        const replay = await postSignedWebhook(server, rawBody, signature);
        expect(replay).toEqual({ statusCode: 200, body: 'OK' });
      } finally {
        await stopWebhookServer(server);
      }

      const dedicatedIncidents = adminClient.rpc.mock.calls.filter(
        ([name, params]) =>
          name === 'record_ops_incident' && params.p_event_code === incidentCode
      );
      expect(dedicatedIncidents).toHaveLength(2);
      expect(consumeCalls).toBe(2);
      expect(adminClient.rpc).toHaveBeenCalledWith(
        'complete_paddle_event_order',
        expect.any(Object)
      );
      expect(adminClient.rpc).toHaveBeenCalledWith(
        'complete_paddle_webhook_event',
        expect.objectContaining({ p_event_id: payload.notification_id })
      );
    }
  );
});

describe('origin-first completed transaction routing', () => {
  test('inherited initial metadata on a renewal never re-enters initial validation', () => {
    expect(classifyCompletedTransactionRoute(completedCheckout({
      origin: 'subscription_recurring'
    }), {
      hasCheckoutAttempt: false,
      env: ENV
    })).toBe('subscription_recurring');
  });

  test('inherited stale targetPlan on a plan update never re-enters initial validation', () => {
    expect(classifyCompletedTransactionRoute(completedCheckout({
      origin: 'subscription_update',
      custom_data: {
        promptgenKind: 'subscription_checkout',
        promptgenCheckoutAttemptId: ATTEMPT_ID,
        promptgenTargetPlan: 'pro'
      },
      items: [{
        quantity: 1,
        price: {
          id: 'pri_enterprise',
          type: 'standard',
          unit_price: { amount: '1999', currency_code: 'USD' },
          billing_cycle: { interval: 'month', frequency: 1 }
        }
      }]
    }), {
      hasCheckoutAttempt: false,
      env: ENV
    })).toBe('subscription_update');
  });

  test('API-origin known plan without metadata or a bound transaction is not ignored', () => {
    expect(classifyCompletedTransactionRoute(completedCheckout({
      custom_data: undefined
    }), {
      hasCheckoutAttempt: false,
      env: ENV
    })).toBe('invalid_promptgen_transaction');
  });

  test('unknown PromptGen credit-pack key is not ignored', () => {
    expect(classifyCompletedTransactionRoute({
      id: 'txn_unknown_pack',
      origin: 'subscription_charge',
      items: [{
        quantity: 1,
        price: {
          custom_data: {
            promptgenKind: 'credit_pack',
            promptgenPackKey: 'usage_unknown'
          }
        }
      }]
    }, { env: ENV })).toBe('invalid_promptgen_transaction');
  });
});

describe('subscription snapshot owner resolution', () => {
  function boundOwnerClient() {
    return makeQueryClient(async ({ table }) => {
      if (table === 'paddle_subscription_states') {
        return {
          data: {
            user_id: USER_ID,
            customer_id: 'ctm_secure_checkout'
          },
          error: null
        };
      }
      if (table === 'profiles') {
        return {
          data: {
            id: USER_ID,
            paddle_customer_id: 'ctm_secure_checkout',
            paddle_subscription_id: 'sub_secure_checkout'
          },
          error: null
        };
      }
      throw new Error('Unexpected table: ' + table);
    });
  }

  test('existing server state/profile binding wins over inherited stale metadata', async () => {
    const supabase = boundOwnerClient();
    const snapshot = {
      id: 'sub_secure_checkout',
      customer_id: 'ctm_secure_checkout',
      custom_data: {
        promptgenKind: 'subscription_checkout',
        promptgenCheckoutAttemptId: ATTEMPT_ID,
        promptgenTargetPlan: 'pro'
      },
      items: [{
        price: { id: 'pri_enterprise' }
      }]
    };

    await expect(resolveSubscriptionSnapshotOwner(
      supabase,
      snapshot,
      'enterprise'
    )).resolves.toBe(USER_ID);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('completed fallback attempt is found by subscription_id, not payload attemptId', async () => {
    const completedAttempt = checkoutAttempt({
      subscription_id: 'sub_secure_checkout',
      customer_id: 'ctm_secure_checkout',
      status: 'completed'
    });
    const supabase = makeQueryClient(async ({ table, filters, mode }) => {
      if (table === 'paddle_subscription_states') {
        return { data: null, error: { code: 'PGRST116' } };
      }
      if (table === 'subscription_checkout_attempts') {
        expect(mode).toBe('maybeSingle');
        expect(filters).toEqual({
          subscription_id: 'sub_secure_checkout',
          status: 'completed'
        });
        return { data: completedAttempt, error: null };
      }
      throw new Error('Unexpected table: ' + table);
    }, {
      data: { resolved: true, userId: USER_ID },
      error: null
    });
    const snapshot = {
      id: 'sub_secure_checkout',
      customer_id: 'ctm_secure_checkout',
      custom_data: {
        promptgenKind: 'subscription_checkout',
        promptgenCheckoutAttemptId:
          '423e4567-e89b-42d3-a456-426614174000',
        promptgenTargetPlan: 'enterprise'
      },
      items: [{ price: { id: 'pri_pro_1099' } }]
    };

    await expect(resolveSubscriptionSnapshotOwner(
      supabase,
      snapshot,
      'pro'
    )).resolves.toBe(USER_ID);
    expect(supabase.rpc).toHaveBeenCalledWith(
      'resolve_completed_subscription_checkout',
      {
        p_attempt_id: ATTEMPT_ID,
        p_subscription_id: 'sub_secure_checkout',
        p_customer_id: 'ctm_secure_checkout',
        p_plan: 'pro',
        p_price_id: 'pri_pro_1099'
      }
    );
  });

  test('recurring ownership resolves from state and profile bindings', async () => {
    const supabase = boundOwnerClient();

    await expect(resolveExistingSubscriptionOwner(supabase, {
      subscriptionId: 'sub_secure_checkout',
      customerId: 'ctm_secure_checkout'
    })).resolves.toBe(USER_ID);
  });

  test('historical subscription ownership still resolves after a safe profile rebind', async () => {
    const supabase = makeQueryClient(async ({ table }) => {
      if (table === 'paddle_subscription_states') {
        return {
          data: {
            user_id: USER_ID,
            customer_id: 'ctm_secure_checkout'
          },
          error: null
        };
      }
      if (table === 'profiles') {
        return {
          data: {
            id: USER_ID,
            paddle_customer_id: 'ctm_secure_checkout',
            paddle_subscription_id: 'sub_replacement'
          },
          error: null
        };
      }
      throw new Error('Unexpected table: ' + table);
    });

    await expect(resolveExistingSubscriptionOwner(supabase, {
      subscriptionId: 'sub_historical',
      customerId: 'ctm_secure_checkout'
    })).resolves.toBe(USER_ID);
  });
});
