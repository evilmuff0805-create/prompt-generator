'use strict';

const {
  APPLY_CONFIRMATION,
  CATALOG,
  EFFECTIVE_TAX_MODE,
  PADDLE_SANDBOX_API_BASE,
  createPaddleSandboxCatalog,
  pricePayload,
  productPayload,
  publicError
} = require('../../scripts/create-paddle-sandbox-catalog');

const API_KEY = `pdl_sdbx_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_${'c'.repeat(3)}`;
const LIVE_API_KEY = `pdl_live_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_${'c'.repeat(3)}`;
const ARGS = ['--apply', `--confirm=${APPLY_CONFIRMATION}`];

function paddleId(prefix, character) {
  return `${prefix}_${character.repeat(26)}`;
}

function response(status, body, { jsonImpl = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    json: jsonImpl || (async () => body)
  };
}

function productEntity(definition, id) {
  return {
    id,
    ...productPayload(definition),
    status: 'active',
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z'
  };
}

function priceEntity(definition, productId, id) {
  return {
    id,
    ...pricePayload(definition, productId),
    tax_mode: EFFECTIVE_TAX_MODE,
    unit_price_overrides: [],
    status: 'active',
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z'
  };
}

function createProvider({
  products = [],
  prices = [],
  postFailure = null,
  listOverride = null
} = {}) {
  const state = {
    products: [...products],
    prices: [...prices]
  };
  let requestSequence = 0;
  let productSequence = state.products.length;
  let priceSequence = state.prices.length;

  const fetchImpl = jest.fn(async (requestUrl, init) => {
    const url = new URL(requestUrl);
    const method = init.method;
    requestSequence += 1;
    const requestId = `req_${requestSequence}`;

    expect(url.origin).toBe(PADDLE_SANDBOX_API_BASE);
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.headers['Paddle-Version']).toBe('1');
    expect(init.redirect).toBe('error');

    if (method === 'GET' && listOverride && !/^\/(?:products|prices)\//.test(url.pathname)) {
      const overridden = await listOverride({ url, init, requestId, state });
      if (overridden) return overridden;
    }

    if (method === 'GET' && (url.pathname === '/products' || url.pathname === '/prices')) {
      const key = url.pathname.slice(1);
      return response(200, {
        data: state[key],
        meta: {
          request_id: requestId,
          pagination: {
            per_page: 200,
            has_more: false,
            next: requestUrl
          }
        }
      });
    }

    if (method === 'GET' && url.pathname.startsWith('/products/')) {
      const id = url.pathname.slice('/products/'.length);
      return response(200, {
        data: state.products.find((item) => item.id === id),
        meta: { request_id: requestId }
      });
    }

    if (method === 'GET' && url.pathname.startsWith('/prices/')) {
      const id = url.pathname.slice('/prices/'.length);
      return response(200, {
        data: state.prices.find((item) => item.id === id),
        meta: { request_id: requestId }
      });
    }

    if (method === 'POST') {
      if (postFailure) return postFailure({ url, init, requestId, state });
      const payload = JSON.parse(init.body);
      if (url.pathname === '/products') {
        const definition = CATALOG.products.find(({ name }) => name === payload.name);
        const id = paddleId('pro', productSequence === 0 ? 'a' : 'b');
        productSequence += 1;
        const entity = productEntity(definition, id);
        expect(payload).toEqual(productPayload(definition));
        state.products.push(entity);
        return response(201, { data: entity, meta: { request_id: requestId } });
      }
      if (url.pathname === '/prices') {
        const definition = CATALOG.prices.find(({ description }) => (
          description === payload.description
        ));
        const id = paddleId('pri', ['c', 'd', 'e'][priceSequence]);
        priceSequence += 1;
        const entity = priceEntity(definition, payload.product_id, id);
        expect(payload).toEqual(pricePayload(definition, payload.product_id));
        state.prices.push(entity);
        return response(201, { data: entity, meta: { request_id: requestId } });
      }
    }

    throw new Error('Unexpected provider call in test.');
  });

  return { fetchImpl, state };
}

describe('fail-closed Paddle Sandbox catalog creation operator', () => {
  test('matches the independently approved literal catalog and exact create payloads', () => {
    const approvedCatalog = {
      products: [
        {
          key: 'pro',
          name: 'PromptGen AI Pro',
          description: 'For individual creators. Includes 600 credits/month: up to 20 base-cost storyboards (30 credits; +5 per reference image, max 4) or 300 image analyses. Credits reset at renewal and do not roll over.'
        },
        {
          key: 'enterprise',
          name: 'PromptGen AI Enterprise',
          description: 'For high-volume individual creators. Includes 1,500 credits/month: up to 50 base-cost storyboards (30 credits; +5 per reference image, max 4) or 750 image analyses. Single-user plan. Credits reset at renewal and do not roll over.'
        }
      ],
      prices: [
        {
          key: 'pro_999',
          productKey: 'pro',
          name: 'Pro Monthly',
          description: 'Pro - $9.99/month - 600 credits - up to 20 base-cost storyboards or 300 analyses',
          amount: '999'
        },
        {
          key: 'pro_1099',
          productKey: 'pro',
          name: 'Pro Monthly',
          description: 'Pro - $10.99/month - 600 credits - up to 20 base-cost storyboards or 300 analyses',
          amount: '1099'
        },
        {
          key: 'enterprise_1999',
          productKey: 'enterprise',
          name: 'Enterprise Monthly',
          description: 'Enterprise - $19.99/month - 1,500 credits - up to 50 base-cost storyboards or 750 analyses',
          amount: '1999'
        }
      ]
    };

    expect(CATALOG).toEqual(approvedCatalog);
    expect(productPayload(approvedCatalog.products[0])).toEqual({
      name: 'PromptGen AI Pro',
      description: approvedCatalog.products[0].description,
      type: 'standard',
      tax_category: 'saas'
    });
    expect(productPayload(approvedCatalog.products[1])).toEqual({
      name: 'PromptGen AI Enterprise',
      description: approvedCatalog.products[1].description,
      type: 'standard',
      tax_category: 'saas'
    });

    const proId = paddleId('pro', 'a');
    const enterpriseId = paddleId('pro', 'b');
    expect(approvedCatalog.prices.map((definition) => pricePayload(
      definition,
      definition.productKey === 'pro' ? proId : enterpriseId
    ))).toEqual([
      {
        product_id: proId,
        type: 'standard',
        name: 'Pro Monthly',
        description: approvedCatalog.prices[0].description,
        billing_cycle: { interval: 'month', frequency: 1 },
        trial_period: null,
        tax_mode: 'account_setting',
        unit_price: { amount: '999', currency_code: 'USD' },
        quantity: { minimum: 1, maximum: 1 }
      },
      {
        product_id: proId,
        type: 'standard',
        name: 'Pro Monthly',
        description: approvedCatalog.prices[1].description,
        billing_cycle: { interval: 'month', frequency: 1 },
        trial_period: null,
        tax_mode: 'account_setting',
        unit_price: { amount: '1099', currency_code: 'USD' },
        quantity: { minimum: 1, maximum: 1 }
      },
      {
        product_id: enterpriseId,
        type: 'standard',
        name: 'Enterprise Monthly',
        description: approvedCatalog.prices[2].description,
        billing_cycle: { interval: 'month', frequency: 1 },
        trial_period: null,
        tax_mode: 'account_setting',
        unit_price: { amount: '1999', currency_code: 'USD' },
        quantity: { minimum: 1, maximum: 1 }
      }
    ]);
  });

  test.each([
    ['missing apply arguments', { rawApiKey: API_KEY, args: [] }],
    ['wrong confirmation', { rawApiKey: API_KEY, args: ['--apply', '--confirm=wrong'] }],
    ['live key', { rawApiKey: LIVE_API_KEY, args: ARGS }],
    ['padded key', { rawApiKey: ` ${API_KEY}`, args: ARGS }],
    ['multiline key', { rawApiKey: `${API_KEY}\nsecond-line`, args: ARGS }],
    ['missing key', { rawApiKey: '', args: ARGS }]
  ])('%s fails before any network request', async (_label, options) => {
    const fetchImpl = jest.fn();
    await expect(createPaddleSandboxCatalog({ ...options, fetchImpl })).rejects.toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('creates exactly two products and three monthly prices in the approved order', async () => {
    const { fetchImpl, state } = createProvider();
    const result = await createPaddleSandboxCatalog({
      rawApiKey: `${API_KEY}\r\n`,
      args: ARGS,
      fetchImpl
    });

    expect(result).toEqual({
      success: true,
      environment: 'sandbox',
      mode: 'catalog-create',
      posts: 5,
      resumedFrom: null,
      products: {
        pro: paddleId('pro', 'a'),
        enterprise: paddleId('pro', 'b')
      },
      prices: {
        pro_999: paddleId('pri', 'c'),
        pro_1099: paddleId('pri', 'd'),
        enterprise_1999: paddleId('pri', 'e')
      }
    });
    expect(state.products).toHaveLength(2);
    expect(state.prices).toHaveLength(3);

    const posts = fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(posts.map(([requestUrl]) => new URL(requestUrl).pathname)).toEqual([
      '/products', '/prices', '/prices', '/products', '/prices'
    ]);
    expect(posts).toHaveLength(5);

    const postedBodies = posts.map(([, init]) => JSON.parse(init.body));
    expect(postedBodies[0]).toEqual(productPayload(CATALOG.products[0]));
    expect(postedBodies[1]).toEqual(pricePayload(CATALOG.prices[0], paddleId('pro', 'a')));
    expect(postedBodies[2]).toEqual(pricePayload(CATALOG.prices[1], paddleId('pro', 'a')));
    expect(postedBodies[3]).toEqual(productPayload(CATALOG.products[1]));
    expect(postedBodies[4]).toEqual(pricePayload(CATALOG.prices[2], paddleId('pro', 'b')));
    expect(postedBodies.filter((payload) => payload.product_id).every((payload) => (
      payload.quantity.minimum === 1
      && payload.quantity.maximum === 1
      && payload.trial_period === null
      && payload.tax_mode === 'account_setting'
    ))).toBe(true);
  });

  test('rejects any pre-existing active or archived catalog object before POST', async () => {
    const existing = productEntity(CATALOG.products[0], paddleId('pro', 'x'));
    existing.status = 'archived';
    const { fetchImpl } = createProvider({ products: [existing] });

    await expect(createPaddleSandboxCatalog({
      rawApiKey: API_KEY,
      args: ARGS,
      fetchImpl
    })).rejects.toMatchObject({
      code: 'PADDLE_SANDBOX_CATALOG_CONCURRENT_CHANGE'
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });

  test('resumes only from the exact verified Pro product and 9.99 price IDs', async () => {
    const proId = paddleId('pro', 'a');
    const pro999Id = paddleId('pri', 'c');
    const { fetchImpl, state } = createProvider({
      products: [productEntity(CATALOG.products[0], proId)],
      prices: [priceEntity(CATALOG.prices[0], proId, pro999Id)]
    });
    const args = [
      ...ARGS,
      '--resume=pro_999',
      `--expect-pro-product-id=${proId}`,
      `--expect-pro-999-price-id=${pro999Id}`
    ];

    const result = await createPaddleSandboxCatalog({ rawApiKey: API_KEY, args, fetchImpl });

    expect(result).toEqual({
      success: true,
      environment: 'sandbox',
      mode: 'catalog-create',
      posts: 3,
      resumedFrom: 'pro_999',
      products: {
        pro: proId,
        enterprise: paddleId('pro', 'b')
      },
      prices: {
        pro_999: pro999Id,
        pro_1099: paddleId('pri', 'd'),
        enterprise_1999: paddleId('pri', 'e')
      }
    });
    expect(state.products).toHaveLength(2);
    expect(state.prices).toHaveLength(3);
    expect(fetchImpl.mock.calls
      .filter(([, init]) => init.method === 'POST')
      .map(([requestUrl]) => new URL(requestUrl).pathname)).toEqual([
      '/prices', '/products', '/prices'
    ]);
  });

  test('partial resume with an unverified existing ID fails before POST', async () => {
    const proId = paddleId('pro', 'a');
    const pro999Id = paddleId('pri', 'c');
    const { fetchImpl } = createProvider({
      products: [productEntity(CATALOG.products[0], proId)],
      prices: [priceEntity(CATALOG.prices[0], proId, pro999Id)]
    });

    await expect(createPaddleSandboxCatalog({
      rawApiKey: API_KEY,
      args: [
        ...ARGS,
        '--resume=pro_999',
        `--expect-pro-product-id=${paddleId('pro', 'z')}`,
        `--expect-pro-999-price-id=${pro999Id}`
      ],
      fetchImpl
    })).rejects.toMatchObject({
      code: 'PADDLE_SANDBOX_CATALOG_CONCURRENT_CHANGE'
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });

  test('stops at the one-page boundary without sending the API key to a next URL', async () => {
    const attackerUrl = 'https://sandbox-api.paddle.com.attacker.invalid/products?after=secret';
    const existing = productEntity(CATALOG.products[0], paddleId('pro', 'x'));
    const { fetchImpl } = createProvider({
      listOverride: async ({ url, requestId }) => {
        if (url.pathname !== '/products') return null;
        return response(200, {
          data: [existing],
          meta: {
            request_id: requestId,
            pagination: { per_page: 200, has_more: true, next: attackerUrl }
          }
        });
      }
    });

    await expect(createPaddleSandboxCatalog({
      rawApiKey: API_KEY,
      args: ARGS,
      fetchImpl
    })).rejects.toMatchObject({
      code: 'PADDLE_SANDBOX_CATALOG_PAGE_LIMIT_REACHED'
    });
    expect(fetchImpl.mock.calls.some(([requestUrl]) => requestUrl === attackerUrl)).toBe(false);
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });

  test('stops after one POST when its network outcome is uncertain', async () => {
    let posts = 0;
    const { fetchImpl } = createProvider({
      postFailure: async () => {
        posts += 1;
        throw new Error(`private provider detail ${API_KEY}`);
      }
    });

    let error;
    try {
      await createPaddleSandboxCatalog({ rawApiKey: API_KEY, args: ARGS, fetchImpl });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'PADDLE_SANDBOX_CATALOG_WRITE_OUTCOME_UNKNOWN'
    });
    expect(posts).toBe(1);
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(publicError(error))).not.toContain(API_KEY);
  });

  test('does not parse or expose a rejected provider response body', async () => {
    const providerBody = jest.fn(async () => ({
      error: { detail: `private provider detail ${API_KEY}` }
    }));
    const { fetchImpl } = createProvider({
      postFailure: async () => response(403, null, { jsonImpl: providerBody })
    });

    let error;
    try {
      await createPaddleSandboxCatalog({ rawApiKey: API_KEY, args: ARGS, fetchImpl });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'PADDLE_SANDBOX_CATALOG_WRITE_REJECTED',
      httpStatus: 403
    });
    expect(providerBody).not.toHaveBeenCalled();
    expect(JSON.stringify(publicError(error))).not.toContain(API_KEY);
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  test('treats an unreadable 201 response as uncertain and never retries', async () => {
    const { fetchImpl } = createProvider({
      postFailure: async () => response(201, null, {
        jsonImpl: async () => {
          throw new Error('invalid JSON');
        }
      })
    });

    await expect(createPaddleSandboxCatalog({
      rawApiKey: API_KEY,
      args: ARGS,
      fetchImpl
    })).rejects.toMatchObject({
      code: 'PADDLE_SANDBOX_CATALOG_WRITE_OUTCOME_UNKNOWN'
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  test('treats a 201 response with malformed metadata as uncertain and never retries', async () => {
    const definition = CATALOG.products[0];
    const entity = productEntity(definition, paddleId('pro', 'a'));
    const { fetchImpl } = createProvider({
      postFailure: async () => response(201, { data: entity, meta: null })
    });

    await expect(createPaddleSandboxCatalog({
      rawApiKey: API_KEY,
      args: ARGS,
      fetchImpl
    })).rejects.toMatchObject({
      code: 'PADDLE_SANDBOX_CATALOG_WRITE_OUTCOME_UNKNOWN'
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  test('requires reconciliation when verification fails after a confirmed 201', async () => {
    const definition = CATALOG.products[0];
    const entity = productEntity(definition, paddleId('pro', 'a'));
    const { fetchImpl } = createProvider({
      // Return a valid create response without adding it to the list/get fixture,
      // simulating provider-side visibility or verification failure after creation.
      postFailure: async ({ requestId }) => response(201, {
        data: entity,
        meta: { request_id: requestId }
      })
    });

    await expect(createPaddleSandboxCatalog({
      rawApiKey: API_KEY,
      args: ARGS,
      fetchImpl
    })).rejects.toMatchObject({
      code: 'PADDLE_SANDBOX_CATALOG_WRITE_RECONCILIATION_REQUIRED'
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
});
