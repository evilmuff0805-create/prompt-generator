'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'analytics.js'),
  'utf8'
);

function makeStorage() {
  const values = new Map();
  return {
    getItem: jest.fn(key => values.has(key) ? values.get(key) : null),
    setItem: jest.fn((key, value) => values.set(key, String(value))),
    removeItem: jest.fn(key => values.delete(key))
  };
}

function loadAnalytics(storage) {
  let uuidCounter = 0;
  const fetch = jest.fn().mockResolvedValue({ ok: true });
  const window = {
    crypto: {
      randomUUID: () => `11111111-1111-4111-8111-${String(++uuidCounter).padStart(12, '0')}`
    },
    fetch,
    location: { pathname: '/' },
    sessionStorage: storage
  };
  const document = {
    readyState: 'loading',
    addEventListener: jest.fn()
  };

  vm.runInNewContext(source, {
    Date,
    JSON,
    Math,
    Promise,
    document,
    navigator: { doNotTrack: '0' },
    window
  });

  return { analytics: window.PromptGenAnalytics, fetch };
}

function sentEvents(fetch) {
  return fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
}

describe('browser product analytics auth intent', () => {
  test('records auth completion once only after an explicit sign-in start', async () => {
    const { analytics, fetch } = loadAnalytics(makeStorage());

    await expect(analytics.track('auth_completed', {
      surface: 'home',
      provider: 'google'
    })).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();

    await analytics.track('signup_started', {
      surface: 'storyboard',
      provider: 'google'
    });
    await expect(analytics.track('auth_completed', {
      surface: 'home',
      provider: 'google'
    })).resolves.toBe(true);
    await expect(analytics.track('auth_completed', {
      surface: 'home',
      provider: 'google'
    })).resolves.toBe(false);

    expect(sentEvents(fetch)).toEqual([
      expect.objectContaining({
        eventName: 'signup_started',
        properties: { surface: 'storyboard', provider: 'google' }
      }),
      expect.objectContaining({
        eventName: 'auth_completed',
        properties: { surface: 'storyboard', provider: 'google' }
      })
    ]);
  });

  test('carries the sign-in intent across the OAuth redirect document', async () => {
    const storage = makeStorage();
    const beforeRedirect = loadAnalytics(storage);
    await beforeRedirect.analytics.track('signup_started', {
      surface: 'endframe',
      provider: 'google'
    });

    const afterRedirect = loadAnalytics(storage);
    await expect(afterRedirect.analytics.track('auth_completed', {
      surface: 'home',
      provider: 'google'
    })).resolves.toBe(true);

    expect(sentEvents(afterRedirect.fetch)).toEqual([
      expect.objectContaining({
        eventName: 'auth_completed',
        properties: { surface: 'endframe', provider: 'google' }
      })
    ]);
  });
});
