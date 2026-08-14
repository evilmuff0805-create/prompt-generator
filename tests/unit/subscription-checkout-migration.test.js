'use strict';

const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  '..',
  'migrations',
  '027_secure_subscription_checkout.sql'
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
  test('fails fast instead of waiting indefinitely for migration locks', () => {
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
  });

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
      'SECURE_SUBSCRIPTION_CHECKOUT_REQUIRES_MIGRATION_025'
    );
    expect(sql).toContain(
      'SECURE_SUBSCRIPTION_CHECKOUT_REQUIRES_MIGRATION_026'
    );
  });

  test('creates an immutable server-bound checkout-attempt ledger', () => {
    expect(sql).toContain(
      'CREATE TABLE public.subscription_checkout_attempts'
    );
    expect(sql).toMatch(
      /attempt_id\s+UUID PRIMARY KEY[\s\S]{0,180}user_id\s+UUID[\s\S]{0,120}REFERENCES public\.profiles\(id\) ON DELETE SET NULL[\s\S]{0,120}authorized_user_id\s+UUID NOT NULL/
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
    for (const status of [
      'created',
      'charging',
      'bound',
      'provider_unknown',
      'reconciled_no_match',
      'account_deleted_review',
      'completed',
      'failed'
    ]) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toContain('provider_mutation_started_at TIMESTAMPTZ');
    expect(sql).toContain('provider_unknown_at  TIMESTAMPTZ');
    expect(sql).toContain(
      "provider_error_code = 'pre_provider_attempt_expired'"
    );
  });

  test('allows only one unresolved provider mutation per user', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX subscription_checkout_attempts_one_open_per_user_idx[\s\S]{0,180}ON public\.subscription_checkout_attempts \(authorized_user_id\)[\s\S]{0,120}WHERE status IN \('created', 'charging', 'bound', 'provider_unknown'\)/
    );
    expect(sql).toContain(
      'charging is persisted before the provider mutation'
    );
    expect(sql).toContain('both remain reconciliation-only');
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

  test('keeps reconciliation evidence and withheld receipts private and immutable', () => {
    expect(sql).toContain(
      'CREATE TABLE public.subscription_checkout_reconciliation_scans'
    );
    expect(sql).toContain(
      'CREATE TABLE public.subscription_checkout_late_payment_receipts'
    );
    expect(sql).toMatch(
      /attempt_id UUID NOT NULL\s+REFERENCES public\.subscription_checkout_attempts\(attempt_id\)\s+ON DELETE RESTRICT/
    );
    expect(sql).toContain(
      'user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL'
    );
    expect(sql).toContain(
      'subscription_checkout_reconciliation_scans_immutable'
    );
    expect(sql).toContain('subscription_checkout_late_receipts_immutable');
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.guard_subscription_checkout_late_receipt_mutation()'
    );
    expect(sql).toContain('AND pg_trigger_depth() > 1');
    expect(sql).toContain('AND OLD.user_id IS NOT NULL');
    expect(sql).toContain('AND NEW.user_id IS NULL');
    expect(sql).toContain(
      "(to_jsonb(NEW) - 'user_id')\n" +
      "           IS NOT DISTINCT FROM (to_jsonb(OLD) - 'user_id')"
    );
    expect(sql).toContain(
      'EXECUTE FUNCTION public.guard_subscription_checkout_late_receipt_mutation();'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.guard_subscription_checkout_late_receipt_mutation()\n' +
      '  FROM PUBLIC, anon, authenticated, service_role;'
    );
    for (const tableName of [
      'subscription_checkout_reconciliation_scans',
      'subscription_checkout_late_payment_receipts'
    ]) {
      expect(sql).toContain(
        `ALTER TABLE public.${tableName}\n  ENABLE ROW LEVEL SECURITY;`
      );
      expect(sql).toContain(
        `REVOKE ALL ON TABLE public.${tableName}\n` +
        '  FROM PUBLIC, anon, authenticated, service_role;'
      );
      expect(sql).toContain(
        `GRANT SELECT ON TABLE public.${tableName}\n  TO service_role;`
      );
    }
    expect(sql).not.toMatch(
      /GRANT\s+(?:[A-Z]+\s*,\s*)*(?:INSERT|UPDATE|DELETE)(?:\s*,\s*[A-Z]+)*\s+ON TABLE public\.subscription_checkout_(?:reconciliation_scans|late_payment_receipts) TO service_role;/i
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
    for (const functionName of [
      'record_subscription_checkout_no_match_scan',
      'finalize_subscription_checkout_no_match'
    ]) {
      expect(normalizedSql).toContain(
        `CREATE OR REPLACE FUNCTION public.${functionName}( ` +
        'p_attempt_id uuid, p_expected_status text, p_checked_at timestamptz, ' +
        'p_window_start timestamptz, p_window_end timestamptz, ' +
        'p_pages_scanned integer, p_transactions_scanned integer, ' +
        'p_provider_request_ids text[], p_catalog_request_id text, ' +
        'p_contract_fingerprint text, p_evidence_hash text, ' +
        'p_audit_reference text ) RETURNS jsonb'
      );
    }
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
      '   WHERE authorized_user_id = p_user_id'
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
      "v_existing.status = 'created'"
    );
    expect(createSql).toContain(
      "v_existing.created_at + interval '15 minutes'"
    );
    expect(createSql).toContain(
      "provider_error_code = 'pre_provider_attempt_expired'"
    );
    expect(createSql).toContain("AND status = 'created'");
    expect(createSql).toContain(
      "status IN ('created', 'charging', 'bound', 'provider_unknown')"
    );
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
      "AND status IN ('charging', 'provider_unknown')"
    );
    expect(bindSql).toContain(
      'SUBSCRIPTION_CHECKOUT_PROVIDER_MUTATION_NOT_STARTED'
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

  test('persists provider-mutation start and never TTL-releases provider work', () => {
    const transitionSql = functionSlice(
      'transition_subscription_checkout_attempt',
      'record_subscription_checkout_no_match_scan'
    );

    expect(transitionSql).toContain(
      "v_status NOT IN ('charging', 'provider_unknown', 'failed')"
    );
    expect(transitionSql).toContain(
      "IF v_attempt.status = 'created' AND v_status <> 'charging' THEN"
    );
    expect(transitionSql).toContain(
      "IF v_attempt.status = 'charging' AND v_status = 'charging' THEN"
    );
    expect(transitionSql).toContain(
      'SUBSCRIPTION_CHECKOUT_ATTEMPT_RECONCILIATION_REQUIRED'
    );
    expect(transitionSql).toMatch(
      /IF v_attempt\.status = 'provider_unknown' THEN[\s\S]{0,500}SUBSCRIPTION_CHECKOUT_ATTEMPT_RECONCILIATION_REQUIRED/
    );
    expect(transitionSql).toContain(
      "THEN COALESCE(provider_mutation_started_at, clock_timestamp())"
    );
    expect(transitionSql).toContain(
      "THEN COALESCE(provider_unknown_at, clock_timestamp())"
    );
    expect(transitionSql).toContain("'reason', CASE");
    expect(transitionSql).toContain("'provider_mutation_started'");
  });

  test('freezes charging status after scan one while preserving value-bearing paths', () => {
    const bindSql = functionSlice(
      'bind_subscription_checkout_transaction',
      'transition_subscription_checkout_attempt'
    );
    const transitionSql = functionSlice(
      'transition_subscription_checkout_attempt',
      'record_subscription_checkout_no_match_scan'
    );
    const consumeSql = functionSlice(
      'consume_subscription_checkout_attempt',
      'resolve_completed_subscription_checkout'
    );
    const chargingDuplicate = transitionSql.indexOf(
      "v_attempt.status = 'charging' AND v_status = 'charging'"
    );
    const scanGuard = transitionSql.indexOf(
      "'reason', 'reconciliation_scan_in_progress'"
    );
    const transitionUpdate = transitionSql.indexOf(
      'UPDATE public.subscription_checkout_attempts'
    );

    expect(transitionSql).toContain(
      "v_attempt.status = 'charging'\n" +
      "     AND v_status IN ('provider_unknown', 'failed')"
    );
    expect(transitionSql).toContain(
      'FROM public.subscription_checkout_reconciliation_scans'
    );
    expect(transitionSql).toContain('AND scan_ordinal = 1');
    expect(chargingDuplicate).toBeGreaterThan(-1);
    expect(scanGuard).toBeGreaterThan(chargingDuplicate);
    expect(transitionUpdate).toBeGreaterThan(scanGuard);
    expect(bindSql).not.toContain('reconciliation_scan_in_progress');
    expect(bindSql).toContain(
      "AND status IN ('charging', 'provider_unknown')"
    );
    expect(consumeSql).not.toContain('reconciliation_scan_in_progress');
    expect(consumeSql).toContain("v_attempt.status = 'reconciled_no_match'");
    expect(transitionSql).toContain(
      "v_attempt.status = 'charging'\n     AND v_status NOT IN ('provider_unknown', 'failed')"
    );
  });

  test('requires two fresh independent full-window scans before final close', () => {
    const firstSql = functionSlice(
      'record_subscription_checkout_no_match_scan',
      'finalize_subscription_checkout_no_match'
    );
    const finalSql = functionSlice(
      'finalize_subscription_checkout_no_match',
      'consume_subscription_checkout_attempt'
    );

    for (const rpcSql of [firstSql, finalSql]) {
      expect(rpcSql).toContain(
        "p_checked_at < v_now - interval '2 minutes'"
      );
      expect(rpcSql).toContain(
        'COALESCE(cardinality(p_provider_request_ids), 0) <>'
      );
      expect(rpcSql).toContain(
        'p_transactions_scanned::bigint > p_pages_scanned::bigint * 30'
      );
      expect(rpcSql).toContain(
        "v_provider_request_id = v_catalog_request_id"
      );
      expect(rpcSql).toContain(
        'v_catalog_request_id IS DISTINCT FROM lower(v_catalog_request_id)'
      );
      expect(rpcSql).toContain(
        'IS DISTINCT FROM lower(v_provider_request_id)'
      );
    }
    expect(firstSql).toContain(
      'COALESCE(\n        v_attempt.provider_unknown_at,\n' +
      '        v_attempt.provider_mutation_started_at\n      )'
    );
    expect(firstSql).toContain(
      "p_checked_at < v_reconciliation_started_at + interval '72 hours'"
    );
    expect(firstSql).toContain('p_window_start > v_attempt.created_at');
    expect(firstSql).toContain("'reconciliation_scan_recorded'");
    expect(firstSql).toContain('RETURNING recorded_at INTO v_recorded_at');
    expect(firstSql).toContain("'firstRecordedAt', v_existing.recorded_at");
    expect(firstSql).toContain("'firstRecordedAt', v_recorded_at");
    expect(firstSql).not.toContain(
      "SET status = 'reconciled_no_match'"
    );

    expect(finalSql).toContain(
      'p_checked_at <\n' +
      '          GREATEST(v_first.checked_at, v_first.recorded_at)'
    );
    expect(finalSql).toContain("interval '24 hours'");
    expect(finalSql).toContain(
      'v_first.expected_status IS DISTINCT FROM v_expected_status'
    );
    expect(finalSql).toContain(
      'v_first.contract_fingerprint IS DISTINCT FROM v_contract_fingerprint'
    );
    expect(finalSql).toContain(
      'v_first.provider_request_ids && p_provider_request_ids'
    );
    expect(finalSql).toContain(
      'SUBSCRIPTION_CHECKOUT_RECONCILIATION_SCANS_NOT_INDEPENDENT'
    );
    const secondEvidence = finalSql.indexOf(
      'INSERT INTO public.subscription_checkout_reconciliation_scans'
    );
    const closeAttempt = finalSql.indexOf(
      'UPDATE public.subscription_checkout_attempts'
    );
    expect(secondEvidence).toBeGreaterThan(-1);
    expect(closeAttempt).toBeGreaterThan(secondEvidence);
    expect(finalSql).toContain("SET status = 'reconciled_no_match'");
    expect(finalSql).toContain(
      "provider_error_code = 'reconciled_definitive_no_match'"
    );
    expect(finalSql).toContain('AND status = v_expected_status');
    expect(finalSql).toContain(
      'SUBSCRIPTION_CHECKOUT_RECONCILIATION_CAS_RACE'
    );
    expect(finalSql).toContain("'reason', 'attempt_reconciled_no_match'");
    expect(finalSql).toContain("'reconciliationDecision', 'definitive_no_match'");
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

  test('withholds late final-close payments while preserving the terminal attempt', () => {
    const consumeSql = functionSlice(
      'consume_subscription_checkout_attempt',
      'resolve_completed_subscription_checkout'
    );
    const lateStart = consumeSql.indexOf(
      "IF v_attempt.status = 'reconciled_no_match' THEN"
    );
    const lateEnd = consumeSql.indexOf(
      "IF v_attempt.status IN ('failed', 'account_deleted_review') THEN",
      lateStart
    );
    const lateSql = consumeSql.slice(lateStart, lateEnd);

    expect(lateStart).toBeGreaterThan(-1);
    expect(lateEnd).toBeGreaterThan(lateStart);
    expect(lateSql).toMatch(
      /public\.apply_ordered_subscription_payment\([\s\S]{0,320}p_completed_at,\s+true,\s+false\s+\)/
    );
    expect(lateSql).toContain('refund_review_required = true');
    expect(lateSql).toContain(
      "refund_review_reason =\n             'late_payment_after_reconciled_no_match'"
    );
    expect(lateSql).toContain(
      'INSERT INTO public.subscription_checkout_late_payment_receipts'
    );
    expect(lateSql).not.toContain(
      'UPDATE public.subscription_checkout_attempts'
    );
    for (const field of [
      "'authorizedUserId'",
      "'userId'",
      "'refundReviewRequired', true",
      "'withheldReason', 'late_payment_after_reconciled_no_match'",
      "'transactionId'",
      "'subscriptionId'"
    ]) {
      expect(lateSql).toContain(field);
    }
  });

  test('tombstones account-deleted completions without granting entitlement', () => {
    const consumeSql = functionSlice(
      'consume_subscription_checkout_attempt',
      'resolve_completed_subscription_checkout'
    );
    const deletedStart = consumeSql.indexOf(
      'IF v_attempt_snapshot.user_id IS NULL THEN'
    );
    const deletedEnd = consumeSql.indexOf(
      "SELECT NULLIF(btrim(p.paddle_subscription_id), '')",
      deletedStart
    );
    const deletedSql = consumeSql.slice(deletedStart, deletedEnd);

    expect(deletedStart).toBeGreaterThan(-1);
    expect(deletedEnd).toBeGreaterThan(deletedStart);
    expect(deletedSql).toContain("'completed_before_account_deleted'");
    expect(deletedSql).toContain("'authorizedUserId'");
    expect(deletedSql).toContain("'userId', NULL");
    expect(deletedSql).toContain("'refundReviewRequired', false");
    expect(deletedSql).toContain(
      'IF v_attempt.provider_mutation_started_at IS NULL THEN'
    );
    expect(deletedSql).toContain(
      'SUBSCRIPTION_CHECKOUT_PROVIDER_MUTATION_NOT_STARTED'
    );
    expect(deletedSql).toContain(
      'INSERT INTO public.subscription_checkout_late_payment_receipts'
    );
    expect(deletedSql).toContain("status = 'account_deleted_review'");
    expect(deletedSql).toContain(
      "provider_error_code = 'payment_after_account_deleted'"
    );
    expect(deletedSql).toContain(
      "AND status IN (\n             'charging',\n" +
      "             'bound',\n             'provider_unknown',\n" +
      "             'failed'\n           )"
    );
    expect(deletedSql).not.toContain("'created',\n             'charging'");
    expect(deletedSql).not.toContain(
      'public.apply_ordered_subscription_payment('
    );
    expect(deletedSql).not.toContain(
      'v_late_receipt.account_deleted IS DISTINCT FROM true'
    );
    expect(deletedSql).toContain(
      "'status', CASE\n          WHEN v_late_receipt.decision_reason ="
    );
    for (const field of [
      "'authorizedUserId'",
      "'userId', NULL",
      "'refundReviewRequired', true",
      "'withheldReason', v_review_reason",
      "'transactionId'",
      "'subscriptionId'"
    ]) {
      expect(deletedSql).toContain(field);
    }
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
      '   FOR UPDATE;',
      profileLock
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
    const paymentCall = consumeSql.lastIndexOf(
      'public.apply_ordered_subscription_payment('
    );
    const purchaseBinding = consumeSql.indexOf(
      'UPDATE public.purchases',
      paymentCall
    );
    const profileBinding = consumeSql.indexOf(
      'UPDATE public.profiles',
      purchaseBinding
    );
    const attemptCompletion = consumeSql.indexOf(
      'UPDATE public.subscription_checkout_attempts',
      profileBinding
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
      "AND status IN ('charging', 'bound', 'provider_unknown')"
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
      'record_subscription_checkout_no_match_scan',
      'finalize_subscription_checkout_no_match',
      'consume_subscription_checkout_attempt',
      'resolve_completed_subscription_checkout'
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\([\\s\\S]*?\\) ` +
          'FROM PUBLIC, anon, authenticated, service_role;'
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
      'Reconcile every created/charging/bound/provider_unknown attempt in Paddle.'
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
