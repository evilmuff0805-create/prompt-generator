'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const {
  ProductEventValidationError,
  recordProductEvent
} = require('../lib/product-analytics');
const logger = require('../lib/logger');

const router = express.Router();
let authClient;

function getAuthClient() {
  if (!authClient) {
    authClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { auth: { persistSession: false } }
    );
  }
  return authClient;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

async function resolveUserId(req) {
  const token = bearerToken(req);
  if (!token) return null;

  const { data, error } = await getAuthClient().auth.getUser(token);
  if (error || !data?.user?.id) {
    const invalid = new ProductEventValidationError('invalid access token');
    invalid.statusCode = 401;
    throw invalid;
  }
  return data.user.id;
}

router.post('/events', async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    const result = await recordProductEvent({
      eventId: req.body?.eventId,
      eventName: req.body?.eventName,
      source: 'client',
      userId,
      sessionId: req.body?.sessionId,
      pagePath: req.body?.pagePath,
      properties: req.body?.properties
    }, { throwOnError: true });

    return res.status(result.duplicate ? 200 : 202).json({
      accepted: true,
      duplicate: result.duplicate
    });
  } catch (error) {
    if (error instanceof ProductEventValidationError) {
      return res.status(error.statusCode || 400).json({
        accepted: false,
        code: error.code,
        error: error.message
      });
    }

    logger.warn('analytics.ingestion.failed', {
      requestId: req.id,
      error
    });
    return res.status(503).json({
      accepted: false,
      code: 'ANALYTICS_UNAVAILABLE'
    });
  }
});

router._setAuthClientForTests = (client) => {
  authClient = client;
};
router.bearerToken = bearerToken;
router.resolveUserId = resolveUserId;

module.exports = router;
