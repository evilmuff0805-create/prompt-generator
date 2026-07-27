'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const STORYBOARD_PAGES = [
  'storyboard.html',
  'storyboard-history.html',
  'storyboard-result.html',
  'storyboard-share.html'
];

function readPublic(file) {
  return fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
}

describe('Storyboard Functional Liquid Glass contract', () => {
  test.each(STORYBOARD_PAGES)('%s uses the isolated, deploy-versioned UI layer', file => {
    const html = readPublic(file);
    expect(html).toContain('<body class="storyboard-shell');
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

  test('result handoff explains independent reference eligibility without blocking prompts', () => {
    const html = readPublic('storyboard-result.html');
    const css = readPublic('style.css');
    expect(html).toContain('class="storyboard-reference-note" role="note"');
    expect(html).toContain('data-i18n="storyboardResult.referenceEligibility"');
    expect(html).toContain('you can still use the shot prompts');
    expect(css).toContain('.storyboard-reference-note');
    expect(css).toContain('overflow-wrap: anywhere');
  });

  test('result locale changes re-render cached data without racing API requests', () => {
    const source = readPublic(path.join('js', 'storyboard-result.js'));
    const localeHandler = source.slice(source.indexOf("document.addEventListener('promptgen:localechange'"));

    expect(source).toContain('function renderLocalizedResult(sb)');
    expect(localeHandler).toContain('renderLocalizedResult(currentStoryboard)');
    expect(localeHandler).toContain('renderSharePanel()');
    expect(localeHandler).not.toContain('loadResult()');
  });

  test('Storyboard routes render asset placeholders instead of sending raw templates', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    for (const file of STORYBOARD_PAGES.filter(file => file !== 'storyboard-share.html')) {
      expect(source).toContain(`sendVersionedPage(res, '${file}')`);
    }
    expect(source).toContain("versionedHtmlTemplates.get('storyboard-share.html')");
  });
});
