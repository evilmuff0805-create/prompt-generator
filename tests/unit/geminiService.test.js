/**
 * geminiService 유닛 테스트
 * 순수 함수(parseHybridResponse, buildFormattedPrompt, buildAnalysis)만 테스트
 */

const {
  parseHybridResponse,
  buildFormattedPrompt,
  buildAnalysis,
  validateAnalysisSchema,
  validateSuggestionsSchema,
  getParseTelemetry
} = require('../../services/geminiService');

// ── 테스트용 픽스처 ──
const SAMPLE_JSON = {
  subject: {
    type: 'person',
    description: 'A chubby, animated male character',
    hair: { style: 'short messy', color: 'dark brown #4E342E' },
    expression: 'Wide-eyed, joyful, and excited',
    pose: 'Standing, holding a megaphone',
    clothing: [
      { item: 'puffer jacket', color: 'red #C0392B', fabric: 'nylon', fit: 'oversized', detail: 'zipped' }
    ],
    accessories: []
  },
  scene: {
    location: 'cinema marquee',
    time: 'evening',
    weather: 'clear',
    lighting: { type: 'warm spotlight', direction: 'front', quality: 'soft' },
    background_elements: ['bokeh lights', 'movie posters']
  },
  composition: {
    framing: 'medium shot',
    angle: 'eye-level',
    focus_point: 'character face',
    aspect_ratio: '16:9'
  },
  style_modifiers: {
    medium: '3D render',
    aesthetic: ['cinematic', 'playful'],
    color_palette: 'warm and vibrant',
    post_processing: 'Octane render'
  },
  constraints: {
    must_keep: ['red jacket', 'megaphone'],
    avoid: ['text overlays']
  }
};

// ── buildFormattedPrompt 테스트 ──
describe('buildFormattedPrompt', () => {
  test('반환 객체에 formattedPrompt와 brackets가 있어야 한다', () => {
    const result = buildFormattedPrompt('Sample prose.', SAMPLE_JSON);
    expect(result).toHaveProperty('formattedPrompt');
    expect(result).toHaveProperty('brackets');
    expect(typeof result.formattedPrompt).toBe('string');
    expect(Array.isArray(result.brackets)).toBe(true);
  });

  test('prose가 formattedPrompt에 포함되어야 한다', () => {
    const { formattedPrompt } = buildFormattedPrompt('This is a vivid scene.', SAMPLE_JSON);
    expect(formattedPrompt).toContain('This is a vivid scene.');
  });

  test('brackets 배열이 비어있지 않아야 한다', () => {
    const { brackets } = buildFormattedPrompt('prose', SAMPLE_JSON);
    expect(brackets.length).toBeGreaterThan(0);
  });

  test('각 bracket은 original과 description을 가져야 한다', () => {
    const { brackets } = buildFormattedPrompt('prose', SAMPLE_JSON);
    brackets.forEach(b => {
      expect(b).toHaveProperty('original');
      expect(b).toHaveProperty('description');
      expect(typeof b.original).toBe('string');
    });
  });

  test('brackets의 original 값이 formattedPrompt에 [bracket] 형식으로 포함되어야 한다', () => {
    const { formattedPrompt, brackets } = buildFormattedPrompt('prose', SAMPLE_JSON);
    brackets.forEach(b => {
      expect(formattedPrompt).toContain(`[${b.original}]`);
    });
  });

  test('빈 JSON이어도 오류 없이 동작해야 한다', () => {
    expect(() => buildFormattedPrompt('prose', {})).not.toThrow();
  });

  test('prose가 없어도 동작해야 한다', () => {
    const { formattedPrompt } = buildFormattedPrompt('', SAMPLE_JSON);
    expect(typeof formattedPrompt).toBe('string');
  });

  test('중복 bracket 값이 없어야 한다', () => {
    const { brackets } = buildFormattedPrompt('prose', SAMPLE_JSON);
    const originals = brackets.map(b => b.original);
    const unique = new Set(originals);
    expect(originals.length).toBe(unique.size);
  });
});

// ── buildAnalysis 테스트 ──
describe('buildAnalysis', () => {
  test('반환 객체에 필요한 필드가 모두 있어야 한다', () => {
    const analysis = buildAnalysis(SAMPLE_JSON);
    expect(analysis).toHaveProperty('composition');
    expect(analysis).toHaveProperty('lighting');
    expect(analysis).toHaveProperty('mood');
    expect(analysis).toHaveProperty('style');
  });

  test('lighting이 type/direction/quality를 합쳐야 한다', () => {
    const analysis = buildAnalysis(SAMPLE_JSON);
    expect(analysis.lighting).toContain('warm spotlight');
    expect(analysis.lighting).toContain('front');
    expect(analysis.lighting).toContain('soft');
  });

  test('mood가 aesthetic 배열을 join해야 한다', () => {
    const analysis = buildAnalysis(SAMPLE_JSON);
    expect(analysis.mood).toContain('cinematic');
    expect(analysis.mood).toContain('playful');
  });

  test('빈 JSON이어도 오류 없이 동작해야 한다', () => {
    const analysis = buildAnalysis({});
    expect(analysis.composition).toBe('');
    expect(analysis.lighting).toBe('');
    expect(analysis.mood).toBe('');
  });
});

// ── parseHybridResponse 테스트 ──
describe('parseHybridResponse', () => {
  test('```json 코드블록이 있을 때 정상 파싱해야 한다', () => {
    const content = `This is a beautiful scene.

\`\`\`json
${JSON.stringify(SAMPLE_JSON)}
\`\`\``;
    const result = parseHybridResponse(content);
    expect(result).toHaveProperty('prompt');
    expect(result).toHaveProperty('brackets');
    expect(result).toHaveProperty('analysis');
    expect(result.brackets.length).toBeGreaterThan(0);
  });

  test('코드블록 없이 raw JSON이 있을 때도 파싱해야 한다', () => {
    const content = `Some prose here.\n${JSON.stringify(SAMPLE_JSON)}`;
    const result = parseHybridResponse(content);
    expect(result.brackets.length).toBeGreaterThan(0);
  });

  test('JSON이 없으면 prompt만 반환하고 brackets는 빈 배열이어야 한다', () => {
    const result = parseHybridResponse('Just some plain text with no JSON.');
    expect(result.prompt).toBe('Just some plain text with no JSON.');
    expect(result.brackets).toEqual([]);
    expect(result.analysis).toEqual({});
    expect(getParseTelemetry(result)).toEqual({
      parseResult: 'missing',
      schemaResult: 'degraded',
      schemaErrorCodes: ['json_missing']
    });
    expect(Object.keys(result)).not.toContain('parseTelemetry');
  });

  test('빈 문자열이면 에러를 throw해야 한다', () => {
    expect(() => parseHybridResponse('')).toThrow('Empty response from Gemini');
  });

  test('PART 헤더 텍스트가 prose에서 제거되어야 한다', () => {
    const content = `PART 1: PROSE DESCRIPTION\nThis is the actual prose.\n${JSON.stringify(SAMPLE_JSON)}`;
    const result = parseHybridResponse(content);
    expect(result.prompt).not.toContain('PART 1: PROSE DESCRIPTION');
  });
});

describe('Gemini schema telemetry', () => {
  test('classifies the critical image-analysis shape without logging content', () => {
    expect(validateAnalysisSchema(SAMPLE_JSON)).toEqual([]);

    const degraded = {
      ...SAMPLE_JSON,
      composition: { ...SAMPLE_JSON.composition, aspect_ratio: '' },
      constraints: { must_keep: [] }
    };
    expect(validateAnalysisSchema(degraded)).toEqual([
      'aspect_ratio_missing',
      'avoid_missing'
    ]);
  });

  test('requires complete 3-5 item suggestion sets for every bracket', () => {
    expect(validateSuggestionsSchema({
      suggestions: [
        { index: 1, items: ['one', 'two', 'three'] },
        { index: 2, items: ['a', 'b', 'c', 'd', 'e'] }
      ]
    }, 2)).toEqual([]);

    expect(validateSuggestionsSchema({
      suggestions: [{ index: 1, items: ['only one'] }]
    }, 2)).toEqual([
      'suggestion_items_invalid',
      'suggestion_index_missing'
    ]);
  });
});
