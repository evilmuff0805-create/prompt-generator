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
  var authToken = null;
  var memorySessionId = null;

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

  function track(eventName, properties, options) {
    options = options || {};
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
        properties: properties || {}
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
