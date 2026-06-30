'use strict';
/**
 * Storyboard safety + rate-limit tests.
 * - Problem 2: category-selective moderation (real lib/moderation.js, openai-client mocked).
 * - Problem 3: rate-limit rollback so failed/blocked attempts don't consume the cooldown.
 */

// Mock openai-client so requiring lib/moderation does not hit its OPENAI_TEXT_MODEL
// top-level env check, and so we control moderateText/moderateImage results.
jest.mock('../../lib/openai-client', () => ({
  moderateText: jest.fn(),
  moderateImage: jest.fn()
}));

const { moderateText, moderateImage } = require('../../lib/openai-client');
const { moderateContent, hasBlockedCategory, BLOCKED_CATEGORIES } = require('../../lib/moderation');

// All categories false except the ones passed in.
function cats(overrides = {}) {
  const base = {
    sexual: false, 'sexual/minors': false,
    'self-harm': false, 'self-harm/intent': false, 'self-harm/instructions': false,
    violence: false, 'violence/graphic': false,
    harassment: false, 'harassment/threatening': false,
    hate: false, 'hate/threatening': false,
    illicit: false, 'illicit/violent': false
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  moderateText.mockReset();
  moderateImage.mockReset();
});

describe('hasBlockedCategory — 차단 대상 카테고리 선별', () => {
  test('차단 목록은 정확히 sexual / sexual:minors / self-harm 계열이어야 한다', () => {
    expect(BLOCKED_CATEGORIES).toEqual([
      'sexual', 'sexual/minors', 'self-harm', 'self-harm/intent', 'self-harm/instructions'
    ]);
  });

  test('sexual=true면 차단', () => {
    expect(hasBlockedCategory(cats({ sexual: true }))).toBe(true);
  });

  test('sexual/minors=true면 차단 (절대 통과 금지)', () => {
    expect(hasBlockedCategory(cats({ 'sexual/minors': true }))).toBe(true);
  });

  test('self-harm 계열(self-harm, /intent, /instructions) 각각 true면 차단', () => {
    expect(hasBlockedCategory(cats({ 'self-harm': true }))).toBe(true);
    expect(hasBlockedCategory(cats({ 'self-harm/intent': true }))).toBe(true);
    expect(hasBlockedCategory(cats({ 'self-harm/instructions': true }))).toBe(true);
  });

  test('violence / violence-graphic는 true여도 통과 (창작 전투 허용)', () => {
    expect(hasBlockedCategory(cats({ violence: true, 'violence/graphic': true }))).toBe(false);
  });

  test('harassment / hate / illicit 계열은 true여도 통과', () => {
    expect(hasBlockedCategory(cats({ harassment: true, 'harassment/threatening': true }))).toBe(false);
    expect(hasBlockedCategory(cats({ hate: true, 'hate/threatening': true }))).toBe(false);
    expect(hasBlockedCategory(cats({ illicit: true, 'illicit/violent': true }))).toBe(false);
  });

  test('전부 false / undefined면 통과', () => {
    expect(hasBlockedCategory(cats())).toBe(false);
    expect(hasBlockedCategory(undefined)).toBe(false);
  });
});

describe('moderateContent — 카테고리 기반 차단 정책', () => {
  test('검·전투(violence만 flagged) 시나리오는 통과해야 한다 (문제 2의 핵심)', async () => {
    moderateText.mockResolvedValue({ flagged: true, categories: cats({ violence: true }) });
    const res = await moderateContent({ text: '19세기 숲, 은발 중년 남성이 대검으로 거대 늑대와 전투' });
    expect(res).toEqual({ flagged: false, reason: null });
  });

  test('sexual/minors는 차단(text_flagged)', async () => {
    moderateText.mockResolvedValue({ flagged: true, categories: cats({ 'sexual/minors': true }) });
    const res = await moderateContent({ text: 'x'.repeat(60) });
    expect(res).toEqual({ flagged: true, reason: 'text_flagged' });
  });

  test('self-harm은 차단(text_flagged)', async () => {
    moderateText.mockResolvedValue({ flagged: true, categories: cats({ 'self-harm': true }) });
    const res = await moderateContent({ text: 'x'.repeat(60) });
    expect(res.flagged).toBe(true);
    expect(res.reason).toBe('text_flagged');
  });

  test('moderateText 예외 → fail-closed(moderation_error)', async () => {
    moderateText.mockRejectedValue(new Error('timeout'));
    const res = await moderateContent({ text: 'x'.repeat(60) });
    expect(res).toEqual({ flagged: true, reason: 'moderation_error' });
  });

  test('이미지: 차단 카테고리면 image_flagged, violence만이면 통과', async () => {
    moderateImage.mockResolvedValueOnce({ flagged: true, categories: cats({ sexual: true }) });
    const blocked = await moderateContent({ text: '', imageUrl: 'data:image/png;base64,AAA' });
    expect(blocked).toEqual({ flagged: true, reason: 'image_flagged' });

    moderateImage.mockResolvedValueOnce({ flagged: true, categories: cats({ violence: true }) });
    const passed = await moderateContent({ text: '', imageUrl: 'data:image/png;base64,AAA' });
    expect(passed).toEqual({ flagged: false, reason: null });
  });
});

// ── Problem 3: rate-limit rollback (mirrors routes/storyboard.js logic) ──
describe('rate limit — 실패/차단 시 쿨다운 롤백', () => {
  let rateLimitMap;
  const WINDOW = 60;

  function checkRateLimit(userId, action, windowSeconds, now) {
    const key = `${userId}:${action}`;
    const entry = rateLimitMap.get(key);
    if (entry && now - entry.ts < windowSeconds * 1000) return false;
    rateLimitMap.set(key, { ts: now });
    return true;
  }
  function clearRateLimit(userId, action) {
    rateLimitMap.delete(`${userId}:${action}`);
  }

  // Mirror of the /generate flag flow: stamp at gate, roll back unless committed.
  function runGenerate(userId, { outcome }, now) {
    let rateLimitStamped = false;
    let rateLimitCommitted = false;
    try {
      if (!checkRateLimit(userId, 'storyboard_generate', WINDOW, now)) {
        return 'RATE_LIMITED';
      }
      rateLimitStamped = true;
      if (outcome === 'moderation') return 'MODERATION_REJECTED';
      if (outcome === 'invalid') return 'INVALID_INPUT';
      if (outcome === 'throw') throw new Error('boom');
      rateLimitCommitted = true; // success
      return 'OK';
    } catch (e) {
      return 'INTERNAL_ERROR';
    } finally {
      if (rateLimitStamped && !rateLimitCommitted) clearRateLimit(userId, 'storyboard_generate');
    }
  }

  beforeEach(() => { rateLimitMap = new Map(); });

  test('moderation 차단 후 즉시 재시도 가능해야 한다 (쿨다운 안 먹음)', () => {
    expect(runGenerate('u1', { outcome: 'moderation' }, 1000)).toBe('MODERATION_REJECTED');
    // 1ms later — would be blocked if cooldown had stuck
    expect(runGenerate('u1', { outcome: 'ok' }, 1001)).toBe('OK');
  });

  test('검증 실패도 쿨다운 안 먹음', () => {
    expect(runGenerate('u1', { outcome: 'invalid' }, 1000)).toBe('INVALID_INPUT');
    expect(runGenerate('u1', { outcome: 'ok' }, 1001)).toBe('OK');
  });

  test('예외(500)도 쿨다운 안 먹음', () => {
    expect(runGenerate('u1', { outcome: 'throw' }, 1000)).toBe('INTERNAL_ERROR');
    expect(runGenerate('u1', { outcome: 'ok' }, 1001)).toBe('OK');
  });

  test('성공한 생성은 60초 throttle 적용 (다음 요청 RATE_LIMITED)', () => {
    expect(runGenerate('u1', { outcome: 'ok' }, 1000)).toBe('OK');
    expect(runGenerate('u1', { outcome: 'ok' }, 1500)).toBe('RATE_LIMITED');
    // after window passes
    expect(runGenerate('u1', { outcome: 'ok' }, 1000 + WINDOW * 1000 + 1)).toBe('OK');
  });

  test('동시 더블서밋: 게이트 스탬프가 두 번째를 막는다 (실패 전이라도)', () => {
    // First passes gate and commits; second within window is blocked.
    expect(runGenerate('u1', { outcome: 'ok' }, 1000)).toBe('OK');
    expect(runGenerate('u1', { outcome: 'ok' }, 1000)).toBe('RATE_LIMITED');
  });
});
