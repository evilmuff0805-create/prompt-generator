/**
 * E2E 테스트: 기본 페이지 로드 및 API 상태 확인
 */
const { test, expect } = require('@playwright/test');

test.describe('Health & Page Load', () => {
  test('헬스체크 API가 200을 반환해야 한다', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('메인 페이지가 정상 로드되어야 한다', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/PromptGen/i);
  });

  test('메인 페이지에 업로드 영역이 있어야 한다', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#dropZone')).toBeVisible();
  });

  test('메인 페이지에 Analyze 버튼이 있어야 한다', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#analyzeBtn')).toBeVisible();
  });

  test('랜딩 히어로가 핵심 메시지와 생성 CTA를 노출해야 한다', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.hero__title')).toContainText('Turn your story.');
    await expect(page.locator('.hero__title')).toContainText('Into every shot.');
    await expect(page.locator('.hero-demo')).toBeVisible();
    await expect(page.locator('#heroStoryboardAnimation img')).toBeVisible();
    await expect(page.locator('.hero-storyboard__tabs [role="tab"]')).toHaveCount(3);

    const primaryCta = page.locator('.btn--hero');
    await expect(primaryCta).toContainText('Create a storyboard');
    await expect(primaryCta).toHaveAttribute('href', '/storyboard');

    const secondaryCta = page.locator('.hero__text-link');
    await expect(secondaryCta).toContainText('Try Image to Prompt');
    await expect(secondaryCta).toHaveAttribute('href', '#upload-section');
  });

  test('Hero 실제 Storyboard 탭은 자동 재생 없이 클릭·키보드로 전환돼야 한다', async ({ page }) => {
    await page.goto('/');

    const animation = page.locator('#heroStoryboardTabAnimation');
    const documentary = page.locator('#heroStoryboardTabDocumentary');
    const cinematic = page.locator('#heroStoryboardTabCinematic');

    await expect(animation).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#heroStoryboardAnimation')).toBeVisible();
    await expect.poll(() => page.locator('#heroStoryboardAnimation img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.waitForTimeout(250);
    await expect(animation).toHaveAttribute('aria-selected', 'true');

    await documentary.click();
    await expect(documentary).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#heroStoryboardDocumentary')).toBeVisible();
    await expect.poll(() => page.locator('#heroStoryboardDocumentary img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(page.locator('#heroStoryboardAnimation')).toBeHidden();

    await documentary.press('ArrowRight');
    await expect(cinematic).toBeFocused();
    await expect(cinematic).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#heroStoryboardCinematic')).toBeVisible();
    await expect.poll(() => page.locator('#heroStoryboardCinematic img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  });

  test('모바일 내비게이션은 상태를 알리고 스크롤을 잠근 뒤 Escape로 닫혀야 한다', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const hamburger = page.locator('#hamburger');
    const navMenu = page.locator('#navMenu');

    await expect(hamburger).toBeVisible();
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    await hamburger.click();
    await expect(hamburger).toHaveAttribute('aria-expanded', 'true');
    await expect(navMenu).toHaveClass(/open/);
    await expect(page.locator('body')).toHaveClass(/nav-open/);
    const menuBox = await navMenu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox.width).toBeGreaterThanOrEqual(389);
    expect(menuBox.height).toBeGreaterThanOrEqual(843);

    await page.keyboard.press('Escape');
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('body')).not.toHaveClass(/nav-open/);
  });

  test('reduced motion 환경에서는 히어로 반복 애니메이션을 중지해야 한다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    await expect(page.locator('.hero__aurora--mint')).toHaveCSS('animation-name', 'none');
  });

  test('인증 없이 /api/analyze POST는 401을 반환해야 한다', async ({ request }) => {
    const res = await request.post('/api/analyze');
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('AUTH_REQUIRED');
  });

  test('인증 없이 /api/user/profile GET은 401을 반환해야 한다', async ({ request }) => {
    const res = await request.get('/api/user/profile');
    expect(res.status()).toBe(401);
  });

  test('갤러리 페이지가 정상 로드되어야 한다', async ({ page }) => {
    await page.goto('/#gallery');
    await expect(page.locator('body')).toBeVisible();
  });

  test('법적 페이지(terms)가 접근 가능해야 한다', async ({ page }) => {
    const res = await page.goto('/terms.html');
    expect(res.status()).toBe(200);
  });

  test('법적 페이지(privacy)가 접근 가능해야 한다', async ({ page }) => {
    const res = await page.goto('/privacy.html');
    expect(res.status()).toBe(200);
    await expect(page.getByText('Cloudflare:', { exact: false })).toBeVisible();
    await expect(page.getByText("separate from PromptGen's first-party product funnel events", { exact: false })).toBeVisible();
  });

  test('법적 페이지(refund)가 접근 가능해야 한다', async ({ page }) => {
    const res = await page.goto('/refund.html');
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('__ASSET_VERSION__');
    expect(html).toMatch(/\/i18n\/legal-content\.js\?v=[a-zA-Z0-9._-]+/);
  });
});

test.describe('보안 헤더', () => {
  test('X-Frame-Options 헤더가 DENY여야 한다', async ({ request }) => {
    const res = await request.get('/');
    expect(res.headers()['x-frame-options']).toBe('DENY');
  });

  test('X-Content-Type-Options 헤더가 nosniff여야 한다', async ({ request }) => {
    const res = await request.get('/');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('Content-Security-Policy 헤더가 있어야 한다', async ({ request }) => {
    const res = await request.get('/');
    expect(res.headers()['content-security-policy']).toBeTruthy();
  });

  test('HSTS 헤더가 장기 max-age와 하위 도메인 보호를 포함해야 한다', async ({ request }) => {
    const res = await request.get('/');
    expect(res.headers()['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });
});
