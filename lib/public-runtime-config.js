'use strict';

const HOSTED_SUPABASE_PATTERN = /^[a-z0-9]{20}\.supabase\.co$/;
const TEST_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9._-]{16,}$/;
const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

function invalidPublicRuntimeConfig() {
  const error = new Error(
    '[runtime-config] Invalid public Supabase runtime configuration'
  );
  error.code = 'INVALID_PUBLIC_RUNTIME_CONFIG';
  return error;
}

function decodeLegacyPublicKey(value) {
  const parts = value.split('.');
  if (
    parts.length !== 3
    || parts.some((part) => !part || !JWT_SEGMENT_PATTERN.test(part))
  ) {
    throw invalidPublicRuntimeConfig();
  }

  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (
      !header
      || header.alg !== 'HS256'
      || !payload
      || payload.iss !== 'supabase'
      || payload.role !== 'anon'
    ) {
      throw invalidPublicRuntimeConfig();
    }
    return payload;
  } catch (error) {
    if (error?.code === 'INVALID_PUBLIC_RUNTIME_CONFIG') throw error;
    throw invalidPublicRuntimeConfig();
  }
}

function validatePublicSupabaseKey(value, projectRef) {
  if (PUBLISHABLE_KEY_PATTERN.test(value)) return;

  const payload = decodeLegacyPublicKey(value);
  if (projectRef && payload.ref !== projectRef) {
    throw invalidPublicRuntimeConfig();
  }
}

function getPublicRuntimeConfig(env = process.env) {
  const rawUrl = typeof env.SUPABASE_URL === 'string' ? env.SUPABASE_URL : '';
  const rawAnonKey = typeof env.SUPABASE_ANON_KEY === 'string'
    ? env.SUPABASE_ANON_KEY
    : '';
  if (
    !rawUrl
    || rawUrl !== rawUrl.trim()
    || !rawAnonKey
    || rawAnonKey !== rawAnonKey.trim()
    || rawAnonKey.length > 4096
  ) {
    throw invalidPublicRuntimeConfig();
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    throw invalidPublicRuntimeConfig();
  }

  const isOriginOnly = !url.username
    && !url.password
    && url.pathname === '/'
    && !url.search
    && !url.hash;
  const isHostedProject = url.protocol === 'https:'
    && !url.port
    && HOSTED_SUPABASE_PATTERN.test(url.hostname);
  const isTestLoopback = String(env.NODE_ENV || '').trim().toLowerCase() === 'test'
    && url.protocol === 'http:'
    && TEST_LOOPBACK_HOSTS.has(url.hostname);

  if (!isOriginOnly || (!isHostedProject && !isTestLoopback)) {
    throw invalidPublicRuntimeConfig();
  }

  validatePublicSupabaseKey(
    rawAnonKey,
    isHostedProject ? url.hostname.split('.')[0] : null
  );

  return Object.freeze({
    supabaseUrl: url.origin,
    supabaseAnonKey: rawAnonKey
  });
}

function buildPublicRuntimeConfigScript(env = process.env) {
  const config = getPublicRuntimeConfig(env);
  return [
    "'use strict';",
    `window.PromptGenRuntimeConfig = Object.freeze(${JSON.stringify(config)});`,
    ''
  ].join('\n');
}

module.exports = {
  buildPublicRuntimeConfigScript,
  getPublicRuntimeConfig
};
