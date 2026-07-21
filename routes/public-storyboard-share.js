'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const {
  resolveSharedStoryboard,
  toPublicStoryboard
} = require('../lib/storyboard-sharing');

function getAdminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

function setPrivateShareHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function createRouter(dependencies = {}) {
  const router = express.Router();
  const makeAdmin = dependencies.getAdminClient || getAdminClient;

  router.use((req, res, next) => {
    setPrivateShareHeaders(res);
    next();
  });

  router.get('/:token/image', async (req, res) => {
    try {
      const admin = makeAdmin();
      const resolved = await resolveSharedStoryboard(admin, req.params.token);
      if (!resolved) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const { data, error } = await admin.storage
        .from('storyboards')
        .download(resolved.storyboard.grid_storage_path);
      if (error || !data) {
        console.error('[public storyboard share image] private object unavailable');
        return res.status(503).json({ success: false, code: 'UNAVAILABLE' });
      }

      const buffer = Buffer.isBuffer(data)
        ? data
        : Buffer.from(await data.arrayBuffer());
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Content-Disposition', 'inline; filename="storyboard-grid.png"');
      return res.send(buffer);
    } catch (error) {
      console.error('[public storyboard share image] failed:', error.message);
      return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
    }
  });

  router.get('/:token', async (req, res) => {
    try {
      const admin = makeAdmin();
      const resolved = await resolveSharedStoryboard(admin, req.params.token);
      if (!resolved) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      return res.json({
        success: true,
        storyboard: toPublicStoryboard(resolved.storyboard, req.params.token)
      });
    } catch (error) {
      console.error('[public storyboard share metadata] failed:', error.message);
      return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}

const router = createRouter();
router._createRouter = createRouter;
router._setPrivateShareHeaders = setPrivateShareHeaders;

module.exports = router;
