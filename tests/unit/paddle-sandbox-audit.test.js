'use strict';

const {
  ENDPOINTS,
  PADDLE_SANDBOX_API_BASE,
  auditPaddleSandbox,
  readSandboxAuditConfig
} = require('../../scripts/audit-paddle-sandbox');

const API_KEY = `pdl_sdbx_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_C3D`;
const LIVE_API_KEY = `pdl_live_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_C3D`;
const BASE_ENV = Object.freeze({
  PADDLE_SANDBOX_AUDIT_CONFIRMED: 'true',
  PADDLE_API_BASE: PADDLE_SANDBOX_API_BASE,
  PADDLE_API_KEY: API_KEY
});
const TIMESTAMPS = Object.freeze({
  early: '2026-07-01T00:00:00.000Z',
  late: '2026-07-02T00:00:00.000Z'
});

function paddleId(prefix, character) {
  return `${prefix}_${character.repeat(26)}`;
}

function requestId(sequence) {
  return `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function endpointByPath(pathname) {
  return ENDPOINTS.find((definition) => definition.path === pathname);
}

function nextUrl(requestUrl, after = null) {
  const url = new URL(requestUrl);
  if (after) url.searchParams.set('after', after);
  return url.toString();
}

function pageResponse(requestUrl, data, {
  hasMore = false,
  sequence = 1,
  next = nextUrl(requestUrl, data.at(-1)?.id || null)
} = {}) {
  const definition = endpointByPath(new URL(requestUrl).pathname);
  return {
    ok: true,
    status: 200,
    redirected: false,
    json: async () => ({
      data,
      meta: {
        request_id: requestId(sequence),
        pagination: {
          per_page: definition.perPage,
          has_more: hasMore,
          next,
          estimated_total: -1
        }
      }
    })
  };
}

function product(character = 'a', overrides = {}) {
  return {
    id: paddleId('pro', character),
    name: 'PromptGen Pro',
    description: 'PromptGen product description',
    status: 'active',
    type: 'standard',
    tax_category: 'saas',
    created_at: TIMESTAMPS.early,
    updated_at: TIMESTAMPS.late,
    custom_data: { must_not_escape: 'PRODUCT_CUSTOM_DATA_MARKER' },
    image_url: 'https://private.invalid/product.png',
    ...overrides
  };
}

function price(character = 'b', overrides = {}) {
  return {
    id: paddleId('pri', character),
    product_id: paddleId('pro', 'a'),
    name: 'Monthly',
    description: 'PromptGen Pro monthly',
    status: 'active',
    type: 'standard',
    tax_mode: 'account_setting',
    unit_price: { amount: '1099', currency_code: 'USD' },
    billing_cycle: { interval: 'month', frequency: 1 },
    created_at: TIMESTAMPS.early,
    updated_at: TIMESTAMPS.late,
    custom_data: { must_not_escape: 'PRICE_CUSTOM_DATA_MARKER' },
    unit_price_overrides: [{ country_codes: ['KR'], unit_price: { amount: '999' } }],
    ...overrides
  };
}

function transaction(character = 'c', overrides = {}) {
  return {
    id: paddleId('txn', character),
    status: 'completed',
    created_at: TIMESTAMPS.early,
    updated_at: TIMESTAMPS.late,
    billed_at: TIMESTAMPS.late,
    customer_id: paddleId('ctm', 'x'),
    subscription_id: paddleId('sub', 'x'),
    custom_data: { must_not_escape: 'TRANSACTION_CUSTOM_DATA_MARKER' },
    checkout: { url: 'https://portal.invalid/transaction-secret' },
    details: { customer: { email: 'private-transaction@example.com' } },
    ...overrides
  };
}

function subscription(character = 'd', overrides = {}) {
  return {
    id: paddleId('sub', character),
    status: 'active',
    created_at: TIMESTAMPS.early,
    updated_at: TIMESTAMPS.late,
    customer_id: paddleId('ctm', 'y'),
    address_id: paddleId('add', 'y'),
    custom_data: { must_not_escape: 'SUBSCRIPTION_CUSTOM_DATA_MARKER' },
    management_urls: {
      update_payment_method: 'https://portal.invalid/subscription-secret'
    },
    ...overrides
  };
}

function notificationSetting(character = 'e', overrides = {}) {
  return {
    id: paddleId('ntfset', character),
    description: 'Production webhook',
    type: 'url',
    destination: 'https://private.invalid/webhook',
    active: true,
    endpoint_secret_key: 'pdl_ntfset_secret_must_not_escape',
    subscribed_events: [{ name: 'transaction.completed' }],
    ...overrides
  };
}

function notification(character = 'f', overrides = {}) {
  return {
    id: paddleId('ntf', character),
    type: 'transaction.completed',
    status: 'delivered',
    occurred_at: TIMESTAMPS.early,
    delivered_at: TIMESTAMPS.late,
    last_attempt_at: TIMESTAMPS.late,
    notification_setting_id: paddleId('ntfset', 'z'),
    payload: {
      data: {
        id: paddleId('txn', 'z'),
        customer_id: paddleId('ctm', 'z'),
        email: 'private-notification@example.com',
        custom_data: { must_not_escape: 'NOTIFICATION_PAYLOAD_MARKER' }
      }
    },
    ...overrides
  };
}

function entityForPath(pathname) {
  switch (pathname) {
    case '/products': return product();
    case '/prices': return price();
    case '/transactions': return transaction();
    case '/subscriptions': return subscription();
    case '/notification-settings': return notificationSetting();
    case '/notifications': return notification();
    default: throw new Error('Unexpected test endpoint.');
  }
}

function successfulFetch() {
  let sequence = 0;
  return jest.fn(async (requestUrl) => {
    sequence += 1;
    const pathname = new URL(requestUrl).pathname;
    return pageResponse(requestUrl, [entityForPath(pathname)], { sequence });
  });
}

describe('fail-closed Paddle Sandbox inventory audit', () => {
  test.each([
    ['missing confirmation', { ...BASE_ENV, PADDLE_SANDBOX_AUDIT_CONFIRMED: undefined }],
    ['non-exact confirmation', { ...BASE_ENV, PADDLE_SANDBOX_AUDIT_CONFIRMED: 'TRUE' }],
    ['live API base', { ...BASE_ENV, PADDLE_API_BASE: 'https://api.paddle.com' }],
    ['non-exact Sandbox base', { ...BASE_ENV, PADDLE_API_BASE: `${PADDLE_SANDBOX_API_BASE}/` }],
    ['live API key', { ...BASE_ENV, PADDLE_API_KEY: LIVE_API_KEY }],
    ['empty Sandbox key suffix', { ...BASE_ENV, PADDLE_API_KEY: 'pdl_sdbx_apikey_' }],
    ['malformed Sandbox key', { ...BASE_ENV, PADDLE_API_KEY: 'pdl_sdbx_apikey_ ' }],
    ['padded Sandbox key', { ...BASE_ENV, PADDLE_API_KEY: ` ${API_KEY} ` }]
  ])('%s fails before any network request', async (_label, env) => {
    const fetchImpl = jest.fn();
    await expect(auditPaddleSandbox({ env, fetchImpl })).rejects.toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('configuration errors never echo rejected bases or API keys', () => {
    const secret = 'pdl_live_apikey_do_not_echo';
    let error;
    try {
      readSandboxAuditConfig({
        PADDLE_SANDBOX_AUDIT_CONFIRMED: 'true',
        PADDLE_API_BASE: 'https://api.paddle.com/private?token=do-not-echo',
        PADDLE_API_KEY: secret
      });
    } catch (caught) {
      error = caught;
    }
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(secret);
    expect(error.message).not.toContain('token=do-not-echo');
  });

  test('uses GET only and emits catalog fields plus aggregate-only sensitive reports', async () => {
    const fetchImpl = successfulFetch();
    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });

    expect(report.success).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.unavailableEndpoints).toEqual([]);
    expect(report.endpoints.products.inventory).toEqual([
      expect.objectContaining({
        id: paddleId('pro', 'a'),
        name: 'PromptGen Pro',
        description: 'PromptGen product description',
        status: 'active',
        taxCategory: 'saas'
      })
    ]);
    expect(report.endpoints.prices.inventory).toEqual([
      expect.objectContaining({
        id: paddleId('pri', 'b'),
        productId: paddleId('pro', 'a'),
        unitPrice: { amount: '1099', currencyCode: 'USD' },
        billingCycle: { interval: 'month', frequency: 1 },
        taxMode: 'account_setting'
      })
    ]);
    expect(report.endpoints.transactions).toEqual(expect.objectContaining({
      status: 'ok',
      requiredScope: 'transaction.read',
      total: 1,
      byStatus: { completed: 1 },
      latestAt: {
        createdAt: TIMESTAMPS.early,
        updatedAt: TIMESTAMPS.late,
        billedAt: TIMESTAMPS.late
      }
    }));
    expect(report.endpoints.notificationSettings).toEqual(expect.objectContaining({
      total: 1,
      byStatus: { active: 1, inactive: 0 }
    }));

    for (const [requestUrl, init] of fetchImpl.mock.calls) {
      expect(new URL(requestUrl).origin).toBe(PADDLE_SANDBOX_API_BASE);
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe('error');
      expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(init.headers['Paddle-Version']).toBe('1');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(ENDPOINTS.length);

    const output = JSON.stringify(report);
    for (const forbidden of [
      API_KEY,
      paddleId('txn', 'c'),
      paddleId('sub', 'd'),
      paddleId('ctm', 'x'),
      paddleId('ctm', 'y'),
      paddleId('add', 'y'),
      paddleId('ntfset', 'e'),
      paddleId('ntf', 'f'),
      'private-transaction@example.com',
      'private-notification@example.com',
      'PRODUCT_CUSTOM_DATA_MARKER',
      'PRICE_CUSTOM_DATA_MARKER',
      'TRANSACTION_CUSTOM_DATA_MARKER',
      'SUBSCRIPTION_CUSTOM_DATA_MARKER',
      'NOTIFICATION_PAYLOAD_MARKER',
      'https://portal.invalid/transaction-secret',
      'https://portal.invalid/subscription-secret',
      'https://private.invalid/webhook',
      'pdl_ntfset_secret_must_not_escape'
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });

  test('requests active and archived catalog records and follows every trusted cursor page', async () => {
    let sequence = 0;
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const url = new URL(requestUrl);
      if (url.pathname === '/products' && !url.searchParams.has('after')) {
        const first = product('a');
        const normalizedNext = new URL(nextUrl(requestUrl, first.id));
        normalizedNext.searchParams.delete('status');
        normalizedNext.searchParams.append('status', 'active');
        normalizedNext.searchParams.append('status', 'archived');
        return pageResponse(requestUrl, [first], {
          hasMore: true,
          sequence,
          next: normalizedNext.toString()
        });
      }
      if (url.pathname === '/products') {
        return pageResponse(requestUrl, [product('g', { status: 'archived' })], { sequence });
      }
      return pageResponse(requestUrl, [entityForPath(url.pathname)], { sequence });
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });
    expect(report.success).toBe(true);
    expect(report.endpoints.products.pages).toBe(2);
    expect(report.endpoints.products.total).toBe(2);
    expect(report.endpoints.products.inventory.map(({ status }) => status)).toEqual([
      'active',
      'archived'
    ]);

    const catalogUrls = fetchImpl.mock.calls
      .map(([requestUrl]) => new URL(requestUrl))
      .filter(({ pathname }) => pathname === '/products' || pathname === '/prices');
    const initialCatalogUrls = catalogUrls.filter((url) => !url.searchParams.has('after'));
    for (const url of initialCatalogUrls) {
      expect(url.searchParams.getAll('status')).toEqual(['active,archived']);
      expect(url.searchParams.get('order_by')).toBe('id[ASC]');
    }
    const nextProductUrl = catalogUrls.find(
      (url) => url.pathname === '/products' && url.searchParams.has('after')
    );
    expect(nextProductUrl.searchParams.getAll('status')).toEqual(['active', 'archived']);
  });

  test('accepts Paddle terminal-page normalization for empty Sandbox lists', async () => {
    let sequence = 0;
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const url = new URL(requestUrl);
      let next = null;

      if (url.pathname === '/products' || url.pathname === '/prices') {
        const normalized = new URL(requestUrl);
        normalized.searchParams.delete('status');
        normalized.searchParams.append('status', 'active');
        normalized.searchParams.append('status', 'archived');
        next = normalized.toString();
      }

      return pageResponse(requestUrl, [], { sequence, next });
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });

    expect(report.success).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.unavailableEndpoints).toEqual([]);
    for (const definition of ENDPOINTS) {
      expect(report.endpoints[definition.key]).toEqual(expect.objectContaining({
        status: 'ok',
        total: 0,
        pages: 1
      }));
    }
  });

  test('rejects a missing next URL when Paddle reports another page', async () => {
    let sequence = 0;
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const url = new URL(requestUrl);
      if (url.pathname === '/products') {
        return pageResponse(requestUrl, [product()], {
          hasMore: true,
          sequence,
          next: null
        });
      }
      return pageResponse(requestUrl, [entityForPath(url.pathname)], { sequence });
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });

    expect(report.success).toBe(false);
    expect(report.endpoints.products.error.code).toBe(
      'PADDLE_SANDBOX_AUDIT_MALFORMED_RESPONSE'
    );
  });

  test('rejects a null terminal URL when the terminal page is non-empty', async () => {
    let sequence = 0;
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const url = new URL(requestUrl);
      if (url.pathname === '/products') {
        return pageResponse(requestUrl, [product()], {
          hasMore: false,
          sequence,
          next: null
        });
      }
      return pageResponse(requestUrl, [entityForPath(url.pathname)], { sequence });
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });

    expect(report.success).toBe(false);
    expect(report.endpoints.products.error.code).toBe(
      'PADDLE_SANDBOX_AUDIT_MALFORMED_RESPONSE'
    );
  });

  test('does not parse or follow an unused next URL after a terminal page', async () => {
    let sequence = 0;
    const unusedUrl = 'https://sandbox-api.paddle.com.attacker.invalid/products?after=unused';
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const url = new URL(requestUrl);
      if (url.pathname === '/products') {
        return pageResponse(requestUrl, [product()], {
          hasMore: false,
          sequence,
          next: unusedUrl
        });
      }
      return pageResponse(requestUrl, [entityForPath(url.pathname)], { sequence });
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });

    expect(report.success).toBe(true);
    expect(report.endpoints.products).toEqual(expect.objectContaining({
      status: 'ok',
      total: 1,
      pages: 1
    }));
    expect(fetchImpl.mock.calls.some(([requestUrl]) => requestUrl === unusedUrl)).toBe(false);
  });

  test('rejects an untrusted next URL without sending the bearer token to it', async () => {
    let sequence = 0;
    const attackerUrl = 'https://sandbox-api.paddle.com.attacker.invalid/products?after=secret';
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const url = new URL(requestUrl);
      if (url.pathname === '/products') {
        return pageResponse(requestUrl, [product()], {
          hasMore: true,
          sequence,
          next: attackerUrl
        });
      }
      return pageResponse(requestUrl, [entityForPath(url.pathname)], { sequence });
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });
    expect(report.success).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.endpoints.products).toEqual(expect.objectContaining({
      status: 'unavailable',
      error: expect.objectContaining({
        code: 'PADDLE_SANDBOX_AUDIT_UNTRUSTED_PAGINATION'
      })
    }));
    expect(fetchImpl.mock.calls.some(([requestUrl]) => requestUrl === attackerUrl)).toBe(false);
    expect(JSON.stringify(report)).not.toContain(attackerUrl);
    expect(JSON.stringify(report)).not.toContain(API_KEY);
  });

  test('reports a missing read scope as partial failure and does not parse its error body', async () => {
    let sequence = 0;
    const forbiddenBody = jest.fn(async () => ({
      error: { detail: 'private?token=forbidden-body-secret' }
    }));
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === '/prices') {
        return { ok: false, status: 403, redirected: false, json: forbiddenBody };
      }
      return pageResponse(requestUrl, [entityForPath(pathname)], { sequence });
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });
    expect(report.success).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.endpoints.products.status).toBe('ok');
    expect(report.endpoints.prices).toEqual({
      status: 'unavailable',
      requiredScope: 'price.read',
      error: {
        code: 'PADDLE_SANDBOX_AUDIT_PERMISSION_DENIED',
        message: 'Paddle prices requires the price.read scope.',
        httpStatus: 403
      }
    });
    expect(report.unavailableEndpoints).toEqual([
      expect.objectContaining({ endpoint: 'prices', requiredScope: 'price.read' })
    ]);
    expect(forbiddenBody).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('forbidden-body-secret');
  });

  test('fails closed on malformed list envelopes while keeping other endpoint results distinct', async () => {
    let sequence = 0;
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const pathname = new URL(requestUrl).pathname;
      if (pathname === '/notifications') {
        return {
          ok: true,
          status: 200,
          redirected: false,
          json: async () => ({ data: 'not-an-array', secret: 'raw-secret-marker' })
        };
      }
      return pageResponse(requestUrl, [entityForPath(pathname)], { sequence });
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });
    expect(report.success).toBe(false);
    expect(report.endpoints.subscriptions.status).toBe('ok');
    expect(report.endpoints.notifications.error.code).toBe(
      'PADDLE_SANDBOX_AUDIT_MALFORMED_RESPONSE'
    );
    expect(JSON.stringify(report)).not.toContain('raw-secret-marker');
  });

  test('does not echo an unexpected sensitive status value from an aggregate endpoint', async () => {
    let sequence = 0;
    const sensitiveStatus = 'private-customer@example.com';
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const pathname = new URL(requestUrl).pathname;
      const entity = pathname === '/transactions'
        ? transaction('c', { status: sensitiveStatus })
        : entityForPath(pathname);
      return pageResponse(requestUrl, [entity], { sequence });
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });
    expect(report.success).toBe(false);
    expect(report.endpoints.transactions.error.code).toBe(
      'PADDLE_SANDBOX_AUDIT_MALFORMED_RESPONSE'
    );
    expect(JSON.stringify(report)).not.toContain(sensitiveStatus);
  });

  test('sanitizes network and timeout failures without echoing URLs, query strings, or credentials', async () => {
    const secretError = Object.assign(
      new Error(`failed ${PADDLE_SANDBOX_API_BASE}/products?customer_id=secret ${API_KEY}`),
      { name: 'TimeoutError' }
    );
    const fetchImpl = jest.fn(async () => {
      throw secretError;
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });
    expect(report.success).toBe(false);
    expect(report.unavailableEndpoints).toHaveLength(ENDPOINTS.length);
    expect(report.endpoints.products.error.code).toBe('PADDLE_SANDBOX_AUDIT_TIMEOUT');
    const output = JSON.stringify(report);
    expect(output).not.toContain('customer_id=secret');
    expect(output).not.toContain(API_KEY);
  });

  test('stops an incomplete endpoint at the explicit page limit', async () => {
    let sequence = 0;
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const url = new URL(requestUrl);
      if (url.pathname === '/products') {
        const first = product();
        return pageResponse(requestUrl, [first], {
          hasMore: true,
          sequence,
          next: nextUrl(requestUrl, first.id)
        });
      }
      return pageResponse(requestUrl, [entityForPath(url.pathname)], { sequence });
    });

    const report = await auditPaddleSandbox({
      env: BASE_ENV,
      fetchImpl,
      maxPages: 1
    });
    expect(report.success).toBe(false);
    expect(report.endpoints.products.error.code).toBe(
      'PADDLE_SANDBOX_AUDIT_PAGE_LIMIT_REACHED'
    );
    expect(fetchImpl.mock.calls.filter(([requestUrl]) => (
      new URL(requestUrl).pathname === '/products'
    ))).toHaveLength(1);
  });

  test('rejects duplicate entities and repeated request IDs during pagination', async () => {
    const first = product('a');
    let productPage = 0;
    let sequence = 0;
    const fetchImpl = jest.fn(async (requestUrl) => {
      sequence += 1;
      const url = new URL(requestUrl);
      if (url.pathname === '/products') {
        productPage += 1;
        if (productPage === 1) {
          return pageResponse(requestUrl, [first], {
            hasMore: true,
            sequence: 99,
            next: nextUrl(requestUrl, first.id)
          });
        }
        return pageResponse(requestUrl, [first], { sequence: 99 });
      }
      return pageResponse(requestUrl, [entityForPath(url.pathname)], { sequence });
    });

    const report = await auditPaddleSandbox({ env: BASE_ENV, fetchImpl });
    expect(report.success).toBe(false);
    expect(report.endpoints.products.error.code).toBe(
      'PADDLE_SANDBOX_AUDIT_PAGINATION_LOOP'
    );
  });
});
