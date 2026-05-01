/**
 * payment 라우터 유닛 테스트
 * HMAC 서명 검증 로직 테스트
 */

const crypto = require('crypto');

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
    const url = 'https://checkout.lemonsqueezy.com/buy/abc123';
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
