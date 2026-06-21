-- Migration 006: Add Paddle subscription identifier columns to profiles
-- Safe: ADD COLUMN IF NOT EXISTS = metadata-only DDL, no table rewrite.
-- Existing rows get NULL for new columns — no data modified.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS paddle_customer_id     TEXT,
  ADD COLUMN IF NOT EXISTS paddle_subscription_id TEXT;

COMMENT ON COLUMN public.profiles.paddle_customer_id
  IS 'Paddle customer ID (ctm_…). Stored on transaction.completed webhook.';
COMMENT ON COLUMN public.profiles.paddle_subscription_id
  IS 'Paddle subscription ID (sub_…). Stored on transaction.completed webhook.';

-- Verification: must return 2 rows
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'profiles'
  AND column_name IN ('paddle_customer_id', 'paddle_subscription_id');
