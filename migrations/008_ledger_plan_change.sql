-- ============================================================
-- Migration 008: purchases 원장 확장 + revert_plan_change RPC
-- Apply in Supabase SQL Editor
--
-- 목적:
--   1. purchases 테이블에 subscription_id, transaction_type 컬럼 추가
--      (업그레이드 환불 추적을 위한 토대 — 기존 행 무영향)
--   2. credits_granted CHECK > 0 → >= 0 완화
--      (플랜 변경 거래는 credits=0도 허용)
--   3. revert_plan_change RPC 생성 (휴면 — 이번엔 어디서도 호출 안 함)
--      free-가드 내장: 이미 취소된(free/0) 계정에 plan 부활 방지
--      실제 연결(revokeCreditsForRefund → revert_plan_change)은 다음 단계.
-- ============================================================

-- 1. 신규 컬럼 추가
ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS subscription_id   TEXT,
  ADD COLUMN IF NOT EXISTS transaction_type  TEXT;

-- subscription_id 인덱스 (직전 행 조회용 — 다음 단계에서 사용)
CREATE INDEX IF NOT EXISTS idx_purchases_subscription_id
  ON public.purchases (subscription_id);

-- 2. credits_granted CHECK 완화: > 0 → >= 0
ALTER TABLE public.purchases
  DROP CONSTRAINT IF EXISTS purchases_credits_granted_check;

ALTER TABLE public.purchases
  ADD CONSTRAINT purchases_credits_granted_check CHECK (credits_granted >= 0);

-- 3. revert_plan_change RPC (휴면: 생성만, 호출 없음)
-- free-가드: 현재 plan=free면 credits만 차감하고 plan은 되살리지 않음.
-- (취소된 계정에 plan 부활 방지 — 방금 잡은 취소 레이스 버그와 동종 위험 차단)
CREATE OR REPLACE FUNCTION public.revert_plan_change(
  p_user_id       UUID,
  p_previous_plan TEXT,
  p_amount        INT
) RETURNS JSON AS $$
DECLARE
  v_current_plan TEXT;
  v_new_credits  INT;
BEGIN
  SELECT plan INTO v_current_plan
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- free-가드: 이미 취소된(free/0) 계정에는 plan을 되살리지 않음
  IF v_current_plan = 'free' THEN
    UPDATE public.profiles
      SET credits = GREATEST(0, credits - p_amount)
      WHERE id = p_user_id
      RETURNING credits INTO v_new_credits;

    RETURN json_build_object(
      'success',       true,
      'new_balance',   v_new_credits,
      'plan_restored', false
    );
  END IF;

  UPDATE public.profiles
    SET plan    = p_previous_plan,
        credits = GREATEST(0, credits - p_amount)
    WHERE id = p_user_id
    RETURNING credits INTO v_new_credits;

  RETURN json_build_object(
    'success',       true,
    'new_balance',   v_new_credits,
    'plan_restored', true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.revert_plan_change(UUID, TEXT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revert_plan_change(UUID, TEXT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.revert_plan_change(UUID, TEXT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.revert_plan_change(UUID, TEXT, INT) TO service_role;


-- ============================================================
-- 검증 쿼리 (마이그레이션 후 확인)
-- ============================================================
-- \d purchases  →  subscription_id, transaction_type 컬럼 확인
--                  credits_granted CHECK >= 0 확인
-- SELECT has_function_privilege('service_role', 'revert_plan_change(uuid,text,integer)', 'EXECUTE');  → true
-- SELECT has_function_privilege('authenticated', 'revert_plan_change(uuid,text,integer)', 'EXECUTE'); → false
