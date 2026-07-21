-- Unlisted, grid-only Storyboard share links.
-- Raw share tokens never enter the database; only SHA-256 hashes are stored.

CREATE TABLE IF NOT EXISTS public.storyboard_shares (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  storyboard_id    TEXT        NOT NULL UNIQUE
                               REFERENCES public.storyboards(id) ON DELETE CASCADE,
  owner_id          UUID        NOT NULL
                               REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash        TEXT        NOT NULL UNIQUE
                               CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scope             TEXT        NOT NULL DEFAULT 'grid_only'
                               CHECK (scope = 'grid_only'),
  consent_version   TEXT        NOT NULL
                               CHECK (consent_version = 'unlisted-grid-v1'),
  consented_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_storyboard_shares_owner_id
  ON public.storyboard_shares (owner_id);

CREATE INDEX IF NOT EXISTS idx_storyboard_shares_active_expiry
  ON public.storyboard_shares (expires_at)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS storyboard_shares_updated_at ON public.storyboard_shares;
CREATE TRIGGER storyboard_shares_updated_at
  BEFORE UPDATE ON public.storyboard_shares
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.storyboard_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "storyboard shares: service role only" ON public.storyboard_shares;
CREATE POLICY "storyboard shares: service role only"
  ON public.storyboard_shares
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.storyboard_shares FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storyboard_shares TO service_role;

COMMENT ON TABLE public.storyboard_shares IS
  'Server-only, unlisted Storyboard grid shares. Public access is mediated by the application and expires with the source Storyboard.';
COMMENT ON COLUMN public.storyboard_shares.token_hash IS
  'Lowercase SHA-256 hex digest of the one-time-disclosed 256-bit share token.';
COMMENT ON COLUMN public.storyboard_shares.scope IS
  'Fixed at grid_only; scenario, prompts, characters, references and account identity are excluded.';
