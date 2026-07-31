'use strict';

const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  '..',
  'migrations',
  '024_paddle_event_ordering.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');
const normalizedSql = sql.replace(/\s+/g, ' ');

describe('Paddle subscription state migration safety contract', () => {
  test('keeps immutable event watermarks separate from subscription snapshots', () => {
    expect(sql).toContain('CREATE TABLE public.paddle_event_watermarks');
    expect(sql).toContain("CHECK (entity_type IN ('transaction', 'adjustment'))");
    expect(sql).not.toContain(
      "CHECK (entity_type IN ('subscription', 'transaction', 'adjustment'))"
    );
    expect(sql).not.toMatch(
      /INSERT INTO public\.paddle_event_watermarks[\s\S]{0,700}'subscription'/
    );
  });

  test('creates a constrained, server-only subscription lifecycle table', () => {
    expect(sql).toContain('CREATE TABLE public.paddle_subscription_states');
    expect(sql).toMatch(
      /subscription_id text PRIMARY KEY[\s\S]{0,180}REFERENCES public\.profiles\(id\) ON DELETE CASCADE/
    );
    expect(sql).toContain(
      "'unknown',\n        'active',\n        'trialing',\n        'past_due',\n        'paused',\n        'canceled'"
    );
    expect(sql).toContain('last_snapshot_event_id text');
    expect(sql).toContain('last_snapshot_event_type text');
    expect(sql).toContain('last_snapshot_occurred_at timestamptz');
    expect(sql).toContain('last_payment_transaction_id text');
    expect(sql).toContain('last_payment_occurred_at timestamptz');
    expect(sql).toContain('terminal_at timestamptz');
    expect(sql).toContain(
      'ALTER TABLE public.paddle_subscription_states ENABLE ROW LEVEL SECURITY;'
    );
    expect(normalizedSql).toContain(
      'REVOKE ALL ON TABLE public.paddle_subscription_states FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(normalizedSql).toContain(
      'GRANT SELECT ON TABLE public.paddle_subscription_states TO service_role;'
    );
  });

  test('bootstraps known subscriptions with one timestamp and terminal free profiles', () => {
    expect(sql).toContain(
      'v_bootstrap timestamptz := clock_timestamp();'
    );
    expect(sql).toMatch(
      /FROM public\.profiles p[\s\S]{0,180}p\.paddle_subscription_id IS NOT NULL/
    );
    expect(sql).toContain(
      "lower(COALESCE(p.plan, 'free')) IN ('pro', 'enterprise', 'paid')"
    );
    expect(sql).toContain(
      "lower(COALESCE(p.plan, 'free')) NOT IN ('pro', 'enterprise', 'paid')"
    );
    expect(sql).toMatch(
      /'migration\.bootstrap',\s+v_bootstrap,[\s\S]{0,180}ELSE v_bootstrap/
    );
  });

  test('fails bootstrap on duplicate provider ownership instead of dropping a profile', () => {
    expect(sql).toMatch(
      /GROUP BY btrim\(paddle_subscription_id\)[\s\S]{0,100}HAVING count\(\*\) > 1[\s\S]{0,140}PADDLE_SUBSCRIPTION_BOOTSTRAP_DUPLICATE/
    );
    expect(sql).toMatch(
      /GROUP BY btrim\(paddle_customer_id\)[\s\S]{0,100}HAVING count\(\*\) > 1[\s\S]{0,140}PADDLE_CUSTOMER_BOOTSTRAP_DUPLICATE/
    );
    const bootstrapStart = sql.indexOf('DO $bootstrap$');
    const bootstrapEnd = sql.indexOf('$bootstrap$;', bootstrapStart);
    expect(sql.slice(bootstrapStart, bootstrapEnd)).not.toContain(
      'ON CONFLICT (subscription_id) DO NOTHING'
    );
  });

  test('publishes the exact subscription snapshot and payment RPC signatures', () => {
    expect(normalizedSql).toContain(
      'CREATE OR REPLACE FUNCTION public.apply_paddle_subscription_snapshot( ' +
      'p_subscription_id text, p_user_id uuid, p_customer_id text, ' +
      'p_status text, p_plan text, p_allotment integer, ' +
      'p_provider_event_id text, p_event_type text, ' +
      'p_occurred_at timestamptz, p_skip_entitlement_mutation boolean ) RETURNS jsonb'
    );
    expect(normalizedSql).toContain(
      'CREATE OR REPLACE FUNCTION public.apply_ordered_subscription_payment( ' +
      'p_transaction_id text, p_user_id uuid, p_plan text, p_amount integer, ' +
       'p_subscription_id text, p_customer_id text, ' +
       'p_occurred_at timestamptz, ' +
       'p_skip_entitlement_mutation boolean, ' +
      'p_allow_subscription_rebind boolean DEFAULT false ) RETURNS jsonb'
    );
  });

  test('serializes subscription work and rejects ownership conflicts', () => {
    const snapshotStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_paddle_subscription_snapshot'
    );
    const paymentStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_ordered_subscription_payment'
    );
    const grantsStart = sql.indexOf(
      'REVOKE ALL ON FUNCTION public.claim_paddle_event_order'
    );
    const snapshotSql = sql.slice(snapshotStart, paymentStart);
    const paymentSql = sql.slice(paymentStart, grantsStart);

    for (const functionSql of [snapshotSql, paymentSql]) {
      expect(functionSql).toMatch(
        /FROM public\.paddle_subscription_states[\s\S]{0,120}FOR UPDATE;/
      );
      expect(functionSql).toContain('PADDLE_SUBSCRIPTION_USER_CONFLICT');
      expect(functionSql).toContain('PADDLE_SUBSCRIPTION_CUSTOMER_CONFLICT');
    }
  });

  test('deduplicates snapshots, preserves timestamp ties for reconciliation, and ignores older snapshots', () => {
    const snapshotStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_paddle_subscription_snapshot'
    );
    const paymentStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_ordered_subscription_payment'
    );
    const snapshotSql = sql.slice(snapshotStart, paymentStart);
    const lifecycleInsert = snapshotSql.indexOf(
      'INSERT INTO public.paddle_subscription_lifecycle_events'
    );
    const equalTimestampBranch = snapshotSql.indexOf(
      'AND p_occurred_at = v_state.last_snapshot_occurred_at THEN'
    );
    const profileLockComment = snapshotSql.indexOf(
      '-- Different Paddle subscription IDs have independent reducer rows'
    );
    const equalTimestampSql = snapshotSql.slice(
      equalTimestampBranch,
      profileLockComment
    );

    expect(snapshotSql).toContain(
      "p_event_type NOT IN ('subscription.updated', 'subscription.canceled')"
    );
    expect(snapshotSql).toMatch(
      /v_status IN \('active', 'trialing'\)[\s\S]{0,220}p_allotment <= 0/
    );
    expect(snapshotSql).toContain(
      'IF v_state.last_snapshot_event_id = p_provider_event_id THEN'
    );
    expect(snapshotSql).toContain("'reason', 'duplicate'");
    expect(snapshotSql).toMatch(
      /p_occurred_at < v_state\.last_snapshot_occurred_at[\s\S]{0,260}'reason', 'stale'/
    );
    expect(lifecycleInsert).toBeGreaterThan(-1);
    expect(equalTimestampBranch).toBeGreaterThan(lifecycleInsert);
    expect(profileLockComment).toBeGreaterThan(equalTimestampBranch);
    expect(equalTimestampSql).toContain("'applied', false");
    expect(equalTimestampSql).toContain("'reason', 'reconciliation_required'");
    expect(equalTimestampSql).not.toContain('RAISE EXCEPTION');
  });

  test('makes cancellation terminal and atomic with entitlement expiration', () => {
    const snapshotStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_paddle_subscription_snapshot'
    );
    const paymentStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_ordered_subscription_payment'
    );
    const snapshotSql = sql.slice(snapshotStart, paymentStart);

    expect(snapshotSql).toMatch(
      /IF v_status = 'canceled' THEN[\s\S]{0,600}public\.expire_subscription_credits\(p_user_id\)/
    );
    expect(snapshotSql).toMatch(
      /IF v_status = 'canceled' THEN[\s\S]{0,1300}lifecycle_status = 'canceled'[\s\S]{0,140}terminal = true/
    );
    expect(snapshotSql).toContain(
      'terminal_at = COALESCE(terminal_at, p_occurred_at)'
    );
    expect(snapshotSql).toMatch(
      /IF v_state\.terminal THEN[\s\S]{0,900}'reason', 'terminal_subscription'/
    );
    expect(snapshotSql).not.toMatch(
      /IF v_state\.terminal THEN[\s\S]{0,800}terminal = false/
    );
  });

  test('rechecks the current profile binding under lock before cross-subscription mutations', () => {
    const snapshotStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_paddle_subscription_snapshot'
    );
    const paymentStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_ordered_subscription_payment'
    );
    const grantsStart = sql.indexOf(
      'REVOKE ALL ON FUNCTION public.claim_paddle_event_order'
    );
    const snapshotSql = sql.slice(snapshotStart, paymentStart);
    const paymentSql = sql.slice(paymentStart, grantsStart);

    for (const functionSql of [snapshotSql, paymentSql]) {
      expect(functionSql).toMatch(
        /FROM public\.profiles[\s\S]{0,100}WHERE id = p_user_id[\s\S]{0,60}FOR UPDATE;/
      );
      expect(functionSql).toContain('v_is_current_subscription');
      expect(functionSql).toContain('PADDLE_CUSTOMER_USER_CONFLICT');
    }
    expect(snapshotSql).toContain(
      "'cancellation_recorded_superseded_subscription'"
    );
    expect(snapshotSql).toContain(
      "'snapshot_recorded_superseded_subscription'"
    );
    expect(paymentSql).toContain(
      'p_allow_subscription_rebind boolean DEFAULT false'
    );
    expect(paymentSql).toContain(
      "v_business_reason := 'superseded_subscription'"
    );
    expect(paymentSql).toMatch(
      /p_allow_subscription_rebind, false\)[\s\S]{0,300}UPDATE public\.profiles[\s\S]{0,180}paddle_subscription_id = btrim\(p_subscription_id\)/
    );
  });

  test('orders renewal payments per subscription and binds every accepted ledger row', () => {
    const paymentStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_ordered_subscription_payment'
    );
    const grantsStart = sql.indexOf(
      'REVOKE ALL ON FUNCTION public.claim_paddle_event_order'
    );
    const paymentSql = sql.slice(paymentStart, grantsStart);

    expect(paymentSql).toMatch(
      /p_occurred_at < v_state\.last_payment_occurred_at[\s\S]{0,120}v_order_reason := 'stale_payment'/
    );
    expect(paymentSql).toMatch(
      /p_occurred_at = v_state\.last_payment_occurred_at[\s\S]{0,120}v_order_reason := 'ambiguous_payment_order'/
    );
    expect(paymentSql).toContain(
      'last_payment_transaction_id = p_transaction_id'
    );
    expect(paymentSql).toContain(
      'last_payment_occurred_at = p_occurred_at'
    );
    expect(paymentSql).toMatch(
      /UPDATE public\.purchases[\s\S]{0,360}subscription_id = btrim\(p_subscription_id\)/
    );
    expect(paymentSql).toContain(
      'SUBSCRIPTION_PAYMENT_LEDGER_BINDING_CONFLICT'
    );
  });

  test('applies active entitlements but preserves paused and past-due entitlements', () => {
    expect(sql).toMatch(
      /IF v_status IN \('active', 'trialing'\) THEN[\s\S]{0,700}public\.apply_plan_change/
    );
    expect(sql).toContain(
      '-- past_due, paused, and unknown snapshots are recorded, but intentionally'
    );
    expect(sql).toContain("'reason', 'entitlement_preserved'");
    expect(sql).toContain("'reason', 'entitlement_mutation_skipped'");
  });

  test('records terminal subscription payments without granting entitlement', () => {
    const paymentStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_ordered_subscription_payment'
    );
    const grantsStart = sql.indexOf(
      'REVOKE ALL ON FUNCTION public.claim_paddle_event_order'
    );
    const paymentSql = sql.slice(paymentStart, grantsStart);

    expect(paymentSql).toContain(
      "v_business_reason := 'terminal_subscription'"
    );
    expect(paymentSql).toMatch(
      /v_effective_skip :=[\s\S]{0,220}v_business_reason IS NOT NULL[\s\S]{0,220}public\.apply_subscription_payment\([\s\S]{0,180}v_effective_skip/
    );
    expect(paymentSql).toContain("'entitlementGranted', false");
    expect(paymentSql).toContain(
      'COALESCE(p_skip_entitlement_mutation, false)'
    );
    expect(paymentSql).toContain(
      "COALESCE(v_payment_result ->> 'reason' = 'payment_applied', false)"
    );
    expect(paymentSql).not.toContain(
      "'entitlementGranted', NOT COALESCE(p_skip_entitlement_mutation, false)"
    );
  });

  test('treats equal immutable-event timestamps as ambiguous, never stale', () => {
    const claimStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.claim_paddle_event_order'
    );
    const completeStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.complete_paddle_event_order'
    );
    const claimSql = sql.slice(claimStart, completeStart);

    expect(claimSql).toMatch(
      /p_occurred_at < v_row\.last_occurred_at[\s\S]{0,180}'outcome', 'stale'/
    );
    expect(claimSql).toMatch(
      /p_occurred_at = v_row\.last_occurred_at[\s\S]{0,180}'outcome', 'ambiguous'/
    );
    expect(claimSql).toContain("'reconciliationRequired', true");
    expect(claimSql).not.toMatch(
      /p_occurred_at <= v_row\.last_occurred_at/
    );
  });

  test('never auto-takes an expired lease and keeps exact-token operator release', () => {
    const claimStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.claim_paddle_event_order'
    );
    const completeStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.complete_paddle_event_order'
    );
    const claimSql = sql.slice(claimStart, completeStart);
    const releaseStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.release_stale_paddle_event_order'
    );
    const snapshotStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_paddle_subscription_snapshot'
    );
    const releaseSql = sql.slice(releaseStart, snapshotStart);

    expect(claimSql).toContain(
      'IF v_row.pending_event_id IS NOT NULL THEN'
    );
    expect(claimSql).toContain("'outcome', 'busy'");
    expect(claimSql).toContain(
      "'pendingClaimedAt', v_row.pending_claimed_at"
    );
    expect(claimSql).not.toContain(
      'OR v_row.pending_lease_expires_at <= v_now'
    );
    expect(releaseSql).toContain(
      'pending_claim_token = p_expected_claim_token'
    );
    expect(releaseSql).toContain(
      'pending_lease_expires_at <= clock_timestamp()'
    );
  });

  test('pins every RPC to service_role only', () => {
    for (const functionName of [
      'claim_paddle_event_order',
      'complete_paddle_event_order',
      'fail_paddle_event_order',
      'release_stale_paddle_event_order',
      'apply_paddle_subscription_snapshot',
      'apply_ordered_subscription_payment'
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
});
