'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('Landing and Image to Prompt routing contract', () => {
  const html = read('public/index.html');
  const server = read('server.js');
  const navbar = read('public/navbar-shared.js');
  const app = read('public/app.js');

  test('the source template declares explicit landing and tool-only boundaries', () => {
    expect(html.match(/<!-- page:landing:start -->/g)).toHaveLength(2);
    expect(html.match(/<!-- page:landing:end -->/g)).toHaveLength(2);
    expect(html.match(/<!-- page:image-tool:start -->/g)).toHaveLength(1);
    expect(html.match(/<!-- page:image-tool:end -->/g)).toHaveLength(1);
  });

  test('the server exposes a dedicated Image to Prompt route and strips the opposite variant', () => {
    expect(server).toContain("app.get(['/image-to-prompt', '/image-to-prompt/']");
    expect(server).toContain("variant === 'landing' ? 'image-tool' : 'landing'");
    expect(server).toContain("sendPromptGenPage(res, 'image-tool')");
    expect(server).toContain("sendPromptGenPage(res, 'landing')");
  });

  test('navigation sends Image to Prompt traffic to its tool route without activating a tool on landing', () => {
    expect(html).toContain('href="/image-to-prompt" class="tool-tab"');
    expect(html).toContain('href="/image-to-prompt#upload-section" class="hero__text-link"');
    expect(navbar).toContain("const isActive = href !== '/' && path.startsWith(href)");

    for (const page of ['frame.html', 'storyboard.html', 'storyboard-history.html', 'storyboard-result.html']) {
      const pageHtml = read(`public/${page}`);
      expect(pageHtml).toContain('href="/image-to-prompt" class="tool-tab"');
      expect(pageHtml).not.toContain('href="/" class="tool-tab"');
    }
  });

  test('the shared app tolerates landing pages without generator controls', () => {
    expect(app).toContain('if (!analyzeBtn) return;');
    expect(app).toContain("dropZone?.addEventListener('click'");
    expect(app).toContain("historyBtn?.addEventListener('click'");
  });

  test('shared navigation assets are commit-versioned on every affected tool shell', () => {
    expect(html).toContain('src="/navbar-shared.js?v=__ASSET_VERSION__"');
    expect(html).toContain('src="/gallery-data.js?v=__ASSET_VERSION__"');
    expect(html).toContain('src="/gallery.js?v=__ASSET_VERSION__"');

    const frameHtml = read('public/frame.html');
    expect(frameHtml).toContain('src="/navbar-shared.js?v=__ASSET_VERSION__"');
    expect(server).toContain("sendVersionedPage(res, 'frame.html')");
  });

  test('the landing pipeline uses lightweight product evidence instead of placeholder media', () => {
    expect(html).not.toContain('TODO: public/showcase');
    expect(html).not.toContain('src="/gallery/2.png"');
    expect(html).not.toContain('src="/endframe-demo.gif"');

    const assets = [
      'public/gallery/pipeline-image-to-prompt-640.webp',
      'public/gallery/pipeline-endframe-640.webp',
      'public/gallery/storyboards/hero-storyboard-animation-640.webp'
    ];

    for (const asset of assets) {
      const fullPath = path.join(ROOT, asset);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.statSync(fullPath).size).toBeLessThan(100 * 1024);
      expect(html).toContain(`src="/${asset.replace('public/', '')}"`);
    }

    expect(html.match(/class="tool-card__proof"/g)).toHaveLength(3);
    expect(html).toContain('data-i18n="hero.showcase.actual"');
    expect(html).toContain('data-i18n="frame.result.alt"');
  });

  test('the landing closes with visible verified expectations and a storyboard CTA', () => {
    expect(html.match(/class="expectation-card"/g)).toHaveLength(3);
    expect(html).toContain('data-i18n="landing.trust.retention.description"');
    expect(html).toContain('data-i18n="landing.trust.boundary.description"');
    expect(html).toContain('class="btn btn--primary landing-final-cta__action" href="/storyboard"');
    expect(html).not.toContain('<details class="expectation-card"');
  });
});
