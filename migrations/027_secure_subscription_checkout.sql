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
  user_id              UUID NOT NULL
                       REFERENCES public.profiles(id) ON DELETE CASCADE,
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
                           'bound',
                           'provider_unknown',
                           'completed',
                           'failed'
                         )
                       ),
  provider_error_code  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  bound_at             TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  failed_at            TIMESTAMPTZ,
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
      )
      OR
      (
        status = 'provider_unknown'
        AND transaction_id IS NULL
        AND subscription_id IS NULL
        AND customer_id IS NULL
        AND bound_at IS NULL
        AND completed_at IS NULL
        AND failed_at IS NULL
      )
      OR
      (
        status = 'bound'
        AND transaction_id IS NOT NULL
        AND subscription_id IS NULL
        AND customer_id IS NULL
        AND bound_at IS NOT NULL
        AND completed_at IS NULL
        AND failed_at IS NULL
      )
      OR
      (
        status = 'completed'
        AND transaction_id IS NOT NULL
        AND subscription_id IS NOT NULL
        AND customer_id IS NOT NULL
        AND bound_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND failed_at IS NULL
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
      )
    )
);

-- A provider_unknown attempt may already have created a transaction even
-- though PromptGen never received the response. It remains open and is
-- reconciled; it is never automatically retried.
CREATE UNIQUE INDEX subscription_checkout_attempts_one_open_per_user_idx
  ON public.subscription_checkout_attempts (user_id)
  WHERE status IN ('created', 'bound', 'provider_unknown');

CREATE INDEX subscription_checkout_attempts_user_created_idx
  ON public.subscription_checkout_attempts (user_id, created_at DESC);

ALTER TABLE public.subscription_checkout_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_checkout_attempts
  FROM PUBLIC, anon, authenticated, service_role;
-- Application reads are direct so webhook reconciliation can locate the
-- immutable attempt. Every write must pass through the SECURITY DEFINER RPCs
-- below, which enforce lock order, state transitions, and contract checks.
GRANT SELECT
  ON TABLE public.subscription_checkout_attempts TO service_role;

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
   WHERE user_id = p_user_id
     AND status IN ('created', 'bound', 'provider_unknown')
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

  BEGIN
    INSERT INTO public.subscription_checkout_attempts (
      attempt_id,
      user_id,
      target_plan,
      price_id,
      credits,
      unit_amount,
      currency_code
    ) VALUES (
      p_attempt_id,
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
     WHERE user_id = p_user_id
       AND status IN ('created', 'bound', 'provider_unknown')
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
  IF v_attempt.status = 'failed' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_TERMINAL'
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
       AND status IN ('created', 'provider_unknown');
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
     OR v_status NOT IN ('provider_unknown', 'failed')
     OR (
       p_provider_error_code IS NOT NULL
       AND length(p_provider_error_code) > 255
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
  IF v_attempt.status IN ('bound', 'completed') THEN
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

  UPDATE public.subscription_checkout_attempts
     SET status = v_status,
         provider_error_code = NULLIF(btrim(p_provider_error_code), ''),
         failed_at = CASE
           WHEN v_status = 'failed' THEN clock_timestamp()
           ELSE NULL
         END,
         updated_at = clock_timestamp()
   WHERE attempt_id = p_attempt_id
     AND status = 'created';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_TRANSITION_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'attempt_transitioned',
    'attemptId', p_attempt_id,
    'status', v_status
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

  IF v_attempt.status = 'failed' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CHECKOUT_ATTEMPT_TERMINAL'
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
       AND status IN ('created', 'bound', 'provider_unknown');
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
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_subscription_checkout_transaction(
  uuid, uuid, text, text, text, text, integer, integer, text, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_subscription_checkout_attempt(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_subscription_checkout_attempt(
  uuid, text, text, text, text, text, text, text,
  integer, integer, text, integer, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_completed_subscription_checkout(
  uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_subscription_checkout_attempt(
  uuid, uuid, text, text, integer, integer, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_subscription_checkout_transaction(
  uuid, uuid, text, text, text, text, integer, integer, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_subscription_checkout_attempt(
  uuid, uuid, text, text
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
--   2. Reconcile every created/bound/provider_unknown attempt in Paddle.
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
-- DROP FUNCTION public.bind_subscription_checkout_transaction(
--   uuid, uuid, text, text, text, text, integer, integer, text, integer
-- );
-- DROP FUNCTION public.create_subscription_checkout_attempt(
--   uuid, uuid, text, text, integer, integer, text
-- );
-- DROP TABLE public.subscription_checkout_attempts;
-- COMMIT;
