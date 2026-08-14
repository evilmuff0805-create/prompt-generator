'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const PRODUCTION_PROJECT_REF = 'kzlovmcghswprasjaeeo';
const DATABASE_URL_ENV = 'PAYMENT_MIGRATION_CLONE_DATABASE_URL';
const PROJECT_REF_ENV = 'PAYMENT_MIGRATION_CLONE_PROJECT_REF';
const DISPOSABLE_DATABASE_PATTERN = /(?:^|[_-])(?:clone|rehearsal|disposable|sandbox|test)(?:$|[_-])/i;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const SQL_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  'scripts',
  'sql',
  'payment-migration-rehearsal'
);

const SQL_FILES = Object.freeze({
  preflight: path.join(SQL_DIRECTORY, '00_preflight_readonly.sql'),
  disableSideEffects: path.join(SQL_DIRECTORY, '10_disable_clone_side_effects.sql'),
  before: path.join(SQL_DIRECTORY, '20_before_invariants.sql'),
  after: path.join(SQL_DIRECTORY, '80_after_invariants.sql'),
  aclRls: path.join(SQL_DIRECTORY, '90_acl_rls_checks.sql')
});

const MIGRATIONS = Object.freeze([
  '023_legacy_credit_classification_manifest.sql',
  '024_credit_lot_ledger.sql',
  '025_paddle_event_ordering.sql',
  '026_secure_payment_requests.sql',
  '027_secure_subscription_checkout.sql'
].map((name) => Object.freeze({
  name,
  file: path.join(REPOSITORY_ROOT, 'migrations', name)
})));

const BEFORE_ZERO_KEYS = Object.freeze([
  'negative_legacy_balance_count',
  'active_analysis_reservation_count',
  'active_storyboard_job_count',
  'paddle_identifier_drift_count',
  'subscription_without_customer_count',
  'subscription_invalid_plan_count',
  'migration_024_landmark_count'
]);

const PREFLIGHT_COUNT_KEYS = Object.freeze([
  'postgres_17_count',
  'cron_extension_count',
  'cron_table_count',
  'cron_extension_without_table_count',
  'cron_extension_without_run_details_count',
  'cron_total_count',
  'cron_active_count',
  'cron_external_database_active_count',
  'cron_running_count'
]);

const SIDE_EFFECT_COUNT_KEYS = Object.freeze([
  'cron_active_count',
  'side_effect_disable_failure_count'
]);

const BEFORE_COUNT_KEYS = Object.freeze([
  'positive_legacy_balance_count',
  ...BEFORE_ZERO_KEYS,
  'manifest_table_count',
  'manifest_row_count',
  'manifest_missing_count',
  'manifest_extra_count',
  'manifest_total_mismatch_count',
  'manifest_invalid_count',
  'manifest_drift_count',
  'manifest_guard_missing_count'
]);

const AFTER_COUNT_KEYS = Object.freeze([
  'profile_balance_mismatch_count',
  'credit_lot_state_violation_count',
  'credit_allocation_mismatch_count',
  'manifest_unconsumed_count',
  'manifest_backfill_mismatch_count',
  'active_analysis_reservation_count',
  'active_storyboard_job_count',
  'pending_event_lease_count',
  'open_credit_pack_request_count',
  'open_subscription_checkout_count'
]);

const ACL_RLS_COUNT_KEYS = Object.freeze([
  'missing_table_count',
  'rls_disabled_count',
  'table_owner_mismatch_count',
  'forbidden_table_grant_count',
  'private_schema_forbidden_grant_count',
  'private_schema_owner_mismatch_count',
  'missing_service_role_count',
  'missing_service_role_select_count',
  'missing_function_count',
  'insecure_function_count',
  'function_owner_mismatch_count',
  'forbidden_function_grant_count',
  'missing_service_role_execute_count',
  'forbidden_service_role_execute_count'
]);

class PaymentMigrationCloneAuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PaymentMigrationCloneAuditError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PaymentMigrationCloneAuditError(code, message);
}

function parseCliArguments(argv) {
  let confirmDisposable = false;
  for (const argument of argv) {
    if (argument !== '--confirm-disposable' || confirmDisposable) {
      fail(
        'PAYMENT_MIGRATION_CLONE_ARGUMENT_INVALID',
        'Only one --confirm-disposable switch is supported.'
      );
    }
    confirmDisposable = true;
  }
  return Object.freeze({ confirmDisposable });
}

function decodeUrlComponent(value) {
  try {
    return decodeURIComponent(value || '');
  } catch (_) {
    fail(
      'PAYMENT_MIGRATION_CLONE_URL_INVALID',
      `${DATABASE_URL_ENV} is not a valid PostgreSQL URL.`
    );
  }
}

function readCloneConfig(env = process.env) {
  const rawUrl = typeof env[DATABASE_URL_ENV] === 'string'
    ? env[DATABASE_URL_ENV]
    : '';
  if (!rawUrl || rawUrl !== rawUrl.trim()) {
    fail(
      'PAYMENT_MIGRATION_CLONE_URL_REQUIRED',
      `${DATABASE_URL_ENV} must be provided without surrounding whitespace.`
    );
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    fail(
      'PAYMENT_MIGRATION_CLONE_URL_INVALID',
      `${DATABASE_URL_ENV} is not a valid PostgreSQL URL.`
    );
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    fail(
      'PAYMENT_MIGRATION_CLONE_URL_INVALID',
      `${DATABASE_URL_ENV} must use the PostgreSQL protocol.`
    );
  }
  if (url.search || url.hash) {
    fail(
      'PAYMENT_MIGRATION_CLONE_URL_INVALID',
      `${DATABASE_URL_ENV} must not contain query parameters or a fragment.`
    );
  }

  const hostname = url.hostname.toLowerCase();
  const projectRef = typeof env[PROJECT_REF_ENV] === 'string'
    ? env[PROJECT_REF_ENV].trim().toLowerCase()
    : '';
  if (
    rawUrl.toLowerCase().includes(PRODUCTION_PROJECT_REF)
    || projectRef === PRODUCTION_PROJECT_REF
    || hostname === `db.${PRODUCTION_PROJECT_REF}.supabase.co`
    || hostname === `${PRODUCTION_PROJECT_REF}.supabase.co`
  ) {
    fail(
      'PAYMENT_MIGRATION_CLONE_PRODUCTION_TARGET_REJECTED',
      'The PromptGen production project is never an allowed clone-audit target.'
    );
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    fail(
      'PAYMENT_MIGRATION_CLONE_REMOTE_TARGET_REJECTED',
      'The clone audit accepts only an exact loopback database host.'
    );
  }

  const database = decodeUrlComponent(url.pathname.replace(/^\//, ''));
  const username = decodeUrlComponent(url.username);
  const password = decodeUrlComponent(url.password);
  if (database.toLowerCase().includes(PRODUCTION_PROJECT_REF)) {
    fail(
      'PAYMENT_MIGRATION_CLONE_PRODUCTION_TARGET_REJECTED',
      'The PromptGen production project is never an allowed clone-audit target.'
    );
  }
  if (
    !database
    || !username
    || !/^[A-Za-z0-9_-]+$/.test(database)
    || !DISPOSABLE_DATABASE_PATTERN.test(database)
  ) {
    fail(
      'PAYMENT_MIGRATION_CLONE_DATABASE_NAME_REJECTED',
      'The target database name must explicitly contain clone, rehearsal, disposable, sandbox, or test.'
    );
  }

  const port = url.port || '5432';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    fail(
      'PAYMENT_MIGRATION_CLONE_URL_INVALID',
      `${DATABASE_URL_ENV} contains an invalid port.`
    );
  }

  return Object.freeze({ hostname, port, database, username, password });
}

function childEnvironment(config, baseEnv = process.env) {
  const safe = {};
  for (const name of [
    'PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
    'HOME', 'LANG', 'LC_ALL'
  ]) {
    if (typeof baseEnv[name] === 'string') safe[name] = baseEnv[name];
  }
  return {
    ...safe,
    PGHOST: config.hostname,
    PGPORT: config.port,
    PGDATABASE: config.database,
    PGUSER: config.username,
    ...(config.password ? { PGPASSWORD: config.password } : {}),
    PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '5',
    PGOPTIONS: '-c statement_timeout=300000 -c idle_in_transaction_session_timeout=300000 -c lock_timeout=5000',
    PGAPPNAME: 'promptgen-payment-migration-clone-audit'
  };
}

function sha256File(file, readFileSyncImpl = fs.readFileSync) {
  return crypto.createHash('sha256').update(readFileSyncImpl(file)).digest('hex');
}

function migrationEvidence(readFileSyncImpl = fs.readFileSync) {
  return MIGRATIONS.map(({ name, file }) => Object.freeze({
    name,
    sha256: sha256File(file, readFileSyncImpl)
  }));
}

function parseCountOnlyJson(stdout, expectedKeys = null) {
  const candidates = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  if (candidates.length !== 1) {
    fail(
      'PAYMENT_MIGRATION_CLONE_OUTPUT_INVALID',
      'A clone-audit SQL check did not return one count-only JSON object.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(candidates[0]);
  } catch (_) {
    fail(
      'PAYMENT_MIGRATION_CLONE_OUTPUT_INVALID',
      'A clone-audit SQL check returned invalid JSON.'
    );
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    fail(
      'PAYMENT_MIGRATION_CLONE_OUTPUT_INVALID',
      'A clone-audit SQL check did not return a count-only JSON object.'
    );
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    fail(
      'PAYMENT_MIGRATION_CLONE_OUTPUT_INVALID',
      'A clone-audit SQL check returned an empty count object.'
    );
  }
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]*_count$/.test(key) || !Number.isSafeInteger(value) || value < 0) {
      fail(
        'PAYMENT_MIGRATION_CLONE_OUTPUT_INVALID',
        'A clone-audit SQL check returned a non-count value.'
      );
    }
  }
  if (expectedKeys) {
    const actualKeys = Object.keys(parsed).sort();
    const requiredKeys = [...expectedKeys].sort();
    if (
      actualKeys.length !== requiredKeys.length
      || actualKeys.some((key, index) => key !== requiredKeys[index])
    ) {
      fail(
        'PAYMENT_MIGRATION_CLONE_OUTPUT_SCHEMA_INVALID',
        'A clone-audit SQL check returned missing or unexpected count fields.'
      );
    }
  }
  return Object.freeze(parsed);
}

function runPsqlFile({
  file,
  config,
  expectCounts,
  expectedCountKeys = null,
  mutation,
  confirmDisposable,
  spawnSyncImpl = spawnSync,
  baseEnv = process.env
}) {
  if (mutation && !confirmDisposable) {
    fail(
      'PAYMENT_MIGRATION_CLONE_CONFIRMATION_REQUIRED',
      'Mutation SQL requires --confirm-disposable.'
    );
  }
  const args = [
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '--no-align',
    '--tuples-only',
    '--quiet',
    '--no-password',
    '--file',
    file
  ];
  const result = spawnSyncImpl('psql', args, {
    cwd: REPOSITORY_ROOT,
    env: childEnvironment(config, baseEnv),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 1024 * 1024
  });
  if (!result || result.error || result.signal || result.status !== 0) {
    fail(
      'PAYMENT_MIGRATION_CLONE_PSQL_STEP_FAILED',
      'A clone-audit database step failed; inspect the private operator log without copying row data or identifiers.'
    );
  }
  return expectCounts
    ? parseCountOnlyJson(result.stdout, expectedCountKeys)
    : null;
}

function assertZeroCounts(counts, keys, code) {
  if (keys.some((key) => counts[key] !== 0)) {
    fail(code, 'A count-only clone invariant blocked the rehearsal.');
  }
}

function manifestIsReady(counts) {
  return counts.manifest_table_count === 1
    && counts.manifest_row_count === counts.positive_legacy_balance_count
    && counts.manifest_missing_count === 0
    && counts.manifest_extra_count === 0
    && counts.manifest_total_mismatch_count === 0
    && counts.manifest_invalid_count === 0
    && counts.manifest_drift_count === 0
    && counts.manifest_guard_missing_count === 0;
}

function runPaymentMigrationCloneAudit(options = {}) {
  const confirmDisposable = options.confirmDisposable === true;
  const env = options.env || process.env;
  const config = readCloneConfig(env);
  const migrations = migrationEvidence(options.readFileSyncImpl || fs.readFileSync);
  let mutationStepCount = 0;
  let sideEffectsDisabled = false;

  const run = (file, {
    expectCounts = false,
    expectedCountKeys = null,
    mutation = false
  } = {}) => {
    const result = runPsqlFile({
      file,
      config,
      expectCounts,
      expectedCountKeys,
      mutation,
      confirmDisposable,
      spawnSyncImpl: options.spawnSyncImpl || spawnSync,
      baseEnv: env
    });
    if (mutation) mutationStepCount += 1;
    return result;
  };

  const preflight = run(SQL_FILES.preflight, {
    expectCounts: true,
    expectedCountKeys: PREFLIGHT_COUNT_KEYS
  });
  if (preflight.postgres_17_count !== 1) {
    fail(
      'PAYMENT_MIGRATION_CLONE_POSTGRES_VERSION_REJECTED',
      'The rehearsal requires PostgreSQL 17.'
    );
  }
  if (
    preflight.cron_extension_without_table_count !== 0
    || preflight.cron_extension_without_run_details_count !== 0
    || preflight.cron_external_database_active_count !== 0
    || preflight.cron_running_count !== 0
  ) {
    fail(
      'PAYMENT_MIGRATION_CLONE_ACTIVE_CRON_REJECTED',
      'Active or ambiguous clone cron state must be disabled and independently verified first.'
    );
  }

  if (preflight.cron_active_count !== 0) {
    if (!confirmDisposable) {
      fail(
        'PAYMENT_MIGRATION_CLONE_ACTIVE_CRON_REJECTED',
        'Active clone cron state requires an explicitly confirmed disposable target.'
      );
    }
    const sideEffectCounts = run(SQL_FILES.disableSideEffects, {
      expectCounts: true,
      expectedCountKeys: SIDE_EFFECT_COUNT_KEYS,
      mutation: true
    });
    assertZeroCounts(
      sideEffectCounts,
      SIDE_EFFECT_COUNT_KEYS,
      'PAYMENT_MIGRATION_CLONE_SIDE_EFFECT_DISABLE_FAILED'
    );
    sideEffectsDisabled = true;
    const verifiedPreflight = run(SQL_FILES.preflight, {
      expectCounts: true,
      expectedCountKeys: PREFLIGHT_COUNT_KEYS
    });
    if (
      verifiedPreflight.postgres_17_count !== 1
      || verifiedPreflight.cron_active_count !== 0
      || verifiedPreflight.cron_extension_without_table_count !== 0
      || verifiedPreflight.cron_extension_without_run_details_count !== 0
      || verifiedPreflight.cron_external_database_active_count !== 0
      || verifiedPreflight.cron_running_count !== 0
    ) {
      fail(
        'PAYMENT_MIGRATION_CLONE_ACTIVE_CRON_REJECTED',
        'Clone cron state was not safely disabled and reverified.'
      );
    }
  }

  let before = run(SQL_FILES.before, {
    expectCounts: true,
    expectedCountKeys: BEFORE_COUNT_KEYS
  });
  assertZeroCounts(
    before,
    BEFORE_ZERO_KEYS,
    'PAYMENT_MIGRATION_CLONE_BEFORE_INVARIANT_FAILED'
  );

  if (!confirmDisposable) {
    return Object.freeze({
      ok: true,
      complete: false,
      mode: 'read-only',
      mutation_step_count: 0,
      migration_count: migrations.length,
      migrations,
      preflight,
      before
    });
  }

  if (!sideEffectsDisabled) {
    const sideEffectCounts = run(SQL_FILES.disableSideEffects, {
      expectCounts: true,
      expectedCountKeys: SIDE_EFFECT_COUNT_KEYS,
      mutation: true
    });
    assertZeroCounts(
      sideEffectCounts,
      SIDE_EFFECT_COUNT_KEYS,
      'PAYMENT_MIGRATION_CLONE_SIDE_EFFECT_DISABLE_FAILED'
    );
  }

  if (before.manifest_table_count === 0) {
    run(MIGRATIONS[0].file, { mutation: true });
    before = run(SQL_FILES.before, {
      expectCounts: true,
      expectedCountKeys: BEFORE_COUNT_KEYS
    });
    assertZeroCounts(
      before,
      BEFORE_ZERO_KEYS,
      'PAYMENT_MIGRATION_CLONE_BEFORE_INVARIANT_FAILED'
    );
  }

  if (!manifestIsReady(before)) {
    return Object.freeze({
      ok: true,
      complete: false,
      mode: 'manifest-review-required',
      mutation_step_count: mutationStepCount,
      migration_count: migrations.length,
      migrations,
      preflight,
      before
    });
  }

  for (const migration of MIGRATIONS.slice(1)) {
    run(migration.file, { mutation: true });
  }
  const postMigrationPreflight = run(SQL_FILES.preflight, {
    expectCounts: true,
    expectedCountKeys: PREFLIGHT_COUNT_KEYS
  });
  if (
    postMigrationPreflight.postgres_17_count !== 1
    || postMigrationPreflight.cron_active_count !== 0
    || postMigrationPreflight.cron_extension_without_table_count !== 0
    || postMigrationPreflight.cron_extension_without_run_details_count !== 0
    || postMigrationPreflight.cron_external_database_active_count !== 0
    || postMigrationPreflight.cron_running_count !== 0
  ) {
    fail(
      'PAYMENT_MIGRATION_CLONE_POST_MIGRATION_PREFLIGHT_FAILED',
      'The post-migration clone preflight failed closed.'
    );
  }
  const after = run(SQL_FILES.after, {
    expectCounts: true,
    expectedCountKeys: AFTER_COUNT_KEYS
  });
  assertZeroCounts(
    after,
    AFTER_COUNT_KEYS,
    'PAYMENT_MIGRATION_CLONE_AFTER_INVARIANT_FAILED'
  );
  const aclRls = run(SQL_FILES.aclRls, {
    expectCounts: true,
    expectedCountKeys: ACL_RLS_COUNT_KEYS
  });
  assertZeroCounts(
    aclRls,
    ACL_RLS_COUNT_KEYS,
    'PAYMENT_MIGRATION_CLONE_ACL_RLS_FAILED'
  );

  return Object.freeze({
    ok: true,
    complete: true,
    mode: 'disposable-clone-rehearsal',
    mutation_step_count: mutationStepCount,
    migration_count: migrations.length,
    migrations,
    preflight,
    before,
    post_migration_preflight: postMigrationPreflight,
    after,
    acl_rls: aclRls
  });
}

function main(argv = process.argv.slice(2)) {
  return runPaymentMigrationCloneAudit(parseCliArguments(argv));
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(main(), null, 2));
  } catch (error) {
    const known = error instanceof PaymentMigrationCloneAuditError;
    console.error(JSON.stringify({
      ok: false,
      code: known ? error.code : 'PAYMENT_MIGRATION_CLONE_AUDIT_FAILED',
      message: known
        ? error.message
        : 'The clone audit stopped because of an internal error.'
    }));
    process.exitCode = 1;
  }
}

module.exports = {
  ACL_RLS_COUNT_KEYS,
  AFTER_COUNT_KEYS,
  BEFORE_ZERO_KEYS,
  BEFORE_COUNT_KEYS,
  DATABASE_URL_ENV,
  MIGRATIONS,
  PROJECT_REF_ENV,
  PRODUCTION_PROJECT_REF,
  PREFLIGHT_COUNT_KEYS,
  SIDE_EFFECT_COUNT_KEYS,
  SQL_FILES,
  PaymentMigrationCloneAuditError,
  childEnvironment,
  manifestIsReady,
  migrationEvidence,
  parseCliArguments,
  parseCountOnlyJson,
  readCloneConfig,
  runPaymentMigrationCloneAudit,
  runPsqlFile
};
