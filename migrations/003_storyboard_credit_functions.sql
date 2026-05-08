-- ============================================================
-- Migration 003: Storyboard-specific credit functions
-- Apply in Supabase SQL Editor
--
-- IMPORTANT: These are NEW functions with DISTINCT names.
-- They do NOT replace existing deduct_credits(user_id, amount).
-- The existing deduct_credits 2-arg function is UNTOUCHED.
-- ============================================================

CREATE OR REPLACE FUNCTION public.deduct_storyboard_credits(
  p_user_id      UUID,
  p_amount       INT,
  p_storyboard_id TEXT
) RETURNS JSON AS $$
DECLARE
  v_balance INT;
BEGIN
  SELECT credits INTO v_balance
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
  END IF;

  UPDATE public.profiles
    SET credits = credits - p_amount
    WHERE id = p_user_id;

  RETURN json_build_object(
    'success',       true,
    'newBalance',    v_balance - p_amount,
    'storyboardId',  p_storyboard_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


CREATE OR REPLACE FUNCTION public.refund_storyboard_credits(
  p_user_id        UUID,
  p_amount         INT,
  p_storyboard_id  TEXT,
  p_reason         TEXT
) RETURNS JSON AS $$
DECLARE
  v_new_balance INT;
BEGIN
  UPDATE public.profiles
    SET credits = credits + p_amount
    WHERE id = p_user_id
    RETURNING credits INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- Append refund note to error_message as audit trail
  UPDATE public.storyboards
    SET error_message = COALESCE(error_message || ' | ', '') || 'REFUND: ' || p_reason
    WHERE id = p_storyboard_id;

  RETURN json_build_object(
    'success',    true,
    'newBalance', v_new_balance
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- PRIVILEGE HARDENING (v1.2.1)
--
-- PostgreSQL grants EXECUTE to PUBLIC by default on new functions.
-- service_role bypasses RLS/GRANT entirely — it does NOT need a
-- GRANT EXECUTE. Client roles (anon, authenticated) must be denied
-- explicitly to prevent privilege escalation via RPC calls.
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.deduct_storyboard_credits(UUID, INT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.deduct_storyboard_credits(UUID, INT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.deduct_storyboard_credits(UUID, INT, TEXT) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.refund_storyboard_credits(UUID, INT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refund_storyboard_credits(UUID, INT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.refund_storyboard_credits(UUID, INT, TEXT, TEXT) FROM authenticated;

-- Defense in depth: pin search_path to prevent function-shadowing attacks
ALTER FUNCTION public.deduct_storyboard_credits(UUID, INT, TEXT)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.refund_storyboard_credits(UUID, INT, TEXT, TEXT)
  SET search_path = public, pg_temp;


-- ============================================================
-- POST-MIGRATION VERIFICATION (run in SQL Editor after applying)
-- ============================================================
-- Confirm existing 2-arg deduct_credits is unchanged:
--   \df deduct_credits        → must show 2-arg signature
--   \df deduct_storyboard_credits  → must show 3-arg signature
--
-- Confirm client roles cannot call the new functions:
--   SELECT has_function_privilege('authenticated', 'deduct_storyboard_credits(uuid,integer,text)', 'EXECUTE');
--   → MUST return false
--
--   SELECT has_function_privilege('anon', 'deduct_storyboard_credits(uuid,integer,text)', 'EXECUTE');
--   → MUST return false
--
--   SELECT has_function_privilege('authenticated', 'refund_storyboard_credits(uuid,integer,text,text)', 'EXECUTE');
--   → MUST return false
-- ============================================================
