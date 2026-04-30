-- ============================================================
-- PromptGen Supabase Setup
-- Supabase 대시보드 > SQL Editor에서 실행하세요.
-- Authentication > Providers > Google을 활성화해야 합니다.
-- ============================================================

-- 1. profiles 테이블
CREATE TABLE IF NOT EXISTS public.profiles (
  id               UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email            TEXT,
  full_name        TEXT,
  avatar_url       TEXT,
  plan             TEXT        NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'paid')),
  credits          INTEGER     NOT NULL DEFAULT 0,
  daily_used       INTEGER     NOT NULL DEFAULT 0,
  last_reset_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. usage_logs 테이블
CREATE TABLE IF NOT EXISTS public.usage_logs (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. RLS 활성화
ALTER TABLE public.profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;

-- 4. profiles RLS 정책
CREATE POLICY "profiles: select own"
  ON public.profiles FOR SELECT USING (auth.uid() = id);

CREATE POLICY "profiles: insert own"
  ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles: update own"
  ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- 5. usage_logs RLS 정책
CREATE POLICY "usage_logs: insert own"
  ON public.usage_logs FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "usage_logs: select own"
  ON public.usage_logs FOR SELECT USING (auth.uid() = user_id);

-- 6. 신규 유저 가입 시 profile 자동 생성 트리거
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
