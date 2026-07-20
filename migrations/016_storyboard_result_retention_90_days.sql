-- Keep active Storyboard results available in History for 90 days.
-- Previously soft-deleted rows remain untouched by design.

ALTER TABLE public.storyboards
  ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '90 days');

UPDATE public.storyboards
   SET expires_at = GREATEST(expires_at, created_at + INTERVAL '90 days')
 WHERE deleted_at IS NULL
   AND expires_at < created_at + INTERVAL '90 days';

COMMENT ON COLUMN public.storyboards.expires_at IS
  'Result availability deadline. Active Storyboards default to 90 days from creation.';
