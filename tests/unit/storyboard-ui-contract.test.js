'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const STORYBOARD_PAGES = [
  'storyboard.html',
  'storyboard-history.html',
  'storyboard-result.html'
];

function readPublic(file) {
  return fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
}

describe('Storyboard Functional Liquid Glass contract', () => {
  test.each(STORYBOARD_PAGES)('%s uses the isolated, deploy-versioned UI layer', file => {
    const html = readPublic(file);
    expect(html).toContain('<body class="storyboard-shell">');
    expect(html).toContain('/style.css?v=__ASSET_VERSION__');
    expect(html).toContain('/storyboard.css?v=__ASSET_VERSION__');

    const localAssets = [...html.matchAll(/(?:src|href)="(\/(?:[^"?]+\.(?:css|js))(?:\?[^" ]+)?)"/g)]
      .map(match => match[1]);
    expect(localAssets.length).toBeGreaterThan(4);
    expect(localAssets.filter(asset => !asset.includes('?v=__ASSET_VERSION__'))).toEqual([]);
  });

  test('glass has accessible fallbacks and responsive safety budgets', () => {
    const css = readPublic('storyboard.css');
    expect(css).toContain('@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('@media (max-width: 360px)');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('min-height: 44px');
  });

  test('shot labels match the 15-second generation contract and are localized', () => {
    const html = readPublic('storyboard.html');
    expect(html).toContain('data-i18n="storyboard.shots.fourMeta"');
    expect(html).toContain('data-i18n="storyboard.shots.nineMeta"');
    expect(html).not.toContain('~12s');
    expect(html).not.toContain('~27s');
    expect(html).toContain('~14s total');
    expect(html).toContain('~13.5s total');
  });

  test('selection controls expose their state to assistive technology', () => {
    const html = readPublic('storyboard.html');
    const source = readPublic(path.join('js', 'storyboard-form.js'));
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(source).toContain("setAttribute('aria-pressed', 'true')");
    expect(source).toContain("setAttribute('aria-pressed', 'false')");
  });

  test('Storyboard routes render asset placeholders instead of sending raw templates', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    for (const file of STORYBOARD_PAGES) {
      expect(source).toContain(`sendVersionedPage(res, '${file}')`);
    }
  });
});
