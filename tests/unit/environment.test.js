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

const completeEnv = {
  OPENAI_API_KEY: 'test-openai-key',
  OPENAI_TEXT_MODEL: 'test-text-model',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-publishable-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-server-key',
  GEMINI_API_KEY: 'test-gemini-key',
  PADDLE_API_KEY: 'test-paddle-key',
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
      missingFeatureVariables: []
    });
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
      PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true'
    }).missingFeatureVariables).toEqual([]);
  });

  test('credit-pack purchases fail closed until Paddle tax category is confirmed', () => {
    expect(() => validateStartupEnvironment({
      ...completeEnv,
      CREDIT_LEDGER_V2_ENABLED: 'true',
      CREDIT_PACK_PURCHASES_ENABLED: 'true',
      PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas',
      PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'false'
    })).toThrow('requires written confirmation');
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
    expect(OPTIONAL_DEFAULTS.PADDLE_PRO_LEGACY_PRICE_IDS).toBe('');
    expect(OPTIONAL_DEFAULTS.PADDLE_ENTERPRISE_LEGACY_PRICE_IDS).toBe('');
    expect(OPTIONAL_DEFAULTS.CREDIT_LEDGER_V2_ENABLED).toBe('false');
    expect(OPTIONAL_DEFAULTS.CREDIT_PACK_PURCHASES_ENABLED).toBe('false');
    expect(OPTIONAL_DEFAULTS.PADDLE_CREDIT_PACK_TAX_CATEGORY).toBe('');
    expect(OPTIONAL_DEFAULTS.PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED).toBe('false');
    expect(OPTIONAL_DEFAULTS).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
  });

  test('Playwright credit-pack fixture explicitly confirms only its test tax placeholder', () => {
    const config = fs.readFileSync(
      path.join(__dirname, '..', '..', 'playwright.config.js'),
      'utf8'
    );

    expect(config).toContain("CREDIT_PACK_PURCHASES_ENABLED: 'true'");
    expect(config).toContain("PADDLE_CREDIT_PACK_TAX_CATEGORY: 'saas'");
    expect(config).toContain("PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'true'");
    expect(config).toContain('Test-only placeholder; not evidence of Paddle tax approval.');
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
