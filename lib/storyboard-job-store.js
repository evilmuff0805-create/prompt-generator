'use strict';

const { createClient } = require('@supabase/supabase-js');

let adminClient;

function getAdminClient() {
  if (!adminClient) {
    adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
  }
  return adminClient;
}

function makeRpcError(error, fallbackCode) {
  const message = error?.message || 'Storyboard queue RPC failed';
  const err = new Error(message);
  const knownCodes = [
    'INSUFFICIENT_CREDITS',
    'USER_NOT_FOUND',
    'PLAN_NOT_ALLOWED',
    'TOO_MANY_CONCURRENT_JOBS',
    'INVALID_CREDIT_AMOUNT',
    'INVALID_MAX_ATTEMPTS'
  ];
  err.code = knownCodes.find(code => message.includes(code))
    || (error?.code === '23505' ? 'DUPLICATE_STORYBOARD' : fallbackCode);
  return err;
}

async function fetchJobState(storyboardId) {
  const { data, error } = await getAdminClient()
    .from('storyboards')
    .select('id, status, claim_token, grid_storage_path, credit_refunded_at, next_attempt_at')
    .eq('id', storyboardId)
    .maybeSingle();

  if (error) throw makeRpcError(error, 'JOB_STATE_FETCH_FAILED');
  return data;
}

async function reconcileEnqueue(storyboardId, userId) {
  const client = getAdminClient();
  const [jobResult, profileResult] = await Promise.all([
    client
      .from('storyboards')
      .select('id, user_id, status, credit_charged_at')
      .eq('id', storyboardId)
      .maybeSingle(),
    client
      .from('profiles')
      .select('credits')
      .eq('id', userId)
      .maybeSingle()
  ]);

  if (jobResult.error || profileResult.error) return null;
  if (
    jobResult.data?.user_id !== userId
    || !jobResult.data?.credit_charged_at
    || typeof profileResult.data?.credits !== 'number'
  ) {
    return null;
  }

  return {
    success: true,
    storyboardId,
    status: jobResult.data.status,
    newBalance: profileResult.data.credits,
    reconciled: true
  };
}

async function enqueueJob(job) {
  const { data, error } = await getAdminClient().rpc('enqueue_storyboard_job', {
    p_storyboard_id: job.id,
    p_user_id: job.userId,
    p_scenario: job.scenario,
    p_genres: job.genres,
    p_style: job.style,
    p_cut_count: job.cutCount,
    p_reference_image_ids: job.referenceImageIds || [],
    p_credit_cost: job.creditCost,
    p_max_concurrent: job.maxConcurrent,
    p_max_attempts: job.maxAttempts
  });

  if (!error) return data;

  const businessError = makeRpcError(error, 'ENQUEUE_FAILED');
  if (businessError.code !== 'ENQUEUE_FAILED') throw businessError;

  // Reconcile an ambiguous transport failure by the server-generated job ID.
  // If the transaction committed, return its durable receipt instead of telling
  // the caller to retry and potentially creating a second paid job.
  try {
    const receipt = await reconcileEnqueue(job.id, job.userId);
    if (receipt) return receipt;
  } catch (reconcileError) {
    // Preserve the original enqueue failure. The route gives an ambiguity-safe
    // message directing the user to history before any retry.
  }

  throw businessError;
}

async function claimJobs(workerId, limit, leaseSeconds) {
  const { data, error } = await getAdminClient().rpc('claim_storyboard_jobs', {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds
  });

  if (error) throw makeRpcError(error, 'CLAIM_FAILED');
  return Array.isArray(data) ? data : [];
}

async function heartbeatJob(storyboardId, claimToken, leaseSeconds) {
  const { data, error } = await getAdminClient().rpc('heartbeat_storyboard_job', {
    p_storyboard_id: storyboardId,
    p_claim_token: claimToken,
    p_lease_seconds: leaseSeconds
  });

  if (error) throw makeRpcError(error, 'HEARTBEAT_FAILED');
  return data === true;
}

async function updateProgress(storyboardId, claimToken, currentStep, progress) {
  const { data, error } = await getAdminClient().rpc('update_storyboard_job_progress', {
    p_storyboard_id: storyboardId,
    p_claim_token: claimToken,
    p_current_step: currentStep,
    p_progress: progress
  });

  if (error) throw makeRpcError(error, 'PROGRESS_UPDATE_FAILED');
  return data === true;
}

async function completeJob(storyboardId, claimToken, result, gridStoragePath) {
  const { data, error } = await getAdminClient().rpc('complete_storyboard_job', {
    p_storyboard_id: storyboardId,
    p_claim_token: claimToken,
    p_shots: result.shots,
    p_characters: result.characters || null,
    p_grid_storage_path: gridStoragePath
  });

  if (!error && data === true) return true;

  // A committed RPC response can be lost in transit. Reconcile before treating
  // the output as stale so an adopted grid is never deleted accidentally.
  try {
    const state = await fetchJobState(storyboardId);
    if (state?.status === 'completed' && state.grid_storage_path === gridStoragePath) {
      return true;
    }
    if (!error) return false;
  } catch (reconcileError) {
    if (!error) throw reconcileError;
  }

  throw makeRpcError(error, 'COMPLETE_FAILED');
}

async function failJob(storyboardId, claimToken, errorMessage, retryable, retryBaseSeconds) {
  const { data, error } = await getAdminClient().rpc('fail_storyboard_job', {
    p_storyboard_id: storyboardId,
    p_claim_token: claimToken,
    p_error_message: errorMessage,
    p_retryable: retryable,
    p_retry_base_seconds: retryBaseSeconds
  });

  if (!error) return data;

  // As with completion, reconcile an ambiguous network failure. A cleared token
  // plus pending/failed state proves the transactional failure RPC committed.
  try {
    const state = await fetchJobState(storyboardId);
    if (state?.status === 'pending' && !state.claim_token) {
      return {
        accepted: true,
        status: 'pending',
        retryAt: state.next_attempt_at,
        refunded: false,
        reconciled: true
      };
    }
    if (state?.status === 'failed' && !state.claim_token) {
      return {
        accepted: true,
        status: 'failed',
        refunded: Boolean(state.credit_refunded_at),
        reconciled: true
      };
    }
    if (state && state.claim_token !== claimToken) {
      return { accepted: false, reason: 'claim_lost', reconciled: true };
    }
  } catch (reconcileError) {
    // Keep the original RPC error: lease expiry will make the job recoverable.
  }

  throw makeRpcError(error, 'FAIL_TRANSITION_FAILED');
}

async function removeGrid(gridStoragePath) {
  if (!gridStoragePath) return;
  const { error } = await getAdminClient()
    .storage
    .from('storyboards')
    .remove([gridStoragePath]);

  if (error) throw makeRpcError(error, 'GRID_CLEANUP_FAILED');
}

function _setAdminClientForTests(client) {
  adminClient = client;
}

module.exports = {
  enqueueJob,
  claimJobs,
  heartbeatJob,
  updateProgress,
  completeJob,
  failJob,
  fetchJobState,
  reconcileEnqueue,
  removeGrid,
  _setAdminClientForTests
};
