-- ============================================================
-- Migration 004: purchases table + grant/revoke credit RPCs
-- Apply in Supabase SQL Editor
--
-- 목적:
--   1. purchases 테이블: Paddle transaction_id → userId 매핑 원장
--      (환불 처리 시 userId 역조회에 필수)
--   2. grant_credits RPC: 크레딧 누적 증분 (기존 잔액 보존)
--   3. revoke_credits RPC: 환불 시 크레딧 회수 + plan → free
--
-- 기존 updateUserPlan (credits 덮어쓰기) 는 paddle.js에서 제거됨.
-- ============================================================

-- 1. purchases 테이블
CREATE TABLE IF NOT EXISTS public.purchases (
  id               BIGSERIAL    PRIMARY KEY,
  transaction_id   TEXT         NOT NULL UNIQUE,
  user_id          UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan             TEXT         NOT NULL,
  credits_granted  INT          NOT NULL CHECK (credits_granted > 0),
  status           TEXT         NOT NULL DEFAULT 'completed'
                                CHECK (status IN ('completed', 'refunded')),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchases_user_id
  ON public.purchases (user_id);

CREATE INDEX IF NOT EXISTS idx_purchases_transaction_id
  ON public.purchases (transaction_id);

ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;

-- 사용자는 자신의 구매 기록만 조회 가능 (백엔드는 service_role로 RLS 우회)
CREATE POLICY "purchases: select own"
  ON public.purchases FOR SELECT
  USING (auth.uid() = user_id);

-- 클라이언트 직접 INSERT/UPDATE/DELETE 차단
CREATE POLICY "purchases: no client insert"
  ON public.purchases FOR INSERT
  WITH CHECK (false);

CREATE POLICY "purchases: no client update"
  ON public.purchases FOR UPDATE
  USING (false);

CREATE POLICY "purchases: no client delete"
  ON public.purchases FOR DELETE
  USING (false);

-- Supabase April 2026: 명시적 GRANT 필요
GRANT ALL ON public.purchases TO service_role;
GRANT SELECT ON public.purchases TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.purchases_id_seq TO service_role;


-- 2. grant_credits RPC
-- 기존 잔액에 누적 증분 + plan 설정.
-- SECURITY DEFINER: service_role만 호출 (클라이언트 직접 호출 불가)
CREATE OR REPLACE FUNCTION public.grant_credits(
  p_user_id UUID,
  p_plan    TEXT,
  p_amount  INT
) RETURNS JSON AS $$
DECLARE
  v_new_credits INT;
BEGIN
  UPDATE public.profiles
    SET plan    = p_plan,
        credits = credits + p_amount
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

REVOKE EXECUTE ON FUNCTION public.grant_credits(UUID, TEXT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.grant_credits(UUID, TEXT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.grant_credits(UUID, TEXT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credits(UUID, TEXT, INT) TO service_role;


-- 3. revoke_credits RPC
-- 환불 시 크레딧 회수 (0 클램프) + plan → free.
CREATE OR REPLACE FUNCTION public.revoke_credits(
  p_user_id UUID,
  p_amount  INT
) RETURNS JSON AS $$
DECLARE
  v_new_credits INT;
BEGIN
  UPDATE public.profiles
    SET plan    = 'free',
        credits = GREATEST(0, credits - p_amount)
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

REVOKE EXECUTE ON FUNCTION public.revoke_credits(UUID, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revoke_credits(UUID, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.revoke_credits(UUID, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_credits(UUID, INT) TO service_role;


-- ============================================================
-- 검증 쿼리 (마이그레이션 후 확인)
-- ============================================================
-- SELECT has_function_privilege('service_role', 'grant_credits(uuid,text,integer)', 'EXECUTE');   → true
-- SELECT has_function_privilege('authenticated', 'grant_credits(uuid,text,integer)', 'EXECUTE'); → false
-- SELECT has_function_privilege('service_role', 'revoke_credits(uuid,integer)', 'EXECUTE');       → true
-- SELECT has_function_privilege('authenticated', 'revoke_credits(uuid,integer)', 'EXECUTE');      → false
-- SELECT * FROM public.purchases LIMIT 1;  → (empty, no error)
