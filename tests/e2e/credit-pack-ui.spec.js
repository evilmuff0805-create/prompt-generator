'use strict';

const { test, expect } = require('@playwright/test');

const LOCALES = ['en', 'ko', 'ja', 'zh-CN', 'fr', 'ru'];
const MESSAGES = Object.fromEntries(LOCALES.map(locale => [
  locale,
  require(`../../public/i18n/locales/${locale}`)
]));
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 768, height: 900 },
  { width: 1024, height: 900 },
  { width: 1440, height: 900 }
];
const PAID_SESSION = {
  access_token: 'credit-pack-e2e-token',
  user: {
    id: 'credit-pack-e2e-user',
    email: 'creator@example.com',
    user_metadata: { full_name: 'Credit Pack Creator' }
  }
};
const SECOND_PAID_SESSION = {
  access_token: 'credit-pack-e2e-token-second',
  user: {
    id: 'credit-pack-e2e-user-second',
    email: 'second-creator@example.com',
    user_metadata: { full_name: 'Second Credit Pack Creator' }
  }
};
const PURCHASE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_PURCHASE_REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const CHECKOUT_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const CATALOG = {
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
    free: {
      id: 'free',
      name: 'Free',
      monthlyPriceUsd: 0,
      credits: 0,
      storyboards: null,
      imageAnalyses: null
    },
    pro: {
      id: 'pro',
      name: 'Pro',
      monthlyPriceUsd: 10.99,
      credits: 600,
      storyboards: 20,
      imageAnalyses: 300
    },
    enterprise: {
      id: 'enterprise',
      name: 'Enterprise',
      monthlyPriceUsd: 19.99,
      credits: 1500,
      storyboards: 50,
      imageAnalyses: 750
    }
  },
  paddle: {
    clientToken: 'credit-pack-e2e-client-token'
  },
  creditPacks: {
    enabled: true,
    eligibility: 'active_paid_subscription',
    expiryDays: 365,
    packs: [
      { key: 'usage_600', credits: 600, priceUsd: 10, currencyCode: 'USD' },
      { key: 'usage_1500', credits: 1500, priceUsd: 20, currencyCode: 'USD' },
      { key: 'usage_3000', credits: 3000, priceUsd: 40, currencyCode: 'USD' }
    ]
  }
};

function makePreview(pack, {
  discount = '0',
  tax = '80',
  grandTotal = '1080'
} = {}) {
  const subtotal = String(Math.round(pack.priceUsd * 100));
  return {
    currencyCode: 'USD',
    subtotal,
    discount,
    tax,
    total: grandTotal,
    credit: '0',
    balance: grandTotal,
    grandTotal,
    grandTotalTax: tax
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise(next => {
    resolve = next;
  });
  return { promise, resolve };
}

async function installPaymentFixture(page, {
  session = null,
  plan = 'free',
  credits = 0,
  purchaseMode = 'submitted',
  initialPurchaseStatus = 'submitted',
  storedRequestId = null
} = {}) {
  const state = {
    credits,
    previewRequests: [],
    purchaseRequests: [],
    pendingRecoveryRequests: 0,
    pendingRecoveryAuthorizations: [],
    pendingPurchase: null,
    statusRequests: 0,
    subscriptionRequests: [],
    purchaseStatus: initialPurchaseStatus
  };

  await page.addInitScript(({ fakeSession, pendingRequestId }) => {
    if (fakeSession && pendingRequestId) {
      window.sessionStorage.setItem(
        `promptgen:credit-pack-purchase:${fakeSession.user.id}`,
        pendingRequestId
      );
    }
    let authStateCallback = null;
    let currentSession = fakeSession;
    window.__emitAuthStateChange = (event, nextSession = fakeSession) => {
      currentSession = nextSession;
      authStateCallback?.(event, nextSession);
    };
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: currentSession } }),
          onAuthStateChange: callback => {
            authStateCallback = callback;
            queueMicrotask(() => callback('INITIAL_SESSION', fakeSession));
            return { data: { subscription: { unsubscribe() {} } } };
          },
          signInWithOAuth: async () => ({ error: null }),
          signInWithIdToken: async () => ({ error: null }),
          signOut: async () => ({ error: null })
        }
      })
    };
    window.__paddleCheckoutCalls = [];
    window.__paddleInitializeCount = 0;
    window.Paddle = {
      Initialize: options => {
        window.__paddleInitializeCount += 1;
        window.__paddleCallback = options.eventCallback;
      },
      Checkout: {
        open: options => {
          window.__paddleCheckoutCalls.push(options);
        }
      }
    };
  }, {
    fakeSession: session,
    pendingRequestId: storedRequestId
  });

  await page.route('**/api/catalog', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, catalog: CATALOG })
  }));
  await page.route('**/api/user/profile', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      user: {
        full_name: 'Credit Pack Creator',
        email: session?.user?.email || 'anonymous@example.com'
      },
      plan,
      credits: state.credits,
      daily_used: 0
    })
  }));
  await page.route(/\/api\/payment\/checkout(?:\?.*)?$/, async route => {
    state.subscriptionRequests.push({
      body: route.request().postDataJSON(),
      authorization: route.request().headers().authorization
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        transactionId: 'txn_subscription_e2e',
        checkoutAttemptId: CHECKOUT_ATTEMPT_ID
      })
    });
  });
  await page.route(/\/api\/payment\/credit-packs\/preview(?:\?.*)?$/, async route => {
    const body = route.request().postDataJSON();
    state.previewRequests.push({
      body,
      authorization: route.request().headers().authorization
    });
    const pack = CATALOG.creditPacks.packs.find(candidate => candidate.key === body.packKey);
    await route.fulfill({
      status: pack ? 200 : 400,
      contentType: 'application/json',
      body: JSON.stringify(pack
        ? {
            success: true,
            pack,
            expiryDays: 365,
            preview: makePreview(pack)
          }
        : {
            success: false,
            code: 'INVALID_CREDIT_PACK'
          })
    });
  });
  await page.route(/\/api\/payment\/credit-packs\/purchase(?:\?.*)?$/, async route => {
    const body = route.request().postDataJSON();
    state.purchaseRequests.push({
      body,
      authorization: route.request().headers().authorization
    });
    const pack = CATALOG.creditPacks.packs.find(candidate => candidate.key === body.packKey);

    if (purchaseMode === 'total_changed' && state.purchaseRequests.length === 1) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          code: 'CREDIT_PACK_TOTAL_CHANGED',
          pack,
          expiryDays: 365,
          preview: makePreview(pack, { tax: '120', grandTotal: '1120' })
        })
      });
      return;
    }

    const providerUnknown = purchaseMode === 'provider_unknown';
    state.purchaseStatus = providerUnknown ? 'provider_unknown' : state.purchaseStatus;
    state.pendingPurchase = {
      purchaseRequestId: PURCHASE_REQUEST_ID,
      status: providerUnknown ? 'provider_unknown' : 'submitted',
      pack,
      createdAt: '2026-07-29T00:00:00.000Z',
      completedAt: null
    };
    if (purchaseMode === 'lost_response') {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        purchaseRequestId: PURCHASE_REQUEST_ID,
        status: providerUnknown ? 'provider_unknown' : 'submitted',
        code: providerUnknown ? 'PURCHASE_CONFIRMATION_PENDING' : undefined,
        pack
      })
    });
  });
  await page.route(/\/api\/payment\/credit-packs\/purchase\/pending(?:\?.*)?$/, async route => {
    state.pendingRecoveryRequests += 1;
    state.pendingRecoveryAuthorizations.push(
      route.request().headers().authorization
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        purchase: state.pendingPurchase
      })
    });
  });
  await page.route(/\/api\/payment\/credit-packs\/purchase\/(?!pending(?:[/?]|$))[^/?]+(?:\?.*)?$/, async route => {
    state.statusRequests += 1;
    const pack = CATALOG.creditPacks.packs[0];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        purchaseRequestId: PURCHASE_REQUEST_ID,
        status: state.purchaseStatus,
        pack,
        createdAt: '2026-07-29T00:00:00.000Z',
        completedAt: state.purchaseStatus === 'completed'
          ? '2026-07-29T00:00:01.000Z'
          : null
      })
    });
  });
  await page.route(/^https:\/\//, route => route.abort());

  return state;
}

test('usage add-ons expose the reviewed catalog and fail closed for anonymous users', async ({ page }) => {
  await installPaymentFixture(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const panel = page.locator('#creditPackPanel');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();

  const packs = panel.locator('.credit-pack');
  await expect(packs).toHaveCount(3);
  await expect(packs.nth(0)).toContainText('600 credits');
  await expect(packs.nth(0)).toContainText('$10');
  await expect(packs.nth(1)).toContainText('1,500 credits');
  await expect(packs.nth(1)).toContainText('$20');
  await expect(packs.nth(2)).toContainText('3,000 credits');
  await expect(packs.nth(2)).toContainText('$40');

  const buttons = panel.locator('[data-credit-pack-key]');
  await expect(buttons).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(buttons.nth(index)).toBeDisabled();
    await expect(buttons.nth(index)).toHaveText('Paid plan required');
    await expect(buttons.nth(index)).toHaveAttribute('aria-label', /Paid plan required: .+ for .+/);
  }
  await expect(panel.locator('#creditPackNote')).toContainText('365 days');
  await expect(panel.locator('#creditPackNote')).toContainText('stay locked until you resubscribe');
});

test('subscription checkout sends only the plan to the server and opens only its bound transaction', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'free'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Free');
  await page.locator('#proPlanBtn').click();
  await expect.poll(() => fixture.subscriptionRequests).toEqual([{
    body: { plan: 'pro' },
    authorization: `Bearer ${PAID_SESSION.access_token}`
  }]);
  await expect.poll(() => page.evaluate(() => window.__paddleCheckoutCalls)).toEqual([
    { transactionId: 'txn_subscription_e2e' }
  ]);
  await expect(page.locator('#proPlanBtn')).toBeDisabled();

  await page.evaluate(() => window.__paddleCallback({ name: 'checkout.closed' }));
  await expect(page.locator('#proPlanBtn')).toHaveText('Resume checkout');
  await page.locator('#proPlanBtn').click();
  await expect.poll(() => page.evaluate(() => window.__paddleCheckoutCalls.length)).toBe(2);
  expect(fixture.subscriptionRequests).toHaveLength(1);
  const opened = await page.evaluate(() => window.__paddleCheckoutCalls);
  expect(opened).toEqual([
    { transactionId: 'txn_subscription_e2e' },
    { transactionId: 'txn_subscription_e2e' }
  ]);
});

test('paid users explicitly confirm the tax-inclusive total and complete only from server status', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    credits: 80
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');
  const buyButton = page.locator('[data-credit-pack-key="usage_600"]');
  await buyButton.click();

  await expect.poll(() => fixture.previewRequests).toEqual([{
    body: { packKey: 'usage_600' },
    authorization: `Bearer ${PAID_SESSION.access_token}`
  }]);
  const modal = page.locator('#creditPackConfirmModal');
  await expect(modal).toHaveClass(/open/);
  await expect(page.locator('#creditPackModalClose')).toBeFocused();
  await expect(page.locator('#creditPackModalCredits')).toHaveText('600 credits');
  await expect(page.locator('#creditPackModalSubtotal')).toHaveText('$10.00');
  await expect(page.locator('#creditPackModalDiscount')).toHaveText('$0.00');
  await expect(page.locator('#creditPackModalTax')).toHaveText('$0.80');
  await expect(page.locator('#creditPackModalTotal')).toHaveText('$10.80');
  await expect(page.locator('#creditPackModalTerms')).toContainText('billed immediately');
  await expect(page.locator('#creditPackModalTerms')).toContainText('expire 365 days');
  await expect(page.locator('#creditPackModalTerms')).toContainText('active Pro or Enterprise');
  await expect(page.locator('#creditPackModalTerms')).toContainText('no cash value');

  await page.locator('#creditPackModalConfirm').click();
  await expect.poll(() => fixture.purchaseRequests).toEqual([{
    body: {
      packKey: 'usage_600',
      confirmedGrandTotal: '1080',
      confirmedCurrencyCode: 'USD'
    },
    authorization: `Bearer ${PAID_SESSION.access_token}`
  }]);
  await expect.poll(() => page.evaluate(userId => (
    window.sessionStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute('data-state', 'pending');
  expect(await page.evaluate(() => window.__paddleInitializeCount)).toBe(0);
  expect(await page.evaluate(() => window.__paddleCheckoutCalls)).toEqual([]);

  fixture.credits = 680;
  await expect.poll(() => fixture.statusRequests, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute('data-state', 'pending');
  await expect(page.locator('#creditPackStatus')).not.toHaveAttribute('data-state', 'success');

  fixture.purchaseStatus = 'completed';
  await expect(page.locator('#creditPackStatus')).toHaveAttribute('data-state', 'success', {
    timeout: 5000
  });
  await expect(page.locator('#creditPackStatus')).toContainText('Credits confirmed');
  await expect.poll(() => page.evaluate(userId => (
    window.sessionStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();
});

test('a changed tax-inclusive total updates the modal and requires a second confirmation', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    purchaseMode: 'total_changed'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');

  await page.locator('[data-credit-pack-key="usage_600"]').click();
  await page.locator('#creditPackModalConfirm').click();
  await expect(page.locator('#creditPackConfirmModal')).toHaveClass(/open/);
  await expect(page.locator('#creditPackModalError')).toContainText('total changed');
  await expect(page.locator('#creditPackModalTotal')).toHaveText('$11.20');
  await expect(page.locator('#creditPackModalConfirm')).toContainText('$11.20');
  expect(fixture.purchaseRequests[0].body.confirmedGrandTotal).toBe('1080');

  await page.locator('#creditPackModalConfirm').click();
  await expect.poll(() => fixture.purchaseRequests.length).toBe(2);
  expect(fixture.purchaseRequests[1].body).toEqual({
    packKey: 'usage_600',
    confirmedGrandTotal: '1120',
    confirmedCurrencyCode: 'USD'
  });
  await expect(page.locator('#creditPackConfirmModal')).not.toHaveClass(/open/);
});

test('pending purchases resume from user-scoped session storage after reload', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'completed'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(0);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute('data-state', 'success');
  expect(fixture.purchaseRequests).toEqual([]);
  await expect.poll(() => page.evaluate(userId => (
    window.sessionStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();
  expect(fixture.pendingRecoveryRequests).toBe(0);
});

test('a lost purchase response is recovered after reload without submitting again', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    purchaseMode: 'lost_response'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');
  await expect.poll(() => fixture.pendingRecoveryRequests).toBe(1);

  await page.locator('[data-credit-pack-key="usage_600"]').click();
  await page.locator('#creditPackModalConfirm').click();
  await expect.poll(() => fixture.purchaseRequests.length).toBe(1);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'pending'
  );
  await expect(page.locator('#creditPackStatus')).toContainText(
    'Do not retry in this page'
  );
  await expect.poll(() => page.evaluate(userId => (
    window.sessionStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();

  fixture.purchaseStatus = 'completed';
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect.poll(() => fixture.pendingRecoveryRequests).toBe(2);
  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(0);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'success'
  );
  await expect(page.locator('#creditPackStatus')).toContainText(
    'Credits confirmed'
  );
  expect(fixture.purchaseRequests).toHaveLength(1);
  expect(fixture.pendingRecoveryAuthorizations).toEqual([
    `Bearer ${PAID_SESSION.access_token}`,
    `Bearer ${PAID_SESSION.access_token}`
  ]);
  await expect.poll(() => page.evaluate(userId => (
    window.sessionStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();

  await page.evaluate(() => {
    window.__emitAuthStateChange('TOKEN_REFRESHED');
    window.__emitAuthStateChange('SIGNED_IN');
  });
  await page.waitForTimeout(100);
  expect(fixture.pendingRecoveryRequests).toBe(2);
  expect(fixture.purchaseRequests).toHaveLength(1);
});

test('a delayed preview from the previous account cannot reopen confirmation', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro'
  });
  const previewStarted = createDeferred();
  const previewResponded = createDeferred();
  await page.route(/\/api\/payment\/credit-packs\/preview(?:\?.*)?$/, async route => {
    const body = route.request().postDataJSON();
    const pack = CATALOG.creditPacks.packs.find(
      candidate => candidate.key === body.packKey
    );
    previewStarted.resolve();
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        pack,
        expiryDays: 365,
        preview: makePreview(pack)
      })
    });
    previewResponded.resolve();
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');
  await page.locator('[data-credit-pack-key="usage_600"]').click();
  await previewStarted.promise;

  await page.evaluate(nextSession => {
    window.__emitAuthStateChange('SIGNED_IN', nextSession);
  }, SECOND_PAID_SESSION);
  await previewResponded.promise;

  await expect(page.locator('#creditPackConfirmModal')).not.toHaveClass(/open/);
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');
  await expect(
    page.locator('[data-credit-pack-key="usage_600"]')
  ).toBeEnabled();
  expect(fixture.purchaseRequests).toEqual([]);
});

test('a delayed purchase response is stored only for its original account', async ({ page }) => {
  await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro'
  });
  const purchaseStarted = createDeferred();
  const purchaseResponded = createDeferred();
  let purchasePosts = 0;
  await page.route(/\/api\/payment\/credit-packs\/purchase(?:\?.*)?$/, async route => {
    purchasePosts += 1;
    purchaseStarted.resolve();
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        purchaseRequestId: PURCHASE_REQUEST_ID,
        status: 'submitted',
        pack: CATALOG.creditPacks.packs[0]
      })
    });
    purchaseResponded.resolve();
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');
  await page.locator('[data-credit-pack-key="usage_600"]').click();
  await page.locator('#creditPackModalConfirm').click();
  await purchaseStarted.promise;

  await page.evaluate(nextSession => {
    window.__emitAuthStateChange('SIGNED_IN', nextSession);
  }, SECOND_PAID_SESSION);
  await purchaseResponded.promise;

  await expect.poll(() => page.evaluate(userId => (
    window.sessionStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
  await expect.poll(() => page.evaluate(userId => (
    window.sessionStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), SECOND_PAID_SESSION.user.id)).toBeNull();
  await expect(page.locator('#creditPackConfirmModal')).not.toHaveClass(/open/);
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');
  await expect(
    page.locator('[data-credit-pack-key="usage_600"]')
  ).toBeEnabled();
  await expect(page.locator('#creditPackStatus')).not.toHaveAttribute(
    'data-state',
    'pending'
  );
  expect(purchasePosts).toBe(1);
});

test('a delayed status response cannot reset the next account purchase state', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    storedRequestId: PURCHASE_REQUEST_ID
  });
  const oldStatusStarted = createDeferred();
  const oldStatusResponded = createDeferred();
  let statusRequestCount = 0;
  await page.route(
    /\/api\/payment\/credit-packs\/purchase\/(?!pending(?:[/?]|$))[^/?]+(?:\?.*)?$/,
    async route => {
      statusRequestCount += 1;
      const requestId = new URL(route.request().url()).pathname.split('/').pop();
      if (requestId === PURCHASE_REQUEST_ID && statusRequestCount === 1) {
        oldStatusStarted.resolve();
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            purchaseRequestId: requestId,
            status: 'completed',
            pack: CATALOG.creditPacks.packs[0],
            createdAt: '2026-07-29T00:00:00.000Z',
            completedAt: '2026-07-29T00:00:01.000Z'
          })
        });
        oldStatusResponded.resolve();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          purchaseRequestId: requestId,
          status: 'submitted',
          pack: CATALOG.creditPacks.packs[0],
          createdAt: '2026-07-29T00:00:00.000Z',
          completedAt: null
        })
      });
    }
  );

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await oldStatusStarted.promise;
  fixture.pendingPurchase = {
    purchaseRequestId: SECOND_PURCHASE_REQUEST_ID,
    status: 'submitted',
    pack: CATALOG.creditPacks.packs[0],
    createdAt: '2026-07-29T00:00:02.000Z',
    completedAt: null
  };
  await page.evaluate(nextSession => {
    window.__emitAuthStateChange('SIGNED_IN', nextSession);
  }, SECOND_PAID_SESSION);

  await expect.poll(() => page.evaluate(userId => (
    window.sessionStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), SECOND_PAID_SESSION.user.id)).toBe(SECOND_PURCHASE_REQUEST_ID);
  await oldStatusResponded.promise;

  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'pending'
  );
  await expect(page.locator('#creditPackStatus')).not.toContainText(
    'Credits confirmed'
  );
  await expect.poll(() => page.evaluate(userId => (
    window.sessionStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), SECOND_PAID_SESSION.user.id)).toBe(SECOND_PURCHASE_REQUEST_ID);
  await expect.poll(() => page.evaluate(userId => (
    window.sessionStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
  const buttons = page.locator('#creditPackPanel [data-credit-pack-key]');
  for (let index = 0; index < 3; index += 1) {
    await expect(buttons.nth(index)).toBeDisabled();
  }
});

test('a transient pending lookup failure retries on reconnect without reposting', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro'
  });
  let pendingRequests = 0;
  await page.route(
    /\/api\/payment\/credit-packs\/purchase\/pending(?:\?.*)?$/,
    async route => {
      pendingRequests += 1;
      await route.fulfill({
        status: pendingRequests === 1 ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          pendingRequests === 1
            ? {
                success: false,
                code: 'PURCHASE_STATUS_UNAVAILABLE'
              }
            : {
                success: true,
                purchase: null
              }
        )
      });
    }
  );

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => pendingRequests).toBe(1);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'pending'
  );
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');
  await expect(
    page.locator('[data-credit-pack-key="usage_600"]')
  ).toBeDisabled();

  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect.poll(() => pendingRequests).toBe(2);
  await expect(
    page.locator('[data-credit-pack-key="usage_600"]')
  ).toBeEnabled();
  await expect(page.locator('#creditPackStatus')).not.toHaveAttribute(
    'data-state',
    'pending'
  );
  expect(fixture.purchaseRequests).toEqual([]);
});

test('provider-unknown purchases remain pending and cannot be submitted twice', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    purchaseMode: 'provider_unknown'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');

  await page.locator('[data-credit-pack-key="usage_600"]').click();
  await page.locator('#creditPackModalConfirm').click();
  await expect(page.locator('#creditPackStatus')).toContainText('still being reconciled');
  const buttons = page.locator('#creditPackPanel [data-credit-pack-key]');
  for (let index = 0; index < 3; index += 1) {
    await expect(buttons.nth(index)).toBeDisabled();
  }
  expect(fixture.purchaseRequests).toHaveLength(1);
});

test('confirmation modal traps focus, closes on Escape, and restores the purchase button', async ({ page }) => {
  await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');

  const buyButton = page.locator('[data-credit-pack-key="usage_600"]');
  await buyButton.click();
  await expect(page.locator('#creditPackModalClose')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#creditPackModalConfirm')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#creditPackConfirmModal')).not.toHaveClass(/open/);
  await expect(buyButton).toBeFocused();
});

test('all six locales disclose expiry and post-cancellation usage locking', async ({ page }) => {
  await installPaymentFixture(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  for (const locale of LOCALES) {
    await page.locator('[data-locale-select]').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    const expectedNote = MESSAGES[locale]['pricing.addons.note'].replace('{days}', '365');
    await expect(page.locator('#creditPackNote')).toHaveText(expectedNote);
  }
});

for (const viewport of VIEWPORTS) {
  test(`usage add-ons and confirmation modal do not overflow at ${viewport.width}px`, async ({ page }) => {
    await installPaymentFixture(page, {
      session: PAID_SESSION,
      plan: 'pro'
    });
    await page.setViewportSize(viewport);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');

    const panel = page.locator('#creditPackPanel');
    await panel.scrollIntoViewIfNeeded();
    await page.locator('[data-credit-pack-key="usage_600"]').click();
    await expect(page.locator('#creditPackConfirmModal')).toHaveClass(/open/);

    const layout = await page.evaluate(() => {
      const panelElement = document.getElementById('creditPackPanel');
      const panelRect = panelElement.getBoundingClientRect();
      const dialog = document.querySelector('.credit-pack-confirm');
      const dialogRect = dialog.getBoundingClientRect();
      return {
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelWithinViewport:
          panelRect.left >= -1 && panelRect.right <= window.innerWidth + 1,
        dialogWithinViewport:
          dialogRect.left >= -1
          && dialogRect.right <= window.innerWidth + 1
          && dialogRect.top >= -1
          && dialogRect.bottom <= window.innerHeight + 1,
        clippedItems: [...document.querySelectorAll('.credit-pack')].filter(item => (
          item.scrollWidth > item.clientWidth + 1
          || item.scrollHeight > item.clientHeight + 1
        )).length
      };
    });

    expect(layout.documentOverflow).toBeLessThanOrEqual(2);
    expect(layout.panelWithinViewport).toBe(true);
    expect(layout.dialogWithinViewport).toBe(true);
    expect(layout.clippedItems).toBe(0);
  });
}
