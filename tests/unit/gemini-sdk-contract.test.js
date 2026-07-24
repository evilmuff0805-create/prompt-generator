const mockGenerateContent = jest.fn();
const mockGoogleGenAI = jest.fn(() => ({
  models: { generateContent: mockGenerateContent }
}));

jest.mock('@google/genai', () => ({
  GoogleGenAI: mockGoogleGenAI
}), { virtual: true });

const {
  analyzeImage,
  getParseTelemetry,
  isStructuredOutputEnabled,
  observeImageMetadataShadow
} = require('../../services/geminiService');
const logger = require('../../lib/logger');
const sharp = require('sharp');

const ANALYSIS_JSON = {
  subject: {
    type: 'person',
    description: 'A cyclist in a yellow rain jacket',
    hair: { style: 'short', color: 'brown #5A3A22' },
    expression: 'focused',
    pose: 'riding forward',
    clothing: [
      { item: 'rain jacket', color: 'yellow #F4C430', fabric: 'nylon', fit: 'regular' }
    ],
    accessories: []
  },
  scene: {
    location: 'wet city street',
    time: 'evening',
    weather: 'rain',
    lighting: { type: 'street lights', direction: 'side', quality: 'soft' },
    background_elements: ['reflections']
  },
  technical: { camera_model: 'full-frame camera', lens: '35mm', aperture: 'f/2.8' },
  composition: {
    framing: 'medium shot',
    angle: 'eye level',
    focus_point: 'cyclist',
    aspect_ratio: '16:9'
  },
  style_modifiers: {
    medium: 'photography',
    aesthetic: ['cinematic'],
    color_palette: 'cool blue with yellow #F4C430',
    post_processing: 'natural contrast'
  },
  constraints: {
    must_keep: ['cyclist', 'yellow jacket', 'rain', 'wet street', 'evening'],
    avoid: ['extra limbs', 'text', 'logos']
  }
};

describe('@google/genai request contract', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_STRUCTURED_OUTPUT_ENABLED;
    delete process.env.GEMINI_IMAGE_METADATA_SHADOW_ENABLED;
    delete process.env.GEMINI_IMAGE_METADATA_SHADOW_SAMPLE_RATE;
    delete process.env.GEMINI_IMAGE_METADATA_SHADOW_MAX_CONCURRENCY;
    mockGenerateContent.mockReset();
    mockGoogleGenAI.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('preserves the image-analysis and suggestion calls without adding schema or thinking config', async () => {
    mockGenerateContent
      .mockResolvedValueOnce({
        text: `A cinematic rainy street scene.\n${JSON.stringify(ANALYSIS_JSON)}`,
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 0,
          totalTokenCount: 150
        }
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ suggestions: [] }),
        usageMetadata: {
          promptTokenCount: 40,
          candidatesTokenCount: 10,
          totalTokenCount: 50
        }
      });

    const result = await analyzeImage('ZmFrZS1pbWFnZQ==', 'image/png');

    expect(mockGoogleGenAI).toHaveBeenCalledTimes(2);
    expect(mockGoogleGenAI).toHaveBeenNthCalledWith(1, { apiKey: 'test-key' });
    expect(mockGoogleGenAI).toHaveBeenNthCalledWith(2, { apiKey: 'test-key' });
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);

    const analysisRequest = mockGenerateContent.mock.calls[0][0];
    expect(analysisRequest).toEqual({
      model: 'gemini-3.1-flash-lite',
      contents: [
        { inlineData: { mimeType: 'image/png', data: 'ZmFrZS1pbWFnZQ==' } },
        'Analyze this image and generate the hybrid prompt.'
      ],
      config: {
        systemInstruction: expect.stringContaining('expert AI image prompt engineer'),
        temperature: 0.3,
        maxOutputTokens: 5000
      }
    });

    const suggestionsRequest = mockGenerateContent.mock.calls[1][0];
    expect(suggestionsRequest).toEqual({
      model: 'gemini-3.1-flash-lite',
      contents: expect.stringContaining('generate 3–5 alternative replacement values'),
      config: { temperature: 0.8, maxOutputTokens: 2200 }
    });

    const serializedRequests = JSON.stringify(mockGenerateContent.mock.calls);
    expect(serializedRequests).not.toContain('responseSchema');
    expect(serializedRequests).not.toContain('responseJsonSchema');
    expect(serializedRequests).not.toContain('responseMimeType');
    expect(serializedRequests).not.toContain('thinkingConfig');
    expect(result.brackets.length).toBeGreaterThan(0);
  });

  test('keeps the image path to a single provider call when parsing yields no brackets', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: 'A plain prose response without structured JSON.',
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 }
    });

    const result = await analyzeImage('ZmFrZQ==', 'image/jpeg');

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(result.brackets).toEqual([]);
  });

  test('observes metadata without changing the provider request when the shadow flag is enabled', async () => {
    process.env.GEMINI_IMAGE_METADATA_SHADOW_ENABLED = 'true';
    process.env.GEMINI_IMAGE_METADATA_SHADOW_SAMPLE_RATE = '1';
    const imageBuffer = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 220, g: 40, b: 20, alpha: 0.5 }
      }
    }).png().toBuffer();
    const imageBase64 = imageBuffer.toString('base64');
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => ({}));
    mockGenerateContent.mockResolvedValueOnce({
      text: 'A plain prose response without structured JSON.',
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 }
    });

    const result = await analyzeImage(imageBase64, 'image/png');

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent.mock.calls[0][0].contents[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: imageBase64 }
    });
    expect(result.brackets).toEqual([]);

    const completed = infoSpy.mock.calls.find(([event]) => event === 'image.metadata_shadow.completed');
    expect(completed).toBeDefined();
    expect(completed[1]).toMatchObject({
      provider: 'sharp',
      sourceWidth: 40,
      sourceHeight: 20,
      displayWidth: 40,
      displayHeight: 20,
      aspectRatio: '16:9',
      hasAlpha: true,
      representativeColorComputed: true
    });
    expect(completed[1]).not.toHaveProperty('representativeHex');
    expect(JSON.stringify(completed[1])).not.toContain('#');
  });

  test('fails open and still makes one unchanged provider call for corrupt shadow input', async () => {
    process.env.GEMINI_IMAGE_METADATA_SHADOW_ENABLED = 'true';
    process.env.GEMINI_IMAGE_METADATA_SHADOW_SAMPLE_RATE = '1';
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => ({}));
    mockGenerateContent.mockResolvedValueOnce({
      text: 'A plain prose response without structured JSON.',
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 }
    });

    const result = await analyzeImage('ZmFrZQ==', 'image/jpeg');

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent.mock.calls[0][0].contents[0]).toEqual({
      inlineData: { mimeType: 'image/jpeg', data: 'ZmFrZQ==' }
    });
    expect(result.brackets).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith('image.metadata_shadow.failed', expect.objectContaining({
      provider: 'sharp',
      errorCode: 'IMAGE_METADATA_EXTRACTION_FAILED'
    }));
  });

  test('starts shadow work beside the provider request instead of serially before it', async () => {
    const order = [];
    let finishShadow;
    const shadowObserver = jest.fn(() => new Promise((resolve) => {
      order.push('shadow-started');
      finishShadow = () => {
        order.push('shadow-finished');
        resolve({ status: 'completed' });
      };
    }));
    mockGenerateContent.mockImplementationOnce(async () => {
      order.push('provider-started');
      finishShadow();
      return {
        text: 'A plain prose response without structured JSON.',
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 }
      };
    });

    await analyzeImage('ZmFrZQ==', 'image/jpeg', { shadowObserver });

    expect(order).toEqual(['shadow-started', 'provider-started', 'shadow-finished']);
    expect(shadowObserver).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  test('contains an unexpected observer rejection without retrying or blocking the provider result', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => ({}));
    const shadowObserver = jest.fn().mockRejectedValue(new Error('unexpected observer failure'));
    mockGenerateContent.mockResolvedValueOnce({
      text: 'A plain prose response without structured JSON.',
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 }
    });

    const result = await analyzeImage('ZmFrZQ==', 'image/jpeg', { shadowObserver });

    expect(result.brackets).toEqual([]);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('image.metadata_shadow.observer_failed', {
      provider: 'sharp',
      operation: 'image.metadata_shadow',
      mimeType: 'image/jpeg',
      errorCode: 'IMAGE_METADATA_OBSERVER_FAILED'
    });
  });

  test('skips sampled shadow work when the process concurrency limit is occupied', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => ({}));
    const env = {
      GEMINI_IMAGE_METADATA_SHADOW_ENABLED: 'true',
      GEMINI_IMAGE_METADATA_SHADOW_SAMPLE_RATE: '1',
      GEMINI_IMAGE_METADATA_SHADOW_MAX_CONCURRENCY: '1'
    };
    let releaseFirst;
    const extractMetadata = jest.fn(() => new Promise((resolve) => {
      releaseFirst = () => resolve({
        format: 'png', sourceWidth: 1, sourceHeight: 1,
        displayWidth: 1, displayHeight: 1, orientation: 1,
        aspectRatio: '1:1', pages: 1, animated: false,
        hasAlpha: false, representativeHex: '#000000'
      });
    }));

    const first = observeImageMetadataShadow('AA==', 'image/png', { env, extractMetadata });
    await Promise.resolve();
    const second = await observeImageMetadataShadow('AA==', 'image/png', { env, extractMetadata });
    releaseFirst();
    const firstResult = await first;

    expect(firstResult).toEqual({ status: 'completed' });
    expect(second).toEqual({ status: 'skipped', reason: 'concurrency_limit' });
    expect(extractMetadata).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('image.metadata_shadow.skipped', expect.objectContaining({
      reason: 'concurrency_limit', activeObservations: 1, maxConcurrency: 1
    }));
  });

  test('adds JSON Schema only when the dormant canary flag is explicitly enabled', async () => {
    process.env.GEMINI_STRUCTURED_OUTPUT_ENABLED = 'true';
    mockGenerateContent
      .mockResolvedValueOnce({
        text: JSON.stringify({
          prose: 'A cinematic rainy street scene.',
          analysis: ANALYSIS_JSON
        }),
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ suggestions: [] }),
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, totalTokenCount: 50 }
      });

    const result = await analyzeImage('ZmFrZS1pbWFnZQ==', 'image/png');

    const analysisConfig = mockGenerateContent.mock.calls[0][0].config;
    expect(analysisConfig).toMatchObject({
      temperature: 0.3,
      maxOutputTokens: 5000,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['prose', 'analysis']
      }
    });
    expect(analysisConfig.systemInstruction).toContain('STRUCTURED OUTPUT MODE');

    const suggestionsConfig = mockGenerateContent.mock.calls[1][0].config;
    expect(suggestionsConfig).toMatchObject({
      temperature: 0.8,
      maxOutputTokens: 2200,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['suggestions']
      }
    });
    const expectedCount = result.brackets.length;
    expect(suggestionsConfig.responseJsonSchema.properties.suggestions).toMatchObject({
      minItems: expectedCount,
      maxItems: expectedCount
    });
    expect(result.prompt).toContain('A cinematic rainy street scene.');
    expect(getParseTelemetry(result)).toEqual({
      parseResult: 'passed',
      schemaResult: 'passed',
      schemaErrorCodes: []
    });
  });

  test('degrades malformed structured output without a second provider call', async () => {
    process.env.GEMINI_STRUCTURED_OUTPUT_ENABLED = 'true';
    mockGenerateContent.mockResolvedValueOnce({
      text: '{"prose":"truncated"',
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 }
    });

    const result = await analyzeImage('ZmFrZQ==', 'image/jpeg');

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ prompt: '', brackets: [], analysis: {} });
    expect(getParseTelemetry(result)).toEqual({
      parseResult: 'failed',
      schemaResult: 'degraded',
      schemaErrorCodes: ['structured_json_invalid']
    });
  });

  test('enables the canary only for an explicit true value', () => {
    expect(isStructuredOutputEnabled({ GEMINI_STRUCTURED_OUTPUT_ENABLED: ' TRUE ' })).toBe(true);
    expect(isStructuredOutputEnabled({ GEMINI_STRUCTURED_OUTPUT_ENABLED: '1' })).toBe(false);
    expect(isStructuredOutputEnabled({ GEMINI_STRUCTURED_OUTPUT_ENABLED: 'yes' })).toBe(false);
    expect(isStructuredOutputEnabled({})).toBe(false);
  });
});
