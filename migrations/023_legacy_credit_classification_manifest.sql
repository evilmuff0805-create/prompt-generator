-- ============================================================
-- Migration 023: operator-reviewed legacy-credit classification
--
-- This migration creates a private, one-time cutover manifest. It does not
-- classify or mutate a balance. The operator must populate one reviewed row
-- for every positive profiles.credits balance while billing writers are
-- frozen. Migration 024 validates and consumes the exact snapshot.
--
-- Never place production emails, user UUIDs, or Paddle identifiers in this
-- checked-in file. Populate the manifest only through the restricted owner
-- session described in docs/payment-pricing-rollout.md.
-- ============================================================

BEGIN;

CREATE SCHEMA promptgen_private;

REVOKE ALL ON SCHEMA promptgen_private
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE promptgen_private.legacy_credit_classification_manifest (
  batch_id                       UUID NOT NULL,
  user_id                        UUID NOT NULL,
  snapshot_captured_at           TIMESTAMPTZ NOT NULL,
  expected_plan                  TEXT NOT NULL
                                 CHECK (
                                   expected_plan IN (
                                     'free',
                                     'paid',
                                     'pro',
                                     'enterprise'
                                   )
                                 ),
  expected_credits               INTEGER NOT NULL CHECK (expected_credits > 0),
  expected_has_paddle_customer   BOOLEAN NOT NULL,
  expected_has_paddle_subscription BOOLEAN NOT NULL,
  expected_purchase_count        BIGINT NOT NULL CHECK (expected_purchase_count >= 0),
  expected_ledger_count          BIGINT NOT NULL CHECK (expected_ledger_count >= 0),
  expected_evidence_fingerprint  TEXT NOT NULL
                                 CHECK (
                                   expected_evidence_fingerprint ~ '^[0-9a-f]{64}$'
                                 ),
  classification                 TEXT NOT NULL
                                 CHECK (
                                   classification IN (
                                     'subscription_carry_in',
                                     'manual_carryover'
                                   )
                                 ),
  review_reference               TEXT NOT NULL
                                 CHECK (
                                   btrim(review_reference) <> ''
                                   AND length(review_reference) <= 255
                                   AND btrim(review_reference) !~ '^<[^>]+>$'
                                 ),
  reviewed_by                    TEXT NOT NULL
                                 CHECK (
                                   btrim(reviewed_by) <> ''
                                   AND length(reviewed_by) <= 255
                                   AND btrim(reviewed_by) !~ '^<[^>]+>$'
                                 ),
  reviewed_at                    TIMESTAMPTZ NOT NULL,
  consumed_at                    TIMESTAMPTZ,
  PRIMARY KEY (batch_id, user_id),
  CONSTRAINT legacy_credit_manifest_one_decision_per_user UNIQUE (user_id),
  CONSTRAINT legacy_credit_manifest_review_time_check CHECK (
    reviewed_at >= snapshot_captured_at
  ),
  CONSTRAINT legacy_credit_manifest_consumed_time_check CHECK (
    consumed_at IS NULL OR consumed_at >= reviewed_at
  )
);

ALTER TABLE promptgen_private.legacy_credit_classification_manifest
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE promptgen_private.legacy_credit_classification_manifest
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION promptgen_private.legacy_credit_evidence_fingerprint(
  p_user_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT encode(
    extensions.digest(
      jsonb_build_object(
        'formatVersion', 2,
        'profile', jsonb_build_array(
          p.plan,
          p.credits,
          p.paddle_customer_id,
          p.paddle_subscription_id
        ),
        'purchases', COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_array(
                x.id,
                x.transaction_id,
                x.plan,
                x.credits_granted,
                x.status,
                extract(epoch FROM x.created_at),
                x.subscription_id,
                x.transaction_type
              )
              ORDER BY x.id
            )
              FROM public.purchases x
             WHERE x.user_id = p.id
          ),
          '[]'::jsonb
        ),
        'creditsLedger', COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_array(
                l.id,
                l.credits_before,
                l.credits_after,
                l.delta,
                l.plan_before,
                l.plan_after,
                extract(epoch FROM l.created_at)
              )
              ORDER BY l.id
            )
              FROM public.credits_ledger l
             WHERE l.user_id = p.id
          ),
          '[]'::jsonb
        )
      )::text,
      'sha256'
    ),
    'hex'
  )
    FROM public.profiles p
   WHERE p.id = p_user_id;
$function$;

REVOKE ALL ON FUNCTION
  promptgen_private.legacy_credit_evidence_fingerprint(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION
  promptgen_private.guard_legacy_credit_classification_manifest()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_INVALID_CONSUMPTION'
        USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_IMMUTABLE'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.batch_id,
    NEW.user_id,
    NEW.snapshot_captured_at,
    NEW.expected_plan,
    NEW.expected_credits,
    NEW.expected_has_paddle_customer,
    NEW.expected_has_paddle_subscription,
    NEW.expected_purchase_count,
    NEW.expected_ledger_count,
    NEW.expected_evidence_fingerprint,
    NEW.classification,
    NEW.review_reference,
    NEW.reviewed_by,
    NEW.reviewed_at
  ) IS DISTINCT FROM ROW(
    OLD.batch_id,
    OLD.user_id,
    OLD.snapshot_captured_at,
    OLD.expected_plan,
    OLD.expected_credits,
    OLD.expected_has_paddle_customer,
    OLD.expected_has_paddle_subscription,
    OLD.expected_purchase_count,
    OLD.expected_ledger_count,
    OLD.expected_evidence_fingerprint,
    OLD.classification,
    OLD.review_reference,
    OLD.reviewed_by,
    OLD.reviewed_at
  ) THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_APPROVAL_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'LEGACY_CREDIT_MANIFEST_INVALID_CONSUMPTION'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION
  promptgen_private.guard_legacy_credit_classification_manifest()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_guard_legacy_credit_classification_manifest
  BEFORE INSERT OR UPDATE OR DELETE
  ON promptgen_private.legacy_credit_classification_manifest
  FOR EACH ROW
  EXECUTE FUNCTION
    promptgen_private.guard_legacy_credit_classification_manifest();

COMMENT ON TABLE promptgen_private.legacy_credit_classification_manifest IS
  'Private, operator-reviewed legacy-credit cutover decisions. Contains opaque user UUIDs, but no direct PII or raw provider IDs.';

COMMENT ON FUNCTION
  promptgen_private.legacy_credit_evidence_fingerprint(uuid) IS
  'Returns a SHA-256 fingerprint of one profile and its purchase/credit evidence.';

COMMIT;

-- Verification (all values must be false):
-- SELECT has_schema_privilege('anon', 'promptgen_private', 'USAGE');
-- SELECT has_schema_privilege('authenticated', 'promptgen_private', 'USAGE');
-- SELECT has_schema_privilege('service_role', 'promptgen_private', 'USAGE');
