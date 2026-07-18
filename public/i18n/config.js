(function (root, factory) {
  'use strict';

  const config = factory();
  if (typeof module === 'object' && module.exports) module.exports = config;
  if (root) root.PromptGenI18nConfig = config;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const locales = Object.freeze([
    Object.freeze({ code: 'en', nativeName: 'English', public: true }),
    Object.freeze({ code: 'ko', nativeName: '한국어', public: true }),
    Object.freeze({ code: 'ja', nativeName: '日本語', public: true }),
    Object.freeze({ code: 'zh-CN', nativeName: '简体中文', public: true }),
    Object.freeze({ code: 'fr', nativeName: 'Français', public: true }),
    Object.freeze({ code: 'ru', nativeName: 'Русский', public: true })
  ]);

  return Object.freeze({
    defaultLocale: 'en',
    locales,
    preferenceKey: 'promptgen.locale.v1',
    publicLocales: Object.freeze(locales.filter(locale => locale.public).map(locale => locale.code))
  });
});
