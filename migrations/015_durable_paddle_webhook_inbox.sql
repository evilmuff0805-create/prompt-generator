-- ============================================================
-- Migration 015: durable Paddle webhook inbox + atomic payment mutations
--
-- Safe rollout order:
--   1. Apply this backward-compatible migration.
--   2. Deploy the server release that uses the RPCs below.
--
-- Compatibility note:
--   status defaults to completed and processed_at keeps its legacy now() default.
--   Therefore the previous server can continue inserting event_id-only rows while
--   the new server is rolling out. The new server explicitly inserts processing
--   rows with processed_at = NULL through claim_paddle_webhook_event().
--
-- Historical backfill:
--   Legacy rows cannot distinguish receipt from business completion. They are
--   conservatively preserved as completed so historical payments are never replayed
--   automatically. Their received_at value is copied from processed_at.
-- ============================================================

BEGIN;

ALTER TABLE public.webhook_events
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.webhook_events
   SET received_at = COALESCE(received_at, processed_at, clock_timestamp()),
       status = 'completed',
       attempt_count = GREATEST(attempt_count, 1),
       updated_at = COALESCE(processed_at, updated_at, clock_timestamp())
 WHERE received_at IS NULL;

ALTER TABLE public.webhook_events
  ALTER COLUMN received_at SET DEFAULT now(),
  ALTER COLUMN received_at SET NOT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.webhook_events'::regclass
       AND conname = 'webhook_events_status_check'
  ) THEN
    ALTER TABLE public.webhook_events
      ADD CONSTRAINT webhook_events_status_check
      CHECK (status IN ('processing', 'completed', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.webhook_events'::regclass
       AND conname = 'webhook_events_attempt_count_check'
  ) THEN
    ALTER TABLE public.webhook_events
      ADD CONSTRAINT webhook_events_attempt_count_check
      CHECK (attempt_count >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.webhook_events'::regclass
       AND conname = 'webhook_events_state_check'
  ) THEN
    ALTER TABLE public.webhook_events
      ADD CONSTRAINT webhook_events_state_check
      CHECK (
        (
          status = 'completed'
          AND processed_at IS NOT NULL
          AND claim_token IS NULL
          AND claimed_at IS NULL
          AND lease_expires_at IS NULL
        )
        OR
        (
          status = 'processing'
          AND processed_at IS NULL
          AND claim_token IS NOT NULL
          AND claimed_at IS NOT NULL
          AND lease_expires_at IS NOT NULL
        )
        OR
        (
          status = 'failed'
          AND processed_at IS NULL
          AND claim_token IS NULL
          AND claimed_at IS NULL
          AND lease_expires_at IS NULL
        )
      );
  END IF;
END;
$constraints$;

CREATE INDEX IF NOT EXISTS idx_webhook_events_processing_lease
  ON public.webhook_events (lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_webhook_events_failed_updated
  ON public.webhook_events (updated_at)
  WHERE status = 'failed';

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.webhook_events TO service_role;

-- Atomically receive or reclaim a Paddle notification. Only failed events and
-- expired leases may be reclaimed. Completed events are never replayed.
CREATE OR REPLACE FUNCTION public.claim_paddle_webhook_event(
  p_event_id text,
  p_claim_token uuid,
  p_lease_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_status text;
  v_attempt_count integer;
  v_lease_expires_at timestamptz;
BEGIN
  IF p_event_id IS NULL OR btrim(p_event_id) = '' OR length(p_event_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_WEBHOOK_EVENT_ID' USING ERRCODE = '22023';
  END IF;
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'INVALID_WEBHOOK_CLAIM_TOKEN' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'INVALID_WEBHOOK_LEASE_SECONDS' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.webhook_events AS inbox (
    event_id,
    received_at,
    processed_at,
    status,
    attempt_count,
    claimed_at,
    lease_expires_at,
    claim_token,
    last_error,
    updated_at
  )
  VALUES (
    p_event_id,
    v_now,
    NULL,
    'processing',
    1,
    v_now,
    v_now + make_interval(secs => p_lease_seconds),
    p_claim_token,
    NULL,
    v_now
  )
  ON CONFLICT (event_id) DO UPDATE
     SET status = 'processing',
         processed_at = NULL,
         attempt_count = inbox.attempt_count + 1,
         claimed_at = v_now,
         lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
         claim_token = p_claim_token,
         last_error = NULL,
         updated_at = v_now
   WHERE inbox.status = 'failed'
      OR (
        inbox.status = 'processing'
        AND inbox.lease_expires_at <= v_now
      )
  RETURNING inbox.status, inbox.attempt_count, inbox.lease_expires_at
       INTO v_status, v_attempt_count, v_lease_expires_at;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'outcome', 'claimed',
      'attemptCount', v_attempt_count,
      'leaseExpiresAt', v_lease_expires_at
    );
  END IF;

  SELECT status, attempt_count, lease_expires_at
    INTO v_status, v_attempt_count, v_lease_expires_at
    FROM public.webhook_events
   WHERE event_id = p_event_id;

  IF v_status = 'completed' THEN
    RETURN jsonb_build_object(
      'outcome', 'completed',
      'attemptCount', v_attempt_count
    );
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'busy',
    'attemptCount', v_attempt_count,
    'leaseExpiresAt', v_lease_expires_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_paddle_webhook_event(
  p_event_id text,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  UPDATE public.webhook_events
     SET status = 'completed',
         processed_at = clock_timestamp(),
         claimed_at = NULL,
         lease_expires_at = NULL,
         claim_token = NULL,
         last_error = NULL,
         updated_at = clock_timestamp()
   WHERE event_id = p_event_id
     AND status = 'processing'
     AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fail_paddle_webhook_event(
  p_event_id text,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  UPDATE public.webhook_events
     SET status = 'failed',
         processed_at = NULL,
         claimed_at = NULL,
         lease_expires_at = NULL,
         claim_token = NULL,
         last_error = left(
           regexp_replace(COALESCE(p_error, 'Unknown webhook error'), E'[\\r\\n\\t]+', ' ', 'g'),
           1000
         ),
         updated_at = clock_timestamp()
   WHERE event_id = p_event_id
     AND status = 'processing'
     AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$function$;

-- Insert the purchase ledger row and reset the subscription credits in one
-- transaction. A duplicate transaction_id never mutates the profile again.
CREATE OR REPLACE FUNCTION public.apply_subscription_payment(
  p_transaction_id text,
  p_user_id uuid,
  p_plan text,
  p_amount integer,
  p_skip_credit_mutation boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_purchase_id bigint;
  v_existing_user_id uuid;
  v_existing_plan text;
  v_existing_amount integer;
  v_existing_type text;
  v_new_balance integer;
BEGIN
  IF p_transaction_id IS NULL OR btrim(p_transaction_id) = '' OR length(p_transaction_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_USER_ID' USING ERRCODE = '22023';
  END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('pro', 'enterprise') THEN
    RAISE EXCEPTION 'INVALID_PLAN' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.purchases (
    transaction_id,
    user_id,
    plan,
    credits_granted,
    status,
    transaction_type
  )
  VALUES (
    p_transaction_id,
    p_user_id,
    p_plan,
    p_amount,
    'completed',
    'subscription_payment'
  )
  ON CONFLICT (transaction_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    SELECT user_id, plan, credits_granted, transaction_type
      INTO v_existing_user_id, v_existing_plan, v_existing_amount, v_existing_type
      FROM public.purchases
     WHERE transaction_id = p_transaction_id;

    IF v_existing_user_id IS DISTINCT FROM p_user_id
       OR v_existing_plan IS DISTINCT FROM p_plan
       OR v_existing_amount IS DISTINCT FROM p_amount
       OR (
         v_existing_type IS NOT NULL
         AND v_existing_type <> 'subscription_payment'
       ) THEN
      RAISE EXCEPTION 'TRANSACTION_ID_CONFLICT' USING ERRCODE = '23505';
    END IF;

    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate'
    );
  END IF;

  IF COALESCE(p_skip_credit_mutation, false) THEN
    RETURN jsonb_build_object(
      'applied', true,
      'reason', 'credit_mutation_skipped'
    );
  END IF;

  UPDATE public.profiles
     SET plan = p_plan,
         credits = p_amount
   WHERE id = p_user_id
  RETURNING credits INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'payment_applied',
    'newBalance', v_new_balance
  );
END;
$function$;

-- Refund status and the corresponding plan/credit mutation commit together.
-- For plan upgrades, previous plan/allotment is derived by the server from the
-- immutable purchase history and revalidated here while the purchase/profile
-- rows are locked.
CREATE OR REPLACE FUNCTION public.apply_purchase_refund(
  p_transaction_id text,
  p_previous_plan text DEFAULT NULL,
  p_previous_allotment integer DEFAULT NULL,
  p_skip_credit_mutation boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_purchase public.purchases%ROWTYPE;
  v_current_plan text;
  v_current_credits integer;
  v_new_balance integer;
BEGIN
  IF p_transaction_id IS NULL OR btrim(p_transaction_id) = '' OR length(p_transaction_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_purchase
    FROM public.purchases
   WHERE transaction_id = p_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_purchase.status = 'refunded' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'userId', v_purchase.user_id
    );
  END IF;

  IF COALESCE(p_skip_credit_mutation, false) THEN
    UPDATE public.purchases
       SET status = 'refunded'
     WHERE id = v_purchase.id;

    RETURN jsonb_build_object(
      'applied', true,
      'reason', 'credit_mutation_skipped',
      'userId', v_purchase.user_id
    );
  END IF;

  SELECT plan, credits
    INTO v_current_plan, v_current_credits
    FROM public.profiles
   WHERE id = v_purchase.user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_purchase.transaction_type = 'plan_upgrade' THEN
    IF p_previous_plan IS NULL OR p_previous_plan NOT IN ('free', 'pro', 'enterprise') THEN
      RAISE EXCEPTION 'INVALID_PREVIOUS_PLAN' USING ERRCODE = '22023';
    END IF;
    IF p_previous_allotment IS NULL OR p_previous_allotment < 0 THEN
      RAISE EXCEPTION 'INVALID_PREVIOUS_ALLOTMENT' USING ERRCODE = '22023';
    END IF;

    IF v_current_plan = 'free' THEN
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'account_free',
        'userId', v_purchase.user_id,
        'newBalance', v_current_credits
      );
    END IF;

    IF v_current_credits < v_purchase.credits_granted THEN
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'credits_used',
        'userId', v_purchase.user_id,
        'newBalance', v_current_credits
      );
    END IF;

    UPDATE public.profiles
       SET plan = p_previous_plan,
           credits = p_previous_allotment
     WHERE id = v_purchase.user_id
    RETURNING credits INTO v_new_balance;

    UPDATE public.purchases
       SET status = 'refunded'
     WHERE id = v_purchase.id;

    RETURN jsonb_build_object(
      'applied', true,
      'reason', 'plan_restored',
      'userId', v_purchase.user_id,
      'newBalance', v_new_balance
    );
  END IF;

  UPDATE public.profiles
     SET plan = 'free',
         credits = GREATEST(0, credits - v_purchase.credits_granted)
   WHERE id = v_purchase.user_id
  RETURNING credits INTO v_new_balance;

  UPDATE public.purchases
     SET status = 'refunded'
   WHERE id = v_purchase.id;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'credits_revoked',
    'userId', v_purchase.user_id,
    'newBalance', v_new_balance
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_paddle_webhook_event(text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_paddle_webhook_event(text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_paddle_webhook_event(text, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_subscription_payment(text, uuid, text, integer, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_purchase_refund(text, text, integer, boolean)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_paddle_webhook_event(text, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_paddle_webhook_event(text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_paddle_webhook_event(text, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_subscription_payment(text, uuid, text, integer, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_purchase_refund(text, text, integer, boolean)
  TO service_role;

COMMIT;

-- Rollback policy (application-first, never while claims are in flight):
--   1. Deploy the previous server. It remains compatible with this schema.
--   2. Confirm status='processing' count is zero and preserve failed rows for audit.
--   3. Prefer leaving the additive columns/functions in place. If removal is
--      required, drop the five functions first, then the two partial indexes,
--      constraints, and additive columns. Never rewrite or delete event_id rows.
