'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const {
  SHARE_CONSENT_VERSION,
  canAccessSharedStoryboard,
  createShareToken,
  hashShareToken,
  isValidShareToken,
  redactShareTokenPath,
  toPublicStoryboard
} = require('../../lib/storyboard-sharing');
const ownerShareRouter = require('../../routes/storyboard-sharing');
const publicShareRouter = require('../../routes/public-storyboard-share');

const ROOT = path.join(__dirname, '..', '..');
const FUTURE = '2026-10-01T00:00:00.000Z';
const NOW = new Date('2026-07-21T00:00:00.000Z');

function validRows() {
  const storyboard = {
    id: 'sb_123',
    user_id: 'user-1',
    status: 'completed',
    style: 'Cinematic',
    cut_count: 9,
    grid_storage_path: 'user-1/sb_123/grid.png',
    created_at: '2026-07-20T00:00:00.000Z',
    expires_at: FUTURE,
    deleted_at: null,
    scenario: 'private scenario',
    shots: [{ videoPrompt: 'private prompt' }],
    characters: [{ name: 'private character' }]
  };
  const share = {
    storyboard_id: storyboard.id,
    owner_id: storyboard.user_id,
    expires_at: FUTURE,
    revoked_at: null
  };
  return { share, storyboard };
}

async function withServer(router, callback) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function request(baseUrl, pathname, options = {}) {
  const url = new URL(pathname, baseUrl);
  const body = options.body ? JSON.stringify(options.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: options.method || 'GET',
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      } : {}
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          json: () => JSON.parse(text)
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function queryResult(data, capture) {
  return {
    select() { return this; },
    eq(column, value) { capture?.eq?.push([column, value]); return this; },
    is(column, value) { capture?.is?.push([column, value]); return this; },
    update(value) { if (capture) capture.update = value; return this; },
    upsert(value, options) {
      if (capture) {
        capture.upsert = value;
        capture.upsertOptions = options;
      }
      return this;
    },
    async maybeSingle() { return { data, error: null }; },
    async single() { return { data, error: null }; }
  };
}

describe('unlisted Storyboard sharing security contract', () => {
  test('uses 256-bit, URL-safe tokens and stores only deterministic hashes', () => {
    const tokens = new Set(Array.from({ length: 50 }, createShareToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(isValidShareToken(token)).toBe(true);
      expect(token).toHaveLength(43);
      expect(hashShareToken(token)).toMatch(/^[0-9a-f]{64}$/);
      expect(hashShareToken(token)).not.toContain(token);
    }
    expect(hashShareToken('too-short')).toBeNull();
    expect(SHARE_CONSENT_VERSION).toBe('unlisted-grid-v1');
  });

  test('redacts raw tokens from normal and error access-log paths', () => {
    const token = createShareToken();
    expect(redactShareTokenPath(`/share/${token}`)).toBe('/share/:token');
    expect(redactShareTokenPath(`/share/${token}/`)).toBe('/share/:token');
    expect(redactShareTokenPath(`/api/share/${token}`)).toBe('/api/share/:token');
    expect(redactShareTokenPath(`/api/share/${token}/`)).toBe('/api/share/:token');
    expect(redactShareTokenPath(`/api/share/${token}/image`)).toBe('/api/share/:token/image');
    expect(redactShareTokenPath(`/api/share/${token}/image/`)).toBe('/api/share/:token/image');
    expect(redactShareTokenPath('/api/storyboard/sb_123/share')).toBe('/api/storyboard/sb_123/share');
  });

  test('fails closed for revocation, expiry, deletion, ownership drift and incomplete grids', () => {
    const { share, storyboard } = validRows();
    expect(canAccessSharedStoryboard(share, storyboard, NOW)).toBe(true);

    const cases = [
      [{ ...share, revoked_at: NOW.toISOString() }, storyboard],
      [{ ...share, expires_at: NOW.toISOString() }, storyboard],
      [share, { ...storyboard, expires_at: NOW.toISOString() }],
      [share, { ...storyboard, deleted_at: NOW.toISOString() }],
      [share, { ...storyboard, status: 'processing' }],
      [share, { ...storyboard, grid_storage_path: null }],
      [share, { ...storyboard, user_id: 'other-user' }],
      [{ ...share, storyboard_id: 'sb_other' }, storyboard]
    ];
    for (const [candidateShare, candidateStoryboard] of cases) {
      expect(canAccessSharedStoryboard(candidateShare, candidateStoryboard, NOW)).toBe(false);
    }
  });

  test('public projection exposes only grid presentation metadata', () => {
    const { storyboard } = validRows();
    const token = createShareToken();
    const result = toPublicStoryboard(storyboard, token);
    expect(result).toEqual({
      style: 'Cinematic',
      cutCount: 9,
      createdAt: storyboard.created_at,
      expiresAt: storyboard.expires_at,
      imagePath: `/api/share/${token}/image`
    });
    for (const sensitive of ['scenario', 'shots', 'characters', 'user_id', 'grid_storage_path']) {
      expect(result).not.toHaveProperty(sensitive);
    }
  });

  test('migration keeps the table server-only and bound to source deletion', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations', '017_unlisted_storyboard_sharing.sql'), 'utf8');
    expect(sql).toContain('REFERENCES public.storyboards(id) ON DELETE CASCADE');
    expect(sql).toContain("CHECK (scope = 'grid_only')");
    expect(sql).toContain("CHECK (consent_version = 'unlisted-grid-v1')");
    expect(sql).toContain("CHECK (token_hash ~ '^[0-9a-f]{64}$')");
    expect(sql).toContain('ALTER TABLE public.storyboard_shares ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('TO service_role');
    expect(sql).toContain('REVOKE ALL ON TABLE public.storyboard_shares FROM PUBLIC, anon, authenticated');
    expect(sql).not.toMatch(/GRANT\s+SELECT[^;]+TO\s+(?:anon|authenticated)/i);
  });

  test('public image delivery downloads from the private bucket without signed URLs', () => {
    const route = fs.readFileSync(path.join(ROOT, 'routes', 'public-storyboard-share.js'), 'utf8');
    expect(route).toContain(".from('storyboards')");
    expect(route).toContain('.download(resolved.storyboard.grid_storage_path)');
    expect(route).not.toContain('createSignedUrl');
    expect(route).toContain("'X-Robots-Tag', 'noindex, nofollow, noarchive'");
    expect(route).not.toMatch(/scenario|videoPrompt|characters|reference_image/i);
  });

  test('owner UI requires unchecked explicit consent before creating a link', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'storyboard-result.html'), 'utf8');
    expect(html).toContain('id="shareConsent" type="checkbox"');
    expect(html).toContain('id="createShareBtn" type="button" class="btn btn--secondary" disabled');
    expect(html).toContain('data-i18n="storyboardShare.control.consent"');
    expect(html).toContain('data-i18n="storyboardShare.control.unpublish"');
    expect(html).not.toContain('Publish to Gallery');
  });

  test('owner publish API refuses missing consent and stores a hash instead of the raw token', async () => {
    const storyboardCapture = { eq: [], is: [] };
    const shareCapture = { eq: [], is: [] };
    const storyboard = validRows().storyboard;
    const admin = {
      from(table) {
        if (table === 'storyboards') return queryResult(storyboard, storyboardCapture);
        if (table === 'storyboard_shares') {
          return queryResult({ expires_at: FUTURE, created_at: NOW.toISOString() }, shareCapture);
        }
        throw new Error(`Unexpected table: ${table}`);
      }
    };
    const router = ownerShareRouter._createRouter({
      requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
      getAdminClient: () => admin
    });

    await withServer(router, async baseUrl => {
      const refused = await request(baseUrl, '/sb_123/share', {
        method: 'POST',
        body: { confirmed: false, consentVersion: SHARE_CONSENT_VERSION }
      });
      expect(refused.status).toBe(400);

      const created = await request(baseUrl, '/sb_123/share', {
        method: 'POST',
        body: { confirmed: true, consentVersion: SHARE_CONSENT_VERSION }
      });
      expect(created.status).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      const payload = created.json();
      expect(payload.share.path).toMatch(/^\/share\/[A-Za-z0-9_-]{43}$/);
      const rawToken = payload.share.path.split('/').pop();
      expect(shareCapture.upsert.token_hash).toBe(hashShareToken(rawToken));
      expect(JSON.stringify(shareCapture.upsert)).not.toContain(rawToken);
      expect(shareCapture.upsert.scope).toBe('grid_only');
      expect(shareCapture.upsert.owner_id).toBe('user-1');
      expect(storyboardCapture.eq).toContainEqual(['user_id', 'user-1']);
    });
  });

  test('public API returns only the minimal projection with anti-index headers', async () => {
    const token = createShareToken();
    const { share, storyboard } = validRows();
    const shareCapture = { eq: [], is: [] };
    const admin = {
      from(table) {
        if (table === 'storyboard_shares') return queryResult(share, shareCapture);
        if (table === 'storyboards') return queryResult(storyboard, { eq: [], is: [] });
        throw new Error(`Unexpected table: ${table}`);
      },
      storage: {
        from: () => ({ download: async () => ({ data: new Blob(['png']), error: null }) })
      }
    };
    const router = publicShareRouter._createRouter({ getAdminClient: () => admin });

    await withServer(router, async baseUrl => {
      const response = await request(baseUrl, `/${token}`);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      const payload = response.json();
      expect(Object.keys(payload.storyboard).sort()).toEqual([
        'createdAt', 'cutCount', 'expiresAt', 'imagePath', 'style'
      ]);
      expect(shareCapture.eq).toContainEqual(['token_hash', hashShareToken(token)]);
      expect(JSON.stringify(shareCapture.eq)).not.toContain(token);
    });
  });
});
