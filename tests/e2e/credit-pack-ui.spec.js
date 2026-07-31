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
const OPEN_PURCHASE_STATUSES = new Set([
  'previewing',
  'created',
  'charging',
  'submitted',
  'provider_unknown',
  'withheld'
]);
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
  storedRequestId = null,
  creditPackPurchasesEnabled = true,
  statusNotFoundCount = 0,
  storageWriteFails = false,
  purchaseReviewRequired = false,
  previewMode = 'success',
  previewDelayMs = 0,
  cancelMode = 'success',
  cancelDelayMs = 0,
  sharedState = null
} = {}) {
  const publicCatalog = {
    ...CATALOG,
    creditPacks: {
      ...CATALOG.creditPacks,
      enabled: creditPackPurchasesEnabled,
      packs: creditPackPurchasesEnabled ? CATALOG.creditPacks.packs : []
    }
  };
  const state = sharedState || {
    credits,
    previewRequests: [],
    previewReservations: 0,
    purchaseRequests: [],
    purchaseHandlerEntries: 0,
    providerChargeAttempts: 0,
    cancelRequests: [],
    pendingRecoveryRequests: 0,
    pendingRecoveryAuthorizations: [],
    pendingPurchase: null,
    openPurchase: null,
    statusRequests: 0,
    statusRequestIds: [],
    unhandledApiRequests: [],
    subscriptionRequests: [],
    purchaseStatus: initialPurchaseStatus,
    statusNotFoundRemaining: statusNotFoundCount,
    purchaseReviewRequired
  };
  if (!sharedState && storedRequestId) {
    const pack = CATALOG.creditPacks.packs[0];
    state.openPurchase = {
      purchaseRequestId: storedRequestId,
      status: initialPurchaseStatus,
      pack,
      expiryDays: 365,
      confirmationVersion: 1,
      preview: makePreview(pack),
      createdAt: '2026-07-29T00:00:00.000Z',
      completedAt: [
        'completed',
        'withheld',
        'refunded',
        'failed',
        'chargeback'
      ].includes(initialPurchaseStatus)
        ? '2026-07-29T00:00:01.000Z'
        : null
    };
    state.pendingPurchase = state.openPurchase;
  }

  await page.addInitScript(({
    fakeSession,
    pendingRequestId,
    shouldFailRecoveryStorage
  }) => {
    if (shouldFailRecoveryStorage) {
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (
          this === window.localStorage
          && String(key).startsWith('promptgen:credit-pack-purchase:')
        ) {
          throw new DOMException(
            'Credit pack recovery storage is unavailable.',
            'QuotaExceededError'
          );
        }
        return originalSetItem.call(this, key, value);
      };
    }
    if (fakeSession && pendingRequestId) {
      window.localStorage.setItem(
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
    const supabaseDouble = {
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
    Object.defineProperty(window, 'supabase', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: supabaseDouble
    });
    window.__paddleCheckoutCalls = [];
    window.__paddleInitializeCount = 0;
    const paddleDouble = {
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
    Object.defineProperty(window, 'Paddle', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: paddleDouble
    });
  }, {
    fakeSession: session,
    pendingRequestId: storedRequestId,
    shouldFailRecoveryStorage: storageWriteFails
  });

  // Register the fail-closed API fallback first. Playwright evaluates newer,
  // more specific routes before older routes, so the handlers below still win
  // while any forgotten local API call is kept away from the dummy services.
  await page.route(/\/api\//, async route => {
    state.unhandledApiRequests.push({
      method: route.request().method(),
      pathname: new URL(route.request().url()).pathname
    });
    await route.fulfill({
      status: 501,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, code: 'UNHANDLED_E2E_API' })
    });
  });

  // Keep the deterministic SDK doubles installed above. Otherwise the remote
  // UMD scripts can overwrite them after addInitScript, which makes multi-page
  // tests depend on CDN timing and may leak requests to a local Supabase URL.
  await page.route('https://cdn.jsdelivr.net/**/supabase.js', route => (
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: ''
    })
  ));
  await page.route('https://cdn.paddle.com/**/paddle.js', route => (
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: ''
    })
  ));
  await page.route('**/api/catalog', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, catalog: publicCatalog })
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
  await page.route('**/api/analytics/events', route => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: JSON.stringify({ accepted: true, duplicate: false })
  }));
  await page.route('**/api/storyboard/active', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, items: [] })
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
    const requestRecord = {
      body,
      authorization: route.request().headers().authorization
    };
    state.previewRequests.push(requestRecord);
    const pack = CATALOG.creditPacks.packs.find(candidate => candidate.key === body.packKey);

    if (
      pack
      && state.openPurchase
      && OPEN_PURCHASE_STATUSES.has(state.openPurchase.status)
    ) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          code: 'PURCHASE_ALREADY_PENDING',
          purchaseRequestId: state.openPurchase.purchaseRequestId,
          status: state.openPurchase.status,
          pack: state.openPurchase.pack
        })
      });
      return;
    }

    if (pack) {
      state.previewReservations += 1;
      state.purchaseStatus = 'previewing';
      state.openPurchase = {
        purchaseRequestId: PURCHASE_REQUEST_ID,
        status: 'previewing',
        pack,
        expiryDays: 365,
        confirmationVersion: 1,
        preview: makePreview(pack),
        createdAt: '2026-07-29T00:00:00.000Z',
        completedAt: null
      };
      state.pendingPurchase = state.openPurchase;
    }
    if (previewDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, previewDelayMs));
    }
    if (pack) {
      state.purchaseStatus = 'created';
      state.openPurchase.status = 'created';
    }
    if (pack && previewMode === 'lost_response') {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: pack ? 200 : 400,
      contentType: 'application/json',
      body: JSON.stringify(pack
        ? {
            success: true,
            purchaseRequestId: PURCHASE_REQUEST_ID,
            status: 'created',
            confirmationVersion: 1,
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

    if (
      purchaseMode === 'api_rate_limited'
      || purchaseMode === 'auth_invalid'
    ) {
      const rateLimited = purchaseMode === 'api_rate_limited';
      await route.fulfill({
        status: rateLimited ? 429 : 401,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: rateLimited
            ? 'Too many requests, please try again later.'
            : 'Invalid or expired token',
          code: rateLimited ? 'API_RATE_LIMITED' : 'AUTH_INVALID',
          requestProcessed: false
        })
      });
      return;
    }
    state.purchaseHandlerEntries += 1;

    if (purchaseMode === 'total_changed' && state.purchaseRequests.length === 1) {
      state.purchaseStatus = 'created';
      if (state.openPurchase) {
        state.openPurchase.status = 'created';
        state.openPurchase.confirmationVersion = 2;
        state.openPurchase.preview = makePreview(pack, {
          tax: '120',
          grandTotal: '1120'
        });
      }
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          code: 'CREDIT_PACK_TOTAL_CHANGED',
          purchaseRequestId: body.purchaseRequestId,
          status: 'created',
          confirmationVersion: 2,
          pack,
          expiryDays: 365,
          preview: makePreview(pack, { tax: '120', grandTotal: '1120' })
        })
      });
      return;
    }

    const canClaim = state.openPurchase
      && state.openPurchase.purchaseRequestId === body.purchaseRequestId
      && state.openPurchase.status === 'created'
      && state.openPurchase.confirmationVersion === body.confirmationVersion;
    if (!canClaim) {
      const pendingStatus = state.openPurchase?.status || state.purchaseStatus;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          code: 'PURCHASE_ALREADY_PENDING',
          purchaseRequestId:
            state.openPurchase?.purchaseRequestId || body.purchaseRequestId,
          status: pendingStatus,
          pack: state.openPurchase?.pack || pack
        })
      });
      return;
    }

    state.openPurchase.status = 'charging';
    state.purchaseStatus = 'charging';
    state.providerChargeAttempts += 1;
    const providerUnknown = purchaseMode === 'provider_unknown';
    const completedBeforeResponse =
      purchaseMode === 'lost_response_fast_completed';
    state.purchaseStatus = providerUnknown
      ? 'provider_unknown'
      : 'submitted';
    if (completedBeforeResponse) {
      state.purchaseStatus = 'completed';
    }
    state.pendingPurchase = {
      ...state.openPurchase,
      purchaseRequestId: body.purchaseRequestId,
      status: providerUnknown
        ? 'provider_unknown'
        : completedBeforeResponse
          ? 'completed'
          : 'submitted',
      pack,
      createdAt: '2026-07-29T00:00:00.000Z',
      completedAt: completedBeforeResponse
        ? '2026-07-29T00:00:01.000Z'
        : null
    };
    state.openPurchase = state.pendingPurchase;
    if (
      purchaseMode === 'lost_response'
      || purchaseMode === 'lost_response_fast_completed'
    ) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        purchaseRequestId: body.purchaseRequestId,
        status: providerUnknown ? 'provider_unknown' : 'submitted',
        code: providerUnknown ? 'PURCHASE_CONFIRMATION_PENDING' : undefined,
        pack
      })
    });
  });
  await page.route(
    /\/api\/payment\/credit-packs\/purchase\/[^/?]+\/cancel(?:\?.*)?$/,
    async route => {
      const requestId = new URL(route.request().url()).pathname
        .split('/')
        .filter(Boolean)
        .at(-2);
      state.cancelRequests.push({
        purchaseRequestId: requestId,
        body: route.request().postDataJSON(),
        authorization: route.request().headers().authorization
      });
      if (cancelDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, cancelDelayMs));
      }
      if (cancelMode === 'lost_response') {
        await route.abort('failed');
        return;
      }
      if (
        state.openPurchase?.purchaseRequestId === requestId
        && ['previewing', 'created'].includes(state.openPurchase.status)
      ) {
        state.purchaseStatus = 'failed';
        state.openPurchase.status = 'failed';
        state.openPurchase.completedAt = '2026-07-29T00:00:01.000Z';
        state.pendingPurchase = state.openPurchase;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            purchaseRequestId: requestId,
            status: 'failed',
            chargeMayHaveRun: false
          })
        });
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          code: 'PURCHASE_ALREADY_PENDING',
          purchaseRequestId: requestId,
          status: state.openPurchase?.status || state.purchaseStatus,
          pack: state.openPurchase?.pack || CATALOG.creditPacks.packs[0]
        })
      });
    }
  );
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
          ? {
              ...state.pendingPurchase,
              status: state.purchaseStatus
            }
          : null
      })
    });
  });
  await page.route(/\/api\/payment\/credit-packs\/purchase\/(?!pending(?:[/?]|$))[^/?]+(?:\?.*)?$/, async route => {
    state.statusRequests += 1;
    if (state.statusNotFoundRemaining > 0) {
      state.statusNotFoundRemaining -= 1;
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          code: 'PURCHASE_REQUEST_NOT_FOUND'
        })
      });
      return;
    }
    const requestId = new URL(route.request().url()).pathname
      .split('/')
      .filter(Boolean)
      .at(-1);
    state.statusRequestIds.push(requestId);
    if (
      state.openPurchase
      && requestId !== state.openPurchase.purchaseRequestId
    ) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          code: 'PURCHASE_REQUEST_NOT_FOUND'
        })
      });
      return;
    }
    const pack = state.openPurchase?.pack || CATALOG.creditPacks.packs[0];
    const purchase = state.openPurchase;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        purchaseRequestId: requestId,
        status: state.purchaseStatus,
        pack,
        expiryDays: purchase?.expiryDays,
        confirmationVersion: purchase?.confirmationVersion,
        preview: purchase?.preview,
        createdAt: '2026-07-29T00:00:00.000Z',
        completedAt: [
          'completed',
          'withheld',
          'refunded',
          'failed',
          'chargeback'
        ].includes(
          state.purchaseStatus
        )
          ? '2026-07-29T00:00:01.000Z'
          : null,
        reviewRequired:
          state.purchaseReviewRequired
          || ['withheld', 'chargeback'].includes(state.purchaseStatus)
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

  await expect.poll(
    async () => page.locator('#planBadge').textContent(),
    { timeout: 15_000 }
  ).toBe('Free');
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
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);

  await page.locator('#creditPackModalConfirm').click();
  await expect.poll(() => fixture.purchaseRequests).toEqual([{
    body: {
      packKey: 'usage_600',
      purchaseRequestId: PURCHASE_REQUEST_ID,
      confirmationVersion: 1,
      confirmedGrandTotal: '1080',
      confirmedCurrencyCode: 'USD'
    },
    authorization: `Bearer ${PAID_SESSION.access_token}`
  }]);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute('data-state', 'pending');
  await expect(page.locator('#creditPackStatus')).toBeFocused();
  expect(fixture.providerChargeAttempts).toBe(1);
  expect(fixture.unhandledApiRequests).toEqual([]);
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
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
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
  expect(fixture.purchaseRequests[0].body.confirmationVersion).toBe(1);
  expect(fixture.purchaseRequests[1].body).toEqual({
    packKey: 'usage_600',
    purchaseRequestId: PURCHASE_REQUEST_ID,
    confirmationVersion: 2,
    confirmedGrandTotal: '1120',
    confirmedCurrencyCode: 'USD'
  });
  expect(fixture.providerChargeAttempts).toBe(1);
  await expect(page.locator('#creditPackConfirmModal')).not.toHaveClass(/open/);
});

test('a recovery storage failure cancels the server reservation before unlocking', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    storageWriteFails: true
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');

  await page.locator('[data-credit-pack-key="usage_600"]').click();

  await expect.poll(() => fixture.cancelRequests.length).toBe(1);
  await expect(page.locator('#creditPackConfirmModal')).not.toHaveClass(/open/);
  await expect(page.locator('#creditPackStatus')).toContainText(
    'could not save the payment recovery key'
  );
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'error'
  );
  expect(fixture.purchaseRequests).toEqual([]);
  expect(fixture.providerChargeAttempts).toBe(0);
  expect(fixture.cancelRequests[0]).toEqual({
    purchaseRequestId: PURCHASE_REQUEST_ID,
    body: { reason: 'client_cancelled' },
    authorization: `Bearer ${PAID_SESSION.access_token}`
  });
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();
  await expect(
    page.locator('[data-credit-pack-key="usage_600"]')
  ).toBeEnabled();
});

test('a lost cancellation response keeps a storage-failed reservation locked', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    storageWriteFails: true,
    cancelMode: 'lost_response'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');

  await page.locator('[data-credit-pack-key="usage_600"]').click();

  await expect.poll(() => fixture.cancelRequests.length).toBe(1);
  await expect(page.locator('#creditPackConfirmModal')).toHaveClass(/open/);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'pending'
  );
  await expect(page.locator('#creditPackModalError')).toContainText(
    'temporarily unavailable'
  );
  await expect(
    page.locator('[data-credit-pack-key="usage_600"]')
  ).toBeDisabled();
  expect(fixture.purchaseRequests).toEqual([]);
  expect(fixture.providerChargeAttempts).toBe(0);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();
});

for (const scenario of [
  {
    mode: 'auth_invalid',
    label: 'expired authentication'
  },
  {
    mode: 'api_rate_limited',
    label: 'the application rate limiter'
  }
]) {
  test(`${scenario.label} keeps the same reserved request available for a safe retry`, async ({ page }) => {
    const fixture = await installPaymentFixture(page, {
      session: PAID_SESSION,
      plan: 'pro',
      purchaseMode: scenario.mode
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');

    const buyButton = page.locator(
      '[data-credit-pack-key="usage_600"]'
    );
    await buyButton.click();
    await page.locator('#creditPackModalConfirm').click();

    await expect.poll(() => fixture.purchaseRequests.length).toBe(1);
    expect(fixture.purchaseHandlerEntries).toBe(0);
    expect(fixture.providerChargeAttempts).toBe(0);
    await expect(page.locator('#creditPackConfirmModal')).toHaveClass(/open/);
    await expect(page.locator('#creditPackStatus')).toHaveAttribute(
      'data-state',
      'error'
    );
    await expect(page.locator('#creditPackStatus')).toContainText(
      'temporarily unavailable'
    );
    await expect.poll(() => page.evaluate(userId => (
      window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
    ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
    await expect(buyButton).toBeDisabled();
    await expect(page.locator('#creditPackModalConfirm')).toBeFocused();
  });
}

test('exact-status 404 CAS-replaces a stale token with the authoritative owner-scoped request across reload', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');

  await page.locator('[data-credit-pack-key="usage_600"]').click();
  await expect(page.locator('#creditPackConfirmModal')).toHaveClass(/open/);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
  await page.evaluate(({ userId, requestId }) => {
    window.localStorage.setItem(
      `promptgen:credit-pack-purchase:${userId}`,
      requestId
    );
  }, {
    userId: PAID_SESSION.user.id,
    requestId: SECOND_PURCHASE_REQUEST_ID
  });
  await page.locator('#creditPackModalConfirm').click();

  expect(fixture.purchaseRequests).toEqual([]);
  await expect.poll(() => fixture.statusRequestIds).toContain(
    SECOND_PURCHASE_REQUEST_ID
  );
  await expect.poll(() => fixture.pendingRecoveryRequests)
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => fixture.statusRequestIds).toContain(
    PURCHASE_REQUEST_ID
  );
  expect(fixture.providerChargeAttempts).toBe(0);
  await expect(page.locator('#creditPackConfirmModal')).toHaveClass(/open/);
  await expect(page.locator('#creditPackModalTotal')).toHaveText('$10.80');
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);

  const statusRequestsBeforeReload = fixture.statusRequestIds.length;
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect.poll(() => fixture.statusRequestIds.length)
    .toBeGreaterThan(statusRequestsBeforeReload);
  expect(
    fixture.statusRequestIds.slice(statusRequestsBeforeReload)
  ).toContain(PURCHASE_REQUEST_ID);
  await expect(page.locator('#creditPackConfirmModal')).toHaveClass(/open/);
  await expect(page.locator('#creditPackModalTotal')).toHaveText('$10.80');
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
  expect(fixture.purchaseRequests).toEqual([]);
  expect(fixture.providerChargeAttempts).toBe(0);
});

test('interleaved tabs share one reservation and one provider money-moving attempt', async ({
  page,
  context
}) => {
  test.setTimeout(120_000);
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'created'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('#creditPackConfirmModal')).toHaveClass(
    /open/,
    { timeout: 30_000 }
  );
  const firstPageStatusRequests = fixture.statusRequestIds.length;
  const secondPage = await context.newPage();
  await installPaymentFixture(secondPage, {
    session: PAID_SESSION,
    plan: 'pro',
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'created',
    sharedState: fixture
  });
  await secondPage.goto('/', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000
  });
  await expect(secondPage.locator('#creditPackConfirmModal')).toHaveClass(
    /open/,
    { timeout: 30_000 }
  );
  await expect.poll(() => fixture.statusRequestIds.length)
    .toBeGreaterThan(firstPageStatusRequests);
  await expect.poll(() => fixture.statusRequestIds.filter(
    requestId => requestId === PURCHASE_REQUEST_ID
  ).length)
    .toBeGreaterThanOrEqual(2);
  expect(fixture.previewRequests).toEqual([]);
  expect(fixture.previewReservations).toBe(0);
  expect(fixture.openPurchase).toMatchObject({
    purchaseRequestId: PURCHASE_REQUEST_ID,
    status: 'created',
    confirmationVersion: 1
  });

  await page.bringToFront();
  const firstPurchaseResponse = page.waitForResponse(response => (
    new URL(response.url()).pathname ===
      '/api/payment/credit-packs/purchase'
    && response.request().method() === 'POST'
  ));
  await page.locator('#creditPackModalConfirm').click({ timeout: 5_000 });
  await secondPage.bringToFront();
  const secondPurchaseResponse = secondPage.waitForResponse(response => (
    new URL(response.url()).pathname ===
      '/api/payment/credit-packs/purchase'
    && response.request().method() === 'POST'
  ));
  await secondPage.locator('#creditPackModalConfirm').click({
    timeout: 5_000
  });
  const purchaseResponses = await Promise.all([
    firstPurchaseResponse,
    secondPurchaseResponse
  ]);
  await Promise.all(purchaseResponses.map(response => response.finished()));
  await expect.poll(() => fixture.purchaseRequests.length).toBe(2);
  expect(fixture.providerChargeAttempts).toBe(1);
  expect(fixture.unhandledApiRequests).toEqual([]);
  await expect(secondPage.locator('#creditPackConfirmModal'))
    .not.toHaveClass(/open/, { timeout: 15_000 });
  const expectedPurchaseBody = {
    packKey: 'usage_600',
    purchaseRequestId: PURCHASE_REQUEST_ID,
    confirmationVersion: 1,
    confirmedGrandTotal: '1080',
    confirmedCurrencyCode: 'USD'
  };
  expect(fixture.purchaseRequests.map(request => request.body)).toEqual([
    expectedPurchaseBody,
    expectedPurchaseBody
  ]);
  expect(fixture.openPurchase).toMatchObject({
    purchaseRequestId: PURCHASE_REQUEST_ID,
    status: 'submitted'
  });
  await expect(secondPage.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'pending'
  );
  // localStorage is shared by same-origin pages in this browser context. Read
  // it once from the foreground tab: evaluating the redundant background-tab
  // copy can stall on Windows Chrome while its status poll is still active.
  await secondPage.bringToFront();
  expect(await secondPage.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
  // The Playwright context fixture owns this page and closes it during test
  // teardown. Closing it here can wait on the deliberately active status poll
  // and turn a completed race assertion into a browser-shutdown timeout.
});

test('pending purchases resume from user-scoped local storage after reload', async ({ page }) => {
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
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();
  expect(fixture.pendingRecoveryRequests).toBe(0);
});

test('a reserved created preview restores the exact confirmation after reload', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'created'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(0);
  await expect(page.locator('#creditPackConfirmModal')).toHaveClass(/open/);
  await expect(page.locator('#creditPackModalTotal')).toHaveText('$10.80');
  await expect(page.locator('#creditPackModalTerms')).toContainText(
    'expire 365 days'
  );
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
  expect(fixture.purchaseRequests).toEqual([]);
  expect(fixture.providerChargeAttempts).toBe(0);

  await page.locator('#creditPackModalCancel').click();
  await expect.poll(() => fixture.cancelRequests.length).toBe(1);
  await expect(page.locator('#creditPackConfirmModal')).not.toHaveClass(/open/);
});

test('withheld payments stay locked for review and cannot be purchased again', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'withheld'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(0);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'error'
  );
  await expect(page.locator('#creditPackStatus')).toContainText(
    'credits are on hold'
  );
  const buttons = page.locator('[data-credit-pack-key]');
  await expect(buttons.first()).toBeDisabled();
  await expect(buttons.first()).toHaveText('Review required');
  expect(fixture.purchaseRequests).toEqual([]);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
});

test('a confirmed refund clears the purchase lock without adding credits', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    credits: 80,
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'refunded'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#usageDisplay')).toContainText('80');
  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(0);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'success'
  );
  await expect(page.locator('#creditPackStatus')).toContainText(
    'refund was confirmed'
  );
  const buttons = page.locator('[data-credit-pack-key]');
  await expect(buttons).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(buttons.nth(index)).toBeEnabled();
  }
  await expect(page.locator('#usageDisplay')).toContainText('80');
  expect(fixture.credits).toBe(80);
  expect(fixture.purchaseRequests).toEqual([]);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();
});

test('a refunded purchase with consumed credits keeps the durable review lock', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    credits: 80,
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'refunded',
    purchaseReviewRequired: true
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(0);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'error'
  );
  await expect(page.locator('#creditPackStatus')).toContainText(
    'credits are on hold'
  );
  const buttons = page.locator('[data-credit-pack-key]');
  await expect(buttons).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(buttons.nth(index)).toBeDisabled();
    await expect(buttons.nth(index)).toHaveText('Review required');
  }
  expect(fixture.purchaseRequests).toEqual([]);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
});

test('a chargeback keeps the review lock and shows a distinct warning', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    credits: 80,
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'chargeback'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#usageDisplay')).toContainText('80');
  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(0);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'error'
  );
  await expect(page.locator('#creditPackStatus')).toContainText(
    'reversed by a chargeback'
  );
  const buttons = page.locator('[data-credit-pack-key]');
  await expect(buttons).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(buttons.nth(index)).toBeDisabled();
    await expect(buttons.nth(index)).toHaveText('Review required');
  }
  await expect(page.locator('#usageDisplay')).toContainText('80');
  expect(fixture.credits).toBe(80);
  expect(fixture.purchaseRequests).toEqual([]);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
});

test('disabled sales still recover and display a stored withheld payment', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'withheld',
    creditPackPurchasesEnabled: false
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#creditPackPanel')).toBeHidden();
  await expect(page.locator('[data-credit-pack-key]')).toHaveCount(0);
  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(0);
  await expect(page.locator('#creditPackStatus')).toBeVisible();
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'error'
  );
  await expect(page.locator('#creditPackStatus')).toContainText(
    'credits are on hold'
  );
  expect(fixture.previewRequests).toEqual([]);
  expect(fixture.purchaseRequests).toEqual([]);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
});

test('disabled sales still recover a stored refund and clear its local lock', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'refunded',
    creditPackPurchasesEnabled: false
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#creditPackPanel')).toBeHidden();
  await expect(page.locator('[data-credit-pack-key]')).toHaveCount(0);
  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(0);
  await expect(page.locator('#creditPackStatus')).toBeVisible();
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'success'
  );
  await expect(page.locator('#creditPackStatus')).toContainText(
    'refund was confirmed'
  );
  expect(fixture.previewRequests).toEqual([]);
  expect(fixture.purchaseRequests).toEqual([]);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();
});

test('a lost preview response recovers the same server reservation without charging', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    previewMode: 'lost_response'
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');
  const initialRecoveryRequests = fixture.pendingRecoveryRequests;

  await page.locator('[data-credit-pack-key="usage_600"]').click();

  await expect.poll(() => fixture.pendingRecoveryRequests)
    .toBeGreaterThan(initialRecoveryRequests);
  await expect.poll(() => fixture.statusRequests).toBeGreaterThan(0);
  await expect(page.locator('#creditPackConfirmModal')).toHaveClass(/open/);
  await expect(page.locator('#creditPackModalTotal')).toHaveText('$10.80');
  expect(fixture.previewReservations).toBe(1);
  expect(fixture.openPurchase.purchaseRequestId).toBe(PURCHASE_REQUEST_ID);
  expect(fixture.purchaseRequests).toEqual([]);
  expect(fixture.providerChargeAttempts).toBe(0);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
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
  const recoveryRequestsBeforeReload = fixture.pendingRecoveryRequests;

  await page.locator('[data-credit-pack-key="usage_600"]').click();
  await page.locator('#creditPackModalConfirm').click();
  await expect.poll(() => fixture.purchaseRequests.length).toBe(1);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'pending'
  );
  await expect(page.locator('#creditPackStatus')).toContainText(
    'do not purchase again'
  );
  await expect(page.locator('#creditPackStatus')).toBeFocused();
  expect(await page.evaluate(() => (
    document.activeElement?.closest('[aria-hidden="true"]') === null
  ))).toBe(true);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);

  fixture.purchaseStatus = 'completed';
  await page.reload({ waitUntil: 'domcontentloaded' });

  expect(fixture.pendingRecoveryRequests).toBe(
    recoveryRequestsBeforeReload
  );
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
    `Bearer ${PAID_SESSION.access_token}`
  ]);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();

  await page.evaluate(() => {
    window.__emitAuthStateChange('TOKEN_REFRESHED');
    window.__emitAuthStateChange('SIGNED_IN');
  });
  await page.waitForTimeout(100);
  expect(fixture.pendingRecoveryRequests).toBe(
    recoveryRequestsBeforeReload
  );
  expect(fixture.purchaseRequests).toHaveLength(1);
});

test('a fast webhook completion survives a lost POST response and an initial status 404', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    purchaseMode: 'lost_response_fast_completed',
    statusNotFoundCount: 1
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');

  await page.locator('[data-credit-pack-key="usage_600"]').click();
  await page.locator('#creditPackModalConfirm').click();

  await expect.poll(() => fixture.purchaseRequests.length).toBe(1);
  expect(fixture.purchaseRequests[0].body.purchaseRequestId)
    .toBe(PURCHASE_REQUEST_ID);
  await expect.poll(() => fixture.statusRequests, {
    timeout: 5_000
  }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => fixture.pendingRecoveryRequests)
    .toBeGreaterThanOrEqual(2);
  await expect(page.locator('#creditPackStatus')).toHaveAttribute(
    'data-state',
    'success',
    { timeout: 5_000 }
  );
  await expect(page.locator('#creditPackStatus')).toContainText(
    'Credits confirmed'
  );
  expect(fixture.purchaseRequests).toHaveLength(1);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBeNull();
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
        purchaseRequestId: PURCHASE_REQUEST_ID,
        status: 'created',
        confirmationVersion: 1,
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
  const pendingRecoveryAuthorizations = [];
  // The real pending-purchase endpoint is authenticated and user-scoped. The
  // shared fixture keeps one in-memory purchase for most single-account tests,
  // so override discovery here to avoid returning the first account's row to
  // the second account during this account-isolation scenario.
  await page.route(
    /\/api\/payment\/credit-packs\/purchase\/pending(?:\?.*)?$/,
    async route => {
      pendingRecoveryAuthorizations.push(
        route.request().headers().authorization
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, purchase: null })
      });
    }
  );
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
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), PAID_SESSION.user.id)).toBe(PURCHASE_REQUEST_ID);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), SECOND_PAID_SESSION.user.id)).toBeNull();
  await expect.poll(() => pendingRecoveryAuthorizations).toContain(
    `Bearer ${SECOND_PAID_SESSION.access_token}`
  );
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
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
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
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
  ), SECOND_PAID_SESSION.user.id)).toBe(SECOND_PURCHASE_REQUEST_ID);
  await expect.poll(() => page.evaluate(userId => (
    window.localStorage.getItem(`promptgen:credit-pack-purchase:${userId}`)
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

test('confirmation modal traps focus and closes only after each server-confirmed cancellation', async ({ page }) => {
  const fixture = await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    cancelDelayMs: 500
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.locator('#planBadge').textContent()).toBe('Pro');

  const buyButton = page.locator('[data-credit-pack-key="usage_600"]');
  const modal = page.locator('#creditPackConfirmModal');
  const dismissals = [
    {
      label: 'close button',
      act: () => page.locator('#creditPackModalClose').click()
    },
    {
      label: 'cancel button',
      act: () => page.locator('#creditPackModalCancel').click()
    },
    {
      label: 'backdrop',
      act: () => modal.click({ position: { x: 4, y: 4 } })
    },
    {
      label: 'Escape',
      act: () => page.keyboard.press('Escape')
    }
  ];

  for (const [index, dismissal] of dismissals.entries()) {
    await buyButton.click();
    await expect(modal, dismissal.label).toHaveClass(/open/);
    await expect(page.locator('#creditPackModalClose')).toBeFocused();
    if (index === 0) {
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('#creditPackModalConfirm')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#creditPackModalClose')).toBeFocused();
    }

    const actionPromise = dismissal.act();
    await expect.poll(() => fixture.cancelRequests.length).toBe(index + 1);
    await expect(modal, dismissal.label).toHaveClass(/open/);
    await expect(modal, dismissal.label).toHaveAttribute('aria-busy', 'true');
    await actionPromise;
    await expect(modal, dismissal.label).not.toHaveClass(/open/);
    await expect(buyButton, dismissal.label).toBeFocused();
  }

  expect(fixture.purchaseRequests).toEqual([]);
  expect(fixture.providerChargeAttempts).toBe(0);
  expect(fixture.cancelRequests.map(request => request.body)).toEqual([
    { reason: 'client_cancelled' },
    { reason: 'client_cancelled' },
    { reason: 'client_cancelled' },
    { reason: 'client_cancelled' }
  ]);
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

test('sales-off review banner wraps safely at 375px in all six locales', async ({ page }) => {
  await installPaymentFixture(page, {
    session: PAID_SESSION,
    plan: 'pro',
    storedRequestId: PURCHASE_REQUEST_ID,
    initialPurchaseStatus: 'withheld',
    creditPackPurchasesEnabled: false
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(
    () => page.locator('#creditPackStatus').getAttribute('data-state')
  ).toBe('error');
  await expect(page.locator('#creditPackPanel')).toBeHidden();

  for (const locale of LOCALES) {
    await page.locator('[data-locale-select]').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('#creditPackStatus')).toHaveText(
      MESSAGES[locale]['pricing.addons.status.withheld']
    );
    const layout = await page.evaluate(() => {
      const status = document.getElementById('creditPackStatus');
      const rect = status.getBoundingClientRect();
      return {
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        statusWithinViewport:
          rect.left >= -1 && rect.right <= window.innerWidth + 1,
        statusContentFits: status.scrollWidth <= status.clientWidth + 1
      };
    });
    expect(layout.documentOverflow).toBeLessThanOrEqual(2);
    expect(layout.statusWithinViewport).toBe(true);
    expect(layout.statusContentFits).toBe(true);
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
