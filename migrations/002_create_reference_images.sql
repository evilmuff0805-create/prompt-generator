-- ============================================================
-- Migration 002: reference_images table
-- Apply in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.reference_images (
  id            TEXT        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path  TEXT        NOT NULL,
  mime_type     TEXT        NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_size     INT         NOT NULL CHECK (file_size > 0),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_reference_images_user_id
  ON public.reference_images (user_id);

CREATE INDEX IF NOT EXISTS idx_reference_images_expires_at
  ON public.reference_images (expires_at);

-- RLS
ALTER TABLE public.reference_images ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reference_images: select own"
  ON public.reference_images FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "reference_images: insert own"
  ON public.reference_images FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- No client-side UPDATE or DELETE (backend handles cleanup via service_role)
CREATE POLICY "reference_images: no client update"
  ON public.reference_images FOR UPDATE
  USING (false);

CREATE POLICY "reference_images: no client delete"
  ON public.reference_images FOR DELETE
  USING (false);

-- Required since Supabase April 2026: new tables are no longer auto-exposed to PostgREST.
-- service_role is used by the backend (bypasses RLS); authenticated covers direct client reads.
GRANT ALL ON public.reference_images TO service_role;
GRANT SELECT, INSERT ON public.reference_images TO authenticated;
