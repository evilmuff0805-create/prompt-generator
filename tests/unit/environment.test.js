'use strict';

const fs = require('fs');
const path = require('path');

const {
  REQUIRED_AT_STARTUP,
  REQUIRED_BY_FEATURE,
  REQUIRED_BY_PAYMENT_FEATURE,
  OPTIONAL_DEFAULTS,
  isConfigured,
  validateStartupEnvironment
} = require('../../lib/environment');

function modernApiKey(environment) {
  return `pdl_${environment}_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_C3D`;
}

const LIVE_API_KEY = modernApiKey('live');
const SANDBOX_API_KEY = modernApiKey('sdbx');
const TEST_SUPABASE_REF = 'aaaaaaaaaaaaaaaaaaaa';
const PRODUCTION_SUPABASE_REF = 'kzlovmcghswprasjaeeo';

const completeEnv = {
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_TEXT_MODEL: 'test-text-model',
  SUPABASE_URL: `https://${PRODUCTION_SUPABASE_REF}.supabase.co`,
  SUPABASE_ANON_KEY: `sb_publishable_${'p'.repeat(32)}`,
  SUPABASE_SERVICE_ROLE_KEY: 'test-server-key',
  GEMINI_API_KEY: 'test-gemini-key',
  PADDLE_API_KEY: LIVE_API_KEY,
  PADDLE_CLIENT_TOKEN: 'live_public-test-token',
  PADDLE_SANDBOX_ALLOWED_SUPABASE_PROJECT_REFS: TEST_SUPABASE_REF,
  PADDLE_WEBHOOK_SECRET: 'test-webhook-secret',
  PADDLE_PRO_PRICE_ID: 'pri_test_pro',
  PADDLE_ENTERPRISE_PRICE_ID: 'pri_test_enterprise'
};

describe('environment contract', () => {
  test('rejects missing or whitespace-only startup values before bind', () => {
    expect(() => validateStartupEnvironment({
      OPENAI_API_KEY: '   ',
      OPENAI_TEXT_MODEL: ''
    })).toThrow('OPENAI_API_KEY, OPENAI_TEXT_MODEL');
  });

  test('reports feature gaps without making them fatal by default', () => {
    const report = validateStartupEnvironment({
      OPENAI_API_KEY: 'test-openai-key',
      OPENAI_TEXT_MODEL: 'test-text-model'
    });

    expect(report.strictFeatures).toBe(false);
    expect(report.missingFeatures).toEqual({
      supabase: REQUIRED_BY_FEATURE.supabase,
      imageAnalysis: REQUIRED_BY_FEATURE.imageAnalysis,
      paddleBilling: REQUIRED_BY_FEATURE.paddleBilling
    });
    expect(report.missingFeatureVariables).not.toContain('OPENAI_API_KEY');
  });

  test('strict feature mode promotes feature gaps to startup failures', () => {
    expect(() => validateStartupEnvironment({
      OPENAI_API_KEY: 'test-openai-key',
      OPENAI_TEXT_MODEL: 'test-text-model',
      ENV_VALIDATION_STRICT_FEATURES: 'true'
    })).toThrow('GEMINI_API_KEY');
  });

  test('strict feature mode is whitespace and case tolerant', () => {
    expect(() => validateStartupEnvironment({
      OPENAI_API_KEY: 'test-openai-key',
      OPENAI_TEXT_MODEL: 'test-text-model',
      ENV_VALIDATION_STRICT_FEATURES: ' TRUE '
    })).toThrow('GEMINI_API_KEY');
  });

  test('complete configuration produces an empty report', () => {
    expect(validateStartupEnvironment(completeEnv)).toEqual({
      strictFeatures: false,
      missingFeatures: {},
      missingFeatureVariables: [],
      paddleWarnings: []
    });
  });

  test('rejects a Supabase secret key before the server can expose browser config', () => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      SUPABASE_ANON_KEY: `sb_secret_${'s'.repeat(32)}`
    })).toThrow('public Supabase runtime configuration');
  });

  test.each([
    ['https://api.paddle.com', 'live_public-test-token', LIVE_API_KEY, PRODUCTION_SUPABASE_REF],
    ['https://sandbox-api.paddle.com', 'test_public-test-token', SANDBOX_API_KEY, TEST_SUPABASE_REF]
  ])('accepts the exact trusted Paddle API origin %s', (paddleApiBase, clientToken, apiKey, supabaseRef) => {
    expect(validateStartupEnvironment({
      ...completeEnv,
      PADDLE_API_BASE: paddleApiBase,
      PADDLE_CLIENT_TOKEN: clientToken,
      PADDLE_API_KEY: apiKey,
      SUPABASE_URL: `https://${supabaseRef}.supabase.co`
    })).toEqual({
      strictFeatures: false,
      missingFeatures: {},
      missingFeatureVariables: [],
      paddleWarnings: []
    });
  });

  test('requires an explicit Sandbox client token and rejects token/base mismatches', () => {
    const sandboxEnv = {
      ...completeEnv,
      SUPABASE_URL: `https://${TEST_SUPABASE_REF}.supabase.co`,
      PADDLE_API_BASE: 'https://sandbox-api.paddle.com',
      PADDLE_API_KEY: SANDBOX_API_KEY
    };
    delete sandboxEnv.PADDLE_CLIENT_TOKEN;

    expect(() => validateStartupEnvironment(sandboxEnv)).toThrow(
      'PADDLE_CLIENT_TOKEN must be explicitly configured for Paddle Sandbox'
    );
    expect(() => validateStartupEnvironment({
      ...sandboxEnv,
      PADDLE_CLIENT_TOKEN: 'live_wrong-environment'
    })).toThrow('PADDLE_CLIENT_TOKEN does not match PADDLE_API_BASE');
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      PADDLE_CLIENT_TOKEN: 'test_wrong-environment'
    })).toThrow('PADDLE_CLIENT_TOKEN does not match PADDLE_API_BASE');
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      PADDLE_CLIENT_TOKEN: 'unprefixed-token'
    })).toThrow('PADDLE_CLIENT_TOKEN must use the live_ or test_ environment prefix');
  });

  test('rejects Paddle Sandbox when Supabase is not explicitly isolated', () => {
    const sandboxEnv = {
      ...completeEnv,
      SUPABASE_URL: `https://${TEST_SUPABASE_REF}.supabase.co`,
      PADDLE_API_BASE: 'https://sandbox-api.paddle.com',
      PADDLE_API_KEY: SANDBOX_API_KEY,
      PADDLE_CLIENT_TOKEN: 'test_public-test-token',
      PADDLE_SANDBOX_ALLOWED_SUPABASE_PROJECT_REFS: ''
    };

    expect(() => validateStartupEnvironment(sandboxEnv))
      .toThrow('Sandbox Supabase project must be explicitly allowlisted');
    expect(() => validateStartupEnvironment({
      ...sandboxEnv,
      PADDLE_SANDBOX_ALLOWED_SUPABASE_PROJECT_REFS: 'bbbbbbbbbbbbbbbbbbbb'
    })).toThrow('Sandbox Supabase project must be explicitly allowlisted');
  });

  test('never permits Paddle Sandbox to use the PromptGen production Supabase project', () => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      SUPABASE_URL: `https://${PRODUCTION_SUPABASE_REF}.supabase.co`,
      PADDLE_API_BASE: 'https://sandbox-api.paddle.com',
      PADDLE_API_KEY: SANDBOX_API_KEY,
      PADDLE_CLIENT_TOKEN: 'test_public-test-token',
      PADDLE_SANDBOX_ALLOWED_SUPABASE_PROJECT_REFS: PRODUCTION_SUPABASE_REF
    })).toThrow('PromptGen production Supabase project');
  });

  test('accepts Paddle Sandbox only with an exact non-production Supabase allowlist match', () => {
    expect(validateStartupEnvironment({
      ...completeEnv,
      SUPABASE_URL: `https://${TEST_SUPABASE_REF}.supabase.co`,
      PADDLE_API_BASE: 'https://sandbox-api.paddle.com',
      PADDLE_API_KEY: SANDBOX_API_KEY,
      PADDLE_CLIENT_TOKEN: 'test_public-test-token',
      PADDLE_SANDBOX_ALLOWED_SUPABASE_PROJECT_REFS: `bbbbbbbbbbbbbbbbbbbb,${TEST_SUPABASE_REF}`
    }).missingFeatureVariables).toEqual([]);
  });

  test('rejects modern Paddle API keys whose prefix disagrees with the API base', () => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      PADDLE_API_KEY: 'pdl_sdbx_apikey_wrong-environment'
    })).toThrow('PADDLE_API_KEY does not match PADDLE_API_BASE');
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      SUPABASE_URL: `https://${TEST_SUPABASE_REF}.supabase.co`,
      PADDLE_API_BASE: 'https://sandbox-api.paddle.com',
      PADDLE_API_KEY: 'pdl_live_apikey_wrong-environment',
      PADDLE_CLIENT_TOKEN: 'test_public-test-token'
    })).toThrow('PADDLE_API_KEY does not match PADDLE_API_BASE');

    expect(validateStartupEnvironment({
      ...completeEnv,
      PADDLE_API_KEY: LIVE_API_KEY
    }).missingFeatureVariables).toEqual([]);
  });

  test('never pairs Paddle Production with a non-production Supabase project', () => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      SUPABASE_URL: `https://${TEST_SUPABASE_REF}.supabase.co`
    })).toThrow('Paddle Production may use only the PromptGen production Supabase project');
  });

  test('disabled payment activations warn but accept a legacy or unrecognized server key', () => {
    const legacyApiKey = 'legacy-key-value-that-must-not-be-logged';
    const report = validateStartupEnvironment({
      ...completeEnv,
      PADDLE_API_KEY: legacyApiKey,
      PRO_PRICE_1099_ENABLED: 'false',
      CREDIT_PACK_PURCHASES_ENABLED: 'false'
    });

    expect(report.paddleWarnings).toEqual([{
      code: 'PADDLE_API_KEY_LEGACY_OR_UNRECOGNIZED',
      variable: 'PADDLE_API_KEY',
      message: expect.stringContaining('legacy or unrecognized format')
    }]);
    expect(JSON.stringify(report)).not.toContain(legacyApiKey);
  });

  test.each([
    [
      'staged Pro pricing',
      {
        PRO_PRICE_1099_ENABLED: 'true',
        PADDLE_PRO_1099_PRICE_ID: 'pri_test_pro_1099'
      }
    ],
    [
      'credit-pack purchases',
      {
        CREDIT_LEDGER_V2_ENABLED: 'true',
        CREDIT_PACK_PURCHASES_ENABLED: 'true',
        PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas',
        PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true',
        PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED: 'true',
        PADDLE_TRANSACTION_READ_CONFIRMED: 'true'
      }
    ]
  ])('%s rejects a legacy server key before activation', (_label, activation) => {
    const legacyApiKey = 'legacy-key-value-that-must-not-be-logged';
    let error;

    try {
      validateStartupEnvironment({
        ...completeEnv,
        ...activation,
        PADDLE_API_KEY: legacyApiKey
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 'PADDLE_MODERN_API_KEY_REQUIRED' });
    expect(error.message).not.toContain(legacyApiKey);
  });

  test('ledger-only activation preserves legacy server-key compatibility with a warning', () => {
    const report = validateStartupEnvironment({
      ...completeEnv,
      CREDIT_LEDGER_V2_ENABLED: 'true',
      PADDLE_API_KEY: 'legacy-ledger-only-key'
    });

    expect(report.paddleWarnings).toEqual([
      expect.objectContaining({
        code: 'PADDLE_API_KEY_LEGACY_OR_UNRECOGNIZED'
      })
    ]);
  });

  test.each([
    'http://api.paddle.com',
    'https://api.paddle.com.attacker.example',
    'https://user:password@api.paddle.com',
    'https://api.paddle.com/v1',
    'https://api.paddle.com?redirect=attacker'
  ])('rejects an unsafe Paddle bearer-token destination %s', (paddleApiBase) => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      PADDLE_API_BASE: paddleApiBase
    })).toThrow('PADDLE_API_BASE must be the exact Paddle production or sandbox HTTPS origin');
  });

  test('allows an HTTP loopback Paddle fixture only in NODE_ENV=test', () => {
    expect(validateStartupEnvironment({
      ...completeEnv,
      NODE_ENV: 'test',
      SUPABASE_URL: 'http://127.0.0.1:54321',
      PADDLE_API_BASE: 'http://127.0.0.1:54322',
      PADDLE_API_KEY: SANDBOX_API_KEY,
      PADDLE_CLIENT_TOKEN: 'test_loopback-fixture'
    })).toEqual({
      strictFeatures: false,
      missingFeatures: {},
      missingFeatureVariables: [],
      paddleWarnings: []
    });
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      NODE_ENV: 'production',
      PADDLE_API_BASE: 'http://127.0.0.1:54322'
    })).toThrow('PADDLE_API_BASE');
  });

  test('allows an HTTPS .test Paddle fixture only in NODE_ENV=test', () => {
    expect(validateStartupEnvironment({
      ...completeEnv,
      NODE_ENV: 'test',
      SUPABASE_URL: `https://${TEST_SUPABASE_REF}.supabase.co`,
      PADDLE_API_BASE: 'https://sandbox-api.paddle.test',
      PADDLE_API_KEY: SANDBOX_API_KEY,
      PADDLE_CLIENT_TOKEN: 'test_domain-fixture'
    })).toEqual({
      strictFeatures: false,
      missingFeatures: {},
      missingFeatureVariables: [],
      paddleWarnings: []
    });
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      NODE_ENV: 'production',
      PADDLE_API_BASE: 'https://sandbox-api.paddle.test'
    })).toThrow('PADDLE_API_BASE');
  });

  test('rejects cross-plan current or legacy Paddle price ID collisions', () => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      PADDLE_PRO_LEGACY_PRICE_IDS: completeEnv.PADDLE_ENTERPRISE_PRICE_ID
    })).toThrow('configured for both pro and enterprise');
  });

  test('staged USD 10.99 Pro cutover fails closed until distinct old and new IDs exist', () => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      PRO_PRICE_1099_ENABLED: 'true'
    })).toThrow('PADDLE_PRO_1099_PRICE_ID');

    expect(() => validateStartupEnvironment({
      ...completeEnv,
      PRO_PRICE_1099_ENABLED: 'true',
      PADDLE_PRO_1099_PRICE_ID: completeEnv.PADDLE_PRO_PRICE_ID
    })).toThrow('must be distinct');

    expect(() => validateStartupEnvironment({
      ...completeEnv,
      PRO_PRICE_1099_ENABLED: 'true',
      PADDLE_PRO_1099_PRICE_ID: completeEnv.PADDLE_ENTERPRISE_PRICE_ID
    })).toThrow('configured for both pro and enterprise');

    expect(validateStartupEnvironment({
      ...completeEnv,
      PRO_PRICE_1099_ENABLED: 'true',
      PADDLE_PRO_1099_PRICE_ID: 'pri_test_pro_1099'
    }).missingFeatureVariables).toEqual([]);
  });

  test.each(REQUIRED_BY_PAYMENT_FEATURE.proPrice1099)(
    'staged Pro cutover makes %s fatal even when strict feature validation is disabled',
    (missingVariable) => {
      const env = {
        ...completeEnv,
        PRO_PRICE_1099_ENABLED: 'true',
        PADDLE_PRO_1099_PRICE_ID: 'pri_test_pro_1099',
        ENV_VALIDATION_STRICT_FEATURES: 'false'
      };
      delete env[missingVariable];

      try {
        validateStartupEnvironment(env);
        throw new Error('expected startup validation to fail');
      } catch (error) {
        expect(error.code).toBe('INVALID_ENVIRONMENT');
        expect(error.missingVariables).toContain(missingVariable);
      }
    }
  );

  test.each(REQUIRED_BY_PAYMENT_FEATURE.creditLedgerV2)(
    'credit ledger V2 makes %s fatal even when strict feature validation is disabled',
    (missingVariable) => {
      const env = {
        ...completeEnv,
        CREDIT_LEDGER_V2_ENABLED: 'true',
        ENV_VALIDATION_STRICT_FEATURES: 'false'
      };
      delete env[missingVariable];

      try {
        validateStartupEnvironment(env);
        throw new Error('expected startup validation to fail');
      } catch (error) {
        expect(error.code).toBe('INVALID_ENVIRONMENT');
        expect(error.missingVariables).toContain(missingVariable);
      }
    }
  );

  test('ledger-only activation does not over-require checkout-only Paddle credentials', () => {
    const env = {
      ...completeEnv,
      CREDIT_LEDGER_V2_ENABLED: 'true'
    };
    delete env.PADDLE_API_KEY;
    delete env.SUPABASE_ANON_KEY;

    expect(validateStartupEnvironment(env).missingFeatureVariables).toEqual([
      'PADDLE_API_KEY',
      'SUPABASE_ANON_KEY'
    ]);
  });

  test.each(REQUIRED_BY_PAYMENT_FEATURE.creditPackPurchases)(
    'credit-pack checkout makes %s fatal even when strict feature validation is disabled',
    (missingVariable) => {
      const env = {
        ...completeEnv,
        CREDIT_LEDGER_V2_ENABLED: 'true',
        CREDIT_PACK_PURCHASES_ENABLED: 'true',
        PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas',
        PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true',
        PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED: 'true',
        PADDLE_TRANSACTION_READ_CONFIRMED: 'true',
        ENV_VALIDATION_STRICT_FEATURES: 'false'
      };
      delete env[missingVariable];

      try {
        validateStartupEnvironment(env);
        throw new Error('expected startup validation to fail');
      } catch (error) {
        expect(error.code).toBe('INVALID_ENVIRONMENT');
        expect(error.missingVariables).toContain(missingVariable);
      }
    }
  );

  test('credit-pack purchases start with complete money-path configuration', () => {
    expect(validateStartupEnvironment({
      ...completeEnv,
      CREDIT_LEDGER_V2_ENABLED: 'true',
      CREDIT_PACK_PURCHASES_ENABLED: 'true',
      PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas',
      PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true',
      PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED: 'true',
      PADDLE_TRANSACTION_READ_CONFIRMED: 'true'
    }).missingFeatureVariables).toEqual([]);
  });

  test('credit-pack purchases fail closed until Paddle tax category is confirmed', () => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      CREDIT_LEDGER_V2_ENABLED: 'true',
      CREDIT_PACK_PURCHASES_ENABLED: 'true',
      PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas',
      PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'false',
      PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED: 'true',
      PADDLE_TRANSACTION_READ_CONFIRMED: 'true'
    })).toThrow('requires written confirmation');
  });

  test('credit-pack purchases fail closed until Paddle subscription history access is confirmed', () => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      CREDIT_LEDGER_V2_ENABLED: 'true',
      CREDIT_PACK_PURCHASES_ENABLED: 'true',
      PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas',
      PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true',
      PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED: 'false',
      PADDLE_TRANSACTION_READ_CONFIRMED: 'true'
    })).toThrow('requires a Paddle API key with subscription_history.read');
  });

  test('credit-pack purchases fail closed until Paddle transaction reads are confirmed', () => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      CREDIT_LEDGER_V2_ENABLED: 'true',
      CREDIT_PACK_PURCHASES_ENABLED: 'true',
      PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas',
      PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true',
      PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED: 'true',
      PADDLE_TRANSACTION_READ_CONFIRMED: 'false'
    })).toThrow('requires a Paddle API key with transaction.read');
  });

  test('catalogs are unique and expose names/defaults rather than secret values', () => {
    expect(new Set(REQUIRED_AT_STARTUP).size).toBe(REQUIRED_AT_STARTUP.length);
    expect(isConfigured(' value ')).toBe(true);
    expect(isConfigured(' ')).toBe(false);
    expect(OPTIONAL_DEFAULTS.OPENAI_TEXT_REASONING_EFFORT).toBe('medium');
    expect(OPTIONAL_DEFAULTS.GEMINI_MODEL).toBe('gemini-3.1-flash-lite');
    expect(OPTIONAL_DEFAULTS.GEMINI_STRUCTURED_OUTPUT_ENABLED).toBe('false');
    expect(OPTIONAL_DEFAULTS.GEMINI_IMAGE_METADATA_SHADOW_ENABLED).toBe('false');
    expect(OPTIONAL_DEFAULTS.GEMINI_IMAGE_METADATA_SHADOW_SAMPLE_RATE).toBe('0.05');
    expect(OPTIONAL_DEFAULTS.GEMINI_IMAGE_METADATA_SHADOW_MAX_CONCURRENCY).toBe('1');
    expect(OPTIONAL_DEFAULTS.PADDLE_PRO_PRICE_USD).toBe('9.99');
    expect(OPTIONAL_DEFAULTS.PRO_PRICE_1099_ENABLED).toBe('false');
    expect(OPTIONAL_DEFAULTS.PADDLE_PRO_1099_PRICE_ID).toBe('');
    expect(OPTIONAL_DEFAULTS.PADDLE_SANDBOX_ALLOWED_SUPABASE_PROJECT_REFS).toBe('');
    expect(OPTIONAL_DEFAULTS.PADDLE_SANDBOX_CHECKOUT_CONFIRMED).toBe('false');
    expect(OPTIONAL_DEFAULTS.PADDLE_PRO_LEGACY_PRICE_IDS).toBe('');
    expect(OPTIONAL_DEFAULTS.PADDLE_ENTERPRISE_LEGACY_PRICE_IDS).toBe('');
    expect(OPTIONAL_DEFAULTS.CREDIT_LEDGER_V2_ENABLED).toBe('false');
    expect(OPTIONAL_DEFAULTS.CREDIT_PACK_PURCHASES_ENABLED).toBe('false');
    expect(OPTIONAL_DEFAULTS.PADDLE_CREDIT_PACK_TAX_CATEGORY).toBe('');
    expect(OPTIONAL_DEFAULTS.PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED).toBe('false');
    expect(OPTIONAL_DEFAULTS.PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED).toBe('false');
    expect(OPTIONAL_DEFAULTS.PADDLE_TRANSACTION_READ_CONFIRMED).toBe('false');
    expect(OPTIONAL_DEFAULTS).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
  });

  test('Playwright credit-pack fixture explicitly confirms only its test placeholders', () => {
    const config = fs.readFileSync(
      path.join(__dirname, '..', '..', 'playwright.config.js'),
      'utf8'
    );

    expect(config).toContain("CREDIT_PACK_PURCHASES_ENABLED: 'true'");
    expect(config).toContain("PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas'");
    expect(config).toContain("PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true'");
    expect(config).toContain("PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED: 'true'");
    expect(config).toContain("PADDLE_TRANSACTION_READ_CONFIRMED: 'true'");
    expect(config).toContain('Test-only placeholder; not evidence of Paddle tax approval.');

    expect(validateStartupEnvironment({
      ...completeEnv,
      NODE_ENV: 'test',
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_ANON_KEY: `sb_publishable_${'p'.repeat(32)}`,
      PADDLE_API_BASE: 'http://127.0.0.1:54322',
      PADDLE_API_KEY: SANDBOX_API_KEY,
      PADDLE_CLIENT_TOKEN: 'test_e2e-placeholder',
      CREDIT_LEDGER_V2_ENABLED: 'true',
      CREDIT_PACK_PURCHASES_ENABLED: 'true',
      PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas',
      PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true',
      PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED: 'true',
      PADDLE_TRANSACTION_READ_CONFIRMED: 'true'
    }).missingFeatureVariables).toEqual([]);
  });

  test('.env.example mirrors every enforced and defaulted variable name', () => {
    const example = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
    const documented = new Set(
      example
        .split(/\r?\n/)
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => line.split('=', 1)[0])
    );
    const expected = [
      ...REQUIRED_AT_STARTUP,
      ...Object.values(REQUIRED_BY_FEATURE).flat(),
      ...Object.keys(OPTIONAL_DEFAULTS)
    ];

    expect(expected.filter((name) => !documented.has(name))).toEqual([]);
    expect(example).toContain('OPENAI_TEXT_MODEL=gpt-5.6-luna');
    expect(example).toContain('OPENAI_TEXT_REASONING_EFFORT=medium');
  });
});
