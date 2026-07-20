'use strict';

const { test, expect } = require('@playwright/test');

const LOCALES = ['en', 'ko', 'ja', 'zh-CN', 'fr', 'ru'];
const VIEWPORTS = [
  { width: 375, height: 812, label: '375' },
  { width: 390, height: 844, label: '390' },
  { width: 512, height: 768, label: '1024-at-200-percent' },
  { width: 720, height: 900, label: '1440-at-200-percent' },
  { width: 768, height: 900, label: '768' },
  { width: 1024, height: 900, label: '1024' },
  { width: 1440, height: 900, label: '1440' }
];

const MATRIX = [
  ...LOCALES.flatMap(locale => VIEWPORTS
    .filter(viewport => ['390', '1440-at-200-percent'].includes(viewport.label))
    .map(viewport => ({ locale, viewport }))),
  ...VIEWPORTS
    .filter(viewport => !['390', '1440-at-200-percent'].includes(viewport.label))
    .map(viewport => ({ locale: 'ru', viewport }))
];

const STATIC_PAGES = [
  { path: '/', name: 'landing', anchor: '.hero__title' },
  { path: '/image-to-prompt', name: 'image-to-prompt', anchor: '#dropZone' },
  { path: '/frame', name: 'endframe', anchor: '.section-title' },
  { path: '/storyboard', name: 'storyboard', anchor: '.storyboard-title' },
  { path: '/privacy.html', name: 'privacy', anchor: '.page-title' }
];

const SECONDARY_LEGAL_PAGES = [
  { path: '/terms.html', name: 'terms', anchor: '.page-title' },
  { path: '/refund.html', name: 'refund', anchor: '.page-title' }
];

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, route => route.abort());
  await page.route('**/js/storyboard-history.js*', route => route.abort());
  await page.route('**/js/storyboard-result.js*', route => route.abort());
});

async function applyLocale(page, locale) {
  const selector = page.locator('[data-locale-select]');
  await expect(selector).toBeVisible();
  await selector.selectOption(locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

async function showStoryboardForm(page) {
  await page.evaluate(() => {
    document.getElementById('loginModal')?.setAttribute('aria-hidden', 'true');
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('planGate').style.display = 'none';
    document.getElementById('loadingGate').style.display = 'none';
    document.getElementById('mainForm').style.display = '';
  });
}

async function auditPage(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const clipped = [];
    const candidates = document.querySelectorAll([
      'h1', 'h2', 'h3',
      'button', '.btn', '.tool-tab', '.nav-link',
      '.locale-switcher__select',
      '.pricing-card__title', '.pricing-card__description', '.pricing-note',
      '.storyboard-style-name', '.storyboard-style-desc',
      '.storyboard-cut-btn', '.storyboard-meta-badge',
      '.legal-translation-note'
    ].join(','));

    candidates.forEach((element) => {
      if (!(element instanceof HTMLElement)) return;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return;

      const clipsX = ['hidden', 'clip'].includes(style.overflowX);
      const clipsY = ['hidden', 'clip'].includes(style.overflowY);
      let clippedX = clipsX && element.scrollWidth > element.clientWidth + 1;
      let clippedY = clipsY && element.scrollHeight > element.clientHeight + 1;

      if (element.matches('.storyboard-style-btn')) {
        const contentRects = [...element.children]
          .filter(child => child instanceof HTMLElement && getComputedStyle(child).display !== 'none')
          .map(child => child.getBoundingClientRect());
        clippedX = clipsX && contentRects.some(child => child.left < rect.left - 1 || child.right > rect.right + 1);
        clippedY = clipsY && contentRects.some(child => child.top < rect.top - 1 || child.bottom > rect.bottom + 1);
      }
      if (!clippedX && !clippedY) return;

      clipped.push({
        tag: element.tagName.toLowerCase(),
        className: element.className,
        text: (element.textContent || '').trim().slice(0, 120),
        client: [element.clientWidth, element.clientHeight],
        scroll: [element.scrollWidth, element.scrollHeight]
      });
    });

    return {
      overflow: root.scrollWidth - root.clientWidth,
      clipped: clipped.slice(0, 12)
    };
  });
}

async function verifyLayout(page, testInfo, context) {
  const audit = await auditPage(page);
  const shouldCapture = process.env.I18N_SCREENSHOT_MATRIX === '1'
    || audit.overflow > 2
    || audit.clipped.length > 0;

  if (shouldCapture) {
    await page.screenshot({
      path: testInfo.outputPath(`${context}.png`),
      fullPage: true
    });
  }

  expect(audit, `${context} layout contract`).toEqual({ overflow: expect.any(Number), clipped: [] });
  expect(audit.overflow, `${context} horizontal overflow`).toBeLessThanOrEqual(2);
}

async function showHistoryFixture(page) {
  await page.evaluate(() => {
    document.getElementById('historyLoading').style.display = 'none';
    const grid = document.getElementById('historyGrid');
    grid.style.display = '';
    grid.innerHTML = '<div class="storyboard-history-card" role="listitem"><a class="storyboard-history-card-link"><div class="storyboard-history-thumb storyboard-history-thumb--placeholder">📽️</div><div class="storyboard-history-info"><div class="storyboard-history-meta"><span class="storyboard-meta-badge">Cinematic</span><span class="storyboard-meta-badge">9 Shots</span><span class="storyboard-status-badge storyboard-status--processing">Processing</span></div><div class="storyboard-history-genres">Science Fiction, Mystery, Romance</div><div class="storyboard-history-date">July 18, 2026</div></div></a><button type="button" class="storyboard-delete-btn" aria-label="Delete">🗑️</button></div>';
  });
}

async function showResultFixture(page) {
  await page.evaluate(() => {
    document.getElementById('resultState').style.display = '';
    document.getElementById('resultMeta').innerHTML = '<span class="storyboard-meta-badge">Cinematic</span><span class="storyboard-meta-badge">9 Shots</span><span class="storyboard-meta-date">July 18, 2026</span>';
    document.getElementById('scenarioCard').style.display = '';
    document.getElementById('scenarioText').textContent = 'A multilingual scenario remains user-authored and must stay readable at every supported zoom level.';
    document.getElementById('shotList').innerHTML = '<div class="storyboard-shot-item" role="listitem"><div class="storyboard-shot-header"><span class="storyboard-shot-num">Shot 1</span><span class="storyboard-shot-angle">Extreme close-up</span></div><p class="storyboard-shot-desc">Generated descriptions remain readable inside the opaque result surface.</p><div class="storyboard-shot-prompt-wrap"><pre class="storyboard-shot-prompt">Ultra-realistic cinematic photography, natural skin texture, physically plausible light and a long prompt that must wrap without leaving the viewport.</pre><button type="button" class="storyboard-copy-btn">Copy</button></div></div>';
  });
}

for (const { locale, viewport } of MATRIX) {
  test(`${locale} stays readable at ${viewport.label}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const target of STATIC_PAGES) {
        await page.goto(target.path, { waitUntil: 'domcontentloaded' });
        await applyLocale(page, locale);
        if (target.name === 'storyboard') {
          await showStoryboardForm(page);
        }
        await expect(page.locator(target.anchor)).toBeVisible();
        await verifyLayout(page, testInfo, `${locale}-${viewport.label}-${target.name}`);
      }

      if (viewport.label === '390') {
        for (const target of SECONDARY_LEGAL_PAGES) {
          await page.goto(target.path, { waitUntil: 'domcontentloaded' });
          await applyLocale(page, locale);
          await expect(page.locator(target.anchor)).toBeVisible();
          await verifyLayout(page, testInfo, `${locale}-${viewport.label}-${target.name}`);
        }
      }

      await page.goto('/storyboard/history', { waitUntil: 'domcontentloaded' });
      await applyLocale(page, locale);
      await showHistoryFixture(page);
      await verifyLayout(page, testInfo, `${locale}-${viewport.label}-storyboard-history`);

      await page.goto('/storyboard/layout-contract', { waitUntil: 'domcontentloaded' });
      await applyLocale(page, locale);
      await showResultFixture(page);
      await verifyLayout(page, testInfo, `${locale}-${viewport.label}-storyboard-result`);
  });
}
