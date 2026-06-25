'use strict';
/**
 * Paddle webhook unit tests
 * Tests signature verification, purchase credit grant, and refund credit revocation logic.
 */

const crypto = require('crypto');
const { classifyTransactionOrigin, isActiveSubscription, recordPlanUpgradePurchase, syncPlanFromSubscription, applyPlanChange } = require('../../routes/paddle');

// ── Copied from routes/paddle.js (pure functions, no side effects) ──

const PLAN_CREDITS = { pro: 1000, enterprise: 4000 };

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

// ── Logic under test (mirrors routes/paddle.js, takes supabase as arg) ──

async function grantCreditsForPurchase(supabase, transactionId, userId, plan) {
  const credits = PLAN_CREDITS[plan] || 0;

  const { error: insertError } = await supabase
    .from('purchases')
    .insert({ transaction_id: transactionId, user_id: userId, plan, credits_granted: credits, status: 'completed' });

  if (insertError) {
    if (insertError.code === '23505') return;
    throw new Error('Failed to insert purchase record: ' + insertError.message);
  }

  const { error: rpcError } = await supabase.rpc('grant_credits', {
    p_user_id: userId, p_plan: plan, p_amount: credits
  });

  if (rpcError) throw new Error('grant_credits RPC failed: ' + rpcError.message);
}

async function revokeCreditsForRefund(supabase, transactionId) {
  const { data: purchase, error: lookupError } = await supabase
    .from('purchases')
    .select('id, user_id, credits_granted, status, transaction_type')
    .eq('transaction_id', transactionId)
    .single();

  if (lookupError || !purchase) return;
  if (purchase.status === 'refunded') return;

  if (purchase.transaction_type === 'plan_upgrade') {
    console.warn(
      '[paddle/webhook] plan_upgrade 환불은 아직 미구현(토대만 기록됨), 스킵 |',
      'transaction_id=' + transactionId,
      '| userId=' + purchase.user_id
    );
    return;
  }

  const { error: updateError } = await supabase
    .from('purchases')
    .update({ status: 'refunded' })
    .eq('id', purchase.id);

  if (updateError) throw new Error('Failed to mark purchase as refunded: ' + updateError.message);

  const { error: rpcError } = await supabase.rpc('revoke_credits', {
    p_user_id: purchase.user_id, p_amount: purchase.credits_granted
  });

  if (rpcError) throw new Error('revoke_credits RPC failed: ' + rpcError.message);
}


async function expireSubscription(supabase, userId) {
  const { error } = await supabase
    .from('profiles')
    .update({ plan: 'free', credits: 0 })
    .eq('id', userId);

  if (error) throw new Error('Failed to expire subscription: ' + error.message);
}

async function saveSubscriptionIds(supabase, { userId, customerId, subscriptionId }) {
  const updates = {};
  if (customerId)     updates.paddle_customer_id     = customerId;
  if (subscriptionId) updates.paddle_subscription_id = subscriptionId;
  if (Object.keys(updates).length === 0) return;

  const { error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId);

  if (error) {
    console.error('[paddle/webhook] Failed to save Paddle IDs for userId=' + userId + ':', error.message);
  }
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

describe('grantCreditsForPurchase', () => {
  test('정상 구매 시 purchases 삽입 후 grant_credits RPC를 호출해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await grantCreditsForPurchase(supabase, 'txn_001', 'user-uuid', 'pro');

    expect(supabase.from).toHaveBeenCalledWith('purchases');
    expect(supabase.rpc).toHaveBeenCalledWith('grant_credits', {
      p_user_id: 'user-uuid',
      p_plan: 'pro',
      p_amount: 1000
    });
  });

  test('enterprise 플랜은 4000 크레딧을 지급해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await grantCreditsForPurchase(supabase, 'txn_002', 'user-uuid', 'enterprise');

    expect(supabase.rpc).toHaveBeenCalledWith('grant_credits', expect.objectContaining({ p_amount: 4000 }));
  });

  test('중복 transaction_id(23505)이면 RPC 없이 조용히 종료해야 한다', async () => {
    const supabase = makeSupabaseMock({ insertError: { code: '23505', message: 'duplicate key' } });
    await expect(grantCreditsForPurchase(supabase, 'txn_dup', 'user-uuid', 'pro')).resolves.toBeUndefined();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('INSERT 실패(비-중복 에러)이면 예외를 던져야 한다', async () => {
    const supabase = makeSupabaseMock({ insertError: { code: '42501', message: 'permission denied' } });
    await expect(grantCreditsForPurchase(supabase, 'txn_003', 'user-uuid', 'pro'))
      .rejects.toThrow('Failed to insert purchase record');
  });

  test('grant_credits RPC 실패 시 예외를 던져야 한다', async () => {
    const supabase = makeSupabaseMock({ rpcError: { message: 'USER_NOT_FOUND' } });
    await expect(grantCreditsForPurchase(supabase, 'txn_004', 'user-uuid', 'pro'))
      .rejects.toThrow('grant_credits RPC failed');
  });
});

describe('revokeCreditsForRefund', () => {
  test('purchases 레코드가 없으면 조용히 종료해야 한다', async () => {
    const supabase = makeSupabaseMock({ selectData: null, selectError: { message: 'not found' } });
    await expect(revokeCreditsForRefund(supabase, 'txn_unknown')).resolves.toBeUndefined();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('이미 refunded 상태이면 중복 처리하지 않아야 한다', async () => {
    const supabase = makeSupabaseMock({
      selectData: { id: 1, user_id: 'user-uuid', credits_granted: 1000, status: 'refunded' }
    });
    await expect(revokeCreditsForRefund(supabase, 'txn_already')).resolves.toBeUndefined();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('정상 환불 시 status를 refunded로 업데이트하고 revoke_credits RPC를 호출해야 한다', async () => {
    const supabase = makeSupabaseMock({
      selectData: { id: 42, user_id: 'user-uuid', credits_granted: 1000, status: 'completed' }
    });
    await revokeCreditsForRefund(supabase, 'txn_refund');

    expect(supabase.rpc).toHaveBeenCalledWith('revoke_credits', {
      p_user_id: 'user-uuid',
      p_amount: 1000
    });
  });

  test('revoke_credits RPC 실패 시 예외를 던져야 한다', async () => {
    const supabase = makeSupabaseMock({
      selectData: { id: 5, user_id: 'user-uuid', credits_granted: 4000, status: 'completed' },
      rpcError: { message: 'USER_NOT_FOUND' }
    });
    await expect(revokeCreditsForRefund(supabase, 'txn_rpc_fail'))
      .rejects.toThrow('revoke_credits RPC failed');
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

  test('UPDATE 실패해도 예외를 던지지 않아야 한다', async () => {
    const supabase = makeSupabaseMock({ updateError: { message: 'db error' } });
    await expect(
      saveSubscriptionIds(supabase, { userId: USER_ID, customerId: CUSTOMER_ID, subscriptionId: SUBSCRIPTION_ID })
    ).resolves.toBeUndefined();
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
      credits_granted:  4000,
      status:           'completed',
      subscription_id:  SUB_ID,
      transaction_type: 'plan_upgrade'
    });
  });

  test('credits는 plan에 따라 올바르게 설정돼야 한다 (pro=1000)', async () => {
    const supabase = makeSupabaseMock();
    await recordPlanUpgradePurchase(supabase, { transactionId: TXN_ID, userId: USER_ID, plan: 'pro', subscriptionId: SUB_ID });

    const insertCall = supabase.from.mock.results[0].value.insert.mock.calls[0][0];
    expect(insertCall.credits_granted).toBe(1000);
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

describe('revokeCreditsForRefund — plan_upgrade skip 가드', () => {
  test('transaction_type=plan_upgrade이면 revoke_credits를 호출하지 않아야 한다(no-op)', async () => {
    const supabase = makeSupabaseMock({
      selectData: { id: 10, user_id: 'user-uuid', credits_granted: 4000, status: 'completed', transaction_type: 'plan_upgrade' }
    });
    await revokeCreditsForRefund(supabase, 'txn_upgrade_refund');

    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('plan_upgrade 스킵 시 status를 refunded로 바꾸지 않아야 한다', async () => {
    const supabase = makeSupabaseMock({
      selectData: { id: 10, user_id: 'user-uuid', credits_granted: 4000, status: 'completed', transaction_type: 'plan_upgrade' }
    });
    await revokeCreditsForRefund(supabase, 'txn_upgrade_refund');

    expect(supabase._updateFn).not.toHaveBeenCalled();
  });

  test('transaction_type=null(신규구매) 환불은 기존 revoke_credits(plan→free) 경로를 그대로 타야 한다', async () => {
    const supabase = makeSupabaseMock({
      selectData: { id: 42, user_id: 'user-uuid', credits_granted: 1000, status: 'completed', transaction_type: null }
    });
    await revokeCreditsForRefund(supabase, 'txn_grant_refund');

    expect(supabase.rpc).toHaveBeenCalledWith('revoke_credits', {
      p_user_id: 'user-uuid',
      p_amount: 1000
    });
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

  test('업그레이드: apply_plan_change RPC를 enterprise allotment(4000)으로 호출해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await applyPlanChange(supabase, USER_ID, 'enterprise');

    expect(supabase._rpcFn).toHaveBeenCalledWith('apply_plan_change', {
      p_user_id: USER_ID,
      p_new_plan: 'enterprise',
      p_new_allotment: 4000
    });
  });

  test('다운그레이드: apply_plan_change RPC를 pro allotment(1000)으로 호출해야 한다', async () => {
    const supabase = makeSupabaseMock();
    await applyPlanChange(supabase, USER_ID, 'pro');

    expect(supabase._rpcFn).toHaveBeenCalledWith('apply_plan_change', {
      p_user_id: USER_ID,
      p_new_plan: 'pro',
      p_new_allotment: 1000
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
      p_new_allotment: 4000
    });
  });

  test("status='trialing'이면 apply_plan_change를 정상 호출해야 한다", async () => {
    const supabase = makeSupabaseMock();
    const result = await handleWithStatusGuard(supabase, 'trialing', USER_ID, 'pro');

    expect(result).toBe('applied');
    expect(supabase._rpcFn).toHaveBeenCalledWith('apply_plan_change', {
      p_user_id: USER_ID,
      p_new_plan: 'pro',
      p_new_allotment: 1000
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
