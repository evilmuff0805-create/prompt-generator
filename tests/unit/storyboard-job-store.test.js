'use strict';

const jobStore = require('../../lib/storyboard-job-store');

function createClient() {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
    remove: jest.fn()
  };
  const bucket = { remove: query.remove };
  const client = {
    rpc: jest.fn(),
    from: jest.fn(() => query),
    storage: {
      from: jest.fn(() => bucket)
    }
  };
  return { client, query, bucket };
}

describe('storyboard job store', () => {
  test('sends all enqueue invariants to the atomic RPC', async () => {
    const { client } = createClient();
    client.rpc.mockResolvedValue({
      data: { success: true, newBalance: 880 },
      error: null
    });
    jobStore._setAdminClientForTests(client);

    const data = await jobStore.enqueueJob({
      id: 'sb_1',
      userId: 'user-1',
      scenario: 'scenario',
      genres: ['Drama'],
      style: 'Cinematic',
      cutCount: 4,
      referenceImageIds: [],
      creditCost: 120,
      maxConcurrent: 5,
      maxAttempts: 3
    });

    expect(data.newBalance).toBe(880);
    expect(client.rpc).toHaveBeenCalledWith('enqueue_storyboard_job', {
      p_storyboard_id: 'sb_1',
      p_user_id: 'user-1',
      p_scenario: 'scenario',
      p_genres: ['Drama'],
      p_style: 'Cinematic',
      p_cut_count: 4,
      p_reference_image_ids: [],
      p_credit_cost: 120,
      p_max_concurrent: 5,
      p_max_attempts: 3
    });
  });

  test('maps transactional credit rejection without a partial local fallback', async () => {
    const { client } = createClient();
    client.rpc.mockResolvedValue({
      data: null,
      error: { message: 'INSUFFICIENT_CREDITS' }
    });
    jobStore._setAdminClientForTests(client);

    await expect(jobStore.enqueueJob({
      id: 'sb_1',
      userId: 'user-1',
      scenario: 'scenario',
      genres: ['Drama'],
      style: 'Cinematic',
      cutCount: 4,
      creditCost: 120,
      maxConcurrent: 5,
      maxAttempts: 3
    })).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
  });

  test('reconciles a lost completion response before grid cleanup', async () => {
    const { client, query } = createClient();
    client.rpc.mockResolvedValue({
      data: null,
      error: { message: 'network response lost' }
    });
    query.maybeSingle.mockResolvedValue({
      data: {
        id: 'sb_1',
        status: 'completed',
        claim_token: null,
        grid_storage_path: 'user/sb_1/grid-token.png'
      },
      error: null
    });
    jobStore._setAdminClientForTests(client);

    await expect(jobStore.completeJob(
      'sb_1',
      'claim-token',
      { shots: [], characters: {} },
      'user/sb_1/grid-token.png'
    )).resolves.toBe(true);
  });

  test('reconciles a committed retry transition after a lost RPC response', async () => {
    const { client, query } = createClient();
    client.rpc.mockResolvedValue({
      data: null,
      error: { message: 'network response lost' }
    });
    query.maybeSingle.mockResolvedValue({
      data: {
        id: 'sb_1',
        status: 'pending',
        claim_token: null,
        next_attempt_at: '2026-07-13T00:00:00Z'
      },
      error: null
    });
    jobStore._setAdminClientForTests(client);

    const result = await jobStore.failJob(
      'sb_1',
      'claim-token',
      'temporary failure',
      true,
      15
    );

    expect(result).toMatchObject({
      accepted: true,
      status: 'pending',
      refunded: false,
      reconciled: true
    });
  });

  test('removes only the explicitly supplied attempt path', async () => {
    const { client, bucket } = createClient();
    bucket.remove.mockResolvedValue({ error: null });
    jobStore._setAdminClientForTests(client);

    await jobStore.removeGrid('user/sb_1/grid-token.png');

    expect(client.storage.from).toHaveBeenCalledWith('storyboards');
    expect(bucket.remove).toHaveBeenCalledWith(['user/sb_1/grid-token.png']);
  });
});
