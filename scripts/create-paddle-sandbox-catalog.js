'use strict';

const {
  MODERN_PADDLE_API_KEY_PATTERN,
  PADDLE_ENVIRONMENTS,
  getPaddleApiKeyEnvironment
} = require('../lib/paddle-api');

const PADDLE_SANDBOX_API_BASE = 'https://sandbox-api.paddle.com';
const PADDLE_API_VERSION = '1';
const APPLY_CONFIRMATION = 'CREATE_PROMPTGEN_SANDBOX_CATALOG_V1';
const DEFAULT_TIMEOUT_MS = 10_000;
const EFFECTIVE_TAX_MODE = 'location';
const PRODUCT_ID_PATTERN = /^pro_[a-z\d]{26}$/;
const PRICE_ID_PATTERN = /^pri_[a-z\d]{26}$/;

const CATALOG = Object.freeze({
  products: Object.freeze([
    Object.freeze({
      key: 'pro',
      name: 'PromptGen AI Pro',
      description:
        'For individual creators. Includes 600 credits/month: up to 20 base-cost storyboards (30 credits; +5 per reference image, max 4) or 300 image analyses. Credits reset at renewal and do not roll over.'
    }),
    Object.freeze({
      key: 'enterprise',
      name: 'PromptGen AI Enterprise',
      description:
        'For high-volume individual creators. Includes 1,500 credits/month: up to 50 base-cost storyboards (30 credits; +5 per reference image, max 4) or 750 image analyses. Single-user plan. Credits reset at renewal and do not roll over.'
    })
  ]),
  prices: Object.freeze([
    Object.freeze({
      key: 'pro_999',
      productKey: 'pro',
      name: 'Pro Monthly',
      description:
        'Pro - $9.99/month - 600 credits - up to 20 base-cost storyboards or 300 analyses',
      amount: '999'
    }),
    Object.freeze({
      key: 'pro_1099',
      productKey: 'pro',
      name: 'Pro Monthly',
      description:
        'Pro - $10.99/month - 600 credits - up to 20 base-cost storyboards or 300 analyses',
      amount: '1099'
    }),
    Object.freeze({
      key: 'enterprise_1999',
      productKey: 'enterprise',
      name: 'Enterprise Monthly',
      description:
        'Enterprise - $19.99/month - 1,500 credits - up to 50 base-cost storyboards or 750 analyses',
      amount: '1999'
    })
  ])
});

const CREATION_ORDER = Object.freeze([
  Object.freeze({ kind: 'product', key: 'pro' }),
  Object.freeze({ kind: 'price', key: 'pro_999' }),
  Object.freeze({ kind: 'price', key: 'pro_1099' }),
  Object.freeze({ kind: 'product', key: 'enterprise' }),
  Object.freeze({ kind: 'price', key: 'enterprise_1999' })
]);

class PaddleSandboxCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PaddleSandboxCatalogError';
    this.code = code;
    this.phase = details.phase || null;
    this.httpStatus = Number.isInteger(details.httpStatus) ? details.httpStatus : null;
  }
}

function operatorError(code, message, details = {}) {
  return new PaddleSandboxCatalogError(code, message, details);
}

function publicError(error) {
  const safe = error instanceof PaddleSandboxCatalogError
    ? error
    : operatorError(
      'PADDLE_SANDBOX_CATALOG_INTERNAL_ERROR',
      'The Paddle Sandbox catalog operator stopped because of an internal error.'
    );
  return {
    code: safe.code,
    message: safe.message,
    ...(safe.phase ? { phase: safe.phase } : {}),
    ...(safe.httpStatus == null ? {} : { httpStatus: safe.httpStatus })
  };
}

function parseAuthorization(args) {
  const baseArguments = ['--apply', `--confirm=${APPLY_CONFIRMATION}`];
  const actual = new Set(args);
  const hasBaseArguments = baseArguments.every((argument) => actual.has(argument));
  const resumeArgument = args.find((argument) => argument.startsWith('--resume='));
  const productIdArgument = args.find((argument) => (
    argument.startsWith('--expect-pro-product-id=')
  ));
  const priceIdArgument = args.find((argument) => (
    argument.startsWith('--expect-pro-999-price-id=')
  ));
  const isFresh = args.length === 2 && actual.size === 2 && !resumeArgument;
  const isResume = args.length === 5
    && actual.size === 5
    && resumeArgument === '--resume=pro_999'
    && productIdArgument
    && priceIdArgument;

  if (!hasBaseArguments || (!isFresh && !isResume)) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_NOT_AUTHORIZED',
      'The exact Sandbox catalog apply flag and confirmation phrase are required.'
    );
  }
  if (isFresh) return Object.freeze({ resumeFrom: null });

  const productId = productIdArgument.slice('--expect-pro-product-id='.length);
  const priceId = priceIdArgument.slice('--expect-pro-999-price-id='.length);
  if (!PRODUCT_ID_PATTERN.test(productId) || !PRICE_ID_PATTERN.test(priceId)) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_NOT_AUTHORIZED',
      'The exact previously verified Paddle IDs are required for a partial resume.'
    );
  }
  return Object.freeze({ resumeFrom: 'pro_999', productId, priceId });
}

function normalizeStdinApiKey(rawInput) {
  if (typeof rawInput !== 'string' || rawInput.length === 0) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_KEY_REJECTED',
      'A modern Paddle Sandbox API key must be supplied through standard input.'
    );
  }

  let apiKey = rawInput;
  if (apiKey.endsWith('\r\n')) apiKey = apiKey.slice(0, -2);
  else if (apiKey.endsWith('\n')) apiKey = apiKey.slice(0, -1);

  if (
    !apiKey
    || apiKey.trim() !== apiKey
    || /[\r\n]/.test(apiKey)
    || !MODERN_PADDLE_API_KEY_PATTERN.test(apiKey)
    || getPaddleApiKeyEnvironment(apiKey) !== PADDLE_ENVIRONMENTS.sandbox
  ) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_KEY_REJECTED',
      'A modern Paddle Sandbox API key must be supplied through standard input.'
    );
  }
  return apiKey;
}

function productPayload(definition) {
  return {
    name: definition.name,
    description: definition.description,
    type: 'standard',
    tax_category: 'saas'
  };
}

function pricePayload(definition, productId) {
  return {
    product_id: productId,
    type: 'standard',
    name: definition.name,
    description: definition.description,
    billing_cycle: { interval: 'month', frequency: 1 },
    trial_period: null,
    tax_mode: 'account_setting',
    unit_price: { amount: definition.amount, currency_code: 'USD' },
    quantity: { minimum: 1, maximum: 1 }
  };
}

function malformedResponse(phase) {
  return operatorError(
    'PADDLE_SANDBOX_CATALOG_MALFORMED_RESPONSE',
    'Paddle returned an unexpected response while the Sandbox catalog was being verified.',
    { phase }
  );
}

function reconciliationRequired(phase) {
  return operatorError(
    'PADDLE_SANDBOX_CATALOG_WRITE_RECONCILIATION_REQUIRED',
    'At least one Paddle create request succeeded or may have succeeded; do not rerun this operator until the full Sandbox catalog is reconciled.',
    { phase }
  );
}

function assertPlainObject(value, phase) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw malformedResponse(phase);
  }
  return value;
}

function assertRequestId(value, phase) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw malformedResponse(phase);
  }
  return value;
}

function assertProduct(entity, expected, phase) {
  const item = assertPlainObject(entity, phase);
  const checks = [
    [PRODUCT_ID_PATTERN.test(item.id), 'id'],
    [item.name === expected.name, 'name'],
    [item.description === expected.description, 'description'],
    [item.type === 'standard', 'type'],
    [item.tax_category === 'saas', 'tax_category'],
    [item.status === 'active', 'status']
  ];
  if (checks.some(([matches]) => !matches)) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_CONTRACT_MISMATCH',
      'A Paddle Sandbox product did not match the approved catalog contract.',
      { phase }
    );
  }
  return item.id;
}

function assertPrice(entity, expected, productId, phase) {
  const item = assertPlainObject(entity, phase);
  const checks = [
    [PRICE_ID_PATTERN.test(item.id), 'id'],
    [item.product_id === productId, 'product_id'],
    [item.name === expected.name, 'name'],
    [item.description === expected.description, 'description'],
    [item.type === 'standard', 'type'],
    [item.status === 'active', 'status'],
    // Paddle resolves the requested account_setting value to the account's
    // effective mode. PromptGen Sandbox currently uses automatic tax
    // localization, so the persisted entity must be location.
    [item.tax_mode === EFFECTIVE_TAX_MODE, 'tax_mode'],
    [item.trial_period === null, 'trial_period'],
    [item.unit_price?.amount === expected.amount, 'unit_price.amount'],
    [item.unit_price?.currency_code === 'USD', 'unit_price.currency_code'],
    [Array.isArray(item.unit_price_overrides), 'unit_price_overrides'],
    [item.unit_price_overrides?.length === 0, 'unit_price_overrides.length'],
    [item.billing_cycle?.interval === 'month', 'billing_cycle.interval'],
    [item.billing_cycle?.frequency === 1, 'billing_cycle.frequency'],
    [item.quantity?.minimum === 1, 'quantity.minimum'],
    [item.quantity?.maximum === 1, 'quantity.maximum']
  ];
  if (checks.some(([matches]) => !matches)) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_CONTRACT_MISMATCH',
      'A Paddle Sandbox price did not match the approved catalog contract.',
      { phase }
    );
  }
  return item.id;
}

function buildListUrl(kind) {
  const url = new URL(`/${kind}`, PADDLE_SANDBOX_API_BASE);
  url.searchParams.set('status', 'active,archived');
  url.searchParams.set('per_page', '200');
  url.searchParams.set('order_by', 'id[ASC]');
  return url;
}

function assertTrustedListUrl(url, kind, { after = null } = {}) {
  if (
    !(url instanceof URL)
    || url.origin !== PADDLE_SANDBOX_API_BASE
    || url.pathname !== `/${kind}`
    || url.username
    || url.password
    || url.hash
  ) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_UNTRUSTED_PAGINATION',
      'Paddle list pagination was rejected before a request was sent.',
      { phase: `list.${kind}` }
    );
  }

  const allowed = new Set(['status', 'per_page', 'order_by', 'after']);
  if ([...new Set(url.searchParams.keys())].some((name) => !allowed.has(name))) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_UNTRUSTED_PAGINATION',
      'Paddle list pagination was rejected before a request was sent.',
      { phase: `list.${kind}` }
    );
  }
  const statuses = url.searchParams.getAll('status')
    .flatMap((value) => value.split(','))
    .sort();
  const cursors = url.searchParams.getAll('after');
  const cursorPattern = kind === 'products' ? PRODUCT_ID_PATTERN : PRICE_ID_PATTERN;
  if (
    statuses.length !== 2
    || statuses[0] !== 'active'
    || statuses[1] !== 'archived'
    || url.searchParams.getAll('per_page').length !== 1
    || url.searchParams.get('per_page') !== '200'
    || url.searchParams.getAll('order_by').length !== 1
    || url.searchParams.get('order_by') !== 'id[ASC]'
    || (after === null && cursors.length !== 0)
    || (after !== null && (
      cursors.length !== 1
      || cursors[0] !== after
      || !cursorPattern.test(cursors[0])
    ))
  ) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_UNTRUSTED_PAGINATION',
      'Paddle list pagination was rejected before a request was sent.',
      { phase: `list.${kind}` }
    );
  }
}

async function requestJson({ apiKey, fetchImpl, method, url, body, phase, timeoutMs }) {
  const target = url instanceof URL ? url : new URL(url, PADDLE_SANDBOX_API_BASE);
  if (
    target.origin !== PADDLE_SANDBOX_API_BASE
    || target.username
    || target.password
    || target.hash
  ) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_TARGET_REJECTED',
      'The Paddle Sandbox request target was rejected before a request was sent.',
      { phase }
    );
  }

  let response;
  try {
    response = await fetchImpl(target.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Paddle-Version': PADDLE_API_VERSION,
        ...(method === 'GET' ? { 'Skip-Count': 'true' } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (_) {
    throw operatorError(
      method === 'POST'
        ? 'PADDLE_SANDBOX_CATALOG_WRITE_OUTCOME_UNKNOWN'
        : 'PADDLE_SANDBOX_CATALOG_READ_FAILED',
      method === 'POST'
        ? 'A Paddle create request may have been accepted; do not retry it until the full catalog is reconciled.'
        : 'A Paddle Sandbox verification request failed before the catalog could be proven safe.',
      { phase }
    );
  }

  if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) {
    if (method === 'POST') {
      throw operatorError(
        'PADDLE_SANDBOX_CATALOG_WRITE_OUTCOME_UNKNOWN',
        'A Paddle create request returned an unreadable response; do not retry it until the full catalog is reconciled.',
        { phase }
      );
    }
    throw malformedResponse(phase);
  }
  if (response.redirected === true) {
    if (method === 'POST') {
      throw operatorError(
        'PADDLE_SANDBOX_CATALOG_WRITE_OUTCOME_UNKNOWN',
        'A Paddle create request returned a redirect; do not retry it until the full catalog is reconciled.',
        { phase }
      );
    }
    throw malformedResponse(phase);
  }

  const expectedStatus = method === 'POST' ? 201 : 200;
  if (response.status !== expectedStatus) {
    const outcomeUnknown = method === 'POST'
      && (response.status === 429 || response.status >= 500 || response.status >= 200 && response.status < 300);
    throw operatorError(
      outcomeUnknown
        ? 'PADDLE_SANDBOX_CATALOG_WRITE_OUTCOME_UNKNOWN'
        : method === 'POST'
          ? 'PADDLE_SANDBOX_CATALOG_WRITE_REJECTED'
          : 'PADDLE_SANDBOX_CATALOG_READ_HTTP_ERROR',
      outcomeUnknown
        ? 'A Paddle create request may have been accepted; do not retry it until the full catalog is reconciled.'
        : method === 'POST'
          ? 'Paddle rejected a Sandbox catalog create request; no automatic retry was attempted.'
          : 'Paddle returned a non-success status during Sandbox catalog verification.',
      { phase, httpStatus: response.status }
    );
  }

  let envelope;
  try {
    envelope = await response.json();
  } catch (_) {
    throw operatorError(
      method === 'POST'
        ? 'PADDLE_SANDBOX_CATALOG_WRITE_OUTCOME_UNKNOWN'
        : 'PADDLE_SANDBOX_CATALOG_MALFORMED_RESPONSE',
      method === 'POST'
        ? 'A Paddle create request returned an unreadable success response; do not retry it until the full catalog is reconciled.'
        : 'Paddle returned an unexpected response while the Sandbox catalog was being verified.',
      { phase }
    );
  }

  try {
    const safeEnvelope = assertPlainObject(envelope, phase);
    const meta = assertPlainObject(safeEnvelope.meta, phase);
    return {
      data: safeEnvelope.data,
      meta,
      requestId: assertRequestId(meta.request_id, phase)
    };
  } catch (error) {
    if (method === 'POST') {
      throw operatorError(
        'PADDLE_SANDBOX_CATALOG_WRITE_OUTCOME_UNKNOWN',
        'A Paddle create request returned an unverifiable success response; do not retry it until the full catalog is reconciled.',
        { phase }
      );
    }
    throw error;
  }
}

function registerRequestId(requestIds, requestId, phase) {
  if (requestIds.has(requestId)) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_REPLAYED_RESPONSE',
      'Paddle repeated a request identifier during independent verification.',
      { phase }
    );
  }
  requestIds.add(requestId);
}

async function listAll(kind, context) {
  const phase = `list.${kind}`;
  const idPattern = kind === 'products' ? PRODUCT_ID_PATTERN : PRICE_ID_PATTERN;
  const seenIds = new Set();
  const items = [];
  const url = buildListUrl(kind);
  assertTrustedListUrl(url, kind);
  const result = await requestJson({
    ...context,
    method: 'GET',
    url,
    phase,
    body: undefined
  });
  registerRequestId(context.requestIds, result.requestId, phase);
  if (!Array.isArray(result.data)) throw malformedResponse(phase);
  const pagination = assertPlainObject(result.meta.pagination, phase);
  if (pagination.per_page !== 200 || typeof pagination.has_more !== 'boolean') {
    throw malformedResponse(phase);
  }

  for (const item of result.data) {
    if (!item || typeof item !== 'object' || !idPattern.test(item.id) || seenIds.has(item.id)) {
      throw malformedResponse(phase);
    }
    seenIds.add(item.id);
    items.push(item);
  }

  if (pagination.has_more) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_PAGE_LIMIT_REACHED',
      'The Sandbox catalog exceeds the one-page bootstrap safety boundary; no next page was requested.',
      { phase }
    );
  }
  return items;
}

async function getEntity(kind, id, context, priorRequestId) {
  const phase = `verify.${kind}`;
  const result = await requestJson({
    ...context,
    method: 'GET',
    url: `/${kind}/${id}`,
    phase,
    body: undefined
  });
  if (result.requestId === priorRequestId) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_REPLAYED_RESPONSE',
      'Paddle repeated a request identifier during independent verification.',
      { phase }
    );
  }
  registerRequestId(context.requestIds, result.requestId, phase);
  return result.data;
}

function productDefinition(key) {
  return CATALOG.products.find((item) => item.key === key);
}

function priceDefinition(key) {
  return CATALOG.prices.find((item) => item.key === key);
}

async function assertInventory(context, expectedProducts, expectedPrices) {
  const [products, prices] = await Promise.all([
    listAll('products', context),
    listAll('prices', context)
  ]);

  if (products.length !== expectedProducts.length || prices.length !== expectedPrices.length) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_CONCURRENT_CHANGE',
      'The complete Paddle Sandbox catalog changed outside the approved creation sequence.',
      { phase: 'inventory' }
    );
  }

  const productsById = new Map(products.map((item) => [item.id, item]));
  const pricesById = new Map(prices.map((item) => [item.id, item]));
  for (const expected of expectedProducts) {
    const item = productsById.get(expected.id);
    if (!item) {
      throw operatorError(
        'PADDLE_SANDBOX_CATALOG_CONCURRENT_CHANGE',
        'The complete Paddle Sandbox catalog changed outside the approved creation sequence.',
        { phase: 'inventory.products' }
      );
    }
    assertProduct(item, productDefinition(expected.key), 'inventory.products');
  }
  for (const expected of expectedPrices) {
    const item = pricesById.get(expected.id);
    if (!item) {
      throw operatorError(
        'PADDLE_SANDBOX_CATALOG_CONCURRENT_CHANGE',
        'The complete Paddle Sandbox catalog changed outside the approved creation sequence.',
        { phase: 'inventory.prices' }
      );
    }
    const definition = priceDefinition(expected.key);
    const productId = expectedProducts.find(({ key }) => key === definition.productKey)?.id;
    assertPrice(item, definition, productId, 'inventory.prices');
  }

  return { products, prices };
}

async function createEntity(kind, definition, payload, context) {
  const phase = `create.${kind}.${definition.key}`;
  context.writeAttempts += 1;
  const result = await requestJson({
    ...context,
    method: 'POST',
    url: `/${kind}`,
    body: payload,
    phase
  });
  context.confirmedWrites += 1;
  registerRequestId(context.requestIds, result.requestId, phase);
  return result;
}

async function createPaddleSandboxCatalog({
  rawApiKey,
  args = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const authorization = parseAuthorization(args);
  const apiKey = normalizeStdinApiKey(rawApiKey);
  if (typeof fetchImpl !== 'function') {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_FETCH_REQUIRED',
      'A fetch implementation is required for the Paddle Sandbox catalog operator.'
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw operatorError(
      'PADDLE_SANDBOX_CATALOG_TIMEOUT_INVALID',
      'The Paddle Sandbox catalog timeout must be an integer between 1 and 30000 milliseconds.'
    );
  }

  const context = {
    apiKey,
    fetchImpl,
    timeoutMs,
    requestIds: new Set(),
    writeAttempts: 0,
    confirmedWrites: 0
  };
  const createdProducts = [];
  const createdPrices = [];
  let creationStartIndex = 0;

  if (authorization.resumeFrom === 'pro_999') {
    createdProducts.push({ key: 'pro', id: authorization.productId });
    createdPrices.push({ key: 'pro_999', id: authorization.priceId });
    creationStartIndex = CREATION_ORDER.findIndex((step) => (
      step.kind === 'price' && step.key === 'pro_999'
    )) + 1;
  }

  try {
    await assertInventory(context, createdProducts, createdPrices);

    for (const step of CREATION_ORDER.slice(creationStartIndex)) {
      await assertInventory(context, createdProducts, createdPrices);
      if (step.kind === 'product') {
        const definition = productDefinition(step.key);
        const created = await createEntity(
          'products',
          definition,
          productPayload(definition),
          context
        );
        const id = assertProduct(created.data, definition, `create.product.${step.key}`);
        const verified = await getEntity('products', id, context, created.requestId);
        assertProduct(verified, definition, `verify.product.${step.key}`);
        createdProducts.push({ key: step.key, id });
      } else {
        const definition = priceDefinition(step.key);
        const productId = createdProducts.find(({ key }) => key === definition.productKey)?.id;
        if (!productId) {
          throw operatorError(
            'PADDLE_SANDBOX_CATALOG_INTERNAL_ERROR',
            'The approved Paddle catalog creation order is invalid.',
            { phase: `create.price.${step.key}` }
          );
        }
        const created = await createEntity(
          'prices',
          definition,
          pricePayload(definition, productId),
          context
        );
        const id = assertPrice(created.data, definition, productId, `create.price.${step.key}`);
        const verified = await getEntity('prices', id, context, created.requestId);
        assertPrice(verified, definition, productId, `verify.price.${step.key}`);
        createdPrices.push({ key: step.key, id });
      }
      await assertInventory(context, createdProducts, createdPrices);
    }

    await assertInventory(context, createdProducts, createdPrices);
    await assertInventory(context, createdProducts, createdPrices);
  } catch (error) {
    if (
      context.confirmedWrites > 0
      && error?.code !== 'PADDLE_SANDBOX_CATALOG_WRITE_OUTCOME_UNKNOWN'
      && error?.code !== 'PADDLE_SANDBOX_CATALOG_WRITE_RECONCILIATION_REQUIRED'
    ) {
      throw reconciliationRequired(error?.phase || 'post-write-verification');
    }
    throw error;
  }

  return {
    success: true,
    environment: 'sandbox',
    mode: 'catalog-create',
    posts: context.writeAttempts,
    resumedFrom: authorization.resumeFrom,
    products: Object.fromEntries(createdProducts.map(({ key, id }) => [key, id])),
    prices: Object.fromEntries(createdPrices.map(({ key, id }) => [key, id]))
  };
}

async function readStdin(stream = process.stdin) {
  let value = '';
  for await (const chunk of stream) value += chunk.toString('utf8');
  return value;
}

if (require.main === module) {
  let rawApiKey = '';
  readStdin()
    .then(async (value) => {
      rawApiKey = value;
      const result = await createPaddleSandboxCatalog({
        rawApiKey,
        args: process.argv.slice(2)
      });
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(JSON.stringify({
        success: false,
        environment: 'sandbox',
        mode: 'catalog-create',
        error: publicError(error)
      }, null, 2));
      process.exitCode = 1;
    })
    .finally(() => {
      rawApiKey = '';
    });
}

module.exports = {
  APPLY_CONFIRMATION,
  CATALOG,
  CREATION_ORDER,
  EFFECTIVE_TAX_MODE,
  PADDLE_SANDBOX_API_BASE,
  PaddleSandboxCatalogError,
  assertPrice,
  assertProduct,
  createPaddleSandboxCatalog,
  normalizeStdinApiKey,
  parseAuthorization,
  pricePayload,
  productPayload,
  publicError
};
