'use strict';

const { test, expect } = require('@playwright/test');

const VIEWPORTS = [
  { width: 375, height: 812, columns: 1, label: 'mobile' },
  { width: 1024, height: 900, columns: 3, label: 'desktop' }
];

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, route => route.abort());
});

for (const viewport of VIEWPORTS) {
  test(`pipeline previews stay complete at ${viewport.label} width`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const section = page.locator('#tools');
    await section.scrollIntoViewIfNeeded();

    const cards = section.locator('.tool-card');
    await expect(cards).toHaveCount(3);
    await expect(section.locator('.tool-card__proof')).toHaveCount(3);

    const media = section.locator('.tool-card__media img');
    for (let index = 0; index < 3; index += 1) {
      await media.nth(index).scrollIntoViewIfNeeded();
      await expect.poll(() => media.nth(index).evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    }

    const mediaLoaded = await media.evaluateAll(images => images.map(image => ({
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      loading: image.loading
    })));

    expect(mediaLoaded).toHaveLength(3);
    expect(mediaLoaded.every(image => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(mediaLoaded.every(image => image.loading === 'lazy')).toBe(true);

    const cardRows = await cards.evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().top)));
    expect(new Set(cardRows).size).toBe(viewport.columns === 1 ? 3 : 1);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
}

test('pipeline evidence labels follow the selected locale', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-locale-select]').selectOption('ko');

  await expect(page.locator('#tools .tool-card__media-label').first()).toHaveText('이미지→프롬프트');
  await expect(page.locator('#tools .tool-card__proof').nth(1)).toContainText('추출된 마지막 프레임');
  await expect(page.locator('#tools .tool-card__media-label').nth(2)).toHaveText('실제 결과');
});
