'use strict';

const {
  PURCHASE_REQUEST_COLUMNS,
  ReconciliationOperatorError,
  parseCliArguments,
  runCreditPackReconciliation
} = require('../../scripts/reconcile-credit-pack-purchase');

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '223e4567-e89b-42d3-a456-426614174001';
const CHECKED_AT = '2026-07-04T00:16:00.000Z';
const CONFIRMATION_CHECKED_AT = '2026-07-04T00:16:30.000Z';
const COMPLETED_AT = '2026-07-04T00:16:31.000Z';
const AUDIT_REFERENCE = 'pgcr_323e4567-e89b-42d3-a456-426614174002';
const PROVIDER_REQUEST_ID_1 = '423e4567-e89b-42d3-a456-426614174003';
const PROVIDER_REQUEST_ID_2 = '523e4567-e89b-42d3-a456-426614174004';
const BINDING_REQUEST_ID = '623e4567-e89b-42d3-a456-426614174005';
const PROVIDER_REQUEST_ID_3 = '723e4567-e89b-42d3-a456-426614174006';
const PROVIDER_REQUEST_ID_4 = '823e4567-e89b-42d3-a456-426614174007';
const CUSTOMER_ID = `ctm_${'a'.repeat(26)}`;
const SUBSCRIPTION_ID = `sub_${'b'.repeat(26)}`;
const PLAN_PRICE_ID = `pri_${'c'.repeat(26)}`;
const ENV = Object.freeze({
  SUPABASE_URL: 'https://kzlovmcghswprasjaeeo.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value',
  PADDLE_API_KEY: 'pdl_live_apikey_test-only',
  PADDLE_API_BASE: 'https://api.paddle.com'
});

function purchaseRow(overrides = {}) {
  return {
    request_id: REQUEST_ID,
    authorized_user_id: USER_ID,
    status: 'provider_unknown',
    customer_id: CUSTOMER_ID,
    subscription_id: SUBSCRIPTION_ID,
    provider_plan_price_id: PLAN_PRICE_ID,
    pack_key: 'usage_600',
    currency_code: 'USD',
    unit_amount: 1000,
    approved_subtotal: 1000,
    approved_discount: 0,
    approved_tax: 80,
    approved_total: 1080,
    approved_credit: 0,
    approved_balance: 1080,
    approved_grand_total: 1080,
    approved_grand_total_tax: 80,
    eligibility_check_started_at: '2026-06-30T23:59:30.000Z',
    eligible_snapshot_occurred_at: '2026-06-30T23:59:45.000Z',
    authorized_at: '2026-07-01T00:00:00.000Z',
    authorization_expires_at: '2026-07-01T00:15:00.000Z',
    review_required: false,
    ...overrides
  };
}

function reconciledPurchaseRow(overrides = {}) {
  return purchaseRow({
    status: 'provider_unknown',
    review_required: true,
    provider_error_code: 'reconciled_no_match_review_locked',
    reconciliation_decision: 'definitive_no_match',
    reconciliation_previous_status: 'provider_unknown',
    reconciliation_checked_at: CHECKED_AT,
    reconciliation_window_start: '2026-06-30T23:59:30.000Z',
    reconciliation_window_end: CHECKED_AT,
    reconciliation_pages_scanned: 2,
    reconciliation_transactions_scanned: 1,
    reconciliation_provider_request_ids: [
      PROVIDER_REQUEST_ID_1,
      PROVIDER_REQUEST_ID_2
    ],
    reconciliation_audit_reference: AUDIT_REFERENCE,
    reconciliation_closed_at: CHECKED_AT,
    ...overrides
  });
}

function subscriptionBindingResponse(overrides = {}) {
  const dataOverrides = overrides.data || {};
  const metaOverrides = overrides.meta || {};
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    json: jest.fn().mockResolvedValue({
      data: {
        id: SUBSCRIPTION_ID,
        customer_id: CUSTOMER_ID,
        items: [{
          price: {
            id: PLAN_PRICE_ID
          }
        }],
        ...dataOverrides
      },
      meta: {
        request_id: BINDING_REQUEST_ID,
        ...metaOverrides
      }
    })
  };
}

function completeEvidence(overrides = {}) {
  return Object.freeze({
    scanComplete: true,
    purchaseRequestId: REQUEST_ID,
    subscriptionId: SUBSCRIPTION_ID,
    customerId: CUSTOMER_ID,
    packKey: 'usage_600',
    currencyCode: 'USD',
    unitAmount: '1000',
    subtotal: '1000',
    discount: '0',
    tax: '80',
    total: '1080',
    credit: '0',
    balance: '1080',
    grandTotal: '1080',
    grandTotalTax: '80',
    windowStartAt: '2026-06-30T23:59:30.000Z',
    windowEndAt: CHECKED_AT,
    checkedAt: CHECKED_AT,
    pagesScanned: 2,
    transactionsScanned: 1,
    apiRequestIds: Object.freeze([
      PROVIDER_REQUEST_ID_1,
      PROVIDER_REQUEST_ID_2
    ]),
    ...overrides
  });
}

function reconciliationResult(status, overrides = {}) {
  return {
    status,
    reason: status === 'definitive_no_match'
      ? 'complete_scan_no_match'
      : status === 'matched'
        ? 'exact_match'
        : 'partial_evidence',
    evidence: completeEvidence({
      scanComplete: status !== 'ambiguous'
    }),
    ...overrides
  };
}

function makeSupabase(row = purchaseRow(), rpcResponse = null) {
  const single = jest.fn().mockResolvedValue({ data: row, error: null });
  const eq = jest.fn().mockReturnValue({ single });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  const rpc = jest.fn().mockResolvedValue(
    rpcResponse || {
      data: {
        applied: true,
        reason: 'request_reconciled_no_match',
        requestId: REQUEST_ID,
        status: 'provider_unknown',
        reviewRequired: true,
        reconciliationDecision: 'definitive_no_match'
      },
      error: null
    }
  );
  return {
    client: { from, rpc },
    from,
    select,
    eq,
    single,
    rpc
  };
}

function operatorOptions({
  row = purchaseRow(),
  result = reconciliationResult('definitive_no_match'),
  confirmationResult = null,
  apply = false,
  rpcResponse = null,
  now = CHECKED_AT
} = {}) {
  const supabase = makeSupabase(row, rpcResponse);
  const createClientImpl = jest.fn().mockReturnValue(supabase.client);
  const defaultConfirmationResult = result?.status === 'definitive_no_match'
    ? {
        ...result,
        evidence: {
          ...result.evidence,
          apiRequestIds: [
            PROVIDER_REQUEST_ID_3,
            PROVIDER_REQUEST_ID_4
          ]
        }
      }
    : result;
  const reconcileImpl = jest.fn()
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce(
      confirmationResult || defaultConfirmationResult
    );
  const fetchImpl = jest.fn().mockResolvedValue(
    subscriptionBindingResponse()
  );
  return {
    options: {
      requestId: REQUEST_ID,
      apply,
      env: ENV,
      now: jest.fn(() => new Date(now)),
      createClientImpl,
      reconcileImpl,
      fetchImpl,
      auditReferenceFactory: jest.fn(() => AUDIT_REFERENCE)
    },
    supabase,
    createClientImpl,
    reconcileImpl,
    fetchImpl
  };
}

function expectOperatorError(code) {
  return expect.objectContaining({
    name: 'ReconciliationOperatorError',
    code
  });
}

describe('credit-pack reconciliation operator', () => {
  test('requires exactly one opaque request ID and defaults to dry-run', () => {
    expect(() => parseCliArguments([])).toThrow(
      expectOperatorError('RECONCILIATION_REQUEST_ID_REQUIRED')
    );
    expect(parseCliArguments(['--request-id', REQUEST_ID])).toEqual({
      requestId: REQUEST_ID,
      apply: false
    });
    expect(parseCliArguments([
      `--request-id=${REQUEST_ID}`,
      '--apply'
    ])).toEqual({
      requestId: REQUEST_ID,
      apply: true
    });
    expect(() => parseCliArguments([
      '--request-id',
      REQUEST_ID,
      '--request-id',
      REQUEST_ID
    ])).toThrow(expectOperatorError('RECONCILIATION_ARGUMENT_INVALID'));
    expect(() => parseCliArguments([
      '--request-id',
      REQUEST_ID,
      '--force'
    ])).toThrow(expectOperatorError('RECONCILIATION_ARGUMENT_INVALID'));
  });

  test('reads one exact row with the full immutable payment contract', async () => {
    const context = operatorOptions();

    await runCreditPackReconciliation(context.options);

    expect(context.supabase.from).toHaveBeenCalledTimes(1);
    expect(context.supabase.from).toHaveBeenCalledWith(
      'credit_pack_purchase_requests'
    );
    expect(context.supabase.select).toHaveBeenCalledWith(
      PURCHASE_REQUEST_COLUMNS
    );
    expect(context.supabase.eq).toHaveBeenCalledWith(
      'request_id',
      REQUEST_ID
    );
    expect(context.supabase.single).toHaveBeenCalledTimes(1);
    expect(context.createClientImpl).toHaveBeenCalledWith(
      'https://kzlovmcghswprasjaeeo.supabase.co',
      ENV.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false
        }
      }
    );
    expect(context.reconcileImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseRequestId: REQUEST_ID,
        unitAmount: '1000',
        subtotal: '1000',
        discount: '0',
        tax: '80',
        total: '1080',
        credit: '0',
        balance: '1080',
        grandTotal: '1080',
        grandTotalTax: '80',
        checkedAt: CHECKED_AT,
        windowEndAt: CHECKED_AT
      })
    );
    expect(context.fetchImpl).toHaveBeenCalledTimes(1);
    const [bindingUrl, bindingInit] = context.fetchImpl.mock.calls[0];
    expect(bindingUrl).toBe(
      `https://api.paddle.com/subscriptions/${SUBSCRIPTION_ID}`
    );
    expect(bindingInit).toEqual(expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      headers: expect.objectContaining({
        Authorization: `Bearer ${ENV.PADDLE_API_KEY}`
      })
    }));
  });

  test('default dry-run never writes even with definitive no-match evidence', async () => {
    const context = operatorOptions();

    const result = await runCreditPackReconciliation(context.options);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      outcome: 'definitive_no_match',
      requestId: REQUEST_ID,
      readyToApply: true,
      paddleBindingRequestId: BINDING_REQUEST_ID,
      evidence: {
        pagesScanned: 2,
        transactionsScanned: 1
      }
    });
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('the real reconciler contract produces a read-only complete dry-run', async () => {
    const context = operatorOptions();
    delete context.options.reconcileImpl;
    context.options.fetchImpl = jest.fn()
      .mockResolvedValueOnce(subscriptionBindingResponse())
      .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        data: [],
        meta: {
          request_id: '423e4567-e89b-42d3-a456-426614174003',
          pagination: {
            per_page: 30,
            has_more: false,
            next: ''
          }
        }
      })
      });

    const result = await runCreditPackReconciliation(context.options);

    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      outcome: 'definitive_no_match',
      readyToApply: true,
      evidence: {
        pagesScanned: 1,
        transactionsScanned: 0,
        providerRequestCount: 1
      }
    });
    expect(context.options.fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = context.options.fetchImpl.mock.calls[1];
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://api.paddle.com');
    expect(parsed.pathname).toBe('/transactions');
    expect(parsed.searchParams.get('created_at[GTE]')).toBe(
      '2026-06-30T23:59:30.000Z'
    );
    expect(parsed.searchParams.get('created_at[LTE]')).toBe(CHECKED_AT);
    expect(parsed.searchParams.has('subscription_id')).toBe(false);
    expect(parsed.searchParams.has('customer_id')).toBe(false);
    expect(init.redirect).toBe('error');
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['matched', reconciliationResult('matched', {
      transaction: { id: 'txn_exact' }
    })],
    ['ambiguous', reconciliationResult('ambiguous')]
  ])('%s provider result never writes, even with --apply', async (
    expectedOutcome,
    providerResult
  ) => {
    const context = operatorOptions({
      result: providerResult,
      apply: true
    });

    const result = await runCreditPackReconciliation(context.options);

    expect(result).toMatchObject({
      ok: true,
      mode: 'read-only',
      outcome: expectedOutcome
    });
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('refuses before 72 hours after authorization expiry without a scan or write', async () => {
    const context = operatorOptions({
      now: '2026-07-04T00:14:59.999Z',
      apply: true
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).rejects.toEqual(
      expectOperatorError('RECONCILIATION_DELAY_ACTIVE')
    );
    expect(context.reconcileImpl).not.toHaveBeenCalled();
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('safe --apply invokes the exact CAS RPC once with complete evidence', async () => {
    const context = operatorOptions({
      apply: true,
      confirmationResult: reconciliationResult('definitive_no_match', {
        evidence: completeEvidence({
          windowEndAt: CONFIRMATION_CHECKED_AT,
          checkedAt: CONFIRMATION_CHECKED_AT,
          apiRequestIds: [
            PROVIDER_REQUEST_ID_3,
            PROVIDER_REQUEST_ID_4
          ]
        })
      })
    });
    context.options.now = jest.fn()
      .mockReturnValueOnce(new Date(CHECKED_AT))
      .mockReturnValueOnce(new Date(CONFIRMATION_CHECKED_AT))
      .mockReturnValueOnce(new Date(COMPLETED_AT));

    const result = await runCreditPackReconciliation(context.options);

    expect(result).toMatchObject({
      ok: true,
      mode: 'applied',
      outcome: 'definitive_no_match',
      requestId: REQUEST_ID,
      status: 'provider_unknown',
      reviewRequired: true,
      reviewLocked: true,
      auditReference: AUDIT_REFERENCE
    });
    expect(context.reconcileImpl).toHaveBeenCalledTimes(2);
    expect(context.reconcileImpl.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        checkedAt: CONFIRMATION_CHECKED_AT,
        windowEndAt: CONFIRMATION_CHECKED_AT
      })
    );
    expect(context.supabase.rpc).toHaveBeenCalledTimes(1);
    expect(context.supabase.rpc).toHaveBeenCalledWith(
      'reconcile_credit_pack_purchase_no_match',
      {
        p_request_id: REQUEST_ID,
        p_user_id: USER_ID,
        p_expected_status: 'provider_unknown',
        p_evidence_result: 'definitive_no_match',
        p_checked_at: CONFIRMATION_CHECKED_AT,
        p_window_start: '2026-06-30T23:59:30.000Z',
        p_window_end: CONFIRMATION_CHECKED_AT,
        p_pages_scanned: 2,
        p_transactions_scanned: 1,
        p_provider_request_ids: [
          PROVIDER_REQUEST_ID_3,
          PROVIDER_REQUEST_ID_4
        ],
        p_audit_reference: AUDIT_REFERENCE
      }
    );
  });

  test('a late match in the independent confirmation scan prevents a no-match write', async () => {
    const context = operatorOptions({
      apply: true,
      confirmationResult: reconciliationResult('matched', {
        transaction: { id: 'txn_late_visible' }
      })
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).resolves.toMatchObject({
      ok: true,
      mode: 'read-only',
      outcome: 'matched',
      transactionId: 'txn_late_visible'
    });
    expect(context.reconcileImpl).toHaveBeenCalledTimes(2);
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['matched', reconciliationResult('matched', {
      transaction: {
        id: 'txn_after_first_cutoff',
        created_at: '2026-07-04T00:16:15.000Z'
      }
    }), 'matched'],
    ['partial', reconciliationResult('ambiguous', {
      reason: 'markerless_candidate',
      transaction: {
        id: 'txn_partial_after_first_cutoff',
        created_at: '2026-07-04T00:16:15.000Z'
      }
    }), 'ambiguous']
  ])('a transaction appearing after the first cutoff as %s blocks the RPC', async (
    _label,
    confirmationResult,
    expectedOutcome
  ) => {
    const context = operatorOptions({
      apply: true,
      confirmationResult
    });
    context.options.now = jest.fn()
      .mockReturnValueOnce(new Date(CHECKED_AT))
      .mockReturnValueOnce(new Date(CONFIRMATION_CHECKED_AT));

    await expect(
      runCreditPackReconciliation(context.options)
    ).resolves.toMatchObject({
      ok: true,
      mode: 'read-only',
      outcome: expectedOutcome
    });
    expect(context.reconcileImpl).toHaveBeenCalledTimes(2);
    expect(context.reconcileImpl.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        checkedAt: CHECKED_AT,
        windowEndAt: CHECKED_AT
      })
    );
    expect(context.reconcileImpl.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        checkedAt: CONFIRMATION_CHECKED_AT,
        windowEndAt: CONFIRMATION_CHECKED_AT
      })
    );
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('reused provider evidence cannot satisfy the confirmation scan', async () => {
    const firstResult = reconciliationResult('definitive_no_match');
    const context = operatorOptions({
      apply: true,
      result: firstResult,
      confirmationResult: firstResult
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).rejects.toEqual(
      expectOperatorError(
        'RECONCILIATION_CONFIRMATION_SCAN_NOT_INDEPENDENT'
      )
    );
    expect(context.reconcileImpl).toHaveBeenCalledTimes(2);
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('a submitted request is eligible for exhaustive no-match reconciliation', async () => {
    const context = operatorOptions({
      row: purchaseRow({ status: 'submitted' }),
      apply: true
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).resolves.toMatchObject({
      ok: true,
      mode: 'applied',
      outcome: 'definitive_no_match'
    });
    expect(context.supabase.rpc).toHaveBeenCalledWith(
      'reconcile_credit_pack_purchase_no_match',
      expect.objectContaining({
        p_expected_status: 'submitted'
      })
    );
  });

  test('a lost RPC response revalidates exact persisted evidence without writing again', async () => {
    const context = operatorOptions({
      row: reconciledPurchaseRow(),
      apply: true
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).resolves.toEqual({
      ok: true,
      mode: 'idempotent',
      outcome: 'definitive_no_match',
      requestId: REQUEST_ID,
      status: 'provider_unknown',
      reviewRequired: true,
      reviewLocked: true,
      previousStatus: 'provider_unknown',
      revalidated: true,
      evidence: {
        checkedAt: CHECKED_AT,
        windowStartAt: '2026-06-30T23:59:30.000Z',
        windowEndAt: CHECKED_AT,
        pagesScanned: 2,
        transactionsScanned: 1,
        providerRequestCount: 2
      },
      persistedEvidence: {
        checkedAt: CHECKED_AT,
        windowStartAt: '2026-06-30T23:59:30.000Z',
        windowEndAt: CHECKED_AT,
        pagesScanned: 2,
        transactionsScanned: 1,
        providerRequestCount: 2
      },
      paddleBindingRequestId: BINDING_REQUEST_ID,
      auditReference: AUDIT_REFERENCE,
      closedAt: CHECKED_AT
    });
    expect(context.fetchImpl).toHaveBeenCalledTimes(1);
    expect(context.reconcileImpl).toHaveBeenCalledTimes(1);
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('a late match revalidates a persisted no-match without writing', async () => {
    const context = operatorOptions({
      row: reconciledPurchaseRow(),
      apply: true,
      result: reconciliationResult('matched', {
        transaction: { id: 'txn_late_revalidation' }
      })
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).resolves.toMatchObject({
      ok: true,
      mode: 'revalidation',
      outcome: 'matched',
      transactionId: 'txn_late_revalidation',
      status: 'provider_unknown',
      reviewRequired: true,
      reviewLocked: true,
      previousStatus: 'provider_unknown',
      requiresSignedWebhookReplay: true,
      auditReference: AUDIT_REFERENCE,
      closedAt: CHECKED_AT
    });
    expect(context.fetchImpl).toHaveBeenCalledTimes(1);
    expect(context.reconcileImpl).toHaveBeenCalledTimes(1);
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('malformed persisted no-match evidence never rescans or writes', async () => {
    const context = operatorOptions({
      row: reconciledPurchaseRow({
        reconciliation_provider_request_ids: [
          PROVIDER_REQUEST_ID_1,
          PROVIDER_REQUEST_ID_1
        ]
      }),
      apply: true
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).rejects.toEqual(
      expectOperatorError('RECONCILIATION_REQUEST_CONTRACT_INVALID')
    );
    expect(context.fetchImpl).not.toHaveBeenCalled();
    expect(context.reconcileImpl).not.toHaveBeenCalled();
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['missing review lock', { review_required: false }],
    ['legacy failed status', { status: 'failed' }],
    ['legacy provider code', {
      provider_error_code: 'reconciled_definitive_no_match'
    }]
  ])('%s cannot masquerade as a persisted no-match', async (
    _label,
    rowOverride
  ) => {
    const context = operatorOptions({
      row: reconciledPurchaseRow(rowOverride),
      apply: true
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).rejects.toEqual(
      expectOperatorError(
        rowOverride.status === 'failed'
          ? 'RECONCILIATION_STATUS_NOT_ALLOWED'
          : 'RECONCILIATION_REQUEST_CONTRACT_INVALID'
      )
    );
    expect(context.fetchImpl).not.toHaveBeenCalled();
    expect(context.reconcileImpl).not.toHaveBeenCalled();
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('an exact idempotent RPC replay is reported without a second call', async () => {
    const context = operatorOptions({
      apply: true,
      rpcResponse: {
        data: {
          applied: false,
          reason: 'reconciliation_duplicate',
          requestId: REQUEST_ID,
          status: 'provider_unknown',
          reconciliationDecision: 'definitive_no_match'
        },
        error: null
      }
    });

    const result = await runCreditPackReconciliation(context.options);

    expect(result).toMatchObject({
      ok: true,
      mode: 'idempotent',
      outcome: 'definitive_no_match',
      status: 'provider_unknown',
      reviewRequired: true,
      reviewLocked: true
    });
    expect(context.supabase.rpc).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['incomplete evidence', completeEvidence({ scanComplete: false })],
    ['changed amount', completeEvidence({ grandTotal: '1079' })],
    ['missing balance', (() => {
      const evidence = { ...completeEvidence() };
      delete evidence.balance;
      return evidence;
    })()],
    ['duplicate provider request IDs', completeEvidence({
      apiRequestIds: [PROVIDER_REQUEST_ID_1, PROVIDER_REQUEST_ID_1]
    })],
    ['non-Paddle provider request ID', completeEvidence({
      apiRequestIds: ['not-a-request-id', PROVIDER_REQUEST_ID_2]
    })],
    ['impossible transaction count', completeEvidence({
      pagesScanned: 1,
      transactionsScanned: 31,
      apiRequestIds: [PROVIDER_REQUEST_ID_1]
    })]
  ])('%s fails closed before the RPC', async (_, unsafeEvidence) => {
    const context = operatorOptions({
      apply: true,
      result: reconciliationResult('definitive_no_match', {
        evidence: unsafeEvidence
      })
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).rejects.toEqual(
      expectOperatorError('RECONCILIATION_EVIDENCE_UNSAFE')
    );
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['non-reconcilable status', { status: 'completed' },
      'RECONCILIATION_STATUS_NOT_ALLOWED'],
    ['missing approved total', { approved_total: null },
      'RECONCILIATION_REQUEST_CONTRACT_INVALID'],
    ['missing provider plan price', { provider_plan_price_id: null },
      'RECONCILIATION_REQUEST_CONTRACT_INVALID'],
    ['inconsistent approved balance', { approved_balance: 1079 },
      'RECONCILIATION_REQUEST_CONTRACT_INVALID'],
    ['wrong authorization window', {
      authorization_expires_at: '2026-07-01T00:14:59.000Z'
    }, 'RECONCILIATION_REQUEST_CONTRACT_INVALID']
  ])('%s prevents scan and write', async (_, rowOverride, errorCode) => {
    const context = operatorOptions({
      row: purchaseRow(rowOverride),
      apply: true
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).rejects.toEqual(expectOperatorError(errorCode));
    expect(context.reconcileImpl).not.toHaveBeenCalled();
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('unexpected RPC response is never reported as applied', async () => {
    const context = operatorOptions({
      apply: true,
      rpcResponse: {
        data: {
          applied: false,
          reason: 'reconciliation_status_mismatch',
          requestId: REQUEST_ID,
          status: 'charging'
        },
        error: null
      }
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).rejects.toEqual(
      expectOperatorError('RECONCILIATION_RPC_REJECTED')
    );
    expect(context.supabase.rpc).toHaveBeenCalledTimes(1);
  });

  test('stale provider evidence is never applied', async () => {
    const context = operatorOptions({
      apply: true,
      confirmationResult: reconciliationResult('definitive_no_match', {
        evidence: completeEvidence({
          windowEndAt: CONFIRMATION_CHECKED_AT,
          checkedAt: CONFIRMATION_CHECKED_AT,
          apiRequestIds: [
            PROVIDER_REQUEST_ID_3,
            PROVIDER_REQUEST_ID_4
          ]
        })
      })
    });
    context.options.now = jest.fn()
      .mockReturnValueOnce(new Date(CHECKED_AT))
      .mockReturnValueOnce(new Date(CONFIRMATION_CHECKED_AT))
      .mockReturnValueOnce(new Date('2026-07-04T00:18:30.001Z'));

    await expect(
      runCreditPackReconciliation(context.options)
    ).rejects.toEqual(
      expectOperatorError('RECONCILIATION_EVIDENCE_STALE')
    );
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('a failed exact-row read never scans or writes', async () => {
    const context = operatorOptions({ apply: true });
    context.supabase.single.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST116' }
    });

    await expect(
      runCreditPackReconciliation(context.options)
    ).rejects.toEqual(
      expectOperatorError('RECONCILIATION_REQUEST_NOT_FOUND')
    );
    expect(context.reconcileImpl).not.toHaveBeenCalled();
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('missing secrets fail without creating a client or leaking values', async () => {
    const createClientImpl = jest.fn();

    await expect(runCreditPackReconciliation({
      requestId: REQUEST_ID,
      env: {
        SUPABASE_URL: ENV.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: ENV.SUPABASE_SERVICE_ROLE_KEY
      },
      createClientImpl
    })).rejects.toEqual(
      expectOperatorError('RECONCILIATION_ENVIRONMENT_MISSING')
    );
    expect(createClientImpl).not.toHaveBeenCalled();
  });

  test('an untrusted Supabase destination never receives the service-role key', async () => {
    const createClientImpl = jest.fn();

    await expect(runCreditPackReconciliation({
      requestId: REQUEST_ID,
      env: {
        ...ENV,
        SUPABASE_URL: 'https://untrusted.example'
      },
      createClientImpl
    })).rejects.toEqual(
      expectOperatorError('RECONCILIATION_ENVIRONMENT_INVALID')
    );
    expect(createClientImpl).not.toHaveBeenCalled();
  });

  test('a different Supabase project never receives the service-role key', async () => {
    const createClientImpl = jest.fn();

    await expect(runCreditPackReconciliation({
      requestId: REQUEST_ID,
      env: {
        ...ENV,
        SUPABASE_URL: 'https://differentproject.supabase.co'
      },
      createClientImpl
    })).rejects.toEqual(
      expectOperatorError('RECONCILIATION_SUPABASE_PROJECT_MISMATCH')
    );
    expect(createClientImpl).not.toHaveBeenCalled();
  });

  test.each([
    [
      'live key against Sandbox',
      {
        PADDLE_API_KEY: 'pdl_live_apikey_test-only',
        PADDLE_API_BASE: 'https://sandbox-api.paddle.com'
      }
    ],
    [
      'Sandbox key against live',
      {
        PADDLE_API_KEY: 'pdl_sdbx_apikey_test-only',
        PADDLE_API_BASE: 'https://api.paddle.com'
      }
    ]
  ])('%s is rejected before any client or provider request', async (
    _label,
    envOverride
  ) => {
    const createClientImpl = jest.fn();
    const fetchImpl = jest.fn();

    await expect(runCreditPackReconciliation({
      requestId: REQUEST_ID,
      env: { ...ENV, ...envOverride },
      createClientImpl,
      fetchImpl
    })).rejects.toEqual(
      expectOperatorError('RECONCILIATION_PADDLE_ENVIRONMENT_MISMATCH')
    );
    expect(createClientImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    [
      'Sandbox credentials',
      {
        PADDLE_API_KEY: 'pdl_sdbx_apikey_test-only',
        PADDLE_API_BASE: 'https://sandbox-api.paddle.com'
      }
    ],
    [
      'a legacy Paddle API key',
      {
        PADDLE_API_KEY: 'legacy-test-only',
        PADDLE_API_BASE: 'https://api.paddle.com'
      }
    ]
  ])('--apply rejects %s before any client or provider request', async (
    _label,
    envOverride
  ) => {
    const createClientImpl = jest.fn();
    const fetchImpl = jest.fn();

    await expect(runCreditPackReconciliation({
      requestId: REQUEST_ID,
      apply: true,
      env: { ...ENV, ...envOverride },
      createClientImpl,
      fetchImpl
    })).rejects.toEqual(
      expectOperatorError('RECONCILIATION_APPLY_ENVIRONMENT_UNSAFE')
    );
    expect(createClientImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ['not found', {
      ok: false,
      status: 404,
      json: jest.fn()
    }],
    ['malformed JSON', {
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(new Error('malformed'))
    }],
    ['wrong subscription', subscriptionBindingResponse({
      data: { id: `sub_${'d'.repeat(26)}` }
    })],
    ['wrong customer', subscriptionBindingResponse({
      data: { customer_id: `ctm_${'e'.repeat(26)}` }
    })],
    ['wrong plan price', subscriptionBindingResponse({
      data: {
        items: [{
          price: { id: `pri_${'f'.repeat(26)}` }
        }]
      }
    })],
    ['invalid provider request ID', subscriptionBindingResponse({
      meta: { request_id: 'not-a-uuid' }
    })]
  ])('%s binding proof prevents transaction scan and RPC', async (
    _label,
    bindingResponse
  ) => {
    const context = operatorOptions({ apply: true });
    context.fetchImpl.mockResolvedValueOnce(bindingResponse);

    await expect(
      runCreditPackReconciliation(context.options)
    ).rejects.toEqual(
      expectOperatorError('RECONCILIATION_PADDLE_BINDING_UNVERIFIED')
    );
    expect(context.fetchImpl).toHaveBeenCalledTimes(1);
    expect(context.reconcileImpl).not.toHaveBeenCalled();
    expect(context.supabase.rpc).not.toHaveBeenCalled();
  });

  test('operator errors expose fixed codes rather than provider payloads', () => {
    const error = new ReconciliationOperatorError(
      'SAFE_CODE',
      'Fixed safe message.'
    );
    expect(error).toMatchObject({
      name: 'ReconciliationOperatorError',
      code: 'SAFE_CODE',
      message: 'Fixed safe message.'
    });
  });
});
