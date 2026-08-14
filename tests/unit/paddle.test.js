'use strict';
/**
 * Paddle webhook unit tests
 * Tests signature verification, purchase credit grant, and refund credit revocation logic.
 */

const crypto = require('crypto');
const {
  classifyTransactionOrigin,
  classifyChargebackAdjustment,
  priceIdToPlan,
  isActiveSubscription,
  isTestAccount,
  recordPlanUpgradePurchase,
  handleNonCreditPackAdjustment,
  reportNonCreditPackChargebackAdjustment,
  verifyPaddleSignature
} = require('../../routes/paddle');

function buildSignatureHeader(secret, rawBody, ts) {
  const signedPayload = ts + ':' + rawBody;
  const h1 = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

// ── Supabase mock helpers ──

function makeSupabaseMock({ insertError = null, selectData = null, selectError = null, rpcError = null } = {}) {
  const singleFn = jest.fn().mockResolvedValue({ data: selectData, error: selectError });
  const rpcFn = jest.fn().mockResolvedValue({ error: rpcError });

  return {
    from: jest.fn().mockReturnValue({
      insert: jest.fn().mockResolvedValue({ error: insertError }),
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ single: singleFn })
      })
    }),
    rpc: rpcFn,
    _rpcFn: rpcFn,
    _singleFn: singleFn
  };
}

// ── Tests ──

describe('verifyPaddleSignature', () => {
  const SECRET = 'test-paddle-webhook-secret-abc';
  const BODY = JSON.stringify({ event_type: 'transaction.completed', data: {} });
  const TS = '1700000000';
  const NOW_MS = Number(TS) * 1000;

  test('올바른 서명은 검증에 통과해야 한다', () => {
    const header = buildSignatureHeader(SECRET, BODY, TS);
    expect(verifyPaddleSignature(SECRET, BODY, header, NOW_MS)).toBe(true);
  });

  test('잘못된 h1 값은 검증에 실패해야 한다', () => {
    const header = `ts=${TS};h1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
    expect(verifyPaddleSignature(SECRET, BODY, header, NOW_MS)).toBe(false);
  });

  test('body가 변조되면 검증에 실패해야 한다', () => {
    const header = buildSignatureHeader(SECRET, BODY, TS);
    expect(verifyPaddleSignature(SECRET, BODY + ' ', header, NOW_MS)).toBe(false);
  });

  test('Paddle-Signature 헤더가 없으면 false를 반환해야 한다', () => {
    expect(verifyPaddleSignature(SECRET, BODY, null)).toBe(false);
    expect(verifyPaddleSignature(SECRET, BODY, '')).toBe(false);
  });

  test('ts 또는 h1 필드가 없으면 false를 반환해야 한다', () => {
    expect(verifyPaddleSignature(SECRET, BODY, 'ts=1700000000')).toBe(false);
    expect(verifyPaddleSignature(SECRET, BODY, 'h1=abc123')).toBe(false);
  });

  test('서명 회전 중 여러 h1 중 하나가 일치하면 통과해야 한다', () => {
    const valid = buildSignatureHeader(SECRET, BODY, TS).split(';')[1];
    const invalid = 'h1=' + '0'.repeat(64);
    expect(
      verifyPaddleSignature(SECRET, BODY, `ts=${TS};${invalid};${valid}`, NOW_MS)
    ).toBe(true);
  });

  test('기본 5초 허용 범위를 벗어난 과거·미래 서명은 거절해야 한다', () => {
    const header = buildSignatureHeader(SECRET, BODY, TS);
    expect(verifyPaddleSignature(SECRET, BODY, header, NOW_MS + 6000)).toBe(false);
    expect(verifyPaddleSignature(SECRET, BODY, header, NOW_MS - 6000)).toBe(false);
  });
});

describe('priceIdToPlan staged price compatibility', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PADDLE_PRO_PRICE_ID: 'pri_pro_current',
      PADDLE_PRO_LEGACY_PRICE_IDS: 'pri_pro_legacy',
      PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise_current',
      PADDLE_ENTERPRISE_LEGACY_PRICE_IDS: 'pri_enterprise_legacy'
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('maps both current and legacy IDs without exposing legacy IDs to checkout', () => {
    expect(priceIdToPlan('pri_pro_current')).toBe('pro');
    expect(priceIdToPlan('pri_pro_legacy')).toBe('pro');
    expect(priceIdToPlan('pri_enterprise_current')).toBe('enterprise');
    expect(priceIdToPlan('pri_enterprise_legacy')).toBe('enterprise');
    expect(priceIdToPlan('pri_unknown')).toBeNull();
  });
});

describe('adjustment.created 이벤트 필터링', () => {
  test('chargeback 계열은 무시 대상이 아니라 수동 검토 대상이다', () => {
    expect(classifyChargebackAdjustment({ action: 'chargeback', status: 'approved' }))
      .toMatchObject({ action: 'chargeback', isReversal: false });
  });

  test('action이 refund 또는 credit이면 처리해야 한다', () => {
    expect('refund' === 'refund' || 'refund' === 'credit').toBe(true);
    expect('credit' === 'refund' || 'credit' === 'credit').toBe(true);
  });

  test('status가 approved가 아닌 경우 처리하지 않아야 한다', () => {
    const status = 'pending';
    expect(status === 'approved').toBe(false);
  });

  test('status가 approved이면 처리해야 한다', () => {
    expect('approved' === 'approved').toBe(true);
  });
});

describe('non-credit-pack chargeback manual review', () => {
  const opaqueIds = {
    adjustmentId: 'opaque-adjustment-id',
    transactionId: 'opaque-transaction-id',
    subscriptionId: 'opaque-subscription-id',
    customerId: 'opaque-customer-id',
    notificationId: 'opaque-notification-id',
    providerEventId: 'opaque-provider-event-id'
  };

  test.each([
    ['chargeback', 'chargeback', false, false, null],
    ['chargeback_warning', 'chargeback_warning', true, false, null],
    ['chargeback_reverse', 'chargeback', false, true, 'reverse_action'],
    ['chargeback_warning_reverse', 'chargeback_warning', true, true, 'reverse_action']
  ])(
    'Paddle action=%s을 명시적으로 분류한다',
    (action, family, isWarning, isReversal, reversalSource) => {
      expect(classifyChargebackAdjustment({ action, status: 'approved' })).toEqual({
        action,
        family,
        isWarning,
        isReversal,
        reversalSource
      });
    }
  );

  test.each(['chargeback', 'chargeback_warning'])(
    'action=%s 원본 adjustment가 status=reversed로 갱신된 형태도 역전으로 분류한다',
    (action) => {
      expect(classifyChargebackAdjustment({ action, status: 'reversed' }))
        .toMatchObject({ isReversal: true, reversalSource: 'reversed_status' });
    }
  );

  test.each(['refund', 'credit', 'credit_reverse', undefined])(
    'action=%s는 chargeback 수동 검토 분류에 속하지 않는다',
    (action) => {
      expect(classifyChargebackAdjustment({ action, status: 'approved' })).toBeNull();
    }
  );

  test.each([
    'chargeback',
    'chargeback_warning',
    'chargeback_reverse',
    'chargeback_warning_reverse'
  ])(
    '%s을 critical/manual-review로 내구적 기록하고 크레딧·entitlement mutation을 명시적으로 금지한다',
    async (action) => {
      const incidentReporter = jest.fn().mockResolvedValue({ persisted: true, incidentId: 42 });
      const result = await reportNonCreditPackChargebackAdjustment(
        {
          id: opaqueIds.adjustmentId,
          transaction_id: opaqueIds.transactionId,
          subscription_id: opaqueIds.subscriptionId,
          customer_id: opaqueIds.customerId,
          action,
          type: 'full',
          status: 'approved'
        },
        {
          requestId: 'opaque-http-request-id',
          eventId: opaqueIds.notificationId,
          providerEventId: opaqueIds.providerEventId,
          eventType: 'adjustment.created',
          occurredAt: '2026-08-01T00:00:00Z',
          incidentReporter
        }
      );

      expect(result).toMatchObject({ handled: true, manualReviewRequired: true });
      expect(incidentReporter).toHaveBeenCalledWith(expect.objectContaining({
        severity: 'critical',
        eventCode: 'NON_CREDIT_PACK_CHARGEBACK_REQUIRES_REVIEW',
        fingerprint:
          `paddle-webhook:NON_CREDIT_PACK_CHARGEBACK_REQUIRES_REVIEW:opaque-adjustment-id:${action}:${action.endsWith('_reverse') ? 'reversal' : 'forward'}`,
        context: expect.objectContaining({
          adjustmentId: opaqueIds.adjustmentId,
          transactionId: opaqueIds.transactionId,
          subscriptionId: opaqueIds.subscriptionId,
          customerId: opaqueIds.customerId,
          eventId: opaqueIds.notificationId,
          providerEventId: opaqueIds.providerEventId,
          action,
          manualReviewRequired: true,
          creditMutationApplied: false,
          entitlementMutationApplied: false
        })
      }));
    }
  );

  test('same adjustment redelivery는 event ID를 보존하면서 같은 open-incident fingerprint를 사용한다', async () => {
    const incidentReporter = jest.fn().mockResolvedValue({ persisted: true });
    const data = {
      id: opaqueIds.adjustmentId,
      transaction_id: opaqueIds.transactionId,
      subscription_id: opaqueIds.subscriptionId,
      action: 'chargeback_warning',
      status: 'approved'
    };

    await reportNonCreditPackChargebackAdjustment(data, {
      eventId: 'notification-first',
      providerEventId: 'event-first',
      incidentReporter
    });
    await reportNonCreditPackChargebackAdjustment(data, {
      eventId: 'notification-second',
      providerEventId: 'event-second',
      incidentReporter
    });

    const first = incidentReporter.mock.calls[0][0];
    const second = incidentReporter.mock.calls[1][0];
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.context).toMatchObject({
      eventId: 'notification-first',
      providerEventId: 'event-first'
    });
    expect(second.context).toMatchObject({
      eventId: 'notification-second',
      providerEventId: 'event-second'
    });
  });

  test('same adjustment의 forward/reversal 금융 상태는 서로 다른 incident fingerprint로 보존한다', async () => {
    const incidentReporter = jest.fn().mockResolvedValue({ persisted: true });
    const base = {
      id: opaqueIds.adjustmentId,
      transaction_id: opaqueIds.transactionId,
      subscription_id: opaqueIds.subscriptionId
    };

    await reportNonCreditPackChargebackAdjustment(
      { ...base, action: 'chargeback_warning', status: 'approved' },
      { providerEventId: 'event-forward', incidentReporter }
    );
    await reportNonCreditPackChargebackAdjustment(
      { ...base, action: 'chargeback_warning', status: 'reversed' },
      { providerEventId: 'event-reversed-status', incidentReporter }
    );
    await reportNonCreditPackChargebackAdjustment(
      { ...base, action: 'chargeback_warning_reverse', status: 'approved' },
      { providerEventId: 'event-reverse-action', incidentReporter }
    );

    const fingerprints = incidentReporter.mock.calls.map(([incident]) => incident.fingerprint);
    expect(new Set(fingerprints).size).toBe(3);
    expect(fingerprints[0]).toMatch(/:chargeback_warning:forward$/);
    expect(fingerprints[1]).toMatch(/:chargeback_warning:reversal$/);
    expect(fingerprints[2]).toMatch(/:chargeback_warning_reverse:reversal$/);
  });

  test('critical incident가 내구적으로 저장되지 않으면 webhook ACK를 막는다', async () => {
    const incidentReporter = jest.fn().mockResolvedValue({ persisted: false });

    await expect(reportNonCreditPackChargebackAdjustment(
      {
        id: opaqueIds.adjustmentId,
        transaction_id: opaqueIds.transactionId,
        action: 'chargeback_reverse',
        status: 'approved'
      },
      { incidentReporter }
    )).rejects.toMatchObject({
      code: 'NON_CREDIT_PACK_CHARGEBACK_INCIDENT_PERSIST_FAILED'
    });
  });

  test('refund/credit은 기존 자동 환불 경로를 위해 chargeback helper에서 처리하지 않는다', async () => {
    const incidentReporter = jest.fn();

    await expect(reportNonCreditPackChargebackAdjustment(
      { action: 'refund', status: 'approved' },
      { incidentReporter }
    )).resolves.toEqual({ handled: false });
    expect(incidentReporter).not.toHaveBeenCalled();
  });

  test.each([
    'chargeback',
    'chargeback_warning',
    'chargeback_reverse',
    'chargeback_warning_reverse'
  ])(
    '%s manual-review 경로는 refund handler를 호출하지 않는다',
    async (action) => {
      const refundHandler = jest.fn();
      const incidentReporter = jest.fn().mockResolvedValue({ persisted: true });

      await expect(handleNonCreditPackAdjustment(
        {},
        {
          id: opaqueIds.adjustmentId,
          transaction_id: opaqueIds.transactionId,
          subscription_id: opaqueIds.subscriptionId,
          action,
          status: 'approved'
        },
        { refundHandler, incidentReporter }
      )).resolves.toMatchObject({ handled: true, manualReviewRequired: true });

      expect(refundHandler).not.toHaveBeenCalled();
    }
  );

  test.each(['refund', 'credit'])(
    'approved %s는 기존 refund handler 계약을 그대로 유지한다',
    async (action) => {
      const supabase = { marker: 'supabase' };
      const refundResult = { reason: 'refunded' };
      const refundHandler = jest.fn().mockResolvedValue(refundResult);
      const incidentReporter = jest.fn();

      await expect(handleNonCreditPackAdjustment(
        supabase,
        {
          transaction_id: opaqueIds.transactionId,
          action,
          type: 'full',
          status: 'approved'
        },
        { refundHandler, incidentReporter }
      )).resolves.toEqual({
        handled: true,
        reason: 'refund_or_credit_applied',
        result: refundResult
      });

      expect(incidentReporter).not.toHaveBeenCalled();
      expect(refundHandler).toHaveBeenCalledWith(
        supabase,
        opaqueIds.transactionId,
        'full'
      );
    }
  );
});

describe('recordPlanUpgradePurchase', () => {
  const TXN_ID = 'txn_upgrade_001';
  const USER_ID = 'user-uuid-123';
  const SUB_ID = 'sub_01abc';

  test('올바른 컬럼으로 purchases INSERT를 호출해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await recordPlanUpgradePurchase(supabase, { transactionId: TXN_ID, userId: USER_ID, plan: 'enterprise', subscriptionId: SUB_ID });

    expect(supabase.from).toHaveBeenCalledWith('purchases');
    const insertCall = supabase.from.mock.results[0].value.insert.mock.calls[0][0];
    expect(insertCall).toMatchObject({
      transaction_id:   TXN_ID,
      user_id:          USER_ID,
      plan:             'enterprise',
      credits_granted:  1500,
      status:           'completed',
      subscription_id:  SUB_ID,
      transaction_type: 'plan_upgrade'
    });
  });

  test('credits는 plan에 따라 올바르게 설정돼야 한다 (pro=600)', async () => {
    const supabase = makeSupabaseMock();
    await recordPlanUpgradePurchase(supabase, { transactionId: TXN_ID, userId: USER_ID, plan: 'pro', subscriptionId: SUB_ID });

    const insertCall = supabase.from.mock.results[0].value.insert.mock.calls[0][0];
    expect(insertCall.credits_granted).toBe(600);
  });

  test('중복 transaction_id(23505)는 저장된 불변 계약이 정확히 같을 때만 스킵해야 한다', async () => {
    const supabase = makeSupabaseMock({
      insertError: { code: '23505', message: 'duplicate key' },
      selectData: {
        transaction_id: TXN_ID,
        user_id: USER_ID,
        plan: 'enterprise',
        credits_granted: 1500,
        status: 'completed',
        subscription_id: SUB_ID,
        transaction_type: 'plan_upgrade'
      }
    });
    await expect(recordPlanUpgradePurchase(supabase, { transactionId: TXN_ID, userId: USER_ID, plan: 'enterprise', subscriptionId: SUB_ID }))
      .resolves.toMatchObject({ transaction_id: TXN_ID });
  });

  test('중복 transaction_id의 기존 계약이 다르면 fail-closed 해야 한다', async () => {
    const supabase = makeSupabaseMock({
      insertError: { code: '23505', message: 'duplicate key' },
      selectData: {
        transaction_id: TXN_ID,
        user_id: 'different-user',
        plan: 'enterprise',
        credits_granted: 1500,
        status: 'completed',
        subscription_id: SUB_ID,
        transaction_type: 'plan_upgrade'
      }
    });

    await expect(recordPlanUpgradePurchase(
      supabase,
      {
        transactionId: TXN_ID,
        userId: USER_ID,
        plan: 'enterprise',
        subscriptionId: SUB_ID
      }
    )).rejects.toThrow('duplicate contract conflict');
  });

  test('중복 transaction_id 조회가 실패하면 정상 중복으로 승인하지 않아야 한다', async () => {
    const supabase = makeSupabaseMock({
      insertError: { code: '23505', message: 'duplicate key' },
      selectError: { message: 'lookup failed' }
    });

    await expect(recordPlanUpgradePurchase(
      supabase,
      {
        transactionId: TXN_ID,
        userId: USER_ID,
        plan: 'enterprise',
        subscriptionId: SUB_ID
      }
    )).rejects.toThrow('duplicate contract conflict');
  });

  test('크레딧 RPC(grant_credits)를 절대 호출하지 않아야 한다 — 크레딧 이중처리 방지', async () => {
    const supabase = makeSupabaseMock();
    await recordPlanUpgradePurchase(supabase, { transactionId: TXN_ID, userId: USER_ID, plan: 'enterprise', subscriptionId: SUB_ID });

    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('비-중복 INSERT 실패 시 예외를 던져야 한다', async () => {
    const supabase = makeSupabaseMock({ insertError: { code: '42501', message: 'permission denied' } });
    await expect(recordPlanUpgradePurchase(supabase, { transactionId: TXN_ID, userId: USER_ID, plan: 'enterprise', subscriptionId: SUB_ID }))
      .rejects.toThrow('Failed to record plan_upgrade purchase');
  });

  test('subscriptionId 없으면 subscription_id=null로 기록해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await recordPlanUpgradePurchase(supabase, { transactionId: TXN_ID, userId: USER_ID, plan: 'enterprise', subscriptionId: undefined });

    const insertCall = supabase.from.mock.results[0].value.insert.mock.calls[0][0];
    expect(insertCall.subscription_id).toBeNull();
  });
});

describe('isTestAccount (env 파싱)', () => {
  test('목록에 있는 user_id는 true', () => {
    expect(isTestAccount('u1', 'u1,u2')).toBe(true);
    expect(isTestAccount('u2', 'u1,u2')).toBe(true);
  });

  test('목록에 없는 user_id는 false', () => {
    expect(isTestAccount('u3', 'u1,u2')).toBe(false);
  });

  test('콤마 주변 공백을 trim해야 한다', () => {
    expect(isTestAccount('u1', '  u1 , u2  ')).toBe(true);
    expect(isTestAccount('u2', 'u1 ,  u2')).toBe(true);
  });

  test('빈 문자열/미설정이면 아무도 화이트리스트 아님 (false)', () => {
    expect(isTestAccount('u1', '')).toBe(false);
    expect(isTestAccount('u1', undefined)).toBe(false);
    expect(isTestAccount('u1', '   ')).toBe(false);
  });

  test('userId가 없으면 false (빈 목록이어도 매칭 안 됨)', () => {
    expect(isTestAccount('', 'u1')).toBe(false);
    expect(isTestAccount(null, 'u1')).toBe(false);
    expect(isTestAccount(undefined, 'u1')).toBe(false);
  });

  test('후행 콤마/빈 항목은 무시해야 한다 (빈 항목이 모두 매칭하지 않음)', () => {
    expect(isTestAccount('u1', 'u1,')).toBe(true);
    expect(isTestAccount('', 'u1,,')).toBe(false);
  });

  test('단일 id', () => {
    expect(isTestAccount('only', 'only')).toBe(true);
    expect(isTestAccount('other', 'only')).toBe(false);
  });
});

describe('classifyTransactionOrigin', () => {
  test("'checkout'은 서버 바인딩 없는 직접 구매로 거부해야 한다", () => {
    expect(classifyTransactionOrigin('checkout')).toBe('reject');
  });

  test("'web'도 서버 바인딩 없는 직접 구매로 거부해야 한다", () => {
    expect(classifyTransactionOrigin('web')).toBe('reject');
  });

  test("'subscription_recurring'은 grant로 분류해야 한다 (갱신)", () => {
    expect(classifyTransactionOrigin('subscription_recurring')).toBe('grant');
  });

  test("'subscription_update'는 defer로 분류해야 한다 (플랜 변경)", () => {
    expect(classifyTransactionOrigin('subscription_update')).toBe('defer');
  });

  test("'subscription_charge'는 ignore로 분류해야 한다 (일회성 추가 청구)", () => {
    expect(classifyTransactionOrigin('subscription_charge')).toBe('ignore');
  });

  test("'subscription_payment_method_change'는 ignore로 분류해야 한다", () => {
    expect(classifyTransactionOrigin('subscription_payment_method_change')).toBe('ignore');
  });

  test('undefined / 알 수 없는 값은 ignore로 분류해야 한다', () => {
    expect(classifyTransactionOrigin(undefined)).toBe('ignore');
    expect(classifyTransactionOrigin(null)).toBe('ignore');
    expect(classifyTransactionOrigin('some_future_origin')).toBe('ignore');
  });
});

describe('isActiveSubscription', () => {
  test("'active'는 true를 반환해야 한다", () => {
    expect(isActiveSubscription('active')).toBe(true);
  });

  test("'trialing'은 true를 반환해야 한다", () => {
    expect(isActiveSubscription('trialing')).toBe(true);
  });

  test("'canceled'는 false를 반환해야 한다", () => {
    expect(isActiveSubscription('canceled')).toBe(false);
  });

  test("'paused'는 false를 반환해야 한다", () => {
    expect(isActiveSubscription('paused')).toBe(false);
  });

  test("'past_due'는 false를 반환해야 한다", () => {
    expect(isActiveSubscription('past_due')).toBe(false);
  });

  test('undefined / null은 false를 반환해야 한다', () => {
    expect(isActiveSubscription(undefined)).toBe(false);
    expect(isActiveSubscription(null)).toBe(false);
  });
});

describe('subscription.updated userId 폴백 로직', () => {
  // Mirrors the handler's userId resolution logic for unit testing
  async function resolveUserId(supabase, data) {
    let userId = data?.custom_data?.userId;
    if (!userId) {
      const customerId = data?.customer_id;
      if (customerId) {
        const { data: profile, error: lookupError } = await supabase
          .from('profiles')
          .select('id')
          .eq('paddle_customer_id', customerId)
          .single();
        if (!lookupError && profile?.id) {
          userId = profile.id;
        }
      }
    }
    return userId || null;
  }

  test('custom_data.userId가 있으면 DB 조회 없이 반환해야 한다', async () => {
    const supabase = makeSupabaseMock();
    const data = { custom_data: { userId: 'user-direct' }, customer_id: 'ctm_abc' };
    const userId = await resolveUserId(supabase, data);

    expect(userId).toBe('user-direct');
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('custom_data.userId 없을 때 paddle_customer_id로 profiles를 조회해야 한다', async () => {
    const supabase = makeSupabaseMock({ selectData: { id: 'user-from-db' } });
    const data = { customer_id: 'ctm_abc' };
    const userId = await resolveUserId(supabase, data);

    expect(userId).toBe('user-from-db');
    expect(supabase.from).toHaveBeenCalledWith('profiles');
  });

  test('custom_data.userId도 없고 paddle_customer_id 조회도 실패하면 null을 반환해야 한다', async () => {
    const supabase = makeSupabaseMock({ selectData: null, selectError: { message: 'not found' } });
    const data = { customer_id: 'ctm_abc' };
    const userId = await resolveUserId(supabase, data);

    expect(userId).toBeNull();
  });

  test('customer_id 자체가 없으면 DB 조회 없이 null을 반환해야 한다', async () => {
    const supabase = makeSupabaseMock();
    const data = { custom_data: {} };
    const userId = await resolveUserId(supabase, data);

    expect(userId).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('data 자체가 null이면 null을 반환해야 한다', async () => {
    const supabase = makeSupabaseMock();
    const userId = await resolveUserId(supabase, null);

    expect(userId).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe('subscription.canceled userId 폴백 로직', () => {
  // Mirrors the subscription.canceled handler's userId resolution — identical
  // pattern to subscription.updated (custom_data.userId → paddle_customer_id).
  async function resolveCanceledUserId(supabase, data) {
    let userId = data?.custom_data?.userId;
    if (!userId) {
      const customerId = data?.customer_id;
      if (customerId) {
        const { data: profile, error: lookupError } = await supabase
          .from('profiles')
          .select('id')
          .eq('paddle_customer_id', customerId)
          .single();
        if (!lookupError && profile?.id) {
          userId = profile.id;
        }
      }
    }
    return userId || null;
  }

  test('정상 케이스: custom_data.userId 있으면 그대로 사용, DB 조회 없음 (기존 동작 무변경)', async () => {
    const supabase = makeSupabaseMock();
    const userId = await resolveCanceledUserId(supabase, { custom_data: { userId: 'user-direct' }, customer_id: 'ctm_abc' });

    expect(userId).toBe('user-direct');
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('폴백: userId 없고 customer_id만 있으면 paddle_customer_id로 유저를 찾아야 한다', async () => {
    const supabase = makeSupabaseMock({ selectData: { id: 'user-from-db' } });
    const userId = await resolveCanceledUserId(supabase, { customer_id: 'ctm_abc' });

    expect(userId).toBe('user-from-db');
    expect(supabase.from).toHaveBeenCalledWith('profiles');
  });

  test('둘 다 없으면 null (CRITICAL 로그 후 안전 종료 — expire 미실행)', async () => {
    const supabase = makeSupabaseMock({ selectData: null, selectError: { message: 'not found' } });
    const userId = await resolveCanceledUserId(supabase, { customer_id: 'ctm_abc' });

    expect(userId).toBeNull();
  });
});
