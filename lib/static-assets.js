'use strict';

const path = require('path');

const REVALIDATED_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.map']);

function getAssetVersion(env = process.env) {
  const raw = env.RAILWAY_GIT_COMMIT_SHA || env.PUBLIC_ASSET_VERSION || 'dev';
  const sanitized = String(raw).replace(/[^a-zA-Z0-9._-]/g, '');
  return sanitized.slice(0, 12) || 'dev';
}

function renderVersionedHtml(template, version) {
  return String(template).replaceAll('__ASSET_VERSION__', encodeURIComponent(version));
}

function setStaticCacheHeaders(res, filePath) {
  if (REVALIDATED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}

module.exports = {
  getAssetVersion,
  renderVersionedHtml,
  setStaticCacheHeaders,
  REVALIDATED_EXTENSIONS
};
