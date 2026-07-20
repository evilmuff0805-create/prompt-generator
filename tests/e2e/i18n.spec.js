const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, route => route.abort());
});

test.describe('English-first locale policy', () => {
  test.use({ locale: 'ko-KR' });

  test('starts in English until the user explicitly chooses another language', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('[data-locale-select]')).toHaveValue('en');
    await expect(page.locator('.hero__title')).toContainText('Into every shot.');
  });
});

test('global language switcher translates pages and preserves the explicit choice', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const localeSelect = page.locator('[data-locale-select]');
  await expect(localeSelect).toBeVisible();
  await expect(localeSelect.locator('option')).toHaveCount(6);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await localeSelect.selectOption('ko');
  await expect(page.locator('.hero__title')).toContainText('모든 컷으로.');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');

  await page.goto('/frame', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-locale-select]')).toHaveValue('ko');
  await expect(page.locator('h1')).toHaveText('엔드프레임 추출기');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
});

test('locale changes never translate user-entered scenario text', async ({ page }) => {
  await page.goto('/storyboard', { waitUntil: 'domcontentloaded' });
  const scenario = 'A user-authored scenario must remain exactly as it was entered, even after changing the interface language.';
  await page.locator('#scenario').evaluate((element, value) => { element.value = value; }, scenario);
  await page.locator('[data-locale-select]').selectOption('ja');
  await expect(page.locator('#scenario')).toHaveValue(scenario);
  await expect(page.locator('.storyboard-title')).toHaveText('ストーリーボード生成');
});

test('legal pages use the same switcher and show the translated governing-language notice', async ({ page }) => {
  await page.goto('/privacy.html', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-locale-select]').selectOption('ru');
  await expect(page.locator('h1')).toHaveText('Политика конфиденциальности');
  await expect(page.locator('.legal-translation-note')).toContainText('английской версией');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
});

test('long Russian navigation remains within a 390px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-locale-select]').selectOption('ru');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);

  const hamburger = page.locator('#hamburger');
  const hamburgerBox = await hamburger.boundingBox();
  expect(hamburgerBox).not.toBeNull();
  expect(hamburgerBox.x).toBeGreaterThanOrEqual(0);
  expect(hamburgerBox.x + hamburgerBox.width).toBeLessThanOrEqual(390);
  await hamburger.click({ trial: true });
});
