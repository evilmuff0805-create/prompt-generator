(function (root, factory) {
  'use strict';

  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PromptGenGoogleAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // OAuth client IDs are public identifiers. The corresponding client secret
  // stays only in Google Cloud and Supabase and must never be shipped here.
  const GOOGLE_CLIENT_ID = '1003811654274-t9i9jd0u85r1ijfui8rb2emkqngkv0je.apps.googleusercontent.com';
  const GOOGLE_LIBRARY_URL = 'https://accounts.google.com/gsi/client';
  const SUPPORTED_LOCALES = new Set(['en', 'ko', 'ja', 'zh-CN', 'fr', 'ru']);

  let googleLibraryPromise = null;

  function isInAppBrowser(userAgent) {
    return /KAKAOTALK|Instagram|NAVER|Line|FBAN|FBAV|FB_IAB|Twitter|Snapchat|MicroMessenger/i.test(userAgent || '');
  }

  async function generateNonce(cryptoApi = root?.crypto) {
    if (!cryptoApi?.getRandomValues || !cryptoApi?.subtle?.digest) {
      throw new Error('Secure browser cryptography is unavailable.');
    }

    const randomBytes = cryptoApi.getRandomValues(new Uint8Array(32));
    const nonce = Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const encodedNonce = new TextEncoder().encode(nonce);
    const hashBuffer = await cryptoApi.subtle.digest('SHA-256', encodedNonce);
    const hashedNonce = Array.from(new Uint8Array(hashBuffer), byte => byte.toString(16).padStart(2, '0')).join('');
    return { nonce, hashedNonce };
  }

  function loadGoogleLibrary(documentRef = root?.document) {
    if (root?.google?.accounts?.id) return Promise.resolve(root.google);
    if (googleLibraryPromise) return googleLibraryPromise;
    if (!documentRef) return Promise.reject(new Error('Document is unavailable.'));

    googleLibraryPromise = new Promise((resolve, reject) => {
      const existing = documentRef.querySelector(`script[src="${GOOGLE_LIBRARY_URL}"]`);
      const script = existing || documentRef.createElement('script');
      const onLoad = () => {
        if (root?.google?.accounts?.id) resolve(root.google);
        else reject(new Error('Google Identity Services did not initialize.'));
      };
      const onError = () => reject(new Error('Google Identity Services could not be loaded.'));

      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      if (!existing) {
        script.src = GOOGLE_LIBRARY_URL;
        script.async = true;
        script.dataset.promptgenGoogleAuth = 'true';
        documentRef.head.appendChild(script);
      }
    }).catch(error => {
      googleLibraryPromise = null;
      throw error;
    });

    return googleLibraryPromise;
  }

  function waitForPageLoad(documentRef = root?.document) {
    if (!documentRef || documentRef.readyState === 'complete' || typeof root?.addEventListener !== 'function') {
      return Promise.resolve();
    }
    return new Promise(resolve => root.addEventListener('load', resolve, { once: true }));
  }

  function getLocale() {
    const locale = root?.PromptGenI18n?.getLocale?.() || root?.document?.documentElement?.lang || 'en';
    return SUPPORTED_LOCALES.has(locale) ? locale : 'en';
  }

  function getLocalizedError() {
    return root?.PromptGenI18n?.t?.('auth.googleUnavailable')
      || 'Google sign-in is temporarily unavailable. Please try again.';
  }

  function resolveContainers(documentRef, buttonIds) {
    return buttonIds
      .map(id => documentRef.getElementById(id))
      .filter(Boolean);
  }

  function showError(containers, error) {
    const message = getLocalizedError();
    containers.forEach(container => {
      let errorElement = container.parentElement?.querySelector('[data-google-auth-error]');
      if (!errorElement && container.parentElement) {
        errorElement = container.ownerDocument.createElement('p');
        errorElement.className = 'google-auth-error';
        errorElement.dataset.googleAuthError = 'true';
        errorElement.setAttribute('role', 'alert');
        container.insertAdjacentElement('afterend', errorElement);
      }
      if (errorElement) {
        errorElement.textContent = message;
        errorElement.hidden = false;
      }
    });
    console.error('[PromptGen Auth]', error?.message || error);
  }

  function clearErrors(containers) {
    containers.forEach(container => {
      const errorElement = container.parentElement?.querySelector('[data-google-auth-error]');
      if (errorElement) {
        errorElement.textContent = '';
        errorElement.hidden = true;
      }
    });
  }

  async function mount({ client, buttonIds, surface = 'unknown', onError } = {}) {
    const documentRef = root?.document;
    if (!documentRef || !client?.auth?.signInWithIdToken || !Array.isArray(buttonIds)) {
      throw new Error('Google sign-in configuration is incomplete.');
    }

    const containers = resolveContainers(documentRef, buttonIds);
    if (!containers.length) return { mounted: false };

    if (isInAppBrowser(root?.navigator?.userAgent)) {
      containers.forEach(container => {
        container.setAttribute('aria-disabled', 'true');
        container.classList.add('google-auth-button--disabled');
      });
      return { mounted: false, reason: 'in-app-browser' };
    }

    let busy = false;
    let currentNonce;
    let google;
    try {
      // A third-party identity script must never delay PromptGen's own load
      // event. The static, localized fallback remains visible until GIS is ready.
      await waitForPageLoad(documentRef);
      currentNonce = await generateNonce();
      google = await loadGoogleLibrary(documentRef);
    } catch (error) {
      showError(containers, error);
      onError?.(error);
      return { mounted: false, reason: 'initialization-failed' };
    }

    const handleCredential = async response => {
      if (busy) return;
      busy = true;
      clearErrors(containers);
      root?.PromptGenAnalytics?.track?.('signup_started', {
        surface,
        provider: 'google'
      });

      try {
        if (!response?.credential) throw new Error('Google did not return an ID token.');
        const { error } = await client.auth.signInWithIdToken({
          provider: 'google',
          token: response.credential,
          nonce: currentNonce.nonce
        });
        if (error) throw error;
      } catch (error) {
        showError(containers, error);
        onError?.(error);
        currentNonce = await generateNonce();
        initializeGoogle();
      } finally {
        busy = false;
      }
    };

    const renderButtons = () => {
      const locale = getLocale();
      containers.forEach(container => {
        const requestedWidth = Number(container.dataset.googleWidth || 320);
        const width = Math.max(240, Math.min(400, requestedWidth));
        container.replaceChildren();
        google.accounts.id.renderButton(container, {
          type: 'standard',
          // Google automatically turns a large returning-user button into a
          // personalized control that exposes the account name and email.
          // Medium buttons remain the simple, generic sign-in control.
          theme: 'outline',
          size: 'medium',
          text: 'signin_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width,
          locale
        });
      });
    };

    const initializeGoogle = () => {
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredential,
        nonce: currentNonce.hashedNonce,
        context: 'signin',
        ux_mode: 'popup',
        auto_select: false,
        cancel_on_tap_outside: true,
        use_fedcm_for_prompt: true,
        itp_support: true
      });
      renderButtons();
    };

    initializeGoogle();
    const localeListener = () => renderButtons();
    documentRef.addEventListener('promptgen:localechange', localeListener);

    return {
      mounted: true,
      destroy() {
        documentRef.removeEventListener('promptgen:localechange', localeListener);
      }
    };
  }

  return Object.freeze({
    GOOGLE_CLIENT_ID,
    GOOGLE_LIBRARY_URL,
    generateNonce,
    isInAppBrowser,
    mount
  });
});
