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
