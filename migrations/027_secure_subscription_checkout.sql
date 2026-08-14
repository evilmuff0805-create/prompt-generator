-- ============================================================
-- Migration 027: server-bound subscription checkout attempts
--
-- Apply after:
--   023_legacy_credit_classification_manifest.sql
--   024_credit_lot_ledger.sql
--   025_paddle_event_ordering.sql
--   026_secure_payment_requests.sql
--
-- Security contract:
--   * The authenticated browser never selects a Paddle price or supplies the
--     entitlement owner to a webhook.
--   * The server creates an immutable attempt before calling Paddle, then binds
--     exactly one API-created transaction to that attempt.
--   * Initial subscription transaction.completed webhooks are fulfilled only
--     through consume_subscription_checkout_attempt. Direct Paddle.js
--     origins (`web` / `checkout`) fail closed and cannot grant entitlement.
--   * A subscription snapshot that carries checkout metadata may resolve its
--     owner only after the corresponding attempt is completed. This prevents an
--     early direct-checkout subscription.updated event from bypassing the
--     transaction-origin check.
--   * Billing lock order is subscription state(s) -> profile -> attempt.
-- ============================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regclass('public.paddle_subscription_states') IS NULL
     OR to_regprocedure(
       'public.apply_ordered_subscription_payment(text,uuid,text,integer,text,text,timestamptz,boolean,boolean)'
     ) IS NULL THEN
    RAISE EXCEPTION 'SECURE_SUBSCRIPTION_CHECKOUT_REQUIRES_MIGRATION_025';
  END IF;

  IF to_regclass('public.credit_pack_purchase_requests') IS NULL THEN
    RAISE EXCEPTION 'SECURE_SUBSCRIPTION_CHECKOUT_REQUIRES_MIGRATION_026';
  END IF;
END;
$preflight$;

CREATE TABLE public.subscription_checkout_attempts (
  attempt_id           UUID PRIMARY KEY,
  user_id              UUID
                       REFERENCES public.profiles(id) ON DELETE SET NULL,
  authorized_user_id   UUID NOT NULL,
  transaction_id       TEXT UNIQUE,
  subscription_id      TEXT UNIQUE,
  customer_id          TEXT,
  target_plan          TEXT NOT NULL
                       CHECK (target_plan IN ('pro', 'enterprise')),
  price_id             TEXT NOT NULL,
  credits              INTEGER NOT NULL CHECK (credits > 0),
  unit_amount          INTEGER NOT NULL CHECK (unit_amount > 0),
  currency_code        TEXT NOT NULL CHECK (currency_code = 'USD'),
  expected_origin      TEXT NOT NULL DEFAULT 'api'
                       CHECK (expected_origin = 'api'),
  status               TEXT NOT NULL DEFAULT 'created'
                       CHECK (
                         status IN (
                           'created',
                           'charging',
                           'bound',
                           'provider_unknown',
                           'reconciled_no_match',
                           'account_deleted_review',
                           'completed',
                           'failed'
                         )
                       ),
  provider_error_code  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  provider_mutation_started_at TIMESTAMPTZ,
  provider_unknown_at  TIMESTAMPTZ,
  bound_at             TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  failed_at            TIMESTAMPTZ,
  reconciliation_decision TEXT,
  reconciliation_previous_status TEXT,
  reconciliation_closed_at TIMESTAMPTZ,
  review_required      BOOLEAN NOT NULL DEFAULT false,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT subscription_checkout_attempts_price_id_check
    CHECK (btrim(price_id) <> '' AND length(price_id) <= 255),
  CONSTRAINT subscription_checkout_attempts_transaction_id_check
    CHECK (
      transaction_id IS NULL
      OR (btrim(transaction_id) <> '' AND length(transaction_id) <= 255)
    ),
  CONSTRAINT subscription_checkout_attempts_subscription_id_check
    CHECK (
      subscription_id IS NULL
      OR (btrim(subscription_id) <> '' AND length(subscription_id) <= 255)
    ),
  CONSTRAINT subscription_checkout_attempts_customer_id_check
    CHECK (
      customer_id IS NULL
      OR (btrim(customer_id) <> '' AND length(customer_id) <= 255)
    ),
  CONSTRAINT subscription_checkout_attempts_provider_error_check
    CHECK (
      provider_error_code IS NULL
      OR length(provider_error_code) <= 255
    ),
  CONSTRAINT subscription_checkout_attempts_status_fields_check
    CHECK (
      (
        status = 'created'
        AND transaction_id IS NULL
        AND subscription_id IS NULL
        AND customer_id IS NULL
        AND bound_at IS NULL
        AND completed_at IS NULL
        AND failed_at IS NULL
        AND provider_mutation_started_at IS NULL
        AND reconciliation_decision IS NULL
        AND reconciliation_previous_status IS NULL
        AND reconciliation_closed_at IS NULL
        AND review_required = false
      )
      OR
      (
        status = 'charging'
        AND transaction_id IS NULL
        AND subscription_id IS NULL
        AND customer_id IS NULL
        AND provider_mutation_started_at IS NOT NULL
        AND provider_unknown_at IS NULL
        AND bound_at IS NULL
        AND completed_at IS NULL
        AND failed_at IS NULL
        AND reconciliation_decision IS NULL
        AND reconciliation_previous_status IS NULL
        AND reconciliation_closed_at IS NULL
        AND review_required = false
      )
      OR
      (
        status = 'provider_unknown'
        AND transaction_id IS NULL
        AND subscription_id IS NULL
        AND customer_id IS NULL
        AND provider_mutation_started_at IS NOT NULL
        AND provider_unknown_at IS NOT NULL
        AND bound_at IS NULL
        AND completed_at IS NULL
        AND failed_at IS NULL
        AND reconciliation_decision IS NULL
        AND reconciliation_previous_status IS NULL
        AND reconciliation_closed_at IS NULL
        AND review_required = false
      )
      OR
      (
        status = 'reconciled_no_match'
        AND transaction_id IS NULL
        AND subscription_id IS NULL
        AND customer_id IS NULL
        AND provider_mutation_started_at IS NOT NULL
        AND (
          reconciliation_previous_status = 'charging'
          OR provider_unknown_at IS NOT NULL
        )
        AND bound_at IS NULL
        AND completed_at IS NULL
        AND failed_at IS NOT NULL
        AND reconciliation_decision = 'definitive_no_match'
        AND reconciliation_previous_status IN ('charging', 'provider_unknown')
        AND reconciliation_closed_at IS NOT NULL
        AND reconciliation_closed_at >=
          CASE
            WHEN reconciliation_previous_status = 'provider_unknown'
              THEN provider_unknown_at + interval '96 hours'
            ELSE provider_mutation_started_at + interval '96 hours'
          END
        AND review_required = true
        AND provider_error_code = 'reconciled_definitive_no_match'
      )
      OR
      (
        status = 'account_deleted_review'
        AND user_id IS NULL
        AND transaction_id IS NOT NULL
        AND subscription_id IS NOT NULL
        AND customer_id IS NOT NULL
        AND provider_mutation_started_at IS NOT NULL
        AND bound_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND failed_at IS NULL
        AND reconciliation_decision IS NULL
        AND reconciliation_previous_status IS NULL
        AND reconciliation_closed_at IS NULL
        AND review_required = true
        AND provider_error_code = 'payment_after_account_deleted'
      )
      OR
      (
        status = 'bound'
        AND transaction_id IS NOT NULL
        AND subscription_id IS NULL
        AND customer_id IS NULL
        AND provider_mutation_started_at IS NOT NULL
        AND bound_at IS NOT NULL
        AND completed_at IS NULL
        AND failed_at IS NULL
        AND reconciliation_decision IS NULL
        AND reconciliation_previous_status IS NULL
        AND reconciliation_closed_at IS NULL
        AND review_required = false
      )
      OR
      (
        status = 'completed'
        AND transaction_id IS NOT NULL
        AND subscription_id IS NOT NULL
        AND customer_id IS NOT NULL
        AND provider_mutation_started_at IS NOT NULL
        AND bound_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND failed_at IS NULL
        AND reconciliation_decision IS NULL
        AND reconciliation_previous_status IS NULL
        AND reconciliation_closed_at IS NULL
        AND review_required = false
      )
      OR
      (
        status = 'failed'
        AND transaction_id IS NULL
        AND subscription_id IS NULL
        AND customer_id IS NULL
        AND bound_at IS NULL
        AND completed_at IS NULL
        AND failed_at IS NOT NULL
        AND reconciliation_decision IS NULL
        AND reconciliation_previous_status IS NULL
        AND reconciliation_closed_at IS NULL
        AND review_required = false
        AND (
          (
            provider_error_code = 'pre_provider_attempt_expired'
            AND provider_mutation_started_at IS NULL
            AND provider_unknown_at IS NULL
          )
          OR
          (
            provider_error_code IS DISTINCT FROM
              'pre_provider_attempt_expired'
            AND provider_mutation_started_at IS NOT NULL
          )
        )
      )
    )
);

-- charging is persisted before the provider mutation. A charging or
-- provider_unknown attempt may already have created a transaction even though
-- PromptGen never received the response, so both remain reconciliation-only.
CREATE UNIQUE INDEX subscription_checkout_attempts_one_open_per_user_idx
  ON public.subscription_checkout_attempts (authorized_user_id)
  WHERE status IN ('created', 'charging', 'bound', 'provider_unknown');

CREATE INDEX subscription_checkout_attempts_user_created_idx
  ON public.subscription_checkout_attempts (user_id, created_at DESC);
CREATE INDEX subscription_checkout_attempts_authorized_user_created_idx
  ON public.subscription_checkout_attempts (
    authorized_user_id,
    created_at DESC
  );

ALTER TABLE public.subscription_checkout_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_checkout_attempts
  FROM PUBLIC, anon, authenticated, service_role;
-- Application reads are direct so webhook reconciliation can locate the
-- immutable attempt. Every write must pass through the SECURITY DEFINER RPCs
-- below, which enforce lock order, state transitions, and contract checks.
GRANT SELECT
  ON TABLE public.subscription_checkout_attempts TO service_role;

-- Two immutable, independent provider scans are required before a
-- provider_unknown attempt can release the one-open-attempt lock. These rows
-- contain no email and survive profile deletion because the attempt keeps an
-- authorization tombstone. Retention duration remains a legal/product gate.
CREATE TABLE public.subscription_checkout_reconciliation_scans (
  attempt_id UUID NOT NULL
    REFERENCES public.subscription_checkout_attempts(attempt_id)
    ON DELETE RESTRICT,
  authorized_user_id UUID NOT NULL,
  scan_ordinal SMALLINT NOT NULL CHECK (scan_ordinal IN (1, 2)),
  expected_status TEXT NOT NULL
    CHECK (expected_status IN ('charging', 'provider_unknown')),
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
  PRIMARY KEY (attempt_id, scan_ordinal),
  CONSTRAINT subscription_checkout_reconciliation_scans_window_check
    CHECK (window_start <= window_end AND window_end >= checked_at),
  CONSTRAINT subscription_checkout_reconciliation_scans_count_check
    CHECK (
      transactions_scanned::bigint <= pages_scanned::bigint * 30
      AND cardinality(provider_request_ids) = pages_scanned
    ),
  CONSTRAINT subscription_checkout_reconciliation_scans_catalog_request_id_check
    CHECK (
      catalog_request_id = btrim(catalog_request_id)
      AND catalog_request_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT subscription_checkout_reconciliation_scans_contract_fingerprint_check
    CHECK (contract_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT subscription_checkout_reconciliation_scans_evidence_hash_check
    CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT subscription_checkout_reconciliation_scans_audit_reference_check
    CHECK (
      btrim(audit_reference) <> ''
      AND length(audit_reference) <= 255
    )
);

CREATE INDEX subscription_checkout_reconciliation_scans_checked_idx
  ON public.subscription_checkout_reconciliation_scans (checked_at DESC);

ALTER TABLE public.subscription_checkout_reconciliation_scans
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_checkout_reconciliation_scans
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.subscription_checkout_reconciliation_scans
  TO service_role;

CREATE TRIGGER subscription_checkout_reconciliation_scans_immutable
BEFORE UPDATE OR DELETE ON public.subscription_checkout_reconciliation_scans
FOR EACH ROW
EXECUTE FUNCTION public.reject_payment_reconciliation_scan_mutation();

-- Signed completions that arrive after final no-match closure, or after the
-- account was deleted, are recorded without entitlement. authorized_user_id
-- is the no-FK authorization tombstone; user_id is nulled if a profile is
-- deleted so a pre-deletion late receipt can be replayed without retaining the
-- live profile relationship.
CREATE TABLE public.subscription_checkout_late_payment_receipts (
  transaction_id TEXT PRIMARY KEY,
  attempt_id UUID NOT NULL
    REFERENCES public.subscription_checkout_attempts(attempt_id)
    ON DELETE RESTRICT,
  authorized_user_id UUID NOT NULL,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  subscription_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  target_plan TEXT NOT NULL CHECK (target_plan IN ('pro', 'enterprise')),
  price_id TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  unit_amount INTEGER NOT NULL CHECK (unit_amount > 0),
  currency_code TEXT NOT NULL CHECK (currency_code = 'USD'),
  completed_at TIMESTAMPTZ NOT NULL,
  decision TEXT NOT NULL CHECK (decision = 'refund_review'),
  decision_reason TEXT NOT NULL
    CHECK (
      decision_reason IN (
        'late_payment_after_reconciled_no_match',
        'payment_after_account_deleted'
      )
    ),
  account_deleted BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT subscription_checkout_late_receipts_transaction_id_check
    CHECK (btrim(transaction_id) <> '' AND length(transaction_id) <= 255),
  CONSTRAINT subscription_checkout_late_receipts_subscription_id_check
    CHECK (btrim(subscription_id) <> '' AND length(subscription_id) <= 255),
  CONSTRAINT subscription_checkout_late_receipts_customer_id_check
    CHECK (btrim(customer_id) <> '' AND length(customer_id) <= 255),
  CONSTRAINT subscription_checkout_late_receipts_price_id_check
    CHECK (btrim(price_id) <> '' AND length(price_id) <= 255)
);

CREATE UNIQUE INDEX subscription_checkout_late_receipts_attempt_idx
  ON public.subscription_checkout_late_payment_receipts (attempt_id);
CREATE INDEX subscription_checkout_late_receipts_review_idx
  ON public.subscription_checkout_late_payment_receipts (
    decision,
    created_at DESC
  );

ALTER TABLE public.subscription_checkout_late_payment_receipts
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_checkout_late_payment_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.subscription_checkout_late_payment_receipts
  TO service_role;

-- Preserve receipt immutability while allowing only the FK's nested
-- ON DELETE SET NULL action to remove the live profile relationship. A direct
-- UPDATE, any other field change, or any DELETE still fails closed.
CREATE OR REPLACE FUNCTION public.guard_subscription_checkout_late_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND OLD.user_id IS NOT NULL
     AND NEW.user_id IS NULL
     AND (to_jsonb(NEW) - 'user_id')
           IS NOT DISTINCT FROM (to_jsonb(OLD) - 'user_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_LATE_RECEIPT_IMMUTABLE'
    USING ERRCODE = '55000';
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_subscription_checkout_late_receipt_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER subscription_checkout_late_receipts_immutable
BEFORE UPDATE OR DELETE ON public.subscription_checkout_late_payment_receipts
FOR EACH ROW
EXECUTE FUNCTION public.guard_subscription_checkout_late_receipt_mutation();

CREATE OR REPLACE FUNCTION public.create_subscription_checkout_attempt(
  p_attempt_id uuid,
  p_user_id uuid,
  p_target_plan text,
  p_price_id text,
  p_credits integer,
  p_unit_amount integer,
  p_currency_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_target_plan text := lower(btrim(COALESCE(p_target_plan, '')));
  v_price_id text := btrim(COALESCE(p_price_id, ''));
  v_currency_code text := upper(btrim(COALESCE(p_currency_code, '')));
  v_profile_snapshot_subscription_id text;
  v_profile public.profiles%ROWTYPE;
  v_state public.paddle_subscription_states%ROWTYPE;
  v_existing public.subscription_checkout_attempts%ROWTYPE;
BEGIN
  IF p_attempt_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_SUBSCRIPTION_CHECKOUT_ATTEMPT'
      USING ERRCODE = '22023';
  END IF;
  IF v_target_plan NOT IN ('pro', 'enterprise')
     OR v_price_id IS NULL OR v_price_id = ''
     OR length(v_price_id) > 255
     OR p_unit_amount IS NULL OR p_unit_amount <= 0
     OR v_currency_code <> 'USD' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;
  IF NOT (
    (v_target_plan = 'pro' AND p_credits = 600)
    OR
    (v_target_plan = 'enterprise' AND p_credits = 1500)
  ) THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;

  -- Read identity without a lock, then acquire state -> profile -> attempt.
  SELECT NULLIF(btrim(p.paddle_subscription_id), '')
    INTO v_profile_snapshot_subscription_id
    FROM public.profiles p
   WHERE p.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_profile_snapshot_subscription_id IS NOT NULL THEN
    SELECT *
      INTO v_state
      FROM public.paddle_subscription_states
     WHERE subscription_id = v_profile_snapshot_subscription_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUBSCRIPTION_STATE_RECONCILIATION_REQUIRED'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NULLIF(btrim(v_profile.paddle_subscription_id), '')
       IS DISTINCT FROM v_profile_snapshot_subscription_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_PROFILE_CHANGED_RETRY'
      USING ERRCODE = '40001';
  END IF;

  IF v_profile_snapshot_subscription_id IS NOT NULL THEN
    IF v_state.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_USER_CONFLICT'
        USING ERRCODE = '23505';
    END IF;
    IF NOT v_state.terminal THEN
      RAISE EXCEPTION 'ACTIVE_SUBSCRIPTION_ALREADY_EXISTS'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF lower(COALESCE(v_profile.plan, 'free')) IN ('pro', 'enterprise', 'paid') THEN
    RAISE EXCEPTION 'SUBSCRIPTION_PROFILE_RECONCILIATION_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.subscription_checkout_attempts
   WHERE authorized_user_id = p_user_id
     AND status IN ('created', 'charging', 'bound', 'provider_unknown')
   ORDER BY created_at, attempt_id
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'created'
       AND clock_timestamp() >= v_existing.created_at + interval '15 minutes'
       THEN
      UPDATE public.subscription_checkout_attempts
         SET status = 'failed',
             provider_error_code = 'pre_provider_attempt_expired',
             failed_at = clock_timestamp(),
             updated_at = clock_timestamp()
       WHERE attempt_id = v_existing.attempt_id
         AND status = 'created'
         AND created_at = v_existing.created_at
         AND clock_timestamp() >= created_at + interval '15 minutes';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_EXPIRY_RACE'
          USING ERRCODE = '40001';
      END IF;
    ELSE
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'duplicate_pending',
        'attemptId', v_existing.attempt_id,
        'status', v_existing.status,
        'targetPlan', v_existing.target_plan,
        'priceId', v_existing.price_id,
        'credits', v_existing.credits,
        'unitAmount', v_existing.unit_amount,
        'currencyCode', v_existing.currency_code,
        'transactionId', v_existing.transaction_id
      );
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.subscription_checkout_attempts (
      attempt_id,
      user_id,
      authorized_user_id,
      target_plan,
      price_id,
      credits,
      unit_amount,
      currency_code
    ) VALUES (
      p_attempt_id,
      p_user_id,
      p_user_id,
      v_target_plan,
      v_price_id,
      p_credits,
      p_unit_amount,
      v_currency_code
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT *
      INTO v_existing
      FROM public.subscription_checkout_attempts
     WHERE authorized_user_id = p_user_id
       AND status IN ('created', 'charging', 'bound', 'provider_unknown')
     ORDER BY created_at, attempt_id
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'duplicate_pending',
        'attemptId', v_existing.attempt_id,
        'status', v_existing.status,
        'targetPlan', v_existing.target_plan,
        'priceId', v_existing.price_id,
        'credits', v_existing.credits,
        'unitAmount', v_existing.unit_amount,
        'currencyCode', v_existing.currency_code,
        'transactionId', v_existing.transaction_id
      );
    END IF;

    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_ID_CONFLICT'
      USING ERRCODE = '23505';
  END;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'checkout_attempt_created',
    'attemptId', p_attempt_id,
    'status', 'created',
    'targetPlan', v_target_plan,
    'priceId', v_price_id,
    'credits', p_credits,
    'unitAmount', p_unit_amount,
    'currencyCode', v_currency_code,
    'transactionId', NULL
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bind_subscription_checkout_transaction(
  p_attempt_id uuid,
  p_user_id uuid,
  p_transaction_id text,
  p_origin text,
  p_plan text,
  p_price_id text,
  p_credits integer,
  p_unit_amount integer,
  p_currency_code text,
  p_quantity integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_transaction_id text := btrim(COALESCE(p_transaction_id, ''));
  v_origin text := lower(btrim(COALESCE(p_origin, '')));
  v_plan text := lower(btrim(COALESCE(p_plan, '')));
  v_price_id text := btrim(COALESCE(p_price_id, ''));
  v_currency_code text := upper(btrim(COALESCE(p_currency_code, '')));
  v_attempt_snapshot public.subscription_checkout_attempts%ROWTYPE;
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
  v_profile_snapshot_subscription_id text;
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF p_attempt_id IS NULL OR p_user_id IS NULL
     OR v_transaction_id IS NULL OR v_transaction_id = ''
     OR length(v_transaction_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_SUBSCRIPTION_CHECKOUT_BINDING'
      USING ERRCODE = '22023';
  END IF;
  IF v_origin <> 'api' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ORIGIN_REJECTED'
      USING ERRCODE = '22023';
  END IF;
  IF v_plan NOT IN ('pro', 'enterprise')
     OR v_price_id = '' OR length(v_price_id) > 255
     OR p_credits IS NULL OR p_credits <= 0
     OR p_unit_amount IS NULL OR p_unit_amount <= 0
     OR v_currency_code <> 'USD'
     OR p_quantity IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_attempt_snapshot
    FROM public.subscription_checkout_attempts
   WHERE attempt_id = p_attempt_id;
  IF NOT FOUND OR v_attempt_snapshot.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT NULLIF(btrim(p.paddle_subscription_id), '')
    INTO v_profile_snapshot_subscription_id
    FROM public.profiles p
   WHERE p.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_profile_snapshot_subscription_id IS NOT NULL THEN
    PERFORM 1
      FROM public.paddle_subscription_states
     WHERE subscription_id = v_profile_snapshot_subscription_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUBSCRIPTION_STATE_RECONCILIATION_REQUIRED'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NULLIF(btrim(v_profile.paddle_subscription_id), '')
       IS DISTINCT FROM v_profile_snapshot_subscription_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_PROFILE_CHANGED_RETRY'
      USING ERRCODE = '40001';
  END IF;

  SELECT *
    INTO v_attempt
    FROM public.subscription_checkout_attempts
   WHERE attempt_id = p_attempt_id
   FOR UPDATE;

  IF NOT FOUND OR v_attempt.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.expected_origin <> 'api' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ORIGIN_REJECTED'
      USING ERRCODE = '22023';
  END IF;
  IF v_attempt.target_plan IS DISTINCT FROM v_plan
     OR v_attempt.price_id IS DISTINCT FROM v_price_id
     OR v_attempt.credits IS DISTINCT FROM p_credits
     OR v_attempt.unit_amount IS DISTINCT FROM p_unit_amount
     OR v_attempt.currency_code IS DISTINCT FROM v_currency_code THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;
  IF v_attempt.status = 'completed' THEN
    IF v_attempt.transaction_id IS DISTINCT FROM v_transaction_id THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_TRANSACTION_CONFLICT'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'already_completed',
      'attemptId', v_attempt.attempt_id,
      'status', v_attempt.status,
      'transactionId', v_attempt.transaction_id
    );
  END IF;
  IF v_attempt.status IN (
    'failed',
    'reconciled_no_match',
    'account_deleted_review'
  ) THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_TERMINAL'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.status = 'created' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_PROVIDER_MUTATION_NOT_STARTED'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.transaction_id IS NOT NULL THEN
    IF v_attempt.transaction_id IS DISTINCT FROM v_transaction_id THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_TRANSACTION_CONFLICT'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'attemptId', v_attempt.attempt_id,
      'status', v_attempt.status,
      'transactionId', v_attempt.transaction_id
    );
  END IF;

  BEGIN
    UPDATE public.subscription_checkout_attempts
       SET transaction_id = v_transaction_id,
           status = 'bound',
           provider_error_code = NULL,
           bound_at = clock_timestamp(),
           updated_at = clock_timestamp()
     WHERE attempt_id = p_attempt_id
       AND status IN ('charging', 'provider_unknown');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_TRANSACTION_CONFLICT'
      USING ERRCODE = '23505';
  END;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_BINDING_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'transaction_bound',
    'attemptId', p_attempt_id,
    'status', 'bound',
    'transactionId', v_transaction_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.transition_subscription_checkout_attempt(
  p_attempt_id uuid,
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
  v_status text := lower(btrim(COALESCE(p_status, '')));
  v_attempt_snapshot public.subscription_checkout_attempts%ROWTYPE;
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
  v_profile_snapshot_subscription_id text;
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF p_attempt_id IS NULL OR p_user_id IS NULL
     OR v_status NOT IN ('charging', 'provider_unknown', 'failed')
     OR (
       p_provider_error_code IS NOT NULL
       AND length(p_provider_error_code) > 255
     )
     OR (
       v_status = 'charging'
       AND NULLIF(btrim(p_provider_error_code), '') IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'INVALID_SUBSCRIPTION_CHECKOUT_TRANSITION'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_attempt_snapshot
    FROM public.subscription_checkout_attempts
   WHERE attempt_id = p_attempt_id;
  IF NOT FOUND OR v_attempt_snapshot.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT NULLIF(btrim(p.paddle_subscription_id), '')
    INTO v_profile_snapshot_subscription_id
    FROM public.profiles p
   WHERE p.id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_profile_snapshot_subscription_id IS NOT NULL THEN
    PERFORM 1
      FROM public.paddle_subscription_states
     WHERE subscription_id = v_profile_snapshot_subscription_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUBSCRIPTION_STATE_RECONCILIATION_REQUIRED'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NULLIF(btrim(v_profile.paddle_subscription_id), '')
       IS DISTINCT FROM v_profile_snapshot_subscription_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_PROFILE_CHANGED_RETRY'
      USING ERRCODE = '40001';
  END IF;

  SELECT *
    INTO v_attempt
    FROM public.subscription_checkout_attempts
   WHERE attempt_id = p_attempt_id
   FOR UPDATE;

  IF NOT FOUND OR v_attempt.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.status IN (
    'bound',
    'completed',
    'reconciled_no_match',
    'account_deleted_review'
  ) THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_RECONCILIATION_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.status = 'failed' THEN
    IF v_status = 'failed' THEN
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'duplicate',
        'status', v_attempt.status
      );
    END IF;
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_TERMINAL'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.status = 'provider_unknown' THEN
    IF v_status = 'provider_unknown' THEN
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'duplicate',
        'status', v_attempt.status
      );
    END IF;
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_RECONCILIATION_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.status = 'created' AND v_status <> 'charging' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_PROVIDER_MUTATION_NOT_STARTED'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.status = 'charging' AND v_status = 'charging' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'attemptId', v_attempt.attempt_id,
      'status', v_attempt.status,
      'providerMutationStartedAt', v_attempt.provider_mutation_started_at
    );
  END IF;
  IF v_attempt.status = 'charging'
     AND v_status IN ('provider_unknown', 'failed')
     AND EXISTS (
       SELECT 1
         FROM public.subscription_checkout_reconciliation_scans
        WHERE attempt_id = p_attempt_id
          AND scan_ordinal = 1
     ) THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_scan_in_progress',
      'attemptId', v_attempt.attempt_id,
      'status', v_attempt.status,
      'providerMutationStartedAt', v_attempt.provider_mutation_started_at
    );
  END IF;
  IF v_attempt.status = 'charging'
     AND v_status NOT IN ('provider_unknown', 'failed') THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_TRANSITION_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.subscription_checkout_attempts
     SET status = v_status,
         provider_error_code = CASE
           WHEN v_status = 'charging' THEN NULL
           ELSE NULLIF(btrim(p_provider_error_code), '')
         END,
         provider_mutation_started_at = CASE
           WHEN v_status = 'charging'
             THEN COALESCE(provider_mutation_started_at, clock_timestamp())
           ELSE provider_mutation_started_at
         END,
         provider_unknown_at = CASE
           WHEN v_status = 'provider_unknown'
             THEN COALESCE(provider_unknown_at, clock_timestamp())
           ELSE provider_unknown_at
         END,
         failed_at = CASE
           WHEN v_status = 'failed' THEN clock_timestamp()
           ELSE NULL
         END,
         updated_at = clock_timestamp()
   WHERE attempt_id = p_attempt_id
     AND status = v_attempt.status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_TRANSITION_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', CASE
      WHEN v_status = 'charging' THEN 'provider_mutation_started'
      ELSE 'attempt_transitioned'
    END,
    'attemptId', p_attempt_id,
    'status', v_status,
    'providerMutationStartedAt', CASE
      WHEN v_status = 'charging'
        THEN COALESCE(
          v_attempt.provider_mutation_started_at,
          (
            SELECT provider_mutation_started_at
              FROM public.subscription_checkout_attempts
             WHERE attempt_id = p_attempt_id
          )
        )
      ELSE v_attempt.provider_mutation_started_at
    END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_subscription_checkout_no_match_scan(
  p_attempt_id uuid,
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
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
  v_existing public.subscription_checkout_reconciliation_scans%ROWTYPE;
  v_expected_status text := lower(btrim(COALESCE(p_expected_status, '')));
  v_catalog_request_id text := btrim(COALESCE(p_catalog_request_id, ''));
  v_contract_fingerprint text :=
    lower(btrim(COALESCE(p_contract_fingerprint, '')));
  v_evidence_hash text := lower(btrim(COALESCE(p_evidence_hash, '')));
  v_audit_reference text := NULLIF(btrim(p_audit_reference), '');
  v_provider_request_id text;
  v_seen_provider_request_ids text[] := ARRAY[]::text[];
  v_reconciliation_started_at timestamptz;
  v_recorded_at timestamptz;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_attempt_id IS NULL
     OR v_expected_status NOT IN ('charging', 'provider_unknown')
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
    RAISE EXCEPTION 'INVALID_SUBSCRIPTION_CHECKOUT_RECONCILIATION_EVIDENCE'
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
      RAISE EXCEPTION 'INVALID_SUBSCRIPTION_CHECKOUT_RECONCILIATION_EVIDENCE'
        USING ERRCODE = '22023';
    END IF;
    v_seen_provider_request_ids :=
      array_append(v_seen_provider_request_ids, v_provider_request_id);
  END LOOP;

  SELECT *
    INTO v_attempt
    FROM public.subscription_checkout_attempts
   WHERE attempt_id = p_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.subscription_checkout_reconciliation_scans
   WHERE attempt_id = p_attempt_id
     AND scan_ordinal = 1;
  IF FOUND THEN
    IF v_existing.authorized_user_id
          IS NOT DISTINCT FROM v_attempt.authorized_user_id
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
        'attemptId', v_attempt.attempt_id,
        'status', v_attempt.status,
        'scanOrdinal', 1,
        'firstCheckedAt', v_existing.checked_at,
        'firstRecordedAt', v_existing.recorded_at
      );
    END IF;

    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_RECONCILIATION_EVIDENCE_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  IF v_attempt.status NOT IN ('charging', 'provider_unknown') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_not_allowed',
      'attemptId', v_attempt.attempt_id,
      'status', v_attempt.status
    );
  END IF;
  IF v_attempt.status IS DISTINCT FROM v_expected_status THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_status_mismatch',
      'attemptId', v_attempt.attempt_id,
      'status', v_attempt.status
    );
  END IF;

  v_reconciliation_started_at := CASE
    WHEN v_attempt.status = 'provider_unknown'
      THEN COALESCE(
        v_attempt.provider_unknown_at,
        v_attempt.provider_mutation_started_at
      )
    ELSE v_attempt.provider_mutation_started_at
  END;

  IF v_reconciliation_started_at IS NULL
     OR p_window_start > v_attempt.created_at
     OR p_checked_at < v_reconciliation_started_at + interval '72 hours'
     OR v_now < v_reconciliation_started_at + interval '72 hours' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_delay_active',
      'attemptId', v_attempt.attempt_id,
      'status', v_attempt.status,
      'earliestReconciliationAt',
        v_reconciliation_started_at + interval '72 hours'
    );
  END IF;

  INSERT INTO public.subscription_checkout_reconciliation_scans (
    attempt_id,
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
    p_attempt_id,
    v_attempt.authorized_user_id,
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
    'attemptId', p_attempt_id,
    'status', v_attempt.status,
    'scanOrdinal', 1,
    'firstCheckedAt', p_checked_at,
    'firstRecordedAt', v_recorded_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_subscription_checkout_no_match(
  p_attempt_id uuid,
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
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
  v_first public.subscription_checkout_reconciliation_scans%ROWTYPE;
  v_existing public.subscription_checkout_reconciliation_scans%ROWTYPE;
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
  IF p_attempt_id IS NULL
     OR v_expected_status NOT IN ('charging', 'provider_unknown')
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
    RAISE EXCEPTION 'INVALID_SUBSCRIPTION_CHECKOUT_RECONCILIATION_EVIDENCE'
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
      RAISE EXCEPTION 'INVALID_SUBSCRIPTION_CHECKOUT_RECONCILIATION_EVIDENCE'
        USING ERRCODE = '22023';
    END IF;
    v_seen_provider_request_ids :=
      array_append(v_seen_provider_request_ids, v_provider_request_id);
  END LOOP;

  SELECT *
    INTO v_attempt
    FROM public.subscription_checkout_attempts
   WHERE attempt_id = p_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_first
    FROM public.subscription_checkout_reconciliation_scans
   WHERE attempt_id = p_attempt_id
     AND scan_ordinal = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_RECONCILIATION_FIRST_SCAN_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.subscription_checkout_reconciliation_scans
   WHERE attempt_id = p_attempt_id
     AND scan_ordinal = 2;
  IF FOUND THEN
    IF v_existing.authorized_user_id
          IS NOT DISTINCT FROM v_attempt.authorized_user_id
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
       AND v_attempt.reconciliation_decision = 'definitive_no_match'
       AND v_attempt.status = 'reconciled_no_match' THEN
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'reconciliation_duplicate',
        'attemptId', v_attempt.attempt_id,
        'status', v_attempt.status,
        'reviewRequired', v_attempt.review_required,
        'reconciliationDecision', v_attempt.reconciliation_decision,
        'firstCheckedAt', v_first.checked_at,
        'checkedAt', v_existing.checked_at,
        'closedAt', v_attempt.reconciliation_closed_at
      );
    END IF;

    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_RECONCILIATION_EVIDENCE_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  IF v_attempt.status NOT IN ('charging', 'provider_unknown') THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_not_allowed',
      'attemptId', v_attempt.attempt_id,
      'status', v_attempt.status
    );
  END IF;
  IF v_attempt.status IS DISTINCT FROM v_expected_status THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_status_mismatch',
      'attemptId', v_attempt.attempt_id,
      'status', v_attempt.status
    );
  END IF;
  IF p_window_start > v_attempt.created_at
     OR p_checked_at <
          GREATEST(v_first.checked_at, v_first.recorded_at) +
            interval '24 hours'
     OR v_now <
          GREATEST(v_first.checked_at, v_first.recorded_at) +
            interval '24 hours' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_second_scan_delay_active',
      'attemptId', v_attempt.attempt_id,
      'status', v_attempt.status,
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
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_RECONCILIATION_SCANS_NOT_INDEPENDENT'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.subscription_checkout_reconciliation_scans (
    attempt_id,
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
    p_attempt_id,
    v_attempt.authorized_user_id,
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

  UPDATE public.subscription_checkout_attempts
     SET status = 'reconciled_no_match',
         provider_error_code = 'reconciled_definitive_no_match',
         failed_at = v_now,
         reconciliation_decision = 'definitive_no_match',
         reconciliation_previous_status = v_expected_status,
         reconciliation_closed_at = v_now,
         review_required = true,
         updated_at = v_now
   WHERE attempt_id = p_attempt_id
     AND status = v_expected_status
     AND reconciliation_decision IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_RECONCILIATION_CAS_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'attempt_reconciled_no_match',
    'attemptId', p_attempt_id,
    'status', 'reconciled_no_match',
    'reviewRequired', true,
    'reconciliationDecision', 'definitive_no_match',
    'firstCheckedAt', v_first.checked_at,
    'checkedAt', p_checked_at,
    'closedAt', v_now
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.consume_subscription_checkout_attempt(
  p_attempt_id uuid,
  p_transaction_id text,
  p_subscription_id text,
  p_customer_id text,
  p_origin text,
  p_transaction_status text,
  p_plan text,
  p_price_id text,
  p_credits integer,
  p_unit_amount integer,
  p_currency_code text,
  p_quantity integer,
  p_completed_at timestamptz,
  p_skip_entitlement_mutation boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_transaction_id text := btrim(COALESCE(p_transaction_id, ''));
  v_subscription_id text := btrim(COALESCE(p_subscription_id, ''));
  v_customer_id text := btrim(COALESCE(p_customer_id, ''));
  v_origin text := lower(btrim(COALESCE(p_origin, '')));
  v_transaction_status text :=
    lower(btrim(COALESCE(p_transaction_status, '')));
  v_plan text := lower(btrim(COALESCE(p_plan, '')));
  v_price_id text := btrim(COALESCE(p_price_id, ''));
  v_currency_code text := upper(btrim(COALESCE(p_currency_code, '')));
  v_attempt_snapshot public.subscription_checkout_attempts%ROWTYPE;
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
  v_state public.paddle_subscription_states%ROWTYPE;
  v_previous_state public.paddle_subscription_states%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_profile_subscription_snapshot text;
  v_current_profile_subscription text;
  v_payment_result jsonb;
  v_late_receipt public.subscription_checkout_late_payment_receipts%ROWTYPE;
  v_review_reason text;
  v_updated integer;
BEGIN
  IF p_attempt_id IS NULL
     OR v_transaction_id IS NULL OR v_transaction_id = ''
     OR length(v_transaction_id) > 255
     OR v_subscription_id IS NULL OR v_subscription_id = ''
     OR length(v_subscription_id) > 255
     OR v_customer_id IS NULL OR v_customer_id = ''
     OR length(v_customer_id) > 255
     OR v_price_id IS NULL OR v_price_id = ''
     OR length(v_price_id) > 255
     OR p_completed_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_SUBSCRIPTION_CHECKOUT_COMPLETION'
      USING ERRCODE = '22023';
  END IF;
  IF v_origin <> 'api' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ORIGIN_REJECTED'
      USING ERRCODE = '22023';
  END IF;
  IF v_transaction_status <> 'completed' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_TRANSACTION_NOT_COMPLETED'
      USING ERRCODE = '22023';
  END IF;
  IF v_plan NOT IN ('pro', 'enterprise')
     OR p_credits IS NULL OR p_credits <= 0
     OR p_unit_amount IS NULL OR p_unit_amount <= 0
     OR v_currency_code <> 'USD'
     OR p_quantity IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;

  -- An attempt ID is the server-minted authorization boundary. No attempt
  -- means no owner resolution and no entitlement.
  SELECT *
    INTO v_attempt_snapshot
    FROM public.subscription_checkout_attempts
   WHERE attempt_id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNBOUND_SUBSCRIPTION_CHECKOUT_TRANSACTION'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_attempt_snapshot.expected_origin <> 'api'
     OR v_attempt_snapshot.target_plan IS DISTINCT FROM v_plan
     OR v_attempt_snapshot.price_id IS DISTINCT FROM v_price_id
     OR v_attempt_snapshot.credits IS DISTINCT FROM p_credits
     OR v_attempt_snapshot.unit_amount IS DISTINCT FROM p_unit_amount
     OR v_attempt_snapshot.currency_code IS DISTINCT FROM v_currency_code THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'subscription_checkout_transaction:' || v_transaction_id,
      0
    )
  );

  -- The attempt is retained as a pseudonymous authorization tombstone after
  -- profile deletion. A signed completion is bound to the attempt and recorded
  -- privately, but no lifecycle/profile/purchase row can be created and no
  -- entitlement can be granted.
  IF v_attempt_snapshot.user_id IS NULL THEN
    SELECT *
      INTO v_attempt
      FROM public.subscription_checkout_attempts
     WHERE attempt_id = p_attempt_id
     FOR UPDATE;
    IF NOT FOUND OR v_attempt.user_id IS NOT NULL THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ACCOUNT_STATE_CHANGED_RETRY'
        USING ERRCODE = '40001';
    END IF;
    IF v_attempt.expected_origin <> 'api'
       OR v_attempt.target_plan IS DISTINCT FROM v_plan
       OR v_attempt.price_id IS DISTINCT FROM v_price_id
       OR v_attempt.credits IS DISTINCT FROM p_credits
       OR v_attempt.unit_amount IS DISTINCT FROM p_unit_amount
       OR v_attempt.currency_code IS DISTINCT FROM v_currency_code THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_CONTRACT_MISMATCH'
        USING ERRCODE = '22023';
    END IF;

    IF v_attempt.status = 'completed' THEN
      IF v_attempt.transaction_id IS DISTINCT FROM v_transaction_id
         OR v_attempt.subscription_id IS DISTINCT FROM v_subscription_id
         OR v_attempt.customer_id IS DISTINCT FROM v_customer_id THEN
        RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_COMPLETION_CONFLICT'
          USING ERRCODE = '23505';
      END IF;
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'completed_before_account_deleted',
        'attemptId', v_attempt.attempt_id,
        'authorizedUserId', v_attempt.authorized_user_id,
        'userId', NULL,
        'status', v_attempt.status,
        'transactionId', v_attempt.transaction_id,
        'subscriptionId', v_attempt.subscription_id,
        'entitlementGranted', false,
        'reviewRequired', false,
        'refundReviewRequired', false,
        'withheldReason', NULL,
        'receiptRecorded', false
      );
    END IF;

    -- A created or pre-provider-expired attempt proves that PromptGen never
    -- began a provider mutation. Do not attach an unrelated signed completion
    -- to that authorization tombstone.
    IF v_attempt.provider_mutation_started_at IS NULL THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_PROVIDER_MUTATION_NOT_STARTED'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_attempt.transaction_id IS NOT NULL
       AND v_attempt.transaction_id IS DISTINCT FROM v_transaction_id THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_TRANSACTION_CONFLICT'
        USING ERRCODE = '23505';
    END IF;

    SELECT *
      INTO v_late_receipt
      FROM public.subscription_checkout_late_payment_receipts
     WHERE transaction_id = v_transaction_id
     FOR UPDATE;
    IF FOUND THEN
      IF v_late_receipt.attempt_id IS DISTINCT FROM p_attempt_id
         OR v_late_receipt.authorized_user_id
              IS DISTINCT FROM v_attempt.authorized_user_id
         OR v_late_receipt.subscription_id
              IS DISTINCT FROM v_subscription_id
         OR v_late_receipt.customer_id IS DISTINCT FROM v_customer_id
         OR v_late_receipt.target_plan IS DISTINCT FROM v_plan
         OR v_late_receipt.price_id IS DISTINCT FROM v_price_id
         OR v_late_receipt.credits IS DISTINCT FROM p_credits
         OR v_late_receipt.unit_amount IS DISTINCT FROM p_unit_amount
         OR v_late_receipt.currency_code IS DISTINCT FROM v_currency_code
         OR v_late_receipt.completed_at IS DISTINCT FROM p_completed_at
         OR v_late_receipt.decision IS DISTINCT FROM 'refund_review'
         OR v_late_receipt.decision_reason NOT IN (
              'late_payment_after_reconciled_no_match',
              'payment_after_account_deleted'
            ) THEN
        RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_COMPLETION_CONFLICT'
          USING ERRCODE = '23505';
      END IF;
      RETURN jsonb_build_object(
        'applied', false,
        'reason', v_late_receipt.decision_reason,
        'attemptId', v_attempt.attempt_id,
        'authorizedUserId', v_attempt.authorized_user_id,
        'userId', NULL,
        'status', CASE
          WHEN v_late_receipt.decision_reason =
                 'late_payment_after_reconciled_no_match'
            THEN 'reconciled_no_match'
          ELSE 'account_deleted_review'
        END,
        'transactionId', v_transaction_id,
        'subscriptionId', v_subscription_id,
        'entitlementGranted', false,
        'reviewRequired', true,
        'refundReviewRequired', true,
        'withheldReason', v_late_receipt.decision_reason,
        'receiptRecorded', false
      );
    END IF;

    PERFORM 1
      FROM public.subscription_checkout_late_payment_receipts
     WHERE attempt_id = p_attempt_id
     FOR UPDATE;
    IF FOUND THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_COMPLETION_CONFLICT'
        USING ERRCODE = '23505';
    END IF;

    v_review_reason := CASE
      WHEN v_attempt.status = 'reconciled_no_match'
        THEN 'late_payment_after_reconciled_no_match'
      ELSE 'payment_after_account_deleted'
    END;

    INSERT INTO public.subscription_checkout_late_payment_receipts (
      transaction_id,
      attempt_id,
      authorized_user_id,
      user_id,
      subscription_id,
      customer_id,
      target_plan,
      price_id,
      credits,
      unit_amount,
      currency_code,
      completed_at,
      decision,
      decision_reason,
      account_deleted
    ) VALUES (
      v_transaction_id,
      p_attempt_id,
      v_attempt.authorized_user_id,
      NULL,
      v_subscription_id,
      v_customer_id,
      v_plan,
      v_price_id,
      p_credits,
      p_unit_amount,
      v_currency_code,
      p_completed_at,
      'refund_review',
      v_review_reason,
      true
    );

    IF v_attempt.status <> 'reconciled_no_match' THEN
      BEGIN
        UPDATE public.subscription_checkout_attempts
           SET transaction_id = v_transaction_id,
               subscription_id = v_subscription_id,
               customer_id = v_customer_id,
               status = 'account_deleted_review',
               provider_error_code = 'payment_after_account_deleted',
               bound_at = COALESCE(bound_at, p_completed_at),
               completed_at = p_completed_at,
               failed_at = NULL,
               review_required = true,
               updated_at = clock_timestamp()
         WHERE attempt_id = p_attempt_id
           AND status IN (
             'charging',
             'bound',
             'provider_unknown',
             'failed'
           );
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_COMPLETION_CONFLICT'
          USING ERRCODE = '23505';
      END;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_COMPLETION_RACE'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'applied', true,
      'reason', v_review_reason,
      'attemptId', p_attempt_id,
      'authorizedUserId', v_attempt.authorized_user_id,
      'userId', NULL,
      'status', CASE
        WHEN v_attempt.status = 'reconciled_no_match'
          THEN 'reconciled_no_match'
        ELSE 'account_deleted_review'
      END,
      'transactionId', v_transaction_id,
      'subscriptionId', v_subscription_id,
      'entitlementGranted', false,
      'reviewRequired', true,
      'refundReviewRequired', true,
      'withheldReason', v_review_reason,
      'receiptRecorded', true
    );
  END IF;

  SELECT NULLIF(btrim(p.paddle_subscription_id), '')
    INTO v_profile_subscription_snapshot
    FROM public.profiles p
   WHERE p.id = v_attempt_snapshot.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Insert the incoming reducer identity, then lock every relevant lifecycle
  -- row in deterministic order before locking the profile and attempt.
  INSERT INTO public.paddle_subscription_states (
    subscription_id,
    user_id,
    customer_id
  ) VALUES (
    v_subscription_id,
    v_attempt_snapshot.user_id,
    v_customer_id
  )
  ON CONFLICT (subscription_id) DO NOTHING;

  PERFORM 1
    FROM public.paddle_subscription_states s
   WHERE s.subscription_id = v_subscription_id
      OR (
        v_profile_subscription_snapshot IS NOT NULL
        AND s.subscription_id = v_profile_subscription_snapshot
      )
   ORDER BY s.subscription_id
   FOR UPDATE;

  SELECT *
    INTO v_state
    FROM public.paddle_subscription_states
   WHERE subscription_id = v_subscription_id;

  IF NOT FOUND
     OR v_state.user_id IS DISTINCT FROM v_attempt_snapshot.user_id
     OR (
       v_state.customer_id IS NOT NULL
       AND v_state.customer_id IS DISTINCT FROM v_customer_id
     ) THEN
    RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_BINDING_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = v_attempt_snapshot.user_id
   FOR UPDATE;

  v_current_profile_subscription :=
    NULLIF(btrim(v_profile.paddle_subscription_id), '');
  IF v_current_profile_subscription
       IS DISTINCT FROM v_profile_subscription_snapshot THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_PROFILE_CHANGED_RETRY'
      USING ERRCODE = '40001';
  END IF;

  SELECT *
    INTO v_attempt
    FROM public.subscription_checkout_attempts
   WHERE attempt_id = p_attempt_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_attempt.user_id IS DISTINCT FROM v_attempt_snapshot.user_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.expected_origin <> 'api'
     OR v_attempt.target_plan IS DISTINCT FROM v_plan
     OR v_attempt.price_id IS DISTINCT FROM v_price_id
     OR v_attempt.credits IS DISTINCT FROM p_credits
     OR v_attempt.unit_amount IS DISTINCT FROM p_unit_amount
     OR v_attempt.currency_code IS DISTINCT FROM v_currency_code THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;

  IF v_attempt.status = 'completed' THEN
    IF v_attempt.transaction_id IS DISTINCT FROM v_transaction_id
       OR v_attempt.subscription_id IS DISTINCT FROM v_subscription_id
       OR v_attempt.customer_id IS DISTINCT FROM v_customer_id THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_COMPLETION_CONFLICT'
        USING ERRCODE = '23505';
    END IF;

    PERFORM 1
      FROM public.purchases
     WHERE transaction_id = v_transaction_id
       AND user_id = v_attempt.user_id
       AND plan = v_attempt.target_plan
       AND credits_granted = v_attempt.credits
       AND subscription_id = v_subscription_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_LEDGER_INVARIANT_FAILED'
        USING ERRCODE = 'P0001';
    END IF;

    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'attemptId', v_attempt.attempt_id,
      'userId', v_attempt.user_id,
      'status', v_attempt.status,
      'transactionId', v_attempt.transaction_id,
      'subscriptionId', v_attempt.subscription_id
    );
  END IF;

  IF v_attempt.status = 'reconciled_no_match' THEN
    SELECT *
      INTO v_late_receipt
      FROM public.subscription_checkout_late_payment_receipts
     WHERE transaction_id = v_transaction_id
     FOR UPDATE;
    IF FOUND THEN
      IF v_late_receipt.attempt_id IS DISTINCT FROM p_attempt_id
         OR v_late_receipt.authorized_user_id
              IS DISTINCT FROM v_attempt.authorized_user_id
         OR v_late_receipt.user_id IS DISTINCT FROM v_attempt.user_id
         OR v_late_receipt.subscription_id
              IS DISTINCT FROM v_subscription_id
         OR v_late_receipt.customer_id IS DISTINCT FROM v_customer_id
         OR v_late_receipt.target_plan IS DISTINCT FROM v_plan
         OR v_late_receipt.price_id IS DISTINCT FROM v_price_id
         OR v_late_receipt.credits IS DISTINCT FROM p_credits
         OR v_late_receipt.unit_amount IS DISTINCT FROM p_unit_amount
         OR v_late_receipt.currency_code IS DISTINCT FROM v_currency_code
         OR v_late_receipt.completed_at IS DISTINCT FROM p_completed_at
         OR v_late_receipt.decision_reason IS DISTINCT FROM
              'late_payment_after_reconciled_no_match'
         OR v_late_receipt.account_deleted IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_COMPLETION_CONFLICT'
          USING ERRCODE = '23505';
      END IF;

      PERFORM 1
        FROM public.purchases
       WHERE transaction_id = v_transaction_id
         AND user_id = v_attempt.user_id
         AND plan = v_attempt.target_plan
         AND credits_granted = v_attempt.credits
         AND subscription_id = v_subscription_id
         AND refund_review_required = true
         AND refund_review_reason =
           'late_payment_after_reconciled_no_match';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_LEDGER_INVARIANT_FAILED'
          USING ERRCODE = 'P0001';
      END IF;

      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'late_payment_after_reconciled_no_match',
        'attemptId', v_attempt.attempt_id,
        'authorizedUserId', v_attempt.authorized_user_id,
        'userId', v_attempt.user_id,
        'status', v_attempt.status,
        'transactionId', v_transaction_id,
        'subscriptionId', v_subscription_id,
        'entitlementGranted', false,
        'reviewRequired', true,
        'refundReviewRequired', true,
        'withheldReason', 'late_payment_after_reconciled_no_match',
        'receiptRecorded', false
      );
    END IF;

    PERFORM 1
      FROM public.subscription_checkout_late_payment_receipts
     WHERE attempt_id = p_attempt_id
     FOR UPDATE;
    IF FOUND THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_COMPLETION_CONFLICT'
        USING ERRCODE = '23505';
    END IF;

    v_payment_result := public.apply_ordered_subscription_payment(
      v_transaction_id,
      v_attempt.user_id,
      v_attempt.target_plan,
      v_attempt.credits,
      v_subscription_id,
      v_customer_id,
      p_completed_at,
      true,
      false
    );

    UPDATE public.purchases
       SET subscription_id = COALESCE(subscription_id, v_subscription_id),
           refund_review_required = true,
           refund_review_reason =
             'late_payment_after_reconciled_no_match'
     WHERE transaction_id = v_transaction_id
       AND user_id = v_attempt.user_id
       AND plan = v_attempt.target_plan
       AND credits_granted = v_attempt.credits
       AND (
         subscription_id IS NULL
         OR subscription_id = v_subscription_id
       );
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_LEDGER_BINDING_CONFLICT'
        USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.subscription_checkout_late_payment_receipts (
      transaction_id,
      attempt_id,
      authorized_user_id,
      user_id,
      subscription_id,
      customer_id,
      target_plan,
      price_id,
      credits,
      unit_amount,
      currency_code,
      completed_at,
      decision,
      decision_reason,
      account_deleted
    ) VALUES (
      v_transaction_id,
      p_attempt_id,
      v_attempt.authorized_user_id,
      v_attempt.user_id,
      v_subscription_id,
      v_customer_id,
      v_plan,
      v_price_id,
      p_credits,
      p_unit_amount,
      v_currency_code,
      p_completed_at,
      'refund_review',
      'late_payment_after_reconciled_no_match',
      false
    );

    RETURN v_payment_result || jsonb_build_object(
      'applied', true,
      'reason', 'late_payment_after_reconciled_no_match',
      'attemptId', v_attempt.attempt_id,
      'authorizedUserId', v_attempt.authorized_user_id,
      'userId', v_attempt.user_id,
      'status', v_attempt.status,
      'transactionId', v_transaction_id,
      'subscriptionId', v_subscription_id,
      'entitlementGranted', false,
      'reviewRequired', true,
      'refundReviewRequired', true,
      'withheldReason', 'late_payment_after_reconciled_no_match',
      'receiptRecorded', true
    );
  END IF;

  IF v_attempt.status IN ('failed', 'account_deleted_review') THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_TERMINAL'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.status = 'created' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_PROVIDER_MUTATION_NOT_STARTED'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt.transaction_id IS NOT NULL
     AND v_attempt.transaction_id IS DISTINCT FROM v_transaction_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_TRANSACTION_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  IF v_current_profile_subscription IS NOT NULL
     AND v_current_profile_subscription <> v_subscription_id THEN
    SELECT *
      INTO v_previous_state
      FROM public.paddle_subscription_states
     WHERE subscription_id = v_current_profile_subscription;

    IF NOT FOUND
       OR v_previous_state.user_id IS DISTINCT FROM v_attempt.user_id
       OR NOT v_previous_state.terminal THEN
      RAISE EXCEPTION 'ACTIVE_SUBSCRIPTION_ALREADY_EXISTS'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF (
    v_current_profile_subscription IS NULL
    OR v_current_profile_subscription <> v_subscription_id
  )
  AND lower(COALESCE(v_profile.plan, 'free'))
        IN ('pro', 'enterprise', 'paid') THEN
    RAISE EXCEPTION 'SUBSCRIPTION_PROFILE_RECONCILIATION_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  IF NULLIF(btrim(v_profile.paddle_customer_id), '') IS NOT NULL
     AND NULLIF(btrim(v_profile.paddle_customer_id), '')
           IS DISTINCT FROM v_customer_id THEN
    RAISE EXCEPTION 'PADDLE_CUSTOMER_USER_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  v_payment_result := public.apply_ordered_subscription_payment(
    v_transaction_id,
    v_attempt.user_id,
    v_attempt.target_plan,
    v_attempt.credits,
    v_subscription_id,
    v_customer_id,
    p_completed_at,
    COALESCE(p_skip_entitlement_mutation, false),
    true
  );

  UPDATE public.purchases
     SET subscription_id = COALESCE(subscription_id, v_subscription_id)
   WHERE transaction_id = v_transaction_id
     AND user_id = v_attempt.user_id
     AND plan = v_attempt.target_plan
     AND credits_granted = v_attempt.credits
     AND (
       subscription_id IS NULL
       OR subscription_id = v_subscription_id
     );
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_LEDGER_BINDING_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  UPDATE public.profiles
     SET paddle_customer_id = v_customer_id,
         paddle_subscription_id = v_subscription_id
   WHERE id = v_attempt.user_id;

  BEGIN
    UPDATE public.subscription_checkout_attempts
       SET transaction_id = v_transaction_id,
           subscription_id = v_subscription_id,
           customer_id = v_customer_id,
           status = 'completed',
           provider_error_code = NULL,
           bound_at = COALESCE(bound_at, p_completed_at),
           completed_at = p_completed_at,
           failed_at = NULL,
           updated_at = clock_timestamp()
     WHERE attempt_id = p_attempt_id
       AND status IN ('charging', 'bound', 'provider_unknown');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_COMPLETION_CONFLICT'
      USING ERRCODE = '23505';
  END;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_COMPLETION_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_payment_result || jsonb_build_object(
    'attemptId', p_attempt_id,
    'userId', v_attempt.user_id,
    'status', 'completed',
    'transactionId', v_transaction_id,
    'subscriptionId', v_subscription_id,
    'customerId', v_customer_id,
    'targetPlan', v_attempt.target_plan
  );
END;
$function$;

-- Resolve subscription.updated / subscription.canceled metadata only after the
-- API transaction has passed consume_subscription_checkout_attempt. An early
-- snapshot is retried by the durable webhook inbox; it cannot grant first.
CREATE OR REPLACE FUNCTION public.resolve_completed_subscription_checkout(
  p_attempt_id uuid,
  p_subscription_id text,
  p_customer_id text,
  p_plan text,
  p_price_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_subscription_id text := btrim(COALESCE(p_subscription_id, ''));
  v_customer_id text := btrim(COALESCE(p_customer_id, ''));
  v_plan text := lower(btrim(COALESCE(p_plan, '')));
  v_price_id text := btrim(COALESCE(p_price_id, ''));
  v_attempt_snapshot public.subscription_checkout_attempts%ROWTYPE;
  v_attempt public.subscription_checkout_attempts%ROWTYPE;
  v_state public.paddle_subscription_states%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF p_attempt_id IS NULL
     OR v_subscription_id IS NULL OR v_subscription_id = ''
     OR length(v_subscription_id) > 255
     OR v_customer_id IS NULL OR v_customer_id = ''
     OR length(v_customer_id) > 255
     OR v_plan NOT IN ('pro', 'enterprise')
     OR v_price_id IS NULL OR v_price_id = ''
     OR length(v_price_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_SUBSCRIPTION_CHECKOUT_RESOLUTION'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_attempt_snapshot
    FROM public.subscription_checkout_attempts
   WHERE attempt_id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_attempt_snapshot.status <> 'completed' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_NOT_COMPLETED'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_state
    FROM public.paddle_subscription_states
   WHERE subscription_id = v_subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUBSCRIPTION_STATE_RECONCILIATION_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = v_attempt_snapshot.user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_attempt
    FROM public.subscription_checkout_attempts
   WHERE attempt_id = p_attempt_id
   FOR UPDATE;

  IF v_attempt.status <> 'completed'
     OR v_attempt.subscription_id IS DISTINCT FROM v_subscription_id
     OR v_attempt.customer_id IS DISTINCT FROM v_customer_id
     OR v_attempt.target_plan IS DISTINCT FROM v_plan
     OR v_attempt.price_id IS DISTINCT FROM v_price_id
     OR v_attempt.expected_origin <> 'api'
     OR v_state.user_id IS DISTINCT FROM v_attempt.user_id
     OR (
       v_state.customer_id IS NOT NULL
       AND v_state.customer_id IS DISTINCT FROM v_customer_id
     )
     OR NULLIF(btrim(v_profile.paddle_subscription_id), '')
          IS DISTINCT FROM v_subscription_id
     OR NULLIF(btrim(v_profile.paddle_customer_id), '')
          IS DISTINCT FROM v_customer_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_RESOLUTION_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  RETURN jsonb_build_object(
    'resolved', true,
    'attemptId', v_attempt.attempt_id,
    'userId', v_attempt.user_id,
    'transactionId', v_attempt.transaction_id,
    'subscriptionId', v_attempt.subscription_id,
    'customerId', v_attempt.customer_id,
    'targetPlan', v_attempt.target_plan,
    'priceId', v_attempt.price_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_subscription_checkout_attempt(
  uuid, uuid, text, text, integer, integer, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bind_subscription_checkout_transaction(
  uuid, uuid, text, text, text, text, integer, integer, text, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.transition_subscription_checkout_attempt(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_subscription_checkout_no_match_scan(
  uuid, text, timestamptz, timestamptz, timestamptz,
  integer, integer, text[], text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_subscription_checkout_no_match(
  uuid, text, timestamptz, timestamptz, timestamptz,
  integer, integer, text[], text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.consume_subscription_checkout_attempt(
  uuid, text, text, text, text, text, text, text,
  integer, integer, text, integer, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_completed_subscription_checkout(
  uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.create_subscription_checkout_attempt(
  uuid, uuid, text, text, integer, integer, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_subscription_checkout_transaction(
  uuid, uuid, text, text, text, text, integer, integer, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_subscription_checkout_attempt(
  uuid, uuid, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_subscription_checkout_no_match_scan(
  uuid, text, timestamptz, timestamptz, timestamptz,
  integer, integer, text[], text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_subscription_checkout_no_match(
  uuid, text, timestamptz, timestamptz, timestamptz,
  integer, integer, text[], text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_subscription_checkout_attempt(
  uuid, text, text, text, text, text, text, text,
  integer, integer, text, integer, timestamptz, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_completed_subscription_checkout(
  uuid, text, text, text, text
) TO service_role;

COMMIT;

-- Reverse migration (operator-run only):
--   1. Disable subscription checkout and webhook intake.
--   2. Reconcile every created/charging/bound/provider_unknown attempt in Paddle.
--   3. Deploy code that no longer calls these RPCs.
--   4. Preserve/export completed rows for the payment audit trail.
--
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.resolve_completed_subscription_checkout(
--   uuid, text, text, text, text
-- ) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.consume_subscription_checkout_attempt(
--   uuid, text, text, text, text, text, text, text,
--   integer, integer, text, integer, timestamptz, boolean
-- ) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.transition_subscription_checkout_attempt(
--   uuid, uuid, text, text
-- ) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.finalize_subscription_checkout_no_match(
--   uuid, text, timestamptz, timestamptz, timestamptz,
--   integer, integer, text[], text, text, text, text
-- ) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.record_subscription_checkout_no_match_scan(
--   uuid, text, timestamptz, timestamptz, timestamptz,
--   integer, integer, text[], text, text, text, text
-- ) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.bind_subscription_checkout_transaction(
--   uuid, uuid, text, text, text, text, integer, integer, text, integer
-- ) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.create_subscription_checkout_attempt(
--   uuid, uuid, text, text, integer, integer, text
-- ) FROM service_role;
-- DROP FUNCTION public.resolve_completed_subscription_checkout(
--   uuid, text, text, text, text
-- );
-- DROP FUNCTION public.consume_subscription_checkout_attempt(
--   uuid, text, text, text, text, text, text, text,
--   integer, integer, text, integer, timestamptz, boolean
-- );
-- DROP FUNCTION public.transition_subscription_checkout_attempt(
--   uuid, uuid, text, text
-- );
-- DROP FUNCTION public.finalize_subscription_checkout_no_match(
--   uuid, text, timestamptz, timestamptz, timestamptz,
--   integer, integer, text[], text, text, text, text
-- );
-- DROP FUNCTION public.record_subscription_checkout_no_match_scan(
--   uuid, text, timestamptz, timestamptz, timestamptz,
--   integer, integer, text[], text, text, text, text
-- );
-- DROP FUNCTION public.bind_subscription_checkout_transaction(
--   uuid, uuid, text, text, text, text, integer, integer, text, integer
-- );
-- DROP FUNCTION public.create_subscription_checkout_attempt(
--   uuid, uuid, text, text, integer, integer, text
-- );
-- DROP TABLE public.subscription_checkout_late_payment_receipts;
-- DROP FUNCTION public.guard_subscription_checkout_late_receipt_mutation();
-- DROP TABLE public.subscription_checkout_reconciliation_scans;
-- DROP TABLE public.subscription_checkout_attempts;
-- COMMIT;
