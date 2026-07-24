const { test, expect } = require('@playwright/test');

const session = {
  access_token: 'e2e-access-token',
  user: { id: 'e2e-user', email: 'creator@example.com' },
};

const catalog = {
  analysisCreditCost: 2,
  storyboardCreditCost: 30,
  storyboardCreditPolicy: { baseCost: 30, perReferenceCost: 5, maxReferences: 4, minCost: 30, maxCost: 50 },
  plans: {
    free: { id: 'free', name: 'Free', monthlyPriceUsd: 0, credits: 0, storyboards: null, imageAnalyses: null },
    pro: { id: 'pro', name: 'Pro', monthlyPriceUsd: 9.99, credits: 600, storyboards: 20, imageAnalyses: 300 },
    enterprise: { id: 'enterprise', name: 'Enterprise', monthlyPriceUsd: 19.99, credits: 1500, storyboards: 50, imageAnalyses: 750 },
  },
  paddle: { clientToken: 'e2e-client-token' },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ fakeSession }) => {
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: fakeSession } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signInWithOAuth: async () => ({ error: null }),
          signInWithIdToken: async () => ({ error: null }),
          signOut: async () => ({ error: null }),
        },
      }),
    };
  }, { fakeSession: session });

  await page.route('**/api/catalog', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, catalog }),
  }));
  await page.route('**/api/user/profile', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      user: { full_name: 'Long Creator Name', email: 'creator@example.com' },
      plan: 'pro',
      credits: 80,
      daily_used: 0,
    }),
  }));
  await page.route(/^https:\/\//, route => route.abort());
});

test('authenticated account actions collapse into an accessible menu without clipping the locale switcher', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const trigger = page.locator('#accountMenuTrigger');
  const accountMenu = page.locator('#accountMenu');
  const manageSubscription = page.locator('#manageSubBtn');

  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(accountMenu).toBeHidden();
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');
  await expect(manageSubscription).toBeHidden();

  const layout = await page.evaluate(() => {
    const locale = document.querySelector('[data-locale-switcher]').getBoundingClientRect();
    const navbar = document.querySelector('.navbar__inner').getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      localeLeft: locale.left,
      localeRight: locale.right,
      navbarLeft: navbar.left,
      navbarRight: navbar.right,
    };
  });

  expect(layout.documentOverflow).toBeLessThanOrEqual(2);
  expect(layout.localeLeft).toBeGreaterThanOrEqual(layout.navbarLeft - 1);
  expect(layout.localeRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.localeRight).toBeLessThanOrEqual(layout.navbarRight + 1);

  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(accountMenu).toBeVisible();
  await expect(page.locator('#usageDisplay')).toContainText('80');
  await expect(page.locator('#historyBtn')).toBeVisible();
  await expect(manageSubscription).toBeVisible();
  await expect(page.locator('#logoutBtn')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(accountMenu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('account menu remains usable inside the mobile navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');
  await page.locator('#hamburger').click();
  await page.locator('#accountMenuTrigger').click();

  await expect(page.locator('#navMenu')).toHaveClass(/open/);
  await expect(page.locator('#accountMenu')).toBeVisible();

  const bounds = await page.locator('#accountMenu').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
});
