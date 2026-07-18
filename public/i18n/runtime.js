(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PromptGenI18nCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function canonicalizeLocale(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const candidate = value.trim().replace(/_/g, '-');
    try {
      return Intl.getCanonicalLocales(candidate)[0] || null;
    } catch (_) {
      return null;
    }
  }

  function matchLocale(value, availableLocales) {
    const canonical = canonicalizeLocale(value);
    if (!canonical) return null;

    const available = (availableLocales || [])
      .map(locale => canonicalizeLocale(locale))
      .filter(Boolean);
    const exact = available.find(locale => locale.toLowerCase() === canonical.toLowerCase());
    if (exact) return exact;

    const lower = canonical.toLowerCase();
    if (lower === 'zh' || lower.startsWith('zh-hans')) {
      return available.find(locale => locale.toLowerCase() === 'zh-cn') || null;
    }
    if (lower.startsWith('zh-hant') || /^zh-(tw|hk|mo)(-|$)/i.test(canonical)) return null;

    const language = lower.split('-')[0];
    return available.find(locale => locale.toLowerCase().split('-')[0] === language) || null;
  }

  function resolveLocale(options) {
    const settings = options || {};
    const available = settings.availableLocales || [];
    const fallback = matchLocale(settings.defaultLocale || 'en', available) || available[0] || 'en';
    const preferred = matchLocale(settings.preferredLocale, available);
    if (preferred) return preferred;

    for (const language of settings.navigatorLanguages || []) {
      const match = matchLocale(language, available);
      if (match) return match;
    }
    return fallback;
  }

  function readPreference(storage, key) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      return storage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function writePreference(storage, key, locale) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(key, locale);
      return true;
    } catch (_) {
      return false;
    }
  }

  function interpolate(template, values) {
    return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(values || {}, key) ? String(values[key]) : match;
    });
  }

  function renderMessage(message, values, locale) {
    if (typeof message === 'string' || typeof message === 'number') {
      return interpolate(message, values);
    }
    if (!message || typeof message !== 'object') return null;

    const variable = message.variable || 'value';
    if (message.type === 'plural') {
      const count = Number(values && values[variable]);
      const category = Number.isFinite(count)
        ? new Intl.PluralRules(locale).select(count)
        : 'other';
      const template = message[category] ?? message.other;
      return template == null ? null : interpolate(template, values);
    }
    if (message.type === 'select') {
      const selected = String(values && values[variable]);
      const template = message[selected] ?? message.other;
      return template == null ? null : interpolate(template, values);
    }
    return null;
  }

  function parseAttributeBindings(value) {
    if (typeof value !== 'string') return [];
    return value.split(',').map(function (entry) {
      const separator = entry.indexOf(':');
      if (separator < 1) return null;
      const attribute = entry.slice(0, separator).trim();
      const key = entry.slice(separator + 1).trim();
      if (!attribute || !key || /^on/i.test(attribute)) return null;
      return { attribute, key };
    }).filter(Boolean);
  }

  function parseVariables(value) {
    if (typeof value !== 'string' || !value.trim()) return {};
    return value.split(',').reduce(function (variables, entry) {
      const separator = entry.indexOf(':');
      if (separator < 1) return variables;
      const key = entry.slice(0, separator).trim();
      const rawValue = entry.slice(separator + 1).trim();
      if (!key) return variables;
      const numericValue = Number(rawValue);
      variables[key] = rawValue !== '' && Number.isFinite(numericValue) ? numericValue : rawValue;
      return variables;
    }, {});
  }

  function createI18n(options) {
    const settings = options || {};
    const catalogs = settings.catalogs || {};
    const defaultLocale = settings.defaultLocale || 'en';
    const availableLocales = (settings.availableLocales || Object.keys(catalogs)).filter(function (locale) {
      return Boolean(catalogs[locale]);
    });
    if (!availableLocales.length || !catalogs[defaultLocale]) {
      throw new Error('PromptGen i18n requires a default catalog and at least one available locale.');
    }

    const preferenceKey = settings.preferenceKey || 'promptgen.locale.v1';
    const storage = settings.storage || null;
    const navigatorLanguages = settings.navigatorLanguages || [];
    const listeners = new Set();
    let locale = resolveLocale({
      preferredLocale: readPreference(storage, preferenceKey),
      navigatorLanguages,
      availableLocales,
      defaultLocale
    });

    function reportMissing(key, requestedLocale, fallbackUsed) {
      if (typeof settings.onMissingKey === 'function') {
        settings.onMissingKey({ key, locale: requestedLocale, fallbackUsed });
      }
    }

    function t(key, values, requestedLocale) {
      const targetLocale = matchLocale(requestedLocale || locale, availableLocales) || locale;
      const targetMessage = catalogs[targetLocale] && catalogs[targetLocale][key];
      let rendered = renderMessage(targetMessage, values, targetLocale);
      if (rendered != null) return rendered;

      const fallbackMessage = catalogs[defaultLocale] && catalogs[defaultLocale][key];
      rendered = renderMessage(fallbackMessage, values, defaultLocale);
      if (rendered != null) {
        reportMissing(key, targetLocale, true);
        return rendered;
      }

      reportMissing(key, targetLocale, false);
      return '[' + key + ']';
    }

    function apply(rootNode) {
      if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return;
      const documentNode = rootNode.nodeType === 9 ? rootNode : rootNode.ownerDocument;
      if (documentNode && documentNode.documentElement) documentNode.documentElement.lang = locale;

      rootNode.querySelectorAll('[data-i18n]').forEach(function (element) {
        element.textContent = t(
          element.getAttribute('data-i18n'),
          parseVariables(element.getAttribute('data-i18n-vars'))
        );
      });
      rootNode.querySelectorAll('[data-i18n-attr]').forEach(function (element) {
        parseAttributeBindings(element.getAttribute('data-i18n-attr')).forEach(function (binding) {
          element.setAttribute(binding.attribute, t(binding.key));
        });
      });
      rootNode.querySelectorAll('[data-locale-select]').forEach(function (element) {
        element.value = locale;
      });
    }

    function setLocale(nextLocale, setOptions) {
      const matched = matchLocale(nextLocale, availableLocales);
      if (!matched) return false;
      const changed = matched !== locale;
      locale = matched;
      if (!setOptions || setOptions.persist !== false) writePreference(storage, preferenceKey, locale);
      if (settings.document) apply(settings.document);
      if (changed) {
        listeners.forEach(function (listener) { listener(locale); });
        if (settings.document && typeof settings.document.dispatchEvent === 'function') {
          const view = settings.document.defaultView;
          if (view && typeof view.CustomEvent === 'function') {
            settings.document.dispatchEvent(new view.CustomEvent('promptgen:localechange', {
              detail: { locale }
            }));
          }
        }
      }
      return true;
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }

    return {
      apply,
      availableLocales: availableLocales.slice(),
      defaultLocale,
      formatCurrency: function (value, currency, formatOptions) {
        return new Intl.NumberFormat(locale, Object.assign({
          style: 'currency',
          currency: currency || 'USD'
        }, formatOptions)).format(value);
      },
      formatDate: function (value, formatOptions) {
        return new Intl.DateTimeFormat(locale, formatOptions).format(value);
      },
      formatNumber: function (value, formatOptions) {
        return new Intl.NumberFormat(locale, formatOptions).format(value);
      },
      getLocale: function () { return locale; },
      setLocale,
      subscribe,
      t
    };
  }

  function createLanguageSwitcher(documentNode, i18n, localeDefinitions) {
    if (!documentNode || !i18n) return null;
    const navInner = documentNode.querySelector('.navbar__inner, .topbar');
    if (!navInner) return null;

    let mount = navInner.querySelector('[data-locale-switcher]');
    if (!mount) {
      mount = documentNode.createElement('div');
      mount.className = 'locale-switcher';
      mount.setAttribute('data-locale-switcher', '');
      const insertionPoint = navInner.querySelector('.navbar__hamburger, .topbar__back');
      navInner.insertBefore(mount, insertionPoint || null);
    }

    const definitions = localeDefinitions || [];
    const publicDefinitions = definitions.filter(function (definition) {
      return i18n.availableLocales.includes(definition.code);
    });
    mount.hidden = publicDefinitions.length < 2;
    mount.setAttribute('aria-hidden', mount.hidden ? 'true' : 'false');
    mount.textContent = '';
    if (mount.hidden) return mount;

    const label = documentNode.createElement('label');
    label.className = 'sr-only';
    label.setAttribute('for', 'promptgenLocaleSelect');
    label.setAttribute('data-i18n', 'language.selector.label');
    label.textContent = i18n.t('language.selector.label');

    const select = documentNode.createElement('select');
    select.id = 'promptgenLocaleSelect';
    select.className = 'locale-switcher__select';
    select.setAttribute('data-locale-select', '');
    select.setAttribute('aria-label', i18n.t('language.selector.label'));
    select.setAttribute('data-i18n-attr', 'aria-label:language.selector.label');
    publicDefinitions.forEach(function (definition) {
      const option = documentNode.createElement('option');
      option.value = definition.code;
      option.textContent = definition.nativeName;
      select.appendChild(option);
    });
    select.value = i18n.getLocale();
    select.addEventListener('change', function () { i18n.setLocale(select.value); });
    mount.appendChild(label);
    mount.appendChild(select);
    return mount;
  }

  return {
    canonicalizeLocale,
    createI18n,
    createLanguageSwitcher,
    interpolate,
    matchLocale,
    parseAttributeBindings,
    parseVariables,
    renderMessage,
    resolveLocale
  };
});
