const mockGenerateContent = jest.fn();
const mockGoogleGenAI = jest.fn(() => ({
  models: { generateContent: mockGenerateContent }
}));

jest.mock('@google/genai', () => ({
  GoogleGenAI: mockGoogleGenAI
}), { virtual: true });

const { analyzeImage } = require('../../services/geminiService');

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
    mockGenerateContent.mockReset();
    mockGoogleGenAI.mockClear();
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
        maxOutputTokens: 16000
      }
    });

    const suggestionsRequest = mockGenerateContent.mock.calls[1][0];
    expect(suggestionsRequest).toEqual({
      model: 'gemini-3.1-flash-lite',
      contents: expect.stringContaining('generate 3–5 alternative replacement values'),
      config: { temperature: 0.8, maxOutputTokens: 12000 }
    });

    const serializedRequests = JSON.stringify(mockGenerateContent.mock.calls);
    expect(serializedRequests).not.toContain('responseSchema');
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
});
