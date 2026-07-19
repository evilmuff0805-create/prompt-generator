'use strict';

const mockInfo = jest.fn();
const mockWarn = jest.fn();

jest.mock('../../lib/logger', () => ({
  info: mockInfo,
  warn: mockWarn
}));

const {
  extractOpenAIUsage,
  extractGeminiUsage,
  recordAiCall
} = require('../../lib/ai-telemetry');

describe('AI provider telemetry', () => {
  beforeEach(() => {
    mockInfo.mockReset();
    mockWarn.mockReset();
  });

  test('normalizes OpenAI and Gemini usage including reasoning tokens', () => {
    expect(extractOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 10 }
    })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 10,
      cachedInputTokens: 25,
      totalTokens: 150
    });

    expect(extractGeminiUsage({
      promptTokenCount: 80,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 5,
      cachedContentTokenCount: 10,
      totalTokenCount: 125
    })).toEqual({
      inputTokens: 80,
      outputTokens: 40,
      reasoningTokens: 5,
      cachedInputTokens: 10,
      totalTokens: 125
    });
  });

  test('emits an allowlisted success record without user input or provider output', () => {
    recordAiCall({
      outcome: 'completed',
      provider: 'openai',
      operation: 'storyboard.text',
      model: 'gpt-5.6-luna-snapshot',
      promptVersion: 'storyboard-v3',
      attempt: 2,
      maxAttempts: 2,
      durationMs: 321,
      parseResult: 'passed',
      schemaResult: 'passed',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      responseId: 'response-id',
      scenario: 'must never be logged',
      output: 'must never be logged'
    });

    expect(mockInfo).toHaveBeenCalledWith('ai.provider_call.completed', expect.objectContaining({
      provider: 'openai',
      retryCount: 1,
      durationMs: 321,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
    }));
    const fields = mockInfo.mock.calls[0][1];
    expect(fields).not.toHaveProperty('scenario');
    expect(fields).not.toHaveProperty('output');
  });

  test('records retryable failures without an error message', () => {
    recordAiCall({
      outcome: 'failed',
      provider: 'google',
      operation: 'image.analysis',
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'image-analysis-v1',
      retryScheduled: true,
      errorCode: 'RATE_LIMITED',
      errorStatus: 429,
      errorMessage: 'sensitive provider content'
    });

    expect(mockWarn).toHaveBeenCalledWith('ai.provider_call.failed', expect.objectContaining({
      retryScheduled: true,
      errorCode: 'RATE_LIMITED',
      errorStatus: 429
    }));
    expect(mockWarn.mock.calls[0][1]).not.toHaveProperty('errorMessage');
  });
});
