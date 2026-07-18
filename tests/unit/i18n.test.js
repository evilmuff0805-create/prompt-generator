'use strict';

const fs = require('fs');
const path = require('path');

const core = require('../../public/i18n/runtime');
const config = require('../../public/i18n/config');
const english = require('../../public/i18n/locales/en');

const ROOT = path.join(__dirname, '..', '..');
const LOCALES = ['en', 'ko', 'ja', 'zh-CN', 'fr', 'ru'];
const APP_HTML = [
  'index.html',
  'frame.html',
  'storyboard.html',
  'storyboard-history.html',
  'storyboard-result.html'
];
const ALL_HTML = [...APP_HTML, 'terms.html', 'privacy.html', 'refund.html'];
const LEGAL_FILES = ['terms.html', 'privacy.html', 'refund.html'];
const OPERATOR_DETAILS = ['codemeet', 'yerim suk', '470-32-01835', 'codemeet@naver.com'];
const LEGAL_UPDATED_DATE = Object.freeze({
  ko: '2026년 7월 18일',
  ja: '2026年7月18日',
  'zh-CN': '2026年7月18日',
  fr: '18 juillet 2026',
  ru: '18 июля 2026 г.'
});

function catalog(locale) {
  return locale === 'en' ? english : require(`../../public/i18n/locales/${locale}`);
}

function operatorBlock(html) {
  const blocks = html.match(/<section\s*class="operator-details">[\s\S]*?<\/section>/g) || [];
  expect(blocks).toHaveLength(1);
  return blocks[0];
}

function variables(message) {
  const templates = typeof message === 'object' && message !== null
    ? Object.entries(message).filter(([key]) => !['type', 'variable'].includes(key)).map(([, value]) => value)
    : [message];
  return [...new Set(templates.flatMap(template =>
    [...String(template).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1])
  ))].sort();
}

describe('PromptGen i18n contract', () => {
  test('English is the source/default and all six locales are public', () => {
    expect(config.defaultLocale).toBe('en');
    expect(config.publicLocales).toEqual(LOCALES);
    expect(config.locales.map(locale => locale.nativeName)).toEqual([
      'English', '한국어', '日本語', '简体中文', 'Français', 'Русский'
    ]);
    const initSource = fs.readFileSync(path.join(ROOT, 'public', 'i18n', 'init.js'), 'utf8');
    expect(initSource).not.toContain('navigatorLanguages');
  });

  test('locale matching is canonical and does not map Traditional Chinese to Simplified Chinese', () => {
    expect(core.matchLocale('FR_ca', LOCALES)).toBe('fr');
    expect(core.matchLocale('zh-Hans-SG', LOCALES)).toBe('zh-CN');
    expect(core.matchLocale('zh-TW', LOCALES)).toBeNull();
    expect(core.resolveLocale({
      preferredLocale: null,
      navigatorLanguages: ['zh-TW'],
      availableLocales: LOCALES,
      defaultLocale: 'en'
    })).toBe('en');
  });

  test('an explicit stored preference wins and changes persist locally', () => {
    const values = new Map([['promptgen.locale.v1', 'ja']]);
    const storage = {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value)
    };
    const i18n = core.createI18n({
      availableLocales: ['en', 'ja'],
      catalogs: { en: english, ja: catalog('ja') },
      defaultLocale: 'en',
      navigatorLanguages: ['en-US'],
      storage
    });
    expect(i18n.getLocale()).toBe('ja');
    expect(i18n.setLocale('en')).toBe(true);
    expect(values.get('promptgen.locale.v1')).toBe('en');
    expect(i18n.setLocale('de')).toBe(false);
  });

  test('storage failures do not block English fallback', () => {
    const i18n = core.createI18n({
      availableLocales: ['en'],
      catalogs: { en: english },
      defaultLocale: 'en',
      navigatorLanguages: ['ko'],
      storage: { getItem: () => { throw new Error('blocked'); } }
    });
    expect(i18n.getLocale()).toBe('en');
    expect(i18n.t('nav.link.home')).toBe('Home');
  });

  test('missing localized messages use English and missing source keys stay visible', () => {
    const missing = [];
    const i18n = core.createI18n({
      availableLocales: ['en', 'ko'],
      catalogs: { en: { greeting: 'Hello {name}' }, ko: {} },
      defaultLocale: 'en',
      onMissingKey: details => missing.push(details)
    });
    expect(i18n.t('greeting', { name: 'Mina' }, 'ko')).toBe('Hello Mina');
    expect(i18n.t('unknown', {}, 'ko')).toBe('[unknown]');
    expect(missing).toEqual([
      { key: 'greeting', locale: 'ko', fallbackUsed: true },
      { key: 'unknown', locale: 'ko', fallbackUsed: false }
    ]);
  });

  test('plural, select, interpolation and safe attribute parsing support the contract', () => {
    expect(core.renderMessage({
      type: 'plural', variable: 'count', one: '{count} кредит', few: '{count} кредита', many: '{count} кредитов', other: '{count} кредита'
    }, { count: 2 }, 'ru')).toBe('2 кредита');
    expect(core.renderMessage({ type: 'select', variable: 'state', ready: 'Ready', other: 'Waiting' }, { state: 'ready' }, 'en')).toBe('Ready');
    expect(core.interpolate('Page {page} of {total}', { page: 2, total: 4 })).toBe('Page 2 of 4');
    expect(core.parseAttributeBindings('aria-label:nav.open,placeholder:field.hint,onerror:bad')).toEqual([
      { attribute: 'aria-label', key: 'nav.open' },
      { attribute: 'placeholder', key: 'field.hint' }
    ]);
    expect(core.parseVariables('credits:120,name:Pro')).toEqual({ credits: 120, name: 'Pro' });
  });
});

describe('locale catalog completeness', () => {
  test.each(LOCALES.slice(1))('%s explicitly translates every English key', locale => {
    const localized = catalog(locale);
    expect([...localized.__translatedKeys].sort()).toEqual(Object.keys(english).sort());
    expect(Object.keys(localized)).toEqual(Object.keys(english));
    for (const key of Object.keys(english)) {
      expect(localized[key]).not.toBeNull();
      expect(localized[key]).not.toBe('');
      expect(variables(localized[key])).toEqual(variables(english[key]));
    }
  });

  test('all declarative and literal runtime keys exist in the source catalog', () => {
    const keys = new Set();
    for (const file of APP_HTML) {
      const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
      for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) keys.add(match[1]);
      for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
        match[1].split(',').forEach(binding => keys.add(binding.slice(binding.indexOf(':') + 1).trim()));
      }
    }
    const scripts = fs.readdirSync(path.join(ROOT, 'public'), { recursive: true })
      .filter(file => String(file).endsWith('.js') && !String(file).includes(`i18n${path.sep}locales`))
      .map(file => fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'))
      .join('\n');
    for (const match of scripts.matchAll(/uiText\(['"]([^'"`]+)['"]/g)) keys.add(match[1]);
    for (const match of scripts.matchAll(/data-i18n="([^"]+)"/g)) keys.add(match[1]);

    expect([...keys].filter(key => !Object.hasOwn(english, key))).toEqual([]);
  });

  test('dynamic key families are complete', () => {
    const dynamicKeys = [
      ...['free', 'pro', 'enterprise'].flatMap(plan => [`pricing.plan.${plan}.name`, `pricing.plan.${plan}.description`]),
      ...['all', 'architecture', 'portrait', 'fashion', 'branded', 'design', 'food'].map(value => `gallery.category.${value}`),
      ...['romance', 'drama', 'thriller', 'comedy', 'action', 'horror', 'scifi', 'fantasy', 'mystery'].map(value => `storyboard.genre.${value}`),
      ...['pixar', 'cinematic', 'documentary', 'animation'].map(value => `storyboard.style.${value}`),
      ...['pending', 'processing', 'completed', 'failed'].map(value => `storyboard.status.${value}`),
      ...['analyzing_scenario', 'generating_grid', 'finalizing', 'retry_wait', 'processing'].map(value => `storyboard.step.${value}`)
    ];
    expect(dynamicKeys.filter(key => !Object.hasOwn(english, key))).toEqual([]);
  });
});

describe('page integration and legal parity', () => {
  test.each(ALL_HTML)('%s loads the global locale runtime', file => {
    const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    expect(html).toContain('/i18n/runtime.js');
    expect(html).toContain('/i18n/locales/ru.js');
    expect(html).toContain('/i18n/init.js');
  });

  test.each(APP_HTML)('%s initializes locale before third-party SDKs', file => {
    const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    const i18nInitIndex = html.indexOf('/i18n/init.js');
    const thirdPartyIndex = html.indexOf('<script src="https://');
    expect(i18nInitIndex).toBeGreaterThan(-1);
    expect(thirdPartyIndex).toBeGreaterThan(-1);
    expect(i18nInitIndex).toBeLessThan(thirdPartyIndex);
  });

  test.each(LEGAL_FILES)('%s publishes the exact service operator details', file => {
    const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    const disclosure = operatorBlock(html);
    for (const detail of OPERATOR_DETAILS) {
      expect(disclosure).toContain(detail);
    }
    expect(disclosure).toContain('href="mailto:codemeet@naver.com"');
    expect(html).toContain('Last Updated: July 18, 2026');
  });

  test.each(LEGAL_FILES)('%s deploy-versions every local stylesheet and script', file => {
    const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    const localAssets = [
      ...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/[^"#]+)"/g)
    ].map(match => match[1]);
    expect(localAssets.length).toBeGreaterThan(0);
    expect(localAssets.filter(asset => !asset.includes('?v=__ASSET_VERSION__'))).toEqual([]);
  });

  test('the server renders legal pages before the static-file handler', () => {
    const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const legalRoute = "app.get(['/terms.html', '/privacy.html', '/refund.html']";
    expect(serverSource).toContain(legalRoute);
    expect(serverSource.indexOf(legalRoute)).toBeLessThan(serverSource.indexOf("app.use(express.static('public'"));
    for (const file of LEGAL_FILES) {
      expect(serverSource).toContain(`['${file}', fs.readFileSync`);
    }
  });

  test('each translated legal page preserves commercial, retention and refund facts', () => {
    const previousWindow = global.window;
    global.window = {};
    jest.isolateModules(() => require('../../public/i18n/legal-content'));
    const documents = global.window.PromptGenLegalDocuments;
    for (const locale of LOCALES.slice(1)) {
      expect(Object.keys(documents[locale])).toEqual(['terms', 'privacy', 'refund']);
      const terms = documents[locale].terms.html.replace(/[\s,]/g, '');
      const privacy = documents[locale].privacy.html.replace(/[\s,]/g, '');
      const refund = documents[locale].refund.html.replace(/[\s,]/g, '');
      for (const fact of ['1000', '4000', '10', '120']) expect(terms).toContain(fact);
      for (const service of ['Paddle', 'Seedance', 'USD']) expect(terms).toContain(service);
      for (const fact of ['30', '180']) expect(privacy).toContain(fact);
      for (const service of ['Supabase', 'Gemini', 'OpenAI', 'Paddle', 'Railway', 'Cloudflare']) expect(privacy).toContain(service);
      for (const fact of ['1000', '4000', '14']) expect(refund).toContain(fact);
      expect(refund).toContain('https://www.paddle.com/legal/refund-policy');
      for (const html of [terms, privacy, refund]) {
        const disclosure = operatorBlock(html);
        for (const detail of OPERATOR_DETAILS) {
          expect(disclosure).toContain(detail.replace(/[\s,]/g, ''));
        }
        expect(disclosure).toContain('href="mailto:codemeet@naver.com"');
        expect(html).toContain(LEGAL_UPDATED_DATE[locale].replace(/[\s,]/g, ''));
        expect(html).not.toMatch(/<script|onerror=|onload=/i);
      }
    }
    global.window = previousWindow;
  });
});
