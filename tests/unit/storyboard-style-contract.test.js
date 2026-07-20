'use strict';

jest.mock('../../lib/openai-client', () => ({
  generateStoryboardData: jest.fn(),
  generateStoryboardGrid: jest.fn()
}));

const {
  buildGridPrompt,
  validateStoryboardData
} = require('../../lib/storyboard-engine');
const { buildSystemPrompt } = require('../../lib/prompts/storyboard-system');

const ANGLES_9 = ['ELS', 'LS', 'WS', 'MLS', 'CU', 'MCU', 'ECU', 'High Angle', 'Low Angle'];
const ANGLES_4 = ['WS', 'MS', 'CU', 'LS'];
const CINEMATIC_CONTINUITY_PHRASES = [
  'anatomically correct hands and limbs',
  'realistic joint angles and clear contact points',
  'physically plausible balance, momentum, and weight transfer',
  'lock recurring character identity',
  'weather, wetness, set geography',
  'no fused limbs',
  'no duplicated people or props',
  '16:9 frame-safe crop',
  'faces, hands, contact points, and story-critical props inside the safe area'
];

function makeData(cutCount, { includeUltraRealistic = true } = {}) {
  const angles = cutCount === 9 ? ANGLES_9 : ANGLES_4;
  const duration = cutCount === 9 ? 1.5 : 3.5;
  const realism = includeUltraRealistic ? ', ultra-realistic' : '';

  return {
    characters: { protagonist: 'Alex' },
    shots: Array.from({ length: cutCount }, (_, index) => ({
      shotNumber: index + 1,
      narrativeBeat: 'Setup',
      description: 'A grounded live-action scene',
      cameraAngle: angles[index],
      action: 'Alex crosses the room',
      emotion: 'focused',
      lighting: 'motivated practical light',
      colorGrade: 'filmic',
      durationSeconds: duration,
      videoPrompt: `16:9, ${angles[index]}, grounded action${realism}, ~${duration} seconds, cinematic 24fps`
    }))
  };
}

describe('Cinematic realism prompt contract', () => {
  test.each([9, 4])('system prompt carries the realism contract for %i cuts', cutCount => {
    const prompt = buildSystemPrompt({ style: 'Cinematic', cutCount });

    expect(prompt).toContain('ultra-realistic');
    expect(prompt).toContain('natural skin and material textures');
    expect(prompt).toContain('physically plausible lighting');
    expect(prompt).toContain('real camera optics');
    expect(prompt).toContain('no waxy skin');
    expect(prompt).toContain('no plastic-looking surfaces');
    expect(prompt).toContain('no over-smoothed CGI look');
    expect(prompt).toContain('Contain the exact phrase "ultra-realistic"');
  });

  test.each([9, 4])('system prompt carries physical continuity without adding validator keywords for %i cuts', cutCount => {
    const prompt = buildSystemPrompt({ style: 'Cinematic', cutCount });

    for (const phrase of CINEMATIC_CONTINUITY_PHRASES) {
      expect(prompt).toContain(phrase);
    }
    expect(prompt).toContain('one readable subject-action-result beat');
    expect(prompt).toContain('prior-shot state');
    expect(prompt).toContain('change state only when the narrative explicitly shows the cause');
  });

  test.each([9, 4])('grid prompt carries the realism contract for %i cuts', cutCount => {
    const prompt = buildGridPrompt(makeData(cutCount), 'Cinematic', cutCount);

    expect(prompt).toContain('ultra-realistic');
    expect(prompt).toContain('natural skin and material textures');
    expect(prompt).toContain('physically plausible lighting');
    expect(prompt).toContain('real camera optics');
    expect(prompt).toContain('no waxy skin');
    expect(prompt).toContain('no plastic-looking surfaces');
    expect(prompt).toContain('no over-smoothed CGI look');
  });

  test.each([9, 4])('grid prompt carries continuity, shot state, and frame safety for %i cuts', cutCount => {
    const prompt = buildGridPrompt(makeData(cutCount), 'Cinematic', cutCount);

    for (const phrase of CINEMATIC_CONTINUITY_PHRASES) {
      expect(prompt).toContain(phrase);
    }
    expect(prompt).toContain('Preserve prior-panel state unless the described action explicitly changes it');
    expect(prompt).toContain('Lighting: motivated practical light');
    expect(prompt).toContain('Color grade: filmic');
  });

  test('Cinematic validation rejects every shot that omits ultra-realistic', () => {
    const errors = validateStoryboardData(
      makeData(9, { includeUltraRealistic: false }),
      9,
      'Cinematic'
    );

    expect(errors).toHaveLength(9);
    expect(errors.every(error => error.includes('missing "ultra-realistic"'))).toBe(true);
  });

  test('Cinematic validation accepts compliant 9-cut and 4-cut prompts', () => {
    expect(validateStoryboardData(makeData(9), 9, 'Cinematic')).toEqual([]);
    expect(validateStoryboardData(makeData(4), 4, 'Cinematic')).toEqual([]);
  });

  test('continuity guidance does not introduce retry-triggering exact keyword validation', () => {
    const data = makeData(9);
    expect(data.shots[0].videoPrompt).not.toContain('anatomically correct hands and limbs');
    expect(validateStoryboardData(data, 9, 'Cinematic')).toEqual([]);
  });

  test.each(['Pixar 3D', 'Animation'])(
    '%s remains free of the Cinematic-only realism contract',
    style => {
      expect(buildSystemPrompt({ style, cutCount: 9 })).not.toContain('ultra-realistic');
      expect(buildGridPrompt(makeData(9), style, 9)).not.toContain('ultra-realistic');
      for (const phrase of CINEMATIC_CONTINUITY_PHRASES) {
        expect(buildSystemPrompt({ style, cutCount: 9 })).not.toContain(phrase);
        expect(buildGridPrompt(makeData(9), style, 9)).not.toContain(phrase);
      }
      expect(validateStoryboardData(
        makeData(9, { includeUltraRealistic: false }),
        9,
        style
      )).toEqual([]);
    }
  );
});

describe('Documentary ultra-realistic prompt contract', () => {
  test.each([9, 4])('system and grid prompts carry documentary realism for %i cuts', cutCount => {
    const systemPrompt = buildSystemPrompt({ style: 'Documentary', cutCount });
    const gridPrompt = buildGridPrompt(makeData(cutCount), 'Documentary', cutCount);

    for (const prompt of [systemPrompt, gridPrompt]) {
      expect(prompt).toContain('ultra-realistic');
      expect(prompt).toContain('authentic skin, fabric, surface, and environmental textures');
      expect(prompt).toContain('natural available light');
      expect(prompt).toContain('real documentary camera optics');
      expect(prompt).toContain('no waxy skin');
      expect(prompt).toContain('no synthetic CGI or over-smoothed AI look');
    }
  });

  test('Documentary validation requires ultra-realistic in every shot prompt', () => {
    const errors = validateStoryboardData(
      makeData(9, { includeUltraRealistic: false }),
      9,
      'Documentary'
    );

    expect(errors).toHaveLength(9);
    expect(errors.every(error => error.includes('for Documentary style'))).toBe(true);
    expect(validateStoryboardData(makeData(9), 9, 'Documentary')).toEqual([]);
  });

  test('Documentary realism does not inherit Cinematic continuity-only constraints', () => {
    const systemPrompt = buildSystemPrompt({ style: 'Documentary', cutCount: 9 });
    const gridPrompt = buildGridPrompt(makeData(9), 'Documentary', 9);

    for (const phrase of CINEMATIC_CONTINUITY_PHRASES) {
      expect(systemPrompt).not.toContain(phrase);
      expect(gridPrompt).not.toContain(phrase);
    }
  });
});
