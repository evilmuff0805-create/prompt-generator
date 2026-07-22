'use strict';

const { webcrypto } = require('crypto');

describe('PromptGen Google direct sign-in', () => {
  const originalGlobals = {};

  beforeEach(() => {
    jest.resetModules();
    for (const key of ['document', 'google', 'PromptGenI18n', 'PromptGenAnalytics']) {
      originalGlobals[key] = global[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalGlobals)) {
      if (typeof value === 'undefined') delete global[key];
      else global[key] = value;
    }
  });

  test('uses the PromptGen web client and the official GIS library', () => {
    const auth = require('../../public/google-auth');
    expect(auth.GOOGLE_CLIENT_ID).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(auth.GOOGLE_LIBRARY_URL).toBe('https://accounts.google.com/gsi/client');
  });

  test('creates a raw nonce and its SHA-256 hexadecimal digest', async () => {
    const auth = require('../../public/google-auth');
    const { nonce, hashedNonce } = await auth.generateNonce(webcrypto);

    expect(nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(hashedNonce).toMatch(/^[a-f0-9]{64}$/);
    expect(hashedNonce).not.toBe(nonce);
  });

  test('passes the Google ID token and raw nonce to Supabase', async () => {
    const rendered = [];
    let googleConfig;
    const parent = { querySelector: () => null };
    const container = {
      dataset: { googleWidth: '320' },
      parentElement: parent,
      ownerDocument: null,
      replaceChildren: jest.fn()
    };
    const documentStub = {
      documentElement: { lang: 'en' },
      getElementById: id => id === 'googleLoginBtn' ? container : null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    };
    container.ownerDocument = documentStub;

    global.document = documentStub;
    global.google = {
      accounts: {
        id: {
          initialize: jest.fn(config => { googleConfig = config; }),
          renderButton: jest.fn((element, config) => rendered.push({ element, config }))
        }
      }
    };
    global.PromptGenI18n = { getLocale: () => 'en', t: key => key };
    global.PromptGenAnalytics = { track: jest.fn() };

    const signInWithIdToken = jest.fn().mockResolvedValue({ error: null });
    const auth = require('../../public/google-auth');
    const result = await auth.mount({
      client: { auth: { signInWithIdToken } },
      buttonIds: ['googleLoginBtn'],
      surface: 'home'
    });

    expect(result.mounted).toBe(true);
    expect(googleConfig.client_id).toBe(auth.GOOGLE_CLIENT_ID);
    expect(googleConfig.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(googleConfig.use_fedcm_for_prompt).toBe(true);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].config).toMatchObject({
      type: 'standard',
      theme: 'outline',
      size: 'medium',
      text: 'signin_with',
      shape: 'rectangular'
    });

    await googleConfig.callback({ credential: 'google-id-token' });
    expect(signInWithIdToken).toHaveBeenCalledWith({
      provider: 'google',
      token: 'google-id-token',
      nonce: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(signInWithIdToken.mock.calls[0][0].nonce).not.toBe(googleConfig.nonce);
  });

  test('blocks known in-app browsers before requesting Google identity UI', () => {
    const auth = require('../../public/google-auth');
    expect(auth.isInAppBrowser('KAKAOTALK/25.0')).toBe(true);
    expect(auth.isInAppBrowser('Mozilla/5.0 Chrome/140.0')).toBe(false);
  });
});
