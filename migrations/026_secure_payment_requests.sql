-- ============================================================
-- Migration 026: server-bound subscription and add-on payments
--
-- Apply after 024_credit_lot_ledger.sql and
-- 025_paddle_event_ordering.sql. Money feature flags must remain false
-- until the cloned-schema race suite and Paddle Sandbox purchase/refund
-- matrix pass.
-- ============================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure(
    'public.apply_credit_pack_purchase(text,uuid,text,text,text,integer,integer,text,text,integer,timestamp with time zone)'
  ) IS NULL THEN
    RAISE EXCEPTION 'SECURE_PAYMENT_REQUESTS_REQUIRES_MIGRATION_024';
  END IF;
  IF to_regprocedure(
    'public.apply_ordered_subscription_payment(text,uuid,text,integer,text,text,timestamptz,boolean,boolean)'
  ) IS NULL THEN
    RAISE EXCEPTION 'SECURE_PAYMENT_REQUESTS_REQUIRES_MIGRATION_025';
  END IF;
END;
$preflight$;

-- Migration 024 exposes only the ledger reads needed by service_role.
-- Every mutation now goes through a SECURITY DEFINER RPC that enforces the
-- ledger lock order and invariants, so retain read-only diagnostics only.
REVOKE ALL ON TABLE
  public.credit_lots,
  public.credit_operations,
  public.credit_operation_allocations,
  public.credit_pack_checkout_intents,
  public.credit_pack_purchases,
  public.credit_pack_adjustments
FROM service_role;
GRANT SELECT ON TABLE
  public.credit_lots,
  public.credit_operations,
  public.credit_operation_allocations,
  public.credit_pack_checkout_intents,
  public.credit_pack_purchases,
  public.credit_pack_adjustments
TO service_role;
REVOKE ALL ON SEQUENCE public.credit_lots_id_seq FROM service_role;

-- The original pack RPCs do not bind an authorization request, signed totals,
-- subscription history, or immutable payment receipt. The v2 SECURITY DEFINER
-- wrappers can still call them as their owner, but service_role must not bypass
-- the secured flow by invoking these legacy entry points directly.
REVOKE ALL ON FUNCTION public.register_credit_pack_checkout_intent(
  text, uuid, text, text, text, text, integer, integer, text, integer
) FROM service_role;
REVOKE ALL ON FUNCTION public.apply_credit_pack_purchase(
  text, uuid, text, text, text, integer, integer, text, text, integer, timestamptz
) FROM service_role;
REVOKE ALL ON FUNCTION public.apply_credit_pack_adjustment(
  text, text, text, text, text
) FROM service_role;
-- These subscription helpers are internal implementation details of the
-- ordered snapshot/payment wrappers from migration 025. Direct service-role
-- execution would bypass lifecycle ordering and terminal-state checks.
REVOKE ALL ON FUNCTION public.apply_subscription_payment(
  text, uuid, text, integer, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_plan_change(
  uuid, text, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.expire_subscription_credits(
  uuid
) FROM PUBLIC, anon, authenticated, service_role;

-- The adjustment FK cascades when a retained account graph is deleted. Index
-- the referencing side so PostgreSQL does not scan and lock the full table.
CREATE INDEX credit_pack_adjustments_transaction_idx
  ON public.credit_pack_adjustments (transaction_id);

-- Migration 024 intentionally starts with only fulfilled purchases. Extend its
-- audit graph before introducing request-bound charges so a paid transaction
-- can be recorded without minting a credit lot.
ALTER TABLE public.credit_pack_checkout_intents
  DROP CONSTRAINT credit_pack_checkout_intents_status_check,
  ADD COLUMN withheld_at timestamptz,
  ADD COLUMN withheld_reason text,
  ADD COLUMN refunded_at timestamptz,
  ADD CONSTRAINT credit_pack_checkout_intents_status_check
    CHECK (status IN ('pending', 'fulfilled', 'withheld', 'refunded')),
  ADD CONSTRAINT credit_pack_checkout_intents_temporal_state_check
    CHECK (
      (
        status = 'pending'
        AND fulfilled_at IS NULL
        AND withheld_at IS NULL
        AND withheld_reason IS NULL
        AND refunded_at IS NULL
      )
      OR
      (
        status = 'fulfilled'
        AND fulfilled_at IS NOT NULL
        AND withheld_at IS NULL
        AND withheld_reason IS NULL
        AND refunded_at IS NULL
      )
      OR
      (
        status = 'withheld'
        AND fulfilled_at IS NULL
        AND withheld_at IS NOT NULL
        AND withheld_reason IS NOT NULL
        AND refunded_at IS NULL
      )
      OR
      (
        status = 'refunded'
        AND refunded_at IS NOT NULL
      )
    );

ALTER TABLE public.credit_pack_purchases
  DROP CONSTRAINT credit_pack_purchases_status_check,
  ADD COLUMN provider_event_id text,
  ADD COLUMN withheld_reason text,
  ADD CONSTRAINT credit_pack_purchases_status_check
    CHECK (status IN ('completed', 'withheld', 'refunded', 'chargeback')),
  ADD CONSTRAINT credit_pack_purchases_provider_event_id_check
    CHECK (
      provider_event_id IS NULL
      OR (btrim(provider_event_id) <> '' AND length(provider_event_id) <= 255)
    ),
  ADD CONSTRAINT credit_pack_purchases_withheld_state_check
    CHECK (
      (
        status = 'withheld'
        AND lot_id IS NULL
        AND withheld_reason IS NOT NULL
      )
      OR
      (
        status <> 'withheld'
        AND withheld_reason IS NULL
      )
    );

CREATE TABLE public.credit_pack_payment_receipts (
  transaction_id text PRIMARY KEY,
  request_id uuid,
  request_reference uuid NOT NULL,
  provider_event_id text NOT NULL UNIQUE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  authorized_user_id uuid NOT NULL,
  customer_id text NOT NULL,
  subscription_id text NOT NULL,
  pack_key text NOT NULL
    CHECK (pack_key IN ('usage_600', 'usage_1500', 'usage_3000')),
  provider_price_id text NOT NULL,
  provider_product_id text NOT NULL,
  credits integer NOT NULL CHECK (credits > 0),
  unit_amount integer NOT NULL CHECK (unit_amount > 0),
  currency_code text NOT NULL CHECK (currency_code = 'USD'),
  actual_subtotal integer,
  actual_discount integer,
  actual_tax integer,
  actual_total integer,
  actual_credit integer,
  actual_balance integer,
  actual_grand_total integer,
  actual_grand_total_tax integer,
  expiry_days integer NOT NULL CHECK (expiry_days = 365),
  transaction_created_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  history_proof_status text NOT NULL
    CHECK (
      history_proof_status IN (
        'eligible',
        'ineligible',
        'unavailable',
        'ambiguous',
        'not_checked'
      )
    ),
  history_api_request_id text,
  history_event_id text,
  history_event_action text,
  history_event_occurred_at timestamptz,
  decision text NOT NULL
    CHECK (decision IN ('granted', 'withheld', 'refunded', 'chargeback')),
  decision_reason text NOT NULL,
  adjusted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT credit_pack_payment_receipts_transaction_id_check
    CHECK (btrim(transaction_id) <> '' AND length(transaction_id) <= 255),
  CONSTRAINT credit_pack_payment_receipts_event_id_check
    CHECK (btrim(provider_event_id) <> '' AND length(provider_event_id) <= 255),
  CONSTRAINT credit_pack_payment_receipts_customer_id_check
    CHECK (btrim(customer_id) <> '' AND length(customer_id) <= 255),
  CONSTRAINT credit_pack_payment_receipts_subscription_id_check
    CHECK (btrim(subscription_id) <> '' AND length(subscription_id) <= 255),
  CONSTRAINT credit_pack_payment_receipts_price_id_check
    CHECK (btrim(provider_price_id) <> '' AND length(provider_price_id) <= 255),
  CONSTRAINT credit_pack_payment_receipts_product_id_check
    CHECK (btrim(provider_product_id) <> '' AND length(provider_product_id) <= 255),
  CONSTRAINT credit_pack_payment_receipts_history_set_check
    CHECK (
      (
        history_event_id IS NULL
        AND history_event_action IS NULL
        AND history_event_occurred_at IS NULL
      )
      OR
      (
        history_event_id IS NOT NULL
        AND history_event_action IS NOT NULL
        AND history_event_occurred_at IS NOT NULL
      )
    )
);

CREATE INDEX credit_pack_payment_receipts_user_decision_idx
  ON public.credit_pack_payment_receipts (
    authorized_user_id,
    decision,
    completed_at DESC
  );
CREATE INDEX credit_pack_payment_receipts_live_user_idx
  ON public.credit_pack_payment_receipts (user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX credit_pack_payment_receipts_request_idx
  ON public.credit_pack_payment_receipts (request_id, completed_at DESC);

ALTER TABLE public.credit_pack_payment_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credit_pack_payment_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT
  ON TABLE public.credit_pack_payment_receipts TO service_role;

-- Adjustment notifications can precede transaction.completed delivery. Keep a
-- transaction-keyed receipt even before the purchase row exists so later
-- fulfillment cannot mint credits for money that Paddle already adjusted.
CREATE TABLE public.credit_pack_adjustment_receipts (
  provider_event_id text PRIMARY KEY,
  adjustment_id text NOT NULL,
  transaction_id text NOT NULL,
  action text NOT NULL,
  adjustment_type text,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  matched boolean NOT NULL DEFAULT false,
  applied boolean NOT NULL DEFAULT false,
  review_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT credit_pack_adjustment_receipts_adjustment_id_check
    CHECK (btrim(adjustment_id) <> '' AND length(adjustment_id) <= 255),
  CONSTRAINT credit_pack_adjustment_receipts_event_id_check
    CHECK (btrim(provider_event_id) <> '' AND length(provider_event_id) <= 255),
  CONSTRAINT credit_pack_adjustment_receipts_transaction_id_check
    CHECK (btrim(transaction_id) <> '' AND length(transaction_id) <= 255),
  CONSTRAINT credit_pack_adjustment_receipts_action_check
    CHECK (btrim(action) <> '' AND length(action) <= 100),
  CONSTRAINT credit_pack_adjustment_receipts_type_check
    CHECK (
      adjustment_type IS NULL
      OR (btrim(adjustment_type) <> '' AND length(adjustment_type) <= 100)
    ),
  CONSTRAINT credit_pack_adjustment_receipts_status_check
    CHECK (btrim(status) <> '' AND length(status) <= 100)
);

CREATE INDEX credit_pack_adjustment_receipts_transaction_idx
  ON public.credit_pack_adjustment_receipts (transaction_id, occurred_at);
CREATE INDEX credit_pack_adjustment_receipts_adjustment_idx
  ON public.credit_pack_adjustment_receipts (adjustment_id, occurred_at);

ALTER TABLE public.credit_pack_adjustment_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credit_pack_adjustment_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT
  ON TABLE public.credit_pack_adjustment_receipts TO service_role;

CREATE TABLE public.credit_pack_purchase_requests (
  request_id             UUID PRIMARY KEY,
  transaction_id         TEXT UNIQUE,
  user_id                UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  authorized_user_id     UUID NOT NULL,
  customer_id            TEXT NOT NULL,
  subscription_id        TEXT NOT NULL,
  pack_key               TEXT NOT NULL
                         CHECK (pack_key IN ('usage_600', 'usage_1500', 'usage_3000')),
  credits                INTEGER NOT NULL CHECK (credits > 0),
  unit_amount            INTEGER NOT NULL CHECK (unit_amount > 0),
  currency_code          TEXT NOT NULL CHECK (currency_code = 'USD'),
  approved_subtotal      INTEGER CHECK (approved_subtotal >= 0),
  approved_discount      INTEGER CHECK (approved_discount >= 0),
  approved_tax           INTEGER CHECK (approved_tax >= 0),
  approved_total         INTEGER CHECK (approved_total >= 0),
  approved_credit        INTEGER CHECK (approved_credit >= 0),
  approved_balance       INTEGER CHECK (approved_balance >= 0),
  approved_grand_total   INTEGER CHECK (approved_grand_total >= 0),
  approved_grand_total_tax INTEGER CHECK (approved_grand_total_tax >= 0),
  expiry_days            INTEGER NOT NULL CHECK (expiry_days = 365),
  provider_price_id      TEXT,
  provider_product_id    TEXT,
  provider_event_id      TEXT,
  provider_subscription_updated_at TIMESTAMPTZ NOT NULL,
  provider_api_request_id TEXT,
  provider_plan_price_id TEXT NOT NULL,
  eligibility_check_started_at TIMESTAMPTZ NOT NULL,
  eligible_snapshot_event_id TEXT NOT NULL,
  eligible_snapshot_occurred_at TIMESTAMPTZ NOT NULL,
  authorized_at          TIMESTAMPTZ NOT NULL,
  authorization_expires_at TIMESTAMPTZ NOT NULL,
  transaction_created_at TIMESTAMPTZ,
  captured_at            TIMESTAMPTZ,
  actual_subtotal        INTEGER,
  actual_discount        INTEGER,
  actual_tax             INTEGER,
  actual_total           INTEGER,
  actual_credit          INTEGER,
  actual_balance         INTEGER,
  actual_grand_total     INTEGER,
  actual_grand_total_tax INTEGER,
  history_proof_status   TEXT,
  history_api_request_id TEXT,
  history_event_id       TEXT,
  history_event_action   TEXT,
  history_event_occurred_at TIMESTAMPTZ,
  reconciliation_decision TEXT,
  reconciliation_previous_status TEXT,
  reconciliation_checked_at TIMESTAMPTZ,
  reconciliation_window_start TIMESTAMPTZ,
  reconciliation_window_end TIMESTAMPTZ,
  reconciliation_pages_scanned INTEGER,
  reconciliation_transactions_scanned INTEGER,
  reconciliation_provider_request_ids TEXT[],
  reconciliation_audit_reference TEXT,
  reconciliation_closed_at TIMESTAMPTZ,
  withheld_reason        TEXT,
  review_required        BOOLEAN NOT NULL DEFAULT false,
  confirmation_version   INTEGER NOT NULL DEFAULT 0
                         CHECK (confirmation_version >= 0),
  status                 TEXT NOT NULL DEFAULT 'previewing'
                         CHECK (
                           status IN (
                             'previewing',
                             'created',
                             'charging',
                             'submitted',
                             'provider_unknown',
                             'completed',
                             'withheld',
                             'refunded',
                             'chargeback',
                             'failed'
                           )
                         ),
  provider_error_code    TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  submitted_at           TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  refunded_at            TIMESTAMPTZ,
  CONSTRAINT credit_pack_purchase_requests_transaction_id_check
    CHECK (
      transaction_id IS NULL
      OR (btrim(transaction_id) <> '' AND length(transaction_id) <= 255)
    ),
  CONSTRAINT credit_pack_purchase_requests_customer_id_check
    CHECK (btrim(customer_id) <> '' AND length(customer_id) <= 255),
  CONSTRAINT credit_pack_purchase_requests_subscription_id_check
    CHECK (btrim(subscription_id) <> '' AND length(subscription_id) <= 255),
  CONSTRAINT credit_pack_purchase_requests_provider_price_id_check
    CHECK (
      provider_price_id IS NULL
      OR (btrim(provider_price_id) <> '' AND length(provider_price_id) <= 255)
    ),
  CONSTRAINT credit_pack_purchase_requests_provider_product_id_check
    CHECK (
      provider_product_id IS NULL
      OR (btrim(provider_product_id) <> '' AND length(provider_product_id) <= 255)
    ),
  CONSTRAINT credit_pack_purchase_requests_provider_event_id_check
    CHECK (
      provider_event_id IS NULL
      OR (btrim(provider_event_id) <> '' AND length(provider_event_id) <= 255)
    ),
  CONSTRAINT credit_pack_purchase_requests_provider_api_request_id_check
    CHECK (
      provider_api_request_id IS NULL
      OR (
        btrim(provider_api_request_id) <> ''
        AND length(provider_api_request_id) <= 255
      )
    ),
  CONSTRAINT credit_pack_purchase_requests_provider_plan_price_id_check
    CHECK (
      btrim(provider_plan_price_id) <> ''
      AND length(provider_plan_price_id) <= 255
    ),
  CONSTRAINT credit_pack_purchase_requests_eligible_snapshot_event_id_check
    CHECK (
      btrim(eligible_snapshot_event_id) <> ''
      AND length(eligible_snapshot_event_id) <= 255
    ),
  CONSTRAINT credit_pack_purchase_requests_authorization_window_check
    CHECK (
      authorization_expires_at = authorized_at + interval '15 minutes'
    ),
  CONSTRAINT credit_pack_purchase_requests_preview_contract_check
    CHECK (
      (
        status IN (
          'previewing',
          'withheld',
          'refunded',
          'chargeback',
          'failed'
        )
        AND confirmation_version = 0
        AND provider_api_request_id IS NULL
        AND approved_subtotal IS NULL
        AND approved_discount IS NULL
        AND approved_tax IS NULL
        AND approved_total IS NULL
        AND approved_credit IS NULL
        AND approved_balance IS NULL
        AND approved_grand_total IS NULL
        AND approved_grand_total_tax IS NULL
      )
      OR
      (
        status <> 'previewing'
        AND confirmation_version >= 1
        AND provider_api_request_id IS NOT NULL
        AND approved_subtotal IS NOT NULL
        AND approved_discount IS NOT NULL
        AND approved_tax IS NOT NULL
        AND approved_total IS NOT NULL
        AND approved_credit IS NOT NULL
        AND approved_balance IS NOT NULL
        AND approved_grand_total IS NOT NULL
        AND approved_grand_total_tax IS NOT NULL
      )
    ),
  CONSTRAINT credit_pack_purchase_requests_approved_totals_check
    CHECK (
      approved_subtotal IS NULL
      OR (
        approved_subtotal = unit_amount
        AND approved_discount = 0
        AND approved_credit = 0
        AND approved_total::bigint =
          approved_subtotal::bigint + approved_tax::bigint
        AND approved_grand_total = approved_total
        AND approved_balance = approved_grand_total
        AND approved_grand_total_tax = approved_tax
      )
    ),
  CONSTRAINT credit_pack_purchase_requests_history_status_check
    CHECK (
      history_proof_status IS NULL
      OR history_proof_status IN (
        'eligible',
        'ineligible',
        'unavailable',
        'ambiguous',
        'not_checked'
      )
    ),
  CONSTRAINT credit_pack_purchase_requests_history_event_set_check
    CHECK (
      (
        history_event_id IS NULL
        AND history_event_action IS NULL
        AND history_event_occurred_at IS NULL
      )
      OR
      (
        history_event_id IS NOT NULL
        AND history_event_action IS NOT NULL
        AND history_event_occurred_at IS NOT NULL
      )
    ),
  CONSTRAINT credit_pack_purchase_requests_reconciliation_evidence_check
    CHECK (
      (
        reconciliation_decision IS NULL
        AND reconciliation_previous_status IS NULL
        AND reconciliation_checked_at IS NULL
        AND reconciliation_window_start IS NULL
        AND reconciliation_window_end IS NULL
        AND reconciliation_pages_scanned IS NULL
        AND reconciliation_transactions_scanned IS NULL
        AND reconciliation_provider_request_ids IS NULL
        AND reconciliation_audit_reference IS NULL
        AND reconciliation_closed_at IS NULL
      )
      OR
      (
        reconciliation_decision = 'definitive_no_match'
        AND reconciliation_previous_status IN (
          'charging',
          'submitted',
          'provider_unknown'
        )
        AND reconciliation_checked_at IS NOT NULL
        AND reconciliation_checked_at >=
          authorization_expires_at + interval '96 hours'
        AND reconciliation_window_start IS NOT NULL
        AND reconciliation_window_start <= authorized_at
        AND reconciliation_window_end IS NOT NULL
        AND reconciliation_window_end >= reconciliation_checked_at
        AND reconciliation_window_start <= reconciliation_window_end
        AND reconciliation_pages_scanned > 0
        AND reconciliation_pages_scanned <= 256
        AND reconciliation_transactions_scanned >= 0
        AND reconciliation_transactions_scanned::bigint <=
          reconciliation_pages_scanned::bigint * 30
        AND COALESCE(cardinality(reconciliation_provider_request_ids), 0) =
          reconciliation_pages_scanned
        AND length(
          COALESCE(array_to_string(reconciliation_provider_request_ids, ','), '')
        ) <= 65535
        AND reconciliation_audit_reference IS NOT NULL
        AND btrim(reconciliation_audit_reference) <> ''
        AND length(reconciliation_audit_reference) <= 255
        AND reconciliation_closed_at IS NOT NULL
        AND reconciliation_closed_at >= reconciliation_checked_at
        AND (
          (
            status = 'failed'
            AND review_required = true
            AND provider_error_code = 'reconciled_definitive_no_match'
          )
          OR status IN ('withheld', 'refunded', 'chargeback')
        )
      )
    ),
  CONSTRAINT credit_pack_purchase_requests_status_fields_check
    CHECK (
      (status IN ('completed', 'withheld', 'refunded', 'chargeback')
        AND transaction_id IS NOT NULL
        AND provider_price_id IS NOT NULL
        AND provider_product_id IS NOT NULL
        AND provider_event_id IS NOT NULL
        AND transaction_created_at IS NOT NULL
        AND captured_at IS NOT NULL
        AND history_proof_status IS NOT NULL
        AND completed_at IS NOT NULL)
      OR
      (status NOT IN ('completed', 'withheld', 'refunded', 'chargeback')
        AND transaction_id IS NULL
        AND provider_price_id IS NULL
        AND provider_product_id IS NULL
        AND provider_event_id IS NULL
        AND transaction_created_at IS NULL
        AND captured_at IS NULL
        AND history_proof_status IS NULL
        AND completed_at IS NULL)
    ),
  CONSTRAINT credit_pack_purchase_requests_actual_totals_state_check
    CHECK (
      status IN ('completed', 'withheld', 'refunded', 'chargeback')
      OR (
        actual_subtotal IS NULL
        AND actual_discount IS NULL
        AND actual_tax IS NULL
        AND actual_total IS NULL
        AND actual_credit IS NULL
        AND actual_balance IS NULL
        AND actual_grand_total IS NULL
        AND actual_grand_total_tax IS NULL
      )
    ),
  CONSTRAINT credit_pack_purchase_requests_withheld_fields_check
    CHECK (
      (status = 'withheld' AND withheld_reason IS NOT NULL)
      OR
      (status <> 'withheld' AND withheld_reason IS NULL)
    ),
  CONSTRAINT credit_pack_purchase_requests_refunded_fields_check
    CHECK (
      (status = 'refunded' AND refunded_at IS NOT NULL)
      OR
      (status <> 'refunded' AND refunded_at IS NULL)
  )
);

-- Provider scans happen outside PostgreSQL, so persist both independent
-- observations before releasing the durable checkout lock. Rows are append
-- only, contain no email address, and survive account deletion through the
-- retained request tombstone. The legal retention period is a separate release
-- gate; this migration deliberately does not install an automatic purge job.
CREATE TABLE public.credit_pack_purchase_reconciliation_scans (
  request_id UUID NOT NULL
    REFERENCES public.credit_pack_purchase_requests(request_id)
    ON DELETE RESTRICT,
  authorized_user_id UUID NOT NULL,
  scan_ordinal SMALLINT NOT NULL CHECK (scan_ordinal IN (1, 2)),
  expected_status TEXT NOT NULL
    CHECK (expected_status IN ('charging', 'submitted', 'provider_unknown')),
  checked_at TIMESTAMPTZ NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  pages_scanned INTEGER NOT NULL CHECK (pages_scanned > 0 AND pages_scanned <= 256),
  transactions_scanned INTEGER NOT NULL CHECK (transactions_scanned >= 0),
  provider_request_ids TEXT[] NOT NULL,
  catalog_request_id TEXT NOT NULL,
  contract_fingerprint TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  audit_reference TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id, scan_ordinal),
  CONSTRAINT credit_pack_reconciliation_scans_window_check
    CHECK (window_start <= window_end AND window_end >= checked_at),
  CONSTRAINT credit_pack_reconciliation_scans_count_check
    CHECK (
      transactions_scanned::bigint <= pages_scanned::bigint * 30
      AND cardinality(provider_request_ids) = pages_scanned
    ),
  CONSTRAINT credit_pack_reconciliation_scans_catalog_request_id_check
    CHECK (
      catalog_request_id = btrim(catalog_request_id)
      AND catalog_request_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT credit_pack_reconciliation_scans_contract_fingerprint_check
    CHECK (contract_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT credit_pack_reconciliation_scans_evidence_hash_check
    CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT credit_pack_reconciliation_scans_audit_reference_check
    CHECK (
      btrim(audit_reference) <> ''
      AND length(audit_reference) <= 255
    )
);

CREATE INDEX credit_pack_reconciliation_scans_checked_idx
  ON public.credit_pack_purchase_reconciliation_scans (checked_at DESC);

ALTER TABLE public.credit_pack_purchase_reconciliation_scans
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credit_pack_purchase_reconciliation_scans
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.credit_pack_purchase_reconciliation_scans
  TO service_role;

CREATE OR REPLACE FUNCTION public.reject_payment_reconciliation_scan_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'PAYMENT_RECONCILIATION_SCAN_IMMUTABLE'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER credit_pack_reconciliation_scans_immutable
BEFORE UPDATE OR DELETE ON public.credit_pack_purchase_reconciliation_scans
FOR EACH ROW
EXECUTE FUNCTION public.reject_payment_reconciliation_scan_mutation();

REVOKE ALL ON FUNCTION public.reject_payment_reconciliation_scan_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.credit_pack_payment_receipts
  ADD CONSTRAINT credit_pack_payment_receipts_request_id_fkey
  FOREIGN KEY (request_id)
  REFERENCES public.credit_pack_purchase_requests(request_id)
  ON DELETE SET NULL;

-- One unresolved provider mutation per account. This is the durable reload and
-- double-click guard; a provider_unknown request is reconciled, never retried.
-- A first no-match scan deliberately leaves the request open. Only a second,
-- independent scan at least 24 hours later can CAS the request to failed, which
-- is excluded from this index. Withheld remains excluded because the claim-time
-- review recheck blocks a newer request before any provider mutation.
CREATE UNIQUE INDEX credit_pack_purchase_requests_one_open_per_user_idx
  ON public.credit_pack_purchase_requests (authorized_user_id)
  WHERE status IN (
    'previewing',
    'created',
    'charging',
    'submitted',
    'provider_unknown'
  );

CREATE INDEX credit_pack_purchase_requests_subscription_created_idx
  ON public.credit_pack_purchase_requests (subscription_id, created_at DESC);
CREATE INDEX credit_pack_purchase_requests_live_user_idx
  ON public.credit_pack_purchase_requests (user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX credit_pack_purchase_requests_reconciliation_checked_idx
  ON public.credit_pack_purchase_requests (reconciliation_checked_at)
  WHERE reconciliation_checked_at IS NOT NULL;

ALTER TABLE public.credit_pack_purchase_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credit_pack_purchase_requests
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT
  ON TABLE public.credit_pack_purchase_requests TO service_role;

CREATE OR REPLACE FUNCTION public.begin_credit_pack_purchase_preview(
  p_request_id uuid,
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_pack_key text,
  p_credits integer,
  p_unit_amount integer,
  p_currency_code text,
  p_expiry_days integer,
  p_provider_subscription_updated_at timestamptz,
  p_provider_plan_price_id text,
  p_eligibility_check_started_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_state public.paddle_subscription_states%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_existing public.credit_pack_purchase_requests%ROWTYPE;
  v_review_receipt public.credit_pack_payment_receipts%ROWTYPE;
  v_review_item record;
  v_authorized_at timestamptz;
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL
     OR p_customer_id IS NULL OR btrim(p_customer_id) = ''
     OR p_subscription_id IS NULL OR btrim(p_subscription_id) = ''
     OR p_pack_key IS NULL
     OR p_credits IS NULL
     OR p_unit_amount IS NULL
     OR length(p_customer_id) > 255
     OR length(p_subscription_id) > 255
     OR p_provider_subscription_updated_at IS NULL
     OR p_provider_plan_price_id IS NULL
     OR btrim(p_provider_plan_price_id) = ''
     OR length(p_provider_plan_price_id) > 255
     OR p_eligibility_check_started_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_PURCHASE_PREVIEW'
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(p_currency_code, '')) <> 'USD'
     OR p_expiry_days IS DISTINCT FROM 365 THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_PREVIEW_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;
  IF NOT (
    (p_pack_key = 'usage_600'  AND p_credits = 600  AND p_unit_amount = 1000)
    OR
    (p_pack_key = 'usage_1500' AND p_credits = 1500 AND p_unit_amount = 2000)
    OR
    (p_pack_key = 'usage_3000' AND p_credits = 3000 AND p_unit_amount = 4000)
  ) THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_PREVIEW_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize the full reservation decision per account before taking any
  -- lifecycle/profile/request row lock. Every preview/claim/close RPC uses the
  -- same advisory key first, which prevents cross-request races and preserves a
  -- single lock order.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)
  );
  v_authorized_at := clock_timestamp();

  -- Re-evaluate proof freshness after any advisory-lock wait. A request that
  -- queued behind another account mutation must not inherit an authorization
  -- clock captured before it actually won the reservation.
  IF p_eligibility_check_started_at < v_authorized_at - interval '5 minutes'
     OR p_eligibility_check_started_at > v_authorized_at + interval '30 seconds' THEN
    RAISE EXCEPTION 'CREDIT_PACK_ELIGIBILITY_PROOF_STALE'
      USING ERRCODE = '22023';
  END IF;

  -- Same lock order as the subscription reducer: lifecycle row, then profile.
  SELECT *
    INTO v_state
    FROM public.paddle_subscription_states
   WHERE subscription_id = p_subscription_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_state.user_id IS DISTINCT FROM p_user_id
     OR v_state.customer_id IS DISTINCT FROM p_customer_id
     OR v_state.terminal
     OR v_state.lifecycle_status <> 'active'
     OR v_state.last_snapshot_event_id IS NULL
     OR v_state.last_snapshot_occurred_at IS NULL THEN
    RAISE EXCEPTION 'ACTIVE_SUBSCRIPTION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NOT FOUND
     OR lower(COALESCE(v_profile.plan, 'free')) NOT IN ('pro', 'enterprise', 'paid')
     OR v_profile.paddle_customer_id IS DISTINCT FROM p_customer_id
     OR v_profile.paddle_subscription_id IS DISTINCT FROM p_subscription_id THEN
    RAISE EXCEPTION 'ACTIVE_SUBSCRIPTION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- This is deliberately non-locking. Adjustment processing locks an immutable
  -- receipt before it can reach the profile; locking here after the profile
  -- would invert that order and permit a profile/receipt deadlock. Any visible
  -- review receipt is still handled conservatively.
  SELECT *
    INTO v_review_receipt
    FROM public.credit_pack_payment_receipts
   WHERE authorized_user_id = p_user_id
     AND decision IN ('withheld', 'chargeback')
   ORDER BY completed_at DESC, transaction_id DESC
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'purchase_review_required',
      'requestId', v_review_receipt.request_id,
      'status', 'withheld',
      'packKey', v_review_receipt.pack_key,
      'credits', v_review_receipt.credits,
      'unitAmount', v_review_receipt.unit_amount
    );
  END IF;

  -- These lookups also stay non-locking. The adjustment path locks its
  -- immutable receipts before synchronizing the profile and purchase rows;
  -- taking either lock here after the profile would invert that order. The
  -- profile lock above orders a review that already reached the user's ledger
  -- before this statement; if this transaction owns that lock first, its
  -- request is ordered before the later adjustment. Fail closed for every
  -- unresolved purchase review, including partial adjustments and refunds with
  -- unrecovered credits.
  SELECT review_item.*
    INTO v_review_item
    FROM (
      SELECT
        receipt.request_id,
        purchase.transaction_id,
        purchase.pack_key,
        purchase.credits_granted AS credits,
        purchase.unit_amount,
        purchase.created_at AS review_at
      FROM public.credit_pack_purchases AS purchase
      LEFT JOIN public.credit_pack_payment_receipts AS receipt
        ON receipt.transaction_id = purchase.transaction_id
      WHERE purchase.user_id = p_user_id
        AND purchase.review_required = true

      UNION ALL

      SELECT
        receipt.request_id,
        receipt.transaction_id,
        receipt.pack_key,
        receipt.credits,
        receipt.unit_amount,
        adjustment.occurred_at AS review_at
      FROM public.credit_pack_payment_receipts AS receipt
      JOIN public.credit_pack_adjustment_receipts AS adjustment
        ON adjustment.transaction_id = receipt.transaction_id
      WHERE receipt.authorized_user_id = p_user_id
        AND adjustment.review_required = true
    ) AS review_item
   ORDER BY review_item.review_at DESC, review_item.transaction_id DESC
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'purchase_review_required',
      'requestId', v_review_item.request_id,
      'transactionId', v_review_item.transaction_id,
      'status', 'withheld',
      'packKey', v_review_item.pack_key,
      'credits', v_review_item.credits,
      'unitAmount', v_review_item.unit_amount
    );
  END IF;

  SELECT *
    INTO v_existing
    FROM public.credit_pack_purchase_requests
   WHERE authorized_user_id = p_user_id
     AND status IN (
       'previewing',
       'created',
       'charging',
       'submitted',
       'provider_unknown',
       'withheld'
     )
   FOR UPDATE;

  IF FOUND THEN
    -- Only states that provably precede the provider mutation may be released.
    -- This cleanup occurs under the same per-user advisory lock and row lock as
    -- the replacement reservation. charging and every later unresolved state
    -- remain reconciliation-only even after the authorization clock elapses.
    IF v_existing.status IN ('previewing', 'created')
       AND clock_timestamp() >= v_existing.authorization_expires_at THEN
      UPDATE public.credit_pack_purchase_requests
         SET status = 'failed',
             provider_error_code = 'authorization_expired'
       WHERE request_id = v_existing.request_id
         AND status = v_existing.status
         AND clock_timestamp() >= authorization_expires_at;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_EXPIRY_RACE'
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      RETURN jsonb_build_object(
        'applied', false,
        'reason', CASE
          WHEN v_existing.status = 'withheld'
            THEN 'purchase_review_required'
          ELSE 'duplicate_pending'
        END,
        'requestId', v_existing.request_id,
        'status', v_existing.status,
        'packKey', v_existing.pack_key,
        'credits', v_existing.credits,
        'unitAmount', v_existing.unit_amount,
        'confirmationVersion', v_existing.confirmation_version
      );
    END IF;
  END IF;

  LOOP
    BEGIN
      INSERT INTO public.credit_pack_purchase_requests (
        request_id,
        user_id,
        authorized_user_id,
        customer_id,
        subscription_id,
        pack_key,
        credits,
        unit_amount,
        currency_code,
        expiry_days,
        provider_subscription_updated_at,
        provider_plan_price_id,
        eligibility_check_started_at,
        eligible_snapshot_event_id,
        eligible_snapshot_occurred_at,
        authorized_at,
        authorization_expires_at
      ) VALUES (
        p_request_id,
        p_user_id,
        p_user_id,
        p_customer_id,
        p_subscription_id,
        p_pack_key,
        p_credits,
        p_unit_amount,
        upper(p_currency_code),
        p_expiry_days,
        p_provider_subscription_updated_at,
        btrim(p_provider_plan_price_id),
        p_eligibility_check_started_at,
        v_state.last_snapshot_event_id,
        v_state.last_snapshot_occurred_at,
        v_authorized_at,
        v_authorized_at + interval '15 minutes'
      );
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      SELECT *
        INTO v_existing
        FROM public.credit_pack_purchase_requests
       WHERE authorized_user_id = p_user_id
         AND status IN (
           'previewing',
           'created',
           'charging',
           'submitted',
           'provider_unknown',
           'withheld'
         )
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE;
      END IF;
      IF v_existing.status IN ('previewing', 'created')
         AND clock_timestamp() >= v_existing.authorization_expires_at THEN
        UPDATE public.credit_pack_purchase_requests
           SET status = 'failed',
               provider_error_code = 'authorization_expired'
         WHERE request_id = v_existing.request_id
           AND status = v_existing.status
           AND clock_timestamp() >= authorization_expires_at;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_EXPIRY_RACE'
            USING ERRCODE = 'P0001';
        END IF;
        CONTINUE;
      END IF;

      RETURN jsonb_build_object(
        'applied', false,
        'reason', CASE
          WHEN v_existing.status = 'withheld'
            THEN 'purchase_review_required'
          ELSE 'duplicate_pending'
        END,
        'requestId', v_existing.request_id,
        'status', v_existing.status,
        'packKey', v_existing.pack_key,
        'credits', v_existing.credits,
        'unitAmount', v_existing.unit_amount,
        'confirmationVersion', v_existing.confirmation_version
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'purchase_preview_reserved',
    'requestId', p_request_id,
    'status', 'previewing',
    'packKey', p_pack_key,
    'credits', p_credits,
    'unitAmount', p_unit_amount,
    'confirmationVersion', 0,
    'authorizedAt', v_authorized_at,
    'authorizationExpiresAt', v_authorized_at + interval '15 minutes'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_credit_pack_purchase_preview(
  p_request_id uuid,
  p_user_id uuid,
  p_expected_confirmation_version integer,
  p_approved_subtotal integer,
  p_approved_discount integer,
  p_approved_tax integer,
  p_approved_total integer,
  p_approved_credit integer,
  p_approved_balance integer,
  p_approved_grand_total integer,
  p_approved_grand_total_tax integer,
  p_provider_api_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_request public.credit_pack_purchase_requests%ROWTYPE;
  v_previous_status text;
  v_next_version integer;
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL
     OR p_expected_confirmation_version IS NULL
     OR p_expected_confirmation_version < 0
     OR p_provider_api_request_id IS NULL
     OR btrim(p_provider_api_request_id) = ''
     OR length(p_provider_api_request_id) > 255
     OR p_approved_subtotal IS NULL OR p_approved_subtotal < 0
     OR p_approved_discount IS NULL OR p_approved_discount < 0
     OR p_approved_tax IS NULL OR p_approved_tax < 0
     OR p_approved_total IS NULL OR p_approved_total < 0
     OR p_approved_credit IS NULL OR p_approved_credit < 0
     OR p_approved_balance IS NULL OR p_approved_balance < 0
     OR p_approved_grand_total IS NULL OR p_approved_grand_total < 0
     OR p_approved_grand_total_tax IS NULL
     OR p_approved_grand_total_tax < 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_PURCHASE_PREVIEW_FINALIZATION'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)
  );

  SELECT *
    INTO v_request
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_request.authorized_user_id IS DISTINCT FROM p_user_id
     OR v_request.user_id IS NULL THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_request.status IN ('charging', 'submitted', 'provider_unknown') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate_or_ambiguous',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version
    );
  END IF;
  IF v_request.status IN (
    'completed',
    'withheld',
    'refunded',
    'chargeback'
  ) THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'already_finalized',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version
    );
  END IF;
  IF v_request.status = 'failed' THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_TERMINAL'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status NOT IN ('previewing', 'created') THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_STATE_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF clock_timestamp() >= v_request.authorization_expires_at THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'authorization_expired',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version
    );
  END IF;
  IF v_request.confirmation_version IS DISTINCT FROM
       p_expected_confirmation_version THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'confirmation_version_mismatch',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version,
      'approvedSubtotal', v_request.approved_subtotal,
      'approvedDiscount', v_request.approved_discount,
      'approvedTax', v_request.approved_tax,
      'approvedTotal', v_request.approved_total,
      'approvedCredit', v_request.approved_credit,
      'approvedBalance', v_request.approved_balance,
      'approvedGrandTotal', v_request.approved_grand_total,
      'approvedGrandTotalTax', v_request.approved_grand_total_tax
    );
  END IF;
  IF p_approved_subtotal IS DISTINCT FROM v_request.unit_amount
     OR p_approved_discount IS DISTINCT FROM 0
     OR p_approved_credit IS DISTINCT FROM 0
     OR p_approved_total::bigint IS DISTINCT FROM
          p_approved_subtotal::bigint + p_approved_tax::bigint
     OR p_approved_grand_total IS DISTINCT FROM p_approved_total
     OR p_approved_balance IS DISTINCT FROM p_approved_grand_total
     OR p_approved_grand_total_tax IS DISTINCT FROM p_approved_tax THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_PREVIEW_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;

  v_previous_status := v_request.status;
  v_next_version := v_request.confirmation_version + 1;

  UPDATE public.credit_pack_purchase_requests
     SET approved_subtotal = p_approved_subtotal,
         approved_discount = p_approved_discount,
         approved_tax = p_approved_tax,
         approved_total = p_approved_total,
         approved_credit = p_approved_credit,
         approved_balance = p_approved_balance,
         approved_grand_total = p_approved_grand_total,
         approved_grand_total_tax = p_approved_grand_total_tax,
         provider_api_request_id = btrim(p_provider_api_request_id),
         confirmation_version = v_next_version,
         status = 'created',
         provider_error_code = NULL
   WHERE request_id = p_request_id
     AND status = v_previous_status
     AND confirmation_version = p_expected_confirmation_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_PREVIEW_FINALIZATION_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', CASE
      WHEN v_previous_status = 'previewing'
        THEN 'purchase_preview_finalized'
      ELSE 'purchase_confirmation_refreshed'
    END,
    'requestId', p_request_id,
    'status', 'created',
    'confirmationVersion', v_next_version,
    'approvedSubtotal', p_approved_subtotal,
    'approvedDiscount', p_approved_discount,
    'approvedTax', p_approved_tax,
    'approvedTotal', p_approved_total,
    'approvedCredit', p_approved_credit,
    'approvedBalance', p_approved_balance,
    'approvedGrandTotal', p_approved_grand_total,
    'approvedGrandTotalTax', p_approved_grand_total_tax,
    'authorizationExpiresAt', v_request.authorization_expires_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_credit_pack_purchase_request(
  p_request_id uuid,
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_pack_key text,
  p_expected_confirmation_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_state public.paddle_subscription_states%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_request public.credit_pack_purchase_requests%ROWTYPE;
  v_review_receipt public.credit_pack_payment_receipts%ROWTYPE;
  v_review_item record;
  v_conflicting_event public.paddle_subscription_lifecycle_events%ROWTYPE;
  v_state_safe boolean := false;
  v_profile_safe boolean := false;
  v_review_receipt_found boolean := false;
  v_review_item_found boolean := false;
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL
     OR p_customer_id IS NULL OR btrim(p_customer_id) = ''
     OR length(p_customer_id) > 255
     OR p_subscription_id IS NULL OR btrim(p_subscription_id) = ''
     OR length(p_subscription_id) > 255
     OR p_pack_key IS NULL OR btrim(p_pack_key) = ''
     OR p_expected_confirmation_version IS NULL
     OR p_expected_confirmation_version < 1 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_PURCHASE_CLAIM'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)
  );

  -- Global billing lock order: user advisory -> lifecycle -> profile ->
  -- request. Provider eligibility and account ownership are revalidated at the
  -- last possible DB boundary before a caller may invoke Paddle.
  SELECT *
    INTO v_state
    FROM public.paddle_subscription_states
   WHERE subscription_id = p_subscription_id
   FOR UPDATE;

  v_state_safe := FOUND;
  IF v_state_safe THEN
    v_state_safe :=
      v_state.subscription_id IS NOT DISTINCT FROM p_subscription_id
      AND v_state.user_id IS NOT DISTINCT FROM p_user_id
      AND v_state.customer_id IS NOT DISTINCT FROM p_customer_id
      AND NOT v_state.terminal
      AND v_state.lifecycle_status = 'active'
      AND v_state.last_snapshot_event_id IS NOT NULL
      AND v_state.last_snapshot_occurred_at IS NOT NULL;
  END IF;

  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  v_profile_safe := FOUND;
  IF v_profile_safe THEN
    v_profile_safe :=
      lower(COALESCE(v_profile.plan, 'free')) IN ('pro', 'enterprise', 'paid')
      AND v_profile.paddle_customer_id IS NOT DISTINCT FROM p_customer_id
      AND v_profile.paddle_subscription_id
            IS NOT DISTINCT FROM p_subscription_id;
  END IF;

  -- Deliberately non-locking after the profile lock and before the request
  -- lock. Adjustment processing locks immutable receipts before the profile;
  -- taking either receipt lock here would invert that order and deadlock.
  SELECT *
    INTO v_review_receipt
    FROM public.credit_pack_payment_receipts
   WHERE authorized_user_id = p_user_id
     AND decision IN ('withheld', 'chargeback')
   ORDER BY completed_at DESC, transaction_id DESC
   LIMIT 1;
  v_review_receipt_found := FOUND;

  SELECT review_item.*
    INTO v_review_item
    FROM (
      SELECT
        receipt.request_id,
        purchase.transaction_id,
        purchase.pack_key,
        purchase.credits_granted AS credits,
        purchase.unit_amount,
        purchase.created_at AS review_at
      FROM public.credit_pack_purchases AS purchase
      LEFT JOIN public.credit_pack_payment_receipts AS receipt
        ON receipt.transaction_id = purchase.transaction_id
      WHERE purchase.user_id = p_user_id
        AND purchase.review_required = true

      UNION ALL

      SELECT
        receipt.request_id,
        receipt.transaction_id,
        receipt.pack_key,
        receipt.credits,
        receipt.unit_amount,
        adjustment.occurred_at AS review_at
      FROM public.credit_pack_payment_receipts AS receipt
      JOIN public.credit_pack_adjustment_receipts AS adjustment
        ON adjustment.transaction_id = receipt.transaction_id
      WHERE receipt.authorized_user_id = p_user_id
        AND adjustment.review_required = true
    ) AS review_item
   ORDER BY review_item.review_at DESC, review_item.transaction_id DESC
   LIMIT 1;
  v_review_item_found := FOUND;

  SELECT *
    INTO v_request
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_request.authorized_user_id IS DISTINCT FROM p_user_id
     OR v_request.user_id IS NULL THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.customer_id IS DISTINCT FROM p_customer_id
     OR v_request.subscription_id IS DISTINCT FROM p_subscription_id
     OR v_request.pack_key IS DISTINCT FROM p_pack_key THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;
  IF v_request.status IN ('charging', 'submitted', 'provider_unknown') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate_or_ambiguous',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version
    );
  END IF;
  IF v_request.status IN (
    'completed',
    'withheld',
    'refunded',
    'chargeback'
  ) THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'already_finalized',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version
    );
  END IF;
  IF v_request.status = 'failed' THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_TERMINAL'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status = 'previewing' THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_PREVIEW_NOT_FINALIZED'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'created' THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_STATE_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF clock_timestamp() >= v_request.authorization_expires_at THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'authorization_expired',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version
    );
  END IF;
  IF v_request.confirmation_version IS DISTINCT FROM
       p_expected_confirmation_version THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'confirmation_version_mismatch',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version,
      'approvedSubtotal', v_request.approved_subtotal,
      'approvedDiscount', v_request.approved_discount,
      'approvedTax', v_request.approved_tax,
      'approvedTotal', v_request.approved_total,
      'approvedCredit', v_request.approved_credit,
      'approvedBalance', v_request.approved_balance,
      'approvedGrandTotal', v_request.approved_grand_total,
      'approvedGrandTotalTax', v_request.approved_grand_total_tax
    );
  END IF;

  IF v_review_receipt_found OR v_review_item_found THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'purchase_review_required',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version,
      'cancellable', true,
      'cancelReason', 'confirmation_rejected'
    );
  END IF;

  IF NOT v_state_safe OR NOT v_profile_safe THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'subscription_reconfirmation_required',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version,
      'cancellable', true,
      'cancelReason', 'confirmation_rejected'
    );
  END IF;

  -- The snapshot reducer retains every signed lifecycle event. A different
  -- event at the same timestamp is deliberately left for reconciliation and
  -- does not advance the state watermark, so checking only ineligible statuses
  -- would allow an active watermark to hide a trialing/unknown tie. Any event
  -- other than the exact preview snapshot at or after that timestamp requires
  -- a fresh confirmation before money can move.
  SELECT *
    INTO v_conflicting_event
    FROM public.paddle_subscription_lifecycle_events
   WHERE subscription_id = v_request.subscription_id
     AND provider_event_id
           IS DISTINCT FROM v_request.eligible_snapshot_event_id
     AND occurred_at >= v_request.eligible_snapshot_occurred_at
   ORDER BY occurred_at ASC, provider_event_id ASC
   LIMIT 1;

  IF FOUND
     OR v_state.last_snapshot_event_id
          IS DISTINCT FROM v_request.eligible_snapshot_event_id
     OR v_state.last_snapshot_occurred_at
          IS DISTINCT FROM v_request.eligible_snapshot_occurred_at THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'subscription_reconfirmation_required',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'confirmationVersion', v_request.confirmation_version,
      'cancellable', true,
      'cancelReason', 'confirmation_rejected'
    );
  END IF;

  UPDATE public.credit_pack_purchase_requests
     SET status = 'charging',
         submitted_at = COALESCE(submitted_at, clock_timestamp()),
         provider_error_code = NULL
   WHERE request_id = p_request_id
     AND status = 'created'
     AND confirmation_version = p_expected_confirmation_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_CLAIM_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'purchase_request_claimed',
    'requestId', p_request_id,
    'status', 'charging',
    'packKey', v_request.pack_key,
    'credits', v_request.credits,
    'unitAmount', v_request.unit_amount,
    'currencyCode', v_request.currency_code,
    'confirmationVersion', v_request.confirmation_version,
    'approvedSubtotal', v_request.approved_subtotal,
    'approvedDiscount', v_request.approved_discount,
    'approvedTax', v_request.approved_tax,
    'approvedTotal', v_request.approved_total,
    'approvedCredit', v_request.approved_credit,
    'approvedBalance', v_request.approved_balance,
    'approvedGrandTotal', v_request.approved_grand_total,
    'approvedGrandTotalTax', v_request.approved_grand_total_tax,
    'providerApiRequestId', v_request.provider_api_request_id,
    'authorizationExpiresAt', v_request.authorization_expires_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_credit_pack_purchase_request(
  p_request_id uuid,
  p_user_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_request public.credit_pack_purchase_requests%ROWTYPE;
  v_reason text := lower(btrim(p_reason));
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL OR p_reason IS NULL
     OR v_reason NOT IN (
       'client_cancelled',
       'preview_failed',
       'preview_unavailable',
       'confirmation_rejected'
     ) THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_PURCHASE_CANCELLATION'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)
  );

  SELECT *
    INTO v_request
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_request.authorized_user_id IS DISTINCT FROM p_user_id
     OR v_request.user_id IS NULL THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status IN ('charging', 'submitted', 'provider_unknown') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_required',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;
  IF v_request.status IN (
    'completed',
    'withheld',
    'refunded',
    'chargeback'
  ) THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'already_finalized',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;
  IF v_request.status = 'failed' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;

  UPDATE public.credit_pack_purchase_requests
     SET status = 'failed',
         provider_error_code = v_reason
   WHERE request_id = p_request_id
     AND status IN ('previewing', 'created');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_CANCELLATION_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'purchase_request_cancelled',
    'requestId', p_request_id,
    'status', 'failed'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.expire_credit_pack_purchase_request(
  p_request_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_request public.credit_pack_purchase_requests%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_PURCHASE_EXPIRY'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)
  );

  SELECT *
    INTO v_request
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_request.authorized_user_id IS DISTINCT FROM p_user_id
     OR v_request.user_id IS NULL THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status IN ('charging', 'submitted', 'provider_unknown') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_required',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;
  IF v_request.status IN (
    'completed',
    'withheld',
    'refunded',
    'chargeback'
  ) THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'already_finalized',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;
  IF v_request.status = 'failed' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;
  IF clock_timestamp() < v_request.authorization_expires_at THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'authorization_active',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'authorizationExpiresAt', v_request.authorization_expires_at
    );
  END IF;

  UPDATE public.credit_pack_purchase_requests
     SET status = 'failed',
         provider_error_code = 'authorization_expired'
   WHERE request_id = p_request_id
     AND status IN ('previewing', 'created')
     AND clock_timestamp() >= authorization_expires_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_EXPIRY_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'purchase_request_expired',
    'requestId', p_request_id,
    'status', 'failed'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.transition_credit_pack_purchase_request(
  p_request_id uuid,
  p_user_id uuid,
  p_status text,
  p_provider_error_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_request public.credit_pack_purchase_requests%ROWTYPE;
  v_status text := lower(btrim(p_status));
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL OR p_status IS NULL
     OR v_status NOT IN ('submitted', 'provider_unknown')
     OR (
       p_provider_error_code IS NOT NULL
       AND length(p_provider_error_code) > 255
     ) THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_REQUEST_TRANSITION'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)
  );

  SELECT *
    INTO v_request
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_request.authorized_user_id IS DISTINCT FROM p_user_id
     OR v_request.user_id IS NULL THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status IN ('completed', 'withheld', 'refunded', 'chargeback') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'already_finalized',
      'status', v_request.status
    );
  END IF;
  IF v_request.status = 'failed' THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_TERMINAL'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status IN ('previewing', 'created') THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_NOT_CLAIMED'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status = 'submitted' AND v_status = 'submitted' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'status', v_request.status
    );
  END IF;
  IF v_request.status = 'provider_unknown' AND v_status <> 'provider_unknown' THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_RECONCILIATION_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status = 'provider_unknown' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate_or_ambiguous',
      'status', v_request.status
    );
  END IF;
  IF v_request.status IS DISTINCT FROM v_status
     AND EXISTS (
       SELECT 1
         FROM public.credit_pack_purchase_reconciliation_scans
        WHERE request_id = p_request_id
          AND scan_ordinal = 1
     ) THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_scan_in_progress',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;
  IF v_request.status NOT IN ('charging', 'submitted') THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_STATE_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.credit_pack_purchase_requests
     SET status = v_status,
         submitted_at = CASE
           WHEN v_status IN ('submitted', 'provider_unknown')
             THEN COALESCE(submitted_at, clock_timestamp())
           ELSE submitted_at
         END,
         provider_error_code = NULLIF(btrim(p_provider_error_code), '')
   WHERE request_id = p_request_id;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'request_transitioned',
    'status', v_status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_credit_pack_purchase_no_match_scan(
  p_request_id uuid,
  p_user_id uuid,
  p_expected_status text,
  p_checked_at timestamptz,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_pages_scanned integer,
  p_transactions_scanned integer,
  p_provider_request_ids text[],
  p_catalog_request_id text,
  p_contract_fingerprint text,
  p_evidence_hash text,
  p_audit_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_request public.credit_pack_purchase_requests%ROWTYPE;
  v_existing public.credit_pack_purchase_reconciliation_scans%ROWTYPE;
  v_expected_status text := lower(btrim(COALESCE(p_expected_status, '')));
  v_catalog_request_id text := btrim(COALESCE(p_catalog_request_id, ''));
  v_contract_fingerprint text :=
    lower(btrim(COALESCE(p_contract_fingerprint, '')));
  v_evidence_hash text := lower(btrim(COALESCE(p_evidence_hash, '')));
  v_audit_reference text := NULLIF(btrim(p_audit_reference), '');
  v_provider_request_id text;
  v_seen_provider_request_ids text[] := ARRAY[]::text[];
  v_recorded_at timestamptz;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL
     OR v_expected_status NOT IN (
       'charging',
       'submitted',
       'provider_unknown'
     )
     OR p_checked_at IS NULL
     OR p_window_start IS NULL
     OR p_window_end IS NULL
     OR p_window_start > p_window_end
     OR p_window_end < p_checked_at
     OR p_pages_scanned IS NULL
     OR p_pages_scanned <= 0
     OR p_pages_scanned > 256
     OR p_transactions_scanned IS NULL OR p_transactions_scanned < 0
     OR p_transactions_scanned::bigint > p_pages_scanned::bigint * 30
     OR COALESCE(cardinality(p_provider_request_ids), 0) <>
          p_pages_scanned
     OR v_audit_reference IS NULL
     OR length(v_audit_reference) > 255
     OR v_catalog_request_id IS DISTINCT FROM lower(v_catalog_request_id)
     OR v_catalog_request_id !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR v_contract_fingerprint !~ '^[0-9a-f]{64}$'
     OR v_evidence_hash !~ '^[0-9a-f]{64}$'
     OR p_checked_at < v_now - interval '2 minutes'
     OR p_checked_at > v_now
     OR p_window_end > v_now THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_RECONCILIATION_EVIDENCE'
      USING ERRCODE = '22023';
  END IF;

  IF p_provider_request_ids IS NOT NULL THEN
    FOREACH v_provider_request_id IN ARRAY p_provider_request_ids LOOP
      IF v_provider_request_id IS NULL
         OR btrim(v_provider_request_id) = ''
         OR v_provider_request_id IS DISTINCT FROM btrim(v_provider_request_id)
         OR length(v_provider_request_id) > 255
         OR v_provider_request_id
              IS DISTINCT FROM lower(v_provider_request_id)
         OR v_provider_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'INVALID_CREDIT_PACK_RECONCILIATION_EVIDENCE'
          USING ERRCODE = '22023';
      END IF;
      IF v_provider_request_id = v_catalog_request_id THEN
        RAISE EXCEPTION 'INVALID_CREDIT_PACK_RECONCILIATION_EVIDENCE'
          USING ERRCODE = '22023';
      END IF;
      IF v_provider_request_id = ANY(v_seen_provider_request_ids) THEN
        RAISE EXCEPTION 'INVALID_CREDIT_PACK_RECONCILIATION_EVIDENCE'
          USING ERRCODE = '22023';
      END IF;
      v_seen_provider_request_ids :=
        array_append(v_seen_provider_request_ids, v_provider_request_id);
    END LOOP;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)
  );

  SELECT *
    INTO v_request
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_request.authorized_user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.credit_pack_purchase_reconciliation_scans
   WHERE request_id = p_request_id
     AND scan_ordinal = 1;

  IF FOUND THEN
    IF v_existing.authorized_user_id IS NOT DISTINCT FROM p_user_id
       AND v_existing.expected_status IS NOT DISTINCT FROM v_expected_status
       AND v_existing.checked_at IS NOT DISTINCT FROM p_checked_at
       AND v_existing.window_start IS NOT DISTINCT FROM p_window_start
       AND v_existing.window_end IS NOT DISTINCT FROM p_window_end
       AND v_existing.pages_scanned IS NOT DISTINCT FROM p_pages_scanned
       AND v_existing.transactions_scanned
            IS NOT DISTINCT FROM p_transactions_scanned
       AND v_existing.provider_request_ids
            IS NOT DISTINCT FROM p_provider_request_ids
       AND v_existing.catalog_request_id
            IS NOT DISTINCT FROM v_catalog_request_id
       AND v_existing.contract_fingerprint
            IS NOT DISTINCT FROM v_contract_fingerprint
       AND v_existing.evidence_hash IS NOT DISTINCT FROM v_evidence_hash
       AND v_existing.audit_reference
            IS NOT DISTINCT FROM v_audit_reference THEN
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'reconciliation_scan_duplicate',
        'requestId', v_request.request_id,
        'status', v_request.status,
        'scanOrdinal', 1,
        'firstCheckedAt', v_existing.checked_at,
        'firstRecordedAt', v_existing.recorded_at
      );
    END IF;

    RAISE EXCEPTION 'CREDIT_PACK_RECONCILIATION_EVIDENCE_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  IF v_request.status NOT IN (
    'charging',
    'submitted',
    'provider_unknown'
  ) THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_not_allowed',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;
  IF v_request.status IS DISTINCT FROM v_expected_status THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_status_mismatch',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;
  IF p_window_start > v_request.authorized_at
     OR p_checked_at <
          v_request.authorization_expires_at + interval '72 hours'
     OR v_now <
          v_request.authorization_expires_at + interval '72 hours' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_delay_active',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'earliestReconciliationAt',
        v_request.authorization_expires_at + interval '72 hours'
    );
  END IF;

  INSERT INTO public.credit_pack_purchase_reconciliation_scans (
    request_id,
    authorized_user_id,
    scan_ordinal,
    expected_status,
    checked_at,
    window_start,
    window_end,
    pages_scanned,
    transactions_scanned,
    provider_request_ids,
    catalog_request_id,
    contract_fingerprint,
    evidence_hash,
    audit_reference
  ) VALUES (
    p_request_id,
    p_user_id,
    1,
    v_expected_status,
    p_checked_at,
    p_window_start,
    p_window_end,
    p_pages_scanned,
    p_transactions_scanned,
    p_provider_request_ids,
    v_catalog_request_id,
    v_contract_fingerprint,
    v_evidence_hash,
    v_audit_reference
  )
  RETURNING recorded_at INTO v_recorded_at;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'reconciliation_scan_recorded',
    'requestId', p_request_id,
    'status', v_request.status,
    'scanOrdinal', 1,
    'firstCheckedAt', p_checked_at,
    'firstRecordedAt', v_recorded_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_credit_pack_purchase_no_match(
  p_request_id uuid,
  p_user_id uuid,
  p_expected_status text,
  p_checked_at timestamptz,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_pages_scanned integer,
  p_transactions_scanned integer,
  p_provider_request_ids text[],
  p_catalog_request_id text,
  p_contract_fingerprint text,
  p_evidence_hash text,
  p_audit_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_request public.credit_pack_purchase_requests%ROWTYPE;
  v_first public.credit_pack_purchase_reconciliation_scans%ROWTYPE;
  v_existing public.credit_pack_purchase_reconciliation_scans%ROWTYPE;
  v_expected_status text := lower(btrim(COALESCE(p_expected_status, '')));
  v_catalog_request_id text := btrim(COALESCE(p_catalog_request_id, ''));
  v_contract_fingerprint text :=
    lower(btrim(COALESCE(p_contract_fingerprint, '')));
  v_evidence_hash text := lower(btrim(COALESCE(p_evidence_hash, '')));
  v_audit_reference text := NULLIF(btrim(p_audit_reference), '');
  v_provider_request_id text;
  v_seen_provider_request_ids text[] := ARRAY[]::text[];
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL
     OR v_expected_status NOT IN (
       'charging',
       'submitted',
       'provider_unknown'
     )
     OR p_checked_at IS NULL
     OR p_window_start IS NULL
     OR p_window_end IS NULL
     OR p_window_start > p_window_end
     OR p_window_end < p_checked_at
     OR p_pages_scanned IS NULL
     OR p_pages_scanned <= 0
     OR p_pages_scanned > 256
     OR p_transactions_scanned IS NULL OR p_transactions_scanned < 0
     OR p_transactions_scanned::bigint > p_pages_scanned::bigint * 30
     OR COALESCE(cardinality(p_provider_request_ids), 0) <>
          p_pages_scanned
     OR v_audit_reference IS NULL
     OR length(v_audit_reference) > 255
     OR v_catalog_request_id IS DISTINCT FROM lower(v_catalog_request_id)
     OR v_catalog_request_id !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR v_contract_fingerprint !~ '^[0-9a-f]{64}$'
     OR v_evidence_hash !~ '^[0-9a-f]{64}$'
     OR p_checked_at < v_now - interval '2 minutes'
     OR p_checked_at > v_now
     OR p_window_end > v_now THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_RECONCILIATION_EVIDENCE'
      USING ERRCODE = '22023';
  END IF;

  FOREACH v_provider_request_id IN ARRAY p_provider_request_ids LOOP
    IF v_provider_request_id IS NULL
       OR btrim(v_provider_request_id) = ''
       OR v_provider_request_id IS DISTINCT FROM btrim(v_provider_request_id)
       OR length(v_provider_request_id) > 255
       OR v_provider_request_id
            IS DISTINCT FROM lower(v_provider_request_id)
       OR v_provider_request_id !~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR v_provider_request_id = v_catalog_request_id
       OR v_provider_request_id = ANY(v_seen_provider_request_ids) THEN
      RAISE EXCEPTION 'INVALID_CREDIT_PACK_RECONCILIATION_EVIDENCE'
        USING ERRCODE = '22023';
    END IF;
    v_seen_provider_request_ids :=
      array_append(v_seen_provider_request_ids, v_provider_request_id);
  END LOOP;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('credit_pack_purchase_user:' || p_user_id::text, 0)
  );

  SELECT *
    INTO v_request
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_request.authorized_user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_first
    FROM public.credit_pack_purchase_reconciliation_scans
   WHERE request_id = p_request_id
     AND scan_ordinal = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_RECONCILIATION_FIRST_SCAN_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.credit_pack_purchase_reconciliation_scans
   WHERE request_id = p_request_id
     AND scan_ordinal = 2;
  IF FOUND THEN
    IF v_existing.authorized_user_id IS NOT DISTINCT FROM p_user_id
       AND v_existing.expected_status IS NOT DISTINCT FROM v_expected_status
       AND v_existing.checked_at IS NOT DISTINCT FROM p_checked_at
       AND v_existing.window_start IS NOT DISTINCT FROM p_window_start
       AND v_existing.window_end IS NOT DISTINCT FROM p_window_end
       AND v_existing.pages_scanned IS NOT DISTINCT FROM p_pages_scanned
       AND v_existing.transactions_scanned
            IS NOT DISTINCT FROM p_transactions_scanned
       AND v_existing.provider_request_ids
            IS NOT DISTINCT FROM p_provider_request_ids
       AND v_existing.catalog_request_id
            IS NOT DISTINCT FROM v_catalog_request_id
       AND v_existing.contract_fingerprint
            IS NOT DISTINCT FROM v_contract_fingerprint
       AND v_existing.evidence_hash IS NOT DISTINCT FROM v_evidence_hash
       AND v_existing.audit_reference
            IS NOT DISTINCT FROM v_audit_reference
       AND v_request.reconciliation_decision = 'definitive_no_match'
       AND v_request.status IN ('failed', 'withheld', 'refunded', 'chargeback')
       THEN
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'reconciliation_duplicate',
        'requestId', v_request.request_id,
        'status', v_request.status,
        'reviewRequired', v_request.review_required,
        'reconciliationDecision', v_request.reconciliation_decision,
        'firstCheckedAt', v_first.checked_at,
        'checkedAt', v_existing.checked_at,
        'closedAt', v_request.reconciliation_closed_at
      );
    END IF;

    RAISE EXCEPTION 'CREDIT_PACK_RECONCILIATION_EVIDENCE_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  IF v_request.status NOT IN ('charging', 'submitted', 'provider_unknown') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_not_allowed',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;
  IF v_request.status IS DISTINCT FROM v_expected_status THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_status_mismatch',
      'requestId', v_request.request_id,
      'status', v_request.status
    );
  END IF;
  IF p_window_start > v_request.authorized_at
     OR p_checked_at <
          GREATEST(v_first.checked_at, v_first.recorded_at) +
            interval '24 hours'
     OR v_now <
          GREATEST(v_first.checked_at, v_first.recorded_at) +
            interval '24 hours' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_second_scan_delay_active',
      'requestId', v_request.request_id,
      'status', v_request.status,
      'earliestReconciliationAt',
        GREATEST(v_first.checked_at, v_first.recorded_at) +
          interval '24 hours'
    );
  END IF;
  IF v_first.expected_status IS DISTINCT FROM v_expected_status
     OR v_first.contract_fingerprint IS DISTINCT FROM v_contract_fingerprint
     OR v_first.catalog_request_id = v_catalog_request_id
     OR v_first.catalog_request_id = ANY(p_provider_request_ids)
     OR v_catalog_request_id = ANY(v_first.provider_request_ids)
     OR v_first.provider_request_ids && p_provider_request_ids THEN
    RAISE EXCEPTION 'CREDIT_PACK_RECONCILIATION_SCANS_NOT_INDEPENDENT'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.credit_pack_purchase_reconciliation_scans (
    request_id,
    authorized_user_id,
    scan_ordinal,
    expected_status,
    checked_at,
    window_start,
    window_end,
    pages_scanned,
    transactions_scanned,
    provider_request_ids,
    catalog_request_id,
    contract_fingerprint,
    evidence_hash,
    audit_reference
  ) VALUES (
    p_request_id,
    p_user_id,
    2,
    v_expected_status,
    p_checked_at,
    p_window_start,
    p_window_end,
    p_pages_scanned,
    p_transactions_scanned,
    p_provider_request_ids,
    v_catalog_request_id,
    v_contract_fingerprint,
    v_evidence_hash,
    v_audit_reference
  );

  UPDATE public.credit_pack_purchase_requests
     SET reconciliation_decision = 'definitive_no_match',
         reconciliation_previous_status = v_expected_status,
         reconciliation_checked_at = p_checked_at,
         reconciliation_window_start = p_window_start,
         reconciliation_window_end = p_window_end,
         reconciliation_pages_scanned = p_pages_scanned,
         reconciliation_transactions_scanned = p_transactions_scanned,
         reconciliation_provider_request_ids = p_provider_request_ids,
         reconciliation_audit_reference = v_audit_reference,
         reconciliation_closed_at = v_now,
         status = 'failed',
         review_required = true,
         provider_error_code = 'reconciled_definitive_no_match'
   WHERE request_id = p_request_id
     AND status = v_expected_status
     AND reconciliation_decision IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_RECONCILIATION_CAS_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'request_reconciled_no_match',
    'requestId', p_request_id,
    'status', 'failed',
    'reviewRequired', true,
    'reconciliationDecision', 'definitive_no_match',
    'firstCheckedAt', v_first.checked_at,
    'checkedAt', p_checked_at,
    'closedAt', v_now
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_credit_pack_subscription_charge(
  p_request_id uuid,
  p_transaction_id text,
  p_customer_id text,
  p_subscription_id text,
  p_pack_key text,
  p_provider_price_id text,
  p_provider_product_id text,
  p_credits integer,
  p_unit_amount integer,
  p_currency_code text,
  p_actual_subtotal integer,
  p_actual_discount integer,
  p_actual_tax integer,
  p_actual_total integer,
  p_actual_credit integer,
  p_actual_balance integer,
  p_actual_grand_total integer,
  p_actual_grand_total_tax integer,
  p_expiry_days integer,
  p_purchased_at timestamptz,
  p_provider_event_id text,
  p_transaction_created_at timestamptz,
  p_captured_at timestamptz,
  p_history_proof_status text,
  p_history_api_request_id text,
  p_history_event_id text,
  p_history_event_action text,
  p_history_event_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_request_snapshot public.credit_pack_purchase_requests%ROWTYPE;
  v_request public.credit_pack_purchase_requests%ROWTYPE;
  v_state public.paddle_subscription_states%ROWTYPE;
  v_intent public.credit_pack_checkout_intents%ROWTYPE;
  v_purchase public.credit_pack_purchases%ROWTYPE;
  v_receipt public.credit_pack_payment_receipts%ROWTYPE;
  v_preceding_adjustment public.credit_pack_adjustment_receipts%ROWTYPE;
  v_ineligible_event public.paddle_subscription_lifecycle_events%ROWTYPE;
  v_result jsonb;
  v_history_status text := lower(btrim(p_history_proof_status));
  v_withheld_reason text;
  v_terminal_adjustment_status text;
  v_has_preceding_adjustment boolean := false;
  v_is_primary_transaction boolean := true;
  v_account_deleted boolean := false;
  v_reconciled_no_match_close boolean := false;
BEGIN
  IF p_request_id IS NULL
     OR p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
     OR length(p_transaction_id) > 255
     OR p_customer_id IS NULL OR btrim(p_customer_id) = ''
     OR length(p_customer_id) > 255
     OR p_subscription_id IS NULL OR btrim(p_subscription_id) = ''
     OR length(p_subscription_id) > 255
     OR p_provider_price_id IS NULL OR btrim(p_provider_price_id) = ''
     OR length(p_provider_price_id) > 255
     OR p_provider_product_id IS NULL OR btrim(p_provider_product_id) = ''
     OR length(p_provider_product_id) > 255
     OR p_purchased_at IS NULL
     OR p_provider_event_id IS NULL OR btrim(p_provider_event_id) = ''
     OR length(p_provider_event_id) > 255
     OR p_transaction_created_at IS NULL
     OR p_captured_at IS NULL
     OR v_history_status NOT IN (
       'eligible',
       'ineligible',
       'unavailable',
       'ambiguous',
       'not_checked'
     )
     OR (
       p_history_api_request_id IS NOT NULL
       AND length(p_history_api_request_id) > 255
     )
     OR (
       p_history_event_id IS NOT NULL
       AND length(p_history_event_id) > 255
     )
     OR (
       p_history_event_action IS NOT NULL
       AND length(p_history_event_action) > 100
     )
     OR (
       (
         p_history_event_id IS NULL
         AND (
           p_history_event_action IS NOT NULL
           OR p_history_event_occurred_at IS NOT NULL
         )
       )
       OR
       (
         p_history_event_id IS NOT NULL
         AND (
           p_history_event_action IS NULL
           OR p_history_event_occurred_at IS NULL
         )
       )
     )
     OR (
       v_history_status IN ('eligible', 'ineligible', 'ambiguous')
       AND (
         p_history_api_request_id IS NULL
         OR btrim(p_history_api_request_id) = ''
       )
     ) THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_SUBSCRIPTION_CHARGE'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize every completion and adjustment for one Paddle transaction.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('credit_pack_transaction:' || btrim(p_transaction_id), 0)
  );

  -- Read identity first without a lock, then acquire lifecycle -> profile ->
  -- request in the global billing lock order.
  SELECT *
    INTO v_request_snapshot
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  v_account_deleted := v_request_snapshot.user_id IS NULL;

  IF NOT v_account_deleted THEN
    SELECT *
      INTO v_state
      FROM public.paddle_subscription_states
     WHERE subscription_id = v_request_snapshot.subscription_id
     FOR UPDATE;
    IF NOT FOUND
       OR v_state.user_id IS DISTINCT FROM v_request_snapshot.user_id
       OR v_state.customer_id IS DISTINCT FROM v_request_snapshot.customer_id THEN
      RAISE EXCEPTION 'CREDIT_PACK_SUBSCRIPTION_BINDING_CONFLICT'
        USING ERRCODE = '23505';
    END IF;

    PERFORM public.sync_credit_lot_balance(v_request_snapshot.user_id);
  END IF;

  SELECT *
    INTO v_request
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF v_request.status = 'completed' THEN
    v_is_primary_transaction :=
      v_request.transaction_id IS NOT DISTINCT FROM p_transaction_id;
  ELSIF v_request.status IN ('withheld', 'refunded', 'chargeback') THEN
    v_is_primary_transaction :=
      v_request.transaction_id IS NOT DISTINCT FROM p_transaction_id;
  END IF;

  IF v_request.customer_id IS DISTINCT FROM p_customer_id
     OR v_request.subscription_id IS DISTINCT FROM p_subscription_id
     OR v_request.pack_key IS DISTINCT FROM p_pack_key
     OR v_request.credits IS DISTINCT FROM p_credits
     OR v_request.unit_amount IS DISTINCT FROM p_unit_amount
     OR v_request.currency_code IS DISTINCT FROM upper(p_currency_code)
     OR v_request.expiry_days IS DISTINCT FROM p_expiry_days THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;

  -- A late signed completion can race with the final provider scan because
  -- Paddle and PostgreSQL cannot share one transaction. Once both scans have
  -- closed the request, the payment is recorded for refund review but can
  -- never mint a credit lot.
  v_reconciled_no_match_close :=
    v_request.confirmation_version >= 1
    AND v_request.reconciliation_decision = 'definitive_no_match'
    AND v_request.reconciliation_previous_status IN (
      'charging',
      'submitted',
      'provider_unknown'
    )
    AND v_request.reconciliation_checked_at IS NOT NULL
    AND v_request.reconciliation_window_start IS NOT NULL
    AND v_request.reconciliation_window_end IS NOT NULL
    AND v_request.reconciliation_pages_scanned IS NOT NULL
    AND v_request.reconciliation_transactions_scanned IS NOT NULL
    AND v_request.reconciliation_provider_request_ids IS NOT NULL
    AND v_request.reconciliation_audit_reference IS NOT NULL
    AND v_request.reconciliation_closed_at IS NOT NULL
    AND v_request.status = 'failed'
    AND v_request.review_required = true
    AND v_request.provider_error_code =
      'reconciled_definitive_no_match'
    AND EXISTS (
      SELECT 1
        FROM public.credit_pack_purchase_reconciliation_scans s
       WHERE s.request_id = v_request.request_id
         AND s.scan_ordinal = 2
    );

  SELECT *
    INTO v_receipt
    FROM public.credit_pack_payment_receipts
   WHERE transaction_id = btrim(p_transaction_id)
   FOR UPDATE;

  IF FOUND THEN
    IF v_receipt.request_id IS DISTINCT FROM p_request_id
       OR v_receipt.request_reference IS DISTINCT FROM p_request_id
       OR v_receipt.provider_event_id IS DISTINCT FROM btrim(p_provider_event_id)
       OR v_receipt.user_id IS DISTINCT FROM v_request.user_id
       OR v_receipt.authorized_user_id
            IS DISTINCT FROM v_request.authorized_user_id
       OR v_receipt.customer_id IS DISTINCT FROM p_customer_id
       OR v_receipt.subscription_id IS DISTINCT FROM p_subscription_id
       OR v_receipt.pack_key IS DISTINCT FROM p_pack_key
       OR v_receipt.provider_price_id IS DISTINCT FROM p_provider_price_id
       OR v_receipt.provider_product_id IS DISTINCT FROM p_provider_product_id
       OR v_receipt.credits IS DISTINCT FROM p_credits
       OR v_receipt.unit_amount IS DISTINCT FROM p_unit_amount
       OR v_receipt.currency_code IS DISTINCT FROM upper(p_currency_code)
       OR v_receipt.actual_subtotal IS DISTINCT FROM p_actual_subtotal
       OR v_receipt.actual_discount IS DISTINCT FROM p_actual_discount
       OR v_receipt.actual_tax IS DISTINCT FROM p_actual_tax
       OR v_receipt.actual_total IS DISTINCT FROM p_actual_total
       OR v_receipt.actual_credit IS DISTINCT FROM p_actual_credit
       OR v_receipt.actual_balance IS DISTINCT FROM p_actual_balance
       OR v_receipt.actual_grand_total IS DISTINCT FROM p_actual_grand_total
       OR v_receipt.actual_grand_total_tax
            IS DISTINCT FROM p_actual_grand_total_tax
       OR v_receipt.expiry_days IS DISTINCT FROM p_expiry_days
       OR v_receipt.transaction_created_at IS DISTINCT FROM p_transaction_created_at
       OR v_receipt.captured_at IS DISTINCT FROM p_captured_at
       OR v_receipt.completed_at IS DISTINCT FROM p_purchased_at THEN
      RAISE EXCEPTION 'CREDIT_PACK_TRANSACTION_ID_CONFLICT'
        USING ERRCODE = '23505';
    END IF;

    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'userId', v_receipt.user_id,
      'requestId', v_receipt.request_id,
      'status', CASE
        WHEN v_receipt.decision = 'granted' THEN 'completed'
        ELSE v_receipt.decision
      END,
      'entitlementGranted', v_receipt.decision = 'granted',
      'reviewRequired',
        v_request.review_required
        OR v_receipt.decision IN ('withheld', 'chargeback'),
      'reconciliationSuperseded',
        v_request.reconciliation_decision = 'definitive_no_match'
        AND v_receipt.decision = 'granted',
      'withheldReason', CASE
        WHEN v_receipt.decision = 'withheld' THEN v_receipt.decision_reason
        ELSE NULL
      END
    );
  END IF;

  IF v_request.status IN ('previewing', 'created') THEN
    v_withheld_reason := 'request_not_claimed';
  ELSIF v_reconciled_no_match_close THEN
    v_withheld_reason := 'late_payment_after_reconciled_no_match';
  ELSIF v_request.status = 'failed'
        THEN
    v_withheld_reason := 'request_previously_failed';
  ELSIF v_request.approved_subtotal IS DISTINCT FROM p_actual_subtotal
     OR v_request.approved_discount IS DISTINCT FROM p_actual_discount
     OR v_request.approved_tax IS DISTINCT FROM p_actual_tax
     OR v_request.approved_total IS DISTINCT FROM p_actual_total
     OR v_request.approved_credit IS DISTINCT FROM p_actual_credit
     OR p_actual_balance IS DISTINCT FROM 0
     OR v_request.approved_grand_total IS DISTINCT FROM p_actual_grand_total
     OR v_request.approved_grand_total_tax
          IS DISTINCT FROM p_actual_grand_total_tax THEN
    v_withheld_reason := 'transaction_totals_mismatch';
  ELSIF p_purchased_at >= v_request.authorized_at
        AND p_purchased_at < v_request.authorization_expires_at
        AND (
          p_transaction_created_at < v_request.authorized_at
          OR p_captured_at < v_request.authorized_at
          OR p_transaction_created_at > p_captured_at
          OR p_captured_at > p_purchased_at
        ) THEN
    -- Persist the signed timestamps and fail closed instead of granting against
    -- an internally impossible provider timeline.
    v_withheld_reason := 'transaction_timeline_mismatch';
  ELSIF v_account_deleted THEN
    v_withheld_reason := 'account_deleted';
  ELSIF v_request.status IN ('completed', 'withheld', 'refunded', 'chargeback')
     AND NOT v_is_primary_transaction THEN
    v_withheld_reason := 'duplicate_request_transaction';
  ELSIF p_purchased_at < v_request.authorized_at THEN
    v_withheld_reason := 'event_before_authorization';
  ELSIF p_purchased_at >= v_request.authorization_expires_at THEN
    v_withheld_reason := 'authorization_expired';
  ELSIF v_history_status = 'eligible'
        AND (
          NULLIF(btrim(p_history_event_id), '') IS NULL
          OR p_history_event_action
               IS DISTINCT FROM 'subscription_one_off_charge_applied'
          OR p_history_event_occurred_at IS NULL
          OR p_history_event_occurred_at < v_request.authorized_at
          OR p_history_event_occurred_at > p_purchased_at
        ) THEN
    v_withheld_reason := 'subscription_history_proof_invalid';
  ELSIF v_history_status = 'ineligible' THEN
    v_withheld_reason := 'subscription_ineligible_before_purchase';
  ELSIF v_history_status = 'unavailable' THEN
    v_withheld_reason := 'subscription_history_unavailable';
  ELSIF v_history_status IN ('ambiguous', 'not_checked') THEN
    v_withheld_reason := 'subscription_history_ambiguous';
  END IF;

  SELECT *
    INTO v_preceding_adjustment
    FROM public.credit_pack_adjustment_receipts
   WHERE transaction_id = btrim(p_transaction_id)
   ORDER BY (
     status = 'approved'
     AND COALESCE(adjustment_type, '') = 'full'
     AND action = 'chargeback'
   ) DESC,
   (
     status = 'approved'
     AND COALESCE(adjustment_type, '') = 'full'
     AND action IN ('refund', 'credit')
   ) DESC,
   occurred_at DESC,
   provider_event_id DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    v_has_preceding_adjustment := true;
    v_terminal_adjustment_status := CASE
      WHEN v_preceding_adjustment.status = 'approved'
       AND COALESCE(v_preceding_adjustment.adjustment_type, '') = 'full'
       AND v_preceding_adjustment.action IN ('refund', 'credit')
        THEN 'refunded'
      WHEN v_preceding_adjustment.status = 'approved'
       AND COALESCE(v_preceding_adjustment.adjustment_type, '') = 'full'
       AND v_preceding_adjustment.action = 'chargeback'
        THEN 'chargeback'
      ELSE NULL
    END;

    IF v_withheld_reason IS NULL THEN
      v_withheld_reason := CASE
        WHEN v_preceding_adjustment.status = 'approved'
         AND COALESCE(v_preceding_adjustment.adjustment_type, '') = 'full'
         AND v_preceding_adjustment.action IN ('refund', 'credit')
          THEN 'provider_refund_preceded_completion'
        WHEN v_preceding_adjustment.status = 'approved'
         AND COALESCE(v_preceding_adjustment.adjustment_type, '') = 'full'
         AND v_preceding_adjustment.action = 'chargeback'
          THEN 'provider_chargeback_preceded_completion'
        ELSE 'provider_adjustment_preceded_completion'
      END;
    END IF;
  END IF;

  IF v_withheld_reason IS NULL THEN
    SELECT *
      INTO v_ineligible_event
      FROM public.paddle_subscription_lifecycle_events
     WHERE subscription_id = p_subscription_id
       AND lifecycle_status IN ('past_due', 'paused', 'canceled')
       AND occurred_at >= v_request.eligible_snapshot_occurred_at
       AND occurred_at <= p_purchased_at
     ORDER BY occurred_at ASC, provider_event_id ASC
     LIMIT 1;

    IF FOUND THEN
      v_withheld_reason := 'subscription_ineligible_before_purchase';
    ELSIF v_state.terminal
          AND v_state.terminal_at IS NOT NULL
          AND v_state.terminal_at <= p_purchased_at THEN
      v_withheld_reason := 'subscription_ineligible_before_purchase';
    ELSIF v_state.lifecycle_status IN ('past_due', 'paused', 'canceled')
          AND v_state.last_snapshot_occurred_at IS NOT NULL
          AND v_state.last_snapshot_occurred_at <= p_purchased_at THEN
      v_withheld_reason := 'subscription_ineligible_before_purchase';
    END IF;
  END IF;

  INSERT INTO public.credit_pack_payment_receipts (
    transaction_id,
    request_id,
    request_reference,
    provider_event_id,
    user_id,
    authorized_user_id,
    customer_id,
    subscription_id,
    pack_key,
    provider_price_id,
    provider_product_id,
    credits,
    unit_amount,
    currency_code,
    actual_subtotal,
    actual_discount,
    actual_tax,
    actual_total,
    actual_credit,
    actual_balance,
    actual_grand_total,
    actual_grand_total_tax,
    expiry_days,
    transaction_created_at,
    captured_at,
    completed_at,
    history_proof_status,
    history_api_request_id,
    history_event_id,
    history_event_action,
    history_event_occurred_at,
    decision,
    decision_reason,
    adjusted_at
  ) VALUES (
    btrim(p_transaction_id),
    p_request_id,
    p_request_id,
    btrim(p_provider_event_id),
    v_request.user_id,
    v_request.authorized_user_id,
    p_customer_id,
    p_subscription_id,
    p_pack_key,
    p_provider_price_id,
    p_provider_product_id,
    p_credits,
    p_unit_amount,
    upper(p_currency_code),
    p_actual_subtotal,
    p_actual_discount,
    p_actual_tax,
    p_actual_total,
    p_actual_credit,
    p_actual_balance,
    p_actual_grand_total,
    p_actual_grand_total_tax,
    p_expiry_days,
    p_transaction_created_at,
    p_captured_at,
    p_purchased_at,
    v_history_status,
    NULLIF(btrim(p_history_api_request_id), ''),
    NULLIF(btrim(p_history_event_id), ''),
    NULLIF(btrim(p_history_event_action), ''),
    p_history_event_occurred_at,
    COALESCE(
      v_terminal_adjustment_status,
      CASE WHEN v_withheld_reason IS NULL THEN 'granted' ELSE 'withheld' END
    ),
    COALESCE(v_withheld_reason, 'credit_pack_applied'),
    CASE
      WHEN v_terminal_adjustment_status IS NOT NULL
        THEN v_preceding_adjustment.occurred_at
      ELSE NULL
    END
  );

  -- The authorization row intentionally survives account deletion with its
  -- direct user FK cleared. Preserve the signed payment evidence and stop here:
  -- all downstream ledger tables require a live user and must never mint.
  IF v_account_deleted THEN
    IF v_request.status NOT IN (
      'completed',
      'withheld',
      'refunded',
      'chargeback'
    ) THEN
      UPDATE public.credit_pack_purchase_requests
         SET transaction_id = btrim(p_transaction_id),
             provider_price_id = p_provider_price_id,
             provider_product_id = p_provider_product_id,
             provider_event_id = btrim(p_provider_event_id),
             transaction_created_at = p_transaction_created_at,
             captured_at = p_captured_at,
             actual_subtotal = p_actual_subtotal,
             actual_discount = p_actual_discount,
             actual_tax = p_actual_tax,
             actual_total = p_actual_total,
             actual_credit = p_actual_credit,
             actual_balance = p_actual_balance,
             actual_grand_total = p_actual_grand_total,
             actual_grand_total_tax = p_actual_grand_total_tax,
             history_proof_status = v_history_status,
             history_api_request_id =
               NULLIF(btrim(p_history_api_request_id), ''),
             history_event_id = NULLIF(btrim(p_history_event_id), ''),
             history_event_action = NULLIF(btrim(p_history_event_action), ''),
             history_event_occurred_at = p_history_event_occurred_at,
             withheld_reason = CASE
               WHEN v_terminal_adjustment_status IS NOT NULL THEN NULL
               ELSE v_withheld_reason
             END,
             review_required =
               COALESCE(v_terminal_adjustment_status, 'withheld') <> 'refunded',
             status = CASE
               WHEN v_terminal_adjustment_status IS NOT NULL
                 THEN v_terminal_adjustment_status
               ELSE 'withheld'
             END,
             submitted_at = COALESCE(submitted_at, p_purchased_at),
             completed_at = p_purchased_at,
             refunded_at = CASE
               WHEN v_terminal_adjustment_status = 'refunded'
                 THEN v_preceding_adjustment.occurred_at
               ELSE NULL
             END,
             provider_error_code = NULL
       WHERE request_id = p_request_id
         AND status IN (
           'previewing',
           'created',
           'charging',
           'submitted',
           'provider_unknown',
           'failed'
         );
    END IF;

    IF v_terminal_adjustment_status IS NOT NULL THEN
      UPDATE public.credit_pack_payment_receipts
         SET decision = v_terminal_adjustment_status,
             decision_reason = 'provider_' || v_terminal_adjustment_status,
             adjusted_at = COALESCE(
               adjusted_at,
               v_preceding_adjustment.occurred_at
             )
       WHERE transaction_id = btrim(p_transaction_id);
    END IF;

    IF v_has_preceding_adjustment THEN
      UPDATE public.credit_pack_adjustment_receipts
         SET matched = true,
             applied = applied OR (v_terminal_adjustment_status IS NOT NULL),
             review_required = review_required OR (
               v_terminal_adjustment_status IS NULL
               OR v_terminal_adjustment_status = 'chargeback'
             ),
             updated_at = clock_timestamp()
       WHERE adjustment_id = v_preceding_adjustment.adjustment_id;
    END IF;

    RETURN jsonb_build_object(
      'applied', false,
      'reason', CASE
        WHEN v_terminal_adjustment_status = 'refunded'
          THEN 'payment_refunded_before_entitlement'
        WHEN v_terminal_adjustment_status = 'chargeback'
          THEN 'payment_chargeback_before_entitlement'
        ELSE 'entitlement_withheld'
      END,
      'userId', NULL,
      'requestId', p_request_id,
      'status', COALESCE(v_terminal_adjustment_status, 'withheld'),
      'entitlementGranted', false,
      'reviewRequired',
        COALESCE(v_terminal_adjustment_status, 'withheld') <> 'refunded',
      'withheldReason', CASE
        WHEN v_terminal_adjustment_status IS NOT NULL THEN NULL
        ELSE v_withheld_reason
      END
    );
  END IF;

  INSERT INTO public.credit_pack_checkout_intents (
    transaction_id,
    user_id,
    customer_id,
    subscription_id,
    pack_key,
    price_id,
    credits,
    unit_amount,
    currency_code,
    expiry_days
  ) VALUES (
    p_transaction_id,
    v_request.user_id,
    p_customer_id,
    p_subscription_id,
    p_pack_key,
    p_provider_price_id,
    p_credits,
    p_unit_amount,
    upper(p_currency_code),
    p_expiry_days
  )
  ON CONFLICT (transaction_id) DO NOTHING;

  SELECT *
    INTO v_intent
    FROM public.credit_pack_checkout_intents
   WHERE transaction_id = btrim(p_transaction_id)
   FOR UPDATE;

  IF NOT FOUND
     OR v_intent.user_id IS DISTINCT FROM v_request.user_id
     OR v_intent.customer_id IS DISTINCT FROM p_customer_id
     OR v_intent.subscription_id IS DISTINCT FROM p_subscription_id
     OR v_intent.pack_key IS DISTINCT FROM p_pack_key
     OR v_intent.price_id IS DISTINCT FROM p_provider_price_id
     OR v_intent.credits IS DISTINCT FROM p_credits
     OR v_intent.unit_amount IS DISTINCT FROM p_unit_amount
     OR v_intent.currency_code IS DISTINCT FROM upper(p_currency_code)
     OR v_intent.expiry_days IS DISTINCT FROM p_expiry_days THEN
    RAISE EXCEPTION 'CREDIT_PACK_CHECKOUT_INTENT_MISMATCH'
      USING ERRCODE = '23505';
  END IF;

  IF v_withheld_reason IS NOT NULL THEN
    INSERT INTO public.credit_pack_purchases (
      transaction_id,
      user_id,
      customer_id,
      pack_key,
      price_id,
      credits_granted,
      unit_amount,
      currency_code,
      subscription_id,
      status,
      provider_event_id,
      withheld_reason,
      review_required,
      purchased_at,
      adjusted_at
    ) VALUES (
      btrim(p_transaction_id),
      v_request.user_id,
      p_customer_id,
      p_pack_key,
      p_provider_price_id,
      p_credits,
      p_unit_amount,
      upper(p_currency_code),
      p_subscription_id,
      COALESCE(v_terminal_adjustment_status, 'withheld'),
      btrim(p_provider_event_id),
      CASE
        WHEN v_terminal_adjustment_status IS NULL THEN v_withheld_reason
        ELSE NULL
      END,
      v_terminal_adjustment_status IS NULL
        OR v_terminal_adjustment_status = 'chargeback',
      p_purchased_at,
      CASE
        WHEN v_terminal_adjustment_status IS NOT NULL
          THEN v_preceding_adjustment.occurred_at
        ELSE NULL
      END
    );

    UPDATE public.credit_pack_checkout_intents
       SET status = CASE
             WHEN v_terminal_adjustment_status IS NULL THEN 'withheld'
             ELSE 'refunded'
           END,
           withheld_at = CASE
             WHEN v_terminal_adjustment_status IS NULL THEN p_purchased_at
             ELSE NULL
           END,
           withheld_reason = CASE
             WHEN v_terminal_adjustment_status IS NULL THEN v_withheld_reason
             ELSE NULL
           END,
           refunded_at = CASE
             WHEN v_terminal_adjustment_status IS NULL THEN NULL
             ELSE v_preceding_adjustment.occurred_at
           END
     WHERE transaction_id = btrim(p_transaction_id)
       AND status = 'pending';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CREDIT_PACK_INTENT_WITHHOLD_RACE'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_request.status NOT IN (
      'completed',
      'withheld',
      'refunded',
      'chargeback'
    ) THEN
      UPDATE public.credit_pack_purchase_requests
         SET transaction_id = btrim(p_transaction_id),
             provider_price_id = p_provider_price_id,
             provider_product_id = p_provider_product_id,
             provider_event_id = btrim(p_provider_event_id),
             transaction_created_at = p_transaction_created_at,
             captured_at = p_captured_at,
             actual_subtotal = p_actual_subtotal,
             actual_discount = p_actual_discount,
             actual_tax = p_actual_tax,
             actual_total = p_actual_total,
             actual_credit = p_actual_credit,
             actual_balance = p_actual_balance,
             actual_grand_total = p_actual_grand_total,
             actual_grand_total_tax = p_actual_grand_total_tax,
             history_proof_status = v_history_status,
             history_api_request_id = NULLIF(btrim(p_history_api_request_id), ''),
             history_event_id = NULLIF(btrim(p_history_event_id), ''),
             history_event_action = NULLIF(btrim(p_history_event_action), ''),
             history_event_occurred_at = p_history_event_occurred_at,
             withheld_reason = CASE
               WHEN v_terminal_adjustment_status IS NOT NULL THEN NULL
               ELSE v_withheld_reason
             END,
             review_required =
               v_terminal_adjustment_status IS NULL
               OR v_terminal_adjustment_status = 'chargeback',
             status = CASE
               WHEN v_terminal_adjustment_status IS NOT NULL
                 THEN v_terminal_adjustment_status
               ELSE 'withheld'
             END,
             submitted_at = COALESCE(submitted_at, p_purchased_at),
             completed_at = p_purchased_at,
             refunded_at = CASE
               WHEN v_terminal_adjustment_status = 'refunded'
                 THEN v_preceding_adjustment.occurred_at
               ELSE NULL
             END,
             provider_error_code = NULL
       WHERE request_id = p_request_id
         AND status IN (
           'previewing',
           'created',
           'charging',
           'submitted',
           'provider_unknown',
           'failed'
         );

      IF NOT FOUND THEN
        RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_WITHHOLD_RACE'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF v_has_preceding_adjustment THEN
      INSERT INTO public.credit_pack_adjustments (
        adjustment_id,
        transaction_id,
        action,
        adjustment_type,
        status,
        applied,
        review_required
      ) VALUES (
        v_preceding_adjustment.adjustment_id,
        btrim(p_transaction_id),
        v_preceding_adjustment.action,
        v_preceding_adjustment.adjustment_type,
        v_preceding_adjustment.status,
        v_terminal_adjustment_status IS NOT NULL,
        v_terminal_adjustment_status IS NULL
          OR v_terminal_adjustment_status = 'chargeback'
      )
      ON CONFLICT (adjustment_id) DO UPDATE
        SET action = EXCLUDED.action,
            adjustment_type = EXCLUDED.adjustment_type,
            status = EXCLUDED.status,
            applied =
              public.credit_pack_adjustments.applied OR EXCLUDED.applied,
            review_required =
              public.credit_pack_adjustments.review_required
              OR EXCLUDED.review_required,
            updated_at = clock_timestamp()
      WHERE public.credit_pack_adjustments.transaction_id =
        EXCLUDED.transaction_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ADJUSTMENT_ID_CONFLICT' USING ERRCODE = '23505';
      END IF;

      UPDATE public.credit_pack_adjustment_receipts
         SET matched = true,
             applied = applied OR (v_terminal_adjustment_status IS NOT NULL),
             review_required = review_required OR (
               v_terminal_adjustment_status IS NULL
               OR v_terminal_adjustment_status = 'chargeback'
             ),
             updated_at = clock_timestamp()
       WHERE adjustment_id = v_preceding_adjustment.adjustment_id;
    END IF;

    RETURN jsonb_build_object(
      'applied', false,
      'reason', CASE
        WHEN v_terminal_adjustment_status = 'refunded'
          THEN 'payment_refunded_before_entitlement'
        WHEN v_terminal_adjustment_status = 'chargeback'
          THEN 'payment_chargeback_before_entitlement'
        ELSE 'entitlement_withheld'
      END,
      'userId', v_request.user_id,
      'requestId', p_request_id,
      'status', COALESCE(v_terminal_adjustment_status, 'withheld'),
      'entitlementGranted', false,
      'reviewRequired',
        COALESCE(v_terminal_adjustment_status, 'withheld') <> 'refunded',
      'withheldReason', CASE
        WHEN v_terminal_adjustment_status IS NOT NULL THEN NULL
        ELSE v_withheld_reason
      END
    );
  END IF;

  IF v_request.status IN (
    'completed',
    'withheld',
    'refunded',
    'chargeback'
  )
  OR (
    v_request.status = 'failed'
    AND NOT v_reconciled_no_match_close
  ) THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_TERMINAL'
      USING ERRCODE = 'P0001';
  END IF;

  v_result := public.apply_credit_pack_purchase(
    btrim(p_transaction_id),
    v_request.user_id,
    p_customer_id,
    p_pack_key,
    p_provider_price_id,
    p_credits,
    p_unit_amount,
    upper(p_currency_code),
    p_subscription_id,
    p_expiry_days,
    p_purchased_at
  );

  UPDATE public.credit_pack_purchases
     SET provider_event_id = btrim(p_provider_event_id)
   WHERE transaction_id = btrim(p_transaction_id)
     AND status = 'completed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_AUDIT_UPDATE_FAILED'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.credit_pack_purchase_requests
     SET transaction_id = btrim(p_transaction_id),
         provider_price_id = p_provider_price_id,
         provider_product_id = p_provider_product_id,
         provider_event_id = btrim(p_provider_event_id),
         transaction_created_at = p_transaction_created_at,
         captured_at = p_captured_at,
         actual_subtotal = p_actual_subtotal,
         actual_discount = p_actual_discount,
         actual_tax = p_actual_tax,
         actual_total = p_actual_total,
         actual_credit = p_actual_credit,
         actual_balance = p_actual_balance,
         actual_grand_total = p_actual_grand_total,
         actual_grand_total_tax = p_actual_grand_total_tax,
         history_proof_status = v_history_status,
         history_api_request_id = NULLIF(btrim(p_history_api_request_id), ''),
         history_event_id = NULLIF(btrim(p_history_event_id), ''),
         history_event_action = NULLIF(btrim(p_history_event_action), ''),
         history_event_occurred_at = p_history_event_occurred_at,
         review_required = false,
         status = 'completed',
         submitted_at = COALESCE(submitted_at, p_purchased_at),
         completed_at = p_purchased_at,
         provider_error_code = NULL
   WHERE request_id = p_request_id
     AND (
       status IN ('charging', 'submitted', 'provider_unknown')
     );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_FULFILLMENT_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_result || jsonb_build_object(
    'userId', v_request.user_id,
    'requestId', p_request_id,
    'status', 'completed',
    'entitlementGranted', true,
    'reviewRequired', false,
    'reconciliationSuperseded', false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment_v2(
  p_adjustment_id text,
  p_provider_event_id text,
  p_transaction_id text,
  p_action text,
  p_adjustment_type text,
  p_status text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_adjustment_receipt public.credit_pack_adjustment_receipts%ROWTYPE;
  v_payment_receipt public.credit_pack_payment_receipts%ROWTYPE;
  v_purchase public.credit_pack_purchases%ROWTYPE;
  v_result jsonb;
  v_terminal_status text;
BEGIN
  IF p_adjustment_id IS NULL OR btrim(p_adjustment_id) = ''
     OR length(p_adjustment_id) > 255
     OR p_provider_event_id IS NULL OR btrim(p_provider_event_id) = ''
     OR length(p_provider_event_id) > 255
     OR p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
     OR length(p_transaction_id) > 255
     OR p_action IS NULL OR btrim(p_action) = ''
     OR length(p_action) > 100
     OR p_status IS NULL OR btrim(p_status) = ''
     OR length(p_status) > 100
     OR (
       p_adjustment_type IS NOT NULL
       AND (
         btrim(p_adjustment_type) = ''
         OR length(p_adjustment_type) > 100
       )
     )
     OR p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_ADJUSTMENT'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('credit_pack_transaction:' || btrim(p_transaction_id), 0)
  );

  INSERT INTO public.credit_pack_adjustment_receipts (
    provider_event_id,
    adjustment_id,
    transaction_id,
    action,
    adjustment_type,
    status,
    occurred_at
  ) VALUES (
    btrim(p_provider_event_id),
    btrim(p_adjustment_id),
    btrim(p_transaction_id),
    btrim(p_action),
    NULLIF(btrim(p_adjustment_type), ''),
    btrim(p_status),
    p_occurred_at
  )
  ON CONFLICT (provider_event_id) DO NOTHING;

  SELECT *
    INTO v_adjustment_receipt
    FROM public.credit_pack_adjustment_receipts
   WHERE provider_event_id = btrim(p_provider_event_id)
   FOR UPDATE;

  IF NOT FOUND
     OR v_adjustment_receipt.adjustment_id IS DISTINCT FROM btrim(p_adjustment_id)
     OR v_adjustment_receipt.transaction_id IS DISTINCT FROM btrim(p_transaction_id)
     OR v_adjustment_receipt.action IS DISTINCT FROM btrim(p_action)
     OR v_adjustment_receipt.adjustment_type
          IS DISTINCT FROM NULLIF(btrim(p_adjustment_type), '')
     OR v_adjustment_receipt.status IS DISTINCT FROM btrim(p_status)
     OR v_adjustment_receipt.occurred_at IS DISTINCT FROM p_occurred_at THEN
    RAISE EXCEPTION 'CREDIT_PACK_ADJUSTMENT_EVENT_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  SELECT *
    INTO v_payment_receipt
    FROM public.credit_pack_payment_receipts
   WHERE transaction_id = btrim(p_transaction_id)
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'matched', false,
      'applied', false,
      'reason', 'payment_not_recorded'
    );
  END IF;

  -- The immutable payment receipt survives account deletion while the 023
  -- purchase/intent/lot graph is intentionally cascaded away. Resolve signed
  -- terminal adjustments directly against the retained evidence; never call a
  -- balance or lot mutator with a deleted user.
  IF v_payment_receipt.user_id IS NULL THEN
    IF btrim(p_status) = 'approved'
       AND COALESCE(NULLIF(btrim(p_adjustment_type), ''), '') = 'full'
       AND btrim(p_action) IN ('refund', 'credit', 'chargeback') THEN
      v_terminal_status := CASE
        WHEN v_payment_receipt.decision = 'chargeback'
          OR btrim(p_action) = 'chargeback'
          THEN 'chargeback'
        ELSE 'refunded'
      END;

      UPDATE public.credit_pack_adjustment_receipts
         SET matched = true,
             applied = true,
             review_required = review_required
               OR v_terminal_status = 'chargeback',
             updated_at = clock_timestamp()
       WHERE provider_event_id = btrim(p_provider_event_id);

      UPDATE public.credit_pack_payment_receipts
         SET decision = v_terminal_status,
             decision_reason = 'provider_' || v_terminal_status,
             adjusted_at = clock_timestamp()
       WHERE transaction_id = btrim(p_transaction_id);

      UPDATE public.credit_pack_checkout_intents
         SET status = 'refunded',
             refunded_at = COALESCE(refunded_at, p_occurred_at)
       WHERE transaction_id = btrim(p_transaction_id)
         AND status IN ('fulfilled', 'refunded');

      IF v_terminal_status = 'chargeback' THEN
        UPDATE public.credit_lots
           SET status = 'chargeback',
               updated_at = clock_timestamp()
         WHERE id = (
           SELECT lot_id
             FROM public.credit_pack_purchases
            WHERE transaction_id = btrim(p_transaction_id)
         )
           AND status = 'refunded';

        UPDATE public.credit_pack_purchases
           SET status = 'chargeback',
               review_required = true,
               adjusted_at = clock_timestamp()
         WHERE transaction_id = btrim(p_transaction_id)
           AND status IN ('refunded', 'chargeback');
      END IF;

      UPDATE public.credit_pack_purchase_requests
         SET status = v_terminal_status,
             withheld_reason = NULL,
             review_required = review_required
               OR v_terminal_status = 'chargeback',
             refunded_at = CASE
               WHEN v_terminal_status = 'refunded'
                 THEN COALESCE(refunded_at, p_occurred_at)
               ELSE NULL
             END
       WHERE request_id = v_payment_receipt.request_id
         AND transaction_id = btrim(p_transaction_id)
         AND status IN ('completed', 'withheld', 'refunded', 'chargeback');

      RETURN jsonb_build_object(
        'matched', true,
        'applied', true,
        'reason', CASE
          WHEN v_terminal_status = 'chargeback'
            THEN 'account_deleted_payment_chargeback_recorded'
          ELSE 'account_deleted_payment_refunded'
        END,
        'reviewRequired', v_terminal_status = 'chargeback',
        'userId', NULL
      );
    END IF;

    UPDATE public.credit_pack_adjustment_receipts
       SET matched = true,
           review_required = true,
           updated_at = clock_timestamp()
     WHERE provider_event_id = btrim(p_provider_event_id);

    UPDATE public.credit_pack_purchase_requests
       SET review_required = true
     WHERE request_id = v_payment_receipt.request_id
       AND transaction_id = btrim(p_transaction_id)
       AND status IN ('completed', 'withheld', 'refunded', 'chargeback');

    RETURN jsonb_build_object(
      'matched', true,
      'applied', false,
      'reason', 'manual_review',
      'reviewRequired', true,
      'userId', NULL
    );
  END IF;

  IF v_payment_receipt.decision <> 'withheld' THEN
    v_result := public.apply_credit_pack_adjustment(
      btrim(p_adjustment_id),
      btrim(p_transaction_id),
      btrim(p_action),
      NULLIF(btrim(p_adjustment_type), ''),
      btrim(p_status)
    );

    UPDATE public.credit_pack_adjustment_receipts
       SET matched = matched
             OR COALESCE((v_result ->> 'matched')::boolean, false),
           applied = applied
             OR COALESCE((v_result ->> 'applied')::boolean, false),
           review_required = review_required
             OR COALESCE((v_result ->> 'reviewRequired')::boolean, false),
           updated_at = clock_timestamp()
     WHERE provider_event_id = btrim(p_provider_event_id);

    UPDATE public.credit_pack_purchase_requests
       SET review_required = review_required
             OR COALESCE(
               (v_result ->> 'reviewRequired')::boolean,
               false
             )
     WHERE request_id = v_payment_receipt.request_id
       AND transaction_id = btrim(p_transaction_id)
       AND status IN ('completed', 'withheld', 'refunded', 'chargeback');

    IF btrim(p_status) = 'approved'
       AND COALESCE(NULLIF(btrim(p_adjustment_type), ''), '') = 'full'
       AND btrim(p_action) IN ('refund', 'credit', 'chargeback') THEN
      v_terminal_status := CASE
        WHEN v_payment_receipt.decision = 'chargeback'
          OR btrim(p_action) = 'chargeback'
          THEN 'chargeback'
        ELSE 'refunded'
      END;

      UPDATE public.credit_pack_adjustment_receipts
         SET matched = true,
             applied = true,
             review_required = review_required
               OR v_terminal_status = 'chargeback',
             updated_at = clock_timestamp()
       WHERE provider_event_id = btrim(p_provider_event_id);

      UPDATE public.credit_pack_adjustments
         SET applied = true,
             review_required = review_required
               OR v_terminal_status = 'chargeback',
             updated_at = clock_timestamp()
       WHERE adjustment_id = btrim(p_adjustment_id);

      UPDATE public.credit_pack_payment_receipts
         SET decision = v_terminal_status,
             decision_reason = 'provider_' || v_terminal_status,
             adjusted_at = clock_timestamp()
       WHERE transaction_id = btrim(p_transaction_id);

      UPDATE public.credit_pack_checkout_intents
         SET status = 'refunded',
             refunded_at = COALESCE(refunded_at, p_occurred_at)
       WHERE transaction_id = btrim(p_transaction_id)
         AND status IN ('fulfilled', 'refunded');

      UPDATE public.credit_pack_purchase_requests
         SET status = v_terminal_status,
             withheld_reason = NULL,
             review_required = review_required
               OR COALESCE(
                 (v_result ->> 'reviewRequired')::boolean,
                 false
               )
               OR v_terminal_status = 'chargeback',
             refunded_at = CASE
               WHEN v_terminal_status = 'refunded'
                 THEN COALESCE(refunded_at, p_occurred_at)
               ELSE NULL
             END
       WHERE request_id = v_payment_receipt.request_id
         AND transaction_id = btrim(p_transaction_id)
         AND status IN ('completed', 'withheld', 'refunded', 'chargeback');

      IF v_terminal_status = 'chargeback' THEN
        UPDATE public.credit_lots
           SET status = 'chargeback',
               updated_at = clock_timestamp()
         WHERE id = (
           SELECT lot_id
             FROM public.credit_pack_purchases
            WHERE transaction_id = btrim(p_transaction_id)
         )
           AND status = 'refunded';

        UPDATE public.credit_pack_purchases
           SET status = 'chargeback',
               review_required = true,
               adjusted_at = clock_timestamp()
         WHERE transaction_id = btrim(p_transaction_id)
           AND status IN ('refunded', 'chargeback');
      END IF;

      v_result := v_result || jsonb_build_object(
        'applied', true,
        'reason', CASE
          WHEN COALESCE((v_result ->> 'applied')::boolean, false)
            THEN v_result ->> 'reason'
          WHEN v_payment_receipt.decision = 'refunded'
               AND v_terminal_status = 'chargeback'
            THEN 'chargeback_reconciled'
          WHEN v_payment_receipt.decision = 'chargeback'
            THEN 'chargeback_preserved'
          ELSE v_terminal_status
        END,
        'reviewRequired',
          COALESCE((v_result ->> 'reviewRequired')::boolean, false)
          OR v_terminal_status = 'chargeback',
        'paymentDecision', v_terminal_status
      );
    END IF;

    RETURN v_result;
  END IF;

  SELECT *
    INTO v_purchase
    FROM public.credit_pack_purchases
   WHERE transaction_id = btrim(p_transaction_id)
   FOR UPDATE;

  IF NOT FOUND OR v_purchase.status <> 'withheld' THEN
    RAISE EXCEPTION 'WITHHELD_CREDIT_PACK_PURCHASE_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.credit_pack_adjustments (
    adjustment_id,
    transaction_id,
    action,
    adjustment_type,
    status
  ) VALUES (
    btrim(p_adjustment_id),
    btrim(p_transaction_id),
    btrim(p_action),
    NULLIF(btrim(p_adjustment_type), ''),
    btrim(p_status)
  )
  ON CONFLICT (adjustment_id) DO UPDATE
    SET action = EXCLUDED.action,
        adjustment_type = EXCLUDED.adjustment_type,
        status = EXCLUDED.status,
        updated_at = clock_timestamp()
  WHERE public.credit_pack_adjustments.transaction_id = EXCLUDED.transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADJUSTMENT_ID_CONFLICT' USING ERRCODE = '23505';
  END IF;

  IF btrim(p_status) <> 'approved' THEN
    UPDATE public.credit_pack_purchases
       SET review_required = true,
           adjusted_at = clock_timestamp()
     WHERE transaction_id = btrim(p_transaction_id);
    UPDATE public.credit_pack_adjustments
       SET review_required = true,
           updated_at = clock_timestamp()
     WHERE adjustment_id = btrim(p_adjustment_id);
    UPDATE public.credit_pack_adjustment_receipts
       SET matched = true,
           review_required = true,
           updated_at = clock_timestamp()
     WHERE provider_event_id = btrim(p_provider_event_id);
    UPDATE public.credit_pack_purchase_requests
       SET review_required = true
     WHERE request_id = v_payment_receipt.request_id
       AND transaction_id = btrim(p_transaction_id)
       AND status = 'withheld';
    RETURN jsonb_build_object(
      'matched', true,
      'applied', false,
      'reason', 'not_approved',
      'reviewRequired', true,
      'userId', v_purchase.user_id
    );
  END IF;

  IF btrim(p_action) NOT IN ('refund', 'credit', 'chargeback')
     OR COALESCE(NULLIF(btrim(p_adjustment_type), ''), '') <> 'full' THEN
    UPDATE public.credit_pack_purchases
       SET review_required = true,
           adjusted_at = clock_timestamp()
     WHERE transaction_id = btrim(p_transaction_id);
    UPDATE public.credit_pack_adjustments
       SET review_required = true
     WHERE adjustment_id = btrim(p_adjustment_id);
    UPDATE public.credit_pack_adjustment_receipts
       SET matched = true,
           review_required = true,
           updated_at = clock_timestamp()
     WHERE provider_event_id = btrim(p_provider_event_id);
    UPDATE public.credit_pack_purchase_requests
       SET review_required = true
     WHERE request_id = v_payment_receipt.request_id
       AND transaction_id = btrim(p_transaction_id)
       AND status = 'withheld';

    RETURN jsonb_build_object(
      'matched', true,
      'applied', false,
      'reason', 'manual_review',
      'reviewRequired', true,
      'userId', v_purchase.user_id
    );
  END IF;

  v_terminal_status := CASE
    WHEN btrim(p_action) = 'chargeback' THEN 'chargeback'
    ELSE 'refunded'
  END;

  UPDATE public.credit_pack_purchases
     SET status = v_terminal_status,
         withheld_reason = NULL,
         review_required = v_terminal_status = 'chargeback',
         adjusted_at = clock_timestamp()
   WHERE transaction_id = btrim(p_transaction_id)
     AND status = 'withheld';

  UPDATE public.credit_pack_checkout_intents
     SET status = 'refunded',
         refunded_at = COALESCE(refunded_at, p_occurred_at)
   WHERE transaction_id = btrim(p_transaction_id)
     AND status = 'withheld';

  UPDATE public.credit_pack_adjustments
     SET applied = true,
         review_required = v_terminal_status = 'chargeback',
         updated_at = clock_timestamp()
   WHERE adjustment_id = btrim(p_adjustment_id);

  UPDATE public.credit_pack_adjustment_receipts
     SET matched = true,
         applied = true,
         review_required = v_terminal_status = 'chargeback',
         updated_at = clock_timestamp()
   WHERE provider_event_id = btrim(p_provider_event_id);

  UPDATE public.credit_pack_payment_receipts
     SET decision = v_terminal_status,
         decision_reason = 'provider_' || v_terminal_status,
         adjusted_at = clock_timestamp()
   WHERE transaction_id = btrim(p_transaction_id)
     AND decision = 'withheld';

  UPDATE public.credit_pack_purchase_requests
     SET status = v_terminal_status,
         withheld_reason = NULL,
         review_required = v_terminal_status = 'chargeback',
         refunded_at = CASE
           WHEN v_terminal_status = 'refunded'
             THEN COALESCE(refunded_at, p_occurred_at)
           ELSE NULL
         END
   WHERE request_id = v_payment_receipt.request_id
     AND transaction_id = btrim(p_transaction_id)
     AND status IN ('withheld', 'refunded', 'chargeback');

  RETURN jsonb_build_object(
    'matched', true,
    'applied', true,
    'reason', CASE
      WHEN v_terminal_status = 'chargeback'
        THEN 'withheld_payment_chargeback_recorded'
      ELSE 'withheld_payment_refunded'
    END,
    'reviewRequired', v_terminal_status = 'chargeback',
    'userId', v_purchase.user_id,
    'newBalance', public.sync_credit_lot_balance(v_purchase.user_id)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.begin_credit_pack_purchase_preview(
  uuid, uuid, text, text, text, integer, integer, text, integer,
  timestamptz, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_credit_pack_purchase_preview(
  uuid, uuid, integer,
  integer, integer, integer, integer, integer, integer, integer, integer,
  text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_credit_pack_purchase_request(
  uuid, uuid, text, text, text, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_credit_pack_purchase_request(
  uuid, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.expire_credit_pack_purchase_request(
  uuid, uuid
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.transition_credit_pack_purchase_request(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_credit_pack_purchase_no_match_scan(
  uuid, uuid, text, timestamptz, timestamptz, timestamptz,
  integer, integer, text[], text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_credit_pack_purchase_no_match(
  uuid, uuid, text, timestamptz, timestamptz, timestamptz,
  integer, integer, text[], text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_credit_pack_subscription_charge(
  uuid, text, text, text, text, text, text,
  integer, integer, text,
  integer, integer, integer, integer, integer, integer, integer, integer,
  integer, timestamptz,
  text, timestamptz, timestamptz, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_credit_pack_adjustment_v2(
  text, text, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.begin_credit_pack_purchase_preview(
  uuid, uuid, text, text, text, integer, integer, text, integer,
  timestamptz, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_credit_pack_purchase_preview(
  uuid, uuid, integer,
  integer, integer, integer, integer, integer, integer, integer, integer,
  text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_credit_pack_purchase_request(
  uuid, uuid, text, text, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_credit_pack_purchase_request(
  uuid, uuid, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_credit_pack_purchase_request(
  uuid, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_credit_pack_purchase_request(
  uuid, uuid, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_credit_pack_purchase_no_match_scan(
  uuid, uuid, text, timestamptz, timestamptz, timestamptz,
  integer, integer, text[], text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_credit_pack_purchase_no_match(
  uuid, uuid, text, timestamptz, timestamptz, timestamptz,
  integer, integer, text[], text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_credit_pack_subscription_charge(
  uuid, text, text, text, text, text, text,
  integer, integer, text,
  integer, integer, integer, integer, integer, integer, integer, integer,
  integer, timestamptz,
  text, timestamptz, timestamptz, text, text, text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_credit_pack_adjustment_v2(
  text, text, text, text, text, text, timestamptz
) TO service_role;

COMMIT;
