'use strict';

const {
  DEFAULT_RELEASE_CUTOVER,
  evaluateCreditPolicyAudit,
  collectCreditPolicyAudit
} = require('../../lib/credit-policy-audit');
const {
  DEFAULT_EXPECTED_PROJECT_REF,
  assertAuditProject
} = require('../../scripts/audit-credit-policy-v2');

const NOW = new Date('2026-07-25T11:05:00.000Z');

function healthySnapshot(overrides = {}) {
  return {
    profiles: [{ id: 'u1', plan: 'pro', credits: 30 }],
    ledger: [{
      id: 1,
      user_id: 'u1',
      credits_before: 40,
      credits_after: 30,
      delta: -10,
      plan_before: 'pro',
      plan_after: 'pro',
      created_at: '2026-07-25T00:53:41.000Z'
    }],
    storyboards: [],
    analysisOperations: [],
    webhookEvents: [{
      event_id: 'evt_1',
      status: 'completed',
      lease_expires_at: null
    }],
    incidents: [],
    purchases: [],
    latestHealth: {
      checked_at: '2026-07-25T11:00:00.000Z',
      result: {
        pendingStuck: 0,
        processingStuck: 0,
        refundMissing: 0,
        storyboardCleanupOverdue: 0,
        referenceCleanupOverdue: 0
      }
    },
    ...overrides
  };
}

describe('credit policy v2 post-deploy audit', () => {
  test('refuses to audit a Supabase project other than PromptGen', () => {
    expect(assertAuditProject(
      `https://${DEFAULT_EXPECTED_PROJECT_REF}.supabase.co`
    )).toBe(DEFAULT_EXPECTED_PROJECT_REF);
    expect(() => assertAuditProject('https://another-project.supabase.co'))
      .toThrow(`expected "${DEFAULT_EXPECTED_PROJECT_REF}"`);
    expect(() => assertAuditProject('not-a-url'))
      .toThrow('SUPABASE_URL must be a valid URL.');
  });

  test('passes the read-only T0 baseline and treats pre-cutover legacy deductions as historical', () => {
    const result = evaluateCreditPolicyAudit(healthySnapshot(), { now: NOW });

    expect(result.success).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.metrics.profiles).toEqual({
      total: 1,
      negative: 0,
      creditSum: 30
    });
    expect(result.metrics.ledger).toMatchObject({
      rows: 1,
      continuityGaps: 0,
      profileMismatches: 0,
      legacyDeductionsAfterCutover: 0
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'NO_POST_CUTOVER_STORYBOARDS',
      'NO_ANALYSIS_OPERATIONS',
      'NO_POST_CUTOVER_PURCHASES'
    ]);
  });

  test('fails closed on payment, credit, refund, webhook, and health anomalies', () => {
    const snapshot = healthySnapshot({
      profiles: [{ id: 'u1', plan: 'pro', credits: -1 }],
      ledger: [
        {
          id: 1,
          user_id: 'u1',
          credits_before: 40,
          credits_after: 30,
          delta: -10,
          plan_before: 'pro',
          plan_after: 'pro',
          created_at: '2026-07-25T03:00:00.000Z'
        },
        {
          id: 2,
          user_id: 'u1',
          credits_before: 25,
          credits_after: 23,
          delta: -2,
          plan_before: 'pro',
          plan_after: 'pro',
          created_at: '2026-07-25T03:01:00.000Z'
        }
      ],
      storyboards: [
        {
          id: 'sb_legacy',
          status: 'completed',
          credits_used: 120,
          reference_image_ids: [],
          created_at: '2026-07-25T04:00:00.000Z',
          updated_at: '2026-07-25T04:00:00.000Z'
        },
        {
          id: 'sb_formula',
          status: 'failed',
          credits_used: 35,
          reference_image_ids: [],
          credit_charged_at: '2026-07-25T04:00:00.000Z',
          credit_refunded_at: null,
          created_at: '2026-07-25T04:00:00.000Z',
          updated_at: '2026-07-25T04:00:00.000Z'
        }
      ],
      analysisOperations: [{
        operation_id: 'op_1',
        status: 'reserved',
        credit_cost: 10,
        charge_type: 'paid_credit',
        charged_amount: 10,
        refund_count: 1,
        expires_at: '2026-07-25T04:00:00.000Z'
      }],
      webhookEvents: [
        { event_id: 'evt_failed', status: 'failed', lease_expires_at: null },
        {
          event_id: 'evt_expired',
          status: 'processing',
          lease_expires_at: '2026-07-25T04:00:00.000Z'
        }
      ],
      incidents: [{ id: 1, severity: 'warn', event_code: 'TEST' }],
      purchases: [{
        id: 1,
        plan: 'unknown',
        credits_granted: 1000,
        created_at: '2026-07-25T05:00:00.000Z'
      }],
      latestHealth: {
        checked_at: '2026-07-25T10:00:00.000Z',
        result: { refundMissing: 1 }
      }
    });

    const result = evaluateCreditPolicyAudit(snapshot, { now: NOW });
    const failureCodes = new Set(result.failures.map((failure) => failure.code));

    expect(result.success).toBe(false);
    expect(failureCodes).toEqual(new Set([
      'NEGATIVE_PROFILE_CREDITS',
      'LEDGER_CONTINUITY_GAP',
      'LEDGER_PROFILE_MISMATCH',
      'LEGACY_DEDUCTION_AFTER_V2',
      'INVALID_STORYBOARD_COST',
      'STORYBOARD_FORMULA_MISMATCH',
      'STORYBOARD_REFUND_MISSING',
      'EXPIRED_ANALYSIS_RESERVATION',
      'INVALID_ANALYSIS_AMOUNT',
      'ANALYSIS_REFUND_COUNT_ANOMALY',
      'FAILED_PADDLE_WEBHOOK',
      'EXPIRED_PADDLE_WEBHOOK_LEASE',
      'UNRESOLVED_INCIDENT',
      'PURCHASE_GRANT_MISMATCH',
      'OPS_HEALTH_STALE_OR_MISSING',
      'OPS_HEALTH_FAILURE'
    ]));
  });

  test('collects all read-only sources with the fixed release cutover', async () => {
    const snapshot = healthySnapshot();
    const repository = {
      getProfiles: jest.fn().mockResolvedValue(snapshot.profiles),
      getLedger: jest.fn().mockResolvedValue(snapshot.ledger),
      getStoryboards: jest.fn().mockResolvedValue(snapshot.storyboards),
      getAnalysisOperations: jest.fn().mockResolvedValue(snapshot.analysisOperations),
      getWebhookEvents: jest.fn().mockResolvedValue(snapshot.webhookEvents),
      getOpenIncidents: jest.fn().mockResolvedValue(snapshot.incidents),
      getPurchases: jest.fn().mockResolvedValue(snapshot.purchases),
      getLatestHealthCheck: jest.fn().mockResolvedValue(snapshot.latestHealth)
    };

    const result = await collectCreditPolicyAudit({
      repository,
      now: NOW,
      cutover: DEFAULT_RELEASE_CUTOVER
    });

    expect(result.success).toBe(true);
    expect(repository.getStoryboards).toHaveBeenCalledWith(DEFAULT_RELEASE_CUTOVER);
    expect(repository.getAnalysisOperations).toHaveBeenCalledWith(DEFAULT_RELEASE_CUTOVER);
    expect(repository.getPurchases).toHaveBeenCalledWith(DEFAULT_RELEASE_CUTOVER);
    expect(repository.getProfiles).toHaveBeenCalledTimes(1);
    expect(repository.getLatestHealthCheck).toHaveBeenCalledTimes(1);
  });
});
