/**
 * navbar-shared.js
 * 모든 툴 페이지에서 공유하는 최소한의 navbar 기능:
 * - 툴 탭 active 상태 표시
 * - Context 링크 (Home/Gallery 등) 를 툴 페이지에서 숨김
 * 스크롤 효과와 햄버거는 각 페이지의 JS가 처리 (app.js / frame.js)
 */
(function () {
  'use strict';

  function initToolTabs() {
    const path = window.location.pathname;

    // 툴 탭 active 클래스 적용
    document.querySelectorAll('.tool-tab').forEach(function (tab) {
      const href = tab.getAttribute('href');
      const isActive = href !== '/' && path.startsWith(href);
      tab.classList.toggle('tool-tab--active', isActive);
    });

    // Landing context links (Home, Pipeline, Pricing) stay on the landing only.
    // Keep authentication/account controls available on every tool page.
    if (path !== '/' && path !== '') {
      const contextMenu = document.getElementById('navMenu');
      if (contextMenu) {
        contextMenu.querySelector('.navbar__menu-intro')?.setAttribute('hidden', '');
        contextMenu.querySelectorAll('.nav-link:not(#loginNavBtn)').forEach(function (link) {
          link.closest('li')?.setAttribute('hidden', '');
        });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToolTabs);
  } else {
    initToolTabs();
  }
})();
