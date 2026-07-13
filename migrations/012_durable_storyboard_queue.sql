-- ============================================================
-- Migration 012: durable Storyboard queue and worker boundaries
--
-- Rollout order:
--   1. Verify there are no pending/processing jobs.
--   2. Apply this backward-compatible migration.
--   3. Deploy the server release containing the durable worker.
--
-- Existing completed/failed rows are preserved. Only jobs created by the new
-- enqueue_storyboard_job RPC receive credit_charged_at and are claimable.
-- ============================================================

BEGIN;

ALTER TABLE public.storyboards
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS credit_charged_at timestamptz,
  ADD COLUMN IF NOT EXISTS credit_refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.storyboards'::regclass
       AND conname = 'storyboards_attempt_count_check'
  ) THEN
    ALTER TABLE public.storyboards
      ADD CONSTRAINT storyboards_attempt_count_check
      CHECK (attempt_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.storyboards'::regclass
       AND conname = 'storyboards_max_attempts_check'
  ) THEN
    ALTER TABLE public.storyboards
      ADD CONSTRAINT storyboards_max_attempts_check
      CHECK (max_attempts BETWEEN 1 AND 10);
  END IF;
END;
$constraints$;

CREATE INDEX IF NOT EXISTS idx_storyboards_pending_queue
  ON public.storyboards (next_attempt_at, created_at)
  WHERE status = 'pending' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_storyboards_expired_leases
  ON public.storyboards (lease_expires_at)
  WHERE status = 'processing' AND deleted_at IS NULL;

-- Browser clients only read their own non-deleted Storyboards. Every mutation
-- is a backend operation so users cannot forge paid jobs or terminal states.
REVOKE ALL ON TABLE public.storyboards FROM anon, authenticated;
GRANT SELECT ON TABLE public.storyboards TO authenticated;
GRANT ALL ON TABLE public.storyboards TO service_role;

DROP POLICY IF EXISTS "storyboards: insert own" ON public.storyboards;
DROP POLICY IF EXISTS "storyboards: update own" ON public.storyboards;
DROP POLICY IF EXISTS "storyboards: delete own" ON public.storyboards;
DROP POLICY IF EXISTS "storyboards: select own" ON public.storyboards;

CREATE POLICY "storyboards: select own"
  ON public.storyboards
  FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = user_id AND deleted_at IS NULL);

-- Atomically create a job and charge it. A per-user transaction advisory lock
-- serializes concurrent submissions so the active-job limit cannot be raced.
CREATE OR REPLACE FUNCTION public.enqueue_storyboard_job(
  p_storyboard_id text,
  p_user_id uuid,
  p_scenario text,
  p_genres text[],
  p_style text,
  p_cut_count integer,
  p_reference_image_ids text[],
  p_credit_cost integer,
  p_max_concurrent integer,
  p_max_attempts integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_plan text;
  v_balance integer;
  v_active integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_storyboard_id IS NULL OR btrim(p_storyboard_id) = '' THEN
    RAISE EXCEPTION 'INVALID_STORYBOARD_ID' USING ERRCODE = '22023';
  END IF;
  IF p_credit_cost IS NULL OR p_credit_cost <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT' USING ERRCODE = '22023';
  END IF;
  IF p_max_concurrent IS NULL OR p_max_concurrent NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'INVALID_CONCURRENCY_LIMIT' USING ERRCODE = '22023';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'INVALID_MAX_ATTEMPTS' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  SELECT plan, credits
    INTO v_plan, v_balance
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF lower(COALESCE(v_plan, 'free')) <> ALL (ARRAY['pro', 'enterprise', 'paid']) THEN
    RAISE EXCEPTION 'PLAN_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;
  IF v_balance < p_credit_cost THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO v_active
    FROM public.storyboards
   WHERE user_id = p_user_id
     AND deleted_at IS NULL
     AND status IN ('pending', 'processing');

  IF v_active >= p_max_concurrent THEN
    RAISE EXCEPTION 'TOO_MANY_CONCURRENT_JOBS' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.storyboards (
    id,
    user_id,
    scenario,
    genres,
    style,
    cut_count,
    reference_image_ids,
    status,
    credits_used,
    attempt_count,
    max_attempts,
    next_attempt_at,
    credit_charged_at
  )
  VALUES (
    p_storyboard_id,
    p_user_id,
    p_scenario,
    p_genres,
    p_style,
    p_cut_count,
    COALESCE(p_reference_image_ids, ARRAY[]::text[]),
    'pending',
    p_credit_cost,
    0,
    p_max_attempts,
    v_now,
    v_now
  );

  UPDATE public.profiles
     SET credits = credits - p_credit_cost
   WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'storyboardId', p_storyboard_id,
    'status', 'pending',
    'newBalance', v_balance - p_credit_cost
  );
END;
$function$;

-- Claim ready jobs with row locks. Before claiming, atomically finalize and
-- refund expired jobs that already exhausted their durable attempt budget.
CREATE OR REPLACE FUNCTION public.claim_storyboard_jobs(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
)
RETURNS SETOF public.storyboards
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_expired record;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'INVALID_WORKER_ID' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'INVALID_CLAIM_LIMIT' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'INVALID_LEASE_SECONDS' USING ERRCODE = '22023';
  END IF;

  FOR v_expired IN
    SELECT s.id, s.user_id, s.credits_used
      FROM public.storyboards s
     WHERE s.status = 'processing'
       AND s.deleted_at IS NULL
       AND s.credit_charged_at IS NOT NULL
       AND s.credit_refunded_at IS NULL
       AND s.lease_expires_at <= now()
       AND s.attempt_count >= s.max_attempts
     ORDER BY s.lease_expires_at
     FOR UPDATE SKIP LOCKED
     LIMIT 100
  LOOP
    UPDATE public.storyboards
       SET status = 'failed',
           current_step = NULL,
           progress = 0,
           failed_at = clock_timestamp(),
           credit_refunded_at = clock_timestamp(),
           lease_expires_at = NULL,
           claim_token = NULL,
           worker_id = NULL,
           error_message = left(
             COALESCE(error_message || ' | ', '') ||
             'Lease expired after maximum attempts | REFUND: durable_worker_exhausted',
             4000
           )
     WHERE id = v_expired.id
       AND status = 'processing'
       AND credit_refunded_at IS NULL;

    IF FOUND THEN
      UPDATE public.profiles
         SET credits = credits + v_expired.credits_used
       WHERE id = v_expired.user_id;
    END IF;
  END LOOP;

  RETURN QUERY
  WITH candidates AS (
    SELECT s.id
      FROM public.storyboards s
     WHERE s.deleted_at IS NULL
       AND s.credit_charged_at IS NOT NULL
       AND s.credit_refunded_at IS NULL
       AND s.attempt_count < s.max_attempts
       AND (
         (s.status = 'pending' AND s.next_attempt_at <= now())
         OR
         (s.status = 'processing' AND s.lease_expires_at <= now())
       )
     ORDER BY
       CASE WHEN s.status = 'processing' THEN 0 ELSE 1 END,
       COALESCE(s.lease_expires_at, s.next_attempt_at),
       s.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE public.storyboards s
     SET status = 'processing',
         attempt_count = s.attempt_count + 1,
         claimed_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         claim_token = gen_random_uuid(),
         worker_id = p_worker_id,
         current_step = 'analyzing_scenario',
         progress = 0.1
    FROM candidates c
   WHERE s.id = c.id
  RETURNING s.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_storyboard_job(
  p_storyboard_id text,
  p_claim_token uuid,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'INVALID_LEASE_SECONDS' USING ERRCODE = '22023';
  END IF;

  UPDATE public.storyboards
     SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
   WHERE id = p_storyboard_id
     AND status = 'processing'
     AND deleted_at IS NULL
     AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_storyboard_job_progress(
  p_storyboard_id text,
  p_claim_token uuid,
  p_current_step text,
  p_progress double precision
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_progress IS NULL OR p_progress < 0 OR p_progress > 1 THEN
    RAISE EXCEPTION 'INVALID_PROGRESS' USING ERRCODE = '22023';
  END IF;

  UPDATE public.storyboards
     SET current_step = p_current_step,
         progress = p_progress
   WHERE id = p_storyboard_id
     AND status = 'processing'
     AND deleted_at IS NULL
     AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_storyboard_job(
  p_storyboard_id text,
  p_claim_token uuid,
  p_shots jsonb,
  p_characters jsonb,
  p_grid_storage_path text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_grid_storage_path IS NULL OR btrim(p_grid_storage_path) = '' THEN
    RAISE EXCEPTION 'INVALID_GRID_PATH' USING ERRCODE = '22023';
  END IF;

  UPDATE public.storyboards
     SET shots = p_shots,
         characters = p_characters,
         grid_storage_path = p_grid_storage_path,
         status = 'completed',
         progress = 1,
         current_step = NULL,
         completed_at = clock_timestamp(),
         failed_at = NULL,
         lease_expires_at = NULL,
         claim_token = NULL,
         worker_id = NULL,
         error_message = NULL
   WHERE id = p_storyboard_id
     AND status = 'processing'
     AND deleted_at IS NULL
     AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fail_storyboard_job(
  p_storyboard_id text,
  p_claim_token uuid,
  p_error_message text,
  p_retryable boolean,
  p_retry_base_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job public.storyboards%ROWTYPE;
  v_delay_seconds integer;
  v_refunded boolean := false;
BEGIN
  IF p_retry_base_seconds IS NULL OR p_retry_base_seconds NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'INVALID_RETRY_BASE_SECONDS' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_job
    FROM public.storyboards
   WHERE id = p_storyboard_id
     AND status = 'processing'
     AND claim_token = p_claim_token
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'claim_lost');
  END IF;

  IF COALESCE(p_retryable, false)
     AND v_job.deleted_at IS NULL
     AND v_job.attempt_count < v_job.max_attempts THEN
    v_delay_seconds := LEAST(
      600,
      p_retry_base_seconds * (2 ^ GREATEST(v_job.attempt_count - 1, 0))
    )::integer;

    UPDATE public.storyboards
       SET status = 'pending',
           current_step = 'retry_wait',
           progress = 0,
           next_attempt_at = clock_timestamp() + make_interval(secs => v_delay_seconds),
           lease_expires_at = NULL,
           claim_token = NULL,
           worker_id = NULL,
           error_message = left(COALESCE(p_error_message, 'Unknown retryable error'), 4000)
     WHERE id = p_storyboard_id;

    RETURN jsonb_build_object(
      'accepted', true,
      'status', 'pending',
      'retryInSeconds', v_delay_seconds,
      'refunded', false
    );
  END IF;

  UPDATE public.storyboards
     SET status = 'failed',
         current_step = NULL,
         progress = 0,
         failed_at = clock_timestamp(),
         credit_refunded_at = CASE
           WHEN credit_refunded_at IS NULL AND credit_charged_at IS NOT NULL
             THEN clock_timestamp()
           ELSE credit_refunded_at
         END,
         lease_expires_at = NULL,
         claim_token = NULL,
         worker_id = NULL,
         error_message = left(
           COALESCE(p_error_message, 'Unknown error') ||
           CASE
             WHEN credit_refunded_at IS NULL AND credit_charged_at IS NOT NULL
               THEN ' | REFUND: durable_worker_final_failure'
             ELSE ''
           END,
           4000
         )
   WHERE id = p_storyboard_id
  RETURNING (credit_refunded_at IS NOT NULL AND v_job.credit_refunded_at IS NULL)
       INTO v_refunded;

  IF v_refunded THEN
    UPDATE public.profiles
       SET credits = credits + v_job.credits_used
     WHERE id = v_job.user_id;
  END IF;

  RETURN jsonb_build_object(
    'accepted', true,
    'status', 'failed',
    'refunded', v_refunded
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_storyboard_job(
  text, uuid, text, text[], text, integer, text[], integer, integer, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_storyboard_jobs(text, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_storyboard_job(text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_storyboard_job_progress(text, uuid, text, double precision)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_storyboard_job(text, uuid, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_storyboard_job(text, uuid, text, boolean, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_storyboard_job(
  text, uuid, text, text[], text, integer, text[], integer, integer, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_storyboard_jobs(text, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_storyboard_job(text, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_storyboard_job_progress(text, uuid, text, double precision)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_storyboard_job(text, uuid, jsonb, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_storyboard_job(text, uuid, text, boolean, integer)
  TO service_role;

COMMIT;

-- Verification highlights:
--   authenticated INSERT/UPDATE/DELETE on storyboards: false
--   authenticated SELECT on storyboards: true
--   anon/authenticated EXECUTE on all six RPCs: false
--   service_role EXECUTE on all six RPCs: true
--   queue indexes exist and migration leaves historical rows untouched
