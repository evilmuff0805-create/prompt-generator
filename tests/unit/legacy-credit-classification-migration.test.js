'use strict';

const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
const manifestSql = fs.readFileSync(
  path.join(migrationsDir, '023_legacy_credit_classification_manifest.sql'),
  'utf8'
);
const ledgerSql = fs.readFileSync(
  path.join(migrationsDir, '024_credit_lot_ledger.sql'),
  'utf8'
);

describe('legacy-credit classification cutover contract', () => {
  test('keeps operator decisions in a private, non-runtime schema', () => {
    expect(manifestSql).toContain('CREATE SCHEMA promptgen_private;');
    expect(manifestSql).toContain(
      'ALTER TABLE promptgen_private.legacy_credit_classification_manifest\n' +
      '  ENABLE ROW LEVEL SECURITY;'
    );
    expect(manifestSql).toMatch(
      /REVOKE ALL ON SCHEMA promptgen_private[\s\S]{0,100}FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(manifestSql).toMatch(
      /REVOKE ALL ON TABLE promptgen_private\.legacy_credit_classification_manifest[\s\S]{0,100}FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(manifestSql).not.toMatch(/GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)/);
  });

  test('allows only explicit subscription carry-in or manual carryover decisions', () => {
    expect(manifestSql).toMatch(
      /classification\s+TEXT NOT NULL[\s\S]{0,220}'subscription_carry_in'[\s\S]{0,100}'manual_carryover'/
    );
    expect(manifestSql).toContain(
      'CONSTRAINT legacy_credit_manifest_one_decision_per_user UNIQUE (user_id)'
    );
    expect(manifestSql).toContain('expected_credits > 0');
    expect(manifestSql).toContain("expected_evidence_fingerprint ~ '^[0-9a-f]{64}$'");
  });

  test('fingerprints profile, purchase, and credit-ledger evidence without storing PII', () => {
    expect(manifestSql).toContain(
      'promptgen_private.legacy_credit_evidence_fingerprint'
    );
    expect(manifestSql).toContain('extensions.digest(');
    expect(manifestSql).toContain("'sha256'");
    expect(manifestSql).toContain("'formatVersion', 2");
    expect(manifestSql).toContain('p.paddle_customer_id,');
    expect(manifestSql).toContain('p.paddle_subscription_id');
    expect(manifestSql).not.toContain("NULLIF(btrim(p.paddle_customer_id), '')");
    expect(manifestSql).not.toContain("NULLIF(btrim(p.paddle_subscription_id), '')");
    expect(manifestSql).toContain('FROM public.purchases x');
    expect(manifestSql).toContain('FROM public.credits_ledger l');
    expect(manifestSql).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
    expect(manifestSql).not.toMatch(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
    );
  });

  test('rejects unreplaced operator-review placeholders', () => {
    expect(manifestSql).toContain("btrim(review_reference) !~ '^<[^>]+>$'");
    expect(manifestSql).toContain("btrim(reviewed_by) !~ '^<[^>]+>$'");
  });

  test('makes consumed approvals immutable and rejects pre-consumed inserts', () => {
    expect(manifestSql).toContain("IF TG_OP = 'INSERT' THEN");
    expect(manifestSql).toContain('LEGACY_CREDIT_MANIFEST_INVALID_CONSUMPTION');
    expect(manifestSql).toContain('LEGACY_CREDIT_MANIFEST_IMMUTABLE');
    expect(manifestSql).toContain('LEGACY_CREDIT_MANIFEST_APPROVAL_CHANGED');
    expect(manifestSql).toMatch(
      /BEFORE INSERT OR UPDATE OR DELETE[\s\S]{0,180}legacy_credit_classification_manifest/
    );
  });

  test('locks the evidence boundary and fails closed before creating ledger objects', () => {
    const createLedger = ledgerSql.indexOf('CREATE TABLE public.credit_lots');
    for (const marker of [
      "SET LOCAL lock_timeout = '5s'",
      'CREDIT_LEDGER_MIGRATION_ALREADY_RUNNING',
      'LEGACY_CREDIT_MANIFEST_MISSING',
      'LEGACY_CREDIT_MANIFEST_EXTRA',
      'LEGACY_CREDIT_MANIFEST_TOTAL_MISMATCH',
      'LEGACY_CREDIT_MANIFEST_MIXED_SNAPSHOT',
      'LEGACY_CREDIT_MANIFEST_SNAPSHOT_DRIFT',
      'LEGACY_CREDIT_MANIFEST_STALE_OR_FUTURE'
    ]) {
      const markerIndex = ledgerSql.indexOf(marker);
      expect(markerIndex).toBeGreaterThan(0);
      expect(markerIndex).toBeLessThan(createLedger);
    }
    for (const table of [
      'public.profiles',
      'public.purchases',
      'public.credits_ledger',
      'public.analysis_credit_operations',
      'public.storyboards',
      'promptgen_private.legacy_credit_classification_manifest'
    ]) {
      expect(ledgerSql).toMatch(
        new RegExp(`LOCK TABLE ${table.replace('.', '\\.')}`)
      );
    }
  });

  test('backfills only reviewed rows and keeps manual carryover non-expiring', () => {
    expect(ledgerSql).toContain(
      'JOIN promptgen_private.legacy_credit_classification_manifest m'
    );
    expect(ledgerSql).toContain("source_kind <> 'manual_carryover' OR expires_at IS NULL");
    expect(ledgerSql).toContain(
      "source_kind IN ('subscription', 'subscription_carry_in')"
    );
    expect(ledgerSql).toContain(
      "source_kind IN ('credit_pack', 'manual_carryover')"
    );
    expect(ledgerSql).not.toContain("WHEN 'migration' THEN");
    expect(ledgerSql).not.toContain("source_kind IN ('subscription', 'migration')");
  });

  test('spends expiring sources before non-expiring manual carryover', () => {
    const orderStart = ledgerSql.indexOf('CASE source_kind');
    const orderEnd = ledgerSql.indexOf('END,', orderStart);
    const orderSql = ledgerSql.slice(orderStart, orderEnd);

    expect(orderSql.indexOf("WHEN 'subscription' THEN 0")).toBeGreaterThan(-1);
    expect(orderSql.indexOf("WHEN 'subscription_carry_in' THEN 1"))
      .toBeGreaterThan(orderSql.indexOf("WHEN 'subscription' THEN 0"));
    expect(orderSql.indexOf("WHEN 'credit_pack' THEN 2"))
      .toBeGreaterThan(orderSql.indexOf("WHEN 'subscription_carry_in' THEN 1"));
    expect(orderSql.indexOf("WHEN 'manual_carryover' THEN 3"))
      .toBeGreaterThan(orderSql.indexOf("WHEN 'credit_pack' THEN 2"));
  });

  test('consumes the manifest only after final ledger invariants and before commit', () => {
    const invariants = ledgerSql.indexOf('DO $invariants$');
    const consume = ledgerSql.indexOf(
      'UPDATE promptgen_private.legacy_credit_classification_manifest'
    );
    const commit = ledgerSql.lastIndexOf('COMMIT;');

    expect(invariants).toBeGreaterThan(0);
    expect(consume).toBeGreaterThan(invariants);
    expect(commit).toBeGreaterThan(consume);
    expect(ledgerSql).toContain('LEGACY_CREDIT_BACKFILL_INVARIANT_FAILED');
    expect(ledgerSql).toContain('LEGACY_CREDIT_MANIFEST_CONSUMPTION_FAILED');
  });
});
