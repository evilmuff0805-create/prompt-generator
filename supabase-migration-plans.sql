-- Migration: Add 'pro' and 'enterprise' plan values
-- Run this in Supabase SQL Editor

-- 1. Drop old check constraint if it exists (only 'free' | 'paid')
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_plan_check;

-- 2. Add new check constraint with expanded plan values
ALTER TABLE profiles
  ADD CONSTRAINT profiles_plan_check
  CHECK (plan IN ('free', 'paid', 'pro', 'enterprise'));

-- 3. Migrate existing 'paid' plan users to 'pro' (optional, safe to run)
-- UPDATE profiles SET plan = 'pro' WHERE plan = 'paid';
