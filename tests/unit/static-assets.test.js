'use strict';

const {
  getAssetVersion,
  renderVersionedHtml,
  setStaticCacheHeaders
} = require('../../lib/static-assets');

describe('static asset versioning and cache headers', () => {
  test('Railway commit SHA becomes the bounded public asset version', () => {
    expect(getAssetVersion({ RAILWAY_GIT_COMMIT_SHA: '337230da22f17dc356152e9f6174ec04783e1bdb' }))
      .toBe('337230da22f1');
    expect(getAssetVersion({})).toBe('dev');
  });

  test('unsafe version characters are removed before HTML rendering', () => {
    expect(getAssetVersion({ PUBLIC_ASSET_VERSION: 'release?<v1>' })).toBe('releasev1');
  });

  test('all asset placeholders receive the same encoded version', () => {
    const html = '<script src="/a.js?v=__ASSET_VERSION__"></script><link href="/a.css?v=__ASSET_VERSION__">';
    expect(renderVersionedHtml(html, 'release-1')).toBe(
      '<script src="/a.js?v=release-1"></script><link href="/a.css?v=release-1">'
    );
  });

  test.each(['index.html', 'app.js', 'styles.css', 'catalog.json', 'app.js.map'])(
    '%s requires revalidation',
    (filePath) => {
      const res = { setHeader: jest.fn() };
      setStaticCacheHeaders(res, `C:/public/${filePath}`);
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, must-revalidate');
    }
  );

  test('media assets keep the platform default cache policy', () => {
    const res = { setHeader: jest.fn() };
    setStaticCacheHeaders(res, 'C:/public/gallery.webp');
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
