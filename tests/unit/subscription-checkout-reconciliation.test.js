'use strict';

const {
  buildSubscriptionCheckoutTransactionListUrl,
  reconcileSubscriptionCheckout
} = require('../../lib/subscription-checkout-reconciliation');

const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ATTEMPT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRICE_ID = `pri_${'a'.repeat(26)}`;
const CUSTOMER_ID = `ctm_${'b'.repeat(26)}`;
const SUBSCRIPTION_ID = `sub_${'c'.repeat(26)}`;
const TXN_1 = `txn_${'d'.repeat(26)}`;
const TXN_2 = `txn_${'e'.repeat(26)}`;
const REQUEST_1 = '11111111-1111-4111-8111-111111111111';
const REQUEST_2 = '22222222-2222-4222-8222-222222222222';

function options(overrides = {}) {
  return {
    apiKey: 'pdl_live_apikey_test-only',
    apiBase: 'https://api.paddle.com',
    attemptId: ATTEMPT_ID,
    userId: USER_ID,
    targetPlan: 'pro',
    priceId: PRICE_ID,
    credits: 600,
    unitAmount: 1099,
    currencyCode: 'USD',
    expectedOrigin: 'api',
    expectedCustomerId: null,
    windowStartAt: '2026-07-01T00:00:00.000Z',
    windowEndAt: '2026-07-05T00:00:00.000Z',
    checkedAt: '2026-07-05T00:00:00.000Z',
    ...overrides
  };
}

function transaction(overrides = {}) {
  return {
    id: TXN_1,
    status: 'completed',
    origin: 'api',
    collection_mode: 'automatic',
    customer_id: CUSTOMER_ID,
    subscription_id: SUBSCRIPTION_ID,
    currency_code: 'USD',
    created_at: '2026-07-02T00:00:00.000Z',
    custom_data: {
      promptgenCheckoutAttemptId: ATTEMPT_ID,
      promptgenKind: 'subscription_checkout',
      promptgenTargetPlan: 'pro'
    },
    items: [{
      quantity: 1,
      price: {
        id: PRICE_ID,
        type: 'standard',
        unit_price: { amount: '1099', currency_code: 'USD' },
        billing_cycle: { interval: 'month', frequency: 1 }
      }
    }],
    ...overrides
  };
}

function response(data, {
  requestId = REQUEST_1,
  hasMore = false,
  next = ''
} = {}) {
  return {
    ok: true,
    json: jest.fn().mockResolvedValue({
      data,
      meta: {
        request_id: requestId,
        pagination: { per_page: 30, has_more: hasMore, next }
      }
    })
  };
}

describe('subscription checkout reconciliation scan', () => {
  test('scans the full created-at window without an unsafe customer filter', () => {
    const url = buildSubscriptionCheckoutTransactionListUrl(
      options(),
      'https://api.paddle.com'
    );

    expect(url.origin).toBe('https://api.paddle.com');
    expect(url.pathname).toBe('/transactions');
    expect(url.searchParams.get('created_at[GTE]')).toBe(
      '2026-07-01T00:00:00.000Z'
    );
    expect(url.searchParams.get('created_at[LTE]')).toBe(
      '2026-07-05T00:00:00.000Z'
    );
    expect(url.searchParams.get('origin')).toBe('api');
    expect(url.searchParams.has('customer_id')).toBe(false);
  });

  test('returns a completed exact metadata and amount contract as matched', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response([transaction()]));

    await expect(reconcileSubscriptionCheckout(options({ fetchImpl })))
      .resolves.toMatchObject({
        status: 'matched',
        reason: 'exact_attempt_transaction_found',
        transaction: {
          id: TXN_1,
          status: 'completed',
          customerId: CUSTOMER_ID,
          priceId: PRICE_ID
        },
        evidence: { scanComplete: true, pagesScanned: 1 }
      });
  });

  test('an exact marker on an intermediate transaction blocks no-match finalization', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response([
      transaction({ status: 'ready', subscription_id: null })
    ]));

    await expect(reconcileSubscriptionCheckout(options({ fetchImpl })))
      .resolves.toMatchObject({
        status: 'matched',
        transaction: { id: TXN_1, status: 'ready' }
      });
  });

  test('a different valid attempt ID on the same plan is unrelated rather than partial evidence', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response([
      transaction({
        custom_data: {
          promptgenCheckoutAttemptId: OTHER_ATTEMPT_ID,
          promptgenKind: 'subscription_checkout',
          promptgenTargetPlan: 'pro'
        }
      })
    ]));

    await expect(reconcileSubscriptionCheckout(options({ fetchImpl })))
      .resolves.toMatchObject({
        status: 'definitive_no_match',
        reason: 'complete_scan_no_match'
      });
  });

  test.each([null, 'not-a-valid-attempt-id'])(
    'a missing or invalid attempt ID (%s) with matching checkout marker remains partial',
    async (markerAttemptId) => {
      const fetchImpl = jest.fn().mockResolvedValue(response([
        transaction({
          custom_data: {
            ...(markerAttemptId === null ? {} : {
              promptgenCheckoutAttemptId: markerAttemptId
            }),
            promptgenKind: 'subscription_checkout',
            promptgenTargetPlan: 'pro'
          }
        })
      ]));

      await expect(reconcileSubscriptionCheckout(options({ fetchImpl })))
        .resolves.toMatchObject({
          status: 'ambiguous',
          reason: 'partial_evidence',
          partialEvidence: { reason: 'partial_attempt_marker' }
        });
    }
  );

  test.each([
    ['wrong customer', { customer_id: `ctm_${'z'.repeat(26)}` }, CUSTOMER_ID],
    ['wrong amount', {
      items: [{
        quantity: 1,
        price: {
          id: PRICE_ID,
          type: 'standard',
          unit_price: { amount: '1098', currency_code: 'USD' },
          billing_cycle: { interval: 'month', frequency: 1 }
        }
      }]
    }, null],
    ['extra metadata key', {
      custom_data: {
        promptgenCheckoutAttemptId: ATTEMPT_ID,
        promptgenKind: 'subscription_checkout',
        promptgenTargetPlan: 'pro',
        extra: 'unsafe'
      }
    }, null]
  ])('%s is partial evidence and never a definitive no-match', async (
    _label,
    transactionOverrides,
    expectedCustomerId
  ) => {
    const fetchImpl = jest.fn().mockResolvedValue(response([
      transaction(transactionOverrides)
    ]));

    await expect(reconcileSubscriptionCheckout(options({
      fetchImpl,
      expectedCustomerId
    }))).resolves.toMatchObject({
      status: 'ambiguous',
      reason: 'partial_evidence',
      evidence: { scanComplete: true }
    });
  });

  test('only a complete trusted multi-page scan can return definitive no-match', async () => {
    const firstUrl = buildSubscriptionCheckoutTransactionListUrl(
      options(),
      'https://api.paddle.com'
    );
    const next = new URL(firstUrl);
    next.searchParams.set('after', TXN_1);
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response([
        transaction({
          custom_data: null,
          origin: 'subscription_charge',
          items: [],
          subscription_id: null
        })
      ], { hasMore: true, next: next.toString() }))
      .mockResolvedValueOnce(response([
        transaction({
          id: TXN_2,
          custom_data: null,
          origin: 'subscription_charge',
          items: [],
          subscription_id: null
        })
      ], { requestId: REQUEST_2 }));

    await expect(reconcileSubscriptionCheckout(options({ fetchImpl })))
      .resolves.toMatchObject({
        status: 'definitive_no_match',
        reason: 'complete_scan_no_match',
        evidence: {
          scanComplete: true,
          pagesScanned: 2,
          transactionsScanned: 2,
          apiRequestIds: [REQUEST_1, REQUEST_2]
        }
      });
  });

  test('a valid next page beyond the configured cap fails closed', async () => {
    const firstUrl = buildSubscriptionCheckoutTransactionListUrl(
      options(),
      'https://api.paddle.com'
    );
    const next = new URL(firstUrl);
    next.searchParams.set('after', TXN_1);
    const fetchImpl = jest.fn().mockResolvedValue(response([
      transaction({
        custom_data: null,
        origin: 'subscription_charge',
        items: [],
        subscription_id: null
      })
    ], {
      hasMore: true,
      next: next.toString()
    }));

    await expect(reconcileSubscriptionCheckout(options({
      fetchImpl,
      maxPages: 1
    }))).resolves.toMatchObject({
      status: 'ambiguous',
      reason: 'pagination_incomplete'
    });
  });

  test('an untrusted next link fails closed', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response([transaction({
      custom_data: null,
      origin: 'subscription_charge',
      items: [],
      subscription_id: null
    })], {
      hasMore: true,
      next: 'https://evil.example/transactions?after=x'
    }));

    await expect(reconcileSubscriptionCheckout(options({ fetchImpl })))
      .resolves.toMatchObject({
        status: 'ambiguous',
        reason: 'untrusted_pagination_url'
      });
  });
});
