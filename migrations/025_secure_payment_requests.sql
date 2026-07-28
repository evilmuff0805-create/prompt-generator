-- ============================================================
-- Migration 025: server-bound subscription and add-on payments
--
-- Apply after 023_credit_lot_ledger.sql and
-- 024_paddle_event_ordering.sql. Money feature flags must remain false
-- until the cloned-schema race suite and Paddle Sandbox purchase/refund
-- matrix pass.
-- ============================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure(
    'public.apply_credit_pack_purchase(text,uuid,text,text,text,integer,integer,text,text,integer,timestamp with time zone)'
  ) IS NULL THEN
    RAISE EXCEPTION 'SECURE_PAYMENT_REQUESTS_REQUIRES_MIGRATION_023';
  END IF;
  IF to_regprocedure(
    'public.apply_ordered_subscription_payment(text,uuid,text,integer,text,text,timestamptz,boolean,boolean)'
  ) IS NULL THEN
    RAISE EXCEPTION 'SECURE_PAYMENT_REQUESTS_REQUIRES_MIGRATION_024';
  END IF;
END;
$preflight$;

CREATE TABLE public.credit_pack_purchase_requests (
  request_id             UUID PRIMARY KEY,
  transaction_id         TEXT UNIQUE,
  user_id                UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id            TEXT NOT NULL CHECK (btrim(customer_id) <> ''),
  subscription_id        TEXT NOT NULL CHECK (btrim(subscription_id) <> ''),
  pack_key               TEXT NOT NULL
                         CHECK (pack_key IN ('usage_600', 'usage_1500', 'usage_3000')),
  credits                INTEGER NOT NULL CHECK (credits > 0),
  unit_amount            INTEGER NOT NULL CHECK (unit_amount > 0),
  currency_code          TEXT NOT NULL CHECK (currency_code = 'USD'),
  expiry_days            INTEGER NOT NULL CHECK (expiry_days = 365),
  provider_price_id      TEXT,
  provider_product_id    TEXT,
  status                 TEXT NOT NULL DEFAULT 'created'
                         CHECK (
                           status IN (
                             'created',
                             'submitted',
                             'provider_unknown',
                             'completed',
                             'failed'
                           )
                         ),
  provider_error_code    TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  submitted_at           TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  CONSTRAINT credit_pack_purchase_requests_transaction_id_check
    CHECK (
      transaction_id IS NULL
      OR (btrim(transaction_id) <> '' AND length(transaction_id) <= 255)
    ),
  CONSTRAINT credit_pack_purchase_requests_customer_id_check
    CHECK (length(customer_id) <= 255),
  CONSTRAINT credit_pack_purchase_requests_subscription_id_check
    CHECK (length(subscription_id) <= 255),
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
  CONSTRAINT credit_pack_purchase_requests_status_fields_check
    CHECK (
      (status = 'completed'
        AND transaction_id IS NOT NULL
        AND provider_price_id IS NOT NULL
        AND provider_product_id IS NOT NULL
        AND completed_at IS NOT NULL)
      OR
      (status <> 'completed' AND completed_at IS NULL)
    )
);

-- One unresolved provider mutation per account. This is the durable reload and
-- double-click guard; a provider_unknown request is reconciled, never retried.
CREATE UNIQUE INDEX credit_pack_purchase_requests_one_open_per_user_idx
  ON public.credit_pack_purchase_requests (user_id)
  WHERE status IN ('created', 'submitted', 'provider_unknown');

CREATE INDEX credit_pack_purchase_requests_subscription_created_idx
  ON public.credit_pack_purchase_requests (subscription_id, created_at DESC);

ALTER TABLE public.credit_pack_purchase_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.credit_pack_purchase_requests
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.credit_pack_purchase_requests TO service_role;

CREATE OR REPLACE FUNCTION public.create_credit_pack_purchase_request(
  p_request_id uuid,
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_pack_key text,
  p_credits integer,
  p_unit_amount integer,
  p_currency_code text,
  p_expiry_days integer
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
BEGIN
  IF p_request_id IS NULL OR p_user_id IS NULL
     OR p_customer_id IS NULL OR btrim(p_customer_id) = ''
     OR p_subscription_id IS NULL OR btrim(p_subscription_id) = ''
     OR length(p_customer_id) > 255
     OR length(p_subscription_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_PURCHASE_REQUEST'
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(p_currency_code, '')) <> 'USD'
     OR p_expiry_days IS DISTINCT FROM 365 THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_CONTRACT_MISMATCH'
      USING ERRCODE = '22023';
  END IF;
  IF NOT (
    (p_pack_key = 'usage_600'  AND p_credits = 600  AND p_unit_amount = 1000)
    OR
    (p_pack_key = 'usage_1500' AND p_credits = 1500 AND p_unit_amount = 2000)
    OR
    (p_pack_key = 'usage_3000' AND p_credits = 3000 AND p_unit_amount = 4000)
  ) THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_CONTRACT_MISMATCH'
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
     OR v_state.lifecycle_status <> 'active' THEN
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

  SELECT *
    INTO v_existing
    FROM public.credit_pack_purchase_requests
   WHERE user_id = p_user_id
     AND status IN ('created', 'submitted', 'provider_unknown')
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate_pending',
      'requestId', v_existing.request_id,
      'status', v_existing.status,
      'packKey', v_existing.pack_key,
      'credits', v_existing.credits,
      'unitAmount', v_existing.unit_amount
    );
  END IF;

  BEGIN
    INSERT INTO public.credit_pack_purchase_requests (
      request_id,
      user_id,
      customer_id,
      subscription_id,
      pack_key,
      credits,
      unit_amount,
      currency_code,
      expiry_days
    ) VALUES (
      p_request_id,
      p_user_id,
      p_customer_id,
      p_subscription_id,
      p_pack_key,
      p_credits,
      p_unit_amount,
      upper(p_currency_code),
      p_expiry_days
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT *
      INTO v_existing
      FROM public.credit_pack_purchase_requests
     WHERE user_id = p_user_id
       AND status IN ('created', 'submitted', 'provider_unknown')
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE;
    END IF;
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate_pending',
      'requestId', v_existing.request_id,
      'status', v_existing.status,
      'packKey', v_existing.pack_key,
      'credits', v_existing.credits,
      'unitAmount', v_existing.unit_amount
    );
  END;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'purchase_request_created',
    'requestId', p_request_id,
    'status', 'created',
    'packKey', p_pack_key,
    'credits', p_credits,
    'unitAmount', p_unit_amount
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
  IF p_request_id IS NULL OR p_user_id IS NULL
     OR v_status NOT IN ('submitted', 'provider_unknown', 'failed')
     OR (
       p_provider_error_code IS NOT NULL
       AND length(p_provider_error_code) > 255
     ) THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_REQUEST_TRANSITION'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_request
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF NOT FOUND OR v_request.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status = 'completed' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'already_completed',
      'status', v_request.status
    );
  END IF;
  IF v_request.status = 'failed' THEN
    IF v_status = 'failed' THEN
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'duplicate',
        'status', v_request.status
      );
    END IF;
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_TERMINAL'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status = 'provider_unknown' AND v_status <> 'provider_unknown' THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_RECONCILIATION_REQUIRED'
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
  p_expiry_days integer,
  p_purchased_at timestamptz
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
  v_result jsonb;
BEGIN
  IF p_request_id IS NULL
     OR p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
     OR p_customer_id IS NULL OR btrim(p_customer_id) = ''
     OR p_subscription_id IS NULL OR btrim(p_subscription_id) = ''
     OR p_provider_price_id IS NULL OR btrim(p_provider_price_id) = ''
     OR p_provider_product_id IS NULL OR btrim(p_provider_product_id) = ''
     OR p_purchased_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_SUBSCRIPTION_CHARGE'
      USING ERRCODE = '22023';
  END IF;

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

  SELECT *
    INTO v_request
    FROM public.credit_pack_purchase_requests
   WHERE request_id = p_request_id
   FOR UPDATE;

  IF v_request.status = 'completed' THEN
    IF v_request.transaction_id IS DISTINCT FROM p_transaction_id
       OR v_request.provider_price_id IS DISTINCT FROM p_provider_price_id
       OR v_request.provider_product_id IS DISTINCT FROM p_provider_product_id THEN
      RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_CONFLICT'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'userId', v_request.user_id,
      'status', v_request.status
    );
  END IF;
  IF v_request.status = 'failed' THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_TERMINAL'
      USING ERRCODE = 'P0001';
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

  v_result := public.apply_credit_pack_purchase(
    p_transaction_id,
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

  UPDATE public.credit_pack_purchase_requests
     SET transaction_id = p_transaction_id,
         provider_price_id = p_provider_price_id,
         provider_product_id = p_provider_product_id,
         status = 'completed',
         submitted_at = COALESCE(submitted_at, p_purchased_at),
         completed_at = p_purchased_at,
         provider_error_code = NULL
   WHERE request_id = p_request_id
     AND status IN ('created', 'submitted', 'provider_unknown');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_PURCHASE_REQUEST_FULFILLMENT_RACE'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_result || jsonb_build_object(
    'userId', v_request.user_id,
    'requestId', p_request_id,
    'status', 'completed'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_credit_pack_purchase_request(
  uuid, uuid, text, text, text, integer, integer, text, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_credit_pack_purchase_request(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_credit_pack_subscription_charge(
  uuid, text, text, text, text, text, text,
  integer, integer, text, integer, timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_credit_pack_purchase_request(
  uuid, uuid, text, text, text, integer, integer, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_credit_pack_purchase_request(
  uuid, uuid, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_credit_pack_subscription_charge(
  uuid, text, text, text, text, text, text,
  integer, integer, text, integer, timestamptz
) TO service_role;

COMMIT;
