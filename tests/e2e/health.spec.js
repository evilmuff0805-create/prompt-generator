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

  test('Image to Prompt 페이지에 업로드 영역이 있어야 한다', async ({ page }) => {
    await page.goto('/image-to-prompt');
    await expect(page.locator('#dropZone')).toBeVisible();
  });

  test('Image to Prompt 페이지에 Analyze 버튼이 있어야 한다', async ({ page }) => {
    await page.goto('/image-to-prompt');
    await expect(page.locator('#analyzeBtn')).toBeVisible();
  });

  test('랜딩과 Image to Prompt의 정보 구조를 분리해야 한다', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('PromptGen — AI Storyboard Generator & Prompt Tools');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Turn scenarios and reference images into consistent 4- or 9-shot storyboards with Seedance-ready prompts. Includes Image to Prompt and Endframe Extractor.');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://promptgen-ai.com/');
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://promptgen-ai.com/');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'PromptGen — Direct Your Story, Shot by Shot');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://promptgen-ai.com/og-image-landing.png');
    await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute('content', 'PromptGen AI storyboard direction preview');
    await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200');
    await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630');
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute('content', 'PromptGen — Direct Your Story, Shot by Shot');
    const landingStructuredData = JSON.parse(await page.locator('#productStructuredData').textContent());
    expect(landingStructuredData).toMatchObject({
      name: 'PromptGen',
      url: 'https://promptgen-ai.com/',
      description: expect.stringContaining('4- or 9-shot storyboard grids')
    });
    await expect(page.locator('.hero')).toBeVisible();
    await expect(page.locator('#tools')).toBeVisible();
    await expect(page.locator('#pricing')).toBeVisible();
    await expect(page.locator('#upload-section')).toHaveCount(0);
    await expect(page.locator('.tool-tab--active')).toHaveCount(0);

    await page.goto('/image-to-prompt');
    await expect(page).toHaveTitle('Image to Prompt Generator — PromptGen');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Turn any reference image into a precise, editable AI prompt for Midjourney, GPT Image 2, and Nano Banana Pro.');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://promptgen-ai.com/image-to-prompt');
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://promptgen-ai.com/image-to-prompt');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Image to Prompt Generator — PromptGen');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://promptgen-ai.com/og-image-image-to-prompt.png');
    await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute('content', 'PromptGen Image to Prompt analysis preview');
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute('content', 'Image to Prompt Generator — PromptGen');
    const imageToolStructuredData = JSON.parse(await page.locator('#productStructuredData').textContent());
    expect(imageToolStructuredData).toMatchObject({
      name: 'PromptGen Image to Prompt',
      url: 'https://promptgen-ai.com/image-to-prompt',
      description: expect.stringContaining('Turn a reference image into a precise, editable AI prompt')
    });
    await expect(page.locator('#upload-section')).toBeVisible();
    await expect(page.locator('#how-it-works')).toBeVisible();
    await expect(page.locator('#gallery')).toBeVisible();
    await expect(page.locator('.hero')).toHaveCount(0);
    await expect(page.locator('#tools')).toHaveCount(0);
    await expect(page.locator('#pricing')).toHaveCount(0);
    await expect(page.locator('.tool-tab[href="/image-to-prompt"]')).toHaveClass(/tool-tab--active/);
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
    await expect(secondaryCta).toHaveAttribute('href', '/image-to-prompt#upload-section');
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

  test('도구별 소셜 미리보기 이미지는 실제 1200×630 PNG로 제공되어야 한다', async ({ request, page }) => {
    for (const imagePath of [
      '/og-image-landing.png',
      '/og-image-image-to-prompt.png',
      '/og-image-storyboard.png',
      '/og-image-frame.png'
    ]) {
      const response = await request.get(imagePath);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('image/png');
      expect((await response.body()).length).toBeGreaterThan(40 * 1024);
    }

    await page.goto('/storyboard');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://promptgen-ai.com/og-image-storyboard.png');
    await page.goto('/frame');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://promptgen-ai.com/og-image-frame.png');
  });

  test('존재하지 않는 실행 스크립트와 정적 자원 경로는 랜딩 대신 404를 반환해야 한다', async ({ request }) => {
    for (const requestPath of ['/1.php', '/100.php/', '/missing-runtime.js']) {
      const res = await request.get(requestPath);
      expect(res.status()).toBe(404);
      expect(res.headers()['cache-control']).toBe('no-store');
      expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
      expect(await res.text()).toBe('Not found');
    }
  });

  test('존재하지 않는 API GET은 HTML 랜딩이 아니라 JSON 404를 반환해야 한다', async ({ request }) => {
    const res = await request.get('/api/not-a-real-endpoint');
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('application/json');
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(await res.json()).toEqual({ success: false, code: 'NOT_FOUND' });
  });

  test('확장자가 없는 레거시 마케팅 경로의 랜딩 fallback은 유지해야 한다', async ({ request }) => {
    const res = await request.get('/legacy-campaign');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('PromptGen');
  });

  test('갤러리 페이지가 정상 로드되어야 한다', async ({ page }) => {
    await page.goto('/image-to-prompt#gallery');
    await expect(page.locator('#gallery')).toBeVisible();
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
