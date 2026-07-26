'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const googleAuth = fs.readFileSync(path.join(root, 'public', 'google-auth.js'), 'utf8');

describe('home authentication latency contract', () => {
  test('keeps the Supabase auth callback synchronous', () => {
    expect(app).toContain('sbClient.auth.onAuthStateChange((event, session) => {');
    expect(app).not.toMatch(/onAuthStateChange\s*\(\s*async\b/);
  });

  test('closes sign-in UI before starting profile hydration', () => {
    const callback = app.slice(
      app.indexOf('sbClient.auth.onAuthStateChange'),
      app.indexOf('   HISTORY', app.indexOf('sbClient.auth.onAuthStateChange'))
    );

    expect(callback.indexOf('closeModal();')).toBeGreaterThan(-1);
    expect(callback.indexOf('void refreshUserProfile(session);')).toBeGreaterThan(callback.indexOf('closeModal();'));
  });

  test('deduplicates an in-flight profile request and rejects stale session results', () => {
    expect(app).toContain('profileRefreshPromise && profileRefreshUserId === userId');
    expect(app).toContain('activeAuthUserId === userId && authSessionGeneration === requestGeneration');
  });

  test('starts GIS initialization without waiting for the full page load event', () => {
    expect(googleAuth).toContain('[currentNonce, google] = await Promise.all([');
    expect(googleAuth).not.toContain('waitForPageLoad');
  });
});
