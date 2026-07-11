-- ============================================================
-- Migration 011: profile mutation & privileged RPC boundaries
-- Apply ONLY AFTER the server release containing:
--   - server.js profile mutations via service-role client
--   - routes/analyze.js credit RPC/counter mutations via service-role client
--
-- This migration makes authenticated browser clients read-only for profiles
-- and removes direct execution of privileged RPCs.
-- ============================================================

BEGIN;

-- 1. Browser clients may only read their own profile. All profile mutations
-- (credits, plans, counters and Paddle IDs) are now performed by the backend.
REVOKE ALL ON TABLE public.profiles FROM anon, authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;

DROP POLICY IF EXISTS "profiles: insert own" ON public.profiles;
DROP POLICY IF EXISTS "profiles: update own" ON public.profiles;
DROP POLICY IF EXISTS "profiles: select own" ON public.profiles;

CREATE POLICY "profiles: select own"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = id);

-- 2. Privileged RPCs are service-role only. Fix mutable search paths and reject
-- non-positive values so a negative "deduction" can never grant credits.
CREATE OR REPLACE FUNCTION public.deduct_credits(
  p_user_id uuid,
  p_amount integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  new_credits integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT' USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles
     SET credits = credits - p_amount
   WHERE id = p_user_id
     AND credits >= p_amount
  RETURNING credits INTO new_credits;

  IF NOT FOUND THEN
    RETURN -1;
  END IF;
  RETURN new_credits;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_plan_change(
  p_user_id uuid,
  p_new_plan text,
  p_new_allotment integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_plan text;
  v_credits  integer;
  v_old      integer;
  v_new      integer;
  v_result   integer;
BEGIN
  IF p_new_plan IS NULL OR btrim(p_new_plan) = '' THEN
    RAISE EXCEPTION 'INVALID_PLAN' USING ERRCODE = '22023';
  END IF;
  IF p_new_allotment IS NULL OR p_new_allotment < 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_ALLOTMENT' USING ERRCODE = '22023';
  END IF;

  SELECT plan, credits
    INTO v_old_plan, v_credits
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Ordinal rank: enterprise=2, pro=1, all other plans=0.
  v_old := CASE v_old_plan WHEN 'enterprise' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END;
  v_new := CASE p_new_plan WHEN 'enterprise' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END;

  IF v_new > v_old THEN
    v_result := p_new_allotment;
  ELSIF v_new < v_old THEN
    v_result := LEAST(v_credits, p_new_allotment);
  ELSE
    v_result := v_credits;
  END IF;

  UPDATE public.profiles
     SET plan = p_new_plan,
         credits = v_result
   WHERE id = p_user_id;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.deduct_storyboard_credits(
  p_user_id uuid,
  p_amount integer,
  p_storyboard_id text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_balance integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT' USING ERRCODE = '22023';
  END IF;

  SELECT credits INTO v_balance
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF v_balance IS NULL THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;
  IF v_balance < p_amount THEN RAISE EXCEPTION 'INSUFFICIENT_CREDITS'; END IF;

  UPDATE public.profiles
     SET credits = credits - p_amount
   WHERE id = p_user_id;

  RETURN json_build_object(
    'success', true,
    'newBalance', v_balance - p_amount,
    'storyboardId', p_storyboard_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_storyboard_credits(
  p_user_id uuid,
  p_amount integer,
  p_storyboard_id text,
  p_reason text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_new_balance integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT' USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles
     SET credits = credits + p_amount
   WHERE id = p_user_id
  RETURNING credits INTO v_new_balance;

  IF v_new_balance IS NULL THEN RAISE EXCEPTION 'USER_NOT_FOUND'; END IF;

  UPDATE public.storyboards
     SET error_message = COALESCE(error_message || ' | ', '') || 'REFUND: ' || p_reason
   WHERE id = p_storyboard_id;

  RETURN json_build_object('success', true, 'newBalance', v_new_balance);
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.deduct_credits(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_plan_change(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deduct_storyboard_credits(uuid, integer, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_storyboard_credits(uuid, integer, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rls_auto_enable()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_updated_at()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.deduct_credits(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_plan_change(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.deduct_storyboard_credits(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_storyboard_credits(uuid, integer, text, text) TO service_role;

COMMIT;

-- Post-deploy verification (run as an administrative SQL query):
-- SELECT
--   has_table_privilege('authenticated', 'public.profiles', 'UPDATE') AS authenticated_can_update_profiles,
--   has_table_privilege('authenticated', 'public.profiles', 'SELECT') AS authenticated_can_select_profiles,
--   has_function_privilege('anon',
--     'public.apply_plan_change(uuid,text,integer)'::regprocedure,
--     'EXECUTE') AS anon_can_apply_plan_change,
--   has_function_privilege('authenticated',
--     'public.deduct_credits(uuid,integer)'::regprocedure,
--     'EXECUTE') AS authenticated_can_deduct_credits,
--   has_function_privilege('service_role',
--     'public.deduct_credits(uuid,integer)'::regprocedure,
--     'EXECUTE') AS service_role_can_deduct_credits;
-- Expected: false, true, false, false, true.
