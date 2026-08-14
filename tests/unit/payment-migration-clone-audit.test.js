'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DATABASE_URL_ENV,
  MIGRATIONS,
  PRODUCTION_PROJECT_REF,
  PaymentMigrationCloneAuditError,
  parseCliArguments,
  parseCountOnlyJson,
  readCloneConfig,
  runPaymentMigrationCloneAudit,
  runPsqlFile
} = require('../../scripts/audit-payment-migration-clone');

const SECRET = 'local-clone-password-must-not-escape';
const BASE_ENV = Object.freeze({
  PATH: process.env.PATH,
  [DATABASE_URL_ENV]: `postgresql://clone_owner:${SECRET}@127.0.0.1:5432/promptgen_payment_clone`
});

const PREFLIGHT = Object.freeze({
  postgres_17_count: 1,
  cron_extension_count: 1,
  cron_table_count: 1,
  cron_extension_without_table_count: 0,
  cron_extension_without_run_details_count: 0,
  cron_total_count: 2,
  cron_active_count: 0,
  cron_external_database_active_count: 0,
  cron_running_count: 0
});

function beforeCounts(overrides = {}) {
  return {
    positive_legacy_balance_count: 0,
    negative_legacy_balance_count: 0,
    active_analysis_reservation_count: 0,
    active_storyboard_job_count: 0,
    paddle_identifier_drift_count: 0,
    subscription_without_customer_count: 0,
    subscription_invalid_plan_count: 0,
    manifest_table_count: 0,
    manifest_row_count: 0,
    manifest_missing_count: 0,
    manifest_extra_count: 0,
    manifest_total_mismatch_count: 0,
    manifest_invalid_count: 0,
    manifest_drift_count: 0,
    manifest_guard_missing_count: 0,
    migration_024_landmark_count: 0,
    ...overrides
  };
}

const AFTER = Object.freeze({
  profile_balance_mismatch_count: 0,
  credit_lot_state_violation_count: 0,
  credit_allocation_mismatch_count: 0,
  manifest_unconsumed_count: 0,
  manifest_backfill_mismatch_count: 0,
  active_analysis_reservation_count: 0,
  active_storyboard_job_count: 0,
  pending_event_lease_count: 0,
  open_credit_pack_request_count: 0,
  open_subscription_checkout_count: 0
});

const ACL_RLS = Object.freeze({
  missing_table_count: 0,
  rls_disabled_count: 0,
  table_owner_mismatch_count: 0,
  forbidden_table_grant_count: 0,
  private_schema_forbidden_grant_count: 0,
  private_schema_owner_mismatch_count: 0,
  missing_service_role_count: 0,
  missing_service_role_select_count: 0,
  missing_function_count: 0,
  insecure_function_count: 0,
  function_owner_mismatch_count: 0,
  forbidden_function_grant_count: 0,
  missing_service_role_execute_count: 0,
  forbidden_service_role_execute_count: 0
});

function mockPsql({
  preflight = PREFLIGHT,
  before = [beforeCounts()],
  after = AFTER,
  aclRls = ACL_RLS,
  failFile = null,
  failStderr = ''
} = {}) {
  let preflightIndex = 0;
  let beforeIndex = 0;
  const calls = [];
  const spawnSyncImpl = jest.fn((_command, args, options) => {
    const file = args[args.indexOf('--file') + 1];
    const name = path.basename(file);
    calls.push({ name, args, options });
    if (name === failFile) {
      return { status: 1, stdout: '', stderr: failStderr };
    }
    let counts = null;
    if (name === '00_preflight_readonly.sql') {
      counts = Array.isArray(preflight)
        ? preflight[Math.min(preflightIndex, preflight.length - 1)]
        : preflight;
      preflightIndex += 1;
    }
    if (name === '10_disable_clone_side_effects.sql') {
      counts = { cron_active_count: 0, side_effect_disable_failure_count: 0 };
    }
    if (name === '20_before_invariants.sql') {
      counts = before[Math.min(beforeIndex, before.length - 1)];
      beforeIndex += 1;
    }
    if (name === '80_after_invariants.sql') counts = after;
    if (name === '90_acl_rls_checks.sql') counts = aclRls;
    return {
      status: 0,
      stdout: counts ? `${JSON.stringify(counts)}\n` : '',
      stderr: ''
    };
  });
  return { calls, spawnSyncImpl };
}

describe('payment migration clone audit', () => {
  test('parses only the single explicit disposable confirmation switch', () => {
    expect(parseCliArguments([])).toEqual({ confirmDisposable: false });
    expect(parseCliArguments(['--confirm-disposable'])).toEqual({
      confirmDisposable: true
    });
    expect(() => parseCliArguments(['--apply'])).toThrow(
      PaymentMigrationCloneAuditError
    );
    expect(() => parseCliArguments([
      '--confirm-disposable', '--confirm-disposable'
    ])).toThrow(PaymentMigrationCloneAuditError);
  });

  test.each([
    [`postgresql://u:p@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/promptgen_clone`, {}],
    [`postgresql://u:p@127.0.0.1:5432/${PRODUCTION_PROJECT_REF}_clone`, {}],
    ['postgresql://u:p@10.0.0.8:5432/promptgen_clone', {}],
    ['postgresql://u:p@localhost:5432/postgres', {}],
    ['postgresql://u:p@host.docker.internal:5432/promptgen_clone', {}],
    ['postgresql://u:p@127.0.0.1:5432/promptgen_clone?sslmode=disable', {}],
    ['postgresql://u:p@127.0.0.1:5432/promptgen_clone#private', {}],
    [`postgresql://u:p@127.0.0.1:5432/${[...PRODUCTION_PROJECT_REF]
      .map((character) => `%${character.charCodeAt(0).toString(16)}`)
      .join('')}_clone`, {}]
  ])('rejects production, remote, and non-disposable targets before psql', (url, extra) => {
    const spawnSyncImpl = jest.fn();
    expect(() => runPaymentMigrationCloneAudit({
      env: { ...BASE_ENV, ...extra, [DATABASE_URL_ENV]: url },
      spawnSyncImpl
    })).toThrow(PaymentMigrationCloneAuditError);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  test('is read-only by default and never exposes the connection secret', () => {
    const mock = mockPsql();
    const result = runPaymentMigrationCloneAudit({
      env: BASE_ENV,
      spawnSyncImpl: mock.spawnSyncImpl
    });

    expect(result.mode).toBe('read-only');
    expect(result.mutation_step_count).toBe(0);
    expect(mock.calls.map(({ name }) => name)).toEqual([
      '00_preflight_readonly.sql',
      '20_before_invariants.sql'
    ]);
    for (const { args } of mock.calls) {
      expect(args).toEqual(expect.arrayContaining([
        '-X', '-v', 'ON_ERROR_STOP=1', '--no-password', '--file'
      ]));
      expect(JSON.stringify(args)).not.toContain(SECRET);
      expect(JSON.stringify(args)).not.toContain(BASE_ENV[DATABASE_URL_ENV]);
    }
    expect(mock.calls[0].options.env.PGOPTIONS).toContain('statement_timeout=300000');
    expect(mock.calls[0].options.env.PGOPTIONS).toContain('lock_timeout=5000');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('keeps every audit check read-only and the side-effect step confirmation-gated', () => {
    const sqlDirectory = path.resolve(
      __dirname,
      '../../scripts/sql/payment-migration-rehearsal'
    );
    for (const name of [
      '00_preflight_readonly.sql',
      '20_before_invariants.sql',
      '80_after_invariants.sql',
      '90_acl_rls_checks.sql'
    ]) {
      const sql = fs.readFileSync(path.join(sqlDirectory, name), 'utf8');
      expect(sql).toContain('BEGIN TRANSACTION READ ONLY;');
      expect(sql).toContain('jsonb_build_object(');
    }
    const sideEffects = fs.readFileSync(
      path.join(sqlDirectory, '10_disable_clone_side_effects.sql'),
      'utf8'
    );
    expect(sideEffects).toMatch(
      /UPDATE cron\.job[\s\S]*SET active = false[\s\S]*WHERE active[\s\S]*AND database = current_database\(\)/
    );
    expect(sideEffects).not.toMatch(
      /UPDATE cron\.job SET active = false WHERE active[';]/
    );
    expect(sideEffects).not.toMatch(/SELECT\s+\*/i);
  });

  test('fails closed on active cron before any later database call', () => {
    const mock = mockPsql({
      preflight: { ...PREFLIGHT, cron_active_count: 1 }
    });
    expect(() => runPaymentMigrationCloneAudit({
      env: BASE_ENV,
      spawnSyncImpl: mock.spawnSyncImpl
    })).toThrow(expect.objectContaining({
      code: 'PAYMENT_MIGRATION_CLONE_ACTIVE_CRON_REJECTED'
    }));
    expect(mock.calls.map(({ name }) => name)).toEqual([
      '00_preflight_readonly.sql'
    ]);
  });

  test('confirmed disposable mode disables active cron and reverifies it before reading rows', () => {
    const mock = mockPsql({
      preflight: [
        { ...PREFLIGHT, cron_active_count: 2 },
        PREFLIGHT,
        PREFLIGHT
      ],
      before: [
        beforeCounts(),
        beforeCounts({ manifest_table_count: 1 })
      ]
    });
    const result = runPaymentMigrationCloneAudit({
      env: BASE_ENV,
      confirmDisposable: true,
      spawnSyncImpl: mock.spawnSyncImpl
    });
    expect(result.complete).toBe(true);
    expect(mock.calls.slice(0, 4).map(({ name }) => name)).toEqual([
      '00_preflight_readonly.sql',
      '10_disable_clone_side_effects.sql',
      '00_preflight_readonly.sql',
      '20_before_invariants.sql'
    ]);
  });

  test('cross-database active cron fails before confirmed mode mutates anything', () => {
    const mock = mockPsql({
      preflight: {
        ...PREFLIGHT,
        cron_active_count: 1,
        cron_external_database_active_count: 1
      }
    });
    expect(() => runPaymentMigrationCloneAudit({
      env: BASE_ENV,
      confirmDisposable: true,
      spawnSyncImpl: mock.spawnSyncImpl
    })).toThrow(expect.objectContaining({
      code: 'PAYMENT_MIGRATION_CLONE_ACTIVE_CRON_REJECTED'
    }));
    expect(mock.calls.map(({ name }) => name)).toEqual([
      '00_preflight_readonly.sql'
    ]);
  });

  test('a running cron execution fails before confirmed mode mutates anything', () => {
    const mock = mockPsql({
      preflight: { ...PREFLIGHT, cron_running_count: 1 }
    });
    expect(() => runPaymentMigrationCloneAudit({
      env: BASE_ENV,
      confirmDisposable: true,
      spawnSyncImpl: mock.spawnSyncImpl
    })).toThrow(expect.objectContaining({
      code: 'PAYMENT_MIGRATION_CLONE_ACTIVE_CRON_REJECTED'
    }));
    expect(mock.calls.map(({ name }) => name)).toEqual([
      '00_preflight_readonly.sql'
    ]);
  });

  test('confirmed run applies only migration 023 before the reviewed manifest stop-line', () => {
    const mock = mockPsql({
      before: [
        beforeCounts({ positive_legacy_balance_count: 2 }),
        beforeCounts({
          positive_legacy_balance_count: 2,
          manifest_table_count: 1,
          manifest_missing_count: 2,
          manifest_total_mismatch_count: 1
        })
      ]
    });
    const result = runPaymentMigrationCloneAudit({
      env: BASE_ENV,
      confirmDisposable: true,
      spawnSyncImpl: mock.spawnSyncImpl
    });

    expect(result).toEqual(expect.objectContaining({
      complete: false,
      mode: 'manifest-review-required',
      mutation_step_count: 2
    }));
    expect(mock.calls.map(({ name }) => name)).toEqual([
      '00_preflight_readonly.sql',
      '20_before_invariants.sql',
      '10_disable_clone_side_effects.sql',
      '023_legacy_credit_classification_manifest.sql',
      '20_before_invariants.sql'
    ]);
  });

  test('confirmed resume runs 024 through 027 and count-only postchecks', () => {
    const ready = beforeCounts({
      positive_legacy_balance_count: 1,
      manifest_table_count: 1,
      manifest_row_count: 1
    });
    const mock = mockPsql({ before: [ready] });
    const result = runPaymentMigrationCloneAudit({
      env: BASE_ENV,
      confirmDisposable: true,
      spawnSyncImpl: mock.spawnSyncImpl
    });

    expect(result).toEqual(expect.objectContaining({
      complete: true,
      mode: 'disposable-clone-rehearsal',
      mutation_step_count: 5,
      migration_count: 5
    }));
    expect(mock.calls.map(({ name }) => name)).toEqual([
      '00_preflight_readonly.sql',
      '20_before_invariants.sql',
      '10_disable_clone_side_effects.sql',
      '024_credit_lot_ledger.sql',
      '025_paddle_event_ordering.sql',
      '026_secure_payment_requests.sql',
      '027_secure_subscription_checkout.sql',
      '00_preflight_readonly.sql',
      '80_after_invariants.sql',
      '90_acl_rls_checks.sql'
    ]);
    expect(result.migrations.map(({ name }) => name)).toEqual(
      MIGRATIONS.map(({ name }) => name)
    );
    for (const migration of result.migrations) {
      expect(migration.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('rejects mutation SQL without confirmation before spawning psql', () => {
    const spawnSyncImpl = jest.fn();
    expect(() => runPsqlFile({
      file: MIGRATIONS[0].file,
      config: readCloneConfig(BASE_ENV),
      expectCounts: false,
      mutation: true,
      confirmDisposable: false,
      spawnSyncImpl,
      baseEnv: BASE_ENV
    })).toThrow(expect.objectContaining({
      code: 'PAYMENT_MIGRATION_CLONE_CONFIRMATION_REQUIRED'
    }));
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  test('accepts only flat non-negative count JSON', () => {
    expect(parseCountOnlyJson('{"safe_count":2}\n')).toEqual({ safe_count: 2 });
    for (const unsafe of [
      '{}',
      '{"user_id":"00000000-0000-4000-8000-000000000000"}',
      '{"paddle_id":"txn_private"}',
      '{"email":"private@example.com"}',
      '{"safe_count":-1}',
      '{"safe_count":{"nested":1}}'
    ]) {
      expect(() => parseCountOnlyJson(unsafe)).toThrow(
        PaymentMigrationCloneAuditError
      );
    }
  });

  test('rejects missing and extra phase count fields', () => {
    expect(() => parseCountOnlyJson(
      '{"first_count":0}',
      ['first_count', 'second_count']
    )).toThrow(expect.objectContaining({
      code: 'PAYMENT_MIGRATION_CLONE_OUTPUT_SCHEMA_INVALID'
    }));
    expect(() => parseCountOnlyJson(
      '{"first_count":0,"second_count":0}',
      ['first_count']
    )).toThrow(expect.objectContaining({
      code: 'PAYMENT_MIGRATION_CLONE_OUTPUT_SCHEMA_INVALID'
    }));
  });

  test('ACL audit binds every granted runtime RPC by exact identity arguments', () => {
    const migrationSql = MIGRATIONS.slice(1)
      .map(({ file }) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    const aclSql = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../scripts/sql/payment-migration-rehearsal/90_acl_rls_checks.sql'
      ),
      'utf8'
    );
    const normalizeArguments = (value) => value
      .replace(/\s+/g, ' ')
      .replace(/\s*,\s*/g, ', ')
      .trim();
    const finalInternalOnly = new Set([
      'apply_plan_change',
      'expire_subscription_credits'
    ]);
    const expected = [...migrationSql.matchAll(
      /GRANT EXECUTE ON FUNCTION public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*TO service_role;/g
    )].map((match) => (
      `('${match[1]}', '${normalizeArguments(match[2])}', `
      + `${finalInternalOnly.has(match[1]) ? 'false' : 'true'})`
    ));
    const normalizedAcl = aclSql.replace(/\s+/g, ' ');

    expect(expected).toHaveLength(34);
    expect(aclSql).toContain('to_regprocedure(');
    for (const signature of expected) {
      expect(normalizedAcl).toContain(signature);
    }
    expect(normalizedAcl).toContain(
      "('apply_plan_change', 'uuid, text, integer', false)"
    );
    expect(normalizedAcl).toContain(
      "('expire_subscription_credits', 'uuid', false)"
    );
    const ownerOnlySignatures = [
      "('sync_credit_lot_balance', 'uuid', false)",
      "('consume_credit_lots', 'text, text, text, uuid, integer', false)",
      "('complete_credit_operation', 'text, uuid', false)",
      "('refund_credit_operation', 'text, uuid, text', false)",
      "('register_credit_pack_checkout_intent', 'text, uuid, text, text, text, text, integer, integer, text, integer', false)",
      "('apply_credit_pack_purchase', 'text, uuid, text, text, text, integer, integer, text, text, integer, timestamptz', false)",
      "('apply_credit_pack_adjustment', 'text, text, text, text, text', false)",
      "('apply_subscription_payment', 'text, uuid, text, integer, boolean', false)",
      "('bridge_legacy_subscription_cancellation', '', false)"
    ];
    for (const signature of ownerOnlySignatures) {
      expect(normalizedAcl).toContain(signature);
    }
    const expectedFunctionCte = aclSql.match(
      /expected_functions\([\s\S]*?\) AS \([\s\S]*?VALUES([\s\S]*?)\n\),\ntable_catalog/
    );
    expect(expectedFunctionCte).not.toBeNull();
    expect(expectedFunctionCte[1].match(/\('[a-z0-9_]+'/g)).toHaveLength(43);
    expect(aclSql).toContain("has_function_privilege('service_role'");
    expect(aclSql).toContain("'search_path=public, pg_temp'");
    expect(aclSql).not.toContain("LIKE '%search_path=public, pg_temp%'");
    expect(aclSql).toContain('a.grantee <> c.relowner');
    expect(aclSql).toContain('a.grantee <> c.proowner');
    expect(aclSql).toContain('a.grantee <> n.nspowner');
    expect(aclSql).toContain(
      "r.rolname IS NOT DISTINCT FROM 'service_role'"
    );
    expect(aclSql).toContain("r.rolname IS NOT DISTINCT FROM 'postgres'");
    expect(aclSql).toContain("c.schema_name = 'public'");
    expect(aclSql).toContain('a.grantor = c.relowner');
    expect(aclSql).toContain('a.grantor = c.proowner');
    expect(aclSql).toContain("'REFERENCES', 'TRIGGER', 'MAINTAIN'");
    expect(aclSql).not.toContain("r.rolname IN ('anon', 'authenticated')");
    expect(aclSql).not.toContain("'report_reader'");
  });

  test('sanitizes psql failures instead of echoing stderr, URLs, or row data', () => {
    const privateMarker = `private@example.com ${SECRET} txn_private`;
    const mock = mockPsql({
      failFile: '00_preflight_readonly.sql',
      failStderr: privateMarker
    });
    let error;
    try {
      runPaymentMigrationCloneAudit({
        env: BASE_ENV,
        spawnSyncImpl: mock.spawnSyncImpl
      });
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('PAYMENT_MIGRATION_CLONE_PSQL_STEP_FAILED');
    expect(JSON.stringify(error)).not.toContain(privateMarker);
    expect(error.message).not.toContain(SECRET);
  });
});
