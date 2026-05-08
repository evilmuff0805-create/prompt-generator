'use strict';

const { createClient } = require('@supabase/supabase-js');

const ALLOWED_PLANS = (process.env.STORYBOARD_ALLOWED_PLANS || 'pro,enterprise,paid')
  .split(',').map(s => s.trim().toLowerCase());

function getAdminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

/**
 * Single query: returns { plan, credits } for the given user.
 */
async function getProfileWithCredits(userId) {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('profiles')
    .select('plan, credits')
    .eq('id', userId)
    .single();

  if (error) {
    const err = new Error(error.message);
    err.code = 'PROFILE_FETCH_ERROR';
    throw err;
  }
  return data;
}

/**
 * Returns true if the user's plan is in the storyboard whitelist.
 */
function canUseStoryboard(profile) {
  return ALLOWED_PLANS.includes((profile?.plan || 'free').toLowerCase());
}

/**
 * Atomically deduct credits via SECURITY DEFINER RPC (service_role bypasses GRANT).
 * Throws with code 'INSUFFICIENT_CREDITS' or 'USER_NOT_FOUND' on failure.
 */
async function deductStoryboardCredits(userId, amount, storyboardId) {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('deduct_storyboard_credits', {
    p_user_id: userId,
    p_amount: amount,
    p_storyboard_id: storyboardId
  });

  if (error) {
    const err = new Error(error.message);
    if (error.message.includes('INSUFFICIENT_CREDITS')) {
      err.code = 'INSUFFICIENT_CREDITS';
    } else if (error.message.includes('USER_NOT_FOUND')) {
      err.code = 'USER_NOT_FOUND';
    } else {
      err.code = 'DEDUCT_ERROR';
    }
    throw err;
  }
  return data;
}

/**
 * Refund credits via SECURITY DEFINER RPC.
 * Also appends the refund reason to storyboards.error_message for audit trail.
 */
async function refundStoryboardCredits(userId, amount, storyboardId, reason) {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('refund_storyboard_credits', {
    p_user_id: userId,
    p_amount: amount,
    p_storyboard_id: storyboardId,
    p_reason: reason
  });

  if (error) {
    const err = new Error(error.message);
    err.code = error.message.includes('USER_NOT_FOUND') ? 'USER_NOT_FOUND' : 'REFUND_ERROR';
    throw err;
  }
  return data;
}

module.exports = {
  getProfileWithCredits,
  canUseStoryboard,
  deductStoryboardCredits,
  refundStoryboardCredits
};
