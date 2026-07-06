-- ============================================================
-- Migration 010: credits_ledger — 크레딧 변동 자동 감사 로그 (DB 트리거)
-- Apply in Supabase SQL Editor (검수 승인 후)
--
-- 방식 (B-트리거, 확정):
--   profiles.credits 또는 plan이 실제로 바뀌는 모든 UPDATE를 트리거가
--   자동 기록. 앱 코드(webhook/deduct RPC 등 검증된 돈 경로) 일절 무변경.
--   어떤 경로(webhook/분석/스토리보드/수동 SQL)든 전부 포착.
--
-- 원칙:
--   1. ledger 기록 실패가 원래 크레딧 UPDATE를 절대 막지 않음
--      (트리거 내부 EXCEPTION으로 삼키고 RAISE WARNING → Postgres 로그)
--   2. reason은 저장하지 않음(트리거는 호출자를 모름) —
--      delta 값으로 사후 추정(하단 판독 쿼리 참조)
--   3. 소급 불가: 적용 시점 이후의 변동만 기록됨
--   4. audit 목적이므로 auth.users FK 없음 — 유저 삭제 후에도 이력 보존
-- ============================================================

BEGIN;

-- 1. 원장 테이블
CREATE TABLE IF NOT EXISTS public.credits_ledger (
  id             BIGSERIAL    PRIMARY KEY,
  user_id        UUID         NOT NULL,
  credits_before INT          NOT NULL,
  credits_after  INT          NOT NULL,
  delta          INT          NOT NULL,   -- credits_after - credits_before (plan만 변경 시 0)
  plan_before    TEXT,
  plan_after     TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credits_ledger_user_time
  ON public.credits_ledger (user_id, created_at DESC);

-- RLS: 클라이언트 접근 전면 차단. service_role(백엔드/SQL Editor)만 접근.
ALTER TABLE public.credits_ledger ENABLE ROW LEVEL SECURITY;
-- (정책을 만들지 않음 → anon/authenticated는 아무것도 못 봄. service_role은 RLS 우회.)

GRANT ALL ON public.credits_ledger TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.credits_ledger_id_seq TO service_role;
REVOKE ALL ON public.credits_ledger FROM anon, authenticated;

-- 2. 트리거 함수
-- SECURITY DEFINER: profiles를 UPDATE하는 주체(service_role/authenticated 등)가
-- ledger INSERT 권한이 없어도 기록되도록.
-- 내부 BEGIN/EXCEPTION: INSERT 실패(디스크/제약 등)가 바깥 UPDATE 트랜잭션을
-- 롤백시키지 않도록 삼키고 WARNING만 남김 (원칙 1).
CREATE OR REPLACE FUNCTION public.log_credits_change()
RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    INSERT INTO public.credits_ledger
      (user_id, credits_before, credits_after, delta, plan_before, plan_after)
    VALUES
      (NEW.id, OLD.credits, NEW.credits, NEW.credits - OLD.credits, OLD.plan, NEW.plan);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[credits_ledger] log failed for user %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.log_credits_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_credits_change() FROM anon;
REVOKE EXECUTE ON FUNCTION public.log_credits_change() FROM authenticated;
-- (트리거는 테이블 소유자 권한으로 실행되므로 별도 GRANT 불필요)

-- 3. 트리거: credits 또는 plan이 "실제로 변한" 행만 발화 (WHEN 절에서 필터 —
--    daily_used 등 무관한 UPDATE는 트리거 함수 호출 자체가 없음 → 오버헤드 최소)
DROP TRIGGER IF EXISTS trg_credits_ledger ON public.profiles;
CREATE TRIGGER trg_credits_ledger
  AFTER UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (OLD.credits IS DISTINCT FROM NEW.credits
     OR OLD.plan    IS DISTINCT FROM NEW.plan)
  EXECUTE FUNCTION public.log_credits_change();

COMMIT;


-- ============================================================
-- 판독 쿼리 (reason은 delta 기반 사후 추정 — 저장하지 않음)
-- ============================================================
-- SELECT id, user_id, credits_before, credits_after, delta,
--        plan_before, plan_after, created_at,
--   CASE
--     WHEN delta = -10                                   THEN 'analysis (추정)'
--     WHEN delta IN (-120, -250)                         THEN 'storyboard deduct (추정)'
--     WHEN delta IN (120, 250)                           THEN 'storyboard refund (추정)'
--     WHEN plan_before IS DISTINCT FROM plan_after
--          AND credits_after IN (0, 1000, 4000)          THEN 'plan change/webhook (추정)'
--     WHEN delta = 0                                     THEN 'plan-only change'
--     ELSE                                                    'manual/other'
--   END AS reason_guess
-- FROM public.credits_ledger
-- WHERE user_id = '<uuid>'
-- ORDER BY created_at DESC;
--
-- ============================================================
-- 검증 (적용 후)
-- ============================================================
-- 1) 트리거 존재: SELECT tgname FROM pg_trigger WHERE tgrelid='public.profiles'::regclass;
-- 2) 무해성: UPDATE profiles SET daily_used = daily_used WHERE id='<uuid>';
--    → credits_ledger에 행 안 생겨야 함 (WHEN 절 필터)
-- 3) 동작: UPDATE profiles SET credits = credits - 1 WHERE id='<테스트계정>';
--    → ledger에 delta=-1 행 1개, 이어서 credits = credits + 1 로 원복 (delta=+1)
-- 4) 차단: authenticated로 SELECT 시도 → permission denied 또는 0 rows
