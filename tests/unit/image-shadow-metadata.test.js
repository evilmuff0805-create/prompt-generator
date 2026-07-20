const sharp = require('sharp');
const {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_SAMPLE_RATE,
  MAX_INPUT_PIXELS,
  MAX_ALLOWED_CONCURRENCY,
  REPRESENTATIVE_COLOR_SIZE,
  classifyAspectRatio,
  extractImageShadowMetadata,
  getImageMetadataShadowConfig,
  isImageMetadataShadowEnabled,
  normalizeImageMetadata,
  parseMaxConcurrency,
  parseSampleRate,
  shouldObserveImageMetadata,
  rgbToHex
} = require('../../lib/image-shadow-metadata');

describe('image metadata shadow', () => {
  test('extracts deterministic dimensions, alpha, aspect ratio, and representative colour', async () => {
    const input = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 220, g: 40, b: 20, alpha: 0.5 }
      }
    }).png().toBuffer();

    const first = await extractImageShadowMetadata(input);
    const second = await extractImageShadowMetadata(input);

    expect(first).toMatchObject({
      format: 'png',
      sourceWidth: 40,
      sourceHeight: 20,
      displayWidth: 40,
      displayHeight: 20,
      orientation: 1,
      aspectRatio: '16:9',
      pages: 1,
      animated: false,
      hasAlpha: true
    });
    expect(first.representativeHex).toMatch(/^#[0-9a-f]{6}$/);
    expect(second.representativeHex).toBe(first.representativeHex);

    const [red, green, blue] = first.representativeHex
      .match(/[0-9a-f]{2}/g)
      .map((channel) => Number.parseInt(channel, 16));
    expect(red).toBeGreaterThan(180);
    expect(green).toBeLessThan(80);
    expect(blue).toBeLessThan(80);
  });

  test('uses EXIF auto-orientation for display dimensions', async () => {
    const input = await sharp({
      create: {
        width: 30,
        height: 50,
        channels: 3,
        background: { r: 10, g: 20, b: 30 }
      }
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();

    const result = await extractImageShadowMetadata(input);

    expect(result).toMatchObject({
      format: 'jpeg',
      sourceWidth: 30,
      sourceHeight: 50,
      displayWidth: 50,
      displayHeight: 30,
      orientation: 6,
      aspectRatio: '16:9',
      animated: false,
      hasAlpha: false
    });
  });

  test('normalizes multi-page metadata using one frame height', () => {
    expect(normalizeImageMetadata({
      format: 'gif',
      width: 32,
      height: 192,
      pageHeight: 64,
      pages: 3,
      hasAlpha: true
    }, '#010203')).toEqual({
      format: 'gif',
      sourceWidth: 32,
      sourceHeight: 64,
      displayWidth: 32,
      displayHeight: 64,
      orientation: 1,
      aspectRatio: '9:16',
      pages: 3,
      animated: true,
      hasAlpha: true,
      representativeHex: '#010203'
    });
  });

  test('detects an animated GIF while analysing only its first frame', async () => {
    const pixels = Buffer.alloc(4 * 4 * 4);
    for (let pixel = 0; pixel < 16; pixel += 1) {
      const offset = pixel * 4;
      const firstFrame = pixel < 8;
      pixels[offset] = firstFrame ? 255 : 0;
      pixels[offset + 1] = 0;
      pixels[offset + 2] = firstFrame ? 0 : 255;
      pixels[offset + 3] = 255;
    }
    const input = await sharp(pixels, {
      raw: { width: 4, height: 4, pageHeight: 2, channels: 4 }
    }).gif({ delay: [100, 100], loop: 0 }).toBuffer();

    await expect(extractImageShadowMetadata(input)).resolves.toMatchObject({
      format: 'gif',
      sourceWidth: 4,
      sourceHeight: 2,
      displayWidth: 4,
      displayHeight: 2,
      pages: 2,
      animated: true,
      hasAlpha: true
    });
  });

  test('rejects corrupt input with a stable extraction code', async () => {
    await expect(extractImageShadowMetadata(Buffer.from('not-an-image')))
      .rejects.toMatchObject({ code: 'IMAGE_METADATA_EXTRACTION_FAILED' });
  });

  test('uses explicit safety limits and exact-true feature gating', () => {
    expect(MAX_INPUT_PIXELS).toBe(40_000_000);
    expect(REPRESENTATIVE_COLOR_SIZE).toBe(64);
    expect(isImageMetadataShadowEnabled({ GEMINI_IMAGE_METADATA_SHADOW_ENABLED: ' TRUE ' })).toBe(true);
    expect(isImageMetadataShadowEnabled({ GEMINI_IMAGE_METADATA_SHADOW_ENABLED: '1' })).toBe(false);
    expect(isImageMetadataShadowEnabled({})).toBe(false);
  });

  test('uses a fail-closed 5% sampling contract and bounded concurrency', () => {
    expect(DEFAULT_SAMPLE_RATE).toBe(0.05);
    expect(DEFAULT_MAX_CONCURRENCY).toBe(1);
    expect(MAX_ALLOWED_CONCURRENCY).toBe(4);
    expect(getImageMetadataShadowConfig({
      GEMINI_IMAGE_METADATA_SHADOW_ENABLED: 'true'
    })).toEqual({ enabled: true, sampleRate: 0.05, maxConcurrency: 1 });
    expect(parseSampleRate('0')).toBe(0);
    expect(parseSampleRate('1')).toBe(1);
    expect(parseSampleRate('1.1')).toBe(0);
    expect(parseSampleRate('invalid')).toBe(0);
    expect(parseMaxConcurrency('4')).toBe(4);
    expect(parseMaxConcurrency('5')).toBe(1);
    expect(parseMaxConcurrency('0')).toBe(1);
    expect(shouldObserveImageMetadata({ enabled: true, sampleRate: 0.05 }, () => 0.049)).toBe(true);
    expect(shouldObserveImageMetadata({ enabled: true, sampleRate: 0.05 }, () => 0.05)).toBe(false);
    expect(shouldObserveImageMetadata({ enabled: true, sampleRate: 0 }, () => 0)).toBe(false);
    expect(shouldObserveImageMetadata({ enabled: false, sampleRate: 1 }, () => 0)).toBe(false);
  });

  test('classifies ratios symmetrically and handles invalid dimensions', () => {
    expect(classifyAspectRatio(1920, 1080)).toBe('16:9');
    expect(classifyAspectRatio(1080, 1920)).toBe('9:16');
    expect(classifyAspectRatio(1000, 1000)).toBe('1:1');
    expect(classifyAspectRatio(0, 1000)).toBeNull();
    expect(rgbToHex({ r: 1, g: 2, b: 3 })).toBe('#010203');
    expect(rgbToHex({ r: Number.NaN, g: 2, b: 3 })).toBeNull();
  });
});
