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

  test.each(['Pixar 3D', 'Documentary', 'Animation'])(
    '%s remains free of the Cinematic-only realism contract',
    style => {
      expect(buildSystemPrompt({ style, cutCount: 9 })).not.toContain('ultra-realistic');
      expect(buildGridPrompt(makeData(9), style, 9)).not.toContain('ultra-realistic');
      expect(validateStoryboardData(
        makeData(9, { includeUltraRealistic: false }),
        9,
        style
      )).toEqual([]);
    }
  );
});
