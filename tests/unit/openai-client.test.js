'use strict';

const mockChatCreate = jest.fn();
const mockLoggerInfo = jest.fn();

jest.mock('openai', () => {
  class OpenAI {
    constructor() {
      this.chat = { completions: { create: mockChatCreate } };
      this.images = { generate: jest.fn(), edit: jest.fn() };
      this.moderations = { create: jest.fn() };
    }
  }
  OpenAI.toFile = jest.fn();
  return OpenAI;
});

jest.mock('../../lib/logger', () => ({
  info: mockLoggerInfo
}));

process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.OPENAI_TEXT_MODEL = 'gpt-5.6-luna';
process.env.OPENAI_TEXT_REASONING_EFFORT = 'medium';

const { generateStoryboardData } = require('../../lib/openai-client');

function makeShots(cutCount) {
  return Array.from({ length: cutCount }, (_, index) => ({
    shotNumber: index + 1,
    narrativeBeat: 'Setup',
    description: 'A scene',
    cameraAngle: `Angle ${index + 1}`,
    action: 'Action',
    emotion: 'Calm',
    lighting: 'Soft',
    colorGrade: 'Warm',
    durationSeconds: cutCount === 9 ? 1.5 : 3.5,
    videoPrompt: '16:9, action, cinematic 24fps'
  }));
}

function completion({ characters, cutCount = 4 }) {
  return {
    id: 'chatcmpl_test',
    model: 'gpt-5.6-luna-2026-06-18',
    choices: [{
      message: {
        content: JSON.stringify({ characters, shots: makeShots(cutCount) })
      }
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 200,
      total_tokens: 300
    }
  };
}

describe('Storyboard OpenAI request contract', () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
    mockLoggerInfo.mockReset();
  });

  test('uses Luna medium reasoning and an exact strict schema without changing the public character contract', async () => {
    mockChatCreate.mockResolvedValue(completion({
      characters: [
        { role: 'protagonist', name: 'Alex' },
        { role: 'friend', name: 'Jordan' }
      ]
    }));

    const result = await generateStoryboardData({
      scenario: 'A quiet reunion',
      genres: ['Drama'],
      style: 'Cinematic',
      cutCount: 4,
      systemPrompt: 'Return the storyboard.'
    });

    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    const request = mockChatCreate.mock.calls[0][0];
    expect(request.model).toBe('gpt-5.6-luna');
    expect(request.reasoning_effort).toBe('medium');
    expect(request.response_format.type).toBe('json_schema');
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(request.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(request.response_format.json_schema.schema.required).toEqual(['characters', 'shots']);
    expect(request.response_format.json_schema.schema.properties.shots).toMatchObject({
      minItems: 4,
      maxItems: 4
    });
    expect(request.response_format.json_schema.schema.properties.shots.items.additionalProperties).toBe(false);
    expect(request.response_format.json_schema.schema.properties.shots.items.required).toHaveLength(10);
    expect(result.characters).toEqual({ protagonist: 'Alex', friend: 'Jordan' });
    expect(result.shots).toHaveLength(4);
    expect(mockLoggerInfo).toHaveBeenCalledWith('storyboard.text.generated', expect.objectContaining({
      model: 'gpt-5.6-luna-2026-06-18',
      reasoningEffort: 'medium',
      attempt: 1,
      usage: {
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300
      }
    }));
    expect(JSON.stringify(mockLoggerInfo.mock.calls)).not.toContain('A quiet reunion');
  });

  test('retries an invalid character mapping and returns the normalized second response', async () => {
    mockChatCreate
      .mockResolvedValueOnce(completion({
        characters: [
          { role: 'protagonist', name: 'Alex' },
          { role: 'protagonist', name: 'Jordan' }
        ]
      }))
      .mockResolvedValueOnce(completion({
        characters: [{ role: 'protagonist', name: 'Alex' }]
      }));

    const result = await generateStoryboardData({
      scenario: 'A quiet reunion',
      genres: ['Drama'],
      style: 'Cinematic',
      cutCount: 4,
      systemPrompt: 'Return the storyboard.'
    });

    expect(mockChatCreate).toHaveBeenCalledTimes(2);
    expect(result.characters).toEqual({ protagonist: 'Alex' });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'storyboard.text.generated',
      expect.objectContaining({ attempt: 2 })
    );
  });

  test('maps a model refusal without retrying or logging user input', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { refusal: 'Unable to comply', content: null } }]
    });

    await expect(generateStoryboardData({
      scenario: 'A quiet reunion',
      genres: ['Drama'],
      style: 'Cinematic',
      cutCount: 4,
      systemPrompt: 'Return the storyboard.'
    })).rejects.toMatchObject({ code: 'OPENAI_TEXT_REFUSED' });

    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});
