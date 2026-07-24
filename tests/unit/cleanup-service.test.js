'use strict';

const { runCleanup } = require('../../lib/cleanup-service');

function makeRepository(overrides = {}) {
  return {
    findExpiredStoryboards: jest.fn().mockResolvedValue([
      { id: 'sb_1', grid_storage_path: 'u/sb_1/grid.png' }
    ]),
    removeStorage: jest.fn().mockResolvedValue(),
    softDeleteStoryboard: jest.fn().mockResolvedValue(true),
    findHardDeleteStoryboards: jest.fn().mockResolvedValue([{ id: 'sb_old' }]),
    hardDeleteStoryboards: jest.fn().mockResolvedValue(1),
    findExpiredReferenceImages: jest.fn().mockResolvedValue([
      { id: 'ref_1', storage_path: 'u/ref_1.png' }
    ]),
    deleteReferenceImage: jest.fn().mockResolvedValue(true),
    purgeWebhookEvents: jest.fn().mockResolvedValue(2),
    refundStaleAnalysisOperations: jest.fn().mockResolvedValue(3),
    ...overrides
  };
}

describe('storage-aware cleanup service', () => {
  const now = new Date('2026-07-13T00:00:00.000Z');

  test('dry-run counts candidates without mutating storage or database', async () => {
    const repository = makeRepository();
    const summary = await runCleanup({ repository, dryRun: true, now });

    expect(summary.candidates).toEqual({
      storyboards: 1,
      hardDelete: 1,
      referenceImages: 1
    });
    expect(repository.removeStorage).not.toHaveBeenCalled();
    expect(repository.softDeleteStoryboard).not.toHaveBeenCalled();
    expect(repository.hardDeleteStoryboards).not.toHaveBeenCalled();
    expect(repository.deleteReferenceImage).not.toHaveBeenCalled();
    expect(repository.purgeWebhookEvents).not.toHaveBeenCalled();
    expect(repository.refundStaleAnalysisOperations).not.toHaveBeenCalled();
  });

  test('removes Storage before deleting metadata and reports exact counts', async () => {
    const repository = makeRepository();
    const summary = await runCleanup({ repository, now });

    expect(repository.removeStorage).toHaveBeenNthCalledWith(
      1,
      'storyboards',
      'u/sb_1/grid.png'
    );
    expect(repository.softDeleteStoryboard).toHaveBeenCalledWith(
      'sb_1',
      now.toISOString()
    );
    expect(repository.removeStorage).toHaveBeenNthCalledWith(
      2,
      'reference-images',
      'u/ref_1.png'
    );
    expect(summary.removed).toEqual({
      storyboards: 1,
      hardDelete: 1,
      referenceImages: 1,
      webhookEvents: 2,
      analysisReservationsRefunded: 3
    });
    expect(summary.failures).toEqual([]);
  });

  test('does not delete metadata after a Storage failure', async () => {
    const storageError = new Error('storage unavailable');
    storageError.code = 'STORAGE_DOWN';
    const repository = makeRepository({
      removeStorage: jest.fn()
        .mockRejectedValueOnce(storageError)
        .mockResolvedValueOnce()
    });

    const summary = await runCleanup({ repository, now });

    expect(repository.softDeleteStoryboard).not.toHaveBeenCalled();
    expect(repository.deleteReferenceImage).toHaveBeenCalledWith('ref_1');
    expect(summary.failures).toEqual([
      expect.objectContaining({
        kind: 'storyboard',
        id: 'sb_1',
        code: 'STORAGE_DOWN'
      })
    ]);
  });

  test('keeps independent cleanup categories running after one query failure', async () => {
    const queryError = new Error('storyboard query failed');
    queryError.code = 'QUERY_DOWN';
    const repository = makeRepository({
      findExpiredStoryboards: jest.fn().mockRejectedValue(queryError)
    });

    const summary = await runCleanup({ repository, now });

    expect(summary.failures).toContainEqual(expect.objectContaining({
      kind: 'storyboard_query',
      code: 'QUERY_DOWN'
    }));
    expect(repository.deleteReferenceImage).toHaveBeenCalledWith('ref_1');
    expect(repository.purgeWebhookEvents).toHaveBeenCalled();
  });
});
