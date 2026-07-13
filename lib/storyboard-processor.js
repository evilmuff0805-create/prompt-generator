'use strict';

const {
  generateScenarioAndPrompts,
  buildGridPrompt,
  generateGridImage
} = require('./storyboard-engine');
const jobStore = require('./storyboard-job-store');

const RETRYABLE_CODES = new Set([
  'OPENAI_RATE_LIMIT',
  'OPENAI_TIMEOUT',
  'OPENAI_TEXT_FAILED',
  'OPENAI_IMAGE_FAILED',
  'VALIDATION_FAILED',
  'REF_SIGN_ERROR',
  'REF_DOWNLOAD_ERROR',
  'STORAGE_UPLOAD_ERROR',
  'PROGRESS_UPDATE_FAILED',
  'COMPLETE_FAILED',
  'FAIL_TRANSITION_FAILED'
]);

const NON_RETRYABLE_CODES = new Set([
  'OPENAI_INVALID_REQUEST',
  'OPENAI_TEXT_INVALID_REQUEST',
  'INVALID_STORYBOARD_DATA',
  'LEASE_LOST'
]);

function makeLeaseLostError() {
  const error = new Error('Storyboard claim lease was lost');
  error.code = 'LEASE_LOST';
  return error;
}

function isRetryableError(error) {
  if (NON_RETRYABLE_CODES.has(error?.code)) return false;
  if (RETRYABLE_CODES.has(error?.code)) return true;

  const status = Number(error?.status);
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return true;
  }
  if (status >= 400 && status < 500) return false;

  // Unknown infrastructure errors get the bounded durable retry budget.
  return true;
}

function summarizeError(error) {
  const code = error?.code || 'UNKNOWN';
  const message = error?.message || 'Unknown error';
  return `[${code}] ${message}`.slice(0, 3500);
}

async function cleanupGrid(gridPath, storyboardId) {
  if (!gridPath) return;
  try {
    await jobStore.removeGrid(gridPath);
  } catch (cleanupError) {
    console.error(
      '[storyboard-processor] Orphan grid cleanup failed:',
      cleanupError.message,
      '| id:',
      storyboardId,
      '| path:',
      gridPath
    );
  }
}

async function requireProgress(job, step, progress) {
  const accepted = await jobStore.updateProgress(
    job.id,
    job.claim_token,
    step,
    progress
  );
  if (!accepted) throw makeLeaseLostError();
}

/**
 * Process one already-claimed durable job. All state transitions are fenced by
 * claim_token so an expired worker can never overwrite a newer attempt.
 */
async function processStoryboardJob(job, options = {}) {
  const leaseSeconds = options.leaseSeconds || 180;
  const heartbeatMs = Math.max(
    10000,
    Number.parseInt(
      process.env.STORYBOARD_WORKER_HEARTBEAT_MS || String(Math.floor(leaseSeconds * 1000 / 3)),
      10
    )
  );
  const retryBaseSeconds = Math.max(
    1,
    Number.parseInt(process.env.STORYBOARD_RETRY_BASE_SECONDS || '15', 10)
  );

  let heartbeatBusy = false;
  let leaseLost = false;
  let gridPath = null;

  const heartbeat = setInterval(async () => {
    if (heartbeatBusy || leaseLost) return;
    heartbeatBusy = true;
    try {
      const accepted = await jobStore.heartbeatJob(
        job.id,
        job.claim_token,
        leaseSeconds
      );
      if (!accepted) leaseLost = true;
    } catch (error) {
      // A transient heartbeat request failure is not proof that the lease was
      // lost. The next fenced progress/complete call resolves ownership.
      console.error(
        '[storyboard-processor] Heartbeat failed:',
        error.message,
        '| id:',
        job.id
      );
    } finally {
      heartbeatBusy = false;
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  try {
    await requireProgress(job, 'analyzing_scenario', 0.1);

    const data = await generateScenarioAndPrompts({
      scenario: job.scenario,
      genres: job.genres,
      style: job.style,
      cutCount: job.cut_count
    });

    if (leaseLost) throw makeLeaseLostError();
    await requireProgress(job, 'generating_grid', 0.5);

    const gridPrompt = buildGridPrompt(data, job.style, job.cut_count);
    gridPath = await generateGridImage({
      prompt: gridPrompt,
      refImageIds: job.reference_image_ids || [],
      cutCount: job.cut_count,
      userId: job.user_id,
      storyboardId: job.id,
      attemptToken: job.claim_token
    });

    if (leaseLost) throw makeLeaseLostError();
    await requireProgress(job, 'finalizing', 0.95);

    const completed = await jobStore.completeJob(
      job.id,
      job.claim_token,
      data,
      gridPath
    );

    if (!completed) {
      await cleanupGrid(gridPath, job.id);
      console.warn('[storyboard-processor] Stale completion discarded:', job.id);
      return { status: 'claim_lost' };
    }

    console.log(
      `[storyboard-processor] Completed ${job.id} on attempt ${job.attempt_count}/${job.max_attempts}`
    );
    return { status: 'completed' };
  } catch (error) {
    await cleanupGrid(gridPath, job.id);

    const retryable = isRetryableError(error);
    const summary = summarizeError(error);

    try {
      const transition = await jobStore.failJob(
        job.id,
        job.claim_token,
        summary,
        retryable,
        retryBaseSeconds
      );

      if (!transition?.accepted) {
        console.warn(
          '[storyboard-processor] Failure transition ignored after claim loss:',
          job.id
        );
        return { status: 'claim_lost', error: summary };
      }

      console.error(
        `[storyboard-processor] Job ${job.id} ${transition.status}:`,
        summary,
        '| retryable:',
        retryable,
        '| refunded:',
        Boolean(transition.refunded)
      );
      return { status: transition.status, error: summary };
    } catch (transitionError) {
      // Do not perform a separate refund here. The lease-expiry recovery path
      // will claim again or atomically fail+refund after max attempts.
      console.error(
        '[storyboard-processor] Failure transition unavailable; lease recovery will resume:',
        transitionError.message,
        '| id:',
        job.id,
        '| original:',
        summary
      );
      throw transitionError;
    }
  } finally {
    clearInterval(heartbeat);
  }
}

module.exports = {
  processStoryboardJob,
  isRetryableError,
  summarizeError,
  makeLeaseLostError
};
