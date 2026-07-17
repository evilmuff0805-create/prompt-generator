'use strict';

const {
  parseApiJson,
  parsePlanPreview,
  calcCreditWarning,
  createPlanPoller,
  PLAN_CREDIT_LIMIT,
} = require('../../public/js/changePlan-helpers');

describe('parseApiJson', () => {
  test('정상 JSON object를 그대로 반환', () => {
    expect(parseApiJson('{"success":true,"data":{"amount":999}}')).toEqual({
      success: true,
      data: { amount: 999 }
    });
  });

  test.each([
    ['HTML gateway error', '<!DOCTYPE html><h1>Bad Gateway</h1>'],
    ['빈 응답', ''],
    ['JSON primitive', 'null']
  ])('%s는 안전한 일반 오류로 변환', (_, body) => {
    expect(parseApiJson(body, 'Could not load plan details.')).toEqual({
      success: false,
      error: 'Could not load plan details.',
      code: 'INVALID_RESPONSE'
    });
  });

  test('서버가 보낸 JSON 오류와 code는 보존', () => {
    expect(parseApiJson('{"success":false,"error":"Inactive","code":"NO_SUBSCRIPTION"}')).toEqual({
      success: false,
      error: 'Inactive',
      code: 'NO_SUBSCRIPTION'
    });
  });
});

// ── parsePlanPreview ─────────────────────────────────────────────────────────

describe('parsePlanPreview', () => {
  const UPGRADE_FIXTURE = {
    currency_code: 'USD',
    immediate_transaction: {
      details: { totals: { grand_total: '918' } }
    },
    recurring_transaction_details: {
      totals: { grand_total: '1999' }
    }
  };

  test('업그레이드: immediate + recurring 정상 파싱 (센트→달러)', () => {
    const result = parsePlanPreview(UPGRADE_FIXTURE);
    expect(result.immediateAmount).toBeCloseTo(9.18);
    expect(result.recurringAmount).toBeCloseTo(19.99);
    expect(result.currency).toBe('USD');
    expect(result.immediateApplicable).toBe(true);
  });

  test('immediate_transaction 없는 응답(다운그레이드 패턴): immediateApplicable=false', () => {
    const data = {
      currency_code: 'USD',
      immediate_transaction: null,
      recurring_transaction_details: { totals: { grand_total: '999' } }
    };
    const result = parsePlanPreview(data);
    expect(result.immediateApplicable).toBe(false);
    expect(result.immediateAmount).toBeNull();
    expect(result.recurringAmount).toBeCloseTo(9.99);
  });

  test('immediate grand_total이 0인 경우: immediateApplicable=false', () => {
    const data = {
      currency_code: 'USD',
      immediate_transaction: { details: { totals: { grand_total: '0' } } },
      recurring_transaction_details: { totals: { grand_total: '999' } }
    };
    const result = parsePlanPreview(data);
    expect(result.immediateApplicable).toBe(false);
    expect(result.immediateAmount).toBe(0);
  });

  test('data가 null이면 null 반환', () => {
    expect(parsePlanPreview(null)).toBeNull();
  });

  test('currency_code 없으면 USD 기본값', () => {
    const data = {
      immediate_transaction: { details: { totals: { grand_total: '100' } } },
      recurring_transaction_details: { totals: { grand_total: '999' } }
    };
    expect(parsePlanPreview(data).currency).toBe('USD');
  });
});

// ── calcCreditWarning ────────────────────────────────────────────────────────

describe('calcCreditWarning', () => {
  test('크레딧이 목표 한도 초과 → show=true, to=min(현재, 한도)', () => {
    const result = calcCreditWarning(2500, 'pro');
    expect(result.show).toBe(true);
    expect(result.from).toBe(2500);
    expect(result.to).toBe(1000);   // Math.min(2500, 1000)
  });

  test('크레딧이 목표 한도 이하 → show=false (안 줄어듦)', () => {
    const result = calcCreditWarning(400, 'pro');
    expect(result.show).toBe(false);
    expect(result.to).toBe(400);    // Math.min(400, 1000) = 400
  });

  test('크레딧이 정확히 한도와 같을 때 → show=false', () => {
    const result = calcCreditWarning(1000, 'pro');
    expect(result.show).toBe(false);
    expect(result.to).toBe(1000);
  });

  test('paid는 pro와 동일한 한도(1000) 적용', () => {
    expect(PLAN_CREDIT_LIMIT['paid']).toBe(1000);
    const result = calcCreditWarning(1500, 'paid');
    expect(result.show).toBe(true);
    expect(result.to).toBe(1000);
  });

  test('알 수 없는 targetPlan → show=false, 크레딧 유지', () => {
    const result = calcCreditWarning(999, 'unknown');
    expect(result.show).toBe(false);
    expect(result.to).toBe(999);
  });

  test('enterprise 업그레이드 시 크레딧 경고 없음 (한도 4000이 현재보다 높음)', () => {
    const result = calcCreditWarning(1000, 'enterprise');
    expect(result.show).toBe(false);
  });

  test('서버 카탈로그 한도가 전달되면 정적 fallback보다 우선해야 한다', () => {
    const result = calcCreditWarning(1500, 'pro', 1200);
    expect(result).toEqual({ show: true, from: 1500, to: 1200 });
  });
});

// ── createPlanPoller ─────────────────────────────────────────────────────────

describe('createPlanPoller', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('checkFn이 targetPlan을 반환하면 onDone 호출 후 중단', async () => {
    const checkFn = jest.fn().mockResolvedValue('enterprise');
    const onDone    = jest.fn();
    const onTimeout = jest.fn();

    createPlanPoller(checkFn, 'enterprise', { maxAttempts: 5, intervalMs: 2000, onDone, onTimeout });

    await jest.runAllTimersAsync();

    expect(checkFn).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test('maxAttempts 초과 시 onTimeout 호출', async () => {
    const checkFn = jest.fn().mockResolvedValue('pro');  // 항상 다른 값
    const onDone    = jest.fn();
    const onTimeout = jest.fn();

    createPlanPoller(checkFn, 'enterprise', { maxAttempts: 3, intervalMs: 1000, onDone, onTimeout });

    await jest.runAllTimersAsync();

    expect(checkFn).toHaveBeenCalledTimes(3);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  test('cancel() 호출 시 이후 폴링 중단', async () => {
    const checkFn = jest.fn().mockResolvedValue('pro');
    const onTimeout = jest.fn();

    const cancel = createPlanPoller(checkFn, 'enterprise', {
      maxAttempts: 5, intervalMs: 1000, onTimeout
    });

    // 1회 tick 후 cancel
    await jest.advanceTimersByTimeAsync(1000);
    expect(checkFn).toHaveBeenCalledTimes(1);

    cancel();

    await jest.advanceTimersByTimeAsync(10000);
    expect(checkFn).toHaveBeenCalledTimes(1);  // 더 이상 증가하지 않음
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test('checkFn 예외 발생해도 폴링 계속되고 timeout 호출', async () => {
    const checkFn = jest.fn().mockRejectedValue(new Error('network'));
    const onTimeout = jest.fn();

    createPlanPoller(checkFn, 'enterprise', { maxAttempts: 2, intervalMs: 500, onTimeout });

    await jest.runAllTimersAsync();

    expect(checkFn).toHaveBeenCalledTimes(2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test('2번째 체크에서 targetPlan 반환 시 onDone, 이후 체크 없음', async () => {
    const checkFn = jest.fn()
      .mockResolvedValueOnce('pro')
      .mockResolvedValueOnce('enterprise');
    const onDone = jest.fn();

    createPlanPoller(checkFn, 'enterprise', { maxAttempts: 5, intervalMs: 1000, onDone });

    await jest.advanceTimersByTimeAsync(1000);
    expect(checkFn).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);
    expect(checkFn).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5000);
    expect(checkFn).toHaveBeenCalledTimes(2);  // 중단됨
  });
});
