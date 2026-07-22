-- Allow the server-side worker to close a deduplicated incident after the
-- underlying operation has succeeded again. The incident row is preserved.

CREATE OR REPLACE FUNCTION public.resolve_ops_incident(p_fingerprint text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_fingerprint text := left(btrim(COALESCE(p_fingerprint, '')), 500);
  v_resolved_count integer;
BEGIN
  IF v_fingerprint = '' THEN
    RAISE EXCEPTION 'INVALID_INCIDENT_FINGERPRINT' USING ERRCODE = '22023';
  END IF;

  UPDATE public.ops_incidents
  SET resolved_at = clock_timestamp()
  WHERE fingerprint = v_fingerprint
    AND resolved_at IS NULL;

  GET DIAGNOSTICS v_resolved_count = ROW_COUNT;
  RETURN v_resolved_count > 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_ops_incident(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_ops_incident(text)
  TO service_role;
