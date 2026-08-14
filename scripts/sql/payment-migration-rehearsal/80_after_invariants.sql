BEGIN TRANSACTION READ ONLY;

SELECT jsonb_build_object(
  'profile_balance_mismatch_count',
    (SELECT count(*)
       FROM public.profiles p
       LEFT JOIN (
         SELECT user_id, sum(credits_remaining)::integer AS active_credits
           FROM public.credit_lots
          WHERE status = 'active'
            AND (expires_at IS NULL OR expires_at > clock_timestamp())
          GROUP BY user_id
       ) l ON l.user_id = p.id
      WHERE p.credits <> COALESCE(l.active_credits, 0)),
  'credit_lot_state_violation_count',
    (SELECT count(*) FROM public.credit_lots
      WHERE credits_remaining < 0
         OR credits_expired < 0
         OR credits_remaining + credits_expired > credits_granted
         OR (status = 'active' AND (credits_remaining = 0 OR credits_expired <> 0))
         OR (status NOT IN ('active', 'quarantined') AND credits_remaining <> 0)),
  'credit_allocation_mismatch_count',
    (SELECT count(*)
       FROM public.credit_operations o
       LEFT JOIN (
         SELECT operation_key, sum(credits_allocated)::integer AS allocated
           FROM public.credit_operation_allocations
          GROUP BY operation_key
       ) a USING (operation_key)
      WHERE COALESCE(a.allocated, 0) <> o.credits_charged),
  'manifest_unconsumed_count',
    (SELECT count(*)
       FROM promptgen_private.legacy_credit_classification_manifest
      WHERE consumed_at IS NULL),
  'manifest_backfill_mismatch_count',
    (SELECT count(*)
       FROM promptgen_private.legacy_credit_classification_manifest m
       LEFT JOIN public.credit_lots l
         ON l.user_id = m.user_id
        AND l.source_id = 'legacy:' || m.batch_id::text || ':' || m.user_id::text
      WHERE l.id IS NULL
         OR l.source_kind IS DISTINCT FROM m.classification
         OR l.credits_granted IS DISTINCT FROM m.expected_credits
         OR l.credits_remaining IS DISTINCT FROM m.expected_credits
         OR l.status IS DISTINCT FROM 'active'
         OR l.expires_at IS NOT NULL),
  'active_analysis_reservation_count',
    (SELECT count(*) FROM public.analysis_credit_operations WHERE status = 'reserved'),
  'active_storyboard_job_count',
    (SELECT count(*) FROM public.storyboards
      WHERE deleted_at IS NULL AND status IN ('pending', 'processing')),
  'pending_event_lease_count',
    (SELECT count(*) FROM public.paddle_event_watermarks
      WHERE pending_event_id IS NOT NULL),
  'open_credit_pack_request_count',
    (SELECT count(*) FROM public.credit_pack_purchase_requests
      WHERE status IN ('previewing', 'created', 'charging', 'submitted', 'provider_unknown')),
  'open_subscription_checkout_count',
    (SELECT count(*) FROM public.subscription_checkout_attempts
      WHERE status IN ('created', 'charging', 'bound', 'provider_unknown'))
);

COMMIT;
