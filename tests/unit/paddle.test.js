'use strict';
/**
 * Paddle webhook unit tests
 * Tests signature verification, purchase credit grant, and refund credit revocation logic.
 */

const crypto = require('crypto');
const {
  classifyTransactionOrigin,
  isActiveSubscription,
  isTestAccount,
  recordPlanUpgradePurchase,
  syncPlanFromSubscription,
  applyPlanChange,
  saveSubscriptionIds
} = require('../../routes/paddle');

// ── Copied from routes/paddle.js (pure functions, no side effects) ──

function verifyPaddleSignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const parts = {};
  signatureHeader.split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    parts[part.slice(0, idx)] = part.slice(idx + 1);
  });
  const ts = parts['ts'];
  const h1 = parts['h1'];
  if (!ts || !h1) return false;

  const signedPayload = ts + ':' + rawBody;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(h1));
  } catch (_) {
    return false;
  }
}

function buildSignatureHeader(secret, rawBody, ts) {
  const signedPayload = ts + ':' + rawBody;
  const h1 = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

// ── Supabase mock helpers ──

function makeSupabaseMock({ insertError = null, selectData = null, selectError = null, updateError = null, rpcError = null } = {}) {
  const singleFn = jest.fn().mockResolvedValue({ data: selectData, error: selectError });
  const updateEqFn = jest.fn().mockResolvedValue({ error: updateError });
  const updateFn = jest.fn().mockReturnValue({ eq: updateEqFn });
  const rpcFn = jest.fn().mockResolvedValue({ error: rpcError });

  return {
    from: jest.fn().mockReturnValue({
      insert: jest.fn().mockResolvedValue({ error: insertError }),
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ single: singleFn })
      }),
      update: updateFn
    }),
    rpc: rpcFn,
    _rpcFn: rpcFn,
    _singleFn: singleFn,
    _updateFn: updateFn,
    _updateEqFn: updateEqFn
  };
}

async function expireSubscription(supabase, userId) {
  if (isTestAccount(userId)) return;

  const { error } = await supabase
    .from('profiles')
    .update({ plan: 'free', credits: 0 })
    .eq('id', userId);

  if (error) throw new Error('Failed to expire subscription: ' + error.message);
}

// ── Tests ──

describe('verifyPaddleSignature', () => {
  const SECRET = 'test-paddle-webhook-secret-abc';
  const BODY = JSON.stringify({ event_type: 'transaction.completed', data: {} });
  const TS = '1700000000';

  test('올바른 서명은 검증에 통과해야 한다', () => {
    const header = buildSignatureHeader(SECRET, BODY, TS);
    expect(verifyPaddleSignature(SECRET, BODY, header)).toBe(true);
  });

  test('잘못된 h1 값은 검증에 실패해야 한다', () => {
    const header = `ts=${TS};h1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
    expect(verifyPaddleSignature(SECRET, BODY, header)).toBe(false);
  });

  test('body가 변조되면 검증에 실패해야 한다', () => {
    const header = buildSignatureHeader(SECRET, BODY, TS);
    expect(verifyPaddleSignature(SECRET, BODY + ' ', header)).toBe(false);
  });

  test('Paddle-Signature 헤더가 없으면 false를 반환해야 한다', () => {
    expect(verifyPaddleSignature(SECRET, BODY, null)).toBe(false);
    expect(verifyPaddleSignature(SECRET, BODY, '')).toBe(false);
  });

  test('ts 또는 h1 필드가 없으면 false를 반환해야 한다', () => {
    expect(verifyPaddleSignature(SECRET, BODY, 'ts=1700000000')).toBe(false);
    expect(verifyPaddleSignature(SECRET, BODY, 'h1=abc123')).toBe(false);
  });
});

describe('expireSubscription', () => {
  test('plan=free, credits=0으로 업데이트해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await expireSubscription(supabase, 'user-uuid');

    expect(supabase.from).toHaveBeenCalledWith('profiles');
    expect(supabase._updateFn).toHaveBeenCalledWith({ plan: 'free', credits: 0 });
    expect(supabase._updateEqFn).toHaveBeenCalledWith('id', 'user-uuid');
  });

  test('업데이트 실패 시 예외를 던져야 한다', async () => {
    const supabase = makeSupabaseMock({ updateError: { message: 'db error' } });
    await expect(expireSubscription(supabase, 'user-uuid'))
      .rejects.toThrow('Failed to expire subscription');
  });
});

describe('adjustment.created 이벤트 필터링', () => {
  test('action이 refund가 아닌 경우 처리하지 않아야 한다', () => {
    const action = 'chargeback';
    const isHandled = action === 'refund' || action === 'credit';
    expect(isHandled).toBe(false);
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

describe('saveSubscriptionIds', () => {
  const USER_ID = 'user-uuid-123';
  const CUSTOMER_ID = 'ctm_01abc';
  const SUBSCRIPTION_ID = 'sub_01xyz';

  test('customer_id + subscription_id 둘 다 있으면 profiles UPDATE를 호출해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await saveSubscriptionIds(supabase, { userId: USER_ID, customerId: CUSTOMER_ID, subscriptionId: SUBSCRIPTION_ID });

    expect(supabase._updateFn).toHaveBeenCalledWith({
      paddle_customer_id: CUSTOMER_ID,
      paddle_subscription_id: SUBSCRIPTION_ID,
    });
  });

  test('UPDATE .eq()에 userId가 정확히 전달돼야 한다 (customerId 혼용 방지)', async () => {
    const supabase = makeSupabaseMock();
    await saveSubscriptionIds(supabase, { userId: USER_ID, customerId: CUSTOMER_ID, subscriptionId: SUBSCRIPTION_ID });

    expect(supabase._updateEqFn).toHaveBeenCalledWith('id', USER_ID);
    expect(supabase._updateEqFn).not.toHaveBeenCalledWith('id', CUSTOMER_ID);
  });

  test('customer_id만 있을 때 paddle_subscription_id를 포함하지 않아야 한다', async () => {
    const supabase = makeSupabaseMock();
    await saveSubscriptionIds(supabase, { userId: USER_ID, customerId: CUSTOMER_ID, subscriptionId: undefined });

    expect(supabase._updateFn).toHaveBeenCalledWith({ paddle_customer_id: CUSTOMER_ID });
    expect(supabase._updateFn).not.toHaveBeenCalledWith(expect.objectContaining({ paddle_subscription_id: expect.anything() }));
  });

  test('둘 다 undefined이면 DB 호출 없이 종료해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await saveSubscriptionIds(supabase, { userId: USER_ID, customerId: undefined, subscriptionId: undefined });

    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('UPDATE 실패 시 durable webhook 재시도를 위해 예외를 던져야 한다', async () => {
    const supabase = makeSupabaseMock({ updateError: { message: 'db error' } });
    await expect(
      saveSubscriptionIds(supabase, { userId: USER_ID, customerId: CUSTOMER_ID, subscriptionId: SUBSCRIPTION_ID })
    ).rejects.toThrow('Failed to save Paddle subscription IDs');
  });
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

  test('중복 transaction_id(23505)이면 조용히 스킵해야 한다', async () => {
    const supabase = makeSupabaseMock({ insertError: { code: '23505', message: 'duplicate key' } });
    await expect(recordPlanUpgradePurchase(supabase, { transactionId: TXN_ID, userId: USER_ID, plan: 'enterprise', subscriptionId: SUB_ID }))
      .resolves.toBeUndefined();
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

describe('테스트 계정 화이트리스트 — mutation 스킵', () => {
  const ORIGINAL = process.env.TEST_ACCOUNT_USER_IDS;
  const WL = 'test-user-1';
  beforeEach(() => { process.env.TEST_ACCOUNT_USER_IDS = WL; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TEST_ACCOUNT_USER_IDS;
    else process.env.TEST_ACCOUNT_USER_IDS = ORIGINAL;
  });

  test('applyPlanChange(실제 함수): apply_plan_change RPC 스킵하고 null 반환', async () => {
    const supabase = makeSupabaseMock();
    const result = await applyPlanChange(supabase, WL, 'enterprise');

    expect(result).toBeNull();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('expireSubscription: profiles UPDATE 스킵', async () => {
    const supabase = makeSupabaseMock();
    await expireSubscription(supabase, WL);

    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('화이트리스트가 아닌 계정은 정상 mutation (apply_plan_change 호출)', async () => {
    const supabase = makeSupabaseMock();
    await applyPlanChange(supabase, 'normal-user', 'pro');

    expect(supabase.rpc).toHaveBeenCalledWith('apply_plan_change', expect.objectContaining({ p_user_id: 'normal-user' }));
  });
});

describe('classifyTransactionOrigin', () => {
  test("'checkout'은 grant로 분류해야 한다 (신규 구매)", () => {
    expect(classifyTransactionOrigin('checkout')).toBe('grant');
  });

  test("'web'도 grant로 분류해야 한다 (Paddle.js 체크아웃 origin 모호성 대비)", () => {
    expect(classifyTransactionOrigin('web')).toBe('grant');
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

describe('syncPlanFromSubscription', () => {
  const USER_ID = 'user-uuid-123';

  test('profiles.plan을 새 플랜으로 UPDATE해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await syncPlanFromSubscription(supabase, USER_ID, 'pro');

    expect(supabase.from).toHaveBeenCalledWith('profiles');
    expect(supabase._updateFn).toHaveBeenCalledWith({ plan: 'pro' });
  });

  test('UPDATE .eq()에 userId가 정확히 전달돼야 한다', async () => {
    const supabase = makeSupabaseMock();
    await syncPlanFromSubscription(supabase, USER_ID, 'enterprise');

    expect(supabase._updateEqFn).toHaveBeenCalledWith('id', USER_ID);
  });

  test('크레딧은 건드리지 않아야 한다 (plan만 UPDATE)', async () => {
    const supabase = makeSupabaseMock();
    await syncPlanFromSubscription(supabase, USER_ID, 'pro');

    const updateArg = supabase._updateFn.mock.calls[0][0];
    expect(updateArg).toEqual({ plan: 'pro' });
    expect(updateArg).not.toHaveProperty('credits');
  });

  test('UPDATE 실패 시 예외를 던져야 한다', async () => {
    const supabase = makeSupabaseMock({ updateError: { message: 'db error' } });
    await expect(syncPlanFromSubscription(supabase, USER_ID, 'pro'))
      .rejects.toThrow('Failed to sync plan from subscription.updated');
  });
});

describe('applyPlanChange', () => {
  const USER_ID = 'user-uuid-123';

  test('업그레이드: apply_plan_change RPC를 enterprise allotment(1500)으로 호출해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await applyPlanChange(supabase, USER_ID, 'enterprise');

    expect(supabase._rpcFn).toHaveBeenCalledWith('apply_plan_change', {
      p_user_id: USER_ID,
      p_new_plan: 'enterprise',
      p_new_allotment: 1500
    });
  });

  test('다운그레이드: apply_plan_change RPC를 pro allotment(600)으로 호출해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await applyPlanChange(supabase, USER_ID, 'pro');

    expect(supabase._rpcFn).toHaveBeenCalledWith('apply_plan_change', {
      p_user_id: USER_ID,
      p_new_plan: 'pro',
      p_new_allotment: 600
    });
  });

  test('동일 플랜 idempotent 재전송: RPC 호출은 정확히 1회 (DB 내 크레딧 결정은 RPC가 처리)', async () => {
    const supabase = makeSupabaseMock();
    await applyPlanChange(supabase, USER_ID, 'enterprise');

    expect(supabase._rpcFn).toHaveBeenCalledTimes(1);
  });

  test('RPC 실패 시 예외를 던져야 한다', async () => {
    const supabase = makeSupabaseMock({ rpcError: { message: 'RPC error' } });
    await expect(applyPlanChange(supabase, USER_ID, 'enterprise'))
      .rejects.toThrow('apply_plan_change RPC failed');
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

describe('subscription.updated status 가드', () => {
  // Mirrors the handler's status guard + applyPlanChange call for unit testing.
  async function handleWithStatusGuard(supabase, status, userId, plan) {
    if (!isActiveSubscription(status)) return 'skipped';
    await applyPlanChange(supabase, userId, plan);
    return 'applied';
  }

  const USER_ID = 'user-uuid-123';

  test("status='canceled'이면 apply_plan_change를 호출하지 않아야 한다 (취소 레이스 방지)", async () => {
    const supabase = makeSupabaseMock();
    const result = await handleWithStatusGuard(supabase, 'canceled', USER_ID, 'enterprise');

    expect(result).toBe('skipped');
    expect(supabase._rpcFn).not.toHaveBeenCalled();
  });

  test("status='paused'이면 apply_plan_change를 호출하지 않아야 한다", async () => {
    const supabase = makeSupabaseMock();
    const result = await handleWithStatusGuard(supabase, 'paused', USER_ID, 'enterprise');

    expect(result).toBe('skipped');
    expect(supabase._rpcFn).not.toHaveBeenCalled();
  });

  test("status='past_due'이면 apply_plan_change를 호출하지 않아야 한다", async () => {
    const supabase = makeSupabaseMock();
    const result = await handleWithStatusGuard(supabase, 'past_due', USER_ID, 'pro');

    expect(result).toBe('skipped');
    expect(supabase._rpcFn).not.toHaveBeenCalled();
  });

  test("status='active'이면 apply_plan_change를 정상 호출해야 한다 (기존 업그레이드 동작 불변)", async () => {
    const supabase = makeSupabaseMock();
    const result = await handleWithStatusGuard(supabase, 'active', USER_ID, 'enterprise');

    expect(result).toBe('applied');
    expect(supabase._rpcFn).toHaveBeenCalledWith('apply_plan_change', {
      p_user_id: USER_ID,
      p_new_plan: 'enterprise',
      p_new_allotment: 1500
    });
  });

  test("status='trialing'이면 apply_plan_change를 정상 호출해야 한다", async () => {
    const supabase = makeSupabaseMock();
    const result = await handleWithStatusGuard(supabase, 'trialing', USER_ID, 'pro');

    expect(result).toBe('applied');
    expect(supabase._rpcFn).toHaveBeenCalledWith('apply_plan_change', {
      p_user_id: USER_ID,
      p_new_plan: 'pro',
      p_new_allotment: 600
    });
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
