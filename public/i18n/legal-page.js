(function () {
  'use strict';

  const page = document.body.dataset.legalPage;
  const container = document.getElementById('legalDocument');
  if (!page || !container) return;

  const initialEnglishHtml = container.innerHTML;
  const initialEnglishTitle = document.title;

  function renderLegalPage() {
    const locale = window.PromptGenI18n?.getLocale() || 'en';
    if (locale === 'en') {
      document.title = initialEnglishTitle;
      container.innerHTML = initialEnglishHtml;
      return;
    }

    const documentData = window.PromptGenLegalDocuments?.[locale]?.[page];
    if (!documentData) {
      document.title = initialEnglishTitle;
      container.innerHTML = initialEnglishHtml;
      return;
    }
    document.title = documentData.title;
    container.innerHTML = documentData.html;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderLegalPage);
  } else {
    renderLegalPage();
  }
  document.addEventListener('promptgen:localechange', renderLegalPage);
})();
