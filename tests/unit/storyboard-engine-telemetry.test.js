'use strict';

const mockGenerateStoryboardData = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('../../lib/openai-client', () => ({
  generateStoryboardData: mockGenerateStoryboardData,
  generateStoryboardGrid: jest.fn()
}));

jest.mock('../../lib/logger', () => ({
  warn: mockLoggerWarn
}));

const { generateScenarioAndPrompts } = require('../../lib/storyboard-engine');

function invalidStoryboard() {
  return {
    characters: { protagonist: 'Alex' },
    shots: Array.from({ length: 4 }, (_, index) => ({
      shotNumber: index + 1,
      narrativeBeat: 'Beat',
      description: 'PRIVATE GENERATED DESCRIPTION',
      cameraAngle: 'PRIVATE DUPLICATE ANGLE',
      action: 'Action',
      emotion: 'Calm',
      lighting: 'Soft',
      colorGrade: 'Warm',
      durationSeconds: 4,
      videoPrompt: 'PRIVATE GENERATED PROMPT'
    }))
  };
}

describe('Storyboard constraint telemetry', () => {
  beforeEach(() => {
    mockGenerateStoryboardData.mockReset();
    mockLoggerWarn.mockReset();
  });

  test('logs stable constraint codes for both attempts without generated content', async () => {
    mockGenerateStoryboardData.mockResolvedValue(invalidStoryboard());

    await expect(generateScenarioAndPrompts({
      scenario: 'PRIVATE USER SCENARIO',
      genres: ['Drama'],
      style: 'Cinematic',
      cutCount: 4
    })).rejects.toThrow(
      'Storyboard validation failed after 2 attempts: camera_angle_unique, aspect_ratio, frame_rate, cinematic_realism, face_identity, duration_cue, duration_total'
    );

    expect(mockGenerateStoryboardData).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenNthCalledWith(1, 'storyboard.text.constraint_failed', expect.objectContaining({
      attempt: 1,
      retryScheduled: true,
      constraintCodes: expect.arrayContaining(['camera_angle_unique', 'aspect_ratio', 'duration_total'])
    }));
    expect(mockLoggerWarn).toHaveBeenNthCalledWith(2, 'storyboard.text.constraint_failed', expect.objectContaining({
      attempt: 2,
      retryScheduled: false
    }));

    const serializedLogs = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(serializedLogs).not.toContain('PRIVATE');
  });
});
