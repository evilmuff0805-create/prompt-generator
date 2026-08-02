'use strict';

require('dotenv').config();

const {
  MODERN_PADDLE_API_KEY_PATTERN,
  PADDLE_ENVIRONMENTS,
  getPaddleApiKeyEnvironment
} = require('../lib/paddle-api');

const PADDLE_SANDBOX_API_BASE = 'https://sandbox-api.paddle.com';
const PADDLE_API_VERSION = '1';
const DEFAULT_MAX_PAGES = 250;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_ALLOWED_PAGES = 1_000;
const MAX_ALLOWED_TIMEOUT_MS = 30_000;
const RFC_3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const ENDPOINTS = Object.freeze([
  Object.freeze({
    key: 'products',
    path: '/products',
    requiredScope: 'product.read',
    perPage: 200,
    idPattern: /^pro_[a-z\d]{26}$/,
    fixedQuery: Object.freeze({ status: 'active,archived' }),
    summaryKind: 'products'
  }),
  Object.freeze({
    key: 'prices',
    path: '/prices',
    requiredScope: 'price.read',
    perPage: 200,
    idPattern: /^pri_[a-z\d]{26}$/,
    fixedQuery: Object.freeze({ status: 'active,archived' }),
    summaryKind: 'prices'
  }),
  Object.freeze({
    key: 'transactions',
    path: '/transactions',
    requiredScope: 'transaction.read',
    perPage: 30,
    idPattern: /^txn_[a-z\d]{26}$/,
    allowedStatuses: Object.freeze([
      'draft', 'ready', 'billed', 'paid', 'completed', 'canceled', 'past_due'
    ]),
    fixedQuery: Object.freeze({}),
    summaryKind: 'transactions'
  }),
  Object.freeze({
    key: 'subscriptions',
    path: '/subscriptions',
    requiredScope: 'subscription.read',
    perPage: 200,
    idPattern: /^sub_[a-z\d]{26}$/,
    allowedStatuses: Object.freeze(['active', 'canceled', 'past_due', 'paused', 'trialing']),
    fixedQuery: Object.freeze({}),
    summaryKind: 'subscriptions'
  }),
  Object.freeze({
    key: 'notificationSettings',
    path: '/notification-settings',
    requiredScope: 'notification_setting.read',
    perPage: 200,
    idPattern: /^ntfset_[a-z\d]{26}$/,
    fixedQuery: Object.freeze({}),
    summaryKind: 'notificationSettings'
  }),
  Object.freeze({
    key: 'notifications',
    path: '/notifications',
    requiredScope: 'notification.read',
    perPage: 200,
    idPattern: /^ntf_[a-z\d]{26}$/,
    allowedStatuses: Object.freeze(['delivered', 'failed', 'needs_retry', 'not_attempted']),
    fixedQuery: Object.freeze({}),
    summaryKind: 'notifications'
  })
]);

class PaddleSandboxAuditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PaddleSandboxAuditError';
    this.code = code;
    this.endpoint = details.endpoint || null;
    this.requiredScope = details.requiredScope || null;
    this.httpStatus = Number.isInteger(details.httpStatus) ? details.httpStatus : null;
  }
}

function configurationError(code, message) {
  return new PaddleSandboxAuditError(code, message);
}

function endpointError(definition, code, message, details = {}) {
  return new PaddleSandboxAuditError(code, message, {
    endpoint: definition.key,
    requiredScope: definition.requiredScope,
    ...details
  });
}

function readSandboxAuditConfig(env = process.env) {
  if (env.PADDLE_SANDBOX_AUDIT_CONFIRMED !== 'true') {
    throw configurationError(
      'PADDLE_SANDBOX_AUDIT_NOT_CONFIRMED',
      'PADDLE_SANDBOX_AUDIT_CONFIRMED must be explicitly set to true.'
    );
  }

  if (env.PADDLE_API_BASE !== PADDLE_SANDBOX_API_BASE) {
    throw configurationError(
      'PADDLE_SANDBOX_AUDIT_BASE_REJECTED',
      'PADDLE_API_BASE must exactly match the Paddle Sandbox API base.'
    );
  }

  const rawApiKey = typeof env.PADDLE_API_KEY === 'string' ? env.PADDLE_API_KEY : '';
  const apiKey = rawApiKey.trim();
  if (
    rawApiKey !== apiKey
    || !MODERN_PADDLE_API_KEY_PATTERN.test(apiKey)
    || getPaddleApiKeyEnvironment(apiKey) !== PADDLE_ENVIRONMENTS.sandbox
  ) {
    throw configurationError(
      'PADDLE_SANDBOX_AUDIT_KEY_REJECTED',
      'PADDLE_API_KEY must be a modern Paddle Sandbox API key.'
    );
  }

  return Object.freeze({ apiBase: PADDLE_SANDBOX_API_BASE, apiKey });
}

function validateRuntimeLimits({ maxPages, timeoutMs }) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_ALLOWED_PAGES) {
    throw configurationError(
      'PADDLE_SANDBOX_AUDIT_MAX_PAGES_INVALID',
      `maxPages must be an integer between 1 and ${MAX_ALLOWED_PAGES}.`
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_ALLOWED_TIMEOUT_MS) {
    throw configurationError(
      'PADDLE_SANDBOX_AUDIT_TIMEOUT_INVALID',
      `timeoutMs must be an integer between 1 and ${MAX_ALLOWED_TIMEOUT_MS}.`
    );
  }
}

function buildInitialUrl(definition) {
  const url = new URL(definition.path, PADDLE_SANDBOX_API_BASE);
  url.searchParams.set('per_page', String(definition.perPage));
  url.searchParams.set('order_by', 'id[ASC]');
  for (const [name, value] of Object.entries(definition.fixedQuery)) {
    url.searchParams.set(name, String(value));
  }
  return url;
}

function expectedQuery(definition) {
  return {
    per_page: String(definition.perPage),
    order_by: 'id[ASC]',
    ...definition.fixedQuery
  };
}

function assertTrustedPageUrl(url, definition, { requireCursor = false, lastEntityId = null } = {}) {
  if (!(url instanceof URL) ||
      url.origin !== PADDLE_SANDBOX_API_BASE ||
      url.pathname !== definition.path ||
      url.username ||
      url.password ||
      url.hash) {
    throw endpointError(
      definition,
      'PADDLE_SANDBOX_AUDIT_UNTRUSTED_PAGINATION',
      `Paddle ${definition.key} pagination was rejected before a request was sent.`
    );
  }

  const fixed = expectedQuery(definition);
  const allowedNames = new Set([...Object.keys(fixed), 'after']);
  for (const name of new Set(url.searchParams.keys())) {
    const valueCount = url.searchParams.getAll(name).length;
    if (!allowedNames.has(name) || (name === 'after' && valueCount !== 1)) {
      throw endpointError(
        definition,
        'PADDLE_SANDBOX_AUDIT_UNTRUSTED_PAGINATION',
        `Paddle ${definition.key} pagination was rejected before a request was sent.`
      );
    }
  }
  for (const [name, value] of Object.entries(fixed)) {
    const expectedValues = (Array.isArray(value) ? value : [value])
      .flatMap((item) => String(item).split(','))
      .sort();
    const actualValues = url.searchParams.getAll(name)
      .flatMap((item) => item.split(','))
      .sort();
    if (
      actualValues.length !== expectedValues.length
      || actualValues.some((actual, index) => actual !== expectedValues[index])
    ) {
      throw endpointError(
        definition,
        'PADDLE_SANDBOX_AUDIT_UNTRUSTED_PAGINATION',
        `Paddle ${definition.key} pagination was rejected before a request was sent.`
      );
    }
  }

  const cursors = url.searchParams.getAll('after');
  const cursor = cursors.length === 1 ? cursors[0] : null;
  const mustMatchLastEntity = requireCursor || Boolean(lastEntityId);
  if (mustMatchLastEntity && (!cursor || !definition.idPattern.test(cursor) || cursor !== lastEntityId)) {
    throw endpointError(
      definition,
      'PADDLE_SANDBOX_AUDIT_UNTRUSTED_PAGINATION',
      `Paddle ${definition.key} pagination was rejected before a request was sent.`
    );
  }
  if (!requireCursor && cursor && !definition.idPattern.test(cursor)) {
    throw endpointError(
      definition,
      'PADDLE_SANDBOX_AUDIT_UNTRUSTED_PAGINATION',
      `Paddle ${definition.key} pagination was rejected before a request was sent.`
    );
  }
  return cursor;
}

function malformedResponse(definition) {
  return endpointError(
    definition,
    'PADDLE_SANDBOX_AUDIT_MALFORMED_RESPONSE',
    `Paddle ${definition.key} did not return the expected read-only list schema.`
  );
}

function assertObject(value, definition) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw malformedResponse(definition);
  }
  return value;
}

function readString(value, definition, {
  nullable = false,
  pattern = null,
  nonEmpty = false,
  maxLength = null
} = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' ||
      (nonEmpty && value.length === 0) ||
      (maxLength != null && value.length > maxLength) ||
      (pattern && !pattern.test(value))) {
    throw malformedResponse(definition);
  }
  return value;
}

function readTimestamp(value, definition, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const timestamp = readString(value, definition, { pattern: RFC_3339_PATTERN });
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw malformedResponse(definition);
  return new Date(milliseconds).toISOString();
}

function maxTimestamp(current, candidate) {
  if (!candidate) return current;
  if (!current || Date.parse(candidate) > Date.parse(current)) return candidate;
  return current;
}

function sortedCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function addStatus(counts, status, definition) {
  const safeStatus = readString(status, definition, { nonEmpty: true, maxLength: 64 });
  if (!definition.allowedStatuses?.includes(safeStatus)) {
    throw malformedResponse(definition);
  }
  counts[safeStatus] = (counts[safeStatus] || 0) + 1;
}

function projectProduct(entity, definition) {
  const item = assertObject(entity, definition);
  return {
    id: readString(item.id, definition, { pattern: definition.idPattern }),
    name: readString(item.name, definition, { nonEmpty: true, maxLength: 200 }),
    description: readString(item.description, definition, { nullable: true }),
    status: readString(item.status, definition, { pattern: /^(?:active|archived)$/ }),
    type: readString(item.type, definition, { pattern: /^(?:standard|custom)$/ }),
    taxCategory: readString(item.tax_category, definition, { nonEmpty: true, maxLength: 100 }),
    createdAt: readTimestamp(item.created_at, definition),
    updatedAt: readTimestamp(item.updated_at, definition)
  };
}

function projectPrice(entity, definition) {
  const item = assertObject(entity, definition);
  const unitPrice = assertObject(item.unit_price, definition);
  const amount = readString(unitPrice.amount, definition, { pattern: /^\d+$/ });
  const currencyCode = readString(unitPrice.currency_code, definition, { pattern: /^[A-Z]{3}$/ });
  let billingCycle = null;
  if (item.billing_cycle !== null) {
    const cycle = assertObject(item.billing_cycle, definition);
    if (!Number.isInteger(cycle.frequency) || cycle.frequency < 1) {
      throw malformedResponse(definition);
    }
    billingCycle = {
      interval: readString(cycle.interval, definition, {
        pattern: /^(?:day|week|month|year)$/
      }),
      frequency: cycle.frequency
    };
  }

  return {
    id: readString(item.id, definition, { pattern: definition.idPattern }),
    productId: readString(item.product_id, definition, { pattern: /^pro_[a-z\d]{26}$/ }),
    name: readString(item.name, definition, { nullable: true, nonEmpty: true, maxLength: 150 }),
    description: readString(item.description, definition, { nonEmpty: true, maxLength: 500 }),
    status: readString(item.status, definition, { pattern: /^(?:active|archived)$/ }),
    type: readString(item.type, definition, { pattern: /^(?:standard|custom)$/ }),
    taxMode: readString(item.tax_mode, definition, {
      pattern: /^(?:account_setting|external|internal|location)$/
    }),
    unitPrice: { amount, currencyCode },
    billingCycle,
    createdAt: readTimestamp(item.created_at, definition),
    updatedAt: readTimestamp(item.updated_at, definition)
  };
}

function createCatalogAccumulator(definition, projector) {
  const inventory = [];
  return {
    consume(entity) {
      inventory.push(projector(entity, definition));
    },
    result() {
      inventory.sort((left, right) => left.id.localeCompare(right.id));
      return { total: inventory.length, inventory };
    }
  };
}

function createStatusAccumulator(definition, timestampFields) {
  let total = 0;
  const byStatus = {};
  const latestAt = Object.fromEntries(timestampFields.map(({ output }) => [output, null]));

  return {
    consume(entity) {
      const item = assertObject(entity, definition);
      readString(item.id, definition, { pattern: definition.idPattern });
      addStatus(byStatus, item.status, definition);
      for (const { input, output, nullable = false } of timestampFields) {
        const timestamp = readTimestamp(item[input], definition, { nullable });
        latestAt[output] = maxTimestamp(latestAt[output], timestamp);
      }
      total += 1;
    },
    result() {
      return { total, byStatus: sortedCounts(byStatus), latestAt };
    }
  };
}

function createNotificationSettingsAccumulator(definition) {
  let total = 0;
  const byStatus = { active: 0, inactive: 0 };
  return {
    consume(entity) {
      const item = assertObject(entity, definition);
      readString(item.id, definition, { pattern: definition.idPattern });
      if (typeof item.active !== 'boolean') throw malformedResponse(definition);
      byStatus[item.active ? 'active' : 'inactive'] += 1;
      total += 1;
    },
    result() {
      return {
        total,
        byStatus,
        latestAt: { createdAt: null, updatedAt: null }
      };
    }
  };
}

function createAccumulator(definition) {
  switch (definition.summaryKind) {
    case 'products':
      return createCatalogAccumulator(definition, projectProduct);
    case 'prices':
      return createCatalogAccumulator(definition, projectPrice);
    case 'transactions':
      return createStatusAccumulator(definition, [
        { input: 'created_at', output: 'createdAt' },
        { input: 'updated_at', output: 'updatedAt' },
        { input: 'billed_at', output: 'billedAt', nullable: true }
      ]);
    case 'subscriptions':
      return createStatusAccumulator(definition, [
        { input: 'created_at', output: 'createdAt' },
        { input: 'updated_at', output: 'updatedAt' }
      ]);
    case 'notificationSettings':
      return createNotificationSettingsAccumulator(definition);
    case 'notifications':
      return createStatusAccumulator(definition, [
        { input: 'occurred_at', output: 'occurredAt' },
        { input: 'delivered_at', output: 'deliveredAt', nullable: true },
        { input: 'last_attempt_at', output: 'lastAttemptAt', nullable: true }
      ]);
    default:
      throw configurationError(
        'PADDLE_SANDBOX_AUDIT_INTERNAL_ERROR',
        'The Paddle Sandbox audit endpoint configuration is invalid.'
      );
  }
}

function publicError(error, definition = null) {
  const safe = error instanceof PaddleSandboxAuditError
    ? error
    : endpointError(
      definition || { key: 'unknown', requiredScope: 'unknown' },
      'PADDLE_SANDBOX_AUDIT_INTERNAL_ERROR',
      'The Paddle Sandbox audit stopped because of an internal error.'
    );
  return {
    code: safe.code,
    message: safe.message,
    ...(safe.httpStatus == null ? {} : { httpStatus: safe.httpStatus })
  };
}

async function fetchPage(url, definition, config, fetchImpl, timeoutMs) {
  assertTrustedPageUrl(url, definition);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        'Paddle-Version': PADDLE_API_VERSION,
        'Skip-Count': 'true'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    throw endpointError(
      definition,
      timedOut ? 'PADDLE_SANDBOX_AUDIT_TIMEOUT' : 'PADDLE_SANDBOX_AUDIT_REQUEST_FAILED',
      timedOut
        ? `Paddle ${definition.key} audit timed out.`
        : `Paddle ${definition.key} audit request failed.`
    );
  }

  if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) {
    throw malformedResponse(definition);
  }
  if (response.redirected === true) {
    throw endpointError(
      definition,
      'PADDLE_SANDBOX_AUDIT_REDIRECT_REJECTED',
      `Paddle ${definition.key} returned a redirect that was rejected.`
    );
  }
  if (!response.ok) {
    const code = response.status === 403
      ? 'PADDLE_SANDBOX_AUDIT_PERMISSION_DENIED'
      : response.status === 401
        ? 'PADDLE_SANDBOX_AUDIT_AUTHENTICATION_FAILED'
        : 'PADDLE_SANDBOX_AUDIT_HTTP_ERROR';
    throw endpointError(
      definition,
      code,
      response.status === 403
        ? `Paddle ${definition.key} requires the ${definition.requiredScope} scope.`
        : `Paddle ${definition.key} returned a non-success status.`,
      { httpStatus: response.status }
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (_) {
    throw malformedResponse(definition);
  }
  return assertObject(body, definition);
}

function validatePageEnvelope(body, definition, seenRequestIds) {
  if (!Array.isArray(body.data)) throw malformedResponse(definition);
  const meta = assertObject(body.meta, definition);
  const requestId = readString(meta.request_id, definition, { nonEmpty: true, maxLength: 200 });
  if (seenRequestIds.has(requestId)) {
    throw endpointError(
      definition,
      'PADDLE_SANDBOX_AUDIT_PAGINATION_LOOP',
      `Paddle ${definition.key} pagination repeated a response.`
    );
  }
  seenRequestIds.add(requestId);

  const pagination = assertObject(meta.pagination, definition);
  if (pagination.per_page !== definition.perPage || typeof pagination.has_more !== 'boolean') {
    throw malformedResponse(definition);
  }
  const next = pagination.next === null
    ? null
    : readString(pagination.next, definition, { nonEmpty: true });
  if (next === null && (pagination.has_more || body.data.length > 0)) {
    throw malformedResponse(definition);
  }
  return { data: body.data, hasMore: pagination.has_more, next };
}

async function auditEndpoint(definition, config, {
  fetchImpl,
  maxPages,
  timeoutMs
}) {
  const accumulator = createAccumulator(definition);
  const seenEntityIds = new Set();
  const seenRequestIds = new Set();
  const seenPageUrls = new Set();
  const seenCursors = new Set();
  let url = buildInitialUrl(definition);

  for (let page = 1; page <= maxPages; page += 1) {
    const pageKey = url.toString();
    if (seenPageUrls.has(pageKey)) {
      throw endpointError(
        definition,
        'PADDLE_SANDBOX_AUDIT_PAGINATION_LOOP',
        `Paddle ${definition.key} pagination repeated a page.`
      );
    }
    seenPageUrls.add(pageKey);

    const body = await fetchPage(url, definition, config, fetchImpl, timeoutMs);
    const envelope = validatePageEnvelope(body, definition, seenRequestIds);
    let lastEntityId = null;

    for (const entity of envelope.data) {
      const item = assertObject(entity, definition);
      const entityId = readString(item.id, definition, { pattern: definition.idPattern });
      if (seenEntityIds.has(entityId)) {
        throw endpointError(
          definition,
          'PADDLE_SANDBOX_AUDIT_DUPLICATE_ENTITY',
          `Paddle ${definition.key} pagination repeated an entity.`
        );
      }
      seenEntityIds.add(entityId);
      lastEntityId = entityId;
      accumulator.consume(item);
    }

    if (!envelope.hasMore) {
      return {
        status: 'ok',
        requiredScope: definition.requiredScope,
        pages: page,
        ...accumulator.result()
      };
    }

    let nextUrl;
    try {
      nextUrl = new URL(envelope.next);
    } catch (_) {
      throw malformedResponse(definition);
    }
    const cursor = assertTrustedPageUrl(nextUrl, definition, {
      requireCursor: envelope.hasMore,
      lastEntityId
    });

    if (envelope.data.length === 0 || page === maxPages) {
      throw endpointError(
        definition,
        'PADDLE_SANDBOX_AUDIT_PAGE_LIMIT_REACHED',
        `Paddle ${definition.key} pagination could not be completed within the page limit.`
      );
    }
    if (!cursor || seenCursors.has(cursor)) {
      throw endpointError(
        definition,
        'PADDLE_SANDBOX_AUDIT_PAGINATION_LOOP',
        `Paddle ${definition.key} pagination repeated a cursor.`
      );
    }
    seenCursors.add(cursor);
    url = nextUrl;
  }

  throw endpointError(
    definition,
    'PADDLE_SANDBOX_AUDIT_PAGE_LIMIT_REACHED',
    `Paddle ${definition.key} pagination could not be completed within the page limit.`
  );
}

async function auditPaddleSandbox({
  env = process.env,
  fetchImpl = fetch,
  maxPages = DEFAULT_MAX_PAGES,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const config = readSandboxAuditConfig(env);
  validateRuntimeLimits({ maxPages, timeoutMs });
  if (typeof fetchImpl !== 'function') {
    throw configurationError(
      'PADDLE_SANDBOX_AUDIT_FETCH_INVALID',
      'A fetch implementation is required for the Paddle Sandbox audit.'
    );
  }

  const endpoints = {};
  const unavailableEndpoints = [];
  for (const definition of ENDPOINTS) {
    try {
      endpoints[definition.key] = await auditEndpoint(definition, config, {
        fetchImpl,
        maxPages,
        timeoutMs
      });
    } catch (error) {
      const safeError = publicError(error, definition);
      endpoints[definition.key] = {
        status: 'unavailable',
        requiredScope: definition.requiredScope,
        error: safeError
      };
      unavailableEndpoints.push({
        endpoint: definition.key,
        requiredScope: definition.requiredScope,
        error: safeError
      });
    }
  }

  const complete = unavailableEndpoints.length === 0;
  return {
    success: complete,
    complete,
    mode: 'read-only',
    environment: 'sandbox',
    requiredScopes: ENDPOINTS.map(({ key, requiredScope }) => ({ endpoint: key, requiredScope })),
    endpoints,
    unavailableEndpoints
  };
}

if (require.main === module) {
  auditPaddleSandbox()
    .then((report) => {
      const output = JSON.stringify(report, null, 2);
      if (report.success) {
        console.log(output);
      } else {
        console.error(output);
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(JSON.stringify({
        success: false,
        complete: false,
        mode: 'read-only',
        environment: 'not-authorized',
        error: publicError(error)
      }, null, 2));
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_MAX_PAGES,
  DEFAULT_TIMEOUT_MS,
  ENDPOINTS,
  PADDLE_SANDBOX_API_BASE,
  PaddleSandboxAuditError,
  assertTrustedPageUrl,
  auditPaddleSandbox,
  buildInitialUrl,
  publicError,
  readSandboxAuditConfig
};
