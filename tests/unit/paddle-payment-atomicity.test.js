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
  grantCreditsForPurchase,
  revokeCreditsForRefund,
  derivePreviousPlan
} = require('../../routes/paddle');

function paymentClient({ result = { applied: true, reason: 'payment_applied', newBalance: 1000 }, error = null } = {}) {
  return {
    from: jest.fn(),
    rpc: jest.fn().mockResolvedValue({ data: result, error })
  };
}

function refundClient({ purchase, priorRow = null, result, error = null }) {
  const purchaseSingle = jest.fn().mockResolvedValue({
    data: purchase || null,
    error: purchase ? null : { message: 'not found' }
  });
  const priorSingle = jest.fn().mockResolvedValue({ data: priorRow, error: null });
  let selectCount = 0;

  const from = jest.fn().mockImplementation(() => ({
    select: jest.fn().mockImplementation(() => {
      selectCount += 1;
      const chain = {
        eq: jest.fn(() => chain),
        lt: jest.fn(() => chain),
        order: jest.fn(() => chain),
        limit: jest.fn(() => chain),
        single: selectCount === 1 ? purchaseSingle : priorSingle,
        maybeSingle: priorSingle
      };
      return chain;
    })
  }));

  return {
    from,
    rpc: jest.fn().mockResolvedValue({ data: result, error })
  };
}

describe('Paddle payment mutations use atomic database boundaries', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const SUBSCRIPTION_ID = 'sub_atomic';
  const CUSTOMER_ID = 'ctm_atomic';
  const PAYMENT_OCCURRED_AT = '2026-07-28T12:34:56.123456Z';
  const originalWhitelist = process.env.TEST_ACCOUNT_USER_IDS;
  const originalLedgerFlag = process.env.CREDIT_LEDGER_V2_ENABLED;

  beforeEach(() => {
    recordServerEvent.mockClear();
    reportIncident.mockClear();
    delete process.env.TEST_ACCOUNT_USER_IDS;
    process.env.CREDIT_LEDGER_V2_ENABLED = 'true';
  });

  afterAll(() => {
    if (originalWhitelist === undefined) delete process.env.TEST_ACCOUNT_USER_IDS;
    else process.env.TEST_ACCOUNT_USER_IDS = originalWhitelist;
    if (originalLedgerFlag === undefined) delete process.env.CREDIT_LEDGER_V2_ENABLED;
    else process.env.CREDIT_LEDGER_V2_ENABLED = originalLedgerFlag;
  });

  test('구독 결제는 purchases INSERT와 credits reset을 단일 RPC에 위임한다', async () => {
    const client = paymentClient();
    await grantCreditsForPurchase(
      client,
      'txn_atomic_1',
      USER_ID,
      'pro',
      SUBSCRIPTION_ID,
      CUSTOMER_ID,
      { occurredAt: PAYMENT_OCCURRED_AT }
    );

    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith('apply_ordered_subscription_payment', {
      p_transaction_id: 'txn_atomic_1',
      p_user_id: USER_ID,
      p_plan: 'pro',
      p_amount: 600,
      p_subscription_id: SUBSCRIPTION_ID,
      p_customer_id: CUSTOMER_ID,
      p_occurred_at: PAYMENT_OCCURRED_AT,
      p_skip_entitlement_mutation: false
    });
    expect(recordServerEvent).toHaveBeenCalledTimes(1);
  });

  test('이미 적용된 transaction_id는 분석 이벤트도 다시 기록하지 않는다', async () => {
    const client = paymentClient({ result: { applied: false, reason: 'duplicate' } });
    await grantCreditsForPurchase(
      client,
      'txn_atomic_dup',
      USER_ID,
      'enterprise',
      SUBSCRIPTION_ID,
      CUSTOMER_ID,
      { occurredAt: PAYMENT_OCCURRED_AT }
    );

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  test('테스트 계정도 원장은 RPC에서 기록하되 credit mutation skip 플래그를 명시한다', async () => {
    process.env.TEST_ACCOUNT_USER_IDS = USER_ID;
    const client = paymentClient({ result: { applied: true, reason: 'credit_mutation_skipped' } });
    await grantCreditsForPurchase(
      client,
      'txn_atomic_test',
      USER_ID,
      'pro',
      SUBSCRIPTION_ID,
      CUSTOMER_ID,
      { occurredAt: PAYMENT_OCCURRED_AT }
    );

    expect(client.rpc).toHaveBeenCalledWith('apply_ordered_subscription_payment', expect.objectContaining({
      p_skip_entitlement_mutation: true
    }));
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  test('결제 RPC 실패는 성공으로 삼키지 않고 durable inbox가 재시도할 예외가 된다', async () => {
    const client = paymentClient({ error: { message: 'USER_NOT_FOUND' } });
    await expect(grantCreditsForPurchase(
      client,
      'txn_atomic_fail',
      USER_ID,
      'pro',
      SUBSCRIPTION_ID,
      CUSTOMER_ID,
      { occurredAt: PAYMENT_OCCURRED_AT }
    )).rejects.toThrow('apply_ordered_subscription_payment RPC failed');
  });

  test('일반 환불은 status 변경과 credits revoke를 단일 RPC에 위임한다', async () => {
    const purchase = {
      id: 1,
      user_id: USER_ID,
      credits_granted: 1000,
      status: 'completed',
      transaction_type: 'subscription_payment',
      subscription_id: 'sub_1',
      created_at: '2026-01-01T00:00:00Z'
    };
    const client = refundClient({
      purchase,
      result: { applied: true, reason: 'credits_revoked', userId: USER_ID, newBalance: 0 }
    });

    await revokeCreditsForRefund(client, 'txn_refund_atomic', 'full');

    expect(client.rpc).toHaveBeenCalledWith('apply_purchase_refund', {
      p_transaction_id: 'txn_refund_atomic',
      p_previous_plan: null,
      p_previous_allotment: null,
      p_skip_credit_mutation: false
    });
  });

  test('원장보다 먼저 온 환불은 완료 처리하지 않고 재시도 가능한 예외가 된다', async () => {
    const client = refundClient({ purchase: null });
    await expect(revokeCreditsForRefund(client, 'txn_not_yet_recorded', 'full'))
      .rejects.toThrow('Purchase record not found');
    expect(client.rpc).not.toHaveBeenCalled();
  });

  test('플랜 변경 전액환불은 잔액을 추측 복원하지 않고 단일 RPC에서 수동검토로 기록한다', async () => {
    const purchase = {
      id: 9,
      user_id: USER_ID,
      credits_granted: 4000,
      status: 'completed',
      transaction_type: 'plan_upgrade',
      subscription_id: 'sub_upgrade',
      created_at: '2026-02-01T00:00:00Z'
    };
    const client = refundClient({
      purchase,
      result: {
        applied: true,
        reason: 'manual_review_required',
        reviewRequired: true,
        reviewReason: 'plan_change_snapshot_missing',
        userId: USER_ID,
        newBalance: 240
      }
    });

    await revokeCreditsForRefund(client, 'txn_upgrade_refund_atomic', 'full');

    expect(client.rpc).toHaveBeenCalledWith('apply_purchase_refund', {
      p_transaction_id: 'txn_upgrade_refund_atomic',
      p_previous_plan: null,
      p_previous_allotment: null,
      p_skip_credit_mutation: false
    });
    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: 'PLAN_CHANGE_REFUND_REQUIRES_REVIEW',
      context: expect.objectContaining({
        transactionId: 'txn_upgrade_refund_atomic',
        currentCredits: 240
      })
    }));
  });

  test('이전 플랜 조회 오류는 free로 추측하지 않고 재시도 가능한 예외가 된다', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: { message: 'temporary ledger error' } });
    const client = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockImplementation(() => {
          const chain = {
            eq: jest.fn(() => chain),
            lt: jest.fn(() => chain),
            order: jest.fn(() => chain),
            limit: jest.fn(() => chain),
            maybeSingle
          };
          return chain;
        })
      })
    };

    await expect(derivePreviousPlan(client, { subscriptionId: 'sub_retry', beforeId: 9 }))
      .rejects.toThrow('Failed to derive previous plan');
  });

  test('테스트 계정 전액환불은 원장만 refunded로 기록하도록 RPC에 위임한다', async () => {
    process.env.TEST_ACCOUNT_USER_IDS = USER_ID;
    const purchase = {
      id: 11,
      user_id: USER_ID,
      credits_granted: 1000,
      status: 'completed',
      transaction_type: 'subscription_payment',
      subscription_id: 'sub_test',
      created_at: '2026-02-01T00:00:00Z'
    };
    const client = refundClient({
      purchase,
      result: { applied: true, reason: 'credit_mutation_skipped', userId: USER_ID }
    });

    await revokeCreditsForRefund(client, 'txn_test_refund', 'full');

    expect(client.rpc).toHaveBeenCalledWith('apply_purchase_refund', {
      p_transaction_id: 'txn_test_refund',
      p_previous_plan: null,
      p_previous_allotment: null,
      p_skip_credit_mutation: true
    });
  });

  test('부분환불은 전체 credits를 회수하지 않고 운영 검토로 남긴다', async () => {
    const purchase = {
      id: 12,
      user_id: USER_ID,
      credits_granted: 1000,
      status: 'completed',
      transaction_type: 'subscription_payment',
      subscription_id: 'sub_partial',
      created_at: '2026-02-01T00:00:00Z'
    };
    const client = refundClient({ purchase });

    await expect(revokeCreditsForRefund(client, 'txn_partial_refund', 'partial'))
      .resolves.toEqual({ action: 'partial_skip' });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
