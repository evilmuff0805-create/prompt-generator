BEGIN TRANSACTION READ ONLY;

DO $audit$
DECLARE
  v_cron_total bigint := 0;
  v_cron_active bigint := 0;
  v_cron_external_active bigint := 0;
  v_cron_running bigint := 0;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM cron.job' INTO v_cron_total;
    EXECUTE 'SELECT count(*) FROM cron.job WHERE active' INTO v_cron_active;
    EXECUTE $sql$
      SELECT count(*)
        FROM cron.job
       WHERE active
         AND database IS DISTINCT FROM current_database()
    $sql$ INTO v_cron_external_active;
  END IF;
  IF to_regclass('cron.job_run_details') IS NOT NULL THEN
    EXECUTE $sql$
      SELECT count(*)
        FROM cron.job_run_details
       WHERE status = 'running'
    $sql$ INTO v_cron_running;
  END IF;
  PERFORM set_config('promptgen_clone.cron_total_count', v_cron_total::text, true);
  PERFORM set_config('promptgen_clone.cron_active_count', v_cron_active::text, true);
  PERFORM set_config(
    'promptgen_clone.cron_external_database_active_count',
    v_cron_external_active::text,
    true
  );
  PERFORM set_config(
    'promptgen_clone.cron_running_count',
    v_cron_running::text,
    true
  );
END;
$audit$;

SELECT jsonb_build_object(
  'postgres_17_count',
    CASE WHEN current_setting('server_version_num')::integer BETWEEN 170000 AND 179999
      THEN 1 ELSE 0 END,
  'cron_extension_count',
    (SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron'),
  'cron_table_count',
    CASE WHEN to_regclass('cron.job') IS NULL THEN 0 ELSE 1 END,
  'cron_extension_without_table_count',
    CASE
      WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
       AND to_regclass('cron.job') IS NULL THEN 1
      ELSE 0
    END,
  'cron_extension_without_run_details_count',
    CASE
      WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
       AND to_regclass('cron.job_run_details') IS NULL THEN 1
      ELSE 0
    END,
  'cron_total_count',
    current_setting('promptgen_clone.cron_total_count')::bigint,
  'cron_active_count',
    current_setting('promptgen_clone.cron_active_count')::bigint,
  'cron_external_database_active_count',
    current_setting('promptgen_clone.cron_external_database_active_count')::bigint,
  'cron_running_count',
    current_setting('promptgen_clone.cron_running_count')::bigint
);

COMMIT;
