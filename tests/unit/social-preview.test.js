'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const PREVIEWS = [
  'og-image-landing.png',
  'og-image-image-to-prompt.png',
  'og-image-storyboard.png',
  'og-image-frame.png'
];

describe('social preview assets', () => {
  test.each(PREVIEWS)('%s is a deployable 1200×630 PNG', async file => {
    const fullPath = path.join(PUBLIC, file);
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.statSync(fullPath).size).toBeLessThan(1024 * 1024);
    const metadata = await sharp(fullPath).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  test('tool pages publish their dedicated social previews and dimensions', () => {
    const storyboard = fs.readFileSync(path.join(PUBLIC, 'storyboard.html'), 'utf8');
    const frame = fs.readFileSync(path.join(PUBLIC, 'frame.html'), 'utf8');

    expect(storyboard).toContain('content="https://promptgen-ai.com/og-image-storyboard.png"');
    expect(frame).toContain('content="https://promptgen-ai.com/og-image-frame.png"');
    for (const html of [storyboard, frame]) {
      expect(html).toContain('<meta property="og:image:width" content="1200" />');
      expect(html).toContain('<meta property="og:image:height" content="630" />');
      expect(html).toContain('name="twitter:image:alt"');
    }
  });

  test('the preview generator is reproducible from approved product evidence', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts', 'generate-og-images.js'), 'utf8');
    expect(script).toContain('case-study-story06-1280.webp');
    expect(script).toContain('pipeline-image-to-prompt-640.webp');
    expect(script).toContain('pipeline-endframe-640.webp');
    expect(script).not.toContain("source: 'http");
  });
});
