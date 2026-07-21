'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const requireAuth = require('../middleware/auth');
const {
  SHARE_CONSENT_VERSION,
  createShareToken,
  hashShareToken
} = require('../lib/storyboard-sharing');

function getAdminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

async function getOwnedStoryboard(admin, storyboardId, ownerId) {
  const { data, error } = await admin
    .from('storyboards')
    .select('id, user_id, status, grid_storage_path, expires_at, deleted_at')
    .eq('id', storyboardId)
    .eq('user_id', ownerId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function createRouter(dependencies = {}) {
  const router = express.Router();
  const auth = dependencies.requireAuth || requireAuth;
  const makeAdmin = dependencies.getAdminClient || getAdminClient;

  router.get('/:id/share', auth, async (req, res) => {
    try {
      const admin = makeAdmin();
      const storyboard = await getOwnedStoryboard(admin, req.params.id, req.user.id);
      if (!storyboard) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const { data: share, error } = await admin
        .from('storyboard_shares')
        .select('expires_at, revoked_at, created_at')
        .eq('storyboard_id', storyboard.id)
        .eq('owner_id', req.user.id)
        .maybeSingle();

      if (error) throw error;
      const now = Date.now();
      const active = Boolean(
        share &&
        !share.revoked_at &&
        new Date(share.expires_at).getTime() > now &&
        storyboard.status === 'completed' &&
        storyboard.grid_storage_path &&
        new Date(storyboard.expires_at).getTime() > now
      );

      return res.json({
        success: true,
        share: {
          active,
          expiresAt: active ? share.expires_at : null,
          createdAt: active ? share.created_at : null
        }
      });
    } catch (error) {
      console.error('[storyboard share status] failed:', error.message);
      return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
    }
  });

  router.post('/:id/share', auth, async (req, res) => {
    if (req.body?.confirmed !== true || req.body?.consentVersion !== SHARE_CONSENT_VERSION) {
      return res.status(400).json({ success: false, code: 'SHARE_CONSENT_REQUIRED' });
    }

    try {
      const admin = makeAdmin();
      const storyboard = await getOwnedStoryboard(admin, req.params.id, req.user.id);
      if (!storyboard) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const expiresAt = new Date(storyboard.expires_at).getTime();
      if (storyboard.status !== 'completed' || !storyboard.grid_storage_path) {
        return res.status(409).json({ success: false, code: 'STORYBOARD_NOT_SHAREABLE' });
      }
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return res.status(409).json({ success: false, code: 'STORYBOARD_EXPIRED' });
      }

      const token = createShareToken();
      const timestamp = new Date().toISOString();
      const { data: share, error } = await admin
        .from('storyboard_shares')
        .upsert({
          storyboard_id: storyboard.id,
          owner_id: req.user.id,
          token_hash: hashShareToken(token),
          scope: 'grid_only',
          consent_version: SHARE_CONSENT_VERSION,
          consented_at: timestamp,
          expires_at: storyboard.expires_at,
          revoked_at: null,
          created_at: timestamp,
          updated_at: timestamp
        }, { onConflict: 'storyboard_id' })
        .select('expires_at, created_at')
        .single();

      if (error) throw error;
      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json({
        success: true,
        share: {
          path: `/share/${token}`,
          expiresAt: share.expires_at,
          createdAt: share.created_at
        }
      });
    } catch (error) {
      console.error('[storyboard share create] failed:', error.message);
      return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
    }
  });

  router.delete('/:id/share', auth, async (req, res) => {
    try {
      const admin = makeAdmin();
      const storyboard = await getOwnedStoryboard(admin, req.params.id, req.user.id);
      if (!storyboard) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const { error } = await admin
        .from('storyboard_shares')
        .update({ revoked_at: new Date().toISOString() })
        .eq('storyboard_id', storyboard.id)
        .eq('owner_id', req.user.id);

      if (error) throw error;
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ success: true });
    } catch (error) {
      console.error('[storyboard share revoke] failed:', error.message);
      return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}

const router = createRouter();
router._createRouter = createRouter;
router._getOwnedStoryboard = getOwnedStoryboard;

module.exports = router;
