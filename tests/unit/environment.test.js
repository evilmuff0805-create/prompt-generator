'use strict';

const fs = require('fs');
const path = require('path');

const {
  REQUIRED_AT_STARTUP,
  REQUIRED_BY_FEATURE,
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

  test('catalogs are unique and expose names/defaults rather than secret values', () => {
    expect(new Set(REQUIRED_AT_STARTUP).size).toBe(REQUIRED_AT_STARTUP.length);
    expect(isConfigured(' value ')).toBe(true);
    expect(isConfigured(' ')).toBe(false);
    expect(OPTIONAL_DEFAULTS.OPENAI_TEXT_REASONING_EFFORT).toBe('medium');
    expect(OPTIONAL_DEFAULTS.GEMINI_MODEL).toBe('gemini-3.1-flash-lite');
    expect(OPTIONAL_DEFAULTS.GEMINI_STRUCTURED_OUTPUT_ENABLED).toBe('false');
    expect(OPTIONAL_DEFAULTS).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
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
