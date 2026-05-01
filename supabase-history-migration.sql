-- ============================================================
-- Migration: 프롬프트 히스토리 테이블 추가
-- Supabase SQL Editor에서 실행하세요.
-- ============================================================

-- 1. prompts 테이블 생성
CREATE TABLE IF NOT EXISTS public.prompts (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  prompt      TEXT         NOT NULL,
  analysis    JSONB        DEFAULT '{}',
  thumbnail   TEXT,                        -- 선택: 이미지 썸네일 URL (현재 미사용)
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 2. RLS 활성화
ALTER TABLE public.prompts ENABLE ROW LEVEL SECURITY;

-- 3. RLS 정책
CREATE POLICY "prompts: select own"
  ON public.prompts FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "prompts: insert own"
  ON public.prompts FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "prompts: delete own"
  ON public.prompts FOR DELETE USING (auth.uid() = user_id);

-- 4. GRANT
GRANT SELECT, INSERT, DELETE ON public.prompts TO authenticated;
GRANT ALL ON public.prompts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.prompts_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.prompts_id_seq TO service_role;

-- 5. 인덱스 (사용자별 최근 조회 최적화)
CREATE INDEX IF NOT EXISTS prompts_user_created
  ON public.prompts (user_id, created_at DESC);
