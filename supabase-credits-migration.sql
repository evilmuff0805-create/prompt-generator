-- ============================================================
-- Credits System Migration
-- Supabase 대시보드 > SQL Editor에서 실행하세요.
-- profiles 테이블의 credits 컬럼은 이미 존재합니다.
-- 이 스크립트는 기존 유료 유저의 초기 크레딧을 설정합니다.
-- ============================================================

-- 기존 pro 유저 중 크레딧이 0인 경우 1000 크레딧 지급
UPDATE public.profiles
SET credits = 1000
WHERE plan = 'pro' AND credits = 0;

-- 기존 paid 유저 중 크레딧이 0인 경우 1000 크레딧 지급
UPDATE public.profiles
SET credits = 1000
WHERE plan = 'paid' AND credits = 0;

-- 기존 enterprise 유저 중 크레딧이 0인 경우 4000 크레딧 지급
UPDATE public.profiles
SET credits = 4000
WHERE plan = 'enterprise' AND credits = 0;
