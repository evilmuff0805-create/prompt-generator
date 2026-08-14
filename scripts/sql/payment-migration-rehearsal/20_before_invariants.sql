BEGIN TRANSACTION READ ONLY;

DO $required$
BEGIN
  IF to_regclass('public.profiles') IS NULL
     OR to_regclass('public.purchases') IS NULL
     OR to_regclass('public.credits_ledger') IS NULL
     OR to_regclass('public.analysis_credit_operations') IS NULL
     OR to_regclass('public.storyboards') IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_MIGRATION_CLONE_REQUIRED_SCHEMA_MISSING';
  END IF;
END;
$required$;

DO $manifest$
DECLARE
  v_rows bigint := 0;
  v_missing bigint := 0;
  v_extra bigint := 0;
  v_total_mismatch bigint := 0;
  v_invalid bigint := 0;
  v_drift bigint := 0;
  v_guard_missing bigint := 0;
BEGIN
  IF to_regclass('promptgen_private.legacy_credit_classification_manifest') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM promptgen_private.legacy_credit_classification_manifest'
      INTO v_rows;
    EXECUTE $sql$
      SELECT count(*)
        FROM public.profiles p
        LEFT JOIN promptgen_private.legacy_credit_classification_manifest m
          ON m.user_id = p.id
       WHERE p.credits > 0 AND m.user_id IS NULL
    $sql$ INTO v_missing;
    EXECUTE $sql$
      SELECT count(*)
        FROM promptgen_private.legacy_credit_classification_manifest m
        LEFT JOIN public.profiles p ON p.id = m.user_id
       WHERE p.id IS NULL OR p.credits <= 0
    $sql$ INTO v_extra;
    EXECUTE $sql$
      SELECT CASE WHEN
        (SELECT count(*) FROM public.profiles WHERE credits > 0)
          IS DISTINCT FROM
        (SELECT count(*) FROM promptgen_private.legacy_credit_classification_manifest)
        OR
        (SELECT COALESCE(sum(credits), 0)::bigint FROM public.profiles WHERE credits > 0)
          IS DISTINCT FROM
        (SELECT COALESCE(sum(expected_credits), 0)::bigint
           FROM promptgen_private.legacy_credit_classification_manifest)
      THEN 1 ELSE 0 END
    $sql$ INTO v_total_mismatch;
    EXECUTE $sql$
      SELECT count(*)
        FROM promptgen_private.legacy_credit_classification_manifest
       WHERE consumed_at IS NOT NULL
          OR snapshot_captured_at > clock_timestamp()
          OR snapshot_captured_at < clock_timestamp() - interval '24 hours'
          OR reviewed_at > clock_timestamp()
    $sql$ INTO v_invalid;

    IF to_regprocedure(
      'promptgen_private.legacy_credit_evidence_fingerprint(uuid)'
    ) IS NULL THEN
      v_guard_missing := v_guard_missing + 1;
    ELSE
      EXECUTE $sql$
        SELECT count(*)
          FROM promptgen_private.legacy_credit_classification_manifest m
          JOIN public.profiles p ON p.id = m.user_id
         WHERE p.plan IS DISTINCT FROM m.expected_plan
            OR p.credits IS DISTINCT FROM m.expected_credits
            OR (NULLIF(btrim(p.paddle_customer_id), '') IS NOT NULL)
                 IS DISTINCT FROM m.expected_has_paddle_customer
            OR (NULLIF(btrim(p.paddle_subscription_id), '') IS NOT NULL)
                 IS DISTINCT FROM m.expected_has_paddle_subscription
            OR (SELECT count(*) FROM public.purchases x WHERE x.user_id = p.id)
                 IS DISTINCT FROM m.expected_purchase_count
            OR (SELECT count(*) FROM public.credits_ledger l WHERE l.user_id = p.id)
                 IS DISTINCT FROM m.expected_ledger_count
            OR promptgen_private.legacy_credit_evidence_fingerprint(p.id)
                 IS DISTINCT FROM m.expected_evidence_fingerprint
      $sql$ INTO v_drift;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'promptgen_private'
         AND c.relname = 'legacy_credit_classification_manifest'
         AND t.tgname = 'trg_guard_legacy_credit_classification_manifest'
         AND NOT t.tgisinternal
         AND t.tgenabled <> 'D'
    ) THEN
      v_guard_missing := v_guard_missing + 1;
    END IF;
  END IF;

  PERFORM set_config('promptgen_clone.manifest_row_count', v_rows::text, true);
  PERFORM set_config('promptgen_clone.manifest_missing_count', v_missing::text, true);
  PERFORM set_config('promptgen_clone.manifest_extra_count', v_extra::text, true);
  PERFORM set_config('promptgen_clone.manifest_total_mismatch_count', v_total_mismatch::text, true);
  PERFORM set_config('promptgen_clone.manifest_invalid_count', v_invalid::text, true);
  PERFORM set_config('promptgen_clone.manifest_drift_count', v_drift::text, true);
  PERFORM set_config('promptgen_clone.manifest_guard_missing_count', v_guard_missing::text, true);
END;
$manifest$;

SELECT jsonb_build_object(
  'positive_legacy_balance_count',
    (SELECT count(*) FROM public.profiles WHERE credits > 0),
  'negative_legacy_balance_count',
    (SELECT count(*) FROM public.profiles WHERE credits < 0),
  'active_analysis_reservation_count',
    (SELECT count(*) FROM public.analysis_credit_operations WHERE status = 'reserved'),
  'active_storyboard_job_count',
    (SELECT count(*) FROM public.storyboards
      WHERE deleted_at IS NULL AND status IN ('pending', 'processing')),
  'paddle_identifier_drift_count',
    (SELECT count(*) FROM public.profiles
      WHERE (paddle_subscription_id IS NOT NULL AND (
        paddle_subscription_id <> btrim(paddle_subscription_id)
        OR btrim(paddle_subscription_id) = ''
        OR length(btrim(paddle_subscription_id)) > 255
      )) OR (paddle_customer_id IS NOT NULL AND (
        paddle_customer_id <> btrim(paddle_customer_id)
        OR btrim(paddle_customer_id) = ''
        OR length(btrim(paddle_customer_id)) > 255
      ))),
  'subscription_without_customer_count',
    (SELECT count(*) FROM public.profiles
      WHERE NULLIF(btrim(paddle_subscription_id), '') IS NOT NULL
        AND NULLIF(btrim(paddle_customer_id), '') IS NULL),
  'subscription_invalid_plan_count',
    (SELECT count(*) FROM public.profiles
      WHERE NULLIF(btrim(paddle_subscription_id), '') IS NOT NULL
        AND COALESCE(plan, '') NOT IN ('free', 'paid', 'pro', 'enterprise')),
  'manifest_table_count',
    CASE WHEN to_regclass('promptgen_private.legacy_credit_classification_manifest') IS NULL
      THEN 0 ELSE 1 END,
  'manifest_row_count', current_setting('promptgen_clone.manifest_row_count')::bigint,
  'manifest_missing_count', current_setting('promptgen_clone.manifest_missing_count')::bigint,
  'manifest_extra_count', current_setting('promptgen_clone.manifest_extra_count')::bigint,
  'manifest_total_mismatch_count',
    current_setting('promptgen_clone.manifest_total_mismatch_count')::bigint,
  'manifest_invalid_count', current_setting('promptgen_clone.manifest_invalid_count')::bigint,
  'manifest_drift_count', current_setting('promptgen_clone.manifest_drift_count')::bigint,
  'manifest_guard_missing_count',
    current_setting('promptgen_clone.manifest_guard_missing_count')::bigint,
  'migration_024_landmark_count',
    CASE WHEN to_regclass('public.credit_lots') IS NULL THEN 0 ELSE 1 END
);

COMMIT;
