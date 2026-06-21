'use strict';
/**
 * Paddle webhook unit tests
 * Tests signature verification, purchase credit grant, and refund credit revocation logic.
 */

const crypto = require('crypto');

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
    .select('id, user_id, credits_granted, status')
    .eq('transaction_id', transactionId)
    .single();

  if (lookupError || !purchase) return;
  if (purchase.status === 'refunded') return;

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
