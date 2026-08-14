-- ============================================================
-- Migration 024: source-aware credit lots and exact refunds
--
-- Rollout contract:
--   * Apply only during a billing maintenance window.
--   * Migration 023 and a complete, operator-reviewed manifest are required.
--   * The migration stops if an analysis reservation or Storyboard job is active.
--   * CREDIT_LEDGER_V2_ENABLED and CREDIT_PACK_PURCHASES_ENABLED remain false
--     until the post-migration invariants and Paddle Sandbox flow pass.
--   * While CREDIT_LEDGER_V2_ENABLED is false, the compatibility trigger below
--     translates the legacy profiles(plan='free', credits=0) cancellation write
--     into the same source-aware expiration used by expire_subscription_credits.
--   * Existing subscription RPC signatures stay compatible with the old server,
--     so schema-first rollback remains possible.
-- ============================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $migration_lock$
BEGIN
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('promptgen:credit-ledger-v2-migration', 0)
  ) THEN
    RAISE EXCEPTION 'CREDIT_LEDGER_MIGRATION_ALREADY_RUNNING'
      USING ERRCODE = '55P03';
  END IF;
END;
$migration_lock$;

LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.purchases IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.credits_ledger IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.analysis_credit_operations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.storyboards IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE promptgen_private.legacy_credit_classification_manifest
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF to_regclass('public.credit_lots') IS NOT NULL THEN
    RAISE EXCEPTION 'CREDIT_LEDGER_MIGRATION_ALREADY_APPLIED'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.analysis_credit_operations
     WHERE status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'CREDIT_LEDGER_MIGRATION_BLOCKED_ACTIVE_ANALYSIS';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.storyboards
     WHERE deleted_at IS NULL
       AND status IN ('pending', 'processing')
  ) THEN
    RAISE EXCEPTION 'CREDIT_LEDGER_MIGRATION_BLOCKED_ACTIVE_STORYBOARD';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE credits < 0
  ) THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_PROFILE_NEGATIVE_BALANCE'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM promptgen_private.legacy_credit_classification_manifest
     WHERE consumed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_ALREADY_CONSUMED'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM promptgen_private.legacy_credit_classification_manifest
     WHERE snapshot_captured_at > clock_timestamp()
        OR snapshot_captured_at < clock_timestamp() - interval '24 hours'
        OR reviewed_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_STALE_OR_FUTURE'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT count(DISTINCT batch_id)
      FROM promptgen_private.legacy_credit_classification_manifest
  ) > 1 OR (
    SELECT count(DISTINCT snapshot_captured_at)
      FROM promptgen_private.legacy_credit_classification_manifest
  ) > 1 THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_MIXED_SNAPSHOT'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.profiles p
      LEFT JOIN promptgen_private.legacy_credit_classification_manifest m
        ON m.user_id = p.id
     WHERE p.credits > 0
       AND m.user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_MISSING'
      USING ERRCODE = '23502';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM promptgen_private.legacy_credit_classification_manifest m
      LEFT JOIN public.profiles p ON p.id = m.user_id
     WHERE p.id IS NULL
        OR p.credits <= 0
  ) THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_EXTRA'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT count(*) FROM public.profiles WHERE credits > 0
  ) IS DISTINCT FROM (
    SELECT count(*)
      FROM promptgen_private.legacy_credit_classification_manifest
  ) OR (
    SELECT COALESCE(sum(credits), 0)::bigint
      FROM public.profiles
     WHERE credits > 0
  ) IS DISTINCT FROM (
    SELECT COALESCE(sum(expected_credits), 0)::bigint
      FROM promptgen_private.legacy_credit_classification_manifest
  ) THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_TOTAL_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM promptgen_private.legacy_credit_classification_manifest m
      JOIN public.profiles p ON p.id = m.user_id
     WHERE p.plan IS DISTINCT FROM m.expected_plan
        OR p.credits IS DISTINCT FROM m.expected_credits
        OR (
          NULLIF(btrim(p.paddle_customer_id), '') IS NOT NULL
        ) IS DISTINCT FROM m.expected_has_paddle_customer
        OR (
          NULLIF(btrim(p.paddle_subscription_id), '') IS NOT NULL
        ) IS DISTINCT FROM m.expected_has_paddle_subscription
        OR (
          SELECT count(*)
            FROM public.purchases x
           WHERE x.user_id = p.id
        ) IS DISTINCT FROM m.expected_purchase_count
        OR (
          SELECT count(*)
            FROM public.credits_ledger l
           WHERE l.user_id = p.id
        ) IS DISTINCT FROM m.expected_ledger_count
        OR promptgen_private.legacy_credit_evidence_fingerprint(p.id)
             IS DISTINCT FROM m.expected_evidence_fingerprint
  ) THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_SNAPSHOT_DRIFT'
      USING ERRCODE = '40001';
  END IF;
END;
$preflight$;

CREATE TABLE public.credit_lots (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_kind        TEXT NOT NULL
                     CHECK (
                       source_kind IN (
                         'subscription',
                         'subscription_carry_in',
                         'manual_carryover',
                         'credit_pack'
                       )
                     ),
  source_id          TEXT NOT NULL UNIQUE CHECK (btrim(source_id) <> ''),
  credits_granted    INTEGER NOT NULL CHECK (credits_granted > 0),
  credits_remaining  INTEGER NOT NULL
                     CHECK (credits_remaining >= 0 AND credits_remaining <= credits_granted),
  credits_expired    INTEGER NOT NULL DEFAULT 0
                     CHECK (
                       credits_expired >= 0
                       AND credits_remaining + credits_expired <= credits_granted
                     ),
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (
                       status IN (
                         'active',
                         'quarantined',
                         'exhausted',
                         'expired',
                         'refunded',
                         'chargeback'
                       )
                     ),
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT credit_lots_live_balance_check CHECK (
    (status = 'active' AND credits_remaining > 0 AND credits_expired = 0)
    OR (status = 'quarantined' AND credits_remaining > 0 AND credits_expired = 0)
    OR (status NOT IN ('active', 'quarantined') AND credits_remaining = 0)
  ),
  CONSTRAINT credit_lots_manual_carryover_non_expiring_check CHECK (
    source_kind <> 'manual_carryover' OR expires_at IS NULL
  )
);

CREATE INDEX credit_lots_user_spend_order_idx
  ON public.credit_lots (
    user_id,
    status,
    source_kind,
    expires_at,
    created_at,
    id
  );

CREATE TABLE public.credit_operations (
  operation_key      TEXT PRIMARY KEY CHECK (btrim(operation_key) <> ''),
  external_id        TEXT NOT NULL CHECK (btrim(external_id) <> ''),
  operation_type     TEXT NOT NULL CHECK (operation_type IN ('analysis', 'storyboard')),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credits_charged    INTEGER NOT NULL CHECK (credits_charged > 0),
  credits_refunded   INTEGER NOT NULL DEFAULT 0
                     CHECK (credits_refunded >= 0 AND credits_refunded <= credits_charged),
  status             TEXT NOT NULL DEFAULT 'reserved'
                     CHECK (status IN ('reserved', 'completed', 'refunded')),
  refund_reason      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at       TIMESTAMPTZ,
  refunded_at        TIMESTAMPTZ
);

CREATE INDEX credit_operations_user_created_idx
  ON public.credit_operations (user_id, created_at DESC);

CREATE TABLE public.credit_operation_allocations (
  operation_key      TEXT NOT NULL
                     REFERENCES public.credit_operations(operation_key) ON DELETE CASCADE,
  lot_id             BIGINT NOT NULL
                     REFERENCES public.credit_lots(id) ON DELETE CASCADE,
  credits_allocated  INTEGER NOT NULL CHECK (credits_allocated > 0),
  credits_refunded   INTEGER NOT NULL DEFAULT 0
                     CHECK (credits_refunded >= 0 AND credits_refunded <= credits_allocated),
  PRIMARY KEY (operation_key, lot_id)
);

CREATE TABLE public.credit_pack_checkout_intents (
  transaction_id       TEXT PRIMARY KEY CHECK (btrim(transaction_id) <> ''),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id          TEXT NOT NULL CHECK (btrim(customer_id) <> ''),
  subscription_id      TEXT NOT NULL CHECK (btrim(subscription_id) <> ''),
  pack_key             TEXT NOT NULL
                       CHECK (pack_key IN ('usage_600', 'usage_1500', 'usage_3000')),
  price_id             TEXT NOT NULL CHECK (btrim(price_id) <> ''),
  credits              INTEGER NOT NULL CHECK (credits > 0),
  unit_amount          INTEGER NOT NULL CHECK (unit_amount > 0),
  currency_code        TEXT NOT NULL CHECK (currency_code = 'USD'),
  expiry_days          INTEGER NOT NULL CHECK (expiry_days BETWEEN 30 AND 3650),
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'fulfilled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  fulfilled_at         TIMESTAMPTZ
);

CREATE INDEX credit_pack_checkout_intents_user_created_idx
  ON public.credit_pack_checkout_intents (user_id, created_at DESC);

CREATE TABLE public.credit_pack_purchases (
  transaction_id       TEXT PRIMARY KEY
                       REFERENCES public.credit_pack_checkout_intents(transaction_id)
                       ON DELETE CASCADE
                       CHECK (btrim(transaction_id) <> ''),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id          TEXT NOT NULL CHECK (btrim(customer_id) <> ''),
  pack_key             TEXT NOT NULL
                       CHECK (pack_key IN ('usage_600', 'usage_1500', 'usage_3000')),
  price_id             TEXT NOT NULL CHECK (btrim(price_id) <> ''),
  credits_granted      INTEGER NOT NULL CHECK (credits_granted > 0),
  unit_amount          INTEGER NOT NULL CHECK (unit_amount > 0),
  currency_code        TEXT NOT NULL CHECK (currency_code = 'USD'),
  subscription_id      TEXT NOT NULL CHECK (btrim(subscription_id) <> ''),
  lot_id               BIGINT UNIQUE REFERENCES public.credit_lots(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'completed'
                       CHECK (status IN ('completed', 'refunded', 'chargeback')),
  review_required      BOOLEAN NOT NULL DEFAULT false,
  unrecovered_credits  INTEGER NOT NULL DEFAULT 0 CHECK (unrecovered_credits >= 0),
  purchased_at         TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  adjusted_at          TIMESTAMPTZ
);

CREATE INDEX credit_pack_purchases_user_created_idx
  ON public.credit_pack_purchases (user_id, created_at DESC);

CREATE TABLE public.credit_pack_adjustments (
  adjustment_id      TEXT PRIMARY KEY CHECK (btrim(adjustment_id) <> ''),
  transaction_id     TEXT NOT NULL
                     REFERENCES public.credit_pack_purchases(transaction_id) ON DELETE CASCADE,
  action             TEXT NOT NULL CHECK (btrim(action) <> ''),
  adjustment_type    TEXT,
  status             TEXT NOT NULL CHECK (btrim(status) <> ''),
  applied            BOOLEAN NOT NULL DEFAULT false,
  review_required    BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.analysis_credit_operations
  ADD COLUMN credit_operation_key TEXT
  REFERENCES public.credit_operations(operation_key) ON DELETE SET NULL;

ALTER TABLE public.storyboards
  ADD COLUMN credit_operation_key TEXT
  REFERENCES public.credit_operations(operation_key) ON DELETE SET NULL;

ALTER TABLE public.purchases
  ADD COLUMN refund_review_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN refund_review_reason TEXT;

ALTER TABLE public.credit_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_operation_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_pack_checkout_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_pack_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_pack_adjustments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.credit_lots
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.credit_operations
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.credit_operation_allocations
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.credit_pack_checkout_intents
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.credit_pack_purchases
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.credit_pack_adjustments
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.credit_lots TO service_role;
GRANT SELECT ON TABLE public.credit_operations TO service_role;
GRANT SELECT ON TABLE public.credit_operation_allocations TO service_role;
GRANT SELECT ON TABLE public.credit_pack_checkout_intents TO service_role;
GRANT SELECT ON TABLE public.credit_pack_purchases TO service_role;
GRANT SELECT ON TABLE public.credit_pack_adjustments TO service_role;

REVOKE ALL ON SEQUENCE public.credit_lots_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

-- Backfill only the exact operator-reviewed snapshot. Subscription carry-in
-- follows subscription expiry. Manual carryover remains outside that lifecycle.
INSERT INTO public.credit_lots (
  user_id,
  source_kind,
  source_id,
  credits_granted,
  credits_remaining,
  status
)
SELECT
  p.id,
  m.classification,
  'legacy:' || m.batch_id::text || ':' || p.id::text,
  m.expected_credits,
  m.expected_credits,
  'active'
FROM public.profiles p
JOIN promptgen_private.legacy_credit_classification_manifest m
  ON m.user_id = p.id
WHERE p.credits > 0
  AND m.consumed_at IS NULL;

CREATE OR REPLACE FUNCTION public.sync_credit_lot_balance(
  p_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_balance integer;
BEGIN
  PERFORM 1
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.credit_lots
     SET credits_remaining = 0,
         credits_expired = credits_expired + credits_remaining,
         status = 'expired',
         updated_at = clock_timestamp()
   WHERE user_id = p_user_id
     AND status = 'active'
     AND expires_at IS NOT NULL
     AND expires_at <= clock_timestamp();

  SELECT COALESCE(sum(credits_remaining), 0)::integer
    INTO v_balance
    FROM public.credit_lots
   WHERE user_id = p_user_id
     AND status = 'active'
     AND credits_remaining > 0
     AND (expires_at IS NULL OR expires_at > clock_timestamp());

  UPDATE public.profiles
     SET credits = v_balance
   WHERE id = p_user_id;

  RETURN v_balance;
END;
$function$;

CREATE OR REPLACE FUNCTION public.consume_credit_lots(
  p_operation_key text,
  p_external_id text,
  p_operation_type text,
  p_user_id uuid,
  p_amount integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing public.credit_operations%ROWTYPE;
  v_lot public.credit_lots%ROWTYPE;
  v_balance integer;
  v_remaining integer := p_amount;
  v_take integer;
BEGIN
  IF p_operation_key IS NULL OR btrim(p_operation_key) = ''
     OR length(p_operation_key) > 255 THEN
    RAISE EXCEPTION 'INVALID_OPERATION_KEY' USING ERRCODE = '22023';
  END IF;
  IF p_external_id IS NULL OR btrim(p_external_id) = ''
     OR length(p_external_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_EXTERNAL_ID' USING ERRCODE = '22023';
  END IF;
  IF p_operation_type NOT IN ('analysis', 'storyboard') THEN
    RAISE EXCEPTION 'INVALID_OPERATION_TYPE' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT' USING ERRCODE = '22023';
  END IF;

  -- Serialize all credit operations for a user before checking idempotency.
  -- Without this lock, two concurrent requests can both observe a missing
  -- operation and the second one fails with a duplicate-key error instead of
  -- returning the existing reservation.
  v_balance := public.sync_credit_lot_balance(p_user_id);

  SELECT *
    INTO v_existing
    FROM public.credit_operations
   WHERE operation_key = p_operation_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.user_id <> p_user_id
       OR v_existing.external_id <> p_external_id
       OR v_existing.operation_type <> p_operation_type
       OR v_existing.credits_charged <> p_amount THEN
      RAISE EXCEPTION 'OPERATION_MISMATCH' USING ERRCODE = '22023';
    END IF;
    IF v_existing.status = 'refunded' THEN
      RAISE EXCEPTION 'OPERATION_ALREADY_REFUNDED' USING ERRCODE = 'P0001';
    END IF;

    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'status', v_existing.status,
      'newBalance', v_balance
    );
  END IF;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.credit_operations (
    operation_key,
    external_id,
    operation_type,
    user_id,
    credits_charged
  ) VALUES (
    p_operation_key,
    p_external_id,
    p_operation_type,
    p_user_id,
    p_amount
  );

  FOR v_lot IN
    SELECT *
      FROM public.credit_lots
     WHERE user_id = p_user_id
       AND status = 'active'
       AND credits_remaining > 0
       AND (expires_at IS NULL OR expires_at > clock_timestamp())
     ORDER BY
       CASE source_kind
         WHEN 'subscription' THEN 0
         WHEN 'subscription_carry_in' THEN 1
         WHEN 'credit_pack' THEN 2
         WHEN 'manual_carryover' THEN 3
         ELSE 4
       END,
       expires_at ASC NULLS LAST,
       created_at,
       id
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining = 0;
    v_take := LEAST(v_lot.credits_remaining, v_remaining);

    UPDATE public.credit_lots
       SET credits_remaining = credits_remaining - v_take,
           status = CASE
             WHEN credits_remaining - v_take = 0 THEN 'exhausted'
             ELSE 'active'
           END,
           updated_at = clock_timestamp()
     WHERE id = v_lot.id;

    INSERT INTO public.credit_operation_allocations (
      operation_key,
      lot_id,
      credits_allocated
    ) VALUES (
      p_operation_key,
      v_lot.id,
      v_take
    );

    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'CREDIT_LEDGER_INVARIANT_VIOLATION' USING ERRCODE = 'P0001';
  END IF;

  v_balance := public.sync_credit_lot_balance(p_user_id);
  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'reserved',
    'status', 'reserved',
    'newBalance', v_balance
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_credit_operation(
  p_operation_key text,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation public.credit_operations%ROWTYPE;
BEGIN
  SELECT *
    INTO v_operation
    FROM public.credit_operations
   WHERE operation_key = p_operation_key
   FOR UPDATE;

  IF NOT FOUND OR v_operation.user_id <> p_user_id THEN
    RAISE EXCEPTION 'CREDIT_OPERATION_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_operation.status = 'completed' THEN
    RETURN false;
  END IF;
  IF v_operation.status <> 'reserved' THEN
    RAISE EXCEPTION 'CREDIT_OPERATION_NOT_RESERVED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.credit_operations
     SET status = 'completed',
         completed_at = clock_timestamp()
   WHERE operation_key = p_operation_key;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_credit_operation(
  p_operation_key text,
  p_user_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation public.credit_operations%ROWTYPE;
  v_allocation record;
  v_restore integer;
  v_refunded integer := 0;
  v_balance integer;
BEGIN
  -- Keep the global mutation order profile -> operation -> allocations/lots.
  -- consume_credit_lots uses the same order; reversing it here can deadlock a
  -- request racing a retry or worker refund for the same operation.
  v_balance := public.sync_credit_lot_balance(p_user_id);

  SELECT *
    INTO v_operation
    FROM public.credit_operations
   WHERE operation_key = p_operation_key
   FOR UPDATE;

  IF NOT FOUND OR v_operation.user_id <> p_user_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'missing',
      'refunded', false
    );
  END IF;

  IF v_operation.status IN ('completed', 'refunded') THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', v_operation.status,
      'refunded', false,
      'creditsRestored', v_operation.credits_refunded,
      'newBalance', v_balance
    );
  END IF;

  FOR v_allocation IN
    SELECT
      a.lot_id,
      a.credits_allocated,
      a.credits_refunded,
      l.status AS lot_status,
      l.expires_at
    FROM public.credit_operation_allocations a
    JOIN public.credit_lots l ON l.id = a.lot_id
    WHERE a.operation_key = p_operation_key
    ORDER BY a.lot_id
    FOR UPDATE OF a, l
  LOOP
    v_restore := v_allocation.credits_allocated - v_allocation.credits_refunded;
    IF v_restore > 0
       AND v_allocation.lot_status IN ('active', 'exhausted')
       AND (
         v_allocation.expires_at IS NULL
         OR v_allocation.expires_at > clock_timestamp()
       ) THEN
      UPDATE public.credit_lots
         SET credits_remaining = credits_remaining + v_restore,
             status = 'active',
             updated_at = clock_timestamp()
       WHERE id = v_allocation.lot_id;

      UPDATE public.credit_operation_allocations
         SET credits_refunded = credits_refunded + v_restore
       WHERE operation_key = p_operation_key
         AND lot_id = v_allocation.lot_id;

      v_refunded := v_refunded + v_restore;
    END IF;
  END LOOP;

  UPDATE public.credit_operations
     SET status = 'refunded',
         credits_refunded = v_refunded,
         refunded_at = clock_timestamp(),
         refund_reason = left(COALESCE(p_reason, 'operation_failed'), 500)
   WHERE operation_key = p_operation_key;

  v_balance := public.sync_credit_lot_balance(p_user_id);
  RETURN jsonb_build_object(
    'success', true,
    'status', 'refunded',
    'refunded', true,
    'creditsRestored', v_refunded,
    'unrecoverableCredits', v_operation.credits_charged - v_refunded,
    'newBalance', v_balance
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.register_credit_pack_checkout_intent(
  p_transaction_id text,
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_pack_key text,
  p_price_id text,
  p_credits integer,
  p_unit_amount integer,
  p_currency_code text,
  p_expiry_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_plan text;
  v_stored_customer_id text;
  v_stored_subscription_id text;
  v_existing public.credit_pack_checkout_intents%ROWTYPE;
  v_inserted_transaction_id text;
BEGIN
  IF p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
     OR length(p_transaction_id) > 255
     OR p_user_id IS NULL
     OR p_customer_id IS NULL OR btrim(p_customer_id) = ''
     OR length(p_customer_id) > 255
     OR p_price_id IS NULL OR btrim(p_price_id) = ''
     OR length(p_price_id) > 255
     OR p_subscription_id IS NULL OR btrim(p_subscription_id) = ''
     OR length(p_subscription_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_CHECKOUT_INTENT' USING ERRCODE = '22023';
  END IF;
  IF p_expiry_days IS NULL OR p_expiry_days NOT BETWEEN 30 AND 3650 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_EXPIRY' USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(p_currency_code, '')) <> 'USD' THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_CURRENCY' USING ERRCODE = '22023';
  END IF;

  -- Database-level price/quantity contract. A catalog change must ship with a
  -- reviewed migration instead of trusting webhook parameters.
  IF NOT (
    (p_pack_key = 'usage_600'  AND p_credits = 600  AND p_unit_amount = 1000)
    OR
    (p_pack_key = 'usage_1500' AND p_credits = 1500 AND p_unit_amount = 2000)
    OR
    (p_pack_key = 'usage_3000' AND p_credits = 3000 AND p_unit_amount = 4000)
  ) THEN
    RAISE EXCEPTION 'CREDIT_PACK_CONTRACT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  -- This RPC is called only after the server has fetched the Paddle
  -- subscription and verified active/trialing status, customer ownership, and
  -- the mapped plan. Persist that verified checkout boundary before the browser
  -- can open Paddle Checkout.
  SELECT plan, paddle_customer_id, paddle_subscription_id
    INTO v_plan, v_stored_customer_id, v_stored_subscription_id
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF lower(COALESCE(v_plan, 'free')) <> ALL (ARRAY['pro', 'enterprise', 'paid']) THEN
    RAISE EXCEPTION 'ACTIVE_SUBSCRIPTION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF v_stored_customer_id IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_ID_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_stored_subscription_id IS DISTINCT FROM p_subscription_id THEN
    RAISE EXCEPTION 'SUBSCRIPTION_ID_MISMATCH' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.credit_pack_checkout_intents (
    transaction_id,
    user_id,
    customer_id,
    subscription_id,
    pack_key,
    price_id,
    credits,
    unit_amount,
    currency_code,
    expiry_days
  ) VALUES (
    p_transaction_id,
    p_user_id,
    p_customer_id,
    p_subscription_id,
    p_pack_key,
    p_price_id,
    p_credits,
    p_unit_amount,
    upper(p_currency_code),
    p_expiry_days
  )
  ON CONFLICT (transaction_id) DO NOTHING
  RETURNING transaction_id INTO v_inserted_transaction_id;

  SELECT *
    INTO v_existing
    FROM public.credit_pack_checkout_intents
   WHERE transaction_id = p_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_CHECKOUT_INTENT_NOT_PERSISTED' USING ERRCODE = 'P0001';
  END IF;
  IF v_existing.user_id <> p_user_id
     OR v_existing.customer_id <> p_customer_id
     OR v_existing.subscription_id <> p_subscription_id
     OR v_existing.pack_key <> p_pack_key
     OR v_existing.price_id <> p_price_id
     OR v_existing.credits <> p_credits
     OR v_existing.unit_amount <> p_unit_amount
     OR v_existing.currency_code <> upper(p_currency_code)
     OR v_existing.expiry_days <> p_expiry_days THEN
    RAISE EXCEPTION 'TRANSACTION_ID_CONFLICT' USING ERRCODE = '23505';
  END IF;

  RETURN jsonb_build_object(
    'applied', v_inserted_transaction_id IS NOT NULL,
    'reason', CASE
      WHEN v_inserted_transaction_id IS NOT NULL THEN 'checkout_intent_registered'
      ELSE 'duplicate'
    END,
    'status', v_existing.status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_credit_pack_purchase(
  p_transaction_id text,
  p_user_id uuid,
  p_customer_id text,
  p_pack_key text,
  p_price_id text,
  p_credits integer,
  p_unit_amount integer,
  p_currency_code text,
  p_subscription_id text,
  p_expiry_days integer,
  p_purchased_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_intent public.credit_pack_checkout_intents%ROWTYPE;
  v_existing public.credit_pack_purchases%ROWTYPE;
  v_lot_id bigint;
  v_balance integer;
BEGIN
  IF p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
     OR length(p_transaction_id) > 255
     OR p_user_id IS NULL
     OR p_customer_id IS NULL OR btrim(p_customer_id) = ''
     OR p_price_id IS NULL OR btrim(p_price_id) = ''
     OR p_subscription_id IS NULL OR btrim(p_subscription_id) = ''
     OR p_purchased_at IS NULL THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_PURCHASE' USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(p_currency_code, '')) <> 'USD' THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_CURRENCY' USING ERRCODE = '22023';
  END IF;

  -- Lock the profile first to keep the same lock ordering as intent
  -- registration and all other balance mutations. This refreshes lazy expiry
  -- but deliberately does not re-check the current plan: checkout eligibility
  -- is the immutable, server-verified intent recorded before payment.
  v_balance := public.sync_credit_lot_balance(p_user_id);

  SELECT *
    INTO v_intent
    FROM public.credit_pack_checkout_intents
   WHERE transaction_id = p_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_CHECKOUT_INTENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_intent.user_id <> p_user_id
     OR v_intent.customer_id <> p_customer_id
     OR v_intent.subscription_id <> p_subscription_id
     OR v_intent.pack_key <> p_pack_key
     OR v_intent.price_id <> p_price_id
     OR v_intent.credits <> p_credits
     OR v_intent.unit_amount <> p_unit_amount
     OR v_intent.currency_code <> upper(p_currency_code)
  THEN
    RAISE EXCEPTION 'CREDIT_PACK_CHECKOUT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.credit_pack_purchases
   WHERE transaction_id = p_transaction_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_intent.status <> 'fulfilled'
       OR v_existing.user_id <> p_user_id
       OR v_existing.customer_id <> p_customer_id
       OR v_existing.pack_key <> p_pack_key
       OR v_existing.price_id <> p_price_id
       OR v_existing.credits_granted <> p_credits
     OR v_existing.unit_amount <> p_unit_amount
     OR v_existing.currency_code <> upper(p_currency_code)
     OR v_existing.subscription_id <> p_subscription_id
     OR v_existing.purchased_at IS DISTINCT FROM p_purchased_at THEN
      RAISE EXCEPTION 'TRANSACTION_ID_CONFLICT' USING ERRCODE = '23505';
    END IF;

    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'newBalance', v_balance
    );
  END IF;
  IF v_intent.status <> 'pending' THEN
    RAISE EXCEPTION 'CREDIT_PACK_INTENT_STATE_INVALID' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.credit_pack_purchases (
    transaction_id,
    user_id,
    customer_id,
    pack_key,
    price_id,
    credits_granted,
    unit_amount,
    currency_code,
    subscription_id,
    purchased_at
  ) VALUES (
    p_transaction_id,
    p_user_id,
    p_customer_id,
    p_pack_key,
    p_price_id,
    p_credits,
    p_unit_amount,
    upper(p_currency_code),
    p_subscription_id,
    p_purchased_at
  );

  INSERT INTO public.credit_lots (
    user_id,
    source_kind,
    source_id,
    credits_granted,
    credits_remaining,
    status,
    expires_at
  ) VALUES (
    p_user_id,
    'credit_pack',
    'credit_pack:' || p_transaction_id,
    p_credits,
    p_credits,
    'active',
    -- The verified checkout intent is authoritative. p_expiry_days remains in
    -- the RPC signature for schema-first compatibility, but a later env change
    -- must never turn a completed charge into a no-credit failure.
    p_purchased_at + make_interval(days => v_intent.expiry_days)
  )
  RETURNING id INTO v_lot_id;

  UPDATE public.credit_pack_purchases
     SET lot_id = v_lot_id
   WHERE transaction_id = p_transaction_id;

  UPDATE public.credit_pack_checkout_intents
     SET status = 'fulfilled',
         fulfilled_at = clock_timestamp()
   WHERE transaction_id = p_transaction_id
     AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_PACK_INTENT_FULFILLMENT_RACE' USING ERRCODE = 'P0001';
  END IF;

  v_balance := public.sync_credit_lot_balance(p_user_id);
  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'credit_pack_applied',
    'newBalance', v_balance,
    'expiresInDays', v_intent.expiry_days
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_credit_pack_adjustment(
  p_adjustment_id text,
  p_transaction_id text,
  p_action text,
  p_adjustment_type text,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_purchase public.credit_pack_purchases%ROWTYPE;
  v_lot public.credit_lots%ROWTYPE;
  v_balance integer;
  v_unrecovered integer;
  v_terminal_status text;
BEGIN
  IF p_adjustment_id IS NULL OR btrim(p_adjustment_id) = ''
     OR length(p_adjustment_id) > 255
     OR p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
     OR length(p_transaction_id) > 255
     OR p_action IS NULL OR btrim(p_action) = ''
     OR p_status IS NULL OR btrim(p_status) = '' THEN
    RAISE EXCEPTION 'INVALID_CREDIT_PACK_ADJUSTMENT' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_purchase
    FROM public.credit_pack_purchases
   WHERE transaction_id = p_transaction_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('matched', false, 'applied', false);
  END IF;

  PERFORM public.sync_credit_lot_balance(v_purchase.user_id);

  SELECT *
    INTO v_purchase
    FROM public.credit_pack_purchases
   WHERE transaction_id = p_transaction_id
   FOR UPDATE;

  INSERT INTO public.credit_pack_adjustments (
    adjustment_id,
    transaction_id,
    action,
    adjustment_type,
    status
  ) VALUES (
    p_adjustment_id,
    p_transaction_id,
    p_action,
    p_adjustment_type,
    p_status
  )
  ON CONFLICT (adjustment_id) DO UPDATE
    SET action = EXCLUDED.action,
        adjustment_type = EXCLUDED.adjustment_type,
        status = EXCLUDED.status,
        updated_at = clock_timestamp()
  WHERE public.credit_pack_adjustments.transaction_id = EXCLUDED.transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADJUSTMENT_ID_CONFLICT' USING ERRCODE = '23505';
  END IF;

  IF p_status <> 'approved' THEN
    RETURN jsonb_build_object(
      'matched', true,
      'applied', false,
      'reason', 'not_approved'
    );
  END IF;

  IF p_action IN ('chargeback_reverse', 'chargeback_warning')
     OR p_action NOT IN ('refund', 'credit', 'chargeback') THEN
    UPDATE public.credit_pack_purchases
       SET review_required = true,
           adjusted_at = clock_timestamp()
     WHERE transaction_id = p_transaction_id;
    UPDATE public.credit_pack_adjustments
       SET review_required = true
     WHERE adjustment_id = p_adjustment_id;

    RETURN jsonb_build_object(
      'matched', true,
      'applied', false,
      'reason', 'manual_review',
      'reviewRequired', true
    );
  END IF;

  IF COALESCE(p_adjustment_type, '') <> 'full' THEN
    SELECT *
      INTO v_lot
      FROM public.credit_lots
     WHERE id = v_purchase.lot_id
     FOR UPDATE;

    IF NOT FOUND OR v_lot.source_kind <> 'credit_pack' THEN
      RAISE EXCEPTION 'CREDIT_PACK_LOT_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;

    -- A provider-approved partial adjustment cannot be translated into an
    -- exact credit quantity without the adjusted money amount. Quarantine the
    -- remaining lot atomically so it cannot be spent while an operator resolves
    -- the proportional credit amount.
    UPDATE public.credit_lots
       SET status = 'quarantined',
           updated_at = clock_timestamp()
     WHERE id = v_lot.id
       AND status = 'active'
       AND credits_remaining > 0;

    UPDATE public.credit_pack_purchases
       SET review_required = true,
           adjusted_at = clock_timestamp()
     WHERE transaction_id = p_transaction_id;
    UPDATE public.credit_pack_adjustments
       SET review_required = true
     WHERE adjustment_id = p_adjustment_id;

    v_balance := public.sync_credit_lot_balance(v_purchase.user_id);
    RETURN jsonb_build_object(
      'matched', true,
      'applied', false,
      'reason', 'partial_requires_review',
      'reviewRequired', true,
      'quarantinedCredits', CASE
        WHEN v_lot.status = 'active' THEN v_lot.credits_remaining
        ELSE 0
      END,
      'newBalance', v_balance,
      'userId', v_purchase.user_id
    );
  END IF;

  v_terminal_status := CASE
    WHEN p_action = 'chargeback' THEN 'chargeback'
    ELSE 'refunded'
  END;

  IF v_purchase.status IN ('refunded', 'chargeback') THEN
    RETURN jsonb_build_object(
      'matched', true,
      'applied', false,
      'reason', 'duplicate',
      'reviewRequired', v_purchase.review_required
    );
  END IF;

  SELECT *
    INTO v_lot
    FROM public.credit_lots
   WHERE id = v_purchase.lot_id
   FOR UPDATE;

  IF NOT FOUND OR v_lot.source_kind <> 'credit_pack' THEN
    RAISE EXCEPTION 'CREDIT_PACK_LOT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Expired, unused credits are not debt. Only credits that are neither still
  -- available nor explicitly recorded as expired were actually consumed.
  v_unrecovered := GREATEST(
    0,
    v_purchase.credits_granted
      - v_lot.credits_remaining
      - v_lot.credits_expired
  );

  UPDATE public.credit_lots
     SET credits_remaining = 0,
         status = v_terminal_status,
         updated_at = clock_timestamp()
   WHERE id = v_lot.id;

  UPDATE public.credit_pack_purchases
     SET status = v_terminal_status,
         review_required = (v_unrecovered > 0),
         unrecovered_credits = v_unrecovered,
         adjusted_at = clock_timestamp()
   WHERE transaction_id = p_transaction_id;

  UPDATE public.credit_pack_adjustments
     SET applied = true,
         review_required = (v_unrecovered > 0),
         updated_at = clock_timestamp()
   WHERE adjustment_id = p_adjustment_id;

  v_balance := public.sync_credit_lot_balance(v_purchase.user_id);
  RETURN jsonb_build_object(
    'matched', true,
    'applied', true,
    'reason', v_terminal_status,
    'reviewRequired', (v_unrecovered > 0),
    'unrecoveredCredits', v_unrecovered,
    'newBalance', v_balance,
    'userId', v_purchase.user_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_subscription_payment(
  p_transaction_id text,
  p_user_id uuid,
  p_plan text,
  p_amount integer,
  p_skip_credit_mutation boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_purchase_id bigint;
  v_existing_user_id uuid;
  v_existing_plan text;
  v_existing_amount integer;
  v_existing_type text;
  v_new_balance integer;
BEGIN
  IF p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
     OR length(p_transaction_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_USER_ID' USING ERRCODE = '22023';
  END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('pro', 'enterprise') THEN
    RAISE EXCEPTION 'INVALID_PLAN' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.purchases (
    transaction_id,
    user_id,
    plan,
    credits_granted,
    status,
    transaction_type
  ) VALUES (
    p_transaction_id,
    p_user_id,
    p_plan,
    p_amount,
    'completed',
    'subscription_payment'
  )
  ON CONFLICT (transaction_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    SELECT user_id, plan, credits_granted, transaction_type
      INTO v_existing_user_id, v_existing_plan, v_existing_amount, v_existing_type
      FROM public.purchases
     WHERE transaction_id = p_transaction_id;

    IF v_existing_user_id IS DISTINCT FROM p_user_id
       OR v_existing_plan IS DISTINCT FROM p_plan
       OR v_existing_amount IS DISTINCT FROM p_amount
       OR (
         v_existing_type IS NOT NULL
         AND v_existing_type <> 'subscription_payment'
       ) THEN
      RAISE EXCEPTION 'TRANSACTION_ID_CONFLICT' USING ERRCODE = '23505';
    END IF;

    RETURN jsonb_build_object('applied', false, 'reason', 'duplicate');
  END IF;

  IF COALESCE(p_skip_credit_mutation, false) THEN
    RETURN jsonb_build_object(
      'applied', true,
      'reason', 'credit_mutation_skipped'
    );
  END IF;

  PERFORM public.sync_credit_lot_balance(p_user_id);

  UPDATE public.credit_lots
     SET credits_remaining = 0,
         credits_expired = credits_expired + credits_remaining,
         status = 'expired',
         updated_at = clock_timestamp()
   WHERE user_id = p_user_id
     AND source_kind IN ('subscription', 'subscription_carry_in')
     AND status IN ('active', 'exhausted');

  INSERT INTO public.credit_lots (
    user_id,
    source_kind,
    source_id,
    credits_granted,
    credits_remaining,
    status
  ) VALUES (
    p_user_id,
    'subscription',
    'subscription_payment:' || p_transaction_id,
    p_amount,
    p_amount,
    'active'
  );

  UPDATE public.profiles
     SET plan = p_plan
   WHERE id = p_user_id;

  v_new_balance := public.sync_credit_lot_balance(p_user_id);
  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'payment_applied',
    'newBalance', v_new_balance
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_plan_change(
  p_user_id uuid,
  p_new_plan text,
  p_new_allotment integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_plan text;
  v_old_rank integer;
  v_new_rank integer;
  v_subscription_remaining integer;
  v_target integer;
  v_result integer;
BEGIN
  IF p_new_plan IS NULL OR p_new_plan NOT IN ('pro', 'enterprise') THEN
    RAISE EXCEPTION 'INVALID_PLAN' USING ERRCODE = '22023';
  END IF;
  IF p_new_allotment IS NULL OR p_new_allotment < 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_ALLOTMENT' USING ERRCODE = '22023';
  END IF;

  SELECT plan
    INTO v_old_plan
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.sync_credit_lot_balance(p_user_id);
  IF v_old_plan = p_new_plan THEN
    SELECT credits INTO v_result FROM public.profiles WHERE id = p_user_id;
    RETURN v_result;
  END IF;

  SELECT COALESCE(sum(credits_remaining), 0)::integer
    INTO v_subscription_remaining
    FROM public.credit_lots
   WHERE user_id = p_user_id
     AND source_kind IN ('subscription', 'subscription_carry_in')
     AND status = 'active';

  v_old_rank := CASE v_old_plan WHEN 'enterprise' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END;
  v_new_rank := CASE p_new_plan WHEN 'enterprise' THEN 2 WHEN 'pro' THEN 1 ELSE 0 END;
  v_target := CASE
    WHEN v_new_rank > v_old_rank THEN p_new_allotment
    WHEN v_new_rank < v_old_rank THEN LEAST(v_subscription_remaining, p_new_allotment)
    ELSE v_subscription_remaining
  END;

  UPDATE public.credit_lots
     SET credits_remaining = 0,
         credits_expired = credits_expired + credits_remaining,
         status = 'expired',
         updated_at = clock_timestamp()
   WHERE user_id = p_user_id
     AND source_kind IN ('subscription', 'subscription_carry_in')
     AND status IN ('active', 'exhausted');

  IF v_target > 0 THEN
    INSERT INTO public.credit_lots (
      user_id,
      source_kind,
      source_id,
      credits_granted,
      credits_remaining,
      status
    ) VALUES (
      p_user_id,
      'subscription',
      'plan_change:' || p_user_id::text || ':' || gen_random_uuid()::text,
      v_target,
      v_target,
      'active'
    );
  END IF;

  UPDATE public.profiles
     SET plan = p_new_plan
   WHERE id = p_user_id;

  v_result := public.sync_credit_lot_balance(p_user_id);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.expire_subscription_credits(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_balance integer;
BEGIN
  PERFORM public.sync_credit_lot_balance(p_user_id);

  UPDATE public.credit_lots
     SET credits_remaining = 0,
         credits_expired = credits_expired + credits_remaining,
         status = 'expired',
         updated_at = clock_timestamp()
   WHERE user_id = p_user_id
     AND source_kind IN ('subscription', 'subscription_carry_in')
     AND status IN ('active', 'exhausted');

  UPDATE public.profiles
     SET plan = 'free'
   WHERE id = p_user_id;

  v_balance := public.sync_credit_lot_balance(p_user_id);
  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'subscription_expired',
    'newBalance', v_balance
  );
END;
$function$;

-- Schema-first rollout compatibility bridge. The server release immediately
-- preceding CREDIT_LEDGER_V2_ENABLED writes profiles(plan='free', credits=0)
-- directly. Convert every paid -> free transition into the same source-aware
-- expiration atomically, while preserving unexpired pack balances.
CREATE OR REPLACE FUNCTION public.bridge_legacy_subscription_cancellation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF lower(COALESCE(OLD.plan, 'free')) = ANY (ARRAY['pro', 'enterprise', 'paid'])
     AND lower(COALESCE(NEW.plan, 'free')) = 'free' THEN
    UPDATE public.credit_lots
       SET credits_remaining = 0,
           credits_expired = credits_expired + credits_remaining,
           status = 'expired',
           updated_at = clock_timestamp()
     WHERE user_id = NEW.id
       AND source_kind IN ('subscription', 'subscription_carry_in')
       AND status IN ('active', 'exhausted');

    SELECT COALESCE(sum(credits_remaining), 0)::integer
      INTO NEW.credits
      FROM public.credit_lots
     WHERE user_id = NEW.id
       AND source_kind IN ('credit_pack', 'manual_carryover')
       AND status = 'active'
       AND credits_remaining > 0
       AND (expires_at IS NULL OR expires_at > clock_timestamp());
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_bridge_legacy_subscription_cancellation
  ON public.profiles;
CREATE TRIGGER trg_bridge_legacy_subscription_cancellation
  BEFORE UPDATE OF plan, credits ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.bridge_legacy_subscription_cancellation();

CREATE OR REPLACE FUNCTION public.apply_purchase_refund(
  p_transaction_id text,
  p_previous_plan text DEFAULT NULL,
  p_previous_allotment integer DEFAULT NULL,
  p_skip_credit_mutation boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_purchase public.purchases%ROWTYPE;
  v_new_balance integer;
  v_payment_lot public.credit_lots%ROWTYPE;
BEGIN
  IF p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
     OR length(p_transaction_id) > 255 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_purchase
    FROM public.purchases
   WHERE transaction_id = p_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_purchase.status = 'refunded' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'duplicate',
      'userId', v_purchase.user_id
    );
  END IF;

  IF COALESCE(p_skip_credit_mutation, false) THEN
    UPDATE public.purchases SET status = 'refunded' WHERE id = v_purchase.id;
    RETURN jsonb_build_object(
      'applied', true,
      'reason', 'credit_mutation_skipped',
      'userId', v_purchase.user_id
    );
  END IF;

  v_new_balance := public.sync_credit_lot_balance(v_purchase.user_id);

  IF v_purchase.transaction_type = 'plan_upgrade' THEN
    -- The legacy plan-change purchase row stores only the target allotment. It
    -- does not contain an immutable snapshot of the prior lot balances, so
    -- restoring p_previous_allotment could mint credits the user had already
    -- spent before upgrading. Record the monetary refund, leave entitlements
    -- untouched, and require an operator to reconcile from Paddle + ledger
    -- evidence. A future migration may automate this only after snapshotting.
    UPDATE public.purchases
       SET status = 'refunded',
           refund_review_required = true,
           refund_review_reason = 'plan_change_snapshot_missing'
     WHERE id = v_purchase.id;

    RETURN jsonb_build_object(
      'applied', true,
      'reason', 'manual_review_required',
      'reviewRequired', true,
      'reviewReason', 'plan_change_snapshot_missing',
      'userId', v_purchase.user_id,
      'newBalance', v_new_balance
    );
  END IF;

  SELECT *
    INTO v_payment_lot
    FROM public.credit_lots
   WHERE source_id = 'subscription_payment:' || p_transaction_id
     AND user_id = v_purchase.user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'purchase_lot_missing',
      'userId', v_purchase.user_id,
      'newBalance', public.sync_credit_lot_balance(v_purchase.user_id)
    );
  END IF;

  -- A newer renewal already replaced this lot. Mark the historical transaction
  -- refunded without touching the current subscription or its newer credits.
  IF v_payment_lot.status IN ('expired', 'refunded') THEN
    UPDATE public.purchases SET status = 'refunded' WHERE id = v_purchase.id;
    RETURN jsonb_build_object(
      'applied', true,
      'reason', 'superseded_payment_refunded',
      'userId', v_purchase.user_id,
      'newBalance', public.sync_credit_lot_balance(v_purchase.user_id)
    );
  END IF;

  IF v_payment_lot.credits_remaining < v_payment_lot.credits_granted THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'credits_used',
      'userId', v_purchase.user_id,
      'newBalance', public.sync_credit_lot_balance(v_purchase.user_id)
    );
  END IF;

  UPDATE public.credit_lots
     SET credits_remaining = 0,
         status = 'refunded',
         updated_at = clock_timestamp()
   WHERE id = v_payment_lot.id;

  UPDATE public.profiles SET plan = 'free' WHERE id = v_purchase.user_id;
  UPDATE public.purchases SET status = 'refunded' WHERE id = v_purchase.id;

  v_new_balance := public.sync_credit_lot_balance(v_purchase.user_id);
  RETURN jsonb_build_object(
    'applied', true,
    'reason', 'credits_revoked',
    'userId', v_purchase.user_id,
    'newBalance', v_new_balance
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_analysis_operation(
  p_operation_id uuid,
  p_user_id uuid,
  p_credit_cost integer,
  p_reservation_seconds integer DEFAULT 900
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation public.analysis_credit_operations%ROWTYPE;
  v_plan text;
  v_balance integer;
  v_daily_used integer;
  v_last_reset_date date;
  v_charge_type text;
  v_charged_amount integer;
  v_now timestamptz := clock_timestamp();
  v_reusing boolean := false;
  v_reservation_count integer := 1;
  v_credit_operation_key text;
  v_consume_result jsonb;
BEGIN
  IF p_operation_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_OPERATION_ID' USING ERRCODE = '22023';
  END IF;
  IF p_credit_cost IS NULL OR p_credit_cost <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT' USING ERRCODE = '22023';
  END IF;
  IF p_reservation_seconds IS NULL OR p_reservation_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'INVALID_RESERVATION_SECONDS' USING ERRCODE = '22023';
  END IF;

  -- The operation ID is the HTTP idempotency key. Serialize same-key requests
  -- before the first existence check so a concurrent retry observes the row
  -- committed by the first request instead of racing the final INSERT.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('analysis_operation:' || p_operation_id::text, 0)
  );

  SELECT *
    INTO v_operation
    FROM public.analysis_credit_operations
   WHERE operation_id = p_operation_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_operation.user_id <> p_user_id OR v_operation.credit_cost <> p_credit_cost THEN
      RAISE EXCEPTION 'OPERATION_MISMATCH' USING ERRCODE = '22023';
    END IF;
    IF v_operation.status IN ('reserved', 'completed') THEN
      SELECT credits INTO v_balance FROM public.profiles WHERE id = p_user_id;
      RETURN jsonb_build_object(
        'success', true,
        'isNew', false,
        'status', v_operation.status,
        'chargeType', v_operation.charge_type,
        'chargedAmount', v_operation.charged_amount,
        'newBalance', v_balance,
        'result', v_operation.result
      );
    END IF;

    v_reusing := true;
    v_reservation_count := v_operation.reservation_count + 1;
  END IF;

  SELECT plan, credits, daily_used, last_reset_date
    INTO v_plan, v_balance, v_daily_used, v_last_reset_date
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF lower(COALESCE(v_plan, 'free')) = ANY (ARRAY['pro', 'enterprise', 'paid']) THEN
    v_charge_type := 'paid_credit';
    v_charged_amount := p_credit_cost;
    v_credit_operation_key :=
      'analysis:' || p_operation_id::text || ':' || v_reservation_count::text;

    v_consume_result := public.consume_credit_lots(
      v_credit_operation_key,
      p_operation_id::text,
      'analysis',
      p_user_id,
      p_credit_cost
    );
    v_balance := (v_consume_result->>'newBalance')::integer;
  ELSE
    IF v_last_reset_date IS DISTINCT FROM CURRENT_DATE THEN
      UPDATE public.profiles
         SET daily_used = 0,
             last_reset_date = CURRENT_DATE
       WHERE id = p_user_id;
      v_daily_used := 0;
    END IF;

    IF COALESCE(v_daily_used, 0) >= 1 THEN
      RAISE EXCEPTION 'DAILY_LIMIT' USING ERRCODE = 'P0001';
    END IF;

    v_charge_type := 'free_daily';
    v_charged_amount := 0;
    v_credit_operation_key := NULL;
    UPDATE public.profiles
       SET daily_used = COALESCE(daily_used, 0) + 1
     WHERE id = p_user_id;
  END IF;

  IF v_reusing THEN
    UPDATE public.analysis_credit_operations
       SET charge_type = v_charge_type,
           charged_amount = v_charged_amount,
           status = 'reserved',
           usage_date = CURRENT_DATE,
           result = NULL,
           reservation_count = reservation_count + 1,
           expires_at = v_now + make_interval(secs => p_reservation_seconds),
           updated_at = v_now,
           completed_at = NULL,
           refunded_at = NULL,
           refund_reason = NULL,
           credit_operation_key = v_credit_operation_key
     WHERE operation_id = p_operation_id;
  ELSE
    INSERT INTO public.analysis_credit_operations (
      operation_id,
      user_id,
      credit_cost,
      charge_type,
      charged_amount,
      status,
      usage_date,
      expires_at,
      credit_operation_key
    ) VALUES (
      p_operation_id,
      p_user_id,
      p_credit_cost,
      v_charge_type,
      v_charged_amount,
      'reserved',
      CURRENT_DATE,
      v_now + make_interval(secs => p_reservation_seconds),
      v_credit_operation_key
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'isNew', true,
    'status', 'reserved',
    'chargeType', v_charge_type,
    'chargedAmount', v_charged_amount,
    'newBalance', v_balance,
    'result', NULL
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_analysis_operation(
  p_operation_id uuid,
  p_user_id uuid,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation public.analysis_credit_operations%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_ANALYSIS_RESULT' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_operation
    FROM public.analysis_credit_operations
   WHERE operation_id = p_operation_id
   FOR UPDATE;

  IF NOT FOUND OR v_operation.user_id <> p_user_id THEN
    RAISE EXCEPTION 'OPERATION_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_operation.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'completed',
      'alreadyCompleted', true,
      'result', v_operation.result
    );
  END IF;
  IF v_operation.status <> 'reserved' THEN
    RAISE EXCEPTION 'OPERATION_NOT_RESERVED' USING ERRCODE = 'P0001';
  END IF;

  IF v_operation.charge_type = 'paid_credit' THEN
    IF v_operation.credit_operation_key IS NULL THEN
      RAISE EXCEPTION 'CREDIT_OPERATION_KEY_MISSING' USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.complete_credit_operation(
      v_operation.credit_operation_key,
      p_user_id
    );
  END IF;

  UPDATE public.analysis_credit_operations
     SET status = 'completed',
         result = p_result,
         completed_at = v_now,
         updated_at = v_now,
         expires_at = v_now
   WHERE operation_id = p_operation_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'completed',
    'alreadyCompleted', false,
    'result', p_result
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_analysis_operation(
  p_operation_id uuid,
  p_user_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation public.analysis_credit_operations%ROWTYPE;
  v_refund_result jsonb;
  v_balance integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT *
    INTO v_operation
    FROM public.analysis_credit_operations
   WHERE operation_id = p_operation_id
   FOR UPDATE;

  IF NOT FOUND OR v_operation.user_id <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'status', 'missing', 'refunded', false);
  END IF;
  IF v_operation.status = 'completed' THEN
    SELECT credits INTO v_balance FROM public.profiles WHERE id = p_user_id;
    RETURN jsonb_build_object(
      'success', true,
      'status', 'completed',
      'refunded', false,
      'newBalance', v_balance
    );
  END IF;
  IF v_operation.status = 'refunded' THEN
    SELECT credits INTO v_balance FROM public.profiles WHERE id = p_user_id;
    RETURN jsonb_build_object(
      'success', true,
      'status', 'refunded',
      'refunded', false,
      'newBalance', v_balance
    );
  END IF;

  IF v_operation.charge_type = 'paid_credit' AND v_operation.charged_amount > 0 THEN
    IF v_operation.credit_operation_key IS NULL THEN
      RAISE EXCEPTION 'CREDIT_OPERATION_KEY_MISSING' USING ERRCODE = 'P0001';
    END IF;
    v_refund_result := public.refund_credit_operation(
      v_operation.credit_operation_key,
      p_user_id,
      p_reason
    );
    v_balance := (v_refund_result->>'newBalance')::integer;
  ELSE
    UPDATE public.profiles
       SET daily_used = GREATEST(COALESCE(daily_used, 0) - 1, 0)
     WHERE id = p_user_id
       AND last_reset_date = v_operation.usage_date
     RETURNING credits INTO v_balance;

    IF v_balance IS NULL THEN
      SELECT credits INTO v_balance FROM public.profiles WHERE id = p_user_id;
    END IF;
  END IF;

  UPDATE public.analysis_credit_operations
     SET status = 'refunded',
         result = NULL,
         refund_count = refund_count + 1,
         refunded_at = v_now,
         updated_at = v_now,
         expires_at = v_now,
         refund_reason = left(COALESCE(p_reason, 'analysis_failed'), 500)
   WHERE operation_id = p_operation_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'refunded',
    'refunded', true,
    'newBalance', v_balance
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.refund_stale_analysis_operations(
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation record;
  v_refunded integer := 0;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'INVALID_SWEEP_LIMIT' USING ERRCODE = '22023';
  END IF;

  FOR v_operation IN
    SELECT *
      FROM public.analysis_credit_operations
     WHERE status = 'reserved'
       AND expires_at <= v_now
     ORDER BY expires_at
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  LOOP
    IF v_operation.charge_type = 'paid_credit' AND v_operation.charged_amount > 0 THEN
      IF v_operation.credit_operation_key IS NULL THEN
        RAISE EXCEPTION 'CREDIT_OPERATION_KEY_MISSING' USING ERRCODE = 'P0001';
      END IF;
      PERFORM public.refund_credit_operation(
        v_operation.credit_operation_key,
        v_operation.user_id,
        'stale_reservation_recovered'
      );
    ELSE
      UPDATE public.profiles
         SET daily_used = GREATEST(COALESCE(daily_used, 0) - 1, 0)
       WHERE id = v_operation.user_id
         AND last_reset_date = v_operation.usage_date;
    END IF;

    UPDATE public.analysis_credit_operations
       SET status = 'refunded',
           result = NULL,
           refund_count = refund_count + 1,
           refunded_at = v_now,
           updated_at = v_now,
           refund_reason = 'stale_reservation_recovered'
     WHERE operation_id = v_operation.operation_id
       AND status = 'reserved';

    IF FOUND THEN
      v_refunded := v_refunded + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'refunded', v_refunded);
END;
$function$;

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
  v_active integer;
  v_now timestamptz := clock_timestamp();
  v_credit_operation_key text;
  v_consume_result jsonb;
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

  SELECT plan
    INTO v_plan
    FROM public.profiles
   WHERE id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF lower(COALESCE(v_plan, 'free')) <> ALL (ARRAY['pro', 'enterprise', 'paid']) THEN
    RAISE EXCEPTION 'PLAN_NOT_ALLOWED' USING ERRCODE = 'P0001';
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

  v_credit_operation_key := 'storyboard:' || p_storyboard_id;

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
    credit_charged_at,
    credit_operation_key
  ) VALUES (
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
    v_now,
    v_credit_operation_key
  );

  v_consume_result := public.consume_credit_lots(
    v_credit_operation_key,
    p_storyboard_id,
    'storyboard',
    p_user_id,
    p_credit_cost
  );

  RETURN jsonb_build_object(
    'success', true,
    'storyboardId', p_storyboard_id,
    'status', 'pending',
    'newBalance', (v_consume_result->>'newBalance')::integer
  );
END;
$function$;

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
    SELECT s.id, s.user_id, s.credits_used, s.credit_operation_key
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
    IF v_expired.credit_operation_key IS NULL THEN
      RAISE EXCEPTION 'CREDIT_OPERATION_KEY_MISSING' USING ERRCODE = 'P0001';
    END IF;

    PERFORM public.refund_credit_operation(
      v_expired.credit_operation_key,
      v_expired.user_id,
      'durable_worker_exhausted'
    );

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
DECLARE
  v_user_id uuid;
  v_credit_operation_key text;
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
     AND claim_token = p_claim_token
  RETURNING user_id, credit_operation_key
       INTO v_user_id, v_credit_operation_key;

  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_credit_operation_key IS NULL THEN
    RAISE EXCEPTION 'CREDIT_OPERATION_KEY_MISSING' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.complete_credit_operation(
    v_credit_operation_key,
    v_user_id
  );
  RETURN true;
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

  IF v_job.credit_refunded_at IS NULL AND v_job.credit_charged_at IS NOT NULL THEN
    IF v_job.credit_operation_key IS NULL THEN
      RAISE EXCEPTION 'CREDIT_OPERATION_KEY_MISSING' USING ERRCODE = 'P0001';
    END IF;
    PERFORM public.refund_credit_operation(
      v_job.credit_operation_key,
      v_job.user_id,
      'durable_worker_final_failure'
    );
    v_refunded := true;
  END IF;

  UPDATE public.storyboards
     SET status = 'failed',
         current_step = NULL,
         progress = 0,
         failed_at = clock_timestamp(),
         credit_refunded_at = CASE
           WHEN v_refunded THEN clock_timestamp()
           ELSE credit_refunded_at
         END,
         lease_expires_at = NULL,
         claim_token = NULL,
         worker_id = NULL,
         error_message = left(
           COALESCE(p_error_message, 'Unknown error') ||
           CASE
             WHEN v_refunded THEN ' | REFUND: durable_worker_final_failure'
             ELSE ''
           END,
           4000
         )
   WHERE id = p_storyboard_id;

  RETURN jsonb_build_object(
    'accepted', true,
    'status', 'failed',
    'refunded', v_refunded
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_credit_lot_balance(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.consume_credit_lots(text, text, text, uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_credit_operation(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.refund_credit_operation(text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.register_credit_pack_checkout_intent(
  text, uuid, text, text, text, text, integer, integer, text, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_credit_pack_purchase(
  text, uuid, text, text, text, integer, integer, text, text, integer, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_credit_pack_adjustment(text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.expire_subscription_credits(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bridge_legacy_subscription_cancellation()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.apply_subscription_payment(text, uuid, text, integer, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_purchase_refund(text, text, integer, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_plan_change(uuid, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_analysis_operation(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_analysis_operation(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.refund_analysis_operation(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.refund_stale_analysis_operations(integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enqueue_storyboard_job(
  text, uuid, text, text[], text, integer, text[], integer, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_storyboard_jobs(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_storyboard_job(text, uuid, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fail_storyboard_job(text, uuid, text, boolean, integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.expire_subscription_credits(uuid)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.apply_purchase_refund(text, text, integer, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_plan_change(uuid, text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_operation(uuid, uuid, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_operation(uuid, uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_analysis_operation(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_stale_analysis_operations(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_storyboard_job(
  text, uuid, text, text[], text, integer, text[], integer, integer, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_storyboard_jobs(text, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_storyboard_job(text, uuid, jsonb, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_storyboard_job(text, uuid, text, boolean, integer)
  TO service_role;

DO $invariants$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.credit_lots
     WHERE credits_remaining < 0
        OR credits_expired < 0
        OR credits_remaining + credits_expired > credits_granted
        OR (
          status = 'active'
          AND (credits_remaining = 0 OR credits_expired <> 0)
        )
        OR (status <> 'active' AND credits_remaining <> 0)
  ) THEN
    RAISE EXCEPTION 'CREDIT_LOT_STATE_INVARIANT_FAILED';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.credit_operations o
      LEFT JOIN (
        SELECT operation_key, sum(credits_allocated)::integer AS allocated
          FROM public.credit_operation_allocations
         GROUP BY operation_key
      ) a USING (operation_key)
     WHERE COALESCE(a.allocated, 0) <> o.credits_charged
  ) THEN
    RAISE EXCEPTION 'CREDIT_ALLOCATION_INVARIANT_FAILED';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.credit_pack_checkout_intents i
      LEFT JOIN public.credit_pack_purchases p
        ON p.transaction_id = i.transaction_id
     WHERE (i.status = 'fulfilled' AND p.transaction_id IS NULL)
        OR (p.transaction_id IS NOT NULL AND i.status <> 'fulfilled')
  ) THEN
    RAISE EXCEPTION 'CREDIT_PACK_INTENT_INVARIANT_FAILED';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.profiles p
      LEFT JOIN (
        SELECT user_id, sum(credits_remaining)::integer AS active_credits
          FROM public.credit_lots
         WHERE status = 'active'
           AND (expires_at IS NULL OR expires_at > clock_timestamp())
         GROUP BY user_id
      ) l ON l.user_id = p.id
     WHERE p.credits <> COALESCE(l.active_credits, 0)
  ) THEN
    RAISE EXCEPTION 'PROFILE_CREDIT_BALANCE_INVARIANT_FAILED';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM promptgen_private.legacy_credit_classification_manifest m
      LEFT JOIN public.credit_lots l
        ON l.user_id = m.user_id
       AND l.source_id = 'legacy:' || m.batch_id::text || ':' || m.user_id::text
     WHERE l.id IS NULL
        OR l.source_kind IS DISTINCT FROM m.classification
        OR l.credits_granted IS DISTINCT FROM m.expected_credits
        OR l.credits_remaining IS DISTINCT FROM m.expected_credits
        OR l.status IS DISTINCT FROM 'active'
        OR l.expires_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_BACKFILL_INVARIANT_FAILED';
  END IF;
END;
$invariants$;

UPDATE promptgen_private.legacy_credit_classification_manifest
   SET consumed_at = clock_timestamp()
 WHERE consumed_at IS NULL;

DO $manifest_consumed$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM promptgen_private.legacy_credit_classification_manifest
     WHERE consumed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_CONSUMPTION_FAILED';
  END IF;
END;
$manifest_consumed$;

COMMIT;

-- Post-migration verification (all mismatch counts must be zero):
-- SELECT count(*) FROM public.profiles p
-- LEFT JOIN (
--   SELECT user_id, sum(credits_remaining)::integer AS active_credits
--   FROM public.credit_lots
--   WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now())
--   GROUP BY user_id
-- ) l ON l.user_id = p.id
-- WHERE p.credits <> COALESCE(l.active_credits, 0);
--
-- SELECT count(*) FROM public.credit_operation_allocations
-- WHERE credits_refunded > credits_allocated;
--
-- SELECT count(*) FROM public.credit_pack_purchases
-- WHERE lot_id IS NULL;
