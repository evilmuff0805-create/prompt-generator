const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('authenticated navbar account menu contract', () => {
  test('keeps the locale switcher global while grouping account actions behind one trigger', () => {
    const html = read('public/index.html');

    expect(html).toContain('id="accountMenuTrigger"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-controls="accountMenu"');
    expect(html).toContain('data-i18n-attr="aria-label:nav.action.accountMenu"');
    expect(html).toContain('id="accountMenu" class="account-menu" role="menu"');
    expect(html).toMatch(/id="accountMenu"[\s\S]*id="usageDisplay"[\s\S]*id="historyBtn"[\s\S]*id="manageSubBtn"[\s\S]*id="logoutBtn"/);
    expect(html).not.toContain('id="promptgenLocaleSelect"');
  });

  test('preserves subscription and logout handlers and adds keyboard-safe menu state', () => {
    const app = read('public/app.js');

    expect(app).toContain("manageSubBtn.addEventListener('click'");
    expect(app).toContain("logoutBtn.addEventListener('click'");
    expect(app).toContain('function setAccountMenuOpen');
    expect(app).toContain("accountMenuTrigger.setAttribute('aria-expanded', String(isOpen))");
    expect(app).toContain("event.key === 'Escape' && !accountMenu.hidden");
    expect(app).toContain("if (link.id === 'accountMenuTrigger') return;");
  });

  test('uses a bounded liquid-glass popover and a mobile in-flow fallback', () => {
    const css = read('public/style.css');

    expect(css).toMatch(/\.account-menu__trigger\s*\{[\s\S]*max-width:\s*176px/);
    expect(css).toMatch(/\.account-menu\s*\{[\s\S]*width:\s*min\(274px, calc\(100vw - 2rem\)\)/);
    expect(css).toContain('backdrop-filter: blur(24px) saturate(150%);');
    expect(css).toMatch(/@media \(max-width: 1040px\)[\s\S]*\.account-menu\s*\{[\s\S]*position:\s*static/);
  });
});
