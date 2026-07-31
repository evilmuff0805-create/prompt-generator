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
  parsePaddleOccurredAt,
  validateCompletedCreditPackTransaction,
  buildCreditPackHistoryUrl,
  verifyCreditPackSubscriptionHistory,
  classifyCompletedTransactionRoute,
  reportUnboundSubscriptionCharge,
  grantCreditsForPack,
  applyCreditPackAdjustment,
  expireSubscription
} = require('../../routes/paddle');

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const ELIGIBILITY_CHECK_STARTED_AT = '2026-07-28T09:59:55.987654Z';
const AUTHORIZED_AT = '2026-07-28T10:00:00.000000Z';
const AUTHORIZATION_EXPIRES_AT = '2026-07-28T10:15:00.000000Z';
const COMPLETED_AT = '2026-07-28T10:10:00.123456Z';
const TRANSACTION_CREATED_AT = '2026-07-28T09:59:58.000001Z';
const CAPTURED_AT = '2026-07-28T10:09:59.999999Z';
const PROVIDER_EVENT_ID = 'evt_credit_pack_completed_1';
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
    status: 'completed',
    collection_mode: 'automatic',
    currency_code: 'USD',
    created_at: TRANSACTION_CREATED_AT,
    payments: [{
      status: 'captured',
      captured_at: CAPTURED_AT,
      amount: '1100'
    }],
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
    details: {
      totals: {
        subtotal: '1000',
        discount: '0',
        tax: '100',
        total: '1100',
        credit: '0',
        balance: '0',
        grand_total: '1100',
        grand_total_tax: '100',
        currency_code: 'USD'
      },
      line_items: [{
        price_id: 'pri_custom_pack_600',
        product: { id: 'pro_custom_pack_600' },
        quantity: 1,
        totals: {
          subtotal: '1000',
          discount: '0',
          tax: '100',
          total: '1100'
        }
      }]
    },
    ...overrides
  };
}

function temporalContext(overrides = {}) {
  return {
    request_id: REQUEST_ID,
    customer_id: 'ctm_1',
    subscription_id: 'sub_1',
    eligibility_check_started_at: ELIGIBILITY_CHECK_STARTED_AT,
    authorized_at: AUTHORIZED_AT,
    authorization_expires_at: AUTHORIZATION_EXPIRES_AT,
    ...overrides
  };
}

function supabaseForGrant({
  rpcResult = {
    applied: true,
    status: 'completed',
    entitlementGranted: true,
    reason: 'purchase_applied',
    newBalance: 1200,
    userId: 'user_1'
  },
  rpcError = null,
  requestContext = temporalContext()
} = {}) {
  const maybeSingle = jest.fn().mockResolvedValue({
    data: requestContext,
    error: null
  });
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  const rpc = jest.fn().mockResolvedValue({
    data: rpcResult,
    error: rpcError
  });
  return {
    from,
    rpc,
    query: { select, eq, maybeSingle }
  };
}

function historyResponse({
  data = [],
  requestId = 'req_history_1',
  hasMore = false,
  next = ''
} = {}) {
  return {
    ok: true,
    json: jest.fn().mockResolvedValue({
      data,
      meta: {
        request_id: requestId,
        pagination: {
          has_more: hasMore,
          next
        }
      }
    })
  };
}

function safeHistoryEvent({
  id = 'hst_one_off_1',
  occurredAt = '2026-07-28T10:05:00.123456Z',
  transactionId = 'txn_pack_1'
} = {}) {
  return {
    id,
    subscription_id: 'sub_1',
    occurred_at: occurredAt,
    detail: {
      action: 'subscription_one_off_charge_applied',
      effective_from: 'immediately',
      transaction_id: transactionId
    }
  };
}

function historyNextUrl(
  after = 'cursor_2',
  historyStartAt = ELIGIBILITY_CHECK_STARTED_AT
) {
  const url = buildCreditPackHistoryUrl({
    apiBase: 'https://sandbox-api.paddle.com',
    subscriptionId: 'sub_1',
    authorizedAt: historyStartAt,
    completedAt: COMPLETED_AT
  });
  url.searchParams.set('after', after);
  return url.toString();
}

describe('strict Paddle timestamp parsing', () => {
  test('preserves provider fractional precision and explicit offsets', () => {
    expect(parsePaddleOccurredAt(' 2026-07-28T10:00:00.123456789Z '))
      .toBe('2026-07-28T10:00:00.123456789Z');
    expect(parsePaddleOccurredAt('2026-07-28T19:00:00.123456789+09:00'))
      .toBe('2026-07-28T19:00:00.123456789+09:00');
  });

  test.each([
    ['missing timezone', '2026-07-28T10:00:00.123456'],
    ['too much fractional precision', '2026-07-28T10:00:00.1234567890Z'],
    ['invalid calendar day', '2026-02-30T10:00:00Z'],
    ['leap second', '2026-07-28T10:00:60Z'],
    ['invalid offset', '2026-07-28T10:00:00+24:00'],
    ['non-RFC3339 value', 'July 28, 2026 10:00 UTC']
  ])('rejects %s', (_label, value) => {
    expect(parsePaddleOccurredAt(value)).toBeNull();
  });
});

describe('credit pack Subscription History proof', () => {
  const baseParams = {
    apiKey: 'pdl_sdbx_test_key',
    subscriptionId: 'sub_1',
    transactionId: 'txn_pack_1',
    historyStartAt: ELIGIBILITY_CHECK_STARTED_AT,
    authorizedAt: AUTHORIZED_AT,
    authorizationExpiresAt: AUTHORIZATION_EXPIRES_AT,
    completedAt: COMPLETED_AT,
    apiBase: 'https://sandbox-api.paddle.com'
  };

  test.each([
    [
      'provider eligibility check',
      ELIGIBILITY_CHECK_STARTED_AT,
      ELIGIBILITY_CHECK_STARTED_AT
    ],
    [
      'earlier DB authorization under clock skew',
      '2026-07-28T10:00:01.000001Z',
      AUTHORIZED_AT
    ]
  ])('starts history at the %s boundary', async (
    _label,
    historyStartAt,
    expectedStartAt
  ) => {
    const fetchImpl = jest.fn().mockResolvedValue(historyResponse({
      data: [safeHistoryEvent()]
    }));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      historyStartAt,
      fetchImpl
    })).resolves.toEqual({
      status: 'eligible',
      requestId: 'req_history_1',
      event: {
        id: 'hst_one_off_1',
        action: 'subscription_one_off_charge_applied',
        occurredAt: '2026-07-28T10:05:00.123456Z'
      }
    });

    const requestedUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(requestedUrl.searchParams.get('occurred_at[GTE]'))
      .toBe(expectedStartAt);
    expect(requestedUrl.searchParams.has('action')).toBe(false);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test('follows validated pagination and proves eligibility only after the last page', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(historyResponse({
        requestId: 'req_history_1',
        hasMore: true,
        next: historyNextUrl()
      }))
      .mockResolvedValueOnce(historyResponse({
        requestId: 'req_history_2',
        hasMore: false,
        next: '',
        data: [safeHistoryEvent()]
      }));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'eligible',
      requestId: 'req_history_1',
      event: {
        id: 'hst_one_off_1',
        action: 'subscription_one_off_charge_applied',
        occurredAt: '2026-07-28T10:05:00.123456Z'
      }
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(historyNextUrl());
  });

  test('returns the first disqualifying history event with full timestamp precision', async () => {
    const event = {
      id: 'hst_cancel_1',
      subscription_id: 'sub_1',
      occurred_at: '2026-07-28T10:05:00.123456Z',
      detail: { action: 'subscription_canceled' }
    };
    const fetchImpl = jest.fn().mockResolvedValue(historyResponse({
      data: [safeHistoryEvent(), event],
      requestId: 'req_history_disqualified'
    }));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'ineligible',
      requestId: 'req_history_disqualified',
      event: {
        id: 'hst_cancel_1',
        action: 'subscription_canceled',
        occurredAt: '2026-07-28T10:05:00.123456Z'
      }
    });
  });

  test('treats only this transaction immediate one-off charge action as safe', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(historyResponse({
      data: [safeHistoryEvent()],
      requestId: 'req_history_one_off'
    }));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'eligible',
      requestId: 'req_history_one_off',
      event: {
        id: 'hst_one_off_1',
        action: 'subscription_one_off_charge_applied',
        occurredAt: '2026-07-28T10:05:00.123456Z'
      }
    });
  });

  test('fails closed when history has no matching one-off proof', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(historyResponse());

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'ambiguous',
      requestId: 'req_history_1'
    });
  });

  test('fails closed when matching one-off proof is duplicated', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(historyResponse({
      data: [
        safeHistoryEvent(),
        safeHistoryEvent({ id: 'hst_one_off_2' })
      ]
    }));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'ambiguous',
      requestId: 'req_history_1'
    });
  });

  test.each([
    [
      'one nanosecond before the query start',
      '2026-07-28T09:59:55.987653999Z'
    ],
    [
      'one nanosecond after transaction completion',
      '2026-07-28T10:10:00.123456001Z'
    ]
  ])('fails closed when matching proof is %s', async (_label, occurredAt) => {
    const fetchImpl = jest.fn().mockResolvedValue(historyResponse({
      data: [safeHistoryEvent({ occurredAt })]
    }));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'ambiguous',
      requestId: 'req_history_1'
    });
  });

  test('fails closed when matching proof is one nanosecond before authorization', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(historyResponse({
      data: [safeHistoryEvent({
        occurredAt: '2026-07-28T09:59:59.999999999Z'
      })]
    }));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'ambiguous',
      requestId: 'req_history_1'
    });
  });

  test.each([
    ['a failed payment attempt', {
      action: 'subscription_payment_attempted',
      transaction_id: 'txn_failed'
    }],
    ['a different immediate one-off transaction', {
      action: 'subscription_one_off_charge_applied',
      effective_from: 'immediately',
      transaction_id: 'txn_other'
    }],
    ['a deferred one-off transaction', {
      action: 'subscription_one_off_charge_applied',
      effective_from: 'next_billing_period',
      transaction_id: 'txn_pack_1'
    }]
  ])('treats %s as ineligible', async (_label, detail) => {
    const fetchImpl = jest.fn().mockResolvedValue(historyResponse({
      data: [
        safeHistoryEvent(),
        {
          id: 'hst_ineligible_1',
          subscription_id: 'sub_1',
          occurred_at: '2026-07-28T10:05:00Z',
          detail
        }
      ]
    }));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'ineligible',
      requestId: 'req_history_1',
      event: {
        id: 'hst_ineligible_1',
        action: detail.action,
        occurredAt: '2026-07-28T10:05:00Z'
      }
    });
  });

  test('fails closed when a continuation URL changes the trusted request contract', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(historyResponse({
      requestId: 'req_history_1',
      hasMore: true,
      next:
        'https://attacker.example/subscriptions/sub_1/history?' +
        'after=cursor_2'
    }));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'ambiguous',
      requestId: 'req_history_1'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('fails closed when a later history page cannot be fetched', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(historyResponse({
        requestId: 'req_history_1',
        hasMore: true,
        next: historyNextUrl()
      }))
      .mockRejectedValueOnce(new Error('temporary Paddle outage'));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'unavailable',
      requestId: 'req_history_1'
    });
  });

  test.each([
    ['invalid event identity', {
      id: '',
      subscription_id: 'sub_1',
      occurred_at: '2026-07-28T10:05:00Z',
      detail: { action: 'subscription_canceled' }
    }],
    ['wrong subscription', {
      id: 'hst_wrong_subscription',
      subscription_id: 'sub_other',
      occurred_at: '2026-07-28T10:05:00Z',
      detail: { action: 'subscription_canceled' }
    }],
    ['unknown action', {
      id: 'hst_unknown_action',
      subscription_id: 'sub_1',
      occurred_at: '2026-07-28T10:05:00Z',
      detail: { action: 'subscription_mystery_state' }
    }],
    ['invalid occurred_at', {
      id: 'hst_invalid_timestamp',
      subscription_id: 'sub_1',
      occurred_at: '2026-07-28 10:05:00',
      detail: { action: 'subscription_paused' }
    }]
  ])('treats %s as ambiguous evidence', async (_label, event) => {
    const fetchImpl = jest.fn().mockResolvedValue(historyResponse({
      data: [event]
    }));

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      fetchImpl
    })).resolves.toEqual({
      status: 'ambiguous',
      requestId: 'req_history_1'
    });
  });

  test('does not query history for an expired completion boundary', async () => {
    const fetchImpl = jest.fn();

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      completedAt: AUTHORIZATION_EXPIRES_AT,
      fetchImpl
    })).resolves.toEqual({
      status: 'not_checked',
      requestId: null
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('returns unavailable when the history credential is absent', async () => {
    const fetchImpl = jest.fn();

    await expect(verifyCreditPackSubscriptionHistory({
      ...baseParams,
      apiKey: '',
      fetchImpl
    })).resolves.toEqual({
      status: 'unavailable',
      requestId: null
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('credit pack transaction.completed fulfillment', () => {
  beforeEach(() => {
    recordServerEvent.mockClear();
    reportIncident.mockClear();
  });

  test('routes a markerless subscription charge to fail-closed review', () => {
    const transaction = completedTransaction({
      items: [{
        quantity: 1,
        price: {
          id: 'pri_unbound_one_off',
          custom_data: null
        }
      }]
    });

    expect(classifyCompletedTransactionRoute(transaction))
      .toBe('unbound_subscription_charge');
  });

  test('preserves marked credit-pack and invalid subscription-marker routing', () => {
    expect(classifyCompletedTransactionRoute(completedTransaction()))
      .toBe('credit_pack');
    expect(classifyCompletedTransactionRoute(completedTransaction({
      custom_data: {
        promptgenKind: 'subscription_checkout',
        promptgenCheckoutAttemptId: 'attempt_1'
      },
      items: [{
        quantity: 1,
        price: {
          id: 'pri_unbound_one_off',
          custom_data: null
        }
      }]
    }))).toBe('invalid_promptgen_transaction');
  });

  test('persists a minimal critical incident before acknowledging an unbound charge', async () => {
    const transaction = completedTransaction({
      custom_data: { privatePayload: 'must-not-be-copied' },
      items: [
        { price: { id: 'pri_unbound_1', custom_data: null } },
        { price: { id: 'pri_unbound_2', custom_data: null } }
      ]
    });

    await expect(reportUnboundSubscriptionCharge(transaction, {
      requestId: 'http_req_1',
      eventId: 'ntf_1',
      providerEventId: 'evt_1'
    })).resolves.toBeUndefined();

    expect(reportIncident).toHaveBeenCalledTimes(1);
    expect(reportIncident).toHaveBeenCalledWith({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'UNBOUND_SUBSCRIPTION_CHARGE',
      message: 'A markerless subscription charge was withheld for manual review',
      fingerprint: 'paddle-webhook:UNBOUND_SUBSCRIPTION_CHARGE:txn_pack_1',
      context: {
        requestId: 'http_req_1',
        eventId: 'ntf_1',
        providerEventId: 'evt_1',
        transactionId: 'txn_pack_1',
        customerId: 'ctm_1',
        subscriptionId: 'sub_1',
        origin: 'subscription_charge',
        itemCount: 2,
        entitlementGranted: false,
        purchaseReviewRequired: true
      }
    });
  });

  test('keeps the webhook retryable when the critical incident is not durable', async () => {
    const incidentReporter = jest.fn().mockResolvedValue({ persisted: false });

    await expect(reportUnboundSubscriptionCharge(completedTransaction(), {
      requestId: 'http_req_failed_incident',
      eventId: 'ntf_failed_incident',
      providerEventId: 'evt_failed_incident',
      incidentReporter
    })).rejects.toMatchObject({
      code: 'UNBOUND_SUBSCRIPTION_CHARGE_INCIDENT_PERSIST_FAILED'
    });

    expect(incidentReporter).toHaveBeenCalledTimes(1);
  });

  test('accepts only the linked subscription-charge custom item contract', () => {
    expect(validateCompletedCreditPackTransaction(completedTransaction(), PACK))
      .toEqual({
        valid: true,
        reason: 'verified',
        actualTotals: {
          subtotal: 1000,
          discount: 0,
          tax: 100,
          total: 1100,
          credit: 0,
          balance: 0,
          grandTotal: 1100,
          grandTotalTax: 100
        }
      });
  });

  test.each([
    ['missing transaction details', { details: null }],
    ['non-integer grand total', {
      details: {
        ...completedTransaction().details,
        totals: {
          ...completedTransaction().details.totals,
          grand_total: '11.00'
        }
      }
    }],
    ['grand total above the PostgreSQL integer boundary', {
      details: {
        ...completedTransaction().details,
        totals: {
          ...completedTransaction().details.totals,
          grand_total: '2147483648'
        }
      }
    }],
    ['internally inconsistent line total', {
      details: {
        ...completedTransaction().details,
        line_items: [{
          ...completedTransaction().details.line_items[0],
          totals: {
            ...completedTransaction().details.line_items[0].totals,
            tax: '99'
          }
        }]
      }
    }],
    ['captured amount does not equal grand total', {
      payments: [{
        status: 'captured',
        captured_at: CAPTURED_AT,
        amount: '1099'
      }]
    }]
  ])('keeps bound identity durable but marks %s for withholding', (_label, overrides) => {
    expect(validateCompletedCreditPackTransaction(
      completedTransaction(overrides),
      PACK
    )).toEqual({
      valid: true,
      reason: 'amount_contract_malformed',
      actualTotals: null
    });
  });

  test.each([
    ['non-completed status', { status: 'paid' }],
    ['manual collection', { collection_mode: 'manual' }],
    ['non-USD transaction', { currency_code: 'EUR' }],
    ['invalid transaction creation time', { created_at: '2026-07-28 10:00:00' }]
  ])('rejects %s before fulfillment', (_label, overrides) => {
    expect(validateCompletedCreditPackTransaction(completedTransaction(overrides), PACK))
      .toEqual({ valid: false, reason: 'invalid_transaction_state' });
  });

  test.each([
    ['missing captured payment', { payments: [] }],
    ['uncaptured payment', {
      payments: [{ status: 'authorized', captured_at: CAPTURED_AT }]
    }],
    ['invalid capture time', {
      payments: [{ status: 'captured', captured_at: 'not-a-timestamp' }]
    }],
    ['multiple captured payments', {
      payments: [
        { status: 'captured', captured_at: CAPTURED_AT },
        { status: 'captured', captured_at: '2026-07-28T10:10:00.000001Z' }
      ]
    }]
  ])('rejects %s as insufficient provider evidence', (_label, overrides) => {
    expect(validateCompletedCreditPackTransaction(completedTransaction(overrides), PACK))
      .toEqual({ valid: false, reason: 'invalid_payment_capture' });
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
    const supabase = supabaseForGrant();
    const transaction = completedTransaction();
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(historyResponse({
      requestId: 'req_history_grant',
      data: [safeHistoryEvent()]
    }));

    try {
      await grantCreditsForPack(
        supabase,
        transaction,
        PACK,
        {
          CREDIT_PACK_EXPIRY_DAYS: '365',
          PADDLE_API_KEY: 'pdl_sdbx_test_key',
          PADDLE_API_BASE: 'https://sandbox-api.paddle.com'
        },
        COMPLETED_AT,
        PROVIDER_EVENT_ID
      );
    } finally {
      global.fetch = originalFetch;
    }

    expect(supabase.from).toHaveBeenCalledWith('credit_pack_purchase_requests');
    expect(supabase.query.select).toHaveBeenCalledWith(
      'request_id, customer_id, subscription_id, authorized_at, ' +
      'authorization_expires_at, eligibility_check_started_at'
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
      p_actual_subtotal: 1000,
      p_actual_discount: 0,
      p_actual_tax: 100,
      p_actual_total: 1100,
      p_actual_credit: 0,
      p_actual_balance: 0,
      p_actual_grand_total: 1100,
      p_actual_grand_total_tax: 100,
      p_expiry_days: 365,
      p_purchased_at: COMPLETED_AT,
      p_provider_event_id: PROVIDER_EVENT_ID,
      p_transaction_created_at: TRANSACTION_CREATED_AT,
      p_captured_at: CAPTURED_AT,
      p_history_proof_status: 'eligible',
      p_history_api_request_id: 'req_history_grant',
      p_history_event_id: 'hst_one_off_1',
      p_history_event_action: 'subscription_one_off_charge_applied',
      p_history_event_occurred_at: '2026-07-28T10:05:00.123456Z'
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

  test('reports when an exact signed completion supersedes no-match reconciliation', async () => {
    const rpcResult = {
      applied: true,
      status: 'completed',
      entitlementGranted: true,
      reason: 'purchase_applied',
      reconciliationSuperseded: true,
      newBalance: 1200,
      userId: 'user_1'
    };
    const supabase = supabaseForGrant({ rpcResult });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(historyResponse({
      requestId: 'req_history_reconciliation_superseded',
      data: [safeHistoryEvent()]
    }));

    try {
      await expect(grantCreditsForPack(
        supabase,
        completedTransaction(),
        PACK,
        {
          CREDIT_PACK_EXPIRY_DAYS: '365',
          PADDLE_API_KEY: 'pdl_sdbx_test_key',
          PADDLE_API_BASE: 'https://sandbox-api.paddle.com'
        },
        COMPLETED_AT,
        PROVIDER_EVENT_ID
      )).resolves.toEqual(rpcResult);
    } finally {
      global.fetch = originalFetch;
    }

    expect(reportIncident).toHaveBeenCalledTimes(1);
    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      eventCode: 'CREDIT_PACK_RECONCILIATION_SUPERSEDED',
      fingerprint:
        'paddle-webhook:CREDIT_PACK_RECONCILIATION_SUPERSEDED:txn_pack_1',
      context: expect.objectContaining({
        transactionId: 'txn_pack_1',
        requestId: REQUEST_ID,
        providerEventId: PROVIDER_EVENT_ID,
        userId: 'user_1'
      })
    }));
    expect(recordServerEvent).toHaveBeenCalledTimes(1);
  });

  test('a duplicate recovered completion repeats only the idempotent incident report', async () => {
    const rpcResult = {
      applied: false,
      reason: 'duplicate',
      status: 'completed',
      entitlementGranted: true,
      reviewRequired: false,
      reconciliationSuperseded: true,
      userId: 'user_1'
    };
    const supabase = supabaseForGrant({ rpcResult });

    await expect(grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      {
        CREDIT_PACK_EXPIRY_DAYS: '365',
        PADDLE_API_KEY: ''
      },
      COMPLETED_AT,
      PROVIDER_EVENT_ID
    )).resolves.toEqual(rpcResult);

    expect(reportIncident).toHaveBeenCalledTimes(1);
    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'CREDIT_PACK_RECONCILIATION_SUPERSEDED',
      fingerprint:
        'paddle-webhook:CREDIT_PACK_RECONCILIATION_SUPERSEDED:txn_pack_1'
    }));
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  test('a recovered completion stays retryable until its incident is durable', async () => {
    const rpcResult = {
      applied: false,
      reason: 'duplicate',
      status: 'completed',
      entitlementGranted: true,
      reviewRequired: false,
      reconciliationSuperseded: true,
      userId: 'user_1'
    };
    const supabase = supabaseForGrant({ rpcResult });
    reportIncident.mockResolvedValueOnce({ persisted: false });

    await expect(grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      {
        CREDIT_PACK_EXPIRY_DAYS: '365',
        PADDLE_API_KEY: ''
      },
      COMPLETED_AT,
      PROVIDER_EVENT_ID
    )).rejects.toMatchObject({
      code: 'CREDIT_PACK_RECONCILIATION_INCIDENT_PERSIST_FAILED'
    });

    expect(reportIncident).toHaveBeenCalledTimes(1);
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  test('passes null actual totals so malformed signed amounts are durably withheld', async () => {
    const supabase = supabaseForGrant({
      rpcResult: {
        applied: false,
        reason: 'entitlement_withheld',
        status: 'withheld',
        entitlementGranted: false,
        reviewRequired: true,
        withheldReason: 'transaction_totals_mismatch',
        userId: 'user_1'
      }
    });

    await grantCreditsForPack(
      supabase,
      completedTransaction({ details: null }),
      PACK,
      {
        CREDIT_PACK_EXPIRY_DAYS: '365',
        PADDLE_API_KEY: ''
      },
      COMPLETED_AT,
      PROVIDER_EVENT_ID
    );

    expect(supabase.rpc).toHaveBeenCalledWith(
      'apply_credit_pack_subscription_charge',
      expect.objectContaining({
        p_actual_subtotal: null,
        p_actual_discount: null,
        p_actual_tax: null,
        p_actual_total: null,
        p_actual_credit: null,
        p_actual_balance: null,
        p_actual_grand_total: null,
        p_actual_grand_total_tax: null
      })
    );
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  test.each([
    'completed',
    'withheld',
    'refunded',
    'chargeback'
  ])('accepts a duplicate terminal %s outcome without side effects', async (status) => {
    const rpcResult = {
      applied: false,
      reason: 'duplicate',
      status,
      userId: 'user_1'
    };
    const supabase = supabaseForGrant({ rpcResult });

    await expect(grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      {
        CREDIT_PACK_EXPIRY_DAYS: '365',
        PADDLE_API_KEY: ''
      },
      COMPLETED_AT,
      PROVIDER_EVENT_ID
    )).resolves.toEqual(rpcResult);

    expect(recordServerEvent).not.toHaveBeenCalled();
    expect(reportIncident).not.toHaveBeenCalled();
  });

  test('accepts a full refund that terminalized payment before entitlement', async () => {
    const rpcResult = {
      applied: false,
      reason: 'payment_refunded_before_entitlement',
      status: 'refunded',
      entitlementGranted: false,
      reviewRequired: false,
      userId: 'user_1'
    };
    const supabase = supabaseForGrant({ rpcResult });

    await expect(grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      {
        CREDIT_PACK_EXPIRY_DAYS: '365',
        PADDLE_API_KEY: ''
      },
      COMPLETED_AT,
      PROVIDER_EVENT_ID
    )).resolves.toEqual(rpcResult);

    expect(recordServerEvent).not.toHaveBeenCalled();
    expect(reportIncident).not.toHaveBeenCalled();
  });

  test('accepts and reports a chargeback that terminalized payment before entitlement', async () => {
    const rpcResult = {
      applied: false,
      reason: 'payment_chargeback_before_entitlement',
      status: 'chargeback',
      entitlementGranted: false,
      reviewRequired: true,
      userId: 'user_1'
    };
    const supabase = supabaseForGrant({ rpcResult });

    await expect(grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      {
        CREDIT_PACK_EXPIRY_DAYS: '365',
        PADDLE_API_KEY: ''
      },
      COMPLETED_AT,
      PROVIDER_EVENT_ID
    )).resolves.toEqual(rpcResult);

    expect(recordServerEvent).not.toHaveBeenCalled();
    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'CREDIT_PACK_PAYMENT_CHARGEBACK',
      context: expect.objectContaining({
        transactionId: 'txn_pack_1',
        requestId: REQUEST_ID,
        providerEventId: PROVIDER_EVENT_ID,
        userId: 'user_1'
      })
    }));
  });

  test('records an ineligible Subscription History proof and reports withheld entitlement', async () => {
    const rpcResult = {
      applied: false,
      reason: 'entitlement_withheld',
      status: 'withheld',
      entitlementGranted: false,
      reviewRequired: true,
      withheldReason: 'subscription_history_ineligible',
      userId: 'user_1'
    };
    const supabase = supabaseForGrant({ rpcResult });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(historyResponse({
      requestId: 'req_history_withheld',
      data: [
        safeHistoryEvent(),
        {
          id: 'hst_pause_1',
          subscription_id: 'sub_1',
          occurred_at: '2026-07-28T10:05:00.654321Z',
          detail: { action: 'subscription_paused' }
        }
      ]
    }));

    try {
      await expect(grantCreditsForPack(
        supabase,
        completedTransaction(),
        PACK,
        {
          CREDIT_PACK_EXPIRY_DAYS: '365',
          PADDLE_API_KEY: 'pdl_sdbx_test_key',
          PADDLE_API_BASE: 'https://sandbox-api.paddle.com'
        },
        COMPLETED_AT,
        PROVIDER_EVENT_ID
      )).resolves.toEqual(rpcResult);
    } finally {
      global.fetch = originalFetch;
    }

    expect(supabase.rpc).toHaveBeenCalledWith(
      'apply_credit_pack_subscription_charge',
      expect.objectContaining({
        p_history_proof_status: 'ineligible',
        p_history_api_request_id: 'req_history_withheld',
        p_history_event_id: 'hst_pause_1',
        p_history_event_action: 'subscription_paused',
        p_history_event_occurred_at: '2026-07-28T10:05:00.654321Z'
      })
    );
    expect(recordServerEvent).not.toHaveBeenCalled();
    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'CREDIT_PACK_PURCHASE_WITHHELD',
      context: expect.objectContaining({
        transactionId: 'txn_pack_1',
        requestId: REQUEST_ID,
        providerEventId: PROVIDER_EVENT_ID,
        withheldReason: 'subscription_history_ineligible'
      })
    }));
  });

  test.each([
    {
      applied: false,
      reason: 'duplicate',
      status: 'provider_unknown'
    },
    {
      applied: false,
      reason: 'unexpected_database_outcome',
      status: 'withheld'
    },
    {
      applied: false,
      reason: 'entitlement_withheld',
      status: 'withheld',
      entitlementGranted: false,
      reviewRequired: false
    }
  ])('rejects unknown or internally inconsistent RPC outcome %#', async (rpcResult) => {
    const supabase = supabaseForGrant({ rpcResult });

    await expect(grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      {
        CREDIT_PACK_EXPIRY_DAYS: '365',
        PADDLE_API_KEY: ''
      },
      COMPLETED_AT,
      PROVIDER_EVENT_ID
    )).rejects.toThrow(
      'apply_credit_pack_subscription_charge returned an invalid outcome'
    );

    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  test('RPC failure remains retryable through the durable webhook inbox', async () => {
    const supabase = supabaseForGrant({
      rpcResult: null,
      rpcError: { message: 'temporary database failure' }
    });

    await expect(grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      {
        CREDIT_PACK_EXPIRY_DAYS: '365',
        PADDLE_API_KEY: ''
      },
      COMPLETED_AT,
      PROVIDER_EVENT_ID
    ))
      .rejects.toThrow('apply_credit_pack_subscription_charge RPC failed');
  });

  test('rejects a missing or invalid occurred_at before any ledger write', async () => {
    const supabase = supabaseForGrant();

    await expect(grantCreditsForPack(
      supabase,
      completedTransaction(),
      PACK,
      process.env,
      'not-a-timestamp',
      PROVIDER_EVENT_ID
    )).rejects.toThrow('missing a valid Paddle occurred_at');

    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['missing provider event ID', completedTransaction(), null],
    ['invalid transaction creation time', completedTransaction({
      created_at: '2026-07-28 09:59:58'
    }), PROVIDER_EVENT_ID],
    ['invalid captured payment time', completedTransaction({
      payments: [{ status: 'captured', captured_at: 'invalid' }]
    }), PROVIDER_EVENT_ID]
  ])('rejects %s before authorization lookup', async (
    _label,
    transaction,
    providerEventId
  ) => {
    const supabase = supabaseForGrant();

    await expect(grantCreditsForPack(
      supabase,
      transaction,
      PACK,
      process.env,
      COMPLETED_AT,
      providerEventId
    )).rejects.toThrow('missing valid provider evidence');

    expect(supabase.from).not.toHaveBeenCalled();
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

    const result = await applyCreditPackAdjustment(
      supabase,
      {
        id: 'adj_1',
        transaction_id: 'txn_pack_1',
        action: 'refund',
        type: 'full',
        status: 'approved'
      },
      {
        providerEventId: 'evt_adjustment_1',
        occurredAt: '2026-07-28T11:00:00.123456Z'
      }
    );

    expect(result.matched).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('apply_credit_pack_adjustment_v2', {
      p_adjustment_id: 'adj_1',
      p_provider_event_id: 'evt_adjustment_1',
      p_transaction_id: 'txn_pack_1',
      p_action: 'refund',
      p_adjustment_type: 'full',
      p_status: 'approved',
      p_occurred_at: '2026-07-28T11:00:00.123456Z'
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

    await applyCreditPackAdjustment(
      supabase,
      {
        id: 'adj_review',
        transaction_id: 'txn_pack_1',
        action: 'refund',
        type: 'partial',
        status: 'approved'
      },
      {
        providerEventId: 'evt_adjustment_review',
        occurredAt: '2026-07-28T11:05:00.654321Z'
      }
    );

    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'CREDIT_PACK_ADJUSTMENT_REQUIRES_REVIEW',
      context: expect.objectContaining({
        adjustmentId: 'adj_review',
        unrecoveredCredits: 120
      })
    }));
  });

  test.each([
    ['missing provider event ID', {
      providerEventId: null,
      occurredAt: '2026-07-28T11:00:00.123456Z'
    }],
    ['invalid occurred_at', {
      providerEventId: 'evt_adjustment_invalid_time',
      occurredAt: '2026-07-28 11:00:00'
    }]
  ])('rejects %s before the adjustment RPC', async (_label, evidence) => {
    const supabase = { rpc: jest.fn() };

    await expect(applyCreditPackAdjustment(
      supabase,
      {
        id: 'adj_invalid_evidence',
        transaction_id: 'txn_pack_1',
        action: 'refund',
        type: 'full',
        status: 'approved'
      },
      evidence
    )).rejects.toThrow(
      'Credit-pack adjustment is missing valid provider evidence'
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('returns an unmatched v2 outcome without legacy side effects', async () => {
    const rpcResult = {
      matched: false,
      applied: false,
      reason: 'unknown_transaction'
    };
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: rpcResult,
        error: null
      })
    };

    await expect(applyCreditPackAdjustment(
      supabase,
      {
        id: 'adj_unknown',
        transaction_id: 'txn_unknown',
        action: 'refund',
        type: 'full',
        status: 'approved'
      },
      {
        providerEventId: 'evt_adjustment_unknown',
        occurredAt: '2026-07-28T11:10:00.000001Z'
      }
    )).resolves.toEqual(rpcResult);

    expect(reportIncident).not.toHaveBeenCalled();
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
