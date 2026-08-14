'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  buildPublicRuntimeConfigScript,
  getPublicRuntimeConfig
} = require('../../lib/public-runtime-config');

const ROOT = path.join(__dirname, '..', '..');
const TEST_REF = 'aaaaaaaaaaaaaaaaaaaa';

function legacySupabaseKey(role = 'anon', ref = TEST_REF) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({ iss: 'supabase', ref, role }),
    'test-signature'
  ].join('.');
}

const TEST_ANON_KEY = legacySupabaseKey();

function runtimeEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    SUPABASE_URL: `https://${TEST_REF}.supabase.co`,
    SUPABASE_ANON_KEY: TEST_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: 'must-never-reach-browser',
    ...overrides
  };
}

describe('public runtime config', () => {
  test('emits only the server-selected public Supabase URL and anon key', () => {
    const env = runtimeEnv();
    const config = getPublicRuntimeConfig(env);
    const script = buildPublicRuntimeConfigScript(env);
    const context = { window: {} };

    vm.runInNewContext(script, context);

    expect(config).toEqual({
      supabaseUrl: `https://${TEST_REF}.supabase.co`,
      supabaseAnonKey: TEST_ANON_KEY
    });
    expect(context.window.PromptGenRuntimeConfig).toEqual(config);
    expect(script).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
    expect(Object.isFrozen(context.window.PromptGenRuntimeConfig)).toBe(true);
  });

  test('accepts a current publishable key for browser use', () => {
    const publishableKey = `sb_publishable_${'p'.repeat(32)}`;

    expect(getPublicRuntimeConfig(runtimeEnv({
      SUPABASE_ANON_KEY: publishableKey
    })).supabaseAnonKey).toBe(publishableKey);
  });

  test.each([
    ['current secret key', `sb_secret_${'s'.repeat(32)}`],
    ['legacy service-role JWT', legacySupabaseKey('service_role')],
    ['legacy anon JWT for another project', legacySupabaseKey('anon', 'bbbbbbbbbbbbbbbbbbbb')],
    ['malformed JWT', 'not.a.valid-public-key']
  ])('rejects a %s before emitting browser config', (_label, key) => {
    expect(() => getPublicRuntimeConfig(runtimeEnv({
      SUPABASE_ANON_KEY: key
    }))).toThrow('public Supabase runtime configuration');
  });

  test.each([
    ['missing URL', { SUPABASE_URL: '' }],
    ['URL credentials', { SUPABASE_URL: `https://user:pass@${TEST_REF}.supabase.co` }],
    ['URL path', { SUPABASE_URL: `https://${TEST_REF}.supabase.co/rest` }],
    ['external HTTP URL', { SUPABASE_URL: 'http://example.com' }],
    ['missing anon key', { SUPABASE_ANON_KEY: ' ' }],
    ['padded anon key', { SUPABASE_ANON_KEY: ' public-key ' }]
  ])('fails closed on %s', (_label, overrides) => {
    expect(() => getPublicRuntimeConfig(runtimeEnv(overrides)))
      .toThrow('public Supabase runtime configuration');
  });

  test('allows a loopback Supabase fixture only in test mode', () => {
    expect(getPublicRuntimeConfig(runtimeEnv({
      NODE_ENV: 'test',
      SUPABASE_URL: 'http://127.0.0.1:54321'
    })).supabaseUrl).toBe('http://127.0.0.1:54321');
    expect(() => getPublicRuntimeConfig(runtimeEnv({
      SUPABASE_URL: 'http://127.0.0.1:54321'
    }))).toThrow('public Supabase runtime configuration');
  });

  test('loads runtime config before every browser Supabase consumer', () => {
    const contracts = [
      ['public/index.html', '/app.js'],
      ['public/frame.html', '/frame.js'],
      ['public/storyboard.html', '/js/storyboard-api.js'],
      ['public/storyboard-history.html', '/js/storyboard-api.js'],
      ['public/storyboard-result.html', '/js/storyboard-api.js']
    ];

    for (const [file, consumer] of contracts) {
      const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(html.indexOf('/runtime-config.js')).toBeGreaterThan(-1);
      expect(html.indexOf('/runtime-config.js')).toBeLessThan(html.indexOf(consumer));
    }

    for (const file of [
      'public/app.js',
      'public/frame.js',
      'public/js/storyboard-api.js'
    ]) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(source).toContain('window.PromptGenRuntimeConfig');
      expect(source).not.toContain('kzlovmcghswprasjaeeo');
      expect(source).not.toContain('eyJhbGciOiJIUzI1NiI');
    }
  });
});
