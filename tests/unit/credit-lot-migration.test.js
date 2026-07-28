'use strict';

const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  '..',
  'migrations',
  '023_credit_lot_ledger.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');
const securePaymentSql = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    '..',
    'migrations',
    '025_secure_payment_requests.sql'
  ),
  'utf8'
);

describe('credit lot ledger migration safety contract', () => {
  test('secure payment requests preflight the current ordered-payment signature', () => {
    expect(securePaymentSql).toContain(
      "'public.apply_ordered_subscription_payment(text,uuid,text,integer,text,text,timestamptz,boolean,boolean)'"
    );
  });

  test('is a single transaction and refuses to migrate active credit work', () => {
    expect(sql).toMatch(/^--[\s\S]*\nBEGIN;\s/m);
    expect(sql).toMatch(/CREDIT_LEDGER_MIGRATION_BLOCKED_ACTIVE_ANALYSIS/);
    expect(sql).toMatch(/CREDIT_LEDGER_MIGRATION_BLOCKED_ACTIVE_STORYBOARD/);
    expect(sql).toMatch(/\nCOMMIT;\s/);
  });

  test('backfills current balances before replacing charging RPCs', () => {
    const backfill = sql.indexOf("INSERT INTO public.credit_lots (");
    const analysisOverride = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.reserve_analysis_operation'
    );
    const storyboardOverride = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.enqueue_storyboard_job'
    );

    expect(backfill).toBeGreaterThan(0);
    expect(analysisOverride).toBeGreaterThan(backfill);
    expect(storyboardOverride).toBeGreaterThan(backfill);
    expect(sql).toContain("'migration:' || id::text");
  });

  test('records exact operation-to-lot allocations and refunds only those lots', () => {
    expect(sql).toContain('CREATE TABLE public.credit_operation_allocations');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.consume_credit_lots');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.refund_credit_operation');
    expect(sql).toMatch(/FOR UPDATE OF a, l/);
    expect(sql).toMatch(/credits_refunded = credits_refunded \+ v_restore/);
    expect(sql).toContain(
      "hashtextextended('analysis_operation:' || p_operation_id::text, 0)"
    );
    expect(sql).toMatch(
      /v_balance := public\.sync_credit_lot_balance\(p_user_id\);[\s\S]{0,300}FROM public\.credit_operations/
    );

    const refundStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.refund_credit_operation'
    );
    const registerIntentStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.register_credit_pack_checkout_intent'
    );
    const refundSql = sql.slice(refundStart, registerIntentStart);
    expect(refundSql.indexOf('public.sync_credit_lot_balance(p_user_id)'))
      .toBeLessThan(refundSql.indexOf('FROM public.credit_operations'));
  });

  test('keeps subscription and pack sources independent at renewal and cancellation', () => {
    expect(sql).toMatch(
      /source_kind IN \('subscription', 'migration'\)[\s\S]{0,220}status IN \('active', 'exhausted'\)/
    );
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.expire_subscription_credits');
    expect(sql).toContain("'credit_pack'");
    expect(sql).toContain("'subscription_payment:' || p_transaction_id");
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.bridge_legacy_subscription_cancellation()'
    );
    expect(sql).toContain('trg_bridge_legacy_subscription_cancellation');
  });

  test('requires a verified checkout intent before a credit pack can be fulfilled', () => {
    expect(sql).toContain('CREATE TABLE public.credit_pack_checkout_intents');
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.register_credit_pack_checkout_intent'
    );
    expect(sql).toContain('CREDIT_PACK_CHECKOUT_INTENT_NOT_FOUND');
    expect(sql).toContain('CREDIT_PACK_CHECKOUT_INTENT_MISMATCH');
    expect(sql).toMatch(
      /FROM public\.credit_pack_checkout_intents[\s\S]{0,400}v_intent\.customer_id <> p_customer_id/
    );

    const applyStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_purchase'
    );
    const adjustmentStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment'
    );
    const applySql = sql.slice(applyStart, adjustmentStart);
    expect(applySql).not.toContain('ACTIVE_SUBSCRIPTION_REQUIRED');
    expect(applySql).toContain("v_intent.status <> 'pending'");
  });

  test('publishes stable checkout-intent, fulfillment, and expiration RPC contracts', () => {
    const normalizedSql = sql.replace(/\s+/g, ' ');

    expect(normalizedSql).toContain(
      'CREATE OR REPLACE FUNCTION public.register_credit_pack_checkout_intent( ' +
      'p_transaction_id text, p_user_id uuid, p_customer_id text, ' +
      'p_subscription_id text, p_pack_key text, p_price_id text, ' +
      'p_credits integer, p_unit_amount integer, p_currency_code text, ' +
      'p_expiry_days integer ) RETURNS jsonb'
    );
    expect(normalizedSql).toContain(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_purchase( ' +
      'p_transaction_id text, p_user_id uuid, p_customer_id text, ' +
      'p_pack_key text, p_price_id text, p_credits integer, ' +
      'p_unit_amount integer, p_currency_code text, p_subscription_id text, ' +
      'p_expiry_days integer, p_purchased_at timestamptz ) RETURNS jsonb'
    );

    expect(sql).toContain("'checkout_intent_registered'");
    expect(sql).toContain("'credit_pack_applied'");
    expect(sql).toContain(
      'make_interval(days => v_intent.expiry_days)'
    );
    expect(sql).toContain("'expiresInDays', v_intent.expiry_days");
    expect(sql).not.toContain(
      'make_interval(days => p_expiry_days)'
    );

    const expireStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.expire_subscription_credits'
    );
    const bridgeStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.bridge_legacy_subscription_cancellation'
    );
    const expireSql = sql.slice(expireStart, bridgeStart);
    expect(expireSql).toContain("'reason', 'subscription_expired'");
    expect(expireSql).toContain("'newBalance', v_balance");
  });

  test('enforces the approved pack quantities and USD amounts inside Postgres', () => {
    expect(sql).toContain(
      "p_pack_key = 'usage_600'  AND p_credits = 600  AND p_unit_amount = 1000"
    );
    expect(sql).toContain(
      "p_pack_key = 'usage_1500' AND p_credits = 1500 AND p_unit_amount = 2000"
    );
    expect(sql).toContain(
      "p_pack_key = 'usage_3000' AND p_credits = 3000 AND p_unit_amount = 4000"
    );
    expect(sql).toContain("currency_code = 'USD'");
  });

  test('does not automate partial refunds or chargeback reversals', () => {
    expect(sql).toContain("'partial_requires_review'");
    expect(sql).toContain("'chargeback_reverse'");
    expect(sql).toContain("'manual_review'");
    expect(sql).toMatch(/review_required = true/);
  });

  test('does not mint a full prior allotment when a plan-change snapshot is absent', () => {
    expect(sql).toContain("refund_review_reason = 'plan_change_snapshot_missing'");
    expect(sql).toContain("'manual_review_required'");
    expect(sql).not.toContain("'refund_restore:' || p_transaction_id");
    expect(sql).not.toContain("'plan_restored'");
  });

  test('separates expired credits from consumed credits', () => {
    expect(sql).toContain('credits_expired    INTEGER NOT NULL DEFAULT 0');
    expect(sql).toMatch(
      /credits_expired = credits_expired \+ credits_remaining/
    );
    expect(sql).toMatch(
      /v_purchase\.credits_granted[\s\S]{0,160}- v_lot\.credits_expired/
    );
  });

  test('uses a consistent user-deletion policy for the new ledger graph', () => {
    expect(sql).toMatch(
      /REFERENCES public\.credit_lots\(id\) ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /REFERENCES public\.credit_pack_purchases\(transaction_id\) ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /REFERENCES public\.credit_operations\(operation_key\) ON DELETE SET NULL/
    );
    expect(sql).not.toMatch(
      /REFERENCES public\.(?:credit_lots|credit_pack_purchases)\([^)]*\) ON DELETE RESTRICT/
    );
  });

  test('keeps all ledger tables and RPCs server-only', () => {
    for (const table of [
      'credit_lots',
      'credit_operations',
      'credit_operation_allocations',
      'credit_pack_checkout_intents',
      'credit_pack_purchases',
      'credit_pack_adjustments'
    ]) {
      expect(sql).toContain(
        `REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`
      );
      expect(sql).toContain(`GRANT ALL ON TABLE public.${table} TO service_role;`);
    }

    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.register_credit_pack_checkout_intent\([\s\S]*?\) FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.apply_credit_pack_purchase\([\s\S]*?\) FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.apply_credit_pack_purchase\([\s\S]*?\) TO service_role;/
    );
  });

  test('ends with balance, allocation, and lot-state invariant checks', () => {
    expect(sql).toContain('CREDIT_LOT_STATE_INVARIANT_FAILED');
    expect(sql).toContain('CREDIT_ALLOCATION_INVARIANT_FAILED');
    expect(sql).toContain('CREDIT_PACK_INTENT_INVARIANT_FAILED');
    expect(sql).toContain('PROFILE_CREDIT_BALANCE_INVARIANT_FAILED');
  });
});
