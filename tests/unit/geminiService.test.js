/**
 * geminiService 유닛 테스트
 * 순수 함수(parseHybridResponse, buildFormattedPrompt, buildAnalysis)만 테스트
 */

const {
  parseHybridResponse,
  buildFormattedPrompt,
  buildAnalysis,
  validateAnalysisSchema,
  validateStructuredAnalysisSchema,
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
    orientation_and_gaze: 'front three-quarter view, body facing viewer-left, eyes looking at the megaphone',
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
    background_elements: ['bokeh lights', 'movie posters'],
    object_layout: [
      'one character — center-lower frame — in front of the marquee',
      'one megaphone — center-right — held beside the character face'
    ],
    depth_layers: [
      'foreground: character and megaphone',
      'midground: cinema entrance',
      'background: marquee lights and posters'
    ]
  },
  composition: {
    framing: 'medium shot',
    angle: 'eye-level',
    focus_point: 'character face',
    viewpoint: 'eye-level frontal oblique view, no visible roll, medium distance',
    subject_placement: 'center-lower cell, about 35% of frame height',
    negative_space: 'upper-left and upper-right around the marquee, about 25% of frame',
    spatial_relationships: [
      'megaphone is viewer-right of the character face',
      'movie posters sit behind the character'
    ],
    aspect_ratio: '16:9'
  },
  style_modifiers: {
    medium: '3D render',
    aesthetic: ['cinematic', 'playful'],
    color_palette: 'warm and vibrant',
    color_distribution: 'warm amber lights in the upper background, red jacket at center',
    tonal_contrast: 'bright marquee highlights against deep evening midtones',
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

  test('재현에 필요한 공간·시선·오브제·색상 정보를 고정 섹션으로 보존해야 한다', () => {
    const { formattedPrompt } = buildFormattedPrompt('prose', SAMPLE_JSON);

    expect(formattedPrompt).toContain('ORIENTATION & GAZE: front three-quarter view');
    expect(formattedPrompt).toContain('OBJECT LAYOUT: one character — center-lower frame');
    expect(formattedPrompt).toContain('DEPTH LAYERS: foreground: character and megaphone');
    expect(formattedPrompt).toContain('SPATIAL FIDELITY: Viewpoint: eye-level frontal oblique view');
    expect(formattedPrompt).toContain('Subject placement: center-lower cell');
    expect(formattedPrompt).toContain('Negative space: upper-left and upper-right');
    expect(formattedPrompt).toContain('COLOR & TONE: Distribution: warm amber lights');
  });

  test('test00 유형의 비대칭 절벽 작업실 구도를 중앙 구도로 단순화하지 않아야 한다', () => {
    const cliffWorkspace = {
      ...SAMPLE_JSON,
      subject: {
        ...SAMPLE_JSON.subject,
        orientation_and_gaze:
          'rear three-quarter view; body faces viewer-upper-left; head and visible gaze remain on the laptop'
      },
      scene: {
        ...SAMPLE_JSON.scene,
        object_layout: [
          'one woman and desk — viewer-right lower third — seated on a diagonal wooden platform',
          'one laptop — viewer-right lower third — directly in front of the woman',
          'small plants, cup, notebook, woven rug, upholstered chair, boulders and stone path — preserve count and relative positions'
        ],
        depth_layers: [
          'foreground: cliff garden, boulders, stone path and wooden platform',
          'midground: woman, chair, diagonal desk, laptop and small props',
          'background: vast cool gray-blue storm cloud field across viewer-left'
        ]
      },
      composition: {
        ...SAMPLE_JSON.composition,
        viewpoint: 'extreme high oblique bird’s-eye view from viewer-upper-left toward viewer-lower-right',
        subject_placement: 'small subject cluster in viewer-right lower third, leaving most of the frame open',
        negative_space: 'cool dark cloud mass occupies roughly 60% of viewer-left',
        spatial_relationships: [
          'woman is behind and viewer-lower-right of the laptop',
          'desk runs diagonally from viewer-lower-left to viewer-upper-right within the right third'
        ]
      },
      style_modifiers: {
        ...SAMPLE_JSON.style_modifiers,
        color_distribution:
          'cool slate gray-blue clouds dominate viewer-left; saturated green garden fills viewer-right; localized amber sunlight enters from viewer-upper-right',
        tonal_contrast:
          'deep cool cloud shadows on viewer-left against restrained warm rim highlights on the right, not a global golden grade'
      }
    };

    const { formattedPrompt } = buildFormattedPrompt('prose', cliffWorkspace);

    expect(formattedPrompt).toContain('rear three-quarter view');
    expect(formattedPrompt).toContain('viewer-right lower third');
    expect(formattedPrompt).toContain('extreme high oblique bird’s-eye view');
    expect(formattedPrompt).toContain('roughly 60% of viewer-left');
    expect(formattedPrompt).toContain('small plants, cup, notebook, woven rug, upholstered chair');
    expect(formattedPrompt).toContain('not a global golden grade');
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

  test('reports missing spatial-fidelity fields without rejecting the parsed legacy response', () => {
    const degraded = {
      ...SAMPLE_JSON,
      subject: { ...SAMPLE_JSON.subject, orientation_and_gaze: '' },
      scene: { ...SAMPLE_JSON.scene, object_layout: undefined, depth_layers: undefined },
      composition: {
        ...SAMPLE_JSON.composition,
        viewpoint: '',
        subject_placement: '',
        negative_space: '',
        spatial_relationships: undefined
      },
      style_modifiers: {
        ...SAMPLE_JSON.style_modifiers,
        color_distribution: '',
        tonal_contrast: ''
      }
    };

    expect(validateAnalysisSchema(degraded)).toEqual([
      'subject_orientation_and_gaze_missing',
      'object_layout_missing',
      'depth_layers_missing',
      'viewpoint_missing',
      'subject_placement_missing',
      'negative_space_missing',
      'spatial_relationships_missing',
      'color_distribution_missing',
      'tonal_contrast_missing'
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

  test('keeps stricter structured-output semantics out of the legacy validator', () => {
    const semanticallyIncomplete = {
      ...SAMPLE_JSON,
      composition: { ...SAMPLE_JSON.composition, aspect_ratio: 'wide' },
      constraints: { must_keep: ['one'], avoid: ['one'] }
    };

    expect(validateAnalysisSchema(semanticallyIncomplete)).toEqual([]);
    expect(validateStructuredAnalysisSchema(semanticallyIncomplete)).toEqual([
      'aspect_ratio_invalid',
      'must_keep_count_invalid',
      'avoid_count_invalid'
    ]);
  });
});
