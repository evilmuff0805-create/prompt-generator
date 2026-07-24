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

  test(`expectations and final CTA remain usable at ${viewport.label} width`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const section = page.locator('.expectations-section');
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
    await expect(section.locator('.expectation-card')).toHaveCount(3);

    const action = section.locator('.landing-final-cta__action');
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute('href', '/storyboard');

    const cardRows = await section.locator('.expectation-card').evaluateAll(elements => (
      elements.map(element => Math.round(element.getBoundingClientRect().top))
    ));
    expect(new Set(cardRows).size).toBe(viewport.columns === 1 ? 3 : 1);

    const actionBox = await action.boundingBox();
    expect(actionBox.height).toBeGreaterThanOrEqual(44);

    const ctaLayout = await section.locator('.landing-final-cta').evaluate(element => {
      const copy = element.querySelector('.landing-final-cta__copy');
      const action = element.querySelector('.landing-final-cta__action');
      const heading = element.querySelector('h2');
      const ctaBox = element.getBoundingClientRect();
      const copyBox = copy.getBoundingClientRect();
      const actionBox = action.getBoundingClientRect();
      const headingBox = heading.getBoundingClientRect();
      const headingLineHeight = Number.parseFloat(getComputedStyle(heading).lineHeight);

      return {
        ctaWidth: ctaBox.width,
        copyWidth: copyBox.width,
        actionWidth: actionBox.width,
        headingLines: headingBox.height / headingLineHeight
      };
    });

    expect(ctaLayout.copyWidth).toBeGreaterThanOrEqual(viewport.columns === 1 ? 240 : 420);
    expect(ctaLayout.headingLines).toBeLessThanOrEqual(3.1);
    if (viewport.columns === 3) {
      expect(ctaLayout.actionWidth).toBeLessThan(ctaLayout.ctaWidth * 0.5);
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test(`FAQ remains readable and keyboard-operable at ${viewport.label} width`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const faq = page.locator('#faq');
    await faq.scrollIntoViewIfNeeded();
    await expect(faq).toBeVisible();

    const items = faq.locator('.faq-item');
    await expect(items).toHaveCount(6);
    await expect(items.first()).toHaveAttribute('open', '');

    const secondSummary = items.nth(1).locator('summary');
    await secondSummary.focus();
    await expect(secondSummary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(items.nth(1)).toHaveAttribute('open', '');
    await expect(items.nth(1).locator('.faq-item__answer')).toBeVisible();

    const summaryBox = await secondSummary.boundingBox();
    expect(summaryBox.height).toBeGreaterThanOrEqual(44);

    const rows = await items.evaluateAll(elements => (
      elements.map(element => Math.round(element.getBoundingClientRect().left))
    ));
    expect(new Set(rows).size).toBe(viewport.columns === 1 ? 1 : 2);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test(`case study remains readable and does not autoplay at ${viewport.label} width`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const section = page.locator('#case-study');
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
    await expect(section.locator('.case-study__media')).toHaveCount(2);
    const storyboardImage = section.locator('.case-study__media--storyboard img');
    await storyboardImage.scrollIntoViewIfNeeded();
    await expect.poll(() => storyboardImage.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await storyboardImage.evaluate(image => image.decode());

    const rows = await section.locator('.case-study__media').evaluateAll(elements => (
      elements.map(element => Math.round(element.getBoundingClientRect().top))
    ));
    expect(new Set(rows).size).toBe(viewport.columns === 1 ? 2 : 1);

    const video = section.locator('video');
    await expect(video).toHaveAttribute('controls', '');
    await expect(video).toHaveAttribute('playsinline', '');
    await expect(video).toHaveAttribute('preload', 'metadata');
    await expect(video).not.toHaveAttribute('autoplay', '');
    await expect(video.locator('source')).toHaveAttribute('src', '/gallery/storyboards/story06-seedance.mp4');
    const metadata = await video.evaluate(element => new Promise(resolve => {
      const read = () => resolve({
        duration: element.duration,
        width: element.videoWidth,
        height: element.videoHeight
      });
      if (element.readyState >= HTMLMediaElement.HAVE_METADATA) read();
      else element.addEventListener('loadedmetadata', read, { once: true });
    }));
    expect(metadata.duration).toBeGreaterThanOrEqual(14);
    expect(metadata.duration).toBeLessThanOrEqual(16);
    expect(metadata.width).toBeGreaterThanOrEqual(640);
    expect(metadata.height).toBeGreaterThanOrEqual(360);
    expect(await video.evaluate(element => ({ paused: element.paused, currentTime: element.currentTime }))).toEqual({
      paused: true,
      currentTime: 0
    });

    const action = section.locator('.case-study__action');
    await expect(action).toHaveAttribute('href', '/storyboard');
    const actionBox = await action.boundingBox();
    expect(actionBox.height).toBeGreaterThanOrEqual(44);

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

test('expectations and final CTA follow the selected locale', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-locale-select]').selectOption('ko');

  const section = page.locator('.expectations-section');
  await section.scrollIntoViewIfNeeded();
  await expect(section.locator('#expectationsTitle')).toHaveText('시작 전 꼭 알아야 할 세 가지');
  await expect(section.locator('.expectation-card').nth(1)).toContainText('결과는 90일 동안 보관');
  await expect(section.locator('.landing-final-cta__action')).toHaveText('스토리보드 만들기');
});

test('FAQ questions and answers follow the selected locale', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-locale-select]').selectOption('ko');

  const faq = page.locator('#faq');
  await faq.scrollIntoViewIfNeeded();
  await expect(faq.locator('#faqTitle')).toHaveText('만들기 전에 꼭 필요한 답을 확인하세요.');
  await expect(faq.locator('.faq-item').nth(2).locator('summary')).toContainText('크레딧은 어떻게 사용되나요?');
  await faq.locator('.faq-item').nth(2).locator('summary').click();
  await expect(faq.locator('.faq-item').nth(2).locator('.faq-item__answer')).toContainText('기본 30크레딧');
  await expect(faq.locator('.faq-item').nth(2).locator('.faq-item__answer')).toContainText('참조 이미지 1장당 5크레딧');
  await expect(faq.locator('.faq-item').nth(5).locator('summary')).toContainText('어떤 인터페이스 언어를 지원하나요?');
});

test('case study boundary and labels follow the selected locale', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-locale-select]').selectOption('ko');

  const section = page.locator('#case-study');
  await section.scrollIntoViewIfNeeded();
  await expect(section.locator('#caseStudyTitle')).toHaveText('하나의 시나리오, 아홉 개의 연출된 컷, 하나의 완성된 시퀀스.');
  await expect(section.locator('.case-study__facts')).toContainText('애니메이션 스타일');
  await expect(section.locator('.case-study__media-label').nth(0)).toContainText('PromptGen 스토리보드');
  await expect(section.locator('.case-study__media-label').nth(1)).toContainText('Seedance 결과');
  await expect(section.locator('.case-study__media').nth(1).locator('figcaption')).toContainText('PromptGen에는 영상 렌더링이 포함되지 않습니다.');
});
