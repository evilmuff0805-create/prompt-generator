-- ============================================================
-- Migration 024: Paddle immutable-event ordering and subscription state reducer
--
-- Paddle does not guarantee webhook delivery order. This migration adds a
-- per-entity lease/watermark for immutable transaction/adjustment edges and a
-- separate, atomic subscription lifecycle reducer. Subscription snapshots must
-- not share a watermark with transaction.completed: a newer transaction edge
-- must never cause an older-but-still-authoritative subscription snapshot to be
-- dropped.
--
-- Apply before deploying the server code that calls these RPCs.
-- ============================================================

BEGIN;

LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

-- Fail before creating reducer state if legacy profile bindings cannot be
-- represented by the canonical Paddle identifiers used by every runtime RPC.
-- Do not silently trim or reinterpret ambiguous billing ownership during a
-- migration; reconcile the profile against Paddle and rerun the migration.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE paddle_subscription_id IS NOT NULL
       AND (
         paddle_subscription_id <> btrim(paddle_subscription_id)
         OR btrim(paddle_subscription_id) = ''
         OR length(btrim(paddle_subscription_id)) > 255
       )
  ) THEN
    RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_BOOTSTRAP_INVALID_ID'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE paddle_customer_id IS NOT NULL
       AND (
         paddle_customer_id <> btrim(paddle_customer_id)
         OR btrim(paddle_customer_id) = ''
         OR length(btrim(paddle_customer_id)) > 255
       )
  ) THEN
    RAISE EXCEPTION 'PADDLE_CUSTOMER_BOOTSTRAP_INVALID_ID'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE paddle_subscription_id IS NOT NULL
       AND btrim(paddle_subscription_id) <> ''
       AND paddle_customer_id IS NULL
  ) THEN
    RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_BOOTSTRAP_CUSTOMER_REQUIRED'
      USING ERRCODE = '23502';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE paddle_subscription_id IS NOT NULL
       AND btrim(paddle_subscription_id) <> ''
       AND COALESCE(plan, '') NOT IN ('free', 'paid', 'pro', 'enterprise')
  ) THEN
    RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_BOOTSTRAP_INVALID_PLAN'
      USING ERRCODE = '22023';
  END IF;
END;
$preflight$;

CREATE TABLE public.paddle_event_watermarks (
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  last_event_id text,
  last_event_type text,
  last_occurred_at timestamptz,
  pending_event_id text,
  pending_event_type text,
  pending_occurred_at timestamptz,
  pending_claim_token uuid,
  pending_claimed_at timestamptz,
  pending_lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id),
  CONSTRAINT paddle_event_watermarks_entity_type_check
    CHECK (entity_type IN ('transaction', 'adjustment')),
  CONSTRAINT paddle_event_watermarks_entity_id_check
    CHECK (btrim(entity_id) <> '' AND length(entity_id) <= 255),
  CONSTRAINT paddle_event_watermarks_last_state_check
    CHECK (
      (
        last_event_id IS NULL
        AND last_event_type IS NULL
        AND last_occurred_at IS NULL
      )
      OR
      (
        last_event_id IS NOT NULL
        AND last_event_type IS NOT NULL
        AND last_occurred_at IS NOT NULL
      )
    ),
  CONSTRAINT paddle_event_watermarks_pending_state_check
    CHECK (
      (
        pending_event_id IS NULL
        AND pending_event_type IS NULL
        AND pending_occurred_at IS NULL
        AND pending_claim_token IS NULL
        AND pending_claimed_at IS NULL
        AND pending_lease_expires_at IS NULL
      )
      OR
      (
        pending_event_id IS NOT NULL
        AND pending_event_type IS NOT NULL
        AND pending_occurred_at IS NOT NULL
        AND pending_claim_token IS NOT NULL
        AND pending_claimed_at IS NOT NULL
        AND pending_lease_expires_at IS NOT NULL
      )
    )
);

CREATE INDEX paddle_event_watermarks_pending_lease_idx
  ON public.paddle_event_watermarks (pending_lease_expires_at)
  WHERE pending_event_id IS NOT NULL;

ALTER TABLE public.paddle_event_watermarks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.paddle_event_watermarks
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.paddle_event_watermarks TO service_role;

CREATE TABLE public.paddle_subscription_states (
  subscription_id text PRIMARY KEY,
  user_id uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  customer_id text,
  lifecycle_status text NOT NULL DEFAULT 'unknown',
  terminal boolean NOT NULL DEFAULT false,
  last_snapshot_event_id text,
  last_snapshot_event_type text,
  last_snapshot_occurred_at timestamptz,
  last_payment_transaction_id text,
  last_payment_occurred_at timestamptz,
  terminal_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paddle_subscription_states_subscription_id_check
    CHECK (btrim(subscription_id) <> '' AND length(subscription_id) <= 255),
  CONSTRAINT paddle_subscription_states_customer_id_check
    CHECK (
      customer_id IS NULL
      OR (btrim(customer_id) <> '' AND length(customer_id) <= 255)
    ),
  CONSTRAINT paddle_subscription_states_lifecycle_status_check
    CHECK (
      lifecycle_status IN (
        'unknown',
        'active',
        'trialing',
        'past_due',
        'paused',
        'canceled'
      )
    ),
  CONSTRAINT paddle_subscription_states_snapshot_set_check
    CHECK (
      (
        last_snapshot_event_id IS NULL
        AND last_snapshot_event_type IS NULL
        AND last_snapshot_occurred_at IS NULL
      )
      OR
      (
        last_snapshot_event_id IS NOT NULL
        AND last_snapshot_event_type IS NOT NULL
        AND last_snapshot_occurred_at IS NOT NULL
      )
    ),
  CONSTRAINT paddle_subscription_states_payment_set_check
    CHECK (
      (
        last_payment_transaction_id IS NULL
        AND last_payment_occurred_at IS NULL
      )
      OR
      (
        last_payment_transaction_id IS NOT NULL
        AND btrim(last_payment_transaction_id) <> ''
        AND length(last_payment_transaction_id) <= 255
        AND last_payment_occurred_at IS NOT NULL
      )
    ),
  CONSTRAINT paddle_subscription_states_terminal_check
    CHECK (
      (terminal = false AND terminal_at IS NULL)
      OR
      (
        terminal = true
        AND lifecycle_status = 'canceled'
        AND terminal_at IS NOT NULL
      )
    )
);

CREATE INDEX paddle_subscription_states_user_idx
  ON public.paddle_subscription_states (user_id);
CREATE INDEX paddle_subscription_states_customer_idx
  ON public.paddle_subscription_states (customer_id)
  WHERE customer_id IS NOT NULL;

ALTER TABLE public.paddle_subscription_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.paddle_subscription_states
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.paddle_subscription_states TO service_role;

-- Keep every signed lifecycle snapshot, including a stale snapshot that
-- arrives after a newer one. The latest-state reducer alone cannot answer
-- whether a subscription was paused, past due, or canceled at an earlier
-- transaction.completed occurred_at.
CREATE TABLE public.paddle_subscription_lifecycle_events (
  provider_event_id text PRIMARY KEY,
  subscription_id text NOT NULL,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  customer_id text,
  lifecycle_status text NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT paddle_subscription_lifecycle_events_event_id_check
    CHECK (btrim(provider_event_id) <> '' AND length(provider_event_id) <= 255),
  CONSTRAINT paddle_subscription_lifecycle_events_subscription_id_check
    CHECK (btrim(subscription_id) <> '' AND length(subscription_id) <= 255),
  CONSTRAINT paddle_subscription_lifecycle_events_customer_id_check
    CHECK (
      customer_id IS NULL
      OR (btrim(customer_id) <> '' AND length(customer_id) <= 255)
    ),
  CONSTRAINT paddle_subscription_lifecycle_events_status_check
    CHECK (
      lifecycle_status IN (
        'unknown',
        'active',
        'trialing',
        'past_due',
        'paused',
        'canceled'
      )
    ),
  CONSTRAINT paddle_subscription_lifecycle_events_type_check
    CHECK (
      event_type IN ('subscription.updated', 'subscription.canceled')
    )
);

CREATE INDEX paddle_subscription_lifecycle_events_subscription_time_idx
  ON public.paddle_subscription_lifecycle_events (
    subscription_id,
    occurred_at,
    provider_event_id
  );
CREATE INDEX paddle_subscription_lifecycle_events_user_idx
  ON public.paddle_subscription_lifecycle_events (user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX paddle_subscription_lifecycle_events_ineligible_idx
  ON public.paddle_subscription_lifecycle_events (
    subscription_id,
    occurred_at
  )
  WHERE lifecycle_status IN ('past_due', 'paused', 'canceled');

ALTER TABLE public.paddle_subscription_lifecycle_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.paddle_subscription_lifecycle_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT
  ON TABLE public.paddle_subscription_lifecycle_events TO service_role;

-- Bootstrap every subscription already linked to a profile with one shared
-- timestamp. This is intentionally conservative: paid profiles remain active,
-- while a profile already recorded as free becomes terminal and cannot be
-- revived by a delayed renewal transaction. Rollout must reconcile these
-- bootstrap rows against Paddle before webhook intake is reopened.
DO $bootstrap$
DECLARE
  v_bootstrap timestamptz := clock_timestamp();
BEGIN
  IF EXISTS (
    SELECT btrim(paddle_subscription_id)
      FROM public.profiles
     WHERE paddle_subscription_id IS NOT NULL
       AND btrim(paddle_subscription_id) <> ''
     GROUP BY btrim(paddle_subscription_id)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_BOOTSTRAP_DUPLICATE'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT btrim(paddle_customer_id)
      FROM public.profiles
     WHERE paddle_customer_id IS NOT NULL
       AND btrim(paddle_customer_id) <> ''
     GROUP BY btrim(paddle_customer_id)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PADDLE_CUSTOMER_BOOTSTRAP_DUPLICATE'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.paddle_subscription_states (
    subscription_id,
    user_id,
    customer_id,
    lifecycle_status,
    terminal,
    last_snapshot_event_id,
    last_snapshot_event_type,
    last_snapshot_occurred_at,
    terminal_at,
    updated_at
  )
  SELECT
    btrim(p.paddle_subscription_id),
    p.id,
    NULLIF(btrim(p.paddle_customer_id), ''),
    CASE
      WHEN COALESCE(p.plan, 'free') IN ('pro', 'enterprise', 'paid')
        THEN 'active'
      ELSE 'canceled'
    END,
    COALESCE(p.plan, 'free') NOT IN ('pro', 'enterprise', 'paid'),
    left('migration-bootstrap:' || btrim(p.paddle_subscription_id), 255),
    'migration.bootstrap',
    v_bootstrap,
    CASE
      WHEN COALESCE(p.plan, 'free') IN ('pro', 'enterprise', 'paid')
        THEN NULL
      ELSE v_bootstrap
    END,
    v_bootstrap
  FROM public.profiles p
  WHERE p.paddle_subscription_id IS NOT NULL
    AND btrim(p.paddle_subscription_id) <> '';
END;
$bootstrap$;

CREATE OR REPLACE FUNCTION public.claim_paddle_event_order(
  p_provider_event_id text,
  p_event_type text,
  p_entity_type text,
  p_entity_id text,
  p_occurred_at timestamptz,
  p_claim_token uuid,
  p_lease_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_row public.paddle_event_watermarks%ROWTYPE;
BEGIN
  IF p_provider_event_id IS NULL
     OR btrim(p_provider_event_id) = ''
     OR length(p_provider_event_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_PADDLE_PROVIDER_EVENT_ID' USING ERRCODE = '22023';
  END IF;
  IF p_event_type IS NULL
     OR btrim(p_event_type) = ''
     OR length(p_event_type) > 100 THEN
    RAISE EXCEPTION 'INVALID_PADDLE_EVENT_TYPE' USING ERRCODE = '22023';
  END IF;
  IF p_entity_type NOT IN ('transaction', 'adjustment') THEN
    RAISE EXCEPTION 'INVALID_PADDLE_ENTITY_TYPE' USING ERRCODE = '22023';
  END IF;
  IF p_entity_id IS NULL
     OR btrim(p_entity_id) = ''
     OR length(p_entity_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_PADDLE_ENTITY_ID' USING ERRCODE = '22023';
  END IF;
  IF p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_PADDLE_OCCURRED_AT' USING ERRCODE = '22023';
  END IF;
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'INVALID_PADDLE_ORDER_CLAIM_TOKEN' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'INVALID_PADDLE_ORDER_LEASE_SECONDS' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.paddle_event_watermarks (entity_type, entity_id)
  VALUES (p_entity_type, p_entity_id)
  ON CONFLICT (entity_type, entity_id) DO NOTHING;

  SELECT *
    INTO v_row
    FROM public.paddle_event_watermarks
   WHERE entity_type = p_entity_type
     AND entity_id = p_entity_id
   FOR UPDATE;

  IF v_row.last_event_id = p_provider_event_id THEN
    RETURN jsonb_build_object(
      'outcome', 'completed',
      'lastOccurredAt', v_row.last_occurred_at
    );
  END IF;

  IF v_row.last_occurred_at IS NOT NULL
     AND p_occurred_at < v_row.last_occurred_at THEN
    RETURN jsonb_build_object(
      'outcome', 'stale',
      'lastEventId', v_row.last_event_id,
      'lastOccurredAt', v_row.last_occurred_at
    );
  END IF;

  -- Paddle timestamps may carry equal precision for different events. There is
  -- no safe total order in that case, so money mutations stop for operator
  -- reconciliation instead of silently classifying one event as stale.
  IF v_row.last_occurred_at IS NOT NULL
     AND p_occurred_at = v_row.last_occurred_at THEN
    RETURN jsonb_build_object(
      'outcome', 'ambiguous',
      'reconciliationRequired', true,
      'lastEventId', v_row.last_event_id,
      'lastOccurredAt', v_row.last_occurred_at
    );
  END IF;

  -- Never auto-steal an expired entity lease. The previous worker may still
  -- resume and its business RPCs are not all fenced by this token. A stale
  -- pending row is therefore an operator-reconciliation event, not an automatic
  -- takeover. This prefers delayed processing over conflicting money mutations.
  IF v_row.pending_event_id IS NOT NULL THEN
    IF v_row.pending_event_id <> p_provider_event_id
       AND v_row.pending_occurred_at = p_occurred_at THEN
      RETURN jsonb_build_object(
        'outcome', 'ambiguous',
        'reconciliationRequired', true,
        'pendingEventId', v_row.pending_event_id,
        'pendingOccurredAt', v_row.pending_occurred_at
      );
    END IF;

    RETURN jsonb_build_object(
      'outcome', 'busy',
      'pendingEventId', v_row.pending_event_id,
      'pendingClaimedAt', v_row.pending_claimed_at,
      'leaseExpiresAt', v_row.pending_lease_expires_at,
      'leaseExpired', v_row.pending_lease_expires_at <= v_now
    );
  END IF;

  UPDATE public.paddle_event_watermarks
     SET pending_event_id = p_provider_event_id,
         pending_event_type = p_event_type,
         pending_occurred_at = p_occurred_at,
         pending_claim_token = p_claim_token,
         pending_claimed_at = v_now,
         pending_lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
         updated_at = v_now
   WHERE entity_type = p_entity_type
     AND entity_id = p_entity_id;

  RETURN jsonb_build_object(
    'outcome', 'claimed',
    'leaseExpiresAt', v_now + make_interval(secs => p_lease_seconds)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_paddle_event_order(
  p_entity_type text,
  p_entity_id text,
  p_provider_event_id text,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.paddle_event_watermarks
     SET last_event_id = pending_event_id,
         last_event_type = pending_event_type,
         last_occurred_at = pending_occurred_at,
         pending_event_id = NULL,
         pending_event_type = NULL,
         pending_occurred_at = NULL,
         pending_claim_token = NULL,
         pending_claimed_at = NULL,
         pending_lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE entity_type = p_entity_type
     AND entity_id = p_entity_id
     AND pending_event_id = p_provider_event_id
     AND pending_claim_token = p_claim_token;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fail_paddle_event_order(
  p_entity_type text,
  p_entity_id text,
  p_provider_event_id text,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.paddle_event_watermarks
     SET pending_event_id = NULL,
         pending_event_type = NULL,
         pending_occurred_at = NULL,
         pending_claim_token = NULL,
         pending_claimed_at = NULL,
         pending_lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE entity_type = p_entity_type
     AND entity_id = p_entity_id
     AND pending_event_id = p_provider_event_id
     AND pending_claim_token = p_claim_token;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$function$;

-- Operator-only recovery primitive. Before calling it, terminate the worker
-- that owned the token and reconcile the Paddle entity state. The application
-- never calls this RPC automatically.
CREATE OR REPLACE FUNCTION public.release_stale_paddle_event_order(
  p_entity_type text,
  p_entity_id text,
  p_provider_event_id text,
  p_expected_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.paddle_event_watermarks
     SET pending_event_id = NULL,
         pending_event_type = NULL,
         pending_occurred_at = NULL,
         pending_claim_token = NULL,
         pending_claimed_at = NULL,
         pending_lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE entity_type = p_entity_type
     AND entity_id = p_entity_id
     AND pending_event_id = p_provider_event_id
     AND pending_claim_token = p_expected_claim_token
     AND pending_lease_expires_at <= clock_timestamp();

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$function$;

-- Atomically reduce an authoritative Paddle subscription snapshot and mutate
-- the matching entitlement. The state row is always locked before any profile,
-- purchase, or credit-lot mutation, which is the same lock order used by
-- apply_ordered_subscription_payment below.
CREATE OR REPLACE FUNCTION public.apply_paddle_subscription_snapshot(
  p_subscription_id text,
  p_user_id uuid,
  p_customer_id text,
  p_status text,
  p_plan text,
  p_allotment integer,
  p_provider_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_skip_entitlement_mutation boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_state public.paddle_subscription_states%ROWTYPE;
  v_lifecycle_event public.paddle_subscription_lifecycle_events%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_customer_id text := NULLIF(btrim(p_customer_id), '');
  v_status text := lower(btrim(p_status));
  v_plan text := lower(btrim(p_plan));
  v_is_current_subscription boolean;
  v_entitlement_result jsonb;
BEGIN
  IF p_subscription_id IS NULL
     OR btrim(p_subscription_id) = ''
     OR length(p_subscription_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_PADDLE_SUBSCRIPTION_ID' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_USER_ID' USING ERRCODE = '22023';
  END IF;
  IF v_customer_id IS NOT NULL AND length(v_customer_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_PADDLE_CUSTOMER_ID' USING ERRCODE = '22023';
  END IF;
  IF v_status IS NULL
     OR v_status NOT IN (
       'unknown',
       'active',
       'trialing',
       'past_due',
       'paused',
       'canceled'
     ) THEN
    RAISE EXCEPTION 'INVALID_PADDLE_SUBSCRIPTION_STATUS' USING ERRCODE = '22023';
  END IF;
  IF p_provider_event_id IS NULL
     OR btrim(p_provider_event_id) = ''
     OR length(p_provider_event_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_PADDLE_PROVIDER_EVENT_ID' USING ERRCODE = '22023';
  END IF;
  IF p_event_type IS NULL
     OR btrim(p_event_type) = ''
     OR length(p_event_type) > 100
     OR p_event_type NOT IN ('subscription.updated', 'subscription.canceled') THEN
    RAISE EXCEPTION 'INVALID_PADDLE_EVENT_TYPE' USING ERRCODE = '22023';
  END IF;
  IF p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_PADDLE_OCCURRED_AT' USING ERRCODE = '22023';
  END IF;
  IF v_status IN ('active', 'trialing')
     AND (
       v_plan IS NULL
       OR v_plan NOT IN ('pro', 'enterprise')
       OR p_allotment IS NULL
       OR p_allotment <= 0
     ) THEN
    RAISE EXCEPTION 'INVALID_PADDLE_ACTIVE_ENTITLEMENT' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.paddle_subscription_states (
    subscription_id,
    user_id,
    customer_id
  ) VALUES (
    btrim(p_subscription_id),
    p_user_id,
    v_customer_id
  )
  ON CONFLICT (subscription_id) DO NOTHING;

  SELECT *
    INTO v_state
    FROM public.paddle_subscription_states
   WHERE subscription_id = btrim(p_subscription_id)
   FOR UPDATE;

  IF v_state.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_USER_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF v_state.customer_id IS NOT NULL
     AND v_customer_id IS NOT NULL
     AND v_state.customer_id <> v_customer_id THEN
    RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_CUSTOMER_CONFLICT' USING ERRCODE = '23505';
  END IF;

  IF v_state.customer_id IS NULL AND v_customer_id IS NOT NULL THEN
    UPDATE public.paddle_subscription_states
       SET customer_id = v_customer_id,
           updated_at = v_now
     WHERE subscription_id = v_state.subscription_id;
    v_state.customer_id := v_customer_id;
  END IF;

  INSERT INTO public.paddle_subscription_lifecycle_events (
    provider_event_id,
    subscription_id,
    user_id,
    customer_id,
    lifecycle_status,
    event_type,
    occurred_at
  ) VALUES (
    btrim(p_provider_event_id),
    btrim(p_subscription_id),
    p_user_id,
    v_customer_id,
    v_status,
    p_event_type,
    p_occurred_at
  )
  ON CONFLICT (provider_event_id) DO NOTHING;

  SELECT *
    INTO v_lifecycle_event
    FROM public.paddle_subscription_lifecycle_events
   WHERE provider_event_id = btrim(p_provider_event_id);

  IF NOT FOUND
     OR v_lifecycle_event.subscription_id IS DISTINCT FROM btrim(p_subscription_id)
     OR v_lifecycle_event.user_id IS DISTINCT FROM p_user_id
     OR v_lifecycle_event.customer_id IS DISTINCT FROM v_customer_id
     OR v_lifecycle_event.lifecycle_status IS DISTINCT FROM v_status
     OR v_lifecycle_event.event_type IS DISTINCT FROM p_event_type
     OR v_lifecycle_event.occurred_at IS DISTINCT FROM p_occurred_at THEN
    RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_EVENT_ID_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  IF v_state.last_snapshot_event_id = p_provider_event_id THEN
    IF v_state.last_snapshot_event_type IS DISTINCT FROM p_event_type
       OR v_state.last_snapshot_occurred_at IS DISTINCT FROM p_occurred_at THEN
      RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_EVENT_ID_CONFLICT'
        USING ERRCODE = '23505';
    END IF;

    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'terminal', v_state.terminal,
      'lifecycleStatus', v_state.lifecycle_status
    );
  END IF;

  IF v_state.last_snapshot_occurred_at IS NOT NULL
     AND p_occurred_at < v_state.last_snapshot_occurred_at THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'stale',
      'terminal', v_state.terminal,
      'lifecycleStatus', v_state.lifecycle_status,
      'lastEventId', v_state.last_snapshot_event_id,
      'lastOccurredAt', v_state.last_snapshot_occurred_at
    );
  END IF;

  IF v_state.last_snapshot_occurred_at IS NOT NULL
     AND p_occurred_at = v_state.last_snapshot_occurred_at THEN
    -- The immutable event was inserted above. Return a fail-closed outcome
    -- instead of raising, because an exception would roll that evidence back.
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'reconciliation_required',
      'terminal', v_state.terminal,
      'lifecycleStatus', v_state.lifecycle_status,
      'lastEventId', v_state.last_snapshot_event_id,
      'incomingEventId', btrim(p_provider_event_id),
      'occurredAt', p_occurred_at
    );
  END IF;

  -- Different Paddle subscription IDs have independent reducer rows, but they
  -- mutate one user entitlement. Lock the profile inside this transaction and
  -- re-check the current binding so a late event from a superseded subscription
  -- cannot cancel or overwrite a newer subscription.
  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(btrim(v_profile.paddle_customer_id), '') IS NOT NULL
     AND v_customer_id IS NOT NULL
     AND NULLIF(btrim(v_profile.paddle_customer_id), '') <> v_customer_id THEN
    RAISE EXCEPTION 'PADDLE_CUSTOMER_USER_CONFLICT' USING ERRCODE = '23505';
  END IF;
  v_is_current_subscription :=
    NULLIF(btrim(v_profile.paddle_subscription_id), '')
      IS NOT DISTINCT FROM NULLIF(btrim(p_subscription_id), '');

  -- Cancellation is terminal regardless of whether Paddle delivered it as
  -- subscription.updated or subscription.canceled.
  IF v_status = 'canceled' THEN
    IF COALESCE(p_skip_entitlement_mutation, false) THEN
      v_entitlement_result := jsonb_build_object(
        'applied', false,
        'reason', 'entitlement_mutation_skipped'
      );
    ELSIF NOT v_is_current_subscription THEN
      v_entitlement_result := jsonb_build_object(
        'applied', false,
        'reason', 'superseded_subscription'
      );
    ELSE
      v_entitlement_result := public.expire_subscription_credits(p_user_id);
    END IF;

    UPDATE public.paddle_subscription_states
       SET customer_id = COALESCE(customer_id, v_customer_id),
           lifecycle_status = 'canceled',
           terminal = true,
           last_snapshot_event_id = p_provider_event_id,
           last_snapshot_event_type = p_event_type,
           last_snapshot_occurred_at = p_occurred_at,
           terminal_at = COALESCE(terminal_at, p_occurred_at),
           updated_at = v_now
     WHERE subscription_id = v_state.subscription_id;

    RETURN jsonb_build_object(
      'applied', true,
      'reason', CASE
        WHEN COALESCE(p_skip_entitlement_mutation, false)
          THEN 'cancellation_recorded_entitlement_skipped'
        WHEN NOT v_is_current_subscription
          THEN 'cancellation_recorded_superseded_subscription'
        ELSE 'subscription_canceled'
      END,
      'terminal', true,
      'lifecycleStatus', 'canceled',
      'entitlementResult', v_entitlement_result
    );
  END IF;

  -- A terminal subscription ID can never be reactivated. A genuinely new
  -- subscription receives a new Paddle subscription ID and therefore a new
  -- reducer row.
  IF v_state.terminal THEN
    UPDATE public.paddle_subscription_states
       SET customer_id = COALESCE(customer_id, v_customer_id),
           last_snapshot_event_id = p_provider_event_id,
           last_snapshot_event_type = p_event_type,
           last_snapshot_occurred_at = p_occurred_at,
           updated_at = v_now
     WHERE subscription_id = v_state.subscription_id;

    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'terminal_subscription',
      'terminal', true,
      'lifecycleStatus', 'canceled'
    );
  END IF;

  IF v_status IN ('active', 'trialing') THEN
    IF COALESCE(p_skip_entitlement_mutation, false) THEN
      v_entitlement_result := jsonb_build_object(
        'applied', false,
        'reason', 'entitlement_mutation_skipped'
      );
    ELSIF NOT v_is_current_subscription THEN
      v_entitlement_result := jsonb_build_object(
        'applied', false,
        'reason', 'superseded_subscription'
      );
    ELSE
      v_entitlement_result := jsonb_build_object(
        'applied', true,
        'newBalance', public.apply_plan_change(
          p_user_id,
          v_plan,
          p_allotment
        )
      );
    END IF;

    UPDATE public.paddle_subscription_states
       SET customer_id = COALESCE(customer_id, v_customer_id),
           lifecycle_status = v_status,
           last_snapshot_event_id = p_provider_event_id,
           last_snapshot_event_type = p_event_type,
           last_snapshot_occurred_at = p_occurred_at,
           updated_at = v_now
     WHERE subscription_id = v_state.subscription_id;

    RETURN jsonb_build_object(
      'applied', true,
      'reason', CASE
        WHEN COALESCE(p_skip_entitlement_mutation, false)
          THEN 'snapshot_recorded_entitlement_skipped'
        WHEN NOT v_is_current_subscription
          THEN 'snapshot_recorded_superseded_subscription'
        ELSE 'subscription_entitlement_applied'
      END,
      'terminal', false,
      'lifecycleStatus', v_status,
      'entitlementResult', v_entitlement_result
    );
  END IF;

  -- past_due, paused, and unknown snapshots are recorded, but intentionally
  -- preserve the current entitlement until Paddle supplies a terminal
  -- cancellation or an active/trialing entitlement snapshot.
  UPDATE public.paddle_subscription_states
     SET customer_id = COALESCE(customer_id, v_customer_id),
         lifecycle_status = v_status,
         last_snapshot_event_id = p_provider_event_id,
         last_snapshot_event_type = p_event_type,
         last_snapshot_occurred_at = p_occurred_at,
         updated_at = v_now
   WHERE subscription_id = v_state.subscription_id;

  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'entitlement_preserved',
    'terminal', false,
    'lifecycleStatus', v_status
  );
END;
$function$;

-- Record an immutable subscription payment while serializing against lifecycle
-- snapshots for the same subscription. A terminal subscription still records
-- the purchase for accounting/idempotency, but always forces the existing
-- payment RPC into its no-entitlement mode.
CREATE OR REPLACE FUNCTION public.apply_ordered_subscription_payment(
  p_transaction_id text,
  p_user_id uuid,
  p_plan text,
  p_amount integer,
  p_subscription_id text,
  p_customer_id text,
  p_occurred_at timestamptz,
  p_skip_entitlement_mutation boolean,
  p_allow_subscription_rebind boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_state public.paddle_subscription_states%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_customer_id text := NULLIF(btrim(p_customer_id), '');
  v_plan text := lower(btrim(p_plan));
  v_is_current_subscription boolean;
  v_order_reason text;
  v_business_reason text;
  v_effective_skip boolean;
  v_payment_result jsonb;
  v_bound_count integer;
BEGIN
  IF p_transaction_id IS NULL
     OR btrim(p_transaction_id) = ''
     OR length(p_transaction_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_USER_ID' USING ERRCODE = '22023';
  END IF;
  IF v_plan IS NULL OR v_plan NOT IN ('pro', 'enterprise') THEN
    RAISE EXCEPTION 'INVALID_PLAN' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT' USING ERRCODE = '22023';
  END IF;
  IF p_subscription_id IS NULL
     OR btrim(p_subscription_id) = ''
     OR length(p_subscription_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_PADDLE_SUBSCRIPTION_ID' USING ERRCODE = '22023';
  END IF;
  IF v_customer_id IS NOT NULL AND length(v_customer_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_PADDLE_CUSTOMER_ID' USING ERRCODE = '22023';
  END IF;
  IF p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_OCCURRED_AT' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.paddle_subscription_states (
    subscription_id,
    user_id,
    customer_id
  ) VALUES (
    btrim(p_subscription_id),
    p_user_id,
    v_customer_id
  )
  ON CONFLICT (subscription_id) DO NOTHING;

  SELECT *
    INTO v_state
    FROM public.paddle_subscription_states
   WHERE subscription_id = btrim(p_subscription_id)
   FOR UPDATE;

  IF v_state.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_USER_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF v_state.customer_id IS NOT NULL
     AND v_customer_id IS NOT NULL
     AND v_state.customer_id <> v_customer_id THEN
    RAISE EXCEPTION 'PADDLE_SUBSCRIPTION_CUSTOMER_CONFLICT' USING ERRCODE = '23505';
  END IF;

  IF v_state.customer_id IS NULL AND v_customer_id IS NOT NULL THEN
    UPDATE public.paddle_subscription_states
       SET customer_id = v_customer_id,
           updated_at = clock_timestamp()
     WHERE subscription_id = v_state.subscription_id;
    v_state.customer_id := v_customer_id;
  END IF;

  SELECT *
    INTO v_profile
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(btrim(v_profile.paddle_customer_id), '') IS NOT NULL
     AND v_customer_id IS NOT NULL
     AND NULLIF(btrim(v_profile.paddle_customer_id), '') <> v_customer_id THEN
    RAISE EXCEPTION 'PADDLE_CUSTOMER_USER_CONFLICT' USING ERRCODE = '23505';
  END IF;
  v_is_current_subscription :=
    NULLIF(btrim(v_profile.paddle_subscription_id), '')
      IS NOT DISTINCT FROM NULLIF(btrim(p_subscription_id), '');

  IF v_state.last_payment_transaction_id IS DISTINCT FROM p_transaction_id
     AND v_state.last_payment_occurred_at IS NOT NULL
     AND p_occurred_at < v_state.last_payment_occurred_at THEN
    v_order_reason := 'stale_payment';
  ELSIF v_state.last_payment_transaction_id IS DISTINCT FROM p_transaction_id
        AND v_state.last_payment_occurred_at IS NOT NULL
        AND p_occurred_at = v_state.last_payment_occurred_at THEN
    v_order_reason := 'ambiguous_payment_order';
  END IF;

  IF v_state.terminal THEN
    v_business_reason := 'terminal_subscription';
  ELSIF NOT v_is_current_subscription
        AND NOT COALESCE(p_allow_subscription_rebind, false) THEN
    v_business_reason := 'superseded_subscription';
  END IF;

  IF NOT v_is_current_subscription
     AND COALESCE(p_allow_subscription_rebind, false)
     AND v_state.terminal = false
     AND v_order_reason IS NULL THEN
    UPDATE public.profiles
       SET paddle_subscription_id = btrim(p_subscription_id),
           paddle_customer_id = COALESCE(
             NULLIF(btrim(paddle_customer_id), ''),
             v_customer_id
           )
      WHERE id = p_user_id;
  END IF;

  v_effective_skip :=
    COALESCE(p_skip_entitlement_mutation, false)
    OR v_order_reason IS NOT NULL
    OR v_business_reason IS NOT NULL;

  v_payment_result := public.apply_subscription_payment(
    p_transaction_id,
    p_user_id,
    v_plan,
    p_amount,
    v_effective_skip
  );

  -- Every accepted subscription payment must carry its immutable provider
  -- subscription identity in the accounting ledger, including duplicates and
  -- payments whose entitlement was withheld.
  UPDATE public.purchases
     SET subscription_id = COALESCE(subscription_id, btrim(p_subscription_id))
   WHERE transaction_id = p_transaction_id
     AND user_id = p_user_id
     AND plan = v_plan
     AND credits_granted = p_amount
     AND (
       subscription_id IS NULL
       OR subscription_id = btrim(p_subscription_id)
     );
  GET DIAGNOSTICS v_bound_count = ROW_COUNT;
  IF v_bound_count <> 1 THEN
    RAISE EXCEPTION 'SUBSCRIPTION_PAYMENT_LEDGER_BINDING_CONFLICT'
      USING ERRCODE = '23505';
  END IF;

  -- Only a strictly newer payment advances the subscription-wide watermark.
  -- Equal-time different transactions are ambiguous and fail closed.
  IF v_order_reason IS NULL
     AND (
       v_state.last_payment_occurred_at IS NULL
       OR v_state.last_payment_transaction_id = p_transaction_id
       OR p_occurred_at > v_state.last_payment_occurred_at
     ) THEN
    UPDATE public.paddle_subscription_states
       SET last_payment_transaction_id = p_transaction_id,
           last_payment_occurred_at = p_occurred_at,
           updated_at = clock_timestamp()
     WHERE subscription_id = v_state.subscription_id;
  END IF;

  IF v_payment_result ->> 'reason' = 'duplicate' THEN
    RETURN v_payment_result || jsonb_build_object(
      'terminal', v_state.terminal,
      'lifecycleStatus', v_state.lifecycle_status,
      'entitlementGranted', false
    );
  END IF;

  IF v_order_reason IS NOT NULL THEN
    RETURN v_payment_result || jsonb_build_object(
      'reason', v_order_reason,
      'terminal', v_state.terminal,
      'lifecycleStatus', v_state.lifecycle_status,
      'entitlementGranted', false
    );
  END IF;

  IF v_business_reason IS NOT NULL THEN
    RETURN v_payment_result || jsonb_build_object(
      'reason', v_business_reason,
      'terminal', v_state.terminal,
      'lifecycleStatus', v_state.lifecycle_status,
      'entitlementGranted', false
    );
  END IF;

  RETURN v_payment_result || jsonb_build_object(
    'terminal', false,
    'lifecycleStatus', v_state.lifecycle_status,
    'entitlementGranted',
      COALESCE(v_payment_result ->> 'reason' = 'payment_applied', false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_paddle_event_order(
  text, text, text, text, timestamptz, uuid, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_paddle_event_order(
  text, text, text, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_paddle_event_order(
  text, text, text, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_stale_paddle_event_order(
  text, text, text, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_paddle_subscription_snapshot(
  text, uuid, text, text, text, integer, text, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_ordered_subscription_payment(
  text, uuid, text, integer, text, text, timestamptz, boolean, boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_paddle_event_order(
  text, text, text, text, timestamptz, uuid, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_paddle_event_order(
  text, text, text, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_paddle_event_order(
  text, text, text, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_stale_paddle_event_order(
  text, text, text, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_paddle_subscription_snapshot(
  text, uuid, text, text, text, integer, text, text, timestamptz, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_ordered_subscription_payment(
  text, uuid, text, integer, text, text, timestamptz, boolean, boolean
) TO service_role;

COMMIT;

-- Rollback policy:
--   Deploy code that no longer calls these RPCs first. Preserve the watermark
--   table for audit; do not drop it while webhook deliveries are in flight.
