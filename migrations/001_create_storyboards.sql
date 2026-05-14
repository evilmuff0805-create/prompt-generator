-- ============================================================
-- Migration 001: storyboards table
-- Apply in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.storyboards (
  id                   TEXT        PRIMARY KEY,
  user_id              UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scenario             TEXT        NOT NULL CHECK (char_length(scenario) BETWEEN 50 AND 2000),
  genres               TEXT[]      NOT NULL,
  style                TEXT        NOT NULL CHECK (style IN ('Pixar 3D', 'Cinematic', 'Documentary', 'Animation')),
  cut_count            INT         NOT NULL CHECK (cut_count IN (4, 9)),
  reference_image_ids  TEXT[]      NOT NULL DEFAULT '{}',
  status               TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'deleted')),
  progress             FLOAT       NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  current_step         TEXT,
  shots                JSONB,
  characters           JSONB,
  grid_storage_path    TEXT,
  credits_used         INT         NOT NULL DEFAULT 250,
  error_message        TEXT,
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_storyboards_user_id
  ON public.storyboards (user_id);

CREATE INDEX IF NOT EXISTS idx_storyboards_status
  ON public.storyboards (status);

CREATE INDEX IF NOT EXISTS idx_storyboards_expires_at
  ON public.storyboards (expires_at);

CREATE INDEX IF NOT EXISTS idx_storyboards_user_status
  ON public.storyboards (user_id, status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS storyboards_updated_at ON public.storyboards;
CREATE TRIGGER storyboards_updated_at
  BEFORE UPDATE ON public.storyboards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.storyboards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "storyboards: select own"
  ON public.storyboards FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "storyboards: insert own"
  ON public.storyboards FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "storyboards: update own"
  ON public.storyboards FOR UPDATE
  USING (auth.uid() = user_id);

-- Soft-delete only (no hard DELETE by clients)
CREATE POLICY "storyboards: delete own"
  ON public.storyboards FOR DELETE
  USING (false);

-- Required since Supabase April 2026: new tables are no longer auto-exposed to PostgREST.
GRANT ALL ON public.storyboards TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.storyboards TO authenticated;
