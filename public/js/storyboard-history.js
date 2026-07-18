'use strict';

(function () {
  let currentPage = 1;
  const LIMIT = 12;
  let currentItems = [];
  let currentTotal = 0;
  const uiText = (key, values) => window.PromptGenI18n?.t(key, values) || key;
  const genreLabel = (genre) => uiText(`storyboard.genre.${String(genre).toLowerCase().replace(/[^a-z]/g, '')}`);
  const styleKey = (style) => ({
    'Pixar 3D': 'pixar',
    Cinematic: 'cinematic',
    Documentary: 'documentary',
    Animation: 'animation'
  }[style] || 'cinematic');

  async function init() {
    window.addEventListener('scroll', () => {
      document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 10);
    });

    const user = await StoryboardAPI.getCurrentUser();
    if (!user) {
      window.location.href = '/storyboard';
      return;
    }

    await loadPage(1);

    document.getElementById('prevPage').addEventListener('click', () => loadPage(currentPage - 1));
    document.getElementById('nextPage').addEventListener('click', () => loadPage(currentPage + 1));
  }

  async function loadPage(page) {
    document.getElementById('historyLoading').style.display = '';
    document.getElementById('historyGrid').style.display = 'none';
    document.getElementById('historyEmpty').style.display = 'none';
    document.getElementById('historyPagination').style.display = 'none';

    try {
      const data = await StoryboardAPI.listStoryboards({ page, limit: LIMIT });
      document.getElementById('historyLoading').style.display = 'none';

      if (!data.success || !data.items || data.items.length === 0) {
        document.getElementById('historyEmpty').style.display = '';
        return;
      }

      currentPage = page;
      currentItems = data.items;
      currentTotal = data.total;
      renderGrid(data.items);
      renderPagination(data.total, page);
    } catch (err) {
      document.getElementById('historyLoading').style.display = 'none';
      document.getElementById('historyEmpty').style.display = '';
    }
  }

  function renderGrid(items) {
    const grid = document.getElementById('historyGrid');
    grid.innerHTML = '';
    grid.style.display = '';

    items.forEach(sb => {
      const card = document.createElement('div');
      card.className = 'storyboard-history-card';
      card.setAttribute('role', 'listitem');
      const date = window.PromptGenI18n?.formatDate(new Date(sb.created_at), { month: 'short', day: 'numeric', year: 'numeric' })
        || new Date(sb.created_at).toLocaleDateString();
      const statusClass = `storyboard-status--${sb.status}`;
      card.innerHTML = `
        <a href="/storyboard/${sb.id}" class="storyboard-history-card-link">
          ${sb.thumbnailUrl
            ? `<img class="storyboard-history-thumb" src="${escapeHtml(sb.thumbnailUrl)}" alt="${escapeHtml(uiText('nav.tool.storyboard'))}" loading="lazy" />`
            : `<div class="storyboard-history-thumb storyboard-history-thumb--placeholder">${sb.status === 'processing' ? '⏳' : sb.status === 'failed' ? '❌' : '📽️'}</div>`
          }
          <div class="storyboard-history-info">
            <div class="storyboard-history-meta">
              <span class="storyboard-meta-badge">${escapeHtml(uiText(`storyboard.style.${styleKey(sb.style)}`))}</span>
              <span class="storyboard-meta-badge">${escapeHtml(uiText('storyboard.shots.count', { count: sb.cut_count || 9 }))}</span>
              <span class="storyboard-status-badge ${statusClass}">${escapeHtml(uiText(`storyboard.status.${sb.status}`))}</span>
            </div>
            <div class="storyboard-history-genres">${(sb.genres || []).map(g => escapeHtml(genreLabel(g))).join(', ')}</div>
            <div class="storyboard-history-date">${date}</div>
          </div>
        </a>
        <button type="button" class="storyboard-delete-btn" data-id="${escapeHtml(sb.id)}" title="${escapeHtml(uiText('storyboardHistory.delete'))}" aria-label="${escapeHtml(uiText('storyboardHistory.delete'))}">🗑️</button>
      `;

      card.querySelector('.storyboard-delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(uiText('storyboardHistory.deleteConfirm'))) return;
        await StoryboardAPI.deleteStoryboard(sb.id);
        card.remove();
      });

      grid.appendChild(card);
    });
  }

  function renderPagination(total, page) {
    const totalPages = Math.ceil(total / LIMIT);
    if (totalPages <= 1) return;

    document.getElementById('historyPagination').style.display = '';
    document.getElementById('pageInfo').textContent = uiText('storyboardHistory.pageInfo', { page, totalPages });
    document.getElementById('prevPage').disabled = page <= 1;
    document.getElementById('nextPage').disabled = page >= totalPages;
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('promptgen:localechange', () => {
    if (currentItems.length) {
      renderGrid(currentItems);
      renderPagination(currentTotal, currentPage);
    }
  });
})();
