-- ============================================================
-- Migration 022: atomic, idempotent Image-to-Prompt charging
--
-- Rollout order:
--   1. Apply this additive migration.
--   2. Deploy the server release that uses these RPCs.
--
-- Existing balances, prompt history, usage history and ledger rows are
-- preserved. Browser roles receive no access to the operation table or RPCs.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.analysis_credit_operations (
  operation_id       uuid        PRIMARY KEY,
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credit_cost        integer     NOT NULL CHECK (credit_cost > 0),
  charge_type        text        NOT NULL CHECK (charge_type IN ('paid_credit', 'free_daily')),
  charged_amount     integer     NOT NULL CHECK (charged_amount >= 0),
  status             text        NOT NULL CHECK (status IN ('reserved', 'completed', 'refunded')),
  usage_date         date        NOT NULL DEFAULT CURRENT_DATE,
  result             jsonb,
  reservation_count  integer     NOT NULL DEFAULT 1 CHECK (reservation_count > 0),
  refund_count       integer     NOT NULL DEFAULT 0 CHECK (refund_count >= 0),
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at       timestamptz,
  refunded_at        timestamptz,
  refund_reason      text
);

CREATE INDEX IF NOT EXISTS idx_analysis_credit_operations_stale
  ON public.analysis_credit_operations (expires_at)
  WHERE status = 'reserved';

CREATE INDEX IF NOT EXISTS idx_analysis_credit_operations_user_time
  ON public.analysis_credit_operations (user_id, created_at DESC);

ALTER TABLE public.analysis_credit_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_credit_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.analysis_credit_operations TO service_role;

ALTER TABLE public.prompts
  ADD COLUMN IF NOT EXISTS analysis_operation_id uuid;

ALTER TABLE public.usage_logs
  ADD COLUMN IF NOT EXISTS analysis_operation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS prompts_analysis_operation_id_unique
  ON public.prompts (analysis_operation_id);

CREATE UNIQUE INDEX IF NOT EXISTS usage_logs_analysis_operation_id_unique
  ON public.usage_logs (analysis_operation_id);

GRANT ALL ON TABLE public.prompts, public.usage_logs TO service_role;

-- Reserve a paid-plan credit charge or a free-plan daily slot before invoking
-- Gemini. Reusing a completed operation returns the cached result without
-- charging or calling the provider again. A refunded operation may be safely
-- retried with the same operation ID.
CREATE OR REPLACE FUNCTION public.reserve_analysis_operation(
  p_operation_id uuid,
  p_user_id uuid,
  p_credit_cost integer,
  p_reservation_seconds integer DEFAULT 900
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation public.analysis_credit_operations%ROWTYPE;
  v_plan text;
  v_balance integer;
  v_daily_used integer;
  v_last_reset_date date;
  v_charge_type text;
  v_charged_amount integer;
  v_now timestamptz := clock_timestamp();
  v_reusing boolean := false;
BEGIN
  IF p_operation_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_OPERATION_ID' USING ERRCODE = '22023';
  END IF;
  IF p_credit_cost IS NULL OR p_credit_cost <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT' USING ERRCODE = '22023';
  END IF;
  IF p_reservation_seconds IS NULL OR p_reservation_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'INVALID_RESERVATION_SECONDS' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_operation
    FROM public.analysis_credit_operations
   WHERE operation_id = p_operation_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_operation.user_id <> p_user_id OR v_operation.credit_cost <> p_credit_cost THEN
      RAISE EXCEPTION 'OPERATION_MISMATCH' USING ERRCODE = '22023';
    END IF;

    IF v_operation.status IN ('reserved', 'completed') THEN
      SELECT credits INTO v_balance FROM public.profiles WHERE id = p_user_id;
      RETURN jsonb_build_object(
        'success', true,
        'isNew', false,
        'status', v_operation.status,
        'chargeType', v_operation.charge_type,
        'chargedAmount', v_operation.charged_amount,
        'newBalance', v_balance,
        'result', v_operation.result
      );
    END IF;

    v_reusing := true;
  END IF;

  -- Serialize all charging/daily-limit decisions for this user.
  SELECT plan, credits, daily_used, last_reset_date
    INTO v_plan, v_balance, v_daily_used, v_last_reset_date
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF lower(COALESCE(v_plan, 'free')) = ANY (ARRAY['pro', 'enterprise', 'paid']) THEN
    IF v_balance < p_credit_cost THEN
      RAISE EXCEPTION 'INSUFFICIENT_CREDITS' USING ERRCODE = 'P0001';
    END IF;
    v_charge_type := 'paid_credit';
    v_charged_amount := p_credit_cost;

    UPDATE public.profiles
       SET credits = credits - p_credit_cost
     WHERE id = p_user_id;
    v_balance := v_balance - p_credit_cost;
  ELSE
    IF v_last_reset_date IS DISTINCT FROM CURRENT_DATE THEN
      UPDATE public.profiles
         SET daily_used = 0,
             last_reset_date = CURRENT_DATE
       WHERE id = p_user_id;
      v_daily_used := 0;
    END IF;

    IF COALESCE(v_daily_used, 0) >= 1 THEN
      RAISE EXCEPTION 'DAILY_LIMIT' USING ERRCODE = 'P0001';
    END IF;

    v_charge_type := 'free_daily';
    v_charged_amount := 0;
    UPDATE public.profiles
       SET daily_used = COALESCE(daily_used, 0) + 1
     WHERE id = p_user_id;
  END IF;

  IF v_reusing THEN
    UPDATE public.analysis_credit_operations
       SET charge_type = v_charge_type,
           charged_amount = v_charged_amount,
           status = 'reserved',
           usage_date = CURRENT_DATE,
           result = NULL,
           reservation_count = reservation_count + 1,
           expires_at = v_now + make_interval(secs => p_reservation_seconds),
           updated_at = v_now,
           completed_at = NULL,
           refunded_at = NULL,
           refund_reason = NULL
     WHERE operation_id = p_operation_id;
  ELSE
    INSERT INTO public.analysis_credit_operations (
      operation_id,
      user_id,
      credit_cost,
      charge_type,
      charged_amount,
      status,
      usage_date,
      expires_at
    ) VALUES (
      p_operation_id,
      p_user_id,
      p_credit_cost,
      v_charge_type,
      v_charged_amount,
      'reserved',
      CURRENT_DATE,
      v_now + make_interval(secs => p_reservation_seconds)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'isNew', true,
    'status', 'reserved',
    'chargeType', v_charge_type,
    'chargedAmount', v_charged_amount,
    'newBalance', v_balance,
    'result', NULL
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_analysis_operation(
  p_operation_id uuid,
  p_user_id uuid,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation public.analysis_credit_operations%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_ANALYSIS_RESULT' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_operation
    FROM public.analysis_credit_operations
   WHERE operation_id = p_operation_id
   FOR UPDATE;

  IF NOT FOUND OR v_operation.user_id <> p_user_id THEN
    RAISE EXCEPTION 'OPERATION_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_operation.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'completed',
      'alreadyCompleted', true,
      'result', v_operation.result
    );
  END IF;

  IF v_operation.status <> 'reserved' THEN
    RAISE EXCEPTION 'OPERATION_NOT_RESERVED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.analysis_credit_operations
     SET status = 'completed',
         result = p_result,
         completed_at = v_now,
         updated_at = v_now,
         expires_at = v_now
   WHERE operation_id = p_operation_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'completed',
    'alreadyCompleted', false,
    'result', p_result
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_analysis_operation(
  p_operation_id uuid,
  p_user_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation public.analysis_credit_operations%ROWTYPE;
  v_balance integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT *
    INTO v_operation
    FROM public.analysis_credit_operations
   WHERE operation_id = p_operation_id
   FOR UPDATE;

  IF NOT FOUND OR v_operation.user_id <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'status', 'missing', 'refunded', false);
  END IF;

  IF v_operation.status = 'completed' THEN
    SELECT credits INTO v_balance FROM public.profiles WHERE id = p_user_id;
    RETURN jsonb_build_object(
      'success', true,
      'status', 'completed',
      'refunded', false,
      'newBalance', v_balance
    );
  END IF;

  IF v_operation.status = 'refunded' THEN
    SELECT credits INTO v_balance FROM public.profiles WHERE id = p_user_id;
    RETURN jsonb_build_object(
      'success', true,
      'status', 'refunded',
      'refunded', false,
      'newBalance', v_balance
    );
  END IF;

  IF v_operation.charge_type = 'paid_credit' AND v_operation.charged_amount > 0 THEN
    UPDATE public.profiles
       SET credits = credits + v_operation.charged_amount
     WHERE id = p_user_id
     RETURNING credits INTO v_balance;
  ELSE
    UPDATE public.profiles
       SET daily_used = GREATEST(COALESCE(daily_used, 0) - 1, 0)
     WHERE id = p_user_id
       AND last_reset_date = v_operation.usage_date
     RETURNING credits INTO v_balance;

    IF v_balance IS NULL THEN
      SELECT credits INTO v_balance FROM public.profiles WHERE id = p_user_id;
    END IF;
  END IF;

  UPDATE public.analysis_credit_operations
     SET status = 'refunded',
         result = NULL,
         refund_count = refund_count + 1,
         refunded_at = v_now,
         updated_at = v_now,
         expires_at = v_now,
         refund_reason = left(COALESCE(p_reason, 'analysis_failed'), 500)
   WHERE operation_id = p_operation_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'refunded',
    'refunded', true,
    'newBalance', v_balance
  );
END;
$function$;

-- Recover reservations left behind by a process crash. SKIP LOCKED makes this
-- safe when multiple app instances run the sweep concurrently.
CREATE OR REPLACE FUNCTION public.refund_stale_analysis_operations(
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation record;
  v_refunded integer := 0;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'INVALID_SWEEP_LIMIT' USING ERRCODE = '22023';
  END IF;

  FOR v_operation IN
    SELECT *
      FROM public.analysis_credit_operations
     WHERE status = 'reserved'
       AND expires_at <= v_now
     ORDER BY expires_at
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  LOOP
    IF v_operation.charge_type = 'paid_credit' AND v_operation.charged_amount > 0 THEN
      UPDATE public.profiles
         SET credits = credits + v_operation.charged_amount
       WHERE id = v_operation.user_id;
    ELSE
      UPDATE public.profiles
         SET daily_used = GREATEST(COALESCE(daily_used, 0) - 1, 0)
       WHERE id = v_operation.user_id
         AND last_reset_date = v_operation.usage_date;
    END IF;

    UPDATE public.analysis_credit_operations
       SET status = 'refunded',
           result = NULL,
           refund_count = refund_count + 1,
           refunded_at = v_now,
           updated_at = v_now,
           refund_reason = 'stale_reservation_recovered'
     WHERE operation_id = v_operation.operation_id
       AND status = 'reserved';

    IF FOUND THEN
      v_refunded := v_refunded + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'refunded', v_refunded);
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_analysis_operation(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_analysis_operation(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_analysis_operation(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_stale_analysis_operations(integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_analysis_operation(uuid, uuid, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_operation(uuid, uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_analysis_operation(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_stale_analysis_operations(integer)
  TO service_role;

COMMIT;

-- Post-migration verification:
--   * anon/authenticated table privileges: false
--   * anon/authenticated RPC EXECUTE: false
--   * service_role RPC EXECUTE: true
--   * existing profiles/prompts/usage_logs/credits_ledger rows unchanged
