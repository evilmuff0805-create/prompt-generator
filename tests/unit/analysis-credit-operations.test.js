'use strict';

const fs = require('fs');
const path = require('path');
const {
  reserveAnalysisOperation,
  completeAnalysisOperation,
  refundAnalysisOperation,
  sweepStaleAnalysisOperations
} = require('../../lib/analysis-credit-operations');

const ROOT = path.join(__dirname, '..', '..');

function clientReturning(data, error = null) {
  return {
    rpc: jest.fn().mockResolvedValue({ data, error })
  };
}

describe('atomic analysis credit operation client', () => {
  const operationId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';

  test('reserves the exact v2 cost before provider work', async () => {
    const client = clientReturning({
      status: 'reserved',
      isNew: true,
      chargedAmount: 2,
      newBalance: 598
    });

    await expect(reserveAnalysisOperation(client, {
      operationId,
      userId,
      creditCost: 2
    })).resolves.toMatchObject({ status: 'reserved', chargedAmount: 2 });

    expect(client.rpc).toHaveBeenCalledWith('reserve_analysis_operation', {
      p_operation_id: operationId,
      p_user_id: userId,
      p_credit_cost: 2,
      p_reservation_seconds: 900
    });
  });

  test('maps database business failures to stable application codes', async () => {
    const client = clientReturning(null, { message: 'P0001: INSUFFICIENT_CREDITS' });
    await expect(reserveAnalysisOperation(client, {
      operationId,
      userId,
      creditCost: 2
    })).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
  });

  test('completion, refund, and stale recovery call service-only RPC contracts', async () => {
    const client = clientReturning({ success: true, status: 'completed' });
    const result = { prompt: 'test', brackets: [], analysis: {} };

    await completeAnalysisOperation(client, { operationId, userId, result });
    await refundAnalysisOperation(client, { operationId, userId, reason: 'provider_failed' });
    await sweepStaleAnalysisOperations(client, 25);

    expect(client.rpc).toHaveBeenNthCalledWith(1, 'complete_analysis_operation', {
      p_operation_id: operationId,
      p_user_id: userId,
      p_result: result
    });
    expect(client.rpc).toHaveBeenNthCalledWith(2, 'refund_analysis_operation', {
      p_operation_id: operationId,
      p_user_id: userId,
      p_reason: 'provider_failed'
    });
    expect(client.rpc).toHaveBeenNthCalledWith(3, 'refund_stale_analysis_operations', {
      p_limit: 25
    });
  });
});

describe('analysis charging rollout contract', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'migrations', '022_atomic_analysis_credit_operations.sql'),
    'utf8'
  );
  const route = fs.readFileSync(path.join(ROOT, 'routes', 'analyze.js'), 'utf8');

  test('migration is additive, idempotent, RLS-protected and service-role only', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.analysis_credit_operations');
    expect(migration).toContain('ALTER TABLE public.prompts');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS analysis_operation_id uuid');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(4);
    expect(migration.match(/SET search_path = public, pg_temp/g)).toHaveLength(4);
    expect(migration).not.toMatch(/UPDATE public\.profiles\s+SET credits\s*=\s*(600|1500)/);
  });

  test('route reserves before Gemini, completes before response, and refunds failures', () => {
    const reserveIndex = route.indexOf('reserveAnalysisOperation(adminClient');
    const providerIndex = route.indexOf('analyzeImage(base64Image, mimeType)');
    const completeIndex = route.indexOf('completeAnalysisOperation(adminClient');
    const responseIndex = route.lastIndexOf('res.json({');

    expect(reserveIndex).toBeGreaterThan(-1);
    expect(providerIndex).toBeGreaterThan(reserveIndex);
    expect(completeIndex).toBeGreaterThan(providerIndex);
    expect(responseIndex).toBeGreaterThan(completeIndex);
    expect(route).toContain('refundAnalysisOperation(adminClient');
    expect(route).not.toContain(".rpc('deduct_credits'");
    expect(route).toContain('analysis_operation_id: operationId');
  });
});
