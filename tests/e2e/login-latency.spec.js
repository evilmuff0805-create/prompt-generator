const { test, expect } = require('@playwright/test');

const signedInSession = {
  access_token: 'e2e-signed-in-token',
  user: {
    id: 'login-latency-user',
    email: 'fast.creator@example.com',
    user_metadata: { full_name: 'Fast Creator' },
  },
};

const catalog = {
  analysisCreditCost: 2,
  storyboardCreditCost: 30,
  storyboardCreditPolicy: { baseCost: 30, perReferenceCost: 5, maxReferences: 4, minCost: 30, maxCost: 50 },
  plans: {
    free: { id: 'free', name: 'Free', monthlyPriceUsd: 0, credits: 0 },
    pro: { id: 'pro', name: 'Pro', monthlyPriceUsd: 9.99, credits: 600 },
    enterprise: { id: 'enterprise', name: 'Enterprise', monthlyPriceUsd: 19.99, credits: 1500 },
  },
  paddle: { clientToken: 'e2e-client-token' },
};

test('sign-in UI completes before delayed profile hydration and deduplicates repeated auth events', async ({ page }) => {
  await page.addInitScript(({ session }) => {
    window.__e2eSignedInSession = session;
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: null } }),
          onAuthStateChange: callback => {
            window.__e2eAuthCallback = callback;
            queueMicrotask(() => callback('INITIAL_SESSION', null));
            return { data: { subscription: { unsubscribe() {} } } };
          },
          signInWithIdToken: async () => ({ error: null }),
          signOut: async () => ({ error: null }),
        },
      }),
    };
  }, { session: signedInSession });

  await page.route('**/api/catalog', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, catalog }),
  }));

  let profileRequests = 0;
  await page.route('**/api/user/profile', async route => {
    profileRequests += 1;
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        user: { full_name: 'Fast Creator', email: 'fast.creator@example.com' },
        plan: 'pro',
        credits: 600,
        daily_used: 0,
      }),
    });
  });
  await page.route(/^https:\/\//, route => route.abort());

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#loginNavBtn').click();
  await expect(page.locator('#loginModal')).toHaveClass(/open/);

  await page.evaluate(() => {
    window.__e2eAuthCallback('SIGNED_IN', window.__e2eSignedInSession);
    window.__e2eAuthCallback('TOKEN_REFRESHED', window.__e2eSignedInSession);
  });

  await expect(page.locator('#loginModal')).not.toHaveClass(/open/, { timeout: 500 });
  await expect(page.locator('#accountMenuTrigger')).toBeVisible({ timeout: 500 });
  await expect(page.locator('#userName')).toHaveText('Fast Creator', { timeout: 500 });
  await expect(page.locator('#planBadge')).toHaveText('Loading…', { timeout: 500 });
  expect(profileRequests).toBe(1);

  await expect(page.locator('#planBadge')).toHaveText('Pro', { timeout: 3000 });
  expect(profileRequests).toBe(1);
});
