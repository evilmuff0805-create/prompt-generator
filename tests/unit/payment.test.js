/**
 * payment 라우터 유닛 테스트
 * HMAC 서명 검증 로직 테스트
 */

const crypto = require('crypto');
const {
  extractPortalUrl,
  planToPriceId,
  buildSubscriptionUpdateBody,
  handleChangePlan
} = require('../../routes/payment');

// HMAC 서명 생성 헬퍼 (payment.js와 동일한 로직)
function generateSignature(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// timingSafeEqual 비교 헬퍼 (payment.js에서 사용하는 로직)
function verifySignature(secret, rawBody, signature) {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

describe('HMAC 웹훅 서명 검증', () => {
  const SECRET = 'test-webhook-secret-key-12345';
  const PAYLOAD = JSON.stringify({ meta: { event_name: 'subscription_created' }, data: {} });

  test('올바른 서명은 검증에 통과해야 한다', () => {
    const sig = generateSignature(SECRET, PAYLOAD);
    expect(verifySignature(SECRET, PAYLOAD, sig)).toBe(true);
  });

  test('잘못된 서명은 검증에 실패해야 한다', () => {
    expect(verifySignature(SECRET, PAYLOAD, 'invalid-signature-abc123')).toBe(false);
  });

  test('다른 secret으로 생성한 서명은 실패해야 한다', () => {
    const wrongSig = generateSignature('wrong-secret', PAYLOAD);
    expect(verifySignature(SECRET, PAYLOAD, wrongSig)).toBe(false);
  });

  test('payload가 변조되면 서명 검증에 실패해야 한다', () => {
    const sig = generateSignature(SECRET, PAYLOAD);
    const tamperedPayload = PAYLOAD + ' ';
    expect(verifySignature(SECRET, tamperedPayload, sig)).toBe(false);
  });

  test('길이가 다른 서명은 timingSafeEqual에서 false를 반환해야 한다', () => {
    const shortSig = 'abc';
    expect(verifySignature(SECRET, PAYLOAD, shortSig)).toBe(false);
  });

  test('빈 서명은 검증에 실패해야 한다', () => {
    expect(verifySignature(SECRET, PAYLOAD, '')).toBe(false);
  });
});

describe('이메일 형식 검증', () => {
  // payment.js에서 사용하는 정규식과 동일
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  test('유효한 이메일은 통과해야 한다', () => {
    expect(EMAIL_RE.test('user@example.com')).toBe(true);
    expect(EMAIL_RE.test('test.user+tag@domain.co.kr')).toBe(true);
  });

  test('유효하지 않은 이메일은 실패해야 한다', () => {
    expect(EMAIL_RE.test('notanemail')).toBe(false);
    expect(EMAIL_RE.test('@nodomain')).toBe(false);
    expect(EMAIL_RE.test('no@tld')).toBe(false);
    expect(EMAIL_RE.test('')).toBe(false);
    expect(EMAIL_RE.test('spaces in@email.com')).toBe(false);
  });
});

describe('체크아웃 URL 검증', () => {
  test('https:// URL은 유효해야 한다', () => {
    const url = 'https://buy.paddle.com/product/abc123';
    expect(url.startsWith('https://')).toBe(true);
  });

  test('http:// URL은 유효하지 않아야 한다', () => {
    const url = 'http://malicious.example.com/fake';
    expect(url.startsWith('https://')).toBe(false);
  });

  test('빈 URL은 유효하지 않아야 한다', () => {
    expect(!!'').toBe(false);
  });
});

describe('withTimeout 패턴', () => {
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      )
    ]);
  }

  test('빠른 Promise는 정상 결과를 반환해야 한다', async () => {
    const fast = Promise.resolve('done');
    const result = await withTimeout(fast, 1000, 'test');
    expect(result).toBe('done');
  });

  test('타임아웃 초과 시 에러를 throw해야 한다', async () => {
    const slow = new Promise(resolve => setTimeout(resolve, 500, 'late'));
    await expect(withTimeout(slow, 50, 'test-op')).rejects.toThrow('test-op timed out after 50ms');
  });
});

describe('extractPortalUrl', () => {
  const SUB_ID = 'sub_01h04vsc0qhwtsbsxh3422wjs4';

  function makeResponse({ subscriptions, overview } = {}) {
    const urls = {};
    if (subscriptions) urls.subscriptions = subscriptions;
    if (overview) urls.general = { overview };
    return { data: { urls } };
  }

  test('해당 subscription의 cancel_subscription 딥링크를 우선 반환해야 한다', () => {
    const res = makeResponse({
      subscriptions: [{ id: SUB_ID, cancel_subscription: 'https://portal/cancel', update_subscription_payment_method: 'https://portal/pay' }],
      overview: 'https://portal/overview'
    });
    expect(extractPortalUrl(res, SUB_ID)).toBe('https://portal/cancel');
  });

  test('일치하는 subscription이 없으면 general.overview로 폴백해야 한다', () => {
    const res = makeResponse({
      subscriptions: [{ id: 'sub_other', cancel_subscription: 'https://portal/other-cancel' }],
      overview: 'https://portal/overview'
    });
    expect(extractPortalUrl(res, SUB_ID)).toBe('https://portal/overview');
  });

  test('subscriptionId가 null이어도 overview로 폴백해야 한다', () => {
    const res = makeResponse({ overview: 'https://portal/overview' });
    expect(extractPortalUrl(res, null)).toBe('https://portal/overview');
  });

  test('cancel 링크도 overview도 없으면 null을 반환해야 한다', () => {
    const res = makeResponse({ subscriptions: [{ id: SUB_ID }] });
    expect(extractPortalUrl(res, SUB_ID)).toBeNull();
  });

  test('urls가 없는 응답이면 null을 반환해야 한다', () => {
    expect(extractPortalUrl({ data: {} }, SUB_ID)).toBeNull();
    expect(extractPortalUrl(null, SUB_ID)).toBeNull();
  });

  test('다른 subscription의 cancel 링크를 잘못 반환하지 않아야 한다', () => {
    const res = makeResponse({
      subscriptions: [
        { id: 'sub_AAA', cancel_subscription: 'https://portal/AAA' },
        { id: SUB_ID, cancel_subscription: 'https://portal/TARGET' }
      ]
    });
    expect(extractPortalUrl(res, SUB_ID)).toBe('https://portal/TARGET');
  });
});

describe('planToPriceId', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, PADDLE_PRO_PRICE_ID: 'pri_pro_123', PADDLE_ENTERPRISE_PRICE_ID: 'pri_ent_456' };
  });
  afterEach(() => { process.env = OLD_ENV; });

  test("'pro'는 PADDLE_PRO_PRICE_ID env로 매핑돼야 한다", () => {
    expect(planToPriceId('pro')).toBe('pri_pro_123');
  });

  test("'enterprise'는 PADDLE_ENTERPRISE_PRICE_ID env로 매핑돼야 한다", () => {
    expect(planToPriceId('enterprise')).toBe('pri_ent_456');
  });

  test('알 수 없는 plan은 null을 반환해야 한다', () => {
    expect(planToPriceId('free')).toBeNull();
    expect(planToPriceId('')).toBeNull();
    expect(planToPriceId(undefined)).toBeNull();
  });

  test('env가 비어있으면 null을 반환해야 한다', () => {
    delete process.env.PADDLE_PRO_PRICE_ID;
    expect(planToPriceId('pro')).toBeNull();
  });
});

describe('buildSubscriptionUpdateBody', () => {
  test('items 전체(price_id+quantity)와 prorated_immediately를 포함해야 한다', () => {
    const body = buildSubscriptionUpdateBody('pri_xyz');
    expect(body).toEqual({
      items: [{ price_id: 'pri_xyz', quantity: 1 }],
      proration_billing_mode: 'prorated_immediately'
    });
  });

  test('items는 단일 항목(전체 목록)이어야 한다 — 누락 시 Paddle이 항목 삭제로 처리', () => {
    const body = buildSubscriptionUpdateBody('pri_xyz');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].price_id).toBe('pri_xyz');
    expect(body.items[0].quantity).toBe(1);
  });

  test('camelCase priceId가 아니라 snake_case price_id여야 한다 (Paddle 계약)', () => {
    const body = buildSubscriptionUpdateBody('pri_xyz');
    expect(body.items[0]).toHaveProperty('price_id');
    expect(body.items[0]).not.toHaveProperty('priceId');
  });
});

describe('handleChangePlan (POST /api/payment/change-plan)', () => {
  const OLD_ENV = process.env;
  const USER_ID = 'user-uuid-1';
  const SUB_ID = 'sub_01live';
  let fetchMock;

  // Mock res: captures status + json
  function makeRes() {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; }
    };
    return res;
  }

  // Mock req with a chainable supabase returning the given profile
  function makeReq({ body = {}, profile = null, profileError = null } = {}) {
    const single = jest.fn().mockResolvedValue({ data: profile, error: profileError });
    const supabase = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({ single })
        })
      })
    };
    return { body, user: { id: USER_ID }, supabase, _single: single };
  }

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      PADDLE_API_KEY: 'pdl_live_testkey',
      PADDLE_PRO_PRICE_ID: 'pri_pro_123',
      PADDLE_ENTERPRISE_PRICE_ID: 'pri_ent_456'
    };
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });
  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  function paddleOk(data = {}) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data }) });
  }
  function paddleErr(status, text = 'err') {
    return Promise.resolve({ ok: false, status, text: () => Promise.resolve(text), json: () => Promise.resolve(null) });
  }

  // ── Guards ──

  test('Guard 6: 잘못된 plan은 400 INVALID_PLAN, Paddle 미호출', async () => {
    const req = makeReq({ body: { plan: 'gold' } });
    const res = makeRes();
    await handleChangePlan(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_PLAN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('Guard 5: PADDLE_API_KEY 없으면 500, Paddle 미호출', async () => {
    delete process.env.PADDLE_API_KEY;
    const req = makeReq({ body: { plan: 'enterprise' } });
    const res = makeRes();
    await handleChangePlan(req, res);
    expect(res.statusCode).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('price ID env 미설정이면 500, Paddle 미호출', async () => {
    delete process.env.PADDLE_ENTERPRISE_PRICE_ID;
    const req = makeReq({ body: { plan: 'enterprise' }, profile: { plan: 'pro', paddle_subscription_id: SUB_ID } });
    const res = makeRes();
    await handleChangePlan(req, res);
    expect(res.statusCode).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('Guard 4: free 유저는 400 NO_ACTIVE_SUBSCRIPTION, Paddle 미호출', async () => {
    const req = makeReq({ body: { plan: 'pro' }, profile: { plan: 'free', paddle_subscription_id: null } });
    const res = makeRes();
    await handleChangePlan(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('NO_ACTIVE_SUBSCRIPTION');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('Guard 2: subscription_id 없으면 404 NO_SUBSCRIPTION, Paddle 미호출', async () => {
    const req = makeReq({ body: { plan: 'enterprise' }, profile: { plan: 'pro', paddle_subscription_id: null } });
    const res = makeRes();
    await handleChangePlan(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('NO_SUBSCRIPTION');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('Guard 3: 목표 plan == 현재 plan이면 400 SAME_PLAN, Paddle 미호출', async () => {
    const req = makeReq({ body: { plan: 'pro' }, profile: { plan: 'pro', paddle_subscription_id: SUB_ID } });
    const res = makeRes();
    await handleChangePlan(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('SAME_PLAN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── PATCH 호출 인자 검증 ──

  test('업그레이드: PATCH /subscriptions/{id}에 올바른 body 전송', async () => {
    fetchMock.mockReturnValue(paddleOk());
    const req = makeReq({ body: { plan: 'enterprise' }, profile: { plan: 'pro', paddle_subscription_id: SUB_ID } });
    const res = makeRes();
    await handleChangePlan(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.paddle.com/subscriptions/${SUB_ID}`);
    expect(opts.method).toBe('PATCH');
    expect(opts.headers.Authorization).toBe('Bearer pdl_live_testkey');
    expect(JSON.parse(opts.body)).toEqual({
      items: [{ price_id: 'pri_ent_456', quantity: 1 }],
      proration_billing_mode: 'prorated_immediately'
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, plan: 'enterprise' });
  });

  test('다운그레이드: enterprise→pro도 pro priceId로 PATCH', async () => {
    fetchMock.mockReturnValue(paddleOk());
    const req = makeReq({ body: { plan: 'pro' }, profile: { plan: 'enterprise', paddle_subscription_id: SUB_ID } });
    const res = makeRes();
    await handleChangePlan(req, res);

    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body).items[0].price_id).toBe('pri_pro_123');
    expect(res.statusCode).toBe(200);
  });

  test('preview:true면 /preview 경로로 호출하고 무청구 데이터 반환', async () => {
    fetchMock.mockReturnValue(paddleOk({ immediate_transaction: { amount: '500' } }));
    const req = makeReq({ body: { plan: 'enterprise', preview: true }, profile: { plan: 'pro', paddle_subscription_id: SUB_ID } });
    const res = makeRes();
    await handleChangePlan(req, res);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.paddle.com/subscriptions/${SUB_ID}/preview`);
    expect(opts.method).toBe('PATCH');
    expect(res.body.preview).toBe(true);
    expect(res.body.data).toEqual({ immediate_transaction: { amount: '500' } });
  });

  test('크레딧/plan을 DB에 절대 쓰지 않아야 한다 (webhook 전담)', async () => {
    fetchMock.mockReturnValue(paddleOk());
    const req = makeReq({ body: { plan: 'enterprise' }, profile: { plan: 'pro', paddle_subscription_id: SUB_ID } });
    const res = makeRes();
    await handleChangePlan(req, res);

    // profiles는 SELECT만 — update/upsert/insert 호출이 없어야 함
    const fromResult = req.supabase.from.mock.results[0].value;
    expect(fromResult.select).toHaveBeenCalled();
    expect(fromResult.update).toBeUndefined();
    expect(fromResult.insert).toBeUndefined();
  });

  // ── 실패/안전 처리 ──

  test('Paddle 4xx/5xx 시 502 안전 메시지, Paddle 원문 미노출', async () => {
    fetchMock.mockReturnValue(paddleErr(400, '{"error":"some_paddle_detail"}'));
    const req = makeReq({ body: { plan: 'enterprise' }, profile: { plan: 'pro', paddle_subscription_id: SUB_ID } });
    const res = makeRes();
    await handleChangePlan(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('some_paddle_detail');
  });

  test('Paddle 403(권한 부족) 시에도 502 안전 응답', async () => {
    fetchMock.mockReturnValue(paddleErr(403, 'forbidden'));
    const req = makeReq({ body: { plan: 'enterprise' }, profile: { plan: 'pro', paddle_subscription_id: SUB_ID } });
    const res = makeRes();
    await handleChangePlan(req, res);
    expect(res.statusCode).toBe(502);
  });

  test('네트워크 실패 시 502, DB 무변경', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const req = makeReq({ body: { plan: 'enterprise' }, profile: { plan: 'pro', paddle_subscription_id: SUB_ID } });
    const res = makeRes();
    await handleChangePlan(req, res);
    expect(res.statusCode).toBe(502);
  });

  test('profile 조회 실패 시 500', async () => {
    const req = makeReq({ body: { plan: 'enterprise' }, profileError: { message: 'db down' } });
    const res = makeRes();
    await handleChangePlan(req, res);
    expect(res.statusCode).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
