BEGIN TRANSACTION READ ONLY;

WITH expected_tables(schema_name, table_name, service_role_select_expected) AS (
  VALUES
    ('promptgen_private', 'legacy_credit_classification_manifest', false),
    ('public', 'credit_lots', true),
    ('public', 'credit_operations', true),
    ('public', 'credit_operation_allocations', true),
    ('public', 'credit_pack_checkout_intents', true),
    ('public', 'credit_pack_purchases', true),
    ('public', 'credit_pack_adjustments', true),
    ('public', 'paddle_event_watermarks', true),
    ('public', 'paddle_subscription_states', true),
    ('public', 'paddle_subscription_lifecycle_events', true),
    ('public', 'credit_pack_payment_receipts', true),
    ('public', 'credit_pack_adjustment_receipts', true),
    ('public', 'credit_pack_purchase_requests', true),
    ('public', 'credit_pack_purchase_reconciliation_scans', true),
    ('public', 'subscription_checkout_attempts', true),
    ('public', 'subscription_checkout_reconciliation_scans', true),
    ('public', 'subscription_checkout_late_payment_receipts', true)
),
expected_functions(function_name, identity_arguments, service_role_execute_expected) AS (
  VALUES
    ('sync_credit_lot_balance', 'uuid', false),
    ('consume_credit_lots', 'text, text, text, uuid, integer', false),
    ('complete_credit_operation', 'text, uuid', false),
    ('refund_credit_operation', 'text, uuid, text', false),
    ('register_credit_pack_checkout_intent',
      'text, uuid, text, text, text, text, integer, integer, text, integer', false),
    ('apply_credit_pack_purchase',
      'text, uuid, text, text, text, integer, integer, text, text, integer, timestamptz', false),
    ('apply_credit_pack_adjustment', 'text, text, text, text, text', false),
    ('apply_subscription_payment', 'text, uuid, text, integer, boolean', false),
    ('bridge_legacy_subscription_cancellation', '', false),
    ('expire_subscription_credits', 'uuid', false),
    ('apply_purchase_refund', 'text, text, integer, boolean', true),
    ('apply_plan_change', 'uuid, text, integer', false),
    ('reserve_analysis_operation', 'uuid, uuid, integer, integer', true),
    ('complete_analysis_operation', 'uuid, uuid, jsonb', true),
    ('refund_analysis_operation', 'uuid, uuid, text', true),
    ('refund_stale_analysis_operations', 'integer', true),
    ('enqueue_storyboard_job',
      'text, uuid, text, text[], text, integer, text[], integer, integer, integer', true),
    ('claim_storyboard_jobs', 'text, integer, integer', true),
    ('complete_storyboard_job', 'text, uuid, jsonb, jsonb, text', true),
    ('fail_storyboard_job', 'text, uuid, text, boolean, integer', true),
    ('claim_paddle_event_order',
      'text, text, text, text, timestamptz, uuid, integer', true),
    ('complete_paddle_event_order', 'text, text, text, uuid', true),
    ('fail_paddle_event_order', 'text, text, text, uuid', true),
    ('release_stale_paddle_event_order', 'text, text, text, uuid', true),
    ('apply_paddle_subscription_snapshot',
      'text, uuid, text, text, text, integer, text, text, timestamptz, boolean', true),
    ('apply_ordered_subscription_payment',
      'text, uuid, text, integer, text, text, timestamptz, boolean, boolean', true),
    ('begin_credit_pack_purchase_preview',
      'uuid, uuid, text, text, text, integer, integer, text, integer, timestamptz, text, timestamptz', true),
    ('finalize_credit_pack_purchase_preview',
      'uuid, uuid, integer, integer, integer, integer, integer, integer, integer, integer, integer, text', true),
    ('claim_credit_pack_purchase_request', 'uuid, uuid, text, text, text, integer', true),
    ('cancel_credit_pack_purchase_request', 'uuid, uuid, text', true),
    ('expire_credit_pack_purchase_request', 'uuid, uuid', true),
    ('transition_credit_pack_purchase_request', 'uuid, uuid, text, text', true),
    ('record_credit_pack_purchase_no_match_scan',
      'uuid, uuid, text, timestamptz, timestamptz, timestamptz, integer, integer, text[], text, text, text, text', true),
    ('finalize_credit_pack_purchase_no_match',
      'uuid, uuid, text, timestamptz, timestamptz, timestamptz, integer, integer, text[], text, text, text, text', true),
    ('apply_credit_pack_subscription_charge',
      'uuid, text, text, text, text, text, text, integer, integer, text, integer, integer, integer, integer, integer, integer, integer, integer, integer, timestamptz, text, timestamptz, timestamptz, text, text, text, text, timestamptz', true),
    ('apply_credit_pack_adjustment_v2',
      'text, text, text, text, text, text, timestamptz', true),
    ('create_subscription_checkout_attempt',
      'uuid, uuid, text, text, integer, integer, text', true),
    ('bind_subscription_checkout_transaction',
      'uuid, uuid, text, text, text, text, integer, integer, text, integer', true),
    ('transition_subscription_checkout_attempt', 'uuid, uuid, text, text', true),
    ('record_subscription_checkout_no_match_scan',
      'uuid, text, timestamptz, timestamptz, timestamptz, integer, integer, text[], text, text, text, text', true),
    ('finalize_subscription_checkout_no_match',
      'uuid, text, timestamptz, timestamptz, timestamptz, integer, integer, text[], text, text, text, text', true),
    ('consume_subscription_checkout_attempt',
      'uuid, text, text, text, text, text, text, text, integer, integer, text, integer, timestamptz, boolean', true),
    ('resolve_completed_subscription_checkout', 'uuid, text, text, text, text', true)
),
table_catalog AS (
  SELECT e.schema_name, e.table_name, e.service_role_select_expected,
         c.oid, c.relrowsecurity, c.relacl, c.relowner
    FROM expected_tables e
    LEFT JOIN pg_namespace n ON n.nspname = e.schema_name
    LEFT JOIN pg_class c ON c.relnamespace = n.oid
      AND c.relname = e.table_name AND c.relkind IN ('r', 'p')
),
function_catalog AS (
  SELECT e.function_name, e.identity_arguments, e.service_role_execute_expected,
         p.oid, p.prosecdef, p.proconfig, p.proacl, p.proowner
    FROM expected_functions e
    LEFT JOIN pg_proc p
      ON p.oid = to_regprocedure(
        format('public.%I(%s)', e.function_name, e.identity_arguments)
      )
),
table_acl_violations AS (
  SELECT count(*) AS violation_count
    FROM table_catalog c
    CROSS JOIN LATERAL aclexplode(
      COALESCE(c.relacl, acldefault('r', c.relowner))
    ) a
   LEFT JOIN pg_roles r ON r.oid = a.grantee
   WHERE c.oid IS NOT NULL
     AND a.grantee <> c.relowner
     AND NOT (
       (
         r.rolname IS NOT DISTINCT FROM 'service_role'
         AND a.grantor = c.relowner
         AND c.service_role_select_expected
         AND a.privilege_type = 'SELECT'
         AND NOT a.is_grantable
       )
       OR (
         r.rolname IS NOT DISTINCT FROM 'postgres'
         AND a.grantor = c.relowner
         AND c.schema_name = 'public'
         AND a.privilege_type = ANY(ARRAY[
           'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
           'REFERENCES', 'TRIGGER', 'MAINTAIN'
         ]::text[])
         AND NOT a.is_grantable
       )
     )
),
function_acl_violations AS (
  SELECT count(*) AS violation_count
    FROM function_catalog c
    CROSS JOIN LATERAL aclexplode(
      COALESCE(c.proacl, acldefault('f', c.proowner))
    ) a
   LEFT JOIN pg_roles r ON r.oid = a.grantee
   WHERE c.oid IS NOT NULL
     AND a.grantee <> c.proowner
     AND NOT (
       (
         r.rolname IS NOT DISTINCT FROM 'service_role'
         AND a.grantor = c.proowner
         AND c.service_role_execute_expected
         AND a.privilege_type = 'EXECUTE'
         AND NOT a.is_grantable
       )
       OR (
         r.rolname IS NOT DISTINCT FROM 'postgres'
         AND a.grantor = c.proowner
         AND a.privilege_type = 'EXECUTE'
         AND NOT a.is_grantable
       )
     )
),
private_schema_acl_violations AS (
  SELECT count(*) AS violation_count
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(
      COALESCE(n.nspacl, acldefault('n', n.nspowner))
    ) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'promptgen_private'
     AND a.grantee <> n.nspowner
)
SELECT jsonb_build_object(
  'missing_table_count',
    (SELECT count(*) FROM table_catalog WHERE oid IS NULL),
  'rls_disabled_count',
    (SELECT count(*) FROM table_catalog WHERE oid IS NOT NULL AND NOT relrowsecurity),
  'table_owner_mismatch_count',
    (SELECT count(*)
       FROM table_catalog
      WHERE oid IS NOT NULL
        AND relowner IS DISTINCT FROM
          (SELECT oid FROM pg_roles WHERE rolname = current_user)),
  'forbidden_table_grant_count',
    (SELECT violation_count FROM table_acl_violations),
  'private_schema_forbidden_grant_count',
    (SELECT violation_count FROM private_schema_acl_violations),
  'private_schema_owner_mismatch_count',
    (SELECT count(*)
       FROM pg_namespace
      WHERE nspname = 'promptgen_private'
        AND nspowner IS DISTINCT FROM
          (SELECT oid FROM pg_roles WHERE rolname = current_user)),
  'missing_service_role_count',
    CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
      THEN 0 ELSE 1 END,
  'missing_service_role_select_count',
    (SELECT count(*)
       FROM table_catalog c
      WHERE c.oid IS NOT NULL
        AND c.service_role_select_expected
        AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
        AND NOT has_table_privilege('service_role', c.oid, 'SELECT')),
  'missing_function_count',
    (SELECT count(*) FROM function_catalog WHERE oid IS NULL),
  'insecure_function_count',
    (SELECT count(*) FROM function_catalog
      WHERE oid IS NOT NULL AND (
        NOT prosecdef
        OR NOT (
          'search_path=public, pg_temp'
            = ANY(COALESCE(proconfig, ARRAY[]::text[]))
        )
        OR (
          SELECT count(*)
            FROM unnest(COALESCE(proconfig, ARRAY[]::text[])) setting
           WHERE setting LIKE 'search_path=%'
        ) <> 1
      )),
  'function_owner_mismatch_count',
    (SELECT count(*)
       FROM function_catalog
      WHERE oid IS NOT NULL
        AND proowner IS DISTINCT FROM
          (SELECT oid FROM pg_roles WHERE rolname = current_user)),
  'forbidden_function_grant_count',
    (SELECT violation_count FROM function_acl_violations),
  'missing_service_role_execute_count',
    (SELECT count(*)
      FROM function_catalog c
      WHERE c.oid IS NOT NULL
        AND c.service_role_execute_expected
        AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
        AND NOT has_function_privilege('service_role', c.oid, 'EXECUTE')),
  'forbidden_service_role_execute_count',
    (SELECT count(*)
      FROM function_catalog c
      WHERE c.oid IS NOT NULL
        AND NOT c.service_role_execute_expected
        AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
        AND has_function_privilege('service_role', c.oid, 'EXECUTE'))
);

COMMIT;
