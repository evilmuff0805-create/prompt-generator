'use strict';

const {
  ANALYSIS_CREDIT_COST,
  PLAN_CREDITS,
  calculateStoryboardCreditCost
} = require('./product-catalog');

const DEFAULT_RELEASE_CUTOVER = '2026-07-25T02:47:27.000Z';
const STORYBOARD_COSTS = new Set([30, 35, 40, 45, 50]);
const LEGACY_DEDUCTION_DELTAS = new Set([-10, -120, -250]);
const AUDIT_PAGE_SIZE = 1000;
const AUDIT_MAX_ROWS = 50000;
const HEALTH_MAX_AGE_MS = 15 * 60 * 1000;

function auditError(message, code = 'CREDIT_POLICY_AUDIT_FAILED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw auditError(`${label} must be a valid date`, 'INVALID_AUDIT_DATE');
  }
  return date;
}

async function fetchAll(buildQuery, {
  pageSize = AUDIT_PAGE_SIZE,
  maxRows = AUDIT_MAX_ROWS,
  label
} = {}) {
  const rows = [];

  while (rows.length < maxRows) {
    const from = rows.length;
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) {
      throw auditError(`${label || 'audit query'} failed: ${error.message}`);
    }

    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }

  throw auditError(
    `${label || 'audit query'} exceeded the ${maxRows}-row safety limit`,
    'AUDIT_ROW_LIMIT_EXCEEDED'
  );
}

function createSupabaseAuditRepository(client, options = {}) {
  if (!client) throw auditError('Supabase client is required');

  const fetchOptions = {
    pageSize: options.pageSize,
    maxRows: options.maxRows
  };

  return {
    getProfiles() {
      return fetchAll(
        () => client.from('profiles').select('id, plan, credits').order('id'),
        { ...fetchOptions, label: 'profiles audit' }
      );
    },

    getLedger() {
      return fetchAll(
        () => client
          .from('credits_ledger')
          .select('id, user_id, credits_before, credits_after, delta, plan_before, plan_after, created_at')
          .order('id'),
        { ...fetchOptions, label: 'credits ledger audit' }
      );
    },

    getStoryboards(cutoverIso) {
      return fetchAll(
        () => client
          .from('storyboards')
          .select('id, status, credits_used, reference_image_ids, credit_charged_at, credit_refunded_at, created_at, updated_at')
          .gte('created_at', cutoverIso)
          .order('created_at'),
        { ...fetchOptions, label: 'Storyboard audit' }
      );
    },

    getAnalysisOperations(cutoverIso) {
      return fetchAll(
        () => client
          .from('analysis_credit_operations')
          .select('operation_id, status, credit_cost, charge_type, charged_amount, refund_count, expires_at, created_at')
          .gte('created_at', cutoverIso)
          .order('created_at'),
        { ...fetchOptions, label: 'analysis operation audit' }
      );
    },

    getWebhookEvents() {
      return fetchAll(
        () => client
          .from('webhook_events')
          .select('event_id, status, lease_expires_at, received_at, updated_at')
          .order('received_at'),
        { ...fetchOptions, label: 'Paddle webhook audit' }
      );
    },

    getOpenIncidents() {
      return fetchAll(
        () => client
          .from('ops_incidents')
          .select('id, severity, event_code, last_seen_at')
          .is('resolved_at', null)
          .order('last_seen_at'),
        { ...fetchOptions, label: 'operations incident audit' }
      );
    },

    getPurchases(cutoverIso) {
      return fetchAll(
        () => client
          .from('purchases')
          .select('id, plan, credits_granted, status, transaction_type, created_at')
          .gte('created_at', cutoverIso)
          .order('created_at'),
        { ...fetchOptions, label: 'purchase grant audit' }
      );
    },

    async getLatestHealthCheck() {
      const { data, error } = await client
        .from('ops_health_checks')
        .select('checked_at, result')
        .order('checked_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        throw auditError(`operations health audit failed: ${error.message}`);
      }
      return data || null;
    }
  };
}

function countBy(rows, predicate) {
  return rows.reduce((count, row) => count + (predicate(row) ? 1 : 0), 0);
}

function addFinding(findings, code, count, message) {
  if (count > 0) findings.push({ code, count, message });
}

function evaluateCreditPolicyAudit(snapshot, {
  now = new Date(),
  cutover = DEFAULT_RELEASE_CUTOVER
} = {}) {
  const checkedAt = parseDate(now, 'now');
  const cutoverAt = parseDate(cutover, 'cutover');
  const cutoverMs = cutoverAt.getTime();

  const profiles = snapshot.profiles || [];
  const ledger = [...(snapshot.ledger || [])].sort((a, b) => Number(a.id) - Number(b.id));
  const storyboards = snapshot.storyboards || [];
  const analysisOperations = snapshot.analysisOperations || [];
  const webhookEvents = snapshot.webhookEvents || [];
  const incidents = snapshot.incidents || [];
  const purchases = snapshot.purchases || [];
  const latestHealth = snapshot.latestHealth || null;

  const failures = [];
  const warnings = [];
  const profileById = new Map(profiles.map((profile) => [String(profile.id), profile]));
  const previousLedgerByUser = new Map();
  const latestLedgerByUser = new Map();
  let ledgerContinuityGaps = 0;

  for (const row of ledger) {
    const userId = String(row.user_id);
    const previous = previousLedgerByUser.get(userId);
    if (previous && Number(previous.credits_after) !== Number(row.credits_before)) {
      ledgerContinuityGaps += 1;
    }
    previousLedgerByUser.set(userId, row);
    latestLedgerByUser.set(userId, row);
  }

  let ledgerProfileMismatches = 0;
  for (const [userId, row] of latestLedgerByUser) {
    const profile = profileById.get(userId);
    if (profile && Number(profile.credits) !== Number(row.credits_after)) {
      ledgerProfileMismatches += 1;
    }
  }

  const negativeProfiles = countBy(profiles, (row) => Number(row.credits) < 0);
  const legacyDeductions = countBy(ledger, (row) => {
    const createdAt = new Date(row.created_at).getTime();
    return createdAt >= cutoverMs
      && row.plan_before === row.plan_after
      && LEGACY_DEDUCTION_DELTAS.has(Number(row.delta));
  });

  const invalidStoryboardCosts = countBy(
    storyboards,
    (row) => !STORYBOARD_COSTS.has(Number(row.credits_used))
  );
  const storyboardFormulaMismatches = countBy(storyboards, (row) => {
    if (!STORYBOARD_COSTS.has(Number(row.credits_used))) return false;
    const referenceCount = Array.isArray(row.reference_image_ids)
      ? row.reference_image_ids.length
      : 0;
    return Number(row.credits_used) !== calculateStoryboardCreditCost(referenceCount);
  });
  const storyboardRefundMissing = countBy(storyboards, (row) => {
    if (row.status !== 'failed' || !row.credit_charged_at || row.credit_refunded_at) {
      return false;
    }
    return checkedAt.getTime() - new Date(row.updated_at).getTime() > 2 * 60 * 1000;
  });
  const activeStoryboards = countBy(
    storyboards,
    (row) => row.status === 'pending' || row.status === 'processing'
  );

  const expiredAnalysisReservations = countBy(
    analysisOperations,
    (row) => row.status === 'reserved'
      && new Date(row.expires_at).getTime() <= checkedAt.getTime()
  );
  const invalidAnalysisAmounts = countBy(analysisOperations, (row) => (
    Number(row.credit_cost) !== ANALYSIS_CREDIT_COST
    || (row.charge_type === 'paid_credit' && Number(row.charged_amount) !== ANALYSIS_CREDIT_COST)
    || (row.charge_type === 'free_daily' && Number(row.charged_amount) !== 0)
  ));
  const analysisRefundCountAnomalies = countBy(analysisOperations, (row) => (
    (row.status === 'refunded' && Number(row.refund_count) !== 1)
    || (row.status !== 'refunded' && Number(row.refund_count) !== 0)
  ));

  const failedWebhooks = countBy(webhookEvents, (row) => row.status === 'failed');
  const processingWebhooks = countBy(webhookEvents, (row) => row.status === 'processing');
  const expiredWebhookLeases = countBy(webhookEvents, (row) => (
    row.status === 'processing'
    && new Date(row.lease_expires_at).getTime() <= checkedAt.getTime()
  ));
  const unresolvedIncidents = incidents.length;
  const unresolvedHighIncidents = countBy(
    incidents,
    (row) => row.severity === 'error' || row.severity === 'critical'
  );

  const purchaseGrantMismatches = countBy(purchases, (row) => {
    const expected = PLAN_CREDITS[row.plan];
    return expected === undefined || Number(row.credits_granted) !== expected;
  });

  let healthStaleOrMissing = 0;
  let healthFailures = 0;
  if (!latestHealth) {
    healthStaleOrMissing = 1;
  } else {
    const age = checkedAt.getTime() - new Date(latestHealth.checked_at).getTime();
    if (!Number.isFinite(age) || age > HEALTH_MAX_AGE_MS) healthStaleOrMissing = 1;
    healthFailures = Object.values(latestHealth.result || {})
      .reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  }

  addFinding(failures, 'NEGATIVE_PROFILE_CREDITS', negativeProfiles, 'Profile credits must never be negative.');
  addFinding(failures, 'LEDGER_CONTINUITY_GAP', ledgerContinuityGaps, 'Ledger rows do not form a continuous credit chain.');
  addFinding(failures, 'LEDGER_PROFILE_MISMATCH', ledgerProfileMismatches, 'The latest ledger balance does not match the profile balance.');
  addFinding(failures, 'LEGACY_DEDUCTION_AFTER_V2', legacyDeductions, 'A legacy 10/120/250-credit deduction occurred after the v2 cutover.');
  addFinding(failures, 'INVALID_STORYBOARD_COST', invalidStoryboardCosts, 'A post-cutover Storyboard used a cost outside 30/35/40/45/50.');
  addFinding(failures, 'STORYBOARD_FORMULA_MISMATCH', storyboardFormulaMismatches, 'Storyboard credits do not match 30 + 5 per reference.');
  addFinding(failures, 'STORYBOARD_REFUND_MISSING', storyboardRefundMissing, 'A failed charged Storyboard is missing its refund.');
  addFinding(failures, 'EXPIRED_ANALYSIS_RESERVATION', expiredAnalysisReservations, 'An analysis reservation expired without completion or refund.');
  addFinding(failures, 'INVALID_ANALYSIS_AMOUNT', invalidAnalysisAmounts, 'An analysis operation does not use the 2-credit v2 policy.');
  addFinding(failures, 'ANALYSIS_REFUND_COUNT_ANOMALY', analysisRefundCountAnomalies, 'An analysis operation violates exactly-once refund accounting.');
  addFinding(failures, 'FAILED_PADDLE_WEBHOOK', failedWebhooks, 'A Paddle webhook remains failed.');
  addFinding(failures, 'EXPIRED_PADDLE_WEBHOOK_LEASE', expiredWebhookLeases, 'A Paddle webhook processing lease has expired.');
  addFinding(failures, 'UNRESOLVED_INCIDENT', unresolvedIncidents, 'An operations incident remains unresolved.');
  addFinding(failures, 'PURCHASE_GRANT_MISMATCH', purchaseGrantMismatches, 'A post-cutover purchase grant does not match 600/1,500 credits.');
  addFinding(failures, 'OPS_HEALTH_STALE_OR_MISSING', healthStaleOrMissing, 'The five-minute operations health scan is stale or missing.');
  addFinding(failures, 'OPS_HEALTH_FAILURE', healthFailures, 'The latest operations health scan contains a non-zero failure count.');

  addFinding(warnings, 'ACTIVE_STORYBOARDS', activeStoryboards, 'A post-cutover Storyboard is still active; recheck after completion.');
  addFinding(warnings, 'PADDLE_WEBHOOK_PROCESSING', processingWebhooks, 'A Paddle webhook is processing with a live lease.');
  if (storyboards.length === 0) {
    warnings.push({
      code: 'NO_POST_CUTOVER_STORYBOARDS',
      count: 0,
      message: 'No v2 Storyboard has been charged yet, so the live formula has no production sample.'
    });
  }
  if (analysisOperations.length === 0) {
    warnings.push({
      code: 'NO_ANALYSIS_OPERATIONS',
      count: 0,
      message: 'No v2 analysis operation has been recorded yet.'
    });
  }
  if (purchases.length === 0) {
    warnings.push({
      code: 'NO_POST_CUTOVER_PURCHASES',
      count: 0,
      message: 'No post-cutover purchase or renewal has occurred.'
    });
  }

  return {
    success: failures.length === 0,
    checkedAt: checkedAt.toISOString(),
    cutoverAt: cutoverAt.toISOString(),
    metrics: {
      profiles: {
        total: profiles.length,
        negative: negativeProfiles,
        creditSum: profiles.reduce((sum, row) => sum + Number(row.credits || 0), 0)
      },
      ledger: {
        rows: ledger.length,
        deltaSum: ledger.reduce((sum, row) => sum + Number(row.delta || 0), 0),
        continuityGaps: ledgerContinuityGaps,
        profileMismatches: ledgerProfileMismatches,
        legacyDeductionsAfterCutover: legacyDeductions
      },
      storyboards: {
        sinceCutover: storyboards.length,
        active: activeStoryboards,
        invalidCosts: invalidStoryboardCosts,
        formulaMismatches: storyboardFormulaMismatches,
        refundMissing: storyboardRefundMissing
      },
      analysisOperations: {
        total: analysisOperations.length,
        expiredReserved: expiredAnalysisReservations,
        invalidAmounts: invalidAnalysisAmounts,
        refundCountAnomalies: analysisRefundCountAnomalies
      },
      paddleWebhooks: {
        total: webhookEvents.length,
        failed: failedWebhooks,
        processing: processingWebhooks,
        expiredProcessing: expiredWebhookLeases
      },
      incidents: {
        unresolved: unresolvedIncidents,
        unresolvedHigh: unresolvedHighIncidents
      },
      purchases: {
        sinceCutover: purchases.length,
        grantMismatches: purchaseGrantMismatches
      },
      latestHealth
    },
    failures,
    warnings
  };
}

async function collectCreditPolicyAudit({
  repository,
  now = new Date(),
  cutover = DEFAULT_RELEASE_CUTOVER
}) {
  if (!repository) throw auditError('Audit repository is required');
  const cutoverIso = parseDate(cutover, 'cutover').toISOString();

  const [
    profiles,
    ledger,
    storyboards,
    analysisOperations,
    webhookEvents,
    incidents,
    purchases,
    latestHealth
  ] = await Promise.all([
    repository.getProfiles(),
    repository.getLedger(),
    repository.getStoryboards(cutoverIso),
    repository.getAnalysisOperations(cutoverIso),
    repository.getWebhookEvents(),
    repository.getOpenIncidents(),
    repository.getPurchases(cutoverIso),
    repository.getLatestHealthCheck()
  ]);

  return evaluateCreditPolicyAudit({
    profiles,
    ledger,
    storyboards,
    analysisOperations,
    webhookEvents,
    incidents,
    purchases,
    latestHealth
  }, { now, cutover: cutoverIso });
}

module.exports = {
  DEFAULT_RELEASE_CUTOVER,
  STORYBOARD_COSTS,
  LEGACY_DEDUCTION_DELTAS,
  HEALTH_MAX_AGE_MS,
  createSupabaseAuditRepository,
  evaluateCreditPolicyAudit,
  collectCreditPolicyAudit,
  fetchAll
};
