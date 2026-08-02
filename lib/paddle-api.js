'use strict';

const DEFAULT_PADDLE_API_BASE = 'https://api.paddle.com';
const PADDLE_SANDBOX_API_BASE = 'https://sandbox-api.paddle.com';
const PADDLE_ENVIRONMENTS = Object.freeze({
  production: 'production',
  sandbox: 'sandbox'
});
const MODERN_PADDLE_API_KEY_PATTERN =
  /^pdl_(?:live|sdbx)_apikey_[a-z\d]{26}_[A-Za-z\d]{22}_[A-Za-z\d]{3}$/;
const ALLOWED_PADDLE_API_ORIGINS = new Set([
  DEFAULT_PADDLE_API_BASE,
  PADDLE_SANDBOX_API_BASE
]);
const TEST_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function invalidPaddleApiBase() {
  const error = new Error(
    '[environment] PADDLE_API_BASE must be the exact Paddle production or sandbox HTTPS origin'
  );
  error.code = 'INVALID_PADDLE_API_BASE';
  return error;
}

function getPaddleApiBase(env = process.env) {
  const configured = typeof env.PADDLE_API_BASE === 'string'
    ? env.PADDLE_API_BASE.trim()
    : '';
  const raw = configured || DEFAULT_PADDLE_API_BASE;

  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw invalidPaddleApiBase();
  }

  const isOriginOnly = !url.username
    && !url.password
    && url.pathname === '/'
    && !url.search
    && !url.hash;
  const isOfficialOrigin = ALLOWED_PADDLE_API_ORIGINS.has(url.origin);
  const isTestEnvironment =
    String(env.NODE_ENV || '').trim().toLowerCase() === 'test';
  const isTestLoopback = isTestEnvironment
    && url.protocol === 'http:'
    && TEST_LOOPBACK_HOSTS.has(url.hostname);
  const isTestDomain = isTestEnvironment
    && url.protocol === 'https:'
    && url.hostname.endsWith('.test');

  if (
    !isOriginOnly
    || (!isOfficialOrigin && !isTestLoopback && !isTestDomain)
  ) {
    throw invalidPaddleApiBase();
  }

  return url.origin;
}

function getPaddleEnvironment(env = process.env) {
  const apiBase = getPaddleApiBase(env);
  if (apiBase === DEFAULT_PADDLE_API_BASE) {
    return PADDLE_ENVIRONMENTS.production;
  }
  if (apiBase === PADDLE_SANDBOX_API_BASE) {
    return PADDLE_ENVIRONMENTS.sandbox;
  }

  // Non-Paddle origins are accepted only by getPaddleApiBase's NODE_ENV=test
  // fixture boundary. Keep those fixtures on Sandbox semantics so a local test
  // server can never initialize Paddle.js as production by accident.
  return PADDLE_ENVIRONMENTS.sandbox;
}

function normalizeCredential(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getPaddleApiKeyEnvironment(apiKey) {
  const normalized = normalizeCredential(apiKey);
  if (normalized.startsWith('pdl_live_apikey_')) {
    return PADDLE_ENVIRONMENTS.production;
  }
  if (normalized.startsWith('pdl_sdbx_apikey_')) {
    return PADDLE_ENVIRONMENTS.sandbox;
  }
  return null;
}

function isModernPaddleApiKey(apiKey) {
  return MODERN_PADDLE_API_KEY_PATTERN.test(normalizeCredential(apiKey));
}

function getPaddleApiKeyWarnings(env = process.env) {
  const apiKey = normalizeCredential(env.PADDLE_API_KEY);
  if (!apiKey || isModernPaddleApiKey(apiKey)) return [];

  return [Object.freeze({
    code: 'PADDLE_API_KEY_LEGACY_OR_UNRECOGNIZED',
    variable: 'PADDLE_API_KEY',
    message:
      'PADDLE_API_KEY uses a legacy or unrecognized format; activated payment features require a modern environment-specific key.'
  })];
}

function getPaddleClientTokenEnvironment(clientToken) {
  const normalized = normalizeCredential(clientToken);
  if (normalized.startsWith('live_')) {
    return PADDLE_ENVIRONMENTS.production;
  }
  if (normalized.startsWith('test_')) {
    return PADDLE_ENVIRONMENTS.sandbox;
  }
  return null;
}

function paddleCredentialError(code, message) {
  const error = new Error(`[environment] ${message}`);
  error.code = code;
  return error;
}

function validatePaddleEnvironmentCredentials(
  env = process.env,
  { requireModernApiKey = false } = {}
) {
  const environment = getPaddleEnvironment(env);
  const clientToken = normalizeCredential(env.PADDLE_CLIENT_TOKEN);
  const apiKey = normalizeCredential(env.PADDLE_API_KEY);

  if (environment === PADDLE_ENVIRONMENTS.sandbox && !clientToken) {
    throw paddleCredentialError(
      'PADDLE_SANDBOX_CLIENT_TOKEN_REQUIRED',
      'PADDLE_CLIENT_TOKEN must be explicitly configured for Paddle Sandbox'
    );
  }

  if (clientToken) {
    const tokenEnvironment = getPaddleClientTokenEnvironment(clientToken);
    if (!tokenEnvironment) {
      throw paddleCredentialError(
        'INVALID_PADDLE_CLIENT_TOKEN',
        'PADDLE_CLIENT_TOKEN must use the live_ or test_ environment prefix'
      );
    }
    if (tokenEnvironment !== environment) {
      throw paddleCredentialError(
        'PADDLE_CLIENT_TOKEN_ENVIRONMENT_MISMATCH',
        'PADDLE_CLIENT_TOKEN does not match PADDLE_API_BASE'
      );
    }
  }

  // Modern Paddle API keys encode their environment. Preserve compatibility
  // with legacy/test placeholders whose environment cannot be inferred, while
  // rejecting every mismatch that can be proven from the supported prefixes.
  const apiKeyEnvironment = getPaddleApiKeyEnvironment(apiKey);
  if (apiKeyEnvironment && apiKeyEnvironment !== environment) {
    throw paddleCredentialError(
      'PADDLE_API_KEY_ENVIRONMENT_MISMATCH',
      'PADDLE_API_KEY does not match PADDLE_API_BASE'
    );
  }
  if (requireModernApiKey && apiKey && !isModernPaddleApiKey(apiKey)) {
    throw paddleCredentialError(
      'PADDLE_MODERN_API_KEY_REQUIRED',
      'PADDLE_API_KEY must use the current environment-specific Paddle API key format before this payment feature can be enabled'
    );
  }

  return environment;
}

module.exports = {
  ALLOWED_PADDLE_API_ORIGINS,
  DEFAULT_PADDLE_API_BASE,
  PADDLE_ENVIRONMENTS,
  PADDLE_SANDBOX_API_BASE,
  MODERN_PADDLE_API_KEY_PATTERN,
  getPaddleApiBase,
  getPaddleApiKeyEnvironment,
  getPaddleApiKeyWarnings,
  getPaddleClientTokenEnvironment,
  getPaddleEnvironment,
  isModernPaddleApiKey,
  validatePaddleEnvironmentCredentials
};
