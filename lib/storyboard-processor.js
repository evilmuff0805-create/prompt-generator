'use strict';

const { createClient } = require('@supabase/supabase-js');
const { generateScenarioAndPrompts, buildGridPrompt, generateGridImage } = require('./storyboard-engine');
const creditManager = require('./credit-manager');

function getAdminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

async function fetchStoryboard(storyboardId) {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('storyboards')
    .select('*')
    .eq('id', storyboardId)
    .single();

  if (error) return null;
  return data;
}

async function updateStatus(storyboardId, status, currentStep, progress) {
  const admin = getAdminClient();
  const { error } = await admin
    .from('storyboards')
    .update({ status, current_step: currentStep, progress })
    .eq('id', storyboardId);
  if (error) {
    // Progress display only — log, don't fail the pipeline over a stale bar.
    console.error('[storyboard-processor] updateStatus failed:', error.message, '| id:', storyboardId);
  }
}

async function saveResult(storyboardId, data, gridPath) {
  const admin = getAdminClient();
  const { error } = await admin
    .from('storyboards')
    .update({
      shots: data.shots,
      characters: data.characters,
      grid_storage_path: gridPath,
      status: 'completed',
      progress: 1.0,
      current_step: null
    })
    .eq('id', storyboardId);
  if (error) {
    // CRITICAL: generated work exists but was not persisted — the job will sit
    // in 'processing' until the stuck-job watchdog fails+refunds it. Flag loudly
    // for tracing; behavior (watchdog path) intentionally unchanged here.
    console.error('[storyboard-processor] [CRITICAL] saveResult failed — completed grid not persisted:', error.message, '| id:', storyboardId, '| gridPath:', gridPath);
  }
}

/**
 * Atomically mark the storyboard as failed only if it is currently 'processing'.
 * Returns true if the update actually changed a row (prevents double-refund).
 */
async function markFailed(storyboardId, errorMessage) {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('storyboards')
    .update({ status: 'failed', current_step: null, progress: 0, error_message: errorMessage })
    .eq('id', storyboardId)
    .eq('status', 'processing')
    .select('id');

  if (error) {
    console.error('[storyboard-processor] markFailed error:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Main async worker. Called via semaphore.run() — does not need to handle concurrency itself.
 */
async function processStoryboardAsync(storyboardId) {
  const sb = await fetchStoryboard(storyboardId);
  if (!sb) {
    console.error(`[storyboard-processor] Storyboard ${storyboardId} not found`);
    return;
  }

  try {
    await updateStatus(storyboardId, 'processing', 'analyzing_scenario', 0.1);

    const data = await generateScenarioAndPrompts({
      scenario: sb.scenario,
      genres: sb.genres,
      style: sb.style,
      cutCount: sb.cut_count
    });

    await updateStatus(storyboardId, 'processing', 'generating_grid', 0.5);

    const gridPrompt = buildGridPrompt(data, sb.style, sb.cut_count);

    const gridPath = await generateGridImage({
      prompt: gridPrompt,
      refImageIds: sb.reference_image_ids || [],
      cutCount: sb.cut_count,
      userId: sb.user_id,
      storyboardId
    });

    await updateStatus(storyboardId, 'processing', 'finalizing', 0.95);
    await saveResult(storyboardId, data, gridPath);
  } catch (error) {
    console.error(`[storyboard-processor] Job ${storyboardId} failed:`, error.message);

    // Atomic compare-and-swap: only refund if we actually changed status
    const changed = await markFailed(storyboardId, error.message || 'Unknown error');
    if (changed) {
      try {
        await creditManager.refundStoryboardCredits(
          sb.user_id,
          sb.credits_used,
          storyboardId,
          `async_failure: ${error.code || error.message}`
        );
      } catch (refundErr) {
        console.error(`[storyboard-processor] Refund failed for ${storyboardId}:`, refundErr.message);
      }
    }
  }
}

module.exports = {
  processStoryboardAsync,
  fetchStoryboard,
  updateStatus,
  markFailed
};
