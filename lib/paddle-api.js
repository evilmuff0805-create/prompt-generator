'use strict';

const DEFAULT_PADDLE_API_BASE = 'https://api.paddle.com';
const ALLOWED_PADDLE_API_ORIGINS = new Set([
  DEFAULT_PADDLE_API_BASE,
  'https://sandbox-api.paddle.com'
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

module.exports = {
  ALLOWED_PADDLE_API_ORIGINS,
  DEFAULT_PADDLE_API_BASE,
  getPaddleApiBase
};
