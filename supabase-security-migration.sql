-- ============================================================
-- Security Migration: Webhook Replay Protection + Atomic Credits
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. 웹훅 이벤트 중복 처리 방지 테이블
CREATE TABLE IF NOT EXISTS public.webhook_events (
  event_id    TEXT        PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- 오래된 이벤트 자동 삭제 (30일 보관)
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed_at
  ON public.webhook_events (processed_at);

-- RLS: 서비스 롤만 접근 가능 (일반 사용자 접근 불가)
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "webhook_events: service role only"
  ON public.webhook_events
  USING (false);  -- 모든 일반 접근 차단; 서비스 롤은 RLS 우회

-- 2. 원자적 크레딧 차감 RPC
-- credits >= p_amount 일 때만 차감 성공, 부족하면 -1 반환
CREATE OR REPLACE FUNCTION public.deduct_credits(p_user_id UUID, p_amount INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_credits INTEGER;
BEGIN
  UPDATE public.profiles
    SET credits = credits - p_amount
  WHERE id = p_user_id
    AND credits >= p_amount
  RETURNING credits INTO new_credits;

  IF NOT FOUND THEN
    RETURN -1;  -- 크레딧 부족
  END IF;

  RETURN new_credits;
END;
$$;

-- RPC를 인증된 사용자만 호출 가능하게 설정
REVOKE ALL ON FUNCTION public.deduct_credits FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deduct_credits TO authenticated;

-- 3. 오래된 webhook_events 자동 정리 (선택사항: pg_cron 사용 가능한 환경에서)
-- SELECT cron.schedule('cleanup-webhook-events', '0 3 * * *',
--   $$DELETE FROM public.webhook_events WHERE processed_at < NOW() - INTERVAL '30 days'$$
-- );
