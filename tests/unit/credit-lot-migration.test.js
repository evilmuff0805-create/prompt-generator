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
const orderedSubscriptionSql = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    '..',
    'migrations',
    '024_paddle_event_ordering.sql'
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

  test('preserves immutable lifecycle history before returning a stale snapshot', () => {
    expect(orderedSubscriptionSql).toContain(
      'CREATE TABLE public.paddle_subscription_lifecycle_events'
    );
    expect(orderedSubscriptionSql).toContain(
      'provider_event_id text PRIMARY KEY'
    );
    expect(orderedSubscriptionSql).toMatch(
      /CREATE INDEX paddle_subscription_lifecycle_events_ineligible_idx[\s\S]{0,260}WHERE lifecycle_status IN \('past_due', 'paused', 'canceled'\)/
    );

    const historyInsert = orderedSubscriptionSql.indexOf(
      'INSERT INTO public.paddle_subscription_lifecycle_events'
    );
    const staleDecision = orderedSubscriptionSql.indexOf(
      'p_occurred_at < v_state.last_snapshot_occurred_at'
    );
    expect(historyInsert).toBeGreaterThan(0);
    expect(staleDecision).toBeGreaterThan(historyInsert);
    expect(orderedSubscriptionSql).toContain(
      'PADDLE_SUBSCRIPTION_EVENT_ID_CONFLICT'
    );
  });

  test('retains an equal-timestamp distinct lifecycle event and fails closed', () => {
    const equalTimestampStart = orderedSubscriptionSql.indexOf(
      'p_occurred_at = v_state.last_snapshot_occurred_at'
    );
    const profileLockStart = orderedSubscriptionSql.indexOf(
      'FROM public.profiles',
      equalTimestampStart
    );
    const equalTimestampSql = orderedSubscriptionSql.slice(
      equalTimestampStart,
      profileLockStart
    );

    expect(equalTimestampStart).toBeGreaterThan(
      orderedSubscriptionSql.indexOf(
        'INSERT INTO public.paddle_subscription_lifecycle_events'
      )
    );
    expect(equalTimestampSql).toContain("'reason', 'reconciliation_required'");
    expect(equalTimestampSql).toContain("'applied', false");
    expect(equalTimestampSql).not.toContain('RAISE EXCEPTION');
  });

  test('enforces an exclusive fifteen-minute add-on authorization window', () => {
    expect(securePaymentSql).toContain(
      "authorization_expires_at = authorized_at + interval '15 minutes'"
    );

    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);

    expect(chargeSql).toContain(
      'p_purchased_at < v_request.authorized_at'
    );
    expect(chargeSql).toContain(
      'p_purchased_at >= v_request.authorization_expires_at'
    );
    expect(chargeSql).toContain("'event_before_authorization'");
    expect(chargeSql).toContain("'authorization_expired'");
  });

  test('stores a bounded eligibility-check start time before authorization', () => {
    expect(securePaymentSql).toContain(
      'eligibility_check_started_at TIMESTAMPTZ NOT NULL'
    );
    expect(securePaymentSql).toContain(
      'p_eligibility_check_started_at timestamptz'
    );
    expect(securePaymentSql).toContain(
      "p_eligibility_check_started_at < v_authorized_at - interval '5 minutes'"
    );
    expect(securePaymentSql).toContain(
      "p_eligibility_check_started_at > v_authorized_at + interval '30 seconds'"
    );
    expect(securePaymentSql).toContain(
      'CREDIT_PACK_ELIGIBILITY_PROOF_STALE'
    );
    const requestFunctionStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.begin_credit_pack_purchase_preview'
    );
    const transitionFunctionStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.finalize_credit_pack_purchase_preview'
    );
    const requestFunctionSql = securePaymentSql.slice(
      requestFunctionStart,
      transitionFunctionStart
    );
    const advisoryLock = requestFunctionSql.indexOf(
      "hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)"
    );
    const authorizationClock = requestFunctionSql.indexOf(
      'v_authorized_at := clock_timestamp()'
    );
    const staleCheck = requestFunctionSql.indexOf(
      'p_eligibility_check_started_at < v_authorized_at'
    );
    const lifecycleLock = requestFunctionSql.indexOf(
      'FROM public.paddle_subscription_states'
    );
    expect(advisoryLock).toBeGreaterThan(0);
    expect(authorizationClock).toBeGreaterThan(advisoryLock);
    expect(staleCheck).toBeGreaterThan(authorizationClock);
    expect(lifecycleLock).toBeGreaterThan(staleCheck);
    const insertStart = requestFunctionSql.indexOf(
      'INSERT INTO public.credit_pack_purchase_requests'
    );
    const valuesStart = requestFunctionSql.indexOf(') VALUES (', insertStart);
    const insertSql = requestFunctionSql.slice(insertStart);
    expect(insertSql.indexOf('eligibility_check_started_at,'))
      .toBeLessThan(valuesStart - insertStart);
    expect(insertSql.indexOf('p_eligibility_check_started_at,'))
      .toBeGreaterThan(valuesStart - insertStart);
    expect(insertSql).toContain(
      "v_authorized_at + interval '15 minutes'"
    );
  });

  test('reserves one account-level preview before any external preview totals exist', () => {
    const beginStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.begin_credit_pack_purchase_preview'
    );
    const finalizeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.finalize_credit_pack_purchase_preview'
    );
    const beginSql = securePaymentSql.slice(beginStart, finalizeStart);
    const insertStart = beginSql.indexOf(
      'INSERT INTO public.credit_pack_purchase_requests'
    );
    const insertSql = beginSql.slice(insertStart);
    const advisoryLock = beginSql.indexOf(
      "hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)"
    );
    const lifecycleLock = beginSql.indexOf(
      'FROM public.paddle_subscription_states'
    );

    expect(beginStart).toBeGreaterThan(0);
    expect(securePaymentSql).toContain(
      "status                 TEXT NOT NULL DEFAULT 'previewing'"
    );
    expect(securePaymentSql).toContain(
      'confirmation_version   INTEGER NOT NULL DEFAULT 0'
    );
    expect(advisoryLock).toBeGreaterThan(0);
    expect(advisoryLock).toBeLessThan(lifecycleLock);
    expect(insertSql).not.toContain('approved_subtotal,');
    expect(insertSql).not.toContain('provider_api_request_id,');
    expect(beginSql).toContain("'reason', 'purchase_preview_reserved'");
    expect(beginSql).toContain("'status', 'previewing'");
    expect(beginSql).toContain("'confirmationVersion', 0");
    expect(beginSql).toMatch(
      /IF v_existing\.status IN \('previewing', 'created'\)[\s\S]{0,140}clock_timestamp\(\) >= v_existing\.authorization_expires_at[\s\S]{0,260}SET status = 'failed',[\s\S]{0,100}provider_error_code = 'authorization_expired'/
    );
    expect(beginSql).toMatch(
      /WHERE request_id = v_existing\.request_id[\s\S]{0,100}AND status = v_existing\.status[\s\S]{0,120}clock_timestamp\(\) >= authorization_expires_at/
    );
    expect(beginSql).not.toMatch(
      /IF v_existing\.status IN \('previewing', 'created', 'charging'/
    );
    const openIndexStart = securePaymentSql.indexOf(
      'CREATE UNIQUE INDEX credit_pack_purchase_requests_one_open_per_user_idx'
    );
    const nextIndexStart = securePaymentSql.indexOf(
      'CREATE INDEX credit_pack_purchase_requests_subscription_created_idx',
      openIndexStart
    );
    const openIndexSql = securePaymentSql.slice(
      openIndexStart,
      nextIndexStart
    );
    expect(openIndexSql).toMatch(
      /'previewing'[\s\S]{0,80}'created'[\s\S]{0,80}'charging'[\s\S]{0,80}'submitted'[\s\S]{0,80}'provider_unknown'/
    );
    expect(openIndexSql).not.toContain("'withheld'");
  });

  test('finalizes and refreshes preview totals with an exact confirmation CAS', () => {
    const finalizeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.finalize_credit_pack_purchase_preview'
    );
    const claimStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.claim_credit_pack_purchase_request'
    );
    const finalizeSql = securePaymentSql.slice(finalizeStart, claimStart);

    expect(finalizeStart).toBeGreaterThan(0);
    expect(finalizeSql).toContain(
      "v_request.status NOT IN ('previewing', 'created')"
    );
    expect(finalizeSql).toContain(
      'v_request.confirmation_version IS DISTINCT FROM'
    );
    expect(finalizeSql).toContain("'confirmation_version_mismatch'");
    expect(finalizeSql).toContain(
      'v_next_version := v_request.confirmation_version + 1'
    );
    expect(finalizeSql).toMatch(
      /UPDATE public\.credit_pack_purchase_requests[\s\S]{0,900}confirmation_version = v_next_version,[\s\S]{0,80}status = 'created'/
    );
    expect(finalizeSql).toContain(
      "AND status = v_previous_status"
    );
    expect(finalizeSql).toContain(
      'AND confirmation_version = p_expected_confirmation_version'
    );
    expect(finalizeSql).not.toContain("status = 'charging'");
    expect(finalizeSql).toContain("'purchase_preview_finalized'");
    expect(finalizeSql).toContain("'purchase_confirmation_refreshed'");
  });

  test('claims one confirmed request atomically and treats every repeat as ambiguous', () => {
    const claimStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.claim_credit_pack_purchase_request'
    );
    const cancelStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.cancel_credit_pack_purchase_request'
    );
    const claimSql = securePaymentSql.slice(claimStart, cancelStart);
    const advisoryLock = claimSql.indexOf(
      "hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)"
    );
    const lifecycleLock = claimSql.indexOf(
      'FROM public.paddle_subscription_states'
    );
    const profileLock = claimSql.indexOf(
      'FROM public.profiles'
    );
    const receiptReview = claimSql.indexOf(
      'FROM public.credit_pack_payment_receipts'
    );
    const adjustmentReview = claimSql.indexOf(
      'SELECT review_item.*'
    );
    const requestLock = claimSql.indexOf(
      'FROM public.credit_pack_purchase_requests'
    );

    expect(claimStart).toBeGreaterThan(0);
    expect(advisoryLock).toBeGreaterThan(0);
    expect(advisoryLock).toBeLessThan(lifecycleLock);
    expect(lifecycleLock).toBeLessThan(profileLock);
    expect(profileLock).toBeLessThan(receiptReview);
    expect(receiptReview).toBeLessThan(adjustmentReview);
    expect(adjustmentReview).toBeLessThan(requestLock);
    expect(claimSql).toContain('FOR UPDATE');
    const receiptReviewEnd = claimSql.indexOf(
      'v_review_receipt_found := FOUND',
      receiptReview
    );
    const adjustmentReviewEnd = claimSql.indexOf(
      'v_review_item_found := FOUND',
      adjustmentReview
    );
    expect(claimSql.slice(receiptReview, receiptReviewEnd))
      .not.toContain('FOR UPDATE');
    expect(claimSql.slice(adjustmentReview, adjustmentReviewEnd))
      .not.toContain('FOR UPDATE');
    expect(claimSql).toContain(
      "v_state.lifecycle_status = 'active'"
    );
    expect(claimSql).toContain('NOT v_state.terminal');
    expect(claimSql).toContain(
      'v_state.subscription_id IS NOT DISTINCT FROM p_subscription_id'
    );
    expect(claimSql).toContain(
      'v_state.user_id IS NOT DISTINCT FROM p_user_id'
    );
    expect(claimSql).toContain(
      'v_state.customer_id IS NOT DISTINCT FROM p_customer_id'
    );
    expect(claimSql).toContain(
      "lower(COALESCE(v_profile.plan, 'free')) IN ('pro', 'enterprise', 'paid')"
    );
    expect(claimSql).toContain(
      'v_profile.paddle_customer_id IS NOT DISTINCT FROM p_customer_id'
    );
    expect(claimSql).toContain(
      'v_profile.paddle_subscription_id'
    );
    expect(claimSql).toContain(
      'IS NOT DISTINCT FROM p_subscription_id'
    );
    expect(claimSql).toContain(
      "decision IN ('withheld', 'chargeback')"
    );
    expect(claimSql).toContain('purchase.review_required = true');
    expect(claimSql).toContain('adjustment.review_required = true');
    expect(claimSql).toContain(
      "'reason', 'purchase_review_required'"
    );
    expect(claimSql).toContain(
      "'reason', 'subscription_reconfirmation_required'"
    );
    expect(claimSql).toContain("'cancellable', true");
    expect(claimSql).toContain("'cancelReason', 'confirmation_rejected'");
    expect(claimSql).toContain(
      'provider_event_id'
    );
    expect(claimSql).toContain(
      'IS DISTINCT FROM v_request.eligible_snapshot_event_id'
    );
    expect(claimSql).toContain(
      'occurred_at >= v_request.eligible_snapshot_occurred_at'
    );
    expect(claimSql).toContain(
      'IS DISTINCT FROM v_request.eligible_snapshot_event_id'
    );
    expect(claimSql).toContain(
      "v_request.status IN ('charging', 'submitted', 'provider_unknown')"
    );
    expect(claimSql).toContain("'reason', 'duplicate_or_ambiguous'");
    expect(claimSql).toContain(
      "IF v_request.status <> 'created' THEN"
    );
    expect(claimSql).toContain(
      'clock_timestamp() >= v_request.authorization_expires_at'
    );
    expect(claimSql).toContain(
      'v_request.confirmation_version IS DISTINCT FROM'
    );
    expect(claimSql).toMatch(
      /UPDATE public\.credit_pack_purchase_requests[\s\S]{0,220}SET status = 'charging'/
    );
    expect(claimSql).toContain("AND status = 'created'");
    expect(claimSql).toContain(
      'AND confirmation_version = p_expected_confirmation_version'
    );
    expect(claimSql).toContain("'reason', 'purchase_request_claimed'");
  });

  test('only previewing or created requests can be cancelled or expired', () => {
    const cancelStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.cancel_credit_pack_purchase_request'
    );
    const expireStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.expire_credit_pack_purchase_request'
    );
    const transitionStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.transition_credit_pack_purchase_request'
    );
    const cancelSql = securePaymentSql.slice(cancelStart, expireStart);
    const expireSql = securePaymentSql.slice(expireStart, transitionStart);

    for (const closeSql of [cancelSql, expireSql]) {
      expect(closeSql).toContain(
        "v_request.status IN ('charging', 'submitted', 'provider_unknown')"
      );
      expect(closeSql).toContain("'reason', 'reconciliation_required'");
      expect(closeSql).toContain(
        "AND status IN ('previewing', 'created')"
      );
      expect(closeSql).not.toMatch(
        /SET status = 'failed'[\s\S]{0,180}status IN \('charging'/
      );
    }
    expect(expireSql).toContain(
      'clock_timestamp() >= authorization_expires_at'
    );
    expect(expireSql).toContain(
      "provider_error_code = 'authorization_expired'"
    );
  });

  test('review-locks only aged charging uncertainty with exhaustive audited evidence', () => {
    const reconciliationStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.reconcile_credit_pack_purchase_no_match'
    );
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const reconciliationSql = securePaymentSql.slice(
      reconciliationStart,
      chargeStart
    );

    expect(reconciliationStart).toBeGreaterThan(0);
    for (const field of [
      'reconciliation_decision TEXT',
      'reconciliation_previous_status TEXT',
      'reconciliation_checked_at TIMESTAMPTZ',
      'reconciliation_window_start TIMESTAMPTZ',
      'reconciliation_window_end TIMESTAMPTZ',
      'reconciliation_pages_scanned INTEGER',
      'reconciliation_transactions_scanned INTEGER',
      'reconciliation_provider_request_ids TEXT[]',
      'reconciliation_audit_reference TEXT',
      'reconciliation_closed_at TIMESTAMPTZ'
    ]) {
      expect(securePaymentSql).toContain(field);
    }
    expect(securePaymentSql).toContain(
      'credit_pack_purchase_requests_reconciliation_evidence_check'
    );
    expect(securePaymentSql).toContain(
      "reconciliation_decision = 'definitive_no_match'"
    );
    expect(securePaymentSql).toMatch(
      /reconciliation_previous_status IN \(\s*'charging',\s*'submitted',\s*'provider_unknown'\s*\)/
    );
    expect(securePaymentSql).toContain(
      "authorization_expires_at + interval '72 hours'"
    );
    expect(securePaymentSql).toContain(
      'credit_pack_purchase_requests_reconciliation_checked_idx'
    );

    expect(reconciliationSql).toMatch(
      /v_expected_status NOT IN \(\s*'charging',\s*'submitted',\s*'provider_unknown'\s*\)/
    );
    expect(reconciliationSql).toContain(
      "v_evidence_result <> 'definitive_no_match'"
    );
    expect(reconciliationSql).toContain(
      'OR p_pages_scanned IS NULL'
    );
    expect(reconciliationSql).toContain(
      'OR p_pages_scanned <= 0'
    );
    expect(reconciliationSql).toContain(
      'OR p_pages_scanned > 256'
    );
    expect(reconciliationSql).toContain(
      'p_transactions_scanned IS NULL OR p_transactions_scanned < 0'
    );
    expect(reconciliationSql).toContain(
      'p_transactions_scanned::bigint > p_pages_scanned::bigint * 30'
    );
    expect(reconciliationSql).toContain(
      'cardinality(p_provider_request_ids)'
    );
    expect(reconciliationSql).toContain(
      'v_audit_reference IS NULL'
    );
    expect(reconciliationSql).toContain(
      'v_provider_request_id = ANY(v_seen_provider_request_ids)'
    );
    expect(reconciliationSql).toContain(
      "v_provider_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-"
    );
    expect(securePaymentSql).toContain(
      'reconciliation_pages_scanned <= 256'
    );
    expect(securePaymentSql).toContain(
      'reconciliation_transactions_scanned::bigint <='
    );
    expect(securePaymentSql).toContain(
      'reconciliation_pages_scanned::bigint * 30'
    );
    expect(securePaymentSql).toContain(
      'COALESCE(cardinality(reconciliation_provider_request_ids), 0) ='
    );
    expect(securePaymentSql).toContain(
      'reconciliation_audit_reference IS NOT NULL'
    );
    expect(reconciliationSql).toContain(
      "p_checked_at < v_now - interval '15 minutes'"
    );
    expect(reconciliationSql).toContain(
      'p_window_start > v_request.authorized_at'
    );
    expect(reconciliationSql).toContain(
      "v_request.authorization_expires_at + interval '72 hours'"
    );
    expect(reconciliationSql).toMatch(
      /v_request.status NOT IN \(\s*'charging',\s*'submitted',\s*'provider_unknown'\s*\)/
    );
    expect(reconciliationSql).toContain(
      'v_request.authorized_user_id IS DISTINCT FROM p_user_id'
    );
    expect(reconciliationSql).not.toContain(
      'OR v_request.user_id IS NULL'
    );
    expect(reconciliationSql).toContain(
      'v_request.status IS DISTINCT FROM v_expected_status'
    );
    expect(reconciliationSql).toContain(
      "'reason', 'reconciliation_duplicate'"
    );
    expect(reconciliationSql.indexOf(
      'IF v_request.reconciliation_decision IS NOT NULL THEN'
    )).toBeLessThan(reconciliationSql.indexOf(
      "IF v_request.status NOT IN ("
    ));
    expect(reconciliationSql).toMatch(
      /UPDATE public\.credit_pack_purchase_requests[\s\S]{0,1100}status = 'provider_unknown',[\s\S]{0,100}review_required = true,[\s\S]{0,120}provider_error_code = 'reconciled_no_match_review_locked'/
    );
    expect(reconciliationSql).toContain("'status', 'provider_unknown'");
    expect(reconciliationSql).toContain("'reviewRequired', true");
    expect(reconciliationSql).toContain(
      'AND status = v_expected_status'
    );
    expect(reconciliationSql).toContain(
      'AND reconciliation_decision IS NULL'
    );
    expect(reconciliationSql).not.toMatch(
      /SET status = 'failed'[\s\S]{0,160}status = 'submitted'/
    );
  });

  test('allows only exact review-locked or legacy no-match recovery and quarantines other failed requests', () => {
    const claimStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.claim_credit_pack_purchase_request'
    );
    const cancelStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.cancel_credit_pack_purchase_request'
    );
    const claimSql = securePaymentSql.slice(claimStart, cancelStart);
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);
    const openIndexStart = securePaymentSql.indexOf(
      'CREATE UNIQUE INDEX credit_pack_purchase_requests_one_open_per_user_idx'
    );
    const openIndexEnd = securePaymentSql.indexOf(
      'CREATE INDEX credit_pack_purchase_requests_subscription_created_idx',
      openIndexStart
    );
    const openIndexSql = securePaymentSql.slice(openIndexStart, openIndexEnd);

    expect(openIndexSql).not.toContain("'withheld'");
    expect(openIndexSql).toContain("'provider_unknown'");
    expect(chargeSql).toContain(
      "v_reconciled_no_match_recovery boolean := false"
    );
    expect(chargeSql).toContain(
      "v_request.reconciliation_decision = 'definitive_no_match'"
    );
    expect(chargeSql).toContain(
      "v_request.status = 'provider_unknown'"
    );
    expect(chargeSql).toContain(
      'v_request.review_required = true'
    );
    expect(chargeSql).toContain(
      "'reconciled_no_match_review_locked'"
    );
    expect(chargeSql).toMatch(
      /v_request\.provider_error_code =\s*'reconciled_definitive_no_match'/
    );
    expect(chargeSql).toContain(
      'v_request.reconciliation_closed_at IS NOT NULL'
    );
    expect(chargeSql).toContain(
      "ELSIF v_request.status = 'failed'"
    );
    expect(chargeSql).toContain(
      'AND NOT v_reconciled_no_match_recovery THEN'
    );
    expect(chargeSql).toContain(
      "v_withheld_reason := 'request_previously_failed'"
    );
    expect(chargeSql).toMatch(
      /AND status IN \([\s\S]{0,100}'charging',[\s\S]{0,160}'provider_unknown',[\s\S]{0,100}'failed'/
    );
    expect(chargeSql).toMatch(
      /status IN \(\s*'charging',\s*'submitted',\s*'provider_unknown'\s*\)[\s\S]{0,520}status = 'failed'[\s\S]{0,320}provider_error_code = 'reconciled_definitive_no_match'/
    );
    expect(chargeSql).toContain(
      "'reconciliationSuperseded', v_reconciled_no_match_recovery"
    );
    expect(claimSql).toContain(
      "decision IN ('withheld', 'chargeback')"
    );
    expect(claimSql).toContain(
      "'reason', 'purchase_review_required'"
    );
  });

  test('requires a claim before provider transition or entitlement grant', () => {
    const transitionStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.transition_credit_pack_purchase_request'
    );
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const transitionSql = securePaymentSql.slice(transitionStart, chargeStart);
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);

    expect(transitionSql).toContain(
      "v_status NOT IN ('submitted', 'provider_unknown')"
    );
    expect(transitionSql).not.toContain(
      "v_status NOT IN ('submitted', 'provider_unknown', 'failed')"
    );
    expect(transitionSql).toContain(
      "v_request.status IN ('previewing', 'created')"
    );
    expect(transitionSql).toContain(
      'CREDIT_PACK_PURCHASE_REQUEST_NOT_CLAIMED'
    );
    expect(chargeSql).toContain(
      "v_request.status IN ('previewing', 'created')"
    );
    expect(chargeSql).toContain("'request_not_claimed'");
    expect(chargeSql).toContain(
      "status IN ('charging', 'submitted', 'provider_unknown')"
    );
    expect(chargeSql).toContain(
      "AND reconciliation_decision = 'definitive_no_match'"
    );
    expect(chargeSql).not.toContain(
      "AND status IN ('created', 'submitted', 'provider_unknown')"
    );
  });

  test('quarantines an unfinalized v0 provider completion without minting', () => {
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);
    const requestNotClaimed = chargeSql.indexOf(
      "v_request.status IN ('previewing', 'created')"
    );
    const withheldStart = chargeSql.indexOf(
      'IF v_withheld_reason IS NOT NULL THEN'
    );
    const grantStart = chargeSql.indexOf(
      'v_result := public.apply_credit_pack_purchase('
    );
    const withheldSql = chargeSql.slice(withheldStart, grantStart);

    expect(securePaymentSql).toMatch(
      /status IN \([\s\S]{0,100}'previewing'[\s\S]{0,180}'withheld'[\s\S]{0,260}confirmation_version = 0/
    );
    expect(requestNotClaimed).toBeGreaterThan(0);
    expect(requestNotClaimed).toBeLessThan(withheldStart);
    expect(chargeSql).toContain(
      "v_withheld_reason := 'request_not_claimed'"
    );
    expect(withheldSql).toMatch(
      /AND status IN \([\s\S]{0,80}'previewing',[\s\S]{0,80}'created',[\s\S]{0,80}'charging'/
    );
    expect(withheldSql).not.toContain(
      'public.apply_credit_pack_purchase('
    );
    expect(chargeSql.slice(grantStart)).toContain(
      "status IN ('charging', 'submitted', 'provider_unknown')"
    );
    expect(chargeSql.slice(grantStart)).toContain(
      "status = 'failed'"
    );
    expect(chargeSql.slice(grantStart)).not.toContain(
      "AND status IN ('previewing', 'created'"
    );
  });

  test('enforces preview and confirmed-total shape at the table boundary', () => {
    expect(securePaymentSql).toMatch(
      /credit_pack_purchase_requests_preview_contract_check[\s\S]{0,280}status IN \([\s\S]{0,100}'previewing'[\s\S]{0,180}'withheld'[\s\S]{0,180}'refunded'[\s\S]{0,180}'chargeback'[\s\S]{0,180}'failed'[\s\S]{0,100}confirmation_version = 0[\s\S]{0,500}approved_grand_total_tax IS NULL/
    );
    expect(securePaymentSql).toMatch(
      /status <> 'previewing'[\s\S]{0,120}confirmation_version >= 1[\s\S]{0,500}approved_grand_total_tax IS NOT NULL/
    );
    expect(securePaymentSql).toMatch(
      /credit_pack_purchase_requests_approved_totals_check[\s\S]{0,260}approved_subtotal = unit_amount[\s\S]{0,220}approved_total::bigint =[\s\S]{0,180}approved_grand_total_tax = approved_tax/
    );
  });

  test('requires immutable provider and subscription-history proof before grant', () => {
    for (const field of [
      'provider_subscription_updated_at TIMESTAMPTZ NOT NULL',
      'provider_api_request_id TEXT',
      'provider_plan_price_id TEXT NOT NULL',
      'eligible_snapshot_event_id TEXT NOT NULL',
      'eligible_snapshot_occurred_at TIMESTAMPTZ NOT NULL',
      'history_proof_status   TEXT'
    ]) {
      expect(securePaymentSql).toContain(field);
    }

    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);

    expect(chargeSql).toContain(
      "v_history_status NOT IN (\n       'eligible',"
    );
    expect(chargeSql).toMatch(
      /FROM public\.paddle_subscription_lifecycle_events[\s\S]{0,220}occurred_at >= v_request\.eligible_snapshot_occurred_at[\s\S]{0,100}occurred_at <= p_purchased_at/
    );
    expect(chargeSql).toContain(
      "v_history_status = 'ineligible'"
    );
    expect(chargeSql).toContain(
      "v_history_status = 'unavailable'"
    );
    expect(chargeSql).toContain(
      "v_history_status IN ('ambiguous', 'not_checked')"
    );
    expect(chargeSql).toContain(
      "IS DISTINCT FROM 'subscription_one_off_charge_applied'"
    );
    expect(chargeSql).toContain(
      'p_history_event_occurred_at < v_request.authorized_at'
    );
    expect(chargeSql).toContain(
      'p_history_event_occurred_at > p_purchased_at'
    );
    expect(chargeSql).toContain(
      "'subscription_history_proof_invalid'"
    );
  });

  test('persists approved preview totals and signed completed totals', () => {
    for (const field of [
      'approved_subtotal      INTEGER',
      'approved_discount      INTEGER',
      'approved_tax           INTEGER',
      'approved_total         INTEGER',
      'approved_credit        INTEGER',
      'approved_balance       INTEGER',
      'approved_grand_total   INTEGER',
      'approved_grand_total_tax INTEGER',
      'actual_subtotal        INTEGER',
      'actual_discount        INTEGER',
      'actual_tax             INTEGER',
      'actual_total           INTEGER',
      'actual_credit          INTEGER',
      'actual_balance         INTEGER',
      'actual_grand_total     INTEGER',
      'actual_grand_total_tax INTEGER'
    ]) {
      expect(securePaymentSql).toContain(field);
    }

    for (const argumentName of [
      'p_approved_subtotal',
      'p_approved_discount',
      'p_approved_tax',
      'p_approved_total',
      'p_approved_credit',
      'p_approved_balance',
      'p_approved_grand_total',
      'p_approved_grand_total_tax',
      'p_actual_subtotal',
      'p_actual_discount',
      'p_actual_tax',
      'p_actual_total',
      'p_actual_credit',
      'p_actual_balance',
      'p_actual_grand_total',
      'p_actual_grand_total_tax'
    ]) {
      expect(securePaymentSql).toContain(`${argumentName} integer`);
    }

    expect(securePaymentSql).toContain(
      'p_approved_subtotal IS DISTINCT FROM v_request.unit_amount'
    );
    expect(securePaymentSql).toContain(
      'p_approved_discount IS DISTINCT FROM 0'
    );
    expect(securePaymentSql).toContain(
      'p_approved_credit IS DISTINCT FROM 0'
    );
    expect(securePaymentSql).toContain(
      'p_approved_total::bigint IS DISTINCT FROM'
    );
    expect(securePaymentSql).toContain(
      'p_approved_subtotal::bigint + p_approved_tax::bigint'
    );
    expect(securePaymentSql).toContain(
      'p_approved_grand_total IS DISTINCT FROM p_approved_total'
    );
    expect(securePaymentSql).toContain(
      'p_approved_balance IS DISTINCT FROM p_approved_grand_total'
    );
    expect(securePaymentSql).toContain(
      'p_approved_grand_total_tax IS DISTINCT FROM p_approved_tax'
    );
    expect(securePaymentSql).toContain(
      'v_request.approved_subtotal IS DISTINCT FROM p_actual_subtotal'
    );
    expect(securePaymentSql).toContain(
      'v_request.approved_grand_total_tax'
    );
    expect(securePaymentSql).toContain(
      'IS DISTINCT FROM p_actual_grand_total_tax'
    );
    expect(securePaymentSql).toContain(
      'p_actual_balance IS DISTINCT FROM 0'
    );
    expect(securePaymentSql).toContain(
      "v_withheld_reason := 'transaction_totals_mismatch'"
    );
    expect(securePaymentSql).not.toContain(
      'v_request.approved_balance IS DISTINCT FROM p_actual_balance'
    );
  });

  test('withholds malformed or missing actual totals instead of raising', () => {
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const advisoryLockStart = securePaymentSql.indexOf(
      'PERFORM pg_advisory_xact_lock',
      chargeStart
    );
    const validationSql = securePaymentSql.slice(
      chargeStart,
      advisoryLockStart
    );
    const mismatchStart = securePaymentSql.indexOf(
      'v_request.approved_subtotal IS DISTINCT FROM p_actual_subtotal',
      chargeStart
    );
    const mismatchEnd = securePaymentSql.indexOf(
      'SELECT *',
      mismatchStart
    );
    const mismatchSql = securePaymentSql.slice(mismatchStart, mismatchEnd);

    expect(validationSql).not.toContain('p_actual_subtotal IS NULL');
    expect(validationSql).not.toContain('p_actual_grand_total_tax IS NULL');
    expect(mismatchSql).toContain("'transaction_totals_mismatch'");
    expect(mismatchSql).not.toContain('RAISE EXCEPTION');
  });

  test('withholds impossible signed transaction timelines and retains the evidence', () => {
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);
    const mismatchStart = chargeSql.indexOf(
      "v_withheld_reason := 'transaction_timeline_mismatch'"
    );
    const receiptInsert = chargeSql.indexOf(
      'INSERT INTO public.credit_pack_payment_receipts'
    );

    expect(chargeSql).toMatch(
      /p_transaction_created_at < v_request\.authorized_at[\s\S]{0,100}p_captured_at < v_request\.authorized_at[\s\S]{0,100}p_transaction_created_at > p_captured_at[\s\S]{0,100}p_captured_at > p_purchased_at/
    );
    expect(mismatchStart).toBeGreaterThan(0);
    expect(receiptInsert).toBeGreaterThan(mismatchStart);
    expect(chargeSql).toMatch(
      /p_transaction_created_at,\s+p_captured_at,\s+p_purchased_at,\s+v_history_status/
    );
  });

  test('stores payment and adjustment receipts before resolving entitlement', () => {
    for (const table of [
      'credit_pack_payment_receipts',
      'credit_pack_adjustment_receipts'
    ]) {
      expect(securePaymentSql).toContain(`CREATE TABLE public.${table}`);
      expect(securePaymentSql).toContain(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`
      );
      expect(securePaymentSql).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE public\\.${table}[\\s\\S]{0,80}` +
          'FROM PUBLIC, anon, authenticated, service_role;'
        )
      );
      expect(securePaymentSql).toMatch(
        new RegExp(
          `GRANT SELECT[\\s\\S]{0,80}` +
          `ON TABLE public\\.${table} TO service_role;`
        )
      );
      expect(securePaymentSql).not.toMatch(
        new RegExp(
          `GRANT SELECT, INSERT, UPDATE, DELETE[\\s\\S]{0,80}` +
          `ON TABLE public\\.${table} TO service_role;`
        )
      );
    }

    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);
    expect(chargeSql.indexOf('INSERT INTO public.credit_pack_payment_receipts'))
      .toBeLessThan(chargeSql.indexOf('IF v_withheld_reason IS NOT NULL THEN'));
    expect(chargeSql.indexOf('INSERT INTO public.credit_pack_payment_receipts'))
      .toBeLessThan(chargeSql.indexOf('public.apply_credit_pack_purchase('));
  });

  test('retains immutable financial evidence across account and request deletion', () => {
    expect(orderedSubscriptionSql).toMatch(
      /user_id uuid REFERENCES public\.profiles\(id\) ON DELETE SET NULL/
    );
    expect(securePaymentSql).toMatch(
      /request_id uuid,\s+request_reference uuid NOT NULL/
    );
    expect(securePaymentSql).toMatch(
      /user_id uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL,\s+authorized_user_id uuid NOT NULL/
    );
    expect(securePaymentSql).toMatch(
      /user_id\s+UUID REFERENCES auth\.users\(id\) ON DELETE SET NULL,\s+authorized_user_id\s+UUID NOT NULL/
    );
    expect(securePaymentSql).toMatch(
      /credit_pack_payment_receipts_request_id_fkey[\s\S]{0,180}ON DELETE SET NULL/
    );
    expect(securePaymentSql).not.toMatch(
      /credit_pack_payment_receipts_request_id_fkey[\s\S]{0,180}ON DELETE CASCADE/
    );
    expect(securePaymentSql).not.toMatch(
      /paddle_subscription_lifecycle_events[\s\S]{0,220}ON DELETE CASCADE/
    );
    expect(orderedSubscriptionSql).toContain(
      'paddle_subscription_lifecycle_events_user_idx'
    );
    expect(securePaymentSql).toContain(
      'credit_pack_payment_receipts_live_user_idx'
    );
    expect(securePaymentSql).toContain(
      'credit_pack_purchase_requests_live_user_idx'
    );
    expect(securePaymentSql).toContain(
      'CREATE INDEX credit_pack_adjustments_transaction_idx'
    );
  });

  test('fails closed and records a completed charge after account deletion', () => {
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);
    const receiptInsert = chargeSql.indexOf(
      'INSERT INTO public.credit_pack_payment_receipts'
    );
    const deletedBranch = chargeSql.indexOf(
      '\n  IF v_account_deleted THEN',
      receiptInsert
    );
    const intentInsert = chargeSql.indexOf(
      'INSERT INTO public.credit_pack_checkout_intents'
    );
    const deletedSql = chargeSql.slice(deletedBranch, intentInsert);

    expect(chargeSql).toContain(
      'v_account_deleted := v_request_snapshot.user_id IS NULL'
    );
    expect(chargeSql).toContain('IF NOT v_account_deleted THEN');
    expect(receiptInsert).toBeGreaterThan(0);
    expect(deletedBranch).toBeGreaterThan(receiptInsert);
    expect(intentInsert).toBeGreaterThan(deletedBranch);
    expect(deletedSql).toContain(
      "'status', COALESCE(v_terminal_adjustment_status, 'withheld')"
    );
    expect(deletedSql).toContain("'entitlementGranted', false");
    expect(deletedSql).toContain('ELSE v_withheld_reason');
    expect(deletedSql).not.toContain('public.sync_credit_lot_balance');
    expect(deletedSql).not.toContain('public.apply_credit_pack_purchase');
  });

  test('resolves account-deleted adjustments from retained receipts only', () => {
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const liveAccountStart = securePaymentSql.indexOf(
      "IF v_payment_receipt.decision <> 'withheld' THEN",
      adjustmentStart
    );
    const deletedAdjustmentSql = securePaymentSql.slice(
      adjustmentStart,
      liveAccountStart
    );

    expect(deletedAdjustmentSql).toContain(
      'IF v_payment_receipt.user_id IS NULL THEN'
    );
    expect(deletedAdjustmentSql).toContain(
      "btrim(p_action) IN ('refund', 'credit', 'chargeback')"
    );
    expect(deletedAdjustmentSql).toContain('SET matched = true');
    expect(deletedAdjustmentSql).toContain('applied = true');
    expect(deletedAdjustmentSql).toContain('SET status = v_terminal_status');
    expect(deletedAdjustmentSql).toContain("'reason', 'manual_review'");
    expect(deletedAdjustmentSql).not.toContain(
      'public.apply_credit_pack_adjustment('
    );
    expect(deletedAdjustmentSql).not.toContain(
      'public.sync_credit_lot_balance'
    );
  });

  test('uses non-locking review lookups and blocks every unresolved pack review', () => {
    const createStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.begin_credit_pack_purchase_preview'
    );
    const transitionStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.finalize_credit_pack_purchase_preview'
    );
    const createSql = securePaymentSql.slice(createStart, transitionStart);
    const lookupStart = createSql.indexOf(
      'FROM public.credit_pack_payment_receipts'
    );
    const lookupEnd = createSql.indexOf('IF FOUND THEN', lookupStart);
    const lookupSql = createSql.slice(lookupStart, lookupEnd);

    expect(lookupSql).toContain(
      "decision IN ('withheld', 'chargeback')"
    );
    expect(lookupSql).not.toContain('FOR UPDATE');

    const unresolvedReviewStart = createSql.indexOf(
      'SELECT review_item.*'
    );
    const unresolvedReviewEnd = createSql.indexOf(
      'IF FOUND THEN',
      unresolvedReviewStart
    );
    const unresolvedReviewSql = createSql.slice(
      unresolvedReviewStart,
      unresolvedReviewEnd
    );

    expect(unresolvedReviewSql).toContain(
      'FROM public.credit_pack_purchases AS purchase'
    );
    expect(unresolvedReviewSql).toContain(
      'purchase.user_id = p_user_id'
    );
    expect(unresolvedReviewSql).toContain(
      'purchase.review_required = true'
    );
    expect(unresolvedReviewSql).toContain(
      'FROM public.credit_pack_payment_receipts AS receipt'
    );
    expect(unresolvedReviewSql).toContain(
      'JOIN public.credit_pack_adjustment_receipts AS adjustment'
    );
    expect(unresolvedReviewSql).toContain(
      'receipt.authorized_user_id = p_user_id'
    );
    expect(unresolvedReviewSql).toContain(
      'adjustment.review_required = true'
    );
    expect(unresolvedReviewSql).not.toContain('FOR UPDATE');

    const reviewReturnSql = createSql.slice(
      unresolvedReviewEnd,
      createSql.indexOf(
        'SELECT *',
        unresolvedReviewEnd
      )
    );
    expect(reviewReturnSql).toContain("'reason', 'purchase_review_required'");
  });

  test('persists request-level review state for status recovery', () => {
    expect(securePaymentSql).toMatch(
      /CREATE TABLE public\.credit_pack_purchase_requests[\s\S]*?review_required\s+BOOLEAN NOT NULL DEFAULT false/
    );

    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);
    const adjustmentSql = securePaymentSql.slice(adjustmentStart);

    expect(chargeSql).toContain(
      'v_request.review_required'
    );
    expect(chargeSql).toContain(
      "COALESCE(v_terminal_adjustment_status, 'withheld') <> 'refunded'"
    );
    expect(chargeSql).toContain('review_required = false');

    expect(adjustmentSql).toMatch(
      /UPDATE public\.credit_pack_purchase_requests[\s\S]{0,140}SET review_required = review_required[\s\S]{0,180}v_result ->> 'reviewRequired'/
    );
    expect(adjustmentSql).toMatch(
      /SET status = v_terminal_status,[\s\S]{0,180}review_required = review_required[\s\S]{0,220}v_result ->> 'reviewRequired'/
    );

    const withheldPurchaseStart = adjustmentSql.indexOf(
      'IF v_payment_receipt.decision <> \'withheld\' THEN'
    );
    const withheldPurchaseSql = adjustmentSql.slice(
      adjustmentSql.indexOf(
        'SELECT *',
        withheldPurchaseStart
      )
    );
    expect(withheldPurchaseSql).toContain(
      "review_required = v_terminal_status = 'chargeback'"
    );
  });

  test('records a withheld payment without creating or applying a credit lot', () => {
    expect(securePaymentSql).toMatch(
      /status = 'withheld'[\s\S]{0,120}lot_id IS NULL[\s\S]{0,120}withheld_reason IS NOT NULL/
    );

    const withheldStart = securePaymentSql.indexOf(
      'IF v_withheld_reason IS NOT NULL THEN'
    );
    const withheldEnd = securePaymentSql.indexOf(
      '\n  IF v_request.status IN (\n',
      withheldStart
    );
    const withheldSql = securePaymentSql.slice(withheldStart, withheldEnd);

    expect(withheldSql).toContain("'withheld'");
    expect(withheldSql).toContain("'entitlement_withheld'");
    expect(withheldSql).toContain("'entitlementGranted', false");
    expect(withheldSql).toMatch(
      /review_required,\s+purchased_at[\s\S]{0,900}END,\s+v_terminal_adjustment_status IS NULL\s+OR v_terminal_adjustment_status = 'chargeback',\s+p_purchased_at/
    );
    expect(withheldSql).toMatch(
      /UPDATE public\.credit_pack_purchase_requests[\s\S]{0,1500}review_required =\s+v_terminal_adjustment_status IS NULL\s+OR v_terminal_adjustment_status = 'chargeback'/
    );
    expect(withheldSql).not.toContain('public.apply_credit_pack_purchase(');
    expect(withheldSql).not.toContain('INSERT INTO public.credit_lots');
  });

  test('persists an early adjustment before payment lookup and blocks a later grant', () => {
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);
    const adjustmentSql = securePaymentSql.slice(adjustmentStart);

    expect(adjustmentSql.indexOf(
      'INSERT INTO public.credit_pack_adjustment_receipts'
    )).toBeLessThan(adjustmentSql.indexOf(
      'FROM public.credit_pack_payment_receipts'
    ));
    expect(adjustmentSql).toContain("'reason', 'payment_not_recorded'");
    expect(chargeSql).toContain(
      'FROM public.credit_pack_adjustment_receipts'
    );
    expect(chargeSql).toContain(
      "'provider_adjustment_preceded_completion'"
    );
    expect(chargeSql).toContain(
      "hashtextextended('credit_pack_transaction:' || btrim(p_transaction_id), 0)"
    );
    expect(adjustmentSql).toContain(
      "hashtextextended('credit_pack_transaction:' || btrim(p_transaction_id), 0)"
    );
  });

  test('finalizes approved full pre-completion adjustments without minting', () => {
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);
    const withheldStart = chargeSql.indexOf(
      'IF v_withheld_reason IS NOT NULL THEN'
    );
    const withheldEnd = chargeSql.indexOf(
      '\n  IF v_request.status IN (\n',
      withheldStart
    );
    const withheldSql = chargeSql.slice(withheldStart, withheldEnd);

    expect(chargeSql).toMatch(
      /v_preceding_adjustment\.status = 'approved'[\s\S]{0,180}adjustment_type, ''\) = 'full'[\s\S]{0,160}action IN \('refund', 'credit'\)[\s\S]{0,100}THEN 'refunded'/
    );
    expect(chargeSql).toMatch(
      /v_preceding_adjustment\.status = 'approved'[\s\S]{0,180}adjustment_type, ''\) = 'full'[\s\S]{0,160}action = 'chargeback'[\s\S]{0,100}THEN 'chargeback'/
    );
    expect(withheldSql).toContain(
      "COALESCE(v_terminal_adjustment_status, 'withheld')"
    );
    expect(withheldSql).toContain(
      'v_terminal_adjustment_status IS NOT NULL'
    );
    expect(withheldSql).toContain(
      "'payment_refunded_before_entitlement'"
    );
    expect(withheldSql).toContain(
      "'payment_chargeback_before_entitlement'"
    );
    expect(withheldSql).toContain("'entitlementGranted', false");
    expect(withheldSql).toContain('adjusted_at');
    expect(withheldSql).toContain(
      'THEN v_preceding_adjustment.occurred_at'
    );
    expect(withheldSql).toMatch(
      /provider_event_id,\s+withheld_reason,\s+review_required,\s+purchased_at/
    );
    expect(withheldSql).toMatch(
      /v_terminal_adjustment_status IS NULL\s+OR v_terminal_adjustment_status = 'chargeback',\s+p_purchased_at/
    );
    expect(withheldSql).not.toContain('public.apply_credit_pack_purchase(');
    expect(withheldSql).not.toContain('INSERT INTO public.credit_lots');
  });

  test('keeps unresolved adjustment flags monotonic and scopes pre-completion resolution', () => {
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);
    const adjustmentSql = securePaymentSql.slice(adjustmentStart);
    const preCompletionReceiptUpdate = chargeSql.slice(
      chargeSql.indexOf('UPDATE public.credit_pack_adjustment_receipts'),
      chargeSql.indexOf('RETURN jsonb_build_object', chargeSql.indexOf(
        'UPDATE public.credit_pack_adjustment_receipts'
      ))
    );

    expect(chargeSql).toContain(
      'public.credit_pack_adjustments.applied OR EXCLUDED.applied'
    );
    expect(chargeSql).toContain(
      'public.credit_pack_adjustments.review_required'
    );
    expect(preCompletionReceiptUpdate).toContain(
      'applied = applied OR (v_terminal_adjustment_status IS NOT NULL)'
    );
    expect(preCompletionReceiptUpdate).toContain(
      'review_required = review_required OR'
    );
    expect(preCompletionReceiptUpdate).toContain(
      'WHERE adjustment_id = v_preceding_adjustment.adjustment_id'
    );
    expect(preCompletionReceiptUpdate).not.toContain(
      'WHERE transaction_id = btrim(p_transaction_id)'
    );
    expect(adjustmentSql).toContain(
      "applied = applied\n             OR COALESCE((v_result ->> 'applied')::boolean, false)"
    );
    expect(adjustmentSql).toContain(
      'review_required = review_required'
    );
  });

  test('keeps chargeback as the strongest terminal payment decision', () => {
    const chargeStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge'
    );
    const adjustmentStart = securePaymentSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2'
    );
    const chargeSql = securePaymentSql.slice(chargeStart, adjustmentStart);
    const selectionStart = chargeSql.indexOf(
      'FROM public.credit_pack_adjustment_receipts'
    );
    const selectionEnd = chargeSql.indexOf('LIMIT 1', selectionStart);
    const selectionSql = chargeSql.slice(selectionStart, selectionEnd);
    const adjustmentSql = securePaymentSql.slice(adjustmentStart);
    const deletedStart = adjustmentSql.indexOf(
      'IF v_payment_receipt.user_id IS NULL THEN'
    );
    const liveStart = adjustmentSql.indexOf(
      "IF v_payment_receipt.decision <> 'withheld' THEN"
    );
    const withheldStart = adjustmentSql.indexOf(
      'SELECT *\n    INTO v_purchase',
      liveStart
    );
    const deletedSql = adjustmentSql.slice(deletedStart, liveStart);
    const liveSql = adjustmentSql.slice(liveStart, withheldStart);
    const withheldSql = adjustmentSql.slice(withheldStart);

    expect(selectionSql.indexOf("action = 'chargeback'"))
      .toBeLessThan(selectionSql.indexOf("action IN ('refund', 'credit')"));
    for (const terminalSql of [deletedSql, liveSql]) {
      expect(terminalSql).toContain(
        "WHEN v_payment_receipt.decision = 'chargeback'"
      );
      expect(terminalSql).toContain(
        "OR btrim(p_action) = 'chargeback'"
      );
      expect(terminalSql).toContain('SET decision = v_terminal_status');
      expect(terminalSql).toContain('SET status = v_terminal_status');
    }
    expect(securePaymentSql).toMatch(
      /status IN \([\s\S]{0,180}'refunded',[\s\S]{0,80}'chargeback'[\s\S]{0,80}'failed'/
    );
    expect(securePaymentSql).toMatch(
      /credit_pack_purchase_requests_refunded_fields_check[\s\S]{0,180}status <> 'refunded' AND refunded_at IS NULL/
    );
    expect(liveSql).toContain(
      "AND status IN ('fulfilled', 'refunded')"
    );
    expect(liveSql).toContain(
      "AND status IN ('refunded', 'chargeback')"
    );
    expect(liveSql).toContain("SET status = 'chargeback'");
    expect(liveSql).toContain('review_required = true');
    expect(liveSql).toMatch(
      /UPDATE public\.credit_pack_adjustment_receipts[\s\S]{0,260}SET matched = true,[\s\S]{0,80}applied = true,[\s\S]{0,160}v_terminal_status = 'chargeback'/
    );
    expect(liveSql).toMatch(
      /UPDATE public\.credit_pack_adjustments[\s\S]{0,180}SET applied = true,[\s\S]{0,160}v_terminal_status = 'chargeback'/
    );
    expect(liveSql).toContain("'applied', true");
    expect(liveSql).toContain("'chargeback_reconciled'");
    expect(liveSql).toContain("'chargeback_preserved'");
    for (const table of [
      'credit_pack_purchases',
      'credit_pack_adjustments',
      'credit_pack_adjustment_receipts'
    ]) {
      expect(withheldSql).toMatch(
        new RegExp(
          `UPDATE public\\.${table}[\\s\\S]{0,260}` +
          "review_required = v_terminal_status = 'chargeback'"
        )
      );
    }
  });

  test('revokes direct service-role writes to temporal and ledger tables', () => {
    for (const table of [
      'paddle_event_watermarks',
      'paddle_subscription_states'
    ]) {
      expect(orderedSubscriptionSql).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE public\\.${table}` +
          '[\\s\\S]{0,100}FROM PUBLIC, anon, authenticated, service_role;'
        )
      );
      expect(orderedSubscriptionSql).toMatch(
        new RegExp(
          `GRANT SELECT ON TABLE public\\.${table} TO service_role;`
        )
      );
    }

    for (const table of [
      'credit_lots',
      'credit_operations',
      'credit_operation_allocations',
      'credit_pack_checkout_intents',
      'credit_pack_purchases',
      'credit_pack_adjustments'
    ]) {
      expect(securePaymentSql).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE[\\s\\S]{0,300}public\\.${table}` +
          '[\\s\\S]{0,300}FROM service_role;'
        )
      );
      expect(securePaymentSql).toMatch(
        new RegExp(
          `GRANT SELECT ON TABLE[\\s\\S]{0,300}public\\.${table}` +
          '[\\s\\S]{0,300}TO service_role;'
        )
      );
    }
    expect(securePaymentSql).toContain(
      'REVOKE ALL ON SEQUENCE public.credit_lots_id_seq FROM service_role;'
    );
    for (const functionName of [
      'register_credit_pack_checkout_intent',
      'apply_credit_pack_purchase',
      'apply_credit_pack_adjustment'
    ]) {
      expect(securePaymentSql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\(` +
          '[\\s\\S]{0,220}\\) FROM service_role;'
        )
      );
    }
    expect(securePaymentSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.apply_subscription_payment\(\s*text, uuid, text, integer, boolean\s*\) FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(securePaymentSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.apply_plan_change\(\s*uuid, text, integer\s*\) FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(securePaymentSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.expire_subscription_credits\(\s*uuid\s*\) FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(securePaymentSql).toMatch(
      /REVOKE ALL ON TABLE public\.credit_pack_purchase_requests[\s\S]{0,100}FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(securePaymentSql).toMatch(
      /GRANT SELECT[\s\S]{0,80}ON TABLE public\.credit_pack_purchase_requests TO service_role;/
    );
  });

  test('keeps temporal payment RPCs service-role only', () => {
    const normalizedSecurePaymentSql = securePaymentSql.replace(/\s+/g, ' ');

    expect(orderedSubscriptionSql).toContain(
      'ALTER TABLE public.paddle_subscription_lifecycle_events ENABLE ROW LEVEL SECURITY;'
    );
    expect(orderedSubscriptionSql).toMatch(
      /REVOKE ALL ON TABLE public\.paddle_subscription_lifecycle_events[\s\S]{0,100}FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(orderedSubscriptionSql).toMatch(
      /GRANT SELECT[\s\S]{0,80}ON TABLE public\.paddle_subscription_lifecycle_events TO service_role;/
    );
    expect(orderedSubscriptionSql).not.toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]{0,80}ON TABLE public\.paddle_subscription_lifecycle_events TO service_role;/
    );

    for (const functionName of [
      'begin_credit_pack_purchase_preview',
      'finalize_credit_pack_purchase_preview',
      'claim_credit_pack_purchase_request',
      'cancel_credit_pack_purchase_request',
      'expire_credit_pack_purchase_request',
      'transition_credit_pack_purchase_request',
      'reconcile_credit_pack_purchase_no_match',
      'apply_credit_pack_subscription_charge',
      'apply_credit_pack_adjustment_v2'
    ]) {
      expect(securePaymentSql).toMatch(
        new RegExp(
          `CREATE OR REPLACE FUNCTION public\\.${functionName}\\([\\s\\S]*?` +
          'SECURITY DEFINER\\s+SET search_path = public, pg_temp'
        )
      );
      expect(securePaymentSql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\([\\s\\S]*?\\) ` +
          'FROM PUBLIC, anon, authenticated, service_role;'
        )
      );
      expect(securePaymentSql).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([\\s\\S]*?\\) ` +
          'TO service_role;'
        )
      );
    }

    const beginSignature =
      'uuid, uuid, text, text, text, integer, integer, text, integer, ' +
      'timestamptz, text, timestamptz';
    const reconciliationSignature =
      'uuid, uuid, text, text, timestamptz, timestamptz, timestamptz, ' +
      'integer, integer, text[], text';
    const chargeSignature =
      'uuid, text, text, text, text, text, text, integer, integer, text, ' +
      'integer, integer, integer, integer, integer, integer, integer, ' +
      'integer, integer, timestamptz, text, timestamptz, timestamptz, ' +
      'text, text, text, text, timestamptz';
    expect(normalizedSecurePaymentSql).toContain(
      `REVOKE ALL ON FUNCTION public.begin_credit_pack_purchase_preview( ` +
      `${beginSignature} ) FROM PUBLIC, anon, authenticated, service_role;`
    );
    expect(normalizedSecurePaymentSql).toContain(
      `REVOKE ALL ON FUNCTION public.reconcile_credit_pack_purchase_no_match( ` +
      `${reconciliationSignature} ) FROM PUBLIC, anon, authenticated, service_role;`
    );
    expect(normalizedSecurePaymentSql).toContain(
      `GRANT EXECUTE ON FUNCTION public.reconcile_credit_pack_purchase_no_match( ` +
      `${reconciliationSignature} ) TO service_role;`
    );
    expect(normalizedSecurePaymentSql).toContain(
      `GRANT EXECUTE ON FUNCTION public.apply_credit_pack_subscription_charge( ` +
      `${chargeSignature} ) TO service_role;`
    );
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
