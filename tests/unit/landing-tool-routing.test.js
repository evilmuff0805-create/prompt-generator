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
});
