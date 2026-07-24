'use strict';

const TERMINAL_STATUSES = ['completed', 'failed'];

function makeError(error, code) {
  const wrapped = new Error(error?.message || code);
  wrapped.code = code;
  return wrapped;
}

function createSupabaseCleanupRepository(client) {
  return {
    async findExpiredStoryboards(nowIso, limit) {
      const { data, error } = await client
        .from('storyboards')
        .select('id, grid_storage_path')
        .lt('expires_at', nowIso)
        .is('deleted_at', null)
        .in('status', TERMINAL_STATUSES)
        .order('expires_at', { ascending: true })
        .limit(limit);
      if (error) throw makeError(error, 'CLEANUP_STORYBOARD_QUERY_FAILED');
      return data || [];
    },

    async removeStorage(bucket, path) {
      if (!path) return;
      const { error } = await client.storage.from(bucket).remove([path]);
      if (error) throw makeError(error, 'CLEANUP_STORAGE_REMOVE_FAILED');
    },

    async softDeleteStoryboard(id, deletedAt) {
      const { data, error } = await client
        .from('storyboards')
        .update({ deleted_at: deletedAt, status: 'deleted' })
        .eq('id', id)
        .is('deleted_at', null)
        .in('status', TERMINAL_STATUSES)
        .select('id');
      if (error) throw makeError(error, 'CLEANUP_STORYBOARD_SOFT_DELETE_FAILED');
      return Array.isArray(data) && data.length > 0;
    },

    async findHardDeleteStoryboards(cutoffIso, limit) {
      const { data, error } = await client
        .from('storyboards')
        .select('id')
        .not('deleted_at', 'is', null)
        .lt('deleted_at', cutoffIso)
        .order('deleted_at', { ascending: true })
        .limit(limit);
      if (error) throw makeError(error, 'CLEANUP_HARD_DELETE_QUERY_FAILED');
      return data || [];
    },

    async hardDeleteStoryboards(ids) {
      if (!ids.length) return 0;
      const { data, error } = await client
        .from('storyboards')
        .delete()
        .in('id', ids)
        .select('id');
      if (error) throw makeError(error, 'CLEANUP_HARD_DELETE_FAILED');
      return Array.isArray(data) ? data.length : 0;
    },

    async findExpiredReferenceImages(nowIso, limit) {
      const { data, error } = await client
        .from('reference_images')
        .select('id, storage_path')
        .lt('expires_at', nowIso)
        .order('expires_at', { ascending: true })
        .limit(limit);
      if (error) throw makeError(error, 'CLEANUP_REFERENCE_QUERY_FAILED');
      return data || [];
    },

    async deleteReferenceImage(id) {
      const { data, error } = await client
        .from('reference_images')
        .delete()
        .eq('id', id)
        .select('id');
      if (error) throw makeError(error, 'CLEANUP_REFERENCE_DELETE_FAILED');
      return Array.isArray(data) && data.length > 0;
    },

    async purgeWebhookEvents(cutoffIso) {
      const { data, error } = await client
        .from('webhook_events')
        .delete()
        .lt('processed_at', cutoffIso)
        .select('event_id');
      if (error) throw makeError(error, 'CLEANUP_WEBHOOK_EVENTS_FAILED');
      return Array.isArray(data) ? data.length : 0;
    },

    async refundStaleAnalysisOperations(limit) {
      const { data, error } = await client.rpc('refund_stale_analysis_operations', {
        p_limit: limit
      });
      if (error) throw makeError(error, 'CLEANUP_ANALYSIS_RESERVATIONS_FAILED');
      return Number(data?.refunded) || 0;
    }
  };
}

function failure(kind, id, error) {
  return {
    kind,
    id,
    code: error?.code || 'CLEANUP_UNKNOWN',
    message: String(error?.message || 'Unknown cleanup error').slice(0, 1000)
  };
}

async function runCleanup(options = {}) {
  const {
    client,
    repository = client ? createSupabaseCleanupRepository(client) : null,
    dryRun = false,
    retentionDays = 30,
    webhookRetentionDays = 90,
    batchSize = 100,
    now = new Date()
  } = options;

  if (!repository) throw new Error('cleanup repository or Supabase client is required');

  const nowIso = now.toISOString();
  const hardDeleteCutoff = new Date(
    now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const webhookCutoff = new Date(
    now.getTime() - webhookRetentionDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const summary = {
    dryRun,
    startedAt: nowIso,
    candidates: { storyboards: 0, hardDelete: 0, referenceImages: 0 },
    removed: {
      storyboards: 0,
      hardDelete: 0,
      referenceImages: 0,
      webhookEvents: 0,
      analysisReservationsRefunded: 0
    },
    failures: []
  };

  let storyboards = [];
  try {
    storyboards = await repository.findExpiredStoryboards(nowIso, batchSize);
    summary.candidates.storyboards = storyboards.length;
  } catch (error) {
    summary.failures.push(failure('storyboard_query', null, error));
  }

  if (!dryRun) {
    for (const storyboard of storyboards) {
      try {
        await repository.removeStorage('storyboards', storyboard.grid_storage_path);
        const changed = await repository.softDeleteStoryboard(storyboard.id, nowIso);
        if (changed) summary.removed.storyboards += 1;
      } catch (error) {
        summary.failures.push(failure('storyboard', storyboard.id, error));
      }
    }
  }

  let hardDeleteRows = [];
  try {
    hardDeleteRows = await repository.findHardDeleteStoryboards(hardDeleteCutoff, batchSize);
    summary.candidates.hardDelete = hardDeleteRows.length;
  } catch (error) {
    summary.failures.push(failure('hard_delete_query', null, error));
  }

  if (!dryRun && hardDeleteRows.length) {
    try {
      summary.removed.hardDelete = await repository.hardDeleteStoryboards(
        hardDeleteRows.map((row) => row.id)
      );
    } catch (error) {
      summary.failures.push(failure('hard_delete', null, error));
    }
  }

  let references = [];
  try {
    references = await repository.findExpiredReferenceImages(nowIso, batchSize);
    summary.candidates.referenceImages = references.length;
  } catch (error) {
    summary.failures.push(failure('reference_query', null, error));
  }

  if (!dryRun) {
    for (const reference of references) {
      try {
        await repository.removeStorage('reference-images', reference.storage_path);
        const changed = await repository.deleteReferenceImage(reference.id);
        if (changed) summary.removed.referenceImages += 1;
      } catch (error) {
        summary.failures.push(failure('reference_image', reference.id, error));
      }
    }

    try {
      summary.removed.webhookEvents = await repository.purgeWebhookEvents(webhookCutoff);
    } catch (error) {
      summary.failures.push(failure('webhook_events', null, error));
    }

    try {
      if (typeof repository.refundStaleAnalysisOperations === 'function') {
        summary.removed.analysisReservationsRefunded =
          await repository.refundStaleAnalysisOperations(batchSize);
      }
    } catch (error) {
      summary.failures.push(failure('analysis_reservations', null, error));
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

module.exports = {
  runCleanup,
  createSupabaseCleanupRepository,
  makeError,
  TERMINAL_STATUSES
};
