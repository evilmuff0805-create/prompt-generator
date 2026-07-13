'use strict';

const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const CLIENT_EVENTS = new Set([
  'page_viewed',
  'signup_started',
  'auth_completed',
  'analysis_started',
  'storyboard_started',
  'checkout_started',
  'checkout_completed'
]);

const SERVER_EVENTS = new Set([
  'signup_completed',
  'analysis_succeeded',
  'storyboard_enqueued',
  'storyboard_completed',
  'storyboard_failed',
  'purchase_completed'
]);

const PROPERTY_ALLOWLIST = Object.freeze({
  page_viewed: [],
  signup_started: ['surface', 'provider'],
  auth_completed: ['surface', 'provider'],
  signup_completed: ['provider'],
  analysis_started: ['surface', 'plan'],
  analysis_succeeded: ['plan', 'creditsCharged'],
  storyboard_started: ['style', 'cutCount', 'referenceCount'],
  storyboard_enqueued: ['style', 'cutCount', 'referenceCount', 'creditsUsed'],
  storyboard_completed: ['cutCount', 'attemptCount', 'durationBucket'],
  storyboard_failed: ['attemptCount', 'refunded', 'errorCode'],
  checkout_started: ['plan', 'surface'],
  checkout_completed: ['plan', 'surface'],
  purchase_completed: ['plan', 'creditsGranted', 'transactionType']
});

const ALLOWED_PAGE_PATHS = new Set([
  '/',
  '/frame',
  '/storyboard',
  '/storyboard/history',
  '/storyboard/:id',
  '/terms.html',
  '/privacy.html',
  '/refund.html'
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
let adminClient;

class ProductEventValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProductEventValidationError';
    this.code = 'INVALID_PRODUCT_EVENT';
  }
}

function getAdminClient() {
  if (!adminClient) {
    adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
  }
  return adminClient;
}

function normalizePagePath(value) {
  if (value == null || value === '') return null;

  let path = String(value).trim();
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    return null;
  }
  try {
    path = new URL(path, 'https://promptgen.invalid').pathname;
  } catch (_) {
    return null;
  }

  path = path.replace(/\/{2,}/g, '/');
  if (/^\/storyboard\/sb_[a-zA-Z0-9]+\/?$/.test(path)) {
    path = '/storyboard/:id';
  } else if (path.length > 1) {
    path = path.replace(/\/$/, '');
  }

  return ALLOWED_PAGE_PATHS.has(path) ? path : null;
}

const ENUM_PROPERTIES = Object.freeze({
  plan: new Set(['free', 'pro', 'enterprise', 'paid', 'unknown']),
  surface: new Set([
    'home',
    'endframe',
    'storyboard',
    'pricing',
    'paddle_overlay',
    'home_generator'
  ]),
  provider: new Set(['google', 'supabase_auth']),
  style: new Set(['Pixar 3D', 'Cinematic', 'Documentary', 'Animation']),
  durationBucket: new Set(['<30s', '30-60s', '60-120s', '120-300s', '300s+']),
  transactionType: new Set(['subscription_payment'])
});

const INTEGER_LIMITS = Object.freeze({
  creditsCharged: [0, 10000],
  cutCount: [1, 20],
  referenceCount: [0, 10],
  creditsUsed: [0, 10000],
  attemptCount: [0, 20],
  creditsGranted: [0, 100000]
});

function sanitizeScalar(value, key) {
  if (key === 'isTest' || key === 'refunded') {
    if (typeof value !== 'boolean') {
      throw new ProductEventValidationError(`${key} must be boolean`);
    }
    return value;
  }

  if (Object.prototype.hasOwnProperty.call(ENUM_PROPERTIES, key)) {
    if (typeof value !== 'string' || !ENUM_PROPERTIES[key].has(value)) {
      throw new ProductEventValidationError(`property value is not allowed: ${key}`);
    }
    return value;
  }

  if (Object.prototype.hasOwnProperty.call(INTEGER_LIMITS, key)) {
    const [minimum, maximum] = INTEGER_LIMITS[key];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new ProductEventValidationError(`invalid numeric property: ${key}`);
    }
    return value;
  }

  if (key === 'errorCode') {
    if (typeof value !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(value)) {
      throw new ProductEventValidationError('invalid errorCode');
    }
    return value;
  }

  throw new ProductEventValidationError(`property has no value validator: ${key}`);
}

function sanitizeProperties(eventName, properties) {
  if (properties == null) return {};
  if (typeof properties !== 'object' || Array.isArray(properties)) {
    throw new ProductEventValidationError('properties must be an object');
  }

  const allowed = new Set([...(PROPERTY_ALLOWLIST[eventName] || []), 'isTest']);
  const output = {};

  for (const [key, value] of Object.entries(properties)) {
    if (!SAFE_KEY_RE.test(key) || !allowed.has(key)) {
      throw new ProductEventValidationError(`property is not allowed: ${key}`);
    }
    output[key] = sanitizeScalar(value, key);
  }

  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 2048) {
    throw new ProductEventValidationError('properties payload is too large');
  }
  return output;
}

function validateProductEvent(input = {}) {
  const source = input.source === 'server' ? 'server' : 'client';
  const allowedEvents = source === 'server' ? SERVER_EVENTS : CLIENT_EVENTS;
  const eventName = String(input.eventName || '');

  if (!allowedEvents.has(eventName)) {
    throw new ProductEventValidationError('event name is not allowed for this source');
  }

  const eventId = input.eventId || (source === 'server' ? randomUUID() : null);
  if (!eventId || !UUID_RE.test(String(eventId))) {
    throw new ProductEventValidationError('eventId must be a UUID');
  }

  const sessionId = input.sessionId == null ? null : String(input.sessionId);
  if (source === 'client' && (!sessionId || !UUID_RE.test(sessionId))) {
    throw new ProductEventValidationError('client events require a UUID sessionId');
  }
  if (sessionId && !UUID_RE.test(sessionId)) {
    throw new ProductEventValidationError('sessionId must be a UUID');
  }

  const userId = input.userId == null ? null : String(input.userId);
  if (source === 'server' && (!userId || !UUID_RE.test(userId))) {
    throw new ProductEventValidationError('server events require a UUID userId');
  }
  if (userId && !UUID_RE.test(userId)) {
    throw new ProductEventValidationError('userId must be a UUID');
  }

  const suppliedPagePath = input.pagePath != null && input.pagePath !== '';
  const pagePath = normalizePagePath(input.pagePath);
  if (suppliedPagePath && !pagePath) {
    throw new ProductEventValidationError('pagePath is not allowed');
  }
  if (eventName === 'page_viewed' && !pagePath) {
    throw new ProductEventValidationError('page_viewed requires pagePath');
  }

  return {
    event_id: String(eventId).toLowerCase(),
    event_name: eventName,
    source,
    user_id: userId,
    session_id: sessionId ? sessionId.toLowerCase() : null,
    page_path: pagePath,
    properties: sanitizeProperties(eventName, input.properties)
  };
}

async function recordProductEvent(input, options = {}) {
  let payload;
  try {
    payload = validateProductEvent(input);
  } catch (error) {
    if (options.throwOnError) throw error;
    logger.warn('analytics.event.rejected', {
      eventName: input?.eventName,
      source: input?.source,
      reason: error.message
    });
    return { persisted: false, duplicate: false, rejected: true };
  }

  try {
    const client = options.client || getAdminClient();
    const { error } = await client.from('product_events').insert(payload);

    if (error?.code === '23505') {
      return { persisted: true, duplicate: true, eventId: payload.event_id };
    }
    if (error) throw error;

    return { persisted: true, duplicate: false, eventId: payload.event_id };
  } catch (error) {
    logger.warn('analytics.event.persistence_failed', {
      eventName: payload.event_name,
      source: payload.source,
      error
    });
    if (options.throwOnError) throw error;
    return { persisted: false, duplicate: false, rejected: false };
  }
}

function recordServerEvent(input, options = {}) {
  return recordProductEvent({ ...input, source: 'server' }, options);
}

function _setAdminClientForTests(client) {
  adminClient = client;
}

module.exports = {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  PROPERTY_ALLOWLIST,
  ProductEventValidationError,
  normalizePagePath,
  sanitizeProperties,
  validateProductEvent,
  recordProductEvent,
  recordServerEvent,
  _setAdminClientForTests
};
