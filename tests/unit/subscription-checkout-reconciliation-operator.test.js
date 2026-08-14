'use strict';

const {
  contractFingerprint,
  parseCliArguments,
  runSubscriptionCheckoutReconciliation
} = require('../../scripts/reconcile-subscription-checkout');
const {
  reconciliationEvidenceHash
} = require('../../scripts/reconcile-credit-pack-purchase');

const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRICE_ID = `pri_${'a'.repeat(26)}`;
const PRODUCT_ID = `pro_${'b'.repeat(26)}`;
const CATALOG_1 = '11111111-1111-4111-8111-111111111111';
const CATALOG_2 = '22222222-2222-4222-8222-222222222222';
const REQUEST_1 = '33333333-3333-4333-8333-333333333333';
const REQUEST_2 = '44444444-4444-4444-8444-444444444444';
const REQUEST_3 = '55555555-5555-4555-8555-555555555555';
const FIRST_CHECKED_AT = '2026-07-04T01:00:00.000Z';
const FINAL_CHECKED_AT = '2026-07-05T02:00:00.000Z';
const WINDOW_START_AT = '2026-07-01T00:00:00.000Z';
const AUDIT = 'pgsr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENV = {
  SUPABASE_URL: 'https://kzlovmcghswprasjaeeo.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-only',
  PADDLE_API_KEY: 'pdl_live_apikey_test-only',
  PADDLE_API_BASE: 'https://api.paddle.com'
};

function attempt(overrides = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    user_id: USER_ID,
    authorized_user_id: USER_ID,
    transaction_id: null,
    subscription_id: null,
    customer_id: null,
    target_plan: 'pro',
    price_id: PRICE_ID,
    credits: 600,
    unit_amount: 1099,
    currency_code: 'USD',
    expected_origin: 'api',
    status: 'provider_unknown',
    provider_error_code: 'provider_timeout',
    provider_mutation_started_at: WINDOW_START_AT,
    provider_unknown_at: '2026-07-01T00:01:00.000Z',
    created_at: WINDOW_START_AT,
    updated_at: '2026-07-01T00:01:00.000Z',
    ...overrides
  };
}

function reconciledAttempt(overrides = {}) {
  return attempt({
    status: 'reconciled_no_match',
    provider_error_code: 'reconciled_definitive_no_match',
    failed_at: FINAL_CHECKED_AT,
    review_required: true,
    reconciliation_decision: 'definitive_no_match',
    reconciliation_previous_status: 'provider_unknown',
    reconciliation_closed_at: FINAL_CHECKED_AT,
    updated_at: FINAL_CHECKED_AT,
    ...overrides
  });
}

function expected(row, checkedAt) {
  return {
    attemptId: ATTEMPT_ID,
    userId: USER_ID,
    status: row.reconciliation_previous_status || row.status,
    targetPlan: row.target_plan,
    priceId: row.price_id,
    credits: row.credits,
    unitAmount: row.unit_amount,
    currencyCode: row.currency_code,
    expectedOrigin: row.expected_origin,
    expectedCustomerId: null,
    createdAt: WINDOW_START_AT,
    providerMutationStartedAt: WINDOW_START_AT,
    providerUnknownAt: row.provider_unknown_at,
    checkedAt,
    windowStartAt: WINDOW_START_AT,
    windowEndAt: checkedAt
  };
}

function evidence(checkedAt, requestIds = [REQUEST_1]) {
  return Object.freeze({
    scanComplete: true,
    attemptId: ATTEMPT_ID,
    userId: USER_ID,
    targetPlan: 'pro',
    priceId: PRICE_ID,
    credits: 600,
    unitAmount: '1099',
    currencyCode: 'USD',
    expectedOrigin: 'api',
    expectedCustomerId: null,
    windowStartAt: WINDOW_START_AT,
    windowEndAt: checkedAt,
    checkedAt,
    pagesScanned: requestIds.length,
    transactionsScanned: 0,
    apiRequestIds: Object.freeze([...requestIds])
  });
}

function noMatch(checkedAt, requestIds) {
  return {
    status: 'definitive_no_match',
    reason: 'complete_scan_no_match',
    evidence: evidence(checkedAt, requestIds)
  };
}

function firstScanRow(row = attempt(), overrides = {}) {
  const contract = expected(row, FIRST_CHECKED_AT);
  const fingerprint = contractFingerprint(contract);
  const firstEvidence = evidence(FIRST_CHECKED_AT, [REQUEST_1]);
  return {
    attempt_id: ATTEMPT_ID,
    authorized_user_id: USER_ID,
    scan_ordinal: 1,
    expected_status: contract.status,
    checked_at: FIRST_CHECKED_AT,
    window_start: WINDOW_START_AT,
    window_end: FIRST_CHECKED_AT,
    pages_scanned: 1,
    transactions_scanned: 0,
    provider_request_ids: [REQUEST_1],
    catalog_request_id: CATALOG_1,
    contract_fingerprint: fingerprint,
    evidence_hash: reconciliationEvidenceHash({
      expectedStatus: contract.status,
      evidence: firstEvidence,
      catalogRequestId: CATALOG_1,
      contractFingerprint: fingerprint
    }),
    audit_reference: AUDIT,
    recorded_at: FIRST_CHECKED_AT,
    ...overrides
  };
}

function finalScanRow(row = reconciledAttempt(), overrides = {}) {
  const contract = expected(row, FINAL_CHECKED_AT);
  const fingerprint = contractFingerprint(contract);
  const finalEvidence = evidence(FINAL_CHECKED_AT, [REQUEST_2]);
  return {
    attempt_id: ATTEMPT_ID,
    authorized_user_id: USER_ID,
    scan_ordinal: 2,
    expected_status: contract.status,
    checked_at: FINAL_CHECKED_AT,
    window_start: WINDOW_START_AT,
    window_end: FINAL_CHECKED_AT,
    pages_scanned: 1,
    transactions_scanned: 0,
    provider_request_ids: [REQUEST_2],
    catalog_request_id: CATALOG_2,
    contract_fingerprint: fingerprint,
    evidence_hash: reconciliationEvidenceHash({
      expectedStatus: contract.status,
      evidence: finalEvidence,
      catalogRequestId: CATALOG_2,
      contractFingerprint: fingerprint
    }),
    audit_reference: AUDIT,
    recorded_at: FINAL_CHECKED_AT,
    ...overrides
  };
}

function priceResponse(requestId = CATALOG_2) {
  return {
    ok: true,
    json: jest.fn().mockResolvedValue({
      data: {
        id: PRICE_ID,
        product_id: PRODUCT_ID,
        type: 'standard',
        unit_price: { amount: '1099', currency_code: 'USD' },
        billing_cycle: { interval: 'month', frequency: 1 }
      },
      meta: { request_id: requestId }
    })
  };
}

function makeSupabase(row, scanRow, finalScan, rpcResult) {
  const attemptSingle = jest.fn().mockResolvedValue({ data: row, error: null });
  const scanMaybeSingle = jest.fn()
    .mockResolvedValueOnce({ data: scanRow || null, error: null })
    .mockResolvedValueOnce({ data: finalScan || null, error: null });
  const from = jest.fn((table) => {
    const builder = {
      select: jest.fn(() => builder),
      eq: jest.fn(() => builder),
      single: attemptSingle,
      maybeSingle: scanMaybeSingle
    };
    if (![
      'subscription_checkout_attempts',
      'subscription_checkout_reconciliation_scans'
    ].includes(table)) {
      throw new Error(`unexpected table ${table}`);
    }
    return builder;
  });
  const rpc = jest.fn().mockResolvedValue({ data: rpcResult, error: null });
  return {
    client: { from, rpc },
    from,
    rpc,
    attemptSingle,
    scanMaybeSingle
  };
}

function context({
  row = attempt(),
  scanRow = null,
  finalScan = null,
  apply = false,
  checkedAt = FINAL_CHECKED_AT,
  results = [noMatch(FINAL_CHECKED_AT, [REQUEST_2])],
  rpcResult = null,
  catalogRequestId = CATALOG_2
} = {}) {
  const defaultRpc = scanRow
    ? {
        applied: true,
        reason: 'attempt_reconciled_no_match',
        attemptId: ATTEMPT_ID,
        status: 'reconciled_no_match',
        reviewRequired: true,
        reconciliationDecision: 'definitive_no_match',
        firstCheckedAt: FIRST_CHECKED_AT,
        checkedAt,
        closedAt: checkedAt
      }
    : {
        applied: true,
        reason: 'reconciliation_scan_recorded',
        attemptId: ATTEMPT_ID,
        status: row.status,
        scanOrdinal: 1,
        firstCheckedAt: checkedAt,
        firstRecordedAt: checkedAt
      };
  const supabase = makeSupabase(
    row,
    scanRow,
    finalScan,
    rpcResult || defaultRpc
  );
  const reconcileImpl = jest.fn();
  results.forEach((value) => reconcileImpl.mockResolvedValueOnce(value));
  return {
    supabase,
    reconcileImpl,
    options: {
      attemptId: ATTEMPT_ID,
      apply,
      env: ENV,
      now: jest.fn(() => new Date(checkedAt)),
      createClientImpl: jest.fn(() => supabase.client),
      fetchImpl: jest.fn().mockResolvedValue(priceResponse(catalogRequestId)),
      reconcileImpl,
      auditReferenceFactory: jest.fn(() => AUDIT)
    }
  };
}

describe('subscription checkout reconciliation operator', () => {
  test('requires one attempt id and defaults to dry-run', () => {
    expect(parseCliArguments([`--attempt-id=${ATTEMPT_ID}`])).toEqual({
      attemptId: ATTEMPT_ID,
      apply: false
    });
    expect(parseCliArguments(['--attempt-id', ATTEMPT_ID, '--apply'])).toEqual({
      attemptId: ATTEMPT_ID,
      apply: true
    });
  });

  test.each(['charging', 'provider_unknown'])(
    '%s can be scanned after its 72-hour provider mutation window',
    async (status) => {
      const row = attempt({
        status,
        provider_unknown_at: status === 'provider_unknown'
          ? '2026-07-01T00:01:00.000Z'
          : null
      });
      const ctx = context({ row });

      await expect(runSubscriptionCheckoutReconciliation(ctx.options))
        .resolves.toMatchObject({
          mode: 'dry-run',
          outcome: 'definitive_no_match'
        });
      expect(ctx.supabase.rpc).not.toHaveBeenCalled();
    }
  );

  test.each([
    ['charging', {
      provider_mutation_started_at: '2026-07-01T02:00:00.000Z',
      provider_unknown_at: null
    }],
    ['provider_unknown', {
      provider_mutation_started_at: WINDOW_START_AT,
      provider_unknown_at: '2026-07-01T02:00:00.000Z'
    }]
  ])('%s delay is anchored to provider state, not row creation', async (
    status,
    timing
  ) => {
    const ctx = context({
      row: attempt({ status, ...timing }),
      checkedAt: '2026-07-04T01:59:59.999Z'
    });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .rejects.toMatchObject({
        code: 'RECONCILIATION_ATTEMPT_CONTRACT_INVALID'
      });
    expect(ctx.options.fetchImpl).not.toHaveBeenCalled();
    expect(ctx.supabase.rpc).not.toHaveBeenCalled();
  });

  test('authorization tombstone permits read-only recovery after profile deletion', async () => {
    const ctx = context({ row: attempt({ user_id: null }) });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .resolves.toMatchObject({
        mode: 'dry-run',
        outcome: 'definitive_no_match'
      });
    expect(ctx.supabase.rpc).not.toHaveBeenCalled();
  });

  test('explicit apply repeats the scan and records only first evidence', async () => {
    const firstRecordedAt = '2026-07-05T02:00:05.000Z';
    const ctx = context({
      apply: true,
      rpcResult: {
        applied: true,
        reason: 'reconciliation_scan_recorded',
        attemptId: ATTEMPT_ID,
        status: 'provider_unknown',
        scanOrdinal: 1,
        firstCheckedAt: FINAL_CHECKED_AT,
        firstRecordedAt
      },
      results: [
        noMatch(FINAL_CHECKED_AT, [REQUEST_2]),
        noMatch(FINAL_CHECKED_AT, [REQUEST_3])
      ]
    });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .resolves.toMatchObject({
        mode: 'first-scan-recorded',
        status: 'provider_unknown',
        firstRecordedAt,
        finalizationEligibleAt: '2026-07-06T02:00:05.000Z'
      });
    expect(ctx.reconcileImpl).toHaveBeenCalledTimes(2);
    expect(ctx.supabase.rpc).toHaveBeenCalledWith(
      'record_subscription_checkout_no_match_scan',
      {
        p_attempt_id: ATTEMPT_ID,
        p_expected_status: 'provider_unknown',
        p_checked_at: FINAL_CHECKED_AT,
        p_window_start: WINDOW_START_AT,
        p_window_end: FINAL_CHECKED_AT,
        p_pages_scanned: 1,
        p_transactions_scanned: 0,
        p_provider_request_ids: [REQUEST_3],
        p_catalog_request_id: CATALOG_2,
        p_contract_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        p_evidence_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        p_audit_reference: AUDIT
      }
    );
  });

  test('first-scan RPC response without persisted recorded_at fails closed', async () => {
    const ctx = context({
      apply: true,
      rpcResult: {
        applied: true,
        reason: 'reconciliation_scan_recorded',
        attemptId: ATTEMPT_ID,
        status: 'provider_unknown',
        scanOrdinal: 1,
        firstCheckedAt: FINAL_CHECKED_AT
      },
      results: [
        noMatch(FINAL_CHECKED_AT, [REQUEST_2]),
        noMatch(FINAL_CHECKED_AT, [REQUEST_3])
      ]
    });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .rejects.toMatchObject({ code: 'RECONCILIATION_RPC_REJECTED' });
  });

  test('provider request UUID case variants are canonicalized before persistence', async () => {
    const ctx = context({
      apply: true,
      results: [
        noMatch(FINAL_CHECKED_AT, [REQUEST_2.toUpperCase()]),
        noMatch(FINAL_CHECKED_AT, [REQUEST_3.toUpperCase()])
      ]
    });

    await runSubscriptionCheckoutReconciliation(ctx.options);

    expect(ctx.supabase.rpc).toHaveBeenCalledWith(
      'record_subscription_checkout_no_match_scan',
      expect.objectContaining({ p_provider_request_ids: [REQUEST_3] })
    );
  });

  test('a persisted first scan younger than 24 hours blocks before Paddle reads', async () => {
    const row = attempt();
    const ctx = context({
      row,
      scanRow: firstScanRow(row),
      checkedAt: '2026-07-04T23:59:59.999Z'
    });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .rejects.toMatchObject({
        code: 'RECONCILIATION_FINALIZATION_DELAY_ACTIVE'
      });
    expect(ctx.options.fetchImpl).not.toHaveBeenCalled();
    expect(ctx.supabase.rpc).not.toHaveBeenCalled();
  });

  test('the 24-hour gate uses persisted recorded_at when it is later than checked_at', async () => {
    const row = attempt();
    const ctx = context({
      row,
      scanRow: firstScanRow(row, {
        recorded_at: '2026-07-04T01:01:00.000Z'
      }),
      checkedAt: '2026-07-05T01:00:59.999Z'
    });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .rejects.toMatchObject({
        code: 'RECONCILIATION_FINALIZATION_DELAY_ACTIVE'
      });
    expect(ctx.options.fetchImpl).not.toHaveBeenCalled();
    expect(ctx.supabase.rpc).not.toHaveBeenCalled();
  });

  test('a lost final RPC response is recovered from terminal row and both immutable scans only', async () => {
    const row = reconciledAttempt();
    const ctx = context({
      row,
      scanRow: firstScanRow(row),
      finalScan: finalScanRow(row),
      apply: true
    });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .resolves.toMatchObject({
        ok: true,
        mode: 'idempotent',
        outcome: 'definitive_no_match',
        attemptId: ATTEMPT_ID,
        status: 'reconciled_no_match',
        reviewRequired: true,
        previousStatus: 'provider_unknown',
        firstEvidence: { checkedAt: FIRST_CHECKED_AT },
        evidence: { checkedAt: FINAL_CHECKED_AT },
        auditReference: AUDIT,
        closedAt: FINAL_CHECKED_AT
      });
    expect(ctx.options.fetchImpl).not.toHaveBeenCalled();
    expect(ctx.reconcileImpl).not.toHaveBeenCalled();
    expect(ctx.supabase.rpc).not.toHaveBeenCalled();
  });

  test('terminal attempt with conflicting final scan fails before provider access', async () => {
    const row = reconciledAttempt();
    const ctx = context({
      row,
      scanRow: firstScanRow(row),
      finalScan: finalScanRow(row, { catalog_request_id: CATALOG_1 }),
      apply: true
    });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .rejects.toMatchObject({ code: 'RECONCILIATION_SCAN_CONTRACT_INVALID' });
    expect(ctx.options.fetchImpl).not.toHaveBeenCalled();
    expect(ctx.reconcileImpl).not.toHaveBeenCalled();
    expect(ctx.supabase.rpc).not.toHaveBeenCalled();
  });

  test('a fresh disjoint second scan is dry-run by default', async () => {
    const row = attempt();
    const ctx = context({ row, scanRow: firstScanRow(row) });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .resolves.toMatchObject({
        mode: 'dry-run-finalization',
        outcome: 'definitive_no_match',
        firstEvidence: { checkedAt: FIRST_CHECKED_AT },
        evidence: { checkedAt: FINAL_CHECKED_AT }
      });
    expect(ctx.supabase.rpc).not.toHaveBeenCalled();
  });

  test('explicit second invocation finalizes through the exact RPC contract', async () => {
    const row = attempt();
    const ctx = context({
      row,
      scanRow: firstScanRow(row),
      apply: true
    });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .resolves.toMatchObject({
        mode: 'finalized',
        status: 'reconciled_no_match',
        reviewRequired: true
      });
    expect(ctx.supabase.rpc).toHaveBeenCalledWith(
      'finalize_subscription_checkout_no_match',
      {
        p_attempt_id: ATTEMPT_ID,
        p_expected_status: 'provider_unknown',
        p_checked_at: FINAL_CHECKED_AT,
        p_window_start: WINDOW_START_AT,
        p_window_end: FINAL_CHECKED_AT,
        p_pages_scanned: 1,
        p_transactions_scanned: 0,
        p_provider_request_ids: [REQUEST_2],
        p_catalog_request_id: CATALOG_2,
        p_contract_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        p_evidence_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        p_audit_reference: AUDIT
      }
    );
  });

  test.each(['matched', 'ambiguous'])(
    '%s evidence in the second invocation never writes',
    async (status) => {
      const row = attempt();
      const scanResult = status === 'matched'
        ? {
            status,
            reason: 'exact_attempt_transaction_found',
            transaction: { id: `txn_${'z'.repeat(26)}` },
            evidence: evidence(FINAL_CHECKED_AT, [REQUEST_2])
          }
        : {
            status,
            reason: 'partial_evidence',
            evidence: evidence(FINAL_CHECKED_AT, [REQUEST_2])
          };
      const ctx = context({
        row,
        scanRow: firstScanRow(row),
        apply: true,
        results: [scanResult]
      });

      await expect(runSubscriptionCheckoutReconciliation(ctx.options))
        .resolves.toMatchObject({
          mode: 'finalization-blocked',
          outcome: status,
          writesApplied: false
        });
      expect(ctx.supabase.rpc).not.toHaveBeenCalled();
    }
  );

  test('reused provider or catalog evidence cannot finalize', async () => {
    const row = attempt();
    const ctx = context({
      row,
      scanRow: firstScanRow(row),
      apply: true,
      catalogRequestId: CATALOG_1,
      results: [noMatch(FINAL_CHECKED_AT, [REQUEST_1])]
    });

    await expect(runSubscriptionCheckoutReconciliation(ctx.options))
      .rejects.toMatchObject({
        code: 'RECONCILIATION_FINAL_SCAN_NOT_INDEPENDENT'
      });
    expect(ctx.supabase.rpc).not.toHaveBeenCalled();
  });
});
