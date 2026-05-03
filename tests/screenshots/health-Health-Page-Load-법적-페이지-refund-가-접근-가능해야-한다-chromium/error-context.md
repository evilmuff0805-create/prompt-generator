# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: health.spec.js >> Health & Page Load >> 법적 페이지(refund)가 접근 가능해야 한다
- Location: tests\e2e\health.spec.js:56:3

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/refund.html
Call log:
  - navigating to "http://localhost:3000/refund.html", waiting until "load"

```

# Test source

```ts
  1  | /**
  2  |  * E2E 테스트: 기본 페이지 로드 및 API 상태 확인
  3  |  */
  4  | const { test, expect } = require('@playwright/test');
  5  | 
  6  | test.describe('Health & Page Load', () => {
  7  |   test('헬스체크 API가 200을 반환해야 한다', async ({ request }) => {
  8  |     const res = await request.get('/api/health');
  9  |     expect(res.status()).toBe(200);
  10 |     const body = await res.json();
  11 |     expect(body.status).toBe('ok');
  12 |   });
  13 | 
  14 |   test('메인 페이지가 정상 로드되어야 한다', async ({ page }) => {
  15 |     await page.goto('/');
  16 |     await expect(page).toHaveTitle(/PromptGen/i);
  17 |   });
  18 | 
  19 |   test('메인 페이지에 업로드 영역이 있어야 한다', async ({ page }) => {
  20 |     await page.goto('/');
  21 |     await expect(page.locator('#dropZone')).toBeVisible();
  22 |   });
  23 | 
  24 |   test('메인 페이지에 Analyze 버튼이 있어야 한다', async ({ page }) => {
  25 |     await page.goto('/');
  26 |     await expect(page.locator('#analyzeBtn')).toBeVisible();
  27 |   });
  28 | 
  29 |   test('인증 없이 /api/analyze POST는 401을 반환해야 한다', async ({ request }) => {
  30 |     const res = await request.post('/api/analyze');
  31 |     expect(res.status()).toBe(401);
  32 |     const body = await res.json();
  33 |     expect(body.code).toBe('AUTH_REQUIRED');
  34 |   });
  35 | 
  36 |   test('인증 없이 /api/user/profile GET은 401을 반환해야 한다', async ({ request }) => {
  37 |     const res = await request.get('/api/user/profile');
  38 |     expect(res.status()).toBe(401);
  39 |   });
  40 | 
  41 |   test('갤러리 페이지가 정상 로드되어야 한다', async ({ page }) => {
  42 |     await page.goto('/#gallery');
  43 |     await expect(page.locator('body')).toBeVisible();
  44 |   });
  45 | 
  46 |   test('법적 페이지(terms)가 접근 가능해야 한다', async ({ page }) => {
  47 |     const res = await page.goto('/terms.html');
  48 |     expect(res.status()).toBe(200);
  49 |   });
  50 | 
  51 |   test('법적 페이지(privacy)가 접근 가능해야 한다', async ({ page }) => {
  52 |     const res = await page.goto('/privacy.html');
  53 |     expect(res.status()).toBe(200);
  54 |   });
  55 | 
  56 |   test('법적 페이지(refund)가 접근 가능해야 한다', async ({ page }) => {
> 57 |     const res = await page.goto('/refund.html');
     |                            ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/refund.html
  58 |     expect(res.status()).toBe(200);
  59 |   });
  60 | });
  61 | 
  62 | test.describe('보안 헤더', () => {
  63 |   test('X-Frame-Options 헤더가 DENY여야 한다', async ({ request }) => {
  64 |     const res = await request.get('/');
  65 |     expect(res.headers()['x-frame-options']).toBe('DENY');
  66 |   });
  67 | 
  68 |   test('X-Content-Type-Options 헤더가 nosniff여야 한다', async ({ request }) => {
  69 |     const res = await request.get('/');
  70 |     expect(res.headers()['x-content-type-options']).toBe('nosniff');
  71 |   });
  72 | 
  73 |   test('Content-Security-Policy 헤더가 있어야 한다', async ({ request }) => {
  74 |     const res = await request.get('/');
  75 |     expect(res.headers()['content-security-policy']).toBeTruthy();
  76 |   });
  77 | });
  78 | 
```