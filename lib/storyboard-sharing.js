'use strict';

const { createHash, randomBytes } = require('crypto');

const SHARE_TOKEN_BYTES = 32;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHARE_CONSENT_VERSION = 'unlisted-grid-v1';

function createShareToken() {
  return randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
}

function isValidShareToken(token) {
  return typeof token === 'string' && SHARE_TOKEN_PATTERN.test(token);
}

function hashShareToken(token) {
  if (!isValidShareToken(token)) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function redactShareTokenPath(requestPath) {
  if (typeof requestPath !== 'string') return requestPath;
  return requestPath.replace(
    /^(\/(?:api\/)?share)\/[^/]+(\/image)?\/?$/,
    '$1/:token$2'
  );
}

function isFutureTimestamp(value, now) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function canAccessSharedStoryboard(share, storyboard, now = new Date()) {
  if (!share || !storyboard) return false;
  if (share.revoked_at) return false;
  if (share.owner_id !== storyboard.user_id) return false;
  if (share.storyboard_id !== storyboard.id) return false;
  if (!isFutureTimestamp(share.expires_at, now)) return false;
  if (!isFutureTimestamp(storyboard.expires_at, now)) return false;
  if (storyboard.deleted_at) return false;
  if (storyboard.status !== 'completed') return false;
  if (typeof storyboard.grid_storage_path !== 'string' || !storyboard.grid_storage_path) return false;
  return true;
}

function toPublicStoryboard(storyboard, token) {
  return {
    style: storyboard.style,
    cutCount: storyboard.cut_count,
    createdAt: storyboard.created_at,
    expiresAt: storyboard.expires_at,
    imagePath: `/api/share/${token}/image`
  };
}

async function resolveSharedStoryboard(admin, token, now = new Date()) {
  const tokenHash = hashShareToken(token);
  if (!tokenHash) return null;

  const { data: share, error: shareError } = await admin
    .from('storyboard_shares')
    .select('storyboard_id, owner_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (shareError) throw shareError;
  if (!share) return null;

  const { data: storyboard, error: storyboardError } = await admin
    .from('storyboards')
    .select('id, user_id, status, style, cut_count, grid_storage_path, created_at, expires_at, deleted_at')
    .eq('id', share.storyboard_id)
    .maybeSingle();

  if (storyboardError) throw storyboardError;
  if (!canAccessSharedStoryboard(share, storyboard, now)) return null;

  return { share, storyboard };
}

module.exports = {
  SHARE_CONSENT_VERSION,
  SHARE_TOKEN_BYTES,
  canAccessSharedStoryboard,
  createShareToken,
  hashShareToken,
  isValidShareToken,
  redactShareTokenPath,
  resolveSharedStoryboard,
  toPublicStoryboard
};
