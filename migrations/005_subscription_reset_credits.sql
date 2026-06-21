-- ============================================================
-- Migration 005: 구독(리셋) 모델로 grant_credits 의미 변경
-- Apply in Supabase SQL Editor
--
-- 배경:
--   이 앱은 "매월 구독 (리셋, 이월 없음)" 모델이다.
--   Paddle 구독은 매 결제 주기마다 transaction.completed 를 발생시키므로,
--   갱신 때마다 크레딧을 누적(+)하면 1000→2000→3000... 으로 무한 증가한다 (버그).
--
--   따라서 grant_credits 는 "누적 증분"이 아니라
--   "해당 플랜 할당량으로 리셋(set)" 해야 한다.
--   (예: 매월 갱신 시 잔액과 무관하게 credits = 1000)
--
-- Migration 004 의 grant_credits(증분) 를 리셋 버전으로 교체한다.
-- 시그니처 동일 → paddle.js 호출부 변경 불필요.
-- ============================================================

CREATE OR REPLACE FUNCTION public.grant_credits(
  p_user_id UUID,
  p_plan    TEXT,
  p_amount  INT
) RETURNS JSON AS $$
DECLARE
  v_new_credits INT;
BEGIN
  -- 구독 리셋: 잔액 누적이 아니라 플랜 할당량으로 SET (이월 없음)
  UPDATE public.profiles
    SET plan    = p_plan,
        credits = p_amount
    WHERE id = p_user_id
    RETURNING credits INTO v_new_credits;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  RETURN json_build_object(
    'success',     true,
    'new_balance', v_new_credits
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

-- 권한은 004 에서 이미 설정됨 (REPLACE 는 권한 유지). 안전을 위해 재확인.
REVOKE EXECUTE ON FUNCTION public.grant_credits(UUID, TEXT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.grant_credits(UUID, TEXT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.grant_credits(UUID, TEXT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credits(UUID, TEXT, INT) TO service_role;


-- ============================================================
-- (선택) 기존 데이터 보정
-- 직전 실결제로 730 → 1730 으로 누적된 잔액을 현재 주기 할당량으로 리셋.
-- 본인 계정만 보정하려면 email 조건을 사용.
-- ============================================================
-- UPDATE public.profiles SET credits = 1000 WHERE plan = 'pro'        AND credits > 1000;
-- UPDATE public.profiles SET credits = 4000 WHERE plan = 'enterprise' AND credits > 4000;
