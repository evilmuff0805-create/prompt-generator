'use strict';

const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, route => route.abort());
});

test('Storyboard pages serve deploy-versioned assets without leaking placeholders', async ({ request }) => {
  for (const path of ['/storyboard', '/storyboard/history', '/storyboard/layout-contract']) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain('/storyboard.css?v=dev');
    expect(html).toContain('/style.css?v=dev');
    expect(html).not.toContain('__ASSET_VERSION__');
  }
});

for (const { width, label } of [
  { width: 320, label: '320px' },
  { width: 390, label: '390px' },
  { width: 720, label: '720px (1440px at 200% zoom equivalent)' },
  { width: 1440, label: '1440px' }
]) {
  test(`Storyboard form remains usable with long Russian UI at ${label}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/storyboard', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-locale-select]').selectOption('ru');

    await page.evaluate(() => {
      document.getElementById('loginModal')?.setAttribute('aria-hidden', 'true');
      document.getElementById('authGate').style.display = 'none';
      document.getElementById('planGate').style.display = 'none';
      document.getElementById('loadingGate').style.display = 'none';
      document.getElementById('mainForm').style.display = '';
    });

    await expect(page.locator('.storyboard-title')).toHaveText('Генератор раскадровок');
    await expect(page.locator('[data-i18n="storyboard.shots.nineMeta"]')).toContainText('13,5');

    const layout = await page.evaluate(() => {
      const selectors = [
        '.storyboard-genre-btn',
        '.storyboard-style-btn',
        '.storyboard-cut-btn',
        '#refUploadBtn',
        '#generateBtn'
      ];
      const targets = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        shortestControl: Math.min(...targets.map(element => element.getBoundingClientRect().height)),
        formRight: document.getElementById('storyboardForm').getBoundingClientRect().right
      };
    });

    expect(layout.overflow).toBeLessThanOrEqual(2);
    expect(layout.shortestControl).toBeGreaterThanOrEqual(44);
    expect(layout.formRight).toBeLessThanOrEqual(width + 1);
  });
}

test('Storyboard selection states stay keyboard-readable', async ({ page }) => {
  await page.route('**/js/storyboard.js*', route => route.abort());
  await page.goto('/storyboard', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.getElementById('loginModal')?.setAttribute('aria-hidden', 'true');
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('mainForm').style.display = '';
    window.StoryboardForm.initForm({ onSubmit: async () => {} });
  });

  const romance = page.locator('[data-genre="Romance"]');
  await expect(romance).toHaveAttribute('aria-pressed', 'false');
  await romance.click();
  await expect(romance).toHaveAttribute('aria-pressed', 'true');

  const cinematic = page.locator('[data-style="Cinematic"]');
  await cinematic.focus();
  await cinematic.press('Enter');
  await expect(cinematic).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-style="Pixar 3D"]')).toHaveAttribute('aria-pressed', 'false');

  const fourShots = page.locator('[data-cuts="4"]');
  await fourShots.focus();
  await fourShots.press('Space');
  await expect(fourShots).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-cuts="9"]')).toHaveAttribute('aria-pressed', 'false');
});

for (const width of [320, 390]) {
  test(`Storyboard result and history states do not overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route('**/js/storyboard-result.js*', route => route.abort());
    await page.route('**/js/storyboard-history.js*', route => route.abort());

    await page.goto('/storyboard/layout-contract', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-locale-select]').selectOption('ru');
    await page.evaluate(() => {
      document.getElementById('resultState').style.display = '';
      document.getElementById('resultMeta').innerHTML = '<span class="storyboard-meta-badge">Cinematic</span><span class="storyboard-meta-badge">9 Shots</span><span class="storyboard-meta-date">July 18, 2026</span>';
      document.getElementById('scenarioCard').style.display = '';
      document.getElementById('scenarioText').textContent = 'A deliberately long multilingual scenario remains readable without forcing horizontal scrolling in the completed storyboard workspace.';
      document.getElementById('shotList').innerHTML = '<div class="storyboard-shot-item" role="listitem"><div class="storyboard-shot-header"><span class="storyboard-shot-num">Shot 1</span><span class="storyboard-shot-angle">Extreme close-up</span></div><p class="storyboard-shot-desc">A long generated description remains inside the opaque result surface.</p><div class="storyboard-shot-prompt-wrap"><pre class="storyboard-shot-prompt">Ultra-realistic cinematic photography with detailed natural skin texture and an intentionally-long-unbroken-token-that-must-wrap-without-overflowing-the-mobile-viewport.</pre><button type="button" class="storyboard-copy-btn">Copy</button></div></div>';
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(2);
    await expect(page.locator('.storyboard-shot-prompt')).toBeVisible();
    await expect(page.locator('.storyboard-reference-note')).toContainText('Seedance проверяет референсные изображения самостоятельно.');
    await expect(page.locator('.storyboard-reference-note')).toHaveAttribute('role', 'note');

    await page.goto('/storyboard/history', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('historyLoading').style.display = 'none';
      const grid = document.getElementById('historyGrid');
      grid.style.display = '';
      grid.innerHTML = '<div class="storyboard-history-card" role="listitem"><a class="storyboard-history-card-link"><div class="storyboard-history-thumb storyboard-history-thumb--placeholder">📽️</div><div class="storyboard-history-info"><div class="storyboard-history-meta"><span class="storyboard-meta-badge">Кинематографичный</span><span class="storyboard-meta-badge">9 кадров</span><span class="storyboard-status-badge storyboard-status--processing">Обработка</span></div><div class="storyboard-history-genres">Научная фантастика, Детектив</div><div class="storyboard-history-date">18 июля 2026 г.</div></div></a><button type="button" class="storyboard-delete-btn" aria-label="Удалить">🗑️</button></div>';
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(2);
    await expect(page.locator('.storyboard-history-card')).toBeVisible();
  });
}
