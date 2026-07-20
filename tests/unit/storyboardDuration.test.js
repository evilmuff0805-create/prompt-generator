'use strict';
/**
 * Storyboard duration budget tests (Seedance 2.0 15s cap).
 * Tests the real validateStoryboardData + buildSystemPrompt.
 */

// storyboard-engine requires openai-client at top level, whose env guard throws
// without OPENAI_TEXT_MODEL — mock it so we can test validation in isolation.
jest.mock('../../lib/openai-client', () => ({
  generateStoryboardData: jest.fn(),
  generateStoryboardGrid: jest.fn()
}));

const { validateStoryboardData } = require('../../lib/storyboard-engine');
const { buildSystemPrompt } = require('../../lib/prompts/storyboard-system');

const ANGLES_9 = ['ELS', 'LS', 'WS', 'MLS', 'CU', 'MCU', 'ECU', 'High Angle', 'Low Angle']; // shot 5 = CU
const ANGLES_4 = ['WS', 'MS', 'CU', 'LS'];

function makeShots(cutCount, durations) {
  const angles = cutCount === 9 ? ANGLES_9 : ANGLES_4;
  return Array.from({ length: cutCount }, (_, i) => ({
    shotNumber: i + 1,
    narrativeBeat: 'Setup',
    description: 'desc',
    cameraAngle: angles[i],
    action: 'act',
    emotion: 'calm',
    lighting: 'soft',
    colorGrade: 'warm',
    durationSeconds: durations[i],
    videoPrompt: `16:9, ${angles[i]}, action, when a face is visible preserve facial identity, ~${durations[i]} seconds, cinematic 24fps`
  }));
}

describe('validateStoryboardData — duration 합산 검증', () => {
  test('9컷 × 1.5s = 13.5s → 통과 (에러 없음)', () => {
    const data = { shots: makeShots(9, Array(9).fill(1.5)) };
    expect(validateStoryboardData(data, 9)).toEqual([]);
  });

  test('4컷 × 3.5s = 14s → 통과', () => {
    const data = { shots: makeShots(4, Array(4).fill(3.5)) };
    expect(validateStoryboardData(data, 4)).toEqual([]);
  });

  test('정확히 15.0s (4컷 × 3.75) → 통과 (경계 포함)', () => {
    const data = { shots: makeShots(4, Array(4).fill(3.75)) };
    expect(validateStoryboardData(data, 4)).toEqual([]);
  });

  test('합산 초과 (9컷 × 3s = 27s) → 15s cap 에러', () => {
    const data = { shots: makeShots(9, Array(9).fill(3)) };
    const errors = validateStoryboardData(data, 9);
    expect(errors.some(e => e.includes('exceeds Seedance 15s cap'))).toBe(true);
  });

  test('합산 15.1s → 초과 판정 (엡실론은 부동소수점 오차만 흡수)', () => {
    const data = { shots: makeShots(4, [3.75, 3.75, 3.75, 3.85]) };
    const errors = validateStoryboardData(data, 4);
    expect(errors.some(e => e.includes('exceeds Seedance 15s cap'))).toBe(true);
  });

  test('durationSeconds 누락 → 샷별 에러 (합산 에러는 생략)', () => {
    const shots = makeShots(4, Array(4).fill(3.5));
    delete shots[2].durationSeconds;
    const errors = validateStoryboardData({ shots }, 4);
    expect(errors.some(e => e.includes('Shot 3') && e.includes('durationSeconds'))).toBe(true);
    expect(errors.some(e => e.includes('exceeds'))).toBe(false);
  });

  test('durationSeconds 음수/문자열 → 에러', () => {
    const shots = makeShots(4, Array(4).fill(3.5));
    shots[0].durationSeconds = -1;
    shots[1].durationSeconds = '3.5';
    const errors = validateStoryboardData({ shots }, 4);
    expect(errors.some(e => e.includes('Shot 1'))).toBe(true);
    expect(errors.some(e => e.includes('Shot 2'))).toBe(true);
  });

  test('소수점 duration cue "~1.5 seconds"가 cue 검증을 통과해야 한다 (정규식 소수 지원)', () => {
    const data = { shots: makeShots(9, Array(9).fill(1.5)) };
    const errors = validateStoryboardData(data, 9);
    expect(errors.some(e => e.includes('missing duration cue'))).toBe(false);
  });

  test('기존 정수 cue("over 3s" 스타일)도 여전히 통과 (회귀 방지)', () => {
    const shots = makeShots(4, Array(4).fill(3));
    shots[0].videoPrompt = '16:9, WS, action, when a face is visible preserve facial identity, over 3s, cinematic 24fps';
    expect(validateStoryboardData({ shots }, 4)).toEqual([]);
  });
});

describe('buildSystemPrompt — duration budget 규칙', () => {
  test('9컷: 총합 15초 규칙 + 샷당 1.5초 배분 + durationSeconds 예시 포함', () => {
    const p = buildSystemPrompt({ style: 'Cinematic', cutCount: 9 });
    expect(p).toContain('MUST NOT exceed 15.0');
    expect(p).toContain('about 1.5 seconds per shot');
    expect(p).toContain('"durationSeconds": 1.5');
    expect(p).toContain('~1.5 seconds');
    expect(p).not.toContain('~3 seconds'); // 옛 하드코딩 예시 제거 확인
  });

  test('4컷: 샷당 3.5초 배분 예시', () => {
    const p = buildSystemPrompt({ style: 'Cinematic', cutCount: 4 });
    expect(p).toContain('about 3.5 seconds per shot');
    expect(p).toContain('"durationSeconds": 3.5');
    expect(p).toContain('~3.5 seconds');
  });

  test('엄격 스키마와 같은 characters 배열 형식을 안내한다', () => {
    const p = buildSystemPrompt({ style: 'Cinematic', cutCount: 4 });
    expect(p).toContain('"characters": [');
    expect(p).toContain('{ "role": "protagonist", "name": "Alex" }');
    expect(p).not.toContain('"characters": { "protagonist"');
  });
});
