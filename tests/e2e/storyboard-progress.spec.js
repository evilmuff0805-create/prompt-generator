const { test, expect } = require('@playwright/test');

const session = {
  access_token: 'storyboard-progress-token',
  user: { id: 'storyboard-progress-user', email: 'creator@example.com' }
};

const catalog = {
  analysisCreditCost: 2,
  storyboardCreditCost: 30,
  storyboardCreditPolicy: {
    baseCost: 30,
    perReferenceCost: 5,
    maxReferences: 4,
    minCost: 30,
    maxCost: 50
  },
  plans: {
    free: { id: 'free', name: 'Free', monthlyPriceUsd: 0, credits: 0 },
    pro: { id: 'pro', name: 'Pro', monthlyPriceUsd: 9.99, credits: 600 },
    enterprise: { id: 'enterprise', name: 'Enterprise', monthlyPriceUsd: 19.99, credits: 1500 }
  },
  paddle: { clientToken: 'test-client-token' }
};

async function installAuthenticatedBrowser(page) {
  await page.addInitScript(({ fakeSession }) => {
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: fakeSession } }),
          onAuthStateChange: callback => {
            queueMicrotask(() => callback('INITIAL_SESSION', fakeSession));
            return { data: { subscription: { unsubscribe() {} } } };
          },
          signInWithIdToken: async () => ({ error: null }),
          signOut: async () => ({ error: null })
        }
      })
    };
  }, { fakeSession: session });

  await page.route('**/api/catalog', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, catalog })
  }));
  await page.route('**/api/storyboard/config', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      storyboardCost: 30,
      storyboardCreditPolicy: catalog.storyboardCreditPolicy,
      catalog
    })
  }));
  await page.route('**/api/user/profile', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      user: { id: session.user.id, full_name: 'Creator', email: session.user.email },
      plan: 'pro',
      credits: 600,
      daily_used: 0
    })
  }));
}

test('active Storyboard stays visible across Image to Prompt and Endframe', async ({ page }) => {
  await installAuthenticatedBrowser(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.route('**/api/storyboard/active', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      items: [{
        id: 'sb_active',
        status: 'processing',
        progress: 0.45,
        currentStep: 'generating_grid',
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:05.000Z'
      }]
    })
  }));
  await page.route('**/api/storyboard/sb_active/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: 'sb_active', status: 'processing', progress: 0.45 })
  }));
  await page.route(/^https:\/\//, route => route.abort());

  await page.goto('/image-to-prompt', { waitUntil: 'domcontentloaded' });
  const progress = page.locator('#storyboardGlobalProgress');
  await expect(progress).toBeVisible();
  await expect(progress).toContainText('Storyboard generating');

  await page.locator('.tool-tab[href="/frame"]').click();
  await expect(page).toHaveURL(/\/frame$/);
  await expect(page.locator('#storyboardGlobalProgress')).toBeVisible();

  await page.locator('[data-locale-select]').selectOption('ru');
  await expect(page.locator('#storyboardGlobalProgress')).toContainText('Создаётся раскадровка');
  const bounds = await page.locator('#storyboardGlobalProgress').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
});

test('tool navigation is blocked only until the durable enqueue is acknowledged', async ({ page }) => {
  await installAuthenticatedBrowser(page);
  let accepted = false;
  let releaseGenerate;

  await page.route('**/api/storyboard/active', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      items: accepted ? [{
        id: 'sb_navigation',
        status: 'processing',
        progress: 0.2,
        currentStep: 'analyzing_scenario',
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:01.000Z'
      }] : []
    })
  }));
  await page.route('**/api/storyboard/generate', async route => {
    await new Promise(resolve => { releaseGenerate = resolve; });
    accepted = true;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        storyboard: { id: 'sb_navigation', status: 'pending', remainingCredits: 570 }
      })
    });
  });
  await page.route('**/api/storyboard/sb_navigation/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'sb_navigation',
      status: 'processing',
      progress: 0.2,
      currentStep: 'analyzing_scenario'
    })
  }));
  await page.route(/^https:\/\//, route => route.abort());

  await page.goto('/storyboard', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#mainForm')).toBeVisible();
  await page.locator('#scenario').fill(
    'A filmmaker follows a quiet traveler through a rain-soaked city as the night slowly reveals a hidden connection.'
  );
  await page.locator('.storyboard-genre-btn').first().click();
  await expect(page.locator('#generateBtn')).toBeEnabled();
  await page.locator('#generateBtn').click();

  await expect(page.locator('#storyboardGlobalProgress')).toContainText('Starting Storyboard');
  await page.locator('.tool-tab[href="/image-to-prompt"]').click();
  await expect(page).toHaveURL(/\/storyboard$/);

  await expect.poll(() => typeof releaseGenerate).toBe('function');
  releaseGenerate();
  await expect(page).toHaveURL(/\/storyboard\/sb_navigation$/);

  await page.locator('.tool-tab[href="/image-to-prompt"]').click();
  await expect(page).toHaveURL(/\/image-to-prompt$/);
  await expect(page.locator('#storyboardGlobalProgress')).toContainText('Storyboard generating');
});
