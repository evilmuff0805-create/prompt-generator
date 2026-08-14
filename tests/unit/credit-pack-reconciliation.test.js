'use strict';

const {
  reconcileCreditPackPurchase
} = require('../../lib/credit-pack-reconciliation');

const TRANSACTION_ID = 'txn_01h04vsbhqc62t8hmd4z3b578c';
const OTHER_TRANSACTION_ID = 'txn_01h04vsbhqc62t8hmd4z3b578d';
const THIRD_TRANSACTION_ID = 'txn_01h04vsbhqc62t8hmd4z3b578e';
const SUBSCRIPTION_ID = 'sub_01h04vsc0qhwtsbsxh3422wjs4';
const OTHER_SUBSCRIPTION_ID = 'sub_01h04vsc0qhwtsbsxh3422wjs5';
const CUSTOMER_ID = 'ctm_01grnn4zta5a1mf02jjze7y2ys';
const OTHER_CUSTOMER_ID = 'ctm_01grnn4zta5a1mf02jjze7y2yt';
const PRICE_ID = 'pri_01gsz8z1q1n00f12qt82y31smh';
const PRODUCT_ID = 'pro_01gsz97mq9pa4fkyy0wqenepkz';
const PROVIDER_REQUEST_ID_1 = '11111111-1111-4111-8111-111111111111';
const PROVIDER_REQUEST_ID_2 = '22222222-2222-4222-8222-222222222222';

const EXPECTED = Object.freeze({
  apiKey: 'pdl_test_key',
  apiBase: 'https://paddle.test',
  purchaseRequestId: '123e4567-e89b-42d3-a456-426614174000',
  subscriptionId: SUBSCRIPTION_ID,
  customerId: CUSTOMER_ID,
  packKey: 'credits_600',
  currencyCode: 'USD',
  unitAmount: 1000,
  subtotal: 1000,
  discount: 100,
  tax: 90,
  total: 990,
  credit: 50,
  balance: 940,
  grandTotal: 940,
  grandTotalTax: 85,
  windowStartAt: '2026-07-01T00:00:00.000000Z',
  windowEndAt: '2026-07-03T00:00:00.000000Z',
  checkedAt: '2026-07-03T00:00:00.000000Z'
});

function marker(overrides = {}) {
  return {
    promptgenKind: 'credit_pack',
    promptgenPackKey: EXPECTED.packKey,
    promptgenPurchaseRequestId: EXPECTED.purchaseRequestId,
    ...overrides
  };
}

function transaction(overrides = {}) {
  const base = {
    id: TRANSACTION_ID,
    status: 'completed',
    customer_id: EXPECTED.customerId,
    custom_data: null,
    currency_code: EXPECTED.currencyCode,
    origin: 'subscription_charge',
    subscription_id: EXPECTED.subscriptionId,
    collection_mode: 'automatic',
    created_at: '2026-07-01T12:00:00.123456Z',
    items: [{
      quantity: 1,
      price: {
        id: PRICE_ID,
        product_id: PRODUCT_ID,
        type: 'custom',
        billing_cycle: null,
        unit_price: {
          amount: '1000',
          currency_code: EXPECTED.currencyCode
        },
        custom_data: marker()
      }
    }],
    details: {
      totals: {
        subtotal: '1000',
        discount: '100',
        tax: '90',
        total: '990',
        credit: '50',
        balance: '0',
        grand_total: '940',
        grand_total_tax: '85',
        currency_code: EXPECTED.currencyCode
      },
      line_items: [{
        price_id: PRICE_ID,
        product: { id: PRODUCT_ID },
        quantity: 1,
        totals: {
          subtotal: '1000',
          discount: '100',
          tax: '90',
          total: '990'
        }
      }]
    }
  };
  return {
    ...base,
    ...overrides
  };
}

function unrelatedTransaction(overrides = {}) {
  const base = transaction({
    id: OTHER_TRANSACTION_ID,
    customer_id: OTHER_CUSTOMER_ID,
    subscription_id: OTHER_SUBSCRIPTION_ID
  });
  base.items[0].price.custom_data = marker({
    promptgenPurchaseRequestId:
      '223e4567-e89b-42d3-a456-426614174001'
  });
  return {
    ...base,
    ...overrides
  };
}

function page(data, options = {}) {
  return {
    data,
    meta: {
      request_id: options.requestId || PROVIDER_REQUEST_ID_1,
      pagination: {
        per_page: 30,
        has_more: options.hasMore ?? false,
        next: options.next || ''
      }
    }
  };
}

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: jest.fn().mockResolvedValue(body)
  };
}

function makeFetch(...responses) {
  const fetchImpl = jest.fn();
  for (const response of responses) {
    fetchImpl.mockResolvedValueOnce(response);
  }
  return fetchImpl;
}

function nextUrl(after) {
  const url = new URL('/transactions', EXPECTED.apiBase);
  url.searchParams.set('created_at[GTE]', EXPECTED.windowStartAt);
  url.searchParams.set('created_at[LTE]', EXPECTED.windowEndAt);
  url.searchParams.set('per_page', '30');
  url.searchParams.set('order_by', 'id[DESC]');
  url.searchParams.set('after', after);
  return url.toString();
}

function generatedTransactionId(index) {
  return `txn_${index.toString(36).padStart(26, '0')}`;
}

function generatedProviderRequestId(index) {
  const uniquePrefix = (index + 1).toString(16).padStart(8, '0');
  return `${uniquePrefix}-0000-4000-8000-000000000000`;
}

function mutateExactTransaction(mutator) {
  const candidate = transaction();
  mutator(candidate);
  return candidate;
}

describe('credit-pack reconciliation', () => {
  test('returns matched only after an exact transaction and complete scan', async () => {
    const fetchImpl = makeFetch(jsonResponse(page([transaction()])));

    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl
    });

    expect(result).toMatchObject({
      status: 'matched',
      reason: 'exact_match',
      transaction: {
        id: TRANSACTION_ID,
        status: 'completed',
        purchaseRequestId: EXPECTED.purchaseRequestId,
        packKey: EXPECTED.packKey,
        unitAmount: '1000',
        grandTotal: '940'
      },
      evidence: {
        scanComplete: true,
        purchaseRequestId: EXPECTED.purchaseRequestId,
        subscriptionId: SUBSCRIPTION_ID,
        customerId: CUSTOMER_ID,
        packKey: EXPECTED.packKey,
        currencyCode: 'USD',
        unitAmount: '1000',
        subtotal: '1000',
        discount: '100',
        tax: '90',
        total: '990',
        credit: '50',
        balance: '940',
        grandTotal: '940',
        grandTotalTax: '85',
        windowStartAt: EXPECTED.windowStartAt,
        windowEndAt: EXPECTED.windowEndAt,
        checkedAt: EXPECTED.checkedAt,
        pagesScanned: 1,
        transactionsScanned: 1,
        apiRequestIds: [PROVIDER_REQUEST_ID_1]
      }
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.apiRequestIds)).toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin).toBe(EXPECTED.apiBase);
    expect(parsed.pathname).toBe('/transactions');
    expect(parsed.searchParams.get('subscription_id')).toBeNull();
    expect(parsed.searchParams.get('customer_id')).toBeNull();
    expect(parsed.searchParams.get('origin')).toBeNull();
    expect(parsed.searchParams.get('created_at[GTE]'))
      .toBe(EXPECTED.windowStartAt);
    expect(parsed.searchParams.get('created_at[LTE]'))
      .toBe(EXPECTED.windowEndAt);
    expect(parsed.searchParams.get('per_page')).toBe('30');
    expect(parsed.searchParams.get('order_by')).toBe('id[DESC]');
    expect(init).toEqual(expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      headers: expect.objectContaining({
        Authorization: `Bearer ${EXPECTED.apiKey}`,
        'Skip-Count': 'true'
      })
    }));
  });

  test('proves no match only after every trusted broad-scan page', async () => {
    const firstNext = nextUrl(OTHER_TRANSACTION_ID);
    const fetchImpl = makeFetch(
      jsonResponse(page([unrelatedTransaction()], {
        hasMore: true,
        next: firstNext
      })),
      jsonResponse(page([], {
        requestId: PROVIDER_REQUEST_ID_2
      }))
    );

    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl
    });

    expect(result).toEqual({
      status: 'definitive_no_match',
      reason: 'complete_scan_no_match',
      evidence: {
        scanComplete: true,
        purchaseRequestId: EXPECTED.purchaseRequestId,
        subscriptionId: SUBSCRIPTION_ID,
        customerId: CUSTOMER_ID,
        packKey: EXPECTED.packKey,
        currencyCode: 'USD',
        unitAmount: '1000',
        subtotal: '1000',
        discount: '100',
        tax: '90',
        total: '990',
        credit: '50',
        balance: '940',
        grandTotal: '940',
        grandTotalTax: '85',
        windowStartAt: EXPECTED.windowStartAt,
        windowEndAt: EXPECTED.windowEndAt,
        checkedAt: EXPECTED.checkedAt,
        pagesScanned: 2,
        transactionsScanned: 1,
        apiRequestIds: [
          PROVIDER_REQUEST_ID_1,
          PROVIDER_REQUEST_ID_2
        ]
      }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(firstNext);
  });

  test('exact request marker with wrong identity remains ambiguous', async () => {
    const wrongIdentity = transaction({
      customer_id: OTHER_CUSTOMER_ID,
      subscription_id: OTHER_SUBSCRIPTION_ID
    });
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl: makeFetch(jsonResponse(page([wrongIdentity])))
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'partial_evidence',
      partialEvidence: {
        transactionId: TRANSACTION_ID,
        reason: 'identity_contract_mismatch'
      },
      evidence: {
        scanComplete: true,
        pagesScanned: 1,
        transactionsScanned: 1
      }
    });
  });

  test.each([
    ['request ID', { purchaseRequestId: 'not-a-uuid' }],
    ['subscription ID', { subscriptionId: 'sub_fake' }],
    ['customer ID', { customerId: 'ctm_fake' }],
    ['amount', { unitAmount: '-1' }],
    ['currency', { currencyCode: 'usd' }],
    ['inconsistent subtotal', { subtotal: 999 }],
    ['inconsistent total', { total: 989 }],
    ['inconsistent grand total', { grandTotal: 939 }],
    ['inconsistent approved balance', { balance: 939 }],
    ['excess grand total tax', { grandTotalTax: 91 }],
    ['time window', {
      windowStartAt: '2026-07-04T00:00:00Z'
    }],
    ['checked-at boundary', {
      checkedAt: '2026-07-03T00:00:00.000001Z'
    }]
  ])('invalid expected %s fails closed before provider access', async (
    _,
    override
  ) => {
    const fetchImpl = jest.fn();
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      ...override,
      fetchImpl
    });

    expect(result).toEqual({
      status: 'ambiguous',
      reason: 'invalid_expected_contract',
      evidence: null
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ['network error', () => Promise.reject(new Error('offline')),
      'provider_unavailable'],
    ['HTTP error', () => Promise.resolve(jsonResponse(null, {
      ok: false,
      status: 503
    })), 'provider_unavailable'],
    ['invalid JSON', () => Promise.resolve({
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(new Error('bad json'))
    }), 'malformed_provider_response']
  ])('provider %s remains ambiguous', async (
    _,
    implementation,
    expectedReason
  ) => {
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl: jest.fn(implementation)
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: expectedReason,
      evidence: {
        scanComplete: false,
        pagesScanned: 0,
        transactionsScanned: 0,
        apiRequestIds: []
      }
    });
  });

  test.each([
    ['wrong per-page', (body) => {
      body.meta.pagination.per_page = 29;
    }],
    ['invalid provider request ID', (body) => {
      body.meta.request_id = 'req_page_1';
    }],
    ['empty has-more page', (body) => {
      body.meta.pagination.has_more = true;
      body.meta.pagination.next = nextUrl(OTHER_TRANSACTION_ID);
    }]
  ])('malformed pagination (%s) cannot prove no match', async (_, mutate) => {
    const malformed = page([]);
    mutate(malformed);
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl: makeFetch(jsonResponse(malformed))
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'malformed_provider_response',
      evidence: {
        scanComplete: false,
        pagesScanned: 0,
        transactionsScanned: 0
      }
    });
  });

  test.each([
    ['foreign origin', (() => {
      const url = new URL(nextUrl(OTHER_TRANSACTION_ID));
      url.host = 'evil.test';
      return url.toString();
    })()],
    ['changed time filter', (() => {
      const url = new URL(nextUrl(OTHER_TRANSACTION_ID));
      url.searchParams.set(
        'created_at[GTE]',
        '2026-07-01T00:00:00.000001Z'
      );
      return url.toString();
    })()],
    ['unexpected parameter',
      `${nextUrl(OTHER_TRANSACTION_ID)}&include=customer`],
    ['duplicate parameter',
      `${nextUrl(OTHER_TRANSACTION_ID)}&created_at%5BGTE%5D=duplicate`]
  ])('untrusted next URL (%s) is never followed', async (
    _,
    untrustedNext
  ) => {
    const fetchImpl = makeFetch(jsonResponse(page([
      unrelatedTransaction()
    ], {
      hasMore: true,
      next: untrustedNext
    })));
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'untrusted_pagination_url',
      evidence: {
        scanComplete: false,
        pagesScanned: 1,
        transactionsScanned: 1
      }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('next cursor must equal the last transaction ID on its page', async () => {
    const fetchImpl = makeFetch(jsonResponse(page([
      unrelatedTransaction()
    ], {
      hasMore: true,
      next: nextUrl(TRANSACTION_ID)
    })));
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'untrusted_pagination_url'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('duplicate provider request IDs are ambiguous', async () => {
    const fetchImpl = makeFetch(
      jsonResponse(page([unrelatedTransaction()], {
        hasMore: true,
        next: nextUrl(OTHER_TRANSACTION_ID)
      })),
      jsonResponse(page([], {
        requestId: PROVIDER_REQUEST_ID_1
      }))
    );
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'duplicate_provider_request_id',
      evidence: {
        scanComplete: false,
        pagesScanned: 1,
        transactionsScanned: 1,
        apiRequestIds: [PROVIDER_REQUEST_ID_1]
      }
    });
  });

  test('reaching a configured page bound remains ambiguous', async () => {
    const fetchImpl = makeFetch(jsonResponse(page([
      unrelatedTransaction()
    ], {
      hasMore: true,
      next: nextUrl(OTHER_TRANSACTION_ID)
    })));
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl,
      maxPages: 1
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'pagination_incomplete',
      evidence: {
        scanComplete: false,
        pagesScanned: 1,
        transactionsScanned: 1
      }
    });
  });

  test('default exhaustive proof traverses the full 256-page bound', async () => {
    const responses = [];
    for (let index = 0; index < 255; index += 1) {
      const transactionId = generatedTransactionId(index);
      responses.push(jsonResponse(page([
        unrelatedTransaction({ id: transactionId })
      ], {
        requestId: generatedProviderRequestId(index),
        hasMore: true,
        next: nextUrl(transactionId)
      })));
    }
    responses.push(jsonResponse(page([], {
      requestId: generatedProviderRequestId(255)
    })));
    const fetchImpl = makeFetch(...responses);

    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl
    });

    expect(result).toMatchObject({
      status: 'definitive_no_match',
      reason: 'complete_scan_no_match',
      evidence: {
        scanComplete: true,
        pagesScanned: 256,
        transactionsScanned: 255
      }
    });
    expect(result.evidence.apiRequestIds).toHaveLength(256);
    expect(fetchImpl).toHaveBeenCalledTimes(256);
  });

  test.each([0, -1, 257, 1.5, '2'])(
    'invalid max-pages value %p fails before provider access',
    async (maxPages) => {
      const fetchImpl = jest.fn();
      const result = await reconcileCreditPackPurchase({
        ...EXPECTED,
        fetchImpl,
        maxPages
      });

      expect(result).toMatchObject({
        status: 'ambiguous',
        reason: 'invalid_scan_configuration',
        evidence: {
          scanComplete: false,
          pagesScanned: 0,
          transactionsScanned: 0
        }
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  test('duplicate transaction evidence across pages is ambiguous', async () => {
    const fetchImpl = makeFetch(
      jsonResponse(page([transaction()], {
        hasMore: true,
        next: nextUrl(TRANSACTION_ID)
      })),
      jsonResponse(page([transaction()], {
        requestId: PROVIDER_REQUEST_ID_2
      }))
    );
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'duplicate_or_invalid_transaction',
      evidence: {
        scanComplete: false,
        pagesScanned: 2,
        transactionsScanned: 2
      }
    });
  });

  test('two distinct exact matches are ambiguous', async () => {
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl: makeFetch(jsonResponse(page([
        transaction(),
        transaction({ id: THIRD_TRANSACTION_ID })
      ])))
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'multiple_matches',
      transactionIds: [TRANSACTION_ID, THIRD_TRANSACTION_ID],
      evidence: {
        scanComplete: true,
        pagesScanned: 1,
        transactionsScanned: 2
      }
    });
  });

  test.each([
    ['grand total', (candidate) => {
      candidate.details.totals.grand_total = '939';
    }],
    ['discount', (candidate) => {
      candidate.details.totals.discount = '0';
    }],
    ['credit', (candidate) => {
      candidate.details.totals.credit = '0';
    }],
    ['completed balance', (candidate) => {
      candidate.details.totals.balance = '940';
    }],
    ['custom price identity', (candidate) => {
      candidate.items[0].price.id = 'pri_fake';
    }]
  ])('an exact marker with wrong %s is partial evidence', async (
    _,
    mutate
  ) => {
    const candidate = mutateExactTransaction(mutate);
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl: makeFetch(jsonResponse(page([candidate])))
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'partial_evidence',
      partialEvidence: {
        transactionId: TRANSACTION_ID,
        reason: 'amount_contract_mismatch'
      },
      evidence: {
        scanComplete: true
      }
    });
  });

  test.each([
    ['outside time window', (candidate) => {
      candidate.created_at = '2026-07-03T00:00:00.000001Z';
    }],
    ['wrong pack', (candidate) => {
      candidate.items[0].price.custom_data.promptgenPackKey =
        'credits_1500';
    }]
  ])('an exact marker with %s is partial evidence', async (_, mutate) => {
    const candidate = mutateExactTransaction(mutate);
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl: makeFetch(jsonResponse(page([candidate])))
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'partial_evidence',
      evidence: {
        scanComplete: true
      }
    });
  });

  test('same-pack metadata without exact request ID is partial evidence', async () => {
    const candidate = transaction();
    delete candidate.items[0].price.custom_data
      .promptgenPurchaseRequestId;
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl: makeFetch(jsonResponse(page([candidate])))
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'partial_evidence',
      partialEvidence: {
        transactionId: TRANSACTION_ID,
        reason: 'missing_exact_request_marker'
      }
    });
  });

  test('an exact identity and amount without any marker is partial evidence', async () => {
    const candidate = transaction();
    candidate.custom_data = null;
    candidate.items[0].price.custom_data = null;
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl: makeFetch(jsonResponse(page([candidate])))
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'partial_evidence',
      partialEvidence: {
        transactionId: TRANSACTION_ID,
        reason: 'missing_exact_request_marker'
      },
      evidence: {
        scanComplete: true
      }
    });
  });

  test.each([
    ['changed tax and totals', (candidate) => {
      candidate.details.totals.tax = '91';
      candidate.details.totals.total = '991';
      candidate.details.totals.grand_total = '941';
      candidate.details.line_items[0].totals.tax = '91';
      candidate.details.line_items[0].totals.total = '991';
    }],
    ['incomplete amount details', (candidate) => {
      candidate.details = null;
    }]
  ])(
    'a markerless exact identity envelope with %s stays ambiguous',
    async (_, mutateCandidate) => {
      const candidate = transaction();
      candidate.custom_data = null;
      candidate.items[0].price.custom_data = null;
      mutateCandidate(candidate);

      const result = await reconcileCreditPackPurchase({
        ...EXPECTED,
        fetchImpl: makeFetch(jsonResponse(page([candidate])))
      });

      expect(result).toMatchObject({
        status: 'ambiguous',
        reason: 'partial_evidence',
        partialEvidence: {
          transactionId: TRANSACTION_ID,
          reason: 'missing_exact_request_marker'
        },
        evidence: {
          scanComplete: true
        }
      });
    }
  );

  test('conflicting top-level request marker is partial evidence', async () => {
    const candidate = transaction({
      custom_data: marker({
        promptgenPurchaseRequestId:
          '323e4567-e89b-42d3-a456-426614174002'
      })
    });
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl: makeFetch(jsonResponse(page([candidate])))
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'partial_evidence',
      partialEvidence: {
        reason: 'conflicting_request_marker'
      }
    });
  });

  test('malformed transaction cannot prove no match', async () => {
    const result = await reconcileCreditPackPurchase({
      ...EXPECTED,
      fetchImpl: makeFetch(jsonResponse(page([{
        id: TRANSACTION_ID,
        status: 'completed'
      }])))
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'partial_evidence',
      partialEvidence: {
        transactionId: TRANSACTION_ID,
        reason: 'invalid_transaction_envelope'
      }
    });
  });
});
