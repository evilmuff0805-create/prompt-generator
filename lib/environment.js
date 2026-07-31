'use strict';

const {
  getAcceptedPaddlePriceIds,
  validatePaddlePriceMappings
} = require('./product-catalog');
const {
  validateCreditPackConfiguration
} = require('./credit-pack-catalog');
const { getPaddleApiBase } = require('./paddle-api');

// These values already make the current server fail while loading the
// Storyboard/OpenAI path. Centralizing the check only makes that failure early
// and actionable; it does not add a new production startup requirement.
const REQUIRED_AT_STARTUP = Object.freeze([
  'OPENAI_API_KEY',
  'OPENAI_TEXT_MODEL'
]);

// These values are required for their named product areas, but older
// deployments can still serve health/static routes without every area enabled.
// Missing values are reported at startup. Set
// ENV_VALIDATION_STRICT_FEATURES=true only after the deployment environment has
// been audited if every product area must be available before accepting traffic.
const REQUIRED_BY_FEATURE = Object.freeze({
  supabase: Object.freeze([
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY'
  ]),
  imageAnalysis: Object.freeze(['GEMINI_API_KEY']),
  paddleBilling: Object.freeze([
    'PADDLE_API_KEY',
    'PADDLE_WEBHOOK_SECRET',
    'PADDLE_PRO_PRICE_ID',
    'PADDLE_ENTERPRISE_PRICE_ID'
  ])
});

// A disabled product area may remain a startup warning for backward
// compatibility. Once a money-moving path is explicitly enabled, however, the
// server must not bind unless that path's checkout, webhook, and database
// dependencies are all present. Keep these lists scoped to values the enabled
// path actually reads; for example, the ledger-only webhook path does not call
// Paddle's API and therefore does not require PADDLE_API_KEY.
const REQUIRED_BY_PAYMENT_FEATURE = Object.freeze({
  proPrice1099: Object.freeze([
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PADDLE_API_KEY',
    'PADDLE_WEBHOOK_SECRET',
    'PADDLE_PRO_PRICE_ID',
    'PADDLE_PRO_1099_PRICE_ID'
  ]),
  creditLedgerV2: Object.freeze([
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PADDLE_WEBHOOK_SECRET',
    'PADDLE_PRO_PRICE_ID',
    'PADDLE_ENTERPRISE_PRICE_ID'
  ]),
  creditPackPurchases: Object.freeze([
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'PADDLE_API_KEY',
    'PADDLE_WEBHOOK_SECRET',
    'PADDLE_PRO_PRICE_ID',
    'PADDLE_ENTERPRISE_PRICE_ID',
    'PADDLE_CREDIT_PACK_TAX_CATEGORY',
    'PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED',
    'PADDLE_TRANSACTION_READ_CONFIRMED'
  ])
});

const OPTIONAL_DEFAULTS = Object.freeze({
  NODE_ENV: 'development',
  PORT: '3000',
  SERVICE_NAME: 'promptgen-api',
  OPENAI_TEXT_REASONING_EFFORT: 'medium',
  OPENAI_IMAGE_MODEL: 'gpt-image-2',
  GEMINI_MODEL: 'gemini-3.1-flash-lite',
  GEMINI_STRUCTURED_OUTPUT_ENABLED: 'false',
  GEMINI_IMAGE_METADATA_SHADOW_ENABLED: 'false',
  GEMINI_IMAGE_METADATA_SHADOW_SAMPLE_RATE: '0.05',
  GEMINI_IMAGE_METADATA_SHADOW_MAX_CONCURRENCY: '1',
  PADDLE_API_BASE: 'https://api.paddle.com',
  PADDLE_PRO_PRICE_USD: '9.99',
  PADDLE_ENTERPRISE_PRICE_USD: '19.99',
  PRO_PRICE_1099_ENABLED: 'false',
  PADDLE_PRO_1099_PRICE_ID: '',
  PADDLE_PRO_LEGACY_PRICE_IDS: '',
  PADDLE_ENTERPRISE_LEGACY_PRICE_IDS: '',
  CREDIT_LEDGER_V2_ENABLED: 'false',
  CREDIT_PACK_PURCHASES_ENABLED: 'false',
  CREDIT_PACK_EXPIRY_DAYS: '365',
  PADDLE_CREDIT_PACK_TAX_CATEGORY: '',
  PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED: 'false',
  PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED: 'false',
  PADDLE_TRANSACTION_READ_CONFIRMED: 'false',
  PADDLE_CREDIT_PACK_600_LEGACY_PRICE_IDS: '',
  PADDLE_CREDIT_PACK_1500_LEGACY_PRICE_IDS: '',
  PADDLE_CREDIT_PACK_3000_LEGACY_PRICE_IDS: '',
  STORYBOARD_ALLOWED_PLANS: 'pro,enterprise,paid',
  STORYBOARD_DURABLE_WORKER_ENABLED: 'true',
  STORYBOARD_WORKER_CONCURRENCY: '5',
  STORYBOARD_WORKER_POLL_MS: '5000',
  STORYBOARD_WORKER_LEASE_SECONDS: '180',
  STORYBOARD_WORKER_HEARTBEAT_MS: '60000',
  STORYBOARD_RETRY_BASE_SECONDS: '15',
  STORYBOARD_MAX_ATTEMPTS: '3',
  STORYBOARD_MAX_CONCURRENT_JOBS: '5',
  STORYBOARD_MAX_FILE_SIZE_MB: '10',
  STORYBOARD_RATE_LIMIT_SECONDS: '60',
  STORYBOARD_REF_EXPIRY_BUFFER_MINUTES: '10',
  STORYBOARD_RETENTION_DAYS: '30',
  CLEANUP_SCHEDULER_ENABLED: 'true',
  CLEANUP_INITIAL_DELAY_MS: '60000',
  CLEANUP_INTERVAL_MS: '86400000',
  CLEANUP_BATCH_SIZE: '100',
  WEBHOOK_EVENT_RETENTION_DAYS: '90',
  OPS_ALERT_WEBHOOK_FORMAT: 'generic',
  OPS_ALERT_MIN_SEVERITY: 'critical',
  OPS_ALERT_REPEAT: 'false',
  ENV_VALIDATION_STRICT_FEATURES: 'false'
});

function isConfigured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function missingFrom(env, names) {
  return names.filter((name) => !isConfigured(env[name]));
}

function isEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function getEnabledPaymentFeatureRequirements(env) {
  return [
    isEnabled(env.PRO_PRICE_1099_ENABLED)
      ? REQUIRED_BY_PAYMENT_FEATURE.proPrice1099
      : [],
    isEnabled(env.CREDIT_LEDGER_V2_ENABLED)
      ? REQUIRED_BY_PAYMENT_FEATURE.creditLedgerV2
      : [],
    isEnabled(env.CREDIT_PACK_PURCHASES_ENABLED)
      ? REQUIRED_BY_PAYMENT_FEATURE.creditPackPurchases
      : []
  ].flat();
}

function validateStartupEnvironment(env = process.env) {
  // Validate the bearer-token destination independently of feature flags.
  getPaddleApiBase(env);

  const missingStartup = missingFrom(env, REQUIRED_AT_STARTUP);
  const missingFeatures = Object.fromEntries(
    Object.entries(REQUIRED_BY_FEATURE)
      .map(([feature, names]) => [feature, missingFrom(env, names)])
      .filter(([, names]) => names.length > 0)
  );
  const strictFeatures = String(env.ENV_VALIDATION_STRICT_FEATURES || '').trim().toLowerCase() === 'true';
  const missingFeatureVariables = [...new Set(Object.values(missingFeatures).flat())].sort();
  const missingEnabledPaymentVariables = missingFrom(
    env,
    getEnabledPaymentFeatureRequirements(env)
  );
  const fatalMissing = [
    ...missingStartup,
    ...missingEnabledPaymentVariables,
    ...(strictFeatures ? missingFeatureVariables : [])
  ];

  if (fatalMissing.length > 0) {
    const error = new Error(
      `[environment] Missing required variables: ${[...new Set(fatalMissing)].sort().join(', ')}`
    );
    error.code = 'INVALID_ENVIRONMENT';
    error.missingVariables = [...new Set(fatalMissing)].sort();
    error.missingFeatures = missingFeatures;
    throw error;
  }

  // A price may be accepted by only one plan. This protects renewal webhooks
  // during staged price migrations while still allowing each plan to list
  // multiple inbound-only legacy price IDs.
  validatePaddlePriceMappings(env);
  validateCreditPackConfiguration(env, [
    ...getAcceptedPaddlePriceIds('pro', env),
    ...getAcceptedPaddlePriceIds('enterprise', env)
  ]);

  return {
    strictFeatures,
    missingFeatures,
    missingFeatureVariables
  };
}

module.exports = {
  REQUIRED_AT_STARTUP,
  REQUIRED_BY_FEATURE,
  REQUIRED_BY_PAYMENT_FEATURE,
  OPTIONAL_DEFAULTS,
  isConfigured,
  validateStartupEnvironment
};
