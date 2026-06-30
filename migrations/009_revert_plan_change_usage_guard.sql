-- ============================================================
-- Migration 009: revert_plan_change 자동 환불복원 버전으로 교체
-- Apply in Supabase SQL Editor
--
-- 008의 휴면 revert_plan_change(uuid,text,int)를 DROP하고,
-- 사용여부 판정 + allotment 복원을 내장한 4-인자 버전으로 교체.
--
-- 정책 (확정):
--   1. 사용여부 판정을 RPC 내부 FOR UPDATE 잠금 안에서 수행 (TOCTOU 레이스 차단)
--      현재 credits < p_granted  → 크레딧 사용함 → 복원 안 함 (정책 위반, 운영자 실수)
--      현재 credits >= p_granted → 미사용 → 정상 복원
--   2. 미사용 복원 시 이전 plan + 그 plan의 allotment로 SET
--      (업그레이드 RESET이 직전 잔액을 덮어써 복구 불가하므로 allotment 부여)
--   3. free-가드: 이미 취소된(free) 계정에는 plan 부활 안 함
--   4. 어느 경우든 크레딧을 차감해 음수로 만들지 않음 (복원=SET, 비복원=무변경)
-- ============================================================

BEGIN;

-- 008의 휴면 3-인자 버전 제거 (한 번도 호출된 적 없음 — 안전)
DROP FUNCTION IF EXISTS public.revert_plan_change(UUID, TEXT, INT);

-- 신규 4-인자 버전
CREATE OR REPLACE FUNCTION public.revert_plan_change(
  p_user_id            UUID,
  p_previous_plan      TEXT,
  p_previous_allotment INT,
  p_granted            INT
) RETURNS JSON AS $$
DECLARE
  v_plan    TEXT;
  v_credits INT;
BEGIN
  SELECT plan, credits INTO v_plan, v_credits
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- free-가드: 이미 취소된(free) 계정에는 plan을 되살리지 않음. 무변경.
  IF v_plan = 'free' THEN
    RETURN json_build_object(
      'success',       true,
      'plan_restored', false,
      'reason',        'account_free',
      'new_balance',   v_credits
    );
  END IF;

  -- 사용여부 판정 (FOR UPDATE 잠금 내부 — 원자적):
  -- 업그레이드는 credits를 allotment로 RESET했으므로, 현재 < granted = 사용함.
  -- 정책 위반(운영자 실수로 사용자가 환불됨) → plan/credits 무변경, 호출측이 CRITICAL 로그.
  IF v_credits < p_granted THEN
    RETURN json_build_object(
      'success',       true,
      'plan_restored', false,
      'reason',        'credits_used',
      'new_balance',   v_credits
    );
  END IF;

  -- 미사용 → 이전 plan + 그 plan allotment로 복원
  UPDATE public.profiles
    SET plan    = p_previous_plan,
        credits = p_previous_allotment
    WHERE id = p_user_id
    RETURNING credits INTO v_credits;

  RETURN json_build_object(
    'success',       true,
    'plan_restored', true,
    'reason',        'restored',
    'new_balance',   v_credits
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.revert_plan_change(UUID, TEXT, INT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revert_plan_change(UUID, TEXT, INT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.revert_plan_change(UUID, TEXT, INT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.revert_plan_change(UUID, TEXT, INT, INT) TO service_role;

COMMIT;


-- ============================================================
-- 검증 쿼리 (마이그레이션 후 확인)
-- ============================================================
-- SELECT has_function_privilege('service_role', 'revert_plan_change(uuid,text,integer,integer)', 'EXECUTE');  → true
-- 구버전(3-인자)이 사라졌는지: 아래가 에러(function does not exist)면 정상
-- SELECT has_function_privilege('service_role', 'revert_plan_change(uuid,text,integer)', 'EXECUTE');
