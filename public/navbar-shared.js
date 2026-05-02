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
      const isActive =
        (href === '/' && (path === '/' || path === '')) ||
        (href !== '/' && path.startsWith(href));
      tab.classList.toggle('tool-tab--active', isActive);
    });

    // PromptGen 전용 Context 링크 (Home, How it Works, Gallery, Pricing)
    // 툴 페이지 (/frame 등)에서는 숨김
    if (path !== '/' && path !== '') {
      const contextMenu = document.getElementById('navMenu');
      if (contextMenu) contextMenu.style.display = 'none';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToolTabs);
  } else {
    initToolTabs();
  }
})();
