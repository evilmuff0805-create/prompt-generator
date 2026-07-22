-- Keep the Storage API boundary aligned with the server-side upload contract.
-- Existing objects remain readable; these restrictions only apply to new uploads.

DO $$
DECLARE
  v_reference_limit CONSTANT bigint := 10 * 1024 * 1024;
  v_storyboard_limit CONSTANT bigint := 20 * 1024 * 1024;
BEGIN
  IF (
    SELECT count(*)
    FROM storage.buckets
    WHERE id IN ('reference-images', 'storyboards')
  ) <> 2 THEN
    RAISE EXCEPTION 'Expected both private PromptGen Storage buckets to exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.buckets
    WHERE id IN ('reference-images', 'storyboards')
      AND public
  ) THEN
    RAISE EXCEPTION 'PromptGen Storage buckets must remain private';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.objects
    WHERE bucket_id IN ('reference-images', 'storyboards')
      AND coalesce(metadata ->> 'mimetype', '') <> 'image/png'
  ) THEN
    RAISE EXCEPTION 'Existing PromptGen Storage objects violate the PNG-only contract';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.objects
    WHERE bucket_id = 'reference-images'
      AND coalesce((metadata ->> 'size')::bigint, 0) > v_reference_limit
  ) THEN
    RAISE EXCEPTION 'Existing reference image exceeds the proposed 10 MiB limit';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM storage.objects
    WHERE bucket_id = 'storyboards'
      AND coalesce((metadata ->> 'size')::bigint, 0) > v_storyboard_limit
  ) THEN
    RAISE EXCEPTION 'Existing storyboard grid exceeds the proposed 20 MiB limit';
  END IF;

  UPDATE storage.buckets
  SET file_size_limit = v_reference_limit,
      allowed_mime_types = ARRAY['image/png']::text[]
  WHERE id = 'reference-images';

  UPDATE storage.buckets
  SET file_size_limit = v_storyboard_limit,
      allowed_mime_types = ARRAY['image/png']::text[]
  WHERE id = 'storyboards';
END
$$;
