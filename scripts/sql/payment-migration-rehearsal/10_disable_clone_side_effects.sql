BEGIN;

DO $audit$
DECLARE
  v_active bigint := 0;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE cron.job
         SET active = false
       WHERE active
         AND database = current_database()
    $sql$;
    EXECUTE $sql$
      SELECT count(*)
        FROM cron.job
       WHERE active
         AND database = current_database()
    $sql$ INTO v_active;
  END IF;
  IF v_active <> 0 THEN
    RAISE EXCEPTION 'PAYMENT_MIGRATION_CLONE_CRON_DISABLE_FAILED';
  END IF;
END;
$audit$;

SELECT jsonb_build_object(
  'cron_active_count', 0,
  'side_effect_disable_failure_count', 0
);

COMMIT;
