'use strict';

(function () {
  const token = window.location.pathname.split('/').filter(Boolean).pop() || '';
  const uiText = (key, values) => window.PromptGenI18n?.t(key, values) || key;
  const styleKey = (style) => ({
    'Pixar 3D': 'pixar',
    Cinematic: 'cinematic',
    Documentary: 'documentary',
    Animation: 'animation'
  }[style] || 'cinematic');
  let sharedStoryboard = null;

  function formatDate(value) {
    const date = new Date(value);
    return window.PromptGenI18n?.formatDate(date, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }) || date.toLocaleDateString();
  }

  function render() {
    if (!sharedStoryboard) return;
    const meta = document.getElementById('shareMeta');
    meta.textContent = '';

    const values = [
      uiText(`storyboard.style.${styleKey(sharedStoryboard.style)}`),
      uiText('storyboard.shots.count', { count: sharedStoryboard.cutCount }),
      formatDate(sharedStoryboard.createdAt)
    ];
    values.forEach((value, index) => {
      const item = document.createElement('span');
      item.className = index === values.length - 1 ? 'storyboard-meta-date' : 'storyboard-meta-badge';
      item.textContent = value;
      meta.appendChild(item);
    });

    document.getElementById('shareExpiryText').textContent = uiText(
      'storyboardShare.expires',
      { date: formatDate(sharedStoryboard.expiresAt) }
    );
    document.getElementById('shareGridImage').alt = uiText('storyboardShare.gridAltStyle', {
      style: uiText(`storyboard.style.${styleKey(sharedStoryboard.style)}`)
    });
  }

  function showUnavailable() {
    document.getElementById('shareLoading').hidden = true;
    document.getElementById('shareResult').hidden = true;
    document.getElementById('shareError').hidden = false;
  }

  async function load() {
    try {
      const response = await fetch(`/api/share/${encodeURIComponent(token)}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) return showUnavailable();
      const data = await response.json();
      if (!data?.success || !data.storyboard?.imagePath) return showUnavailable();

      sharedStoryboard = data.storyboard;
      const image = document.getElementById('shareGridImage');
      image.addEventListener('error', showUnavailable, { once: true });
      image.src = sharedStoryboard.imagePath;
      render();
      document.getElementById('shareLoading').hidden = true;
      document.getElementById('shareError').hidden = true;
      document.getElementById('shareResult').hidden = false;
    } catch (_) {
      showUnavailable();
    }
  }

  document.addEventListener('DOMContentLoaded', load);
  document.addEventListener('promptgen:localechange', render);
})();
