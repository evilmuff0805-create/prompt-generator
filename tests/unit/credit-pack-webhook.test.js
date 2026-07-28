'use strict';

jest.mock('../../lib/product-analytics', () => ({
  recordServerEvent: jest.fn().mockResolvedValue({ persisted: true })
}));
jest.mock('../../lib/incident-reporter', () => ({
  reportIncident: jest.fn().mockResolvedValue({ persisted: true })
}));

const { recordServerEvent } = require('../../lib/product-analytics');
const { reportIncident } = require('../../lib/incident-reporter');
const {
  validateCompletedCreditPackTransaction,
  grantCreditsForPack,
  applyCreditPackAdjustment,
  expireSubscription
} = require('../../routes/paddle');

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const PACK = {
  key: 'usage_600',
  credits: 600,
  priceUsd: 10,
  priceCents: 1000
};

function completedTransaction(overrides = {}) {
  return {
    id: 'txn_pack_1',
    origin: 'subscription_charge',
    customer_id: 'ctm_1',
    subscription_id: 'sub_1',
    items: [{
      quantity: 1,
      price: {
        id: 'pri_custom_pack_600',
        product_id: 'pro_custom_pack_600',
        type: 'custom',
        billing_cycle: null,
        name: '600 Credits - One-time',
        description:
          '600 PromptGen usage credits - $10.00 one-time - ' +
          'active paid subscription required - expires after 365 days - ' +
          'PromptGen use only - non-transferable - no cash value',
        unit_price: {
          amount: '1000',
          currency_code: 'USD'
        },
        custom_data: {
          promptgenKind: 'credit_pack',
          promptgenPackKey: 'usage_600',
          promptgenPurchaseRequestId: REQUEST_ID
        }
      }
    }],
    ...overrides
  };
}

describe('credit pack transaction.completed fulfillment', () => {
  beforeEach(() => {
    recordServerEvent.mockClear();
  });

  test('accepts only the linked subscription-charge custom item contract', () => {
    expect(validateCompletedCreditPackTransaction(completedTransaction(), PACK))
      .toEqual({ valid: true, reason: 'verified' });
  });

  test.each([
    ['browser-origin transaction', { origin: 'web' }, 'invalid_origin'],
    ['API-origin transaction', { origin: 'api' }, 'invalid_origin'],
    ['missing subscription identity', { subscription_id: null }, 'missing_identity'],
    ['wrong pack key', {
      items: [{
        ...completedTransaction().items[0],
        price: {
          ...completedTransaction().items[0].price,
          custom_data: {
            promptgenKind: 'credit_pack',
            promptgenPackKey: 'usage_3000',
            promptgenPurchaseRequestId: REQUEST_ID
          }
        }
      }]
    }, 'invalid_product_kind'],
    ['missing durable request ID', {
      items: [{
        ...completedTransaction().items[0],
        price: {
          ...completedTransaction().items[0].price,
          custom_data: {
            promptgenKind: 'credit_pack',
            promptgenPackKey: 'usage_600'
          }
        }
      }]
    }, 'missing_purchase_request'],
    ['malformed durable request ID', {
      items: [{
        ...completedTransaction().items[0],
        price: {
          ...completedTransaction().items[0].price,
          custom_data: {
            promptgenKind: 'credit_pack',
            promptgenPackKey: 'usage_600',
            promptgenPurchaseRequestId: 'attacker-controlled'
          }
        }
      }]
    }, 'missing_purchase_request'],
    ['multiple items', {
      items: [
        completedTransaction().items[0],
        completedTransaction().items[0]
      ]
    }, 'invalid_item_count'],
    ['wrong quantity', {
      items: [{
        ...completedTransaction().items[0],
        quantity: 2
      }]
    }, 'item_mismatch'],
    ['standard catalog price', {
      items: [{
        ...completedTransaction().items[0],
        price: {
          ...completedTransaction().items[0].price,
          type: 'standard'
        }
      }]
    }, 'item_mismatch'],
    ['missing custom product identity', {
      items: [{
        ...completedTransaction().items[0],
        price: {
          ...completedTransaction().items[0].price,
          product_id: null
        }
      }]
    }, 'item_mismatch'],
    ['recurring item', {
      items: [{
        quantity: 1,
        price: {
          ...completedTransaction().items[0].price,
          billing_cycle: { interval: 'month', frequency: 1 }
        }
      }]
    }, 'not_one_time'],
    ['amount mismatch', {
      items: [{
        quantity: 1,
        price: {
          ...completedTransaction().items[0].price,
          unit_price: { amount: '800', currency_code: 'USD' }
        }
      }]
    }, 'catalog_price_mismatch'],
    ['currency mismatch', {
      items: [{
        quantity: 1,
        price: {
          ...completedTransaction().items[0].price,
          unit_price: { amount: '1000', currency_code: 'EUR' }
        }
      }]
    }, 'catalog_price_mismatch'],
    ['receipt name mismatch', {
      items: [{
        quantity: 1,
        price: {
          ...completedTransaction().items[0].price,
          name: 'Generic credits'
        }
      }]
    }, 'catalog_price_mismatch'],
    ['receipt description mismatch', {
      items: [{
        quantity: 1,
        price: {
          ...completedTransaction().items[0].price,
          description: 'No expiry disclosure'
        }
      }]
    }, 'catalog_price_mismatch']
  ])('rejects %s', (_label, overrides, reason) => {
    expect(validateCompletedCreditPackTransaction(completedTransaction(overrides), PACK))
      .toEqual({ valid: false, reason });
  });

  test('delegates idempotent grant and lot creation to one service-role RPC', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          applied: true,
          reason: 'purchase_applied',
          newBalance: 1200,
          userId: 'user_1'
        },
        error: null
      })
    };
    const transaction = completedTransaction();

    await grantCreditsForPack(
      supabase,
      transaction,
      PACK,
      { CREDIT_PACK_EXPIRY_DAYS: '365' },
      '2026-07-28T10:00:00.000Z'
    );

    expect(supabase.rpc).toHaveBeenCalledWith('apply_credit_pack_subscription_charge', {
      p_request_id: REQUEST_ID,
      p_transaction_id: 'txn_pack_1',
      p_customer_id: 'ctm_1',
      p_subscription_id: 'sub_1',
      p_pack_key: 'usage_600',
      p_provider_price_id: 'pri_custom_pack_600',
      p_provider_product_id: 'pro_custom_pack_600',
      p_credits: 600,
      p_unit_amount: 1000,
      p_currency_code: 'USD',
      p_expiry_days: 365,
      p_purchased_at: '2026-07-28T10:00:00.000Z'
    });
    expect(recordServerEvent).toHaveBeenCalledWith({
      eventName: 'purchase_completed',
      userId: 'user_1',
      properties: {
        plan: 'credit_pack',
        creditsGranted: 600,
        transactionType: 'credit_pack'
      }
    });
  });

  test('duplicate webhook does not emit duplicate analytics', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: { applied: false, reason: 'duplicate', userId: 'user_1' },
        error: null
      })
    };

    await grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      process.env,
      '2026-07-28T10:00:00.000Z'
    );

    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  test('RPC failure remains retryable through the durable webhook inbox', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'temporary database failure' }
      })
    };

    await expect(grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      process.env,
      '2026-07-28T10:00:00.000Z'
    ))
      .rejects.toThrow('apply_credit_pack_subscription_charge RPC failed');
  });

  test('rejects a missing or invalid occurred_at before any ledger write', async () => {
    const supabase = { rpc: jest.fn() };

    await expect(grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      process.env,
      'not-a-timestamp'
    )).rejects.toThrow('missing a valid Paddle occurred_at');

    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('credit pack adjustment and subscription-expiry routing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CREDIT_LEDGER_V2_ENABLED: 'true',
      TEST_ACCOUNT_USER_IDS: ''
    };
    reportIncident.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('passes the complete adjustment identity to the atomic ledger RPC', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          matched: true,
          applied: true,
          reason: 'refunded',
          reviewRequired: false,
          newBalance: 600
        },
        error: null
      })
    };

    const result = await applyCreditPackAdjustment(supabase, {
      id: 'adj_1',
      transaction_id: 'txn_pack_1',
      action: 'refund',
      type: 'full',
      status: 'approved'
    });

    expect(result.matched).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('apply_credit_pack_adjustment', {
      p_adjustment_id: 'adj_1',
      p_transaction_id: 'txn_pack_1',
      p_action: 'refund',
      p_adjustment_type: 'full',
      p_status: 'approved'
    });
    expect(reportIncident).not.toHaveBeenCalled();
  });

  test('flags partial or already-spent pack refunds for manual reconciliation', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: {
          matched: true,
          applied: false,
          reason: 'partial_requires_review',
          reviewRequired: true,
          unrecoveredCredits: 120,
          userId: 'user_1'
        },
        error: null
      })
    };

    await applyCreditPackAdjustment(supabase, {
      id: 'adj_review',
      transaction_id: 'txn_pack_1',
      action: 'refund',
      type: 'partial',
      status: 'approved'
    });

    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'CREDIT_PACK_ADJUSTMENT_REQUIRES_REVIEW',
      context: expect.objectContaining({
        adjustmentId: 'adj_review',
        unrecoveredCredits: 120
      })
    }));
  });

  test('does not call the new RPC while the ledger feature is disabled', async () => {
    process.env.CREDIT_LEDGER_V2_ENABLED = 'false';
    const supabase = { rpc: jest.fn() };

    await expect(applyCreditPackAdjustment(supabase, {
      id: 'adj_1',
      transaction_id: 'txn_pack_1'
    })).resolves.toEqual({
      matched: false,
      applied: false,
      reason: 'ledger_disabled'
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('subscription cancellation expires only subscription lots through the ledger RPC', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: { applied: true, reason: 'subscription_expired', newBalance: 500 },
        error: null
      })
    };

    await expireSubscription(supabase, 'user_1');

    expect(supabase.rpc).toHaveBeenCalledWith('expire_subscription_credits', {
      p_user_id: 'user_1'
    });
  });
});
