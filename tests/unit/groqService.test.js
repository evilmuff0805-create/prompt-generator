/**
 * groqService 유닛 테스트
 * 순수 함수(parseTextResponse, parseAnalysis)만 테스트
 */

// Groq SDK는 API 키 없이 인스턴스화 시 에러를 던지므로 모킹 필요
jest.mock('groq-sdk', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } }
  }));
});

const { parseTextResponse, parseAnalysis } = require('../../services/groqService');

// ── parseTextResponse 테스트 ──
describe('parseTextResponse', () => {
  test('반환 객체에 prompt, brackets, analysis가 있어야 한다', () => {
    const content = 'SUBJECT: [chubby animated character] with [dark brown hair]';
    const result = parseTextResponse(content);
    expect(result).toHaveProperty('prompt');
    expect(result).toHaveProperty('brackets');
    expect(result).toHaveProperty('analysis');
  });

  test('[bracket] 패턴을 올바르게 추출해야 한다', () => {
    const content = 'SUBJECT: [animated character] wearing [red puffer jacket]';
    const { brackets } = parseTextResponse(content);
    expect(brackets.length).toBe(2);
    expect(brackets[0].original).toBe('animated character');
    expect(brackets[1].original).toBe('red puffer jacket');
  });

  test('중복 bracket은 한 번만 추출해야 한다', () => {
    const content = '[red jacket] and again [red jacket] appears here';
    const { brackets } = parseTextResponse(content);
    expect(brackets.length).toBe(1);
    expect(brackets[0].original).toBe('red jacket');
  });

  test('bracket이 없으면 빈 배열을 반환해야 한다', () => {
    const { brackets } = parseTextResponse('Plain text with no brackets at all.');
    expect(brackets).toEqual([]);
  });

  test('빈 문자열이면 에러를 throw해야 한다', () => {
    expect(() => parseTextResponse('')).toThrow('Empty response from Groq');
  });

  test('공백만 있으면 에러를 throw해야 한다', () => {
    expect(() => parseTextResponse('   ')).toThrow('Empty response from Groq');
  });

  test('각 bracket은 original, description, suggestions 필드를 가져야 한다', () => {
    const { brackets } = parseTextResponse('[warm lighting] scene');
    expect(brackets[0]).toHaveProperty('original', 'warm lighting');
    expect(brackets[0]).toHaveProperty('description', '');
    expect(brackets[0]).toHaveProperty('suggestions');
    expect(Array.isArray(brackets[0].suggestions)).toBe(true);
  });

  test('prompt는 입력 내용과 동일해야 한다', () => {
    const input = 'SUBJECT: [tall character] with [blue eyes]';
    const { prompt } = parseTextResponse(input);
    expect(prompt).toBe(input);
  });
});

// ── parseAnalysis 테스트 ──
describe('parseAnalysis', () => {
  const SAMPLE_PROMPT = `SUBJECT: [chubby animated character] with [dark brown hair]

LAYOUT & COMPOSITION
Medium shot, centered framing, eye-level angle

LIGHTING
Warm spotlight from front, soft diffused quality

COLOR & TONE
Warm and vibrant, rich reds and oranges

TECHNICAL QUALITY
3D render, Octane render, high detail

OUTPUT
16:9 aspect ratio, 8K resolution`;

  test('LAYOUT & COMPOSITION 섹션을 composition으로 파싱해야 한다', () => {
    const analysis = parseAnalysis(SAMPLE_PROMPT);
    expect(analysis.composition).toContain('Medium shot');
  });

  test('LIGHTING 섹션을 lighting으로 파싱해야 한다', () => {
    const analysis = parseAnalysis(SAMPLE_PROMPT);
    expect(analysis.lighting).toContain('Warm spotlight');
  });

  test('COLOR & TONE 섹션을 mood로 파싱해야 한다', () => {
    const analysis = parseAnalysis(SAMPLE_PROMPT);
    expect(analysis.mood).toContain('Warm and vibrant');
  });

  test('TECHNICAL QUALITY 섹션을 style로 파싱해야 한다', () => {
    const analysis = parseAnalysis(SAMPLE_PROMPT);
    expect(analysis.style).toContain('3D render');
  });

  test('알 수 없는 섹션이 있어도 오류 없이 동작해야 한다', () => {
    expect(() => parseAnalysis('UNKNOWN SECTION\nsome content\n')).not.toThrow();
  });

  test('빈 문자열이어도 오류 없이 빈 객체를 반환해야 한다', () => {
    const analysis = parseAnalysis('');
    expect(typeof analysis).toBe('object');
  });

  test('섹션 내용이 250자로 truncate되어야 한다', () => {
    const longText = 'A'.repeat(300);
    const prompt = `LIGHTING\n${longText}`;
    const analysis = parseAnalysis(prompt);
    expect(analysis.lighting.length).toBeLessThanOrEqual(250);
  });
});
