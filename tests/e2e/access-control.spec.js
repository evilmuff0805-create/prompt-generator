'use strict';

const { test, expect } = require('@playwright/test');

test.describe('OAuth and plan access contracts', () => {
  test('main page exposes the Google sign-in entry point without starting OAuth', async ({ page }) => {
    await page.goto('/');
    await page.locator('#loginNavBtn').click();

    const modal = page.locator('#loginModal');
    await expect(modal).toHaveAttribute('aria-hidden', 'false');
    await expect(modal.locator('#googleLoginBtn')).toBeVisible();
    await expect(modal.locator('#googleLoginBtn')).toContainText('Sign in with Google');
  });

  test('Endframe remains a free, local-only tool behind sign-in', async ({ page }) => {
    const response = await page.goto('/frame');
    expect(response.status()).toBe(200);

    await expect(page.getByRole('heading', { name: 'Endframe Extractor' })).toBeVisible();
    await expect(page.locator('#frameAuthGate')).toContainText('completely free');
    await expect(page.locator('#frameAuthGate')).toContainText('no credits needed');
    await expect(page.locator('#frameAuthGateSignIn')).toContainText('Sign in with Google');
    await expect(page.getByText('No upload — processes locally in your browser')).toBeAttached();
  });

  test('Storyboard public config and paid-plan UI use the same cost contract', async ({ page, request }) => {
    const configResponse = await request.get('/api/storyboard/config');
    expect(configResponse.status()).toBe(200);
    const config = await configResponse.json();

    expect(config.success).toBe(true);
    expect(config.storyboardCost).toBe(config.catalog.storyboardCreditCost);
    expect(config.catalog.plans.free.features).not.toContain('storyboard_generator');
    expect(config.catalog.plans.pro.features).toContain('storyboard_generator');
    expect(config.catalog.plans.enterprise.features).toContain('storyboard_generator');

    const response = await page.goto('/storyboard');
    expect(response.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Storyboard Generator' })).toBeVisible();
    await expect(page.locator('#planGate')).toContainText('Pro Plan Required');
    await expect(page.locator('#planGate [data-i18n="storyboard.plan.description"]'))
      .toContainText(String(config.storyboardCost));
    await expect(page.locator('#loginBtn')).toContainText('Sign In with Google');
  });

  test('Storyboard mutation and history APIs reject anonymous access', async ({ request }) => {
    const generate = await request.post('/api/storyboard/generate', {
      data: {
        scenario: 'A long enough scenario that must still be rejected before processing.',
        genres: ['drama'],
        style: 'cinematic',
        cutCount: 4,
        referenceImageIds: []
      }
    });
    expect(generate.status()).toBe(401);
    const generateBody = await generate.json();
    expect(generateBody).toMatchObject({ code: 'AUTH_REQUIRED' });

    const history = await request.get('/api/storyboard/list');
    expect(history.status()).toBe(401);
    const historyBody = await history.json();
    expect(historyBody).toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
