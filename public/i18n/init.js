(function () {
  'use strict';

  const core = window.PromptGenI18nCore;
  const config = window.PromptGenI18nConfig;
  const catalogs = window.PromptGenI18nCatalogs || {};
  if (!core || !config || !catalogs[config.defaultLocale]) {
    console.error('[i18n] Runtime, config, or English source catalog is unavailable.');
    return;
  }

  let preferenceStorage = null;
  try {
    preferenceStorage = window.localStorage;
  } catch (_) {
    // Privacy modes can deny storage access; locale resolution still falls back safely.
  }

  const i18n = core.createI18n({
    availableLocales: config.publicLocales,
    catalogs,
    defaultLocale: config.defaultLocale,
    document,
    onMissingKey: function (details) {
      console.warn('[i18n] Missing message key:', details.key, 'locale:', details.locale);
    },
    preferenceKey: config.preferenceKey,
    storage: preferenceStorage
  });
  window.PromptGenI18n = i18n;

  function initializePage() {
    i18n.apply(document);
    core.createLanguageSwitcher(document, i18n, config.locales);
  }

  // Every PromptGen page loads this bundle at the end of <body>, so the UI is
  // already available. Apply synchronously before third-party SDKs can delay
  // DOMContentLoaded on slow or restricted networks.
  initializePage();
})();
