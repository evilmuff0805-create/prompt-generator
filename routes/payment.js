'use strict';
require('dotenv').config();
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

function makeUserClient(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false }
  });
}

async function verifyToken(token) {
  const base = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false }
  });
  const { data: { user }, error } = await base.auth.getUser(token);
  return { user, error };
}

/* ── GET /api/payment/status ── */
router.get('/status', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  const { user, error: userError } = await verifyToken(token);
  if (userError || !user) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }

  const supabase = makeUserClient(token);
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('plan')
    .eq('id', user.id)
    .single();

  if (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch subscription status' });
  }

  res.json({ success: true, plan: profile.plan });
});

/* ── POST /api/payment/cancel ── */
// Stub: one-time credit purchases cannot be cancelled.
// Implement when subscriptions are introduced (requires paddle_subscription_id column in profiles).
router.post('/cancel', async (req, res) => {
  return res.status(400).json({
    success: false,
    error: 'Credit purchases are non-refundable. See our Refund Policy for eligibility.'
  });
});

module.exports = router;
