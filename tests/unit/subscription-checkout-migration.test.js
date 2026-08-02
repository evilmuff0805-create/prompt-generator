'use strict';

const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  '..',
  'migrations',
  '026_secure_subscription_checkout.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');
const normalizedSql = sql.replace(/\s+/g, ' ');

function functionSlice(functionName, nextFunctionName) {
  const start = sql.indexOf(
    `CREATE OR REPLACE FUNCTION public.${functionName}`
  );
  const end = nextFunctionName
    ? sql.indexOf(`CREATE OR REPLACE FUNCTION public.${nextFunctionName}`)
    : sql.indexOf('REVOKE ALL ON FUNCTION public.create_subscription_checkout_attempt');

  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Unable to isolate ${functionName} SQL`);
  }
  return sql.slice(start, end);
}

describe('secure subscription checkout migration', () => {
  test('preflights the ordered reducer and prior secure-payment migration', () => {
    expect(sql).toContain(
      "to_regclass('public.paddle_subscription_states')"
    );
    expect(sql).toContain(
      "'public.apply_ordered_subscription_payment(text,uuid,text,integer,text,text,timestamptz,boolean,boolean)'"
    );
    expect(sql).toContain(
      "to_regclass('public.credit_pack_purchase_requests')"
    );
    expect(sql).toContain(
      'SECURE_SUBSCRIPTION_CHECKOUT_REQUIRES_MIGRATION_024'
    );
    expect(sql).toContain(
      'SECURE_SUBSCRIPTION_CHECKOUT_REQUIRES_MIGRATION_025'
    );
  });

  test('creates an immutable server-bound checkout-attempt ledger', () => {
    expect(sql).toContain(
      'CREATE TABLE public.subscription_checkout_attempts'
    );
    expect(sql).toMatch(
      /attempt_id\s+UUID PRIMARY KEY[\s\S]{0,180}user_id\s+UUID NOT NULL[\s\S]{0,120}REFERENCES public\.profiles\(id\) ON DELETE CASCADE/
    );
    expect(sql).toContain('transaction_id       TEXT UNIQUE');
    expect(sql).toContain('subscription_id      TEXT UNIQUE');
    expect(sql).toContain(
      "CHECK (target_plan IN ('pro', 'enterprise'))"
    );
    expect(sql).toContain(
      "expected_origin      TEXT NOT NULL DEFAULT 'api'"
    );
    expect(sql).toContain("CHECK (expected_origin = 'api')");
    expect(sql).toContain('credits              INTEGER NOT NULL CHECK (credits > 0)');
    expect(sql).not.toContain(
      'CONSTRAINT subscription_checkout_attempts_plan_credit_check'
    );
    expect(sql).toContain(
      "'created',\n                           'bound',\n                           'provider_unknown',\n                           'completed',\n                           'failed'"
    );
  });

  test('allows only one unresolved provider mutation per user', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX subscription_checkout_attempts_one_open_per_user_idx[\s\S]{0,180}ON public\.subscription_checkout_attempts \(user_id\)[\s\S]{0,120}WHERE status IN \('created', 'bound', 'provider_unknown'\)/
    );
    expect(sql).toContain(
      'A provider_unknown attempt may already have created a transaction'
    );
    expect(sql).toContain('it is never automatically retried');
  });

  test('makes the table read-only to service_role with all writes behind RPCs', () => {
    expect(sql).toContain(
      'ALTER TABLE public.subscription_checkout_attempts ENABLE ROW LEVEL SECURITY;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.subscription_checkout_attempts\n' +
      '  FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(sql).toContain(
      'GRANT SELECT\n' +
      '  ON TABLE public.subscription_checkout_attempts TO service_role;'
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:[A-Z]+\s*,\s*)*(?:INSERT|UPDATE|DELETE)(?:\s*,\s*[A-Z]+)*\s+ON TABLE public\.subscription_checkout_attempts TO service_role;/i
    );
    expect(sql).toContain('Every write must pass through the SECURITY DEFINER RPCs');
    expect(sql).not.toMatch(
      /CREATE POLICY[\s\S]{0,180}subscription_checkout_attempts/
    );
  });

  test('publishes exact request-first RPC signatures', () => {
    expect(normalizedSql).toContain(
      'CREATE OR REPLACE FUNCTION public.create_subscription_checkout_attempt( ' +
      'p_attempt_id uuid, p_user_id uuid, p_target_plan text, p_price_id text, ' +
      'p_credits integer, p_unit_amount integer, p_currency_code text ) RETURNS jsonb'
    );
    expect(normalizedSql).toContain(
      'CREATE OR REPLACE FUNCTION public.bind_subscription_checkout_transaction( ' +
      'p_attempt_id uuid, p_user_id uuid, p_transaction_id text, p_origin text, ' +
      'p_plan text, p_price_id text, p_credits integer, p_unit_amount integer, ' +
      'p_currency_code text, p_quantity integer ) RETURNS jsonb'
    );
    expect(normalizedSql).toContain(
      'CREATE OR REPLACE FUNCTION public.transition_subscription_checkout_attempt( ' +
      'p_attempt_id uuid, p_user_id uuid, p_status text, ' +
      'p_provider_error_code text ) RETURNS jsonb'
    );
    expect(normalizedSql).toContain(
      'CREATE OR REPLACE FUNCTION public.consume_subscription_checkout_attempt( ' +
      'p_attempt_id uuid, p_transaction_id text, p_subscription_id text, ' +
      'p_customer_id text, p_origin text, p_transaction_status text, ' +
      'p_plan text, p_price_id text, p_credits integer, p_unit_amount integer, ' +
      'p_currency_code text, p_quantity integer, p_completed_at timestamptz, ' +
      'p_skip_entitlement_mutation boolean ) RETURNS jsonb'
    );
    expect(normalizedSql).toContain(
      'CREATE OR REPLACE FUNCTION public.resolve_completed_subscription_checkout( ' +
      'p_attempt_id uuid, p_subscription_id text, p_customer_id text, ' +
      'p_plan text, p_price_id text ) RETURNS jsonb'
    );
  });

  test('creates the attempt before provider work and deduplicates reloads', () => {
    const createSql = functionSlice(
      'create_subscription_checkout_attempt',
      'bind_subscription_checkout_transaction'
    );

    expect(createSql).toContain(
      'SUBSCRIPTION_CHECKOUT_CONTRACT_MISMATCH'
    );
    const stateLock = createSql.indexOf(
      'FROM public.paddle_subscription_states'
    );
    const profileLock = createSql.indexOf(
      'FROM public.profiles\n   WHERE id = p_user_id\n   FOR UPDATE;'
    );
    const attemptLock = createSql.indexOf(
      'FROM public.subscription_checkout_attempts\n' +
      '   WHERE user_id = p_user_id'
    );
    expect(stateLock).toBeGreaterThan(-1);
    expect(profileLock).toBeGreaterThan(stateLock);
    expect(attemptLock).toBeGreaterThan(profileLock);
    expect(createSql).toContain('ACTIVE_SUBSCRIPTION_ALREADY_EXISTS');
    expect(createSql).toContain(
      'SUBSCRIPTION_PROFILE_RECONCILIATION_REQUIRED'
    );
    expect(createSql).toContain("'reason', 'duplicate_pending'");
    expect(createSql).toContain(
      'INSERT INTO public.subscription_checkout_attempts'
    );
    expect(createSql).toContain('EXCEPTION WHEN unique_violation THEN');
  });

  test('binds one API-created transaction and permits unknown-outcome reconciliation', () => {
    const bindSql = functionSlice(
      'bind_subscription_checkout_transaction',
      'transition_subscription_checkout_attempt'
    );

    expect(bindSql).toContain("IF v_origin <> 'api' THEN");
    expect(bindSql).toContain('SUBSCRIPTION_CHECKOUT_ORIGIN_REJECTED');
    const stateLock = bindSql.indexOf(
      'FROM public.paddle_subscription_states'
    );
    const profileLock = bindSql.indexOf(
      'FROM public.profiles\n   WHERE id = p_user_id\n   FOR UPDATE;'
    );
    const attemptLock = bindSql.indexOf(
      'FROM public.subscription_checkout_attempts\n' +
      '   WHERE attempt_id = p_attempt_id\n' +
      '   FOR UPDATE;'
    );
    expect(stateLock).toBeGreaterThan(-1);
    expect(profileLock).toBeGreaterThan(stateLock);
    expect(attemptLock).toBeGreaterThan(profileLock);
    expect(bindSql).toContain(
      "AND status IN ('created', 'provider_unknown')"
    );
    expect(bindSql).toContain(
      'SUBSCRIPTION_CHECKOUT_TRANSACTION_CONFLICT'
    );
    expect(bindSql).toContain('p_quantity IS DISTINCT FROM 1');
    expect(bindSql).toMatch(
      /v_attempt\.target_plan IS DISTINCT FROM v_plan[\s\S]{0,220}v_attempt\.price_id IS DISTINCT FROM v_price_id[\s\S]{0,220}v_attempt\.unit_amount IS DISTINCT FROM p_unit_amount/
    );
    expect(bindSql).toContain('EXCEPTION WHEN unique_violation THEN');
  });

  test('never releases a provider-unknown or bound attempt automatically', () => {
    const transitionSql = functionSlice(
      'transition_subscription_checkout_attempt',
      'consume_subscription_checkout_attempt'
    );

    expect(transitionSql).toContain(
      "v_status NOT IN ('provider_unknown', 'failed')"
    );
    expect(transitionSql).toContain(
      "IF v_attempt.status IN ('bound', 'completed') THEN"
    );
    expect(transitionSql).toContain(
      'SUBSCRIPTION_CHECKOUT_ATTEMPT_RECONCILIATION_REQUIRED'
    );
    expect(transitionSql).toMatch(
      /IF v_attempt\.status = 'provider_unknown' THEN[\s\S]{0,500}SUBSCRIPTION_CHECKOUT_ATTEMPT_RECONCILIATION_REQUIRED/
    );
    expect(transitionSql).toContain(
      "AND status = 'created'"
    );
  });

  test('fails closed for direct web/checkout transactions and mismatched items', () => {
    const consumeSql = functionSlice(
      'consume_subscription_checkout_attempt',
      'resolve_completed_subscription_checkout'
    );

    expect(consumeSql).toContain("IF v_origin <> 'api' THEN");
    expect(consumeSql).toContain(
      'SUBSCRIPTION_CHECKOUT_ORIGIN_REJECTED'
    );
    expect(consumeSql).toContain(
      "IF v_transaction_status <> 'completed' THEN"
    );
    expect(consumeSql).toContain('p_quantity IS DISTINCT FROM 1');
    expect(consumeSql).toContain(
      'UNBOUND_SUBSCRIPTION_CHECKOUT_TRANSACTION'
    );
    expect(consumeSql).toMatch(
      /v_attempt\.target_plan IS DISTINCT FROM v_plan[\s\S]{0,220}v_attempt\.price_id IS DISTINCT FROM v_price_id[\s\S]{0,220}v_attempt\.unit_amount IS DISTINCT FROM p_unit_amount/
    );
    expect(consumeSql).not.toContain('custom_data.userId');
    expect(consumeSql).not.toContain('p_user_id');
  });

  test('locks lifecycle rows deterministically before profile and attempt', () => {
    const consumeSql = functionSlice(
      'consume_subscription_checkout_attempt',
      'resolve_completed_subscription_checkout'
    );
    const stateLock = consumeSql.indexOf(
      'FROM public.paddle_subscription_states s'
    );
    const profileLock = consumeSql.indexOf(
      'FROM public.profiles\n   WHERE id = v_attempt_snapshot.user_id\n   FOR UPDATE;'
    );
    const attemptLock = consumeSql.indexOf(
      'FROM public.subscription_checkout_attempts\n' +
      '   WHERE attempt_id = p_attempt_id\n' +
      '   FOR UPDATE;'
    );

    expect(stateLock).toBeGreaterThan(-1);
    expect(consumeSql.slice(stateLock, profileLock)).toContain(
      'ORDER BY s.subscription_id'
    );
    expect(consumeSql.slice(stateLock, profileLock)).toContain('FOR UPDATE;');
    expect(profileLock).toBeGreaterThan(stateLock);
    expect(attemptLock).toBeGreaterThan(profileLock);
  });

  test('atomically records the ordered payment, profile binding, and attempt completion', () => {
    const consumeSql = functionSlice(
      'consume_subscription_checkout_attempt',
      'resolve_completed_subscription_checkout'
    );
    const paymentCall = consumeSql.indexOf(
      'public.apply_ordered_subscription_payment('
    );
    const purchaseBinding = consumeSql.indexOf(
      'UPDATE public.purchases'
    );
    const profileBinding = consumeSql.indexOf(
      'UPDATE public.profiles'
    );
    const attemptCompletion = consumeSql.indexOf(
      'UPDATE public.subscription_checkout_attempts'
    );

    expect(paymentCall).toBeGreaterThan(-1);
    expect(consumeSql).toMatch(
      /public\.apply_ordered_subscription_payment\([\s\S]{0,320}p_completed_at,\s+COALESCE\(p_skip_entitlement_mutation, false\),\s+true\s+\)/
    );
    expect(purchaseBinding).toBeGreaterThan(paymentCall);
    expect(profileBinding).toBeGreaterThan(purchaseBinding);
    expect(attemptCompletion).toBeGreaterThan(profileBinding);
    expect(consumeSql).toContain(
      'SUBSCRIPTION_CHECKOUT_LEDGER_BINDING_CONFLICT'
    );
    expect(consumeSql).toContain(
      "AND status IN ('created', 'bound', 'provider_unknown')"
    );
    expect(consumeSql).toContain(
      'SUBSCRIPTION_CHECKOUT_LEDGER_INVARIANT_FAILED'
    );
  });

  test('completes against the immutable stored credit contract across later catalog changes', () => {
    const consumeSql = functionSlice(
      'consume_subscription_checkout_attempt',
      'resolve_completed_subscription_checkout'
    );

    expect(consumeSql).toContain(
      'v_attempt.credits IS DISTINCT FROM p_credits'
    );
    expect(consumeSql).toContain('v_attempt.credits,');
    expect(consumeSql).not.toContain(
      "(v_plan = 'pro' AND p_credits = 600)"
    );
    expect(consumeSql).not.toContain(
      "(v_plan = 'enterprise' AND p_credits = 1500)"
    );
  });

  test('allows resubscription only after the previous lifecycle is terminal', () => {
    const consumeSql = functionSlice(
      'consume_subscription_checkout_attempt',
      'resolve_completed_subscription_checkout'
    );

    expect(consumeSql).toMatch(
      /v_current_profile_subscription <> v_subscription_id[\s\S]{0,500}FROM public\.paddle_subscription_states[\s\S]{0,300}NOT v_previous_state\.terminal[\s\S]{0,180}ACTIVE_SUBSCRIPTION_ALREADY_EXISTS/
    );
    expect(consumeSql).toContain(
      'SUBSCRIPTION_PROFILE_RECONCILIATION_REQUIRED'
    );
    expect(consumeSql).toContain('PADDLE_CUSTOMER_USER_CONFLICT');
  });

  test('blocks early subscription snapshots until origin-verified completion', () => {
    const resolveSql = functionSlice(
      'resolve_completed_subscription_checkout',
      null
    );

    expect(resolveSql).toContain(
      "IF v_attempt_snapshot.status <> 'completed' THEN"
    );
    expect(resolveSql).toContain('SUBSCRIPTION_CHECKOUT_NOT_COMPLETED');
    expect(resolveSql).toMatch(
      /FROM public\.paddle_subscription_states[\s\S]{0,120}FOR UPDATE;[\s\S]{0,220}FROM public\.profiles[\s\S]{0,120}FOR UPDATE;[\s\S]{0,220}FROM public\.subscription_checkout_attempts[\s\S]{0,120}FOR UPDATE;/
    );
    expect(resolveSql).toContain("v_attempt.expected_origin <> 'api'");
    expect(resolveSql).toContain(
      'SUBSCRIPTION_CHECKOUT_RESOLUTION_CONFLICT'
    );
  });

  test('pins all privileged RPCs to service_role only', () => {
    for (const functionName of [
      'create_subscription_checkout_attempt',
      'bind_subscription_checkout_transaction',
      'transition_subscription_checkout_attempt',
      'consume_subscription_checkout_attempt',
      'resolve_completed_subscription_checkout'
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\([\\s\\S]*?\\) ` +
          'FROM PUBLIC, anon, authenticated;'
        )
      );
      expect(sql).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([\\s\\S]*?\\) ` +
          'TO service_role;'
        )
      );
    }
  });

  test('documents a gated reverse migration without automatic data loss', () => {
    expect(sql).toContain('Reverse migration (operator-run only):');
    expect(sql).toContain(
      'Reconcile every created/bound/provider_unknown attempt in Paddle.'
    );
    expect(sql).toContain(
      'Preserve/export completed rows for the payment audit trail.'
    );
    expect(sql).toContain(
      '-- DROP TABLE public.subscription_checkout_attempts;'
    );
    expect(sql).not.toMatch(
      /^DROP TABLE public\.subscription_checkout_attempts;/m
    );
  });
});
