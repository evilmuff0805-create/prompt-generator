'use strict';

const {
  getSubscriptionCheckoutMetadata,
  validateCompletedSubscriptionCheckoutTransaction,
  consumeSubscriptionCheckoutAttempt,
  classifyCompletedTransactionRoute,
  resolveExistingSubscriptionOwner,
  resolveSubscriptionSnapshotOwner
} = require('../../routes/paddle');

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
