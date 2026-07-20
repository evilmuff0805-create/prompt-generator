'use strict';

(function () {
  const tabs = [...document.querySelectorAll('[data-hero-storyboard-tab]')];
  if (!tabs.length) return;

  function activate(tab, { focus = false } = {}) {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      const panel = document.getElementById(candidate.getAttribute('aria-controls'));

      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      if (panel) panel.hidden = !selected;
    }

    if (focus) tab.focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      let nextIndex = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === null) return;

      event.preventDefault();
      activate(tabs[nextIndex], { focus: true });
    });
  });
})();
