'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('cross-tool Storyboard progress contract', () => {
  test('all authenticated tool surfaces load the versioned progress controller', () => {
    for (const file of [
      'public/index.html',
      'public/frame.html',
      'public/storyboard.html',
      'public/storyboard-history.html',
      'public/storyboard-result.html'
    ]) {
      expect(read(file)).toContain('/storyboard-progress.js?v=__ASSET_VERSION__');
    }
  });

  test('active discovery is authenticated, owner-scoped, read-only, and registered before /:id', () => {
    const source = read('routes/storyboard.js');
    const activeIndex = source.indexOf("router.get('/active'");
    const listIndex = source.indexOf("router.get('/list'");
    const parameterIndex = source.indexOf("router.get('/:id/status'");
    const activeRoute = source.slice(activeIndex, listIndex);

    expect(activeIndex).toBeGreaterThan(-1);
    expect(listIndex).toBeGreaterThan(activeIndex);
    expect(parameterIndex).toBeGreaterThan(activeIndex);
    expect(activeRoute).toContain("router.get('/active', requireAuth");
    expect(activeRoute).toContain(".eq('user_id', userId)");
    expect(activeRoute).toContain(".in('status', ['pending', 'processing'])");
    expect(activeRoute).not.toMatch(/\.(insert|update|delete|upsert)\(/);
    expect(activeRoute).not.toContain('scenario');
    expect(activeRoute).not.toContain('reference_image_ids');
    expect(activeRoute).not.toContain('grid_storage_path');
  });

  test('client state is tab-scoped, account-bound, and guards only the pre-ack handoff', () => {
    const source = read('public/storyboard-progress.js');

    expect(source).toContain('window.sessionStorage');
    expect(source).not.toContain('window.localStorage');
    expect(source).toContain('state.userId !== context.userId');
    expect(source).toContain("window.addEventListener('beforeunload', guardPendingUnload)");
    expect(source).toContain("document.addEventListener('click', guardPendingNavigation, true)");
    expect(source).toContain("fetchJson('/api/storyboard/active'");
    expect(source).toContain('TERMINAL_RETENTION_MS');
  });

  test('every locale contains the global progress copy', () => {
    for (const locale of ['en', 'ko', 'ja', 'zh-CN', 'fr', 'ru']) {
      const source = read(`public/i18n/locales/${locale}.js`);
      for (const key of [
        'storyboardProgress.starting',
        'storyboardProgress.startingHint',
        'storyboardProgress.generating',
        'storyboardProgress.generatingMultiple',
        'storyboardProgress.ready',
        'storyboardProgress.failed',
        'storyboardProgress.open',
        'storyboardProgress.dismiss'
      ]) {
        expect(source).toContain(`'${key}'`);
      }
    }
  });
});
