(function () {
  'use strict';

  if (navigator.doNotTrack === '1') {
    window.PromptGenAnalytics = {
      track: function () { return Promise.resolve(false); },
      setAuthToken: function () {}
    };
    return;
  }

  var SESSION_KEY = 'promptgen_analytics_session_v1';
  var AUTH_INTENT_KEY = 'promptgen_analytics_auth_intent_v1';
  var AUTH_INTENT_MAX_AGE_MS = 30 * 60 * 1000;
  var authToken = null;
  var memorySessionId = null;
  var memoryAuthIntent = null;

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
      var value = Math.floor(Math.random() * 16);
      var nibble = char === 'x' ? value : (value & 3) | 8;
      return nibble.toString(16);
    });
  }

  function sessionId() {
    if (memorySessionId) return memorySessionId;
    try {
      var existing = window.sessionStorage.getItem(SESSION_KEY);
      if (existing) {
        memorySessionId = existing;
        return memorySessionId;
      }
      memorySessionId = uuid();
      window.sessionStorage.setItem(SESSION_KEY, memorySessionId);
      return memorySessionId;
    } catch (_) {
      memorySessionId = uuid();
      return memorySessionId;
    }
  }

  function pagePath() {
    var path = window.location.pathname || '/';
    if (/^\/storyboard\/sb_[a-zA-Z0-9]+\/?$/.test(path)) {
      return '/storyboard/:id';
    }
    if (path.length > 1) path = path.replace(/\/$/, '');
    return path;
  }

  function rememberAuthIntent(properties) {
    var intent = {
      startedAt: Date.now(),
      surface: typeof properties?.surface === 'string' ? properties.surface : null,
      provider: typeof properties?.provider === 'string' ? properties.provider : null
    };
    memoryAuthIntent = intent;
    try {
      window.sessionStorage.setItem(AUTH_INTENT_KEY, JSON.stringify(intent));
    } catch (_) {
      // The in-memory fallback still protects this document from duplicate events.
    }
  }

  function consumeAuthIntent(fallbackProperties) {
    var intent = memoryAuthIntent;
    memoryAuthIntent = null;

    try {
      var stored = window.sessionStorage.getItem(AUTH_INTENT_KEY);
      window.sessionStorage.removeItem(AUTH_INTENT_KEY);
      if (stored) intent = JSON.parse(stored);
    } catch (_) {
      // Invalid or unavailable session storage fails closed below.
    }

    if (!intent || typeof intent.startedAt !== 'number') return null;
    var age = Date.now() - intent.startedAt;
    if (age < 0 || age > AUTH_INTENT_MAX_AGE_MS) return null;

    fallbackProperties = fallbackProperties || {};
    return {
      surface: typeof intent.surface === 'string' ? intent.surface : fallbackProperties.surface,
      provider: typeof intent.provider === 'string' ? intent.provider : fallbackProperties.provider
    };
  }

  function track(eventName, properties, options) {
    options = options || {};
    properties = properties || {};

    if (eventName === 'signup_started') {
      rememberAuthIntent(properties);
    } else if (eventName === 'auth_completed') {
      properties = consumeAuthIntent(properties);
      if (!properties) return Promise.resolve(false);
    }

    var token = options.token || authToken;
    var headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;

    return window.fetch('/api/analytics/events', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: headers,
      body: JSON.stringify({
        eventId: uuid(),
        eventName: eventName,
        sessionId: sessionId(),
        pagePath: pagePath(),
        properties: properties
      })
    }).then(function (response) {
      return response.ok;
    }).catch(function () {
      return false;
    });
  }

  function setAuthToken(token) {
    authToken = typeof token === 'string' && token ? token : null;
  }

  window.PromptGenAnalytics = {
    track: track,
    setAuthToken: setAuthToken
  };

  function trackPage() {
    track('page_viewed');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trackPage, { once: true });
  } else {
    trackPage();
  }
})();
