/* ── Gallery Module ── */
(function () {
  'use strict';

  const filtersEl   = document.getElementById('galleryFilters');
  const gridEl      = document.getElementById('galleryGrid');
  const modal       = document.getElementById('galleryModal');
  const modalCat    = document.getElementById('gModalCat');
  const modalTitle  = document.getElementById('gModalTitle');
  const modalPrompt = document.getElementById('gModalPrompt');
  const modalCopyBtn= document.getElementById('gModalCopyBtn');
  const modalClose  = document.getElementById('gModalClose');

  if (!filtersEl || !gridEl) return;

  let activeCategory = 'all';
  let currentModalItem = null;
  const uiText = (key, values) => window.PromptGenI18n?.t(key, values) || key;
  const categoryLabel = (category) => uiText(`gallery.category.${category.id}`);

  /* ── Render Filter Tabs ── */
  function renderFilters() {
    filtersEl.innerHTML = GALLERY_CATEGORIES.map(cat => `
      <button
        class="gallery-filter-btn${cat.id === activeCategory ? ' active' : ''}"
        data-category="${cat.id}"
        type="button"
      >${escapeHtml(categoryLabel(cat))}</button>
    `).join('');

    filtersEl.querySelectorAll('.gallery-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeCategory = btn.dataset.category;
        renderFilters();
        renderCards();
      });
    });
  }

  /* ── Render Cards ── */
  function renderCards() {
    const items = activeCategory === 'all'
      ? GALLERY_DATA
      : GALLERY_DATA.filter(item => item.category === activeCategory);

    if (items.length === 0) {
      gridEl.innerHTML = `<p class="gallery-empty">${escapeHtml(uiText('gallery.empty'))}</p>`;
      return;
    }

    gridEl.innerHTML = items.map(item => {
      const catObj = GALLERY_CATEGORIES.find(c => c.id === item.category);
      const catLabel = catObj ? categoryLabel(catObj) : item.category;
      const shortPrompt = (item.prompt || '').slice(0, 120) + '…';
      return `
      <div class="gallery-card" data-id="${item.id}" tabindex="0" role="button" aria-label="${escapeAttr(uiText('gallery.card.viewPrompt', { title: item.title }))}">
        <div class="gallery-card__thumb">
          <img
            src="${escapeAttr(item.image)}"
            alt="${escapeAttr(item.title)}"
            class="gallery-card__img"
            loading="lazy"
            onerror="this.closest('.gallery-card__thumb').classList.add('img-error')"
          />
          <div class="gallery-card__overlay">
            <p class="gallery-card__preview">${escapeHtml(shortPrompt)}</p>
            <span class="gallery-card__cta">${escapeHtml(uiText('gallery.card.viewFull'))}</span>
          </div>
          <span class="gallery-card__badge">${escapeHtml(catLabel)}</span>
        </div>
        <div class="gallery-card__footer">
          <span class="gallery-card__title">${escapeHtml(item.title)}</span>
          <button class="gallery-card__copy-mini" data-id="${item.id}" title="${escapeAttr(uiText('gallery.action.copy'))}" aria-label="${escapeAttr(uiText('gallery.action.copy'))}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </div>
    `;
    }).join('');

    /* Card click → modal */
    gridEl.querySelectorAll('.gallery-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.gallery-card__copy-mini')) return;
        const item = GALLERY_DATA.find(d => d.id === +card.dataset.id);
        if (item) openModal(item);
      });
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          card.click();
        }
      });
    });

    /* Mini copy button */
    gridEl.querySelectorAll('.gallery-card__copy-mini').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const item = GALLERY_DATA.find(d => d.id === +btn.dataset.id);
        if (item) copyText(item.prompt, btn);
      });
    });
  }

  /* ── Modal ── */
  function openModal(item) {
    const catObj = GALLERY_CATEGORIES.find(c => c.id === item.category);
    currentModalItem = item;
    modalCat.textContent    = catObj ? categoryLabel(catObj) : item.category;
    modalTitle.textContent  = item.title;
    modalPrompt.textContent = item.prompt;
    modalCopyBtn.dataset.prompt = item.prompt;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    modalClose.focus();
  }

  function closeModal() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    currentModalItem = null;
  }

  if (modalClose) modalClose.addEventListener('click', closeModal);

  modal && modal.addEventListener('click', e => {
    if (e.target === modal) closeModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) closeModal();
  });

  /* ── Copy Button (modal) ── */
  modalCopyBtn && modalCopyBtn.addEventListener('click', () => {
    copyText(modalCopyBtn.dataset.prompt, modalCopyBtn);
  });

  /* ── Helpers ── */
  function copyText(text, triggerEl) {
    navigator.clipboard.writeText(text).then(() => {
      const orig = triggerEl.innerHTML;
      triggerEl.innerHTML = triggerEl === modalCopyBtn
        ? uiText('common.state.copied')
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      triggerEl.classList.add('copied');
      setTimeout(() => {
        triggerEl.innerHTML = orig;
        triggerEl.classList.remove('copied');
      }, 1800);
    }).catch(() => {
      /* fallback for older browsers */
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── Init ── */
  renderFilters();
  renderCards();
  document.addEventListener('promptgen:localechange', () => {
    renderFilters();
    renderCards();
    if (currentModalItem) openModal(currentModalItem);
  });
})();
