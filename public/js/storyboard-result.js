'use strict';

(function () {
  const storyboardId = window.location.pathname.split('/').pop();
  let pollTimer = null;
  let currentShots = null;
  let currentStoryboard = null;
  let currentStatus = null;
  let storyboardCost = null;
  let shareState = { active: false, expiresAt: null };
  let currentSharePath = null;
  let shareHandlersBound = false;
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

    // Display-only: insert the configured cost into the refund note.
    // On failure the number-free default text stays (never blank/NaN).
    StoryboardAPI.getConfig().then(cfg => {
      if (cfg && typeof cfg.storyboardCost === 'number') {
        storyboardCost = cfg.storyboardCost;
        const note = document.getElementById('refundNote');
        if (note) note.textContent = uiText('storyboardResult.refundedCredits', { credits: cfg.storyboardCost });
      }
    }).catch(() => {});

    const user = await StoryboardAPI.getCurrentUser();
    if (!user) {
      window.location.href = '/storyboard';
      return;
    }

    await checkStatus();
  }

  async function checkStatus() {
    try {
      const data = await StoryboardAPI.getStatus(storyboardId);

      if (data.status === 'completed') {
        clearInterval(pollTimer);
        await loadResult();
        return;
      }

      if (data.status === 'failed') {
        clearInterval(pollTimer);
        showError(uiText('storyboard.error.generation'));
        return;
      }

      // Still processing
      showProcessing(data);
      if (!pollTimer) {
        pollTimer = setInterval(checkStatus, 5000);
      }
    } catch (err) {
      showError(uiText('storyboardResult.error.status'));
    }
  }

  function showProcessing(data) {
    currentStatus = data;
    document.getElementById('processingState').style.display = '';
    document.getElementById('errorState').style.display = 'none';
    document.getElementById('resultState').style.display = 'none';

    document.getElementById('processingLabel').textContent = uiText(`storyboard.step.${data.currentStep || 'processing'}`);
    const pct = Math.round((data.progress || 0) * 100);
    document.getElementById('progressBar').style.width = `${pct}%`;
    const eta = data.estimatedSecondsRemaining;
    document.getElementById('processingEta').textContent =
      eta > 0 ? uiText('storyboardResult.remaining', { seconds: eta }) : uiText('storyboardResult.almostDone');
  }

  function showError(msg) {
    document.getElementById('processingState').style.display = 'none';
    document.getElementById('errorState').style.display = '';
    document.getElementById('resultState').style.display = 'none';
    document.getElementById('errorMsg').textContent = msg;
  }

  function renderLocalizedResult(sb) {
    const meta = document.getElementById('resultMeta');
    const date = window.PromptGenI18n?.formatDate(new Date(sb.createdAt), { year: 'numeric', month: 'long', day: 'numeric' })
      || new Date(sb.createdAt).toLocaleDateString();
    meta.innerHTML = `
      <span class="storyboard-meta-badge">${escapeHtml(uiText(`storyboard.style.${styleKey(sb.style)}`))}</span>
      <span class="storyboard-meta-badge">${escapeHtml(uiText('storyboard.shots.count', { count: sb.cutCount }))}</span>
      ${(sb.genres || []).map(g => `<span class="storyboard-meta-badge">${escapeHtml(genreLabel(g))}</span>`).join('')}
      <span class="storyboard-meta-date">${date}</span>
    `;

    const img = document.getElementById('gridImage');
    if (img && sb.gridUrl) {
      img.alt = uiText('storyboardResult.gridAltStyle', {
        style: uiText(`storyboard.style.${styleKey(sb.style)}`)
      });
    }
  }

  async function loadResult() {
    const data = await StoryboardAPI.getStoryboard(storyboardId);
    if (!data.success) {
      showError(uiText('storyboardResult.error.load'));
      return;
    }

    const sb = data.storyboard;
    currentStoryboard = sb;
    window.PromptGenStoryboardProgress?.markViewed(storyboardId);
    document.getElementById('processingState').style.display = 'none';
    document.getElementById('errorState').style.display = 'none';
    document.getElementById('resultState').style.display = '';

    renderLocalizedResult(sb);

    // ① My Scenario — textContent (XSS-safe); hidden when absent (older rows)
    if (sb.scenario) {
      document.getElementById('scenarioText').textContent = sb.scenario;
      document.getElementById('scenarioCard').style.display = '';
    }

    // Grid image
    if (sb.gridUrl) {
      const img = document.getElementById('gridImage');
      img.src = sb.gridUrl;
      const dlBtn = document.getElementById('downloadGridBtn');
      dlBtn.style.display = '';
      dlBtn.onclick = async (e) => {
        e.preventDefault();
        try {
          dlBtn.textContent = uiText('common.state.downloading');
          dlBtn.disabled = true;
          const res = await fetch(sb.gridUrl);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `storyboard-${storyboardId}.png`;
          a.click();
          URL.revokeObjectURL(url);
        } finally {
          dlBtn.textContent = uiText('storyboardResult.downloadGrid');
          dlBtn.disabled = false;
        }
      };
    }

    await initializeSharePanel();

    // Shots
    const shotList = document.getElementById('shotList');
    shotList.innerHTML = '';
    currentShots = sb.shots || [];
    shotList.parentElement.querySelector('.storyboard-copy-all-btn')?.remove();

    // Copy All Prompts button (above shot list)
    const copyAllBtn = document.createElement('button');
    copyAllBtn.type = 'button';
    copyAllBtn.className = 'btn btn--secondary storyboard-copy-all-btn';
    copyAllBtn.setAttribute('data-i18n', 'storyboardResult.copyAll');
    copyAllBtn.textContent = uiText('storyboardResult.copyAll');
    copyAllBtn.addEventListener('click', () => {
      if (!currentShots || currentShots.length === 0) return;

      const flashFail = () => {
        copyAllBtn.textContent = uiText('common.error.copy');
        setTimeout(() => { copyAllBtn.textContent = uiText('storyboardResult.copyAll'); }, 2000);
      };

      if (!navigator.clipboard) { flashFail(); return; }

      const text = currentShots.map((shot, i) => {
        const num = shot.shotNumber || (i + 1);
        const angle = shot.cameraAngle ? ` (${shot.cameraAngle})` : '';
        return `- shot ${num}${angle} -\n${(shot.videoPrompt || '').trim()}`;
      }).join('\n\n');

      navigator.clipboard.writeText(text).then(() => {
        copyAllBtn.textContent = uiText('common.state.copied');
        setTimeout(() => { copyAllBtn.textContent = uiText('storyboardResult.copyAll'); }, 2000);
      }).catch(flashFail);
    });
    shotList.parentElement.insertBefore(copyAllBtn, shotList);

    currentShots.forEach((shot, i) => {
      const item = document.createElement('div');
      item.className = 'storyboard-shot-item';
      item.setAttribute('role', 'listitem');
      item.innerHTML = `
        <div class="storyboard-shot-header">
          <span class="storyboard-shot-num" data-i18n="storyboardResult.shotNumber" data-i18n-vars="number:${shot.shotNumber || i + 1}">${escapeHtml(uiText('storyboardResult.shotNumber', { number: shot.shotNumber || i + 1 }))}</span>
          <span class="storyboard-shot-angle">${escapeHtml(shot.cameraAngle || '')}</span>
          <span class="storyboard-shot-beat">${escapeHtml(shot.narrativeBeat || '')}</span>
        </div>
        <p class="storyboard-shot-desc">${escapeHtml(shot.description || '')}</p>
        <div class="storyboard-shot-prompt-wrap">
          <pre class="storyboard-shot-prompt" id="prompt-${i}">${escapeHtml(shot.videoPrompt || '')}</pre>
          <button type="button" class="storyboard-copy-btn" data-target="prompt-${i}" title="${escapeHtml(uiText('gallery.action.copy'))}" data-i18n="common.action.copy" data-i18n-attr="title:gallery.action.copy">${escapeHtml(uiText('common.action.copy'))}</button>
        </div>
      `;
      shotList.appendChild(item);
    });

    // Copy buttons
    shotList.querySelectorAll('.storyboard-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pre = document.getElementById(btn.dataset.target);
        if (pre) {
          navigator.clipboard.writeText(pre.textContent).then(() => {
            btn.textContent = uiText('common.state.copied');
            setTimeout(() => { btn.textContent = uiText('common.action.copy'); }, 2000);
          });
        }
      });
    });
  }

  function formatShareDate(value) {
    const date = new Date(value);
    return window.PromptGenI18n?.formatDate(date, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }) || date.toLocaleDateString();
  }

  function renderSharePanel(messageKey) {
    const consent = document.getElementById('shareConsent');
    const createButton = document.getElementById('createShareBtn');
    const revokeButton = document.getElementById('revokeShareBtn');
    const linkRow = document.getElementById('shareLinkRow');
    const linkInput = document.getElementById('shareLinkInput');
    const status = document.getElementById('shareStatus');
    if (!consent || !createButton || !revokeButton || !linkRow || !linkInput || !status) return;

    createButton.disabled = !consent.checked;
    createButton.textContent = uiText(shareState.active
      ? 'storyboardShare.control.rotate'
      : 'storyboardShare.control.create');
    revokeButton.hidden = !shareState.active;
    linkRow.hidden = !currentSharePath;
    linkInput.value = currentSharePath ? `${window.location.origin}${currentSharePath}` : '';

    if (messageKey) {
      status.textContent = uiText(messageKey, shareState.expiresAt
        ? { date: formatShareDate(shareState.expiresAt) }
        : {});
    } else if (shareState.active) {
      status.textContent = uiText('storyboardShare.control.active', {
        date: formatShareDate(shareState.expiresAt)
      });
    } else {
      status.textContent = '';
    }
  }

  function bindShareHandlers() {
    if (shareHandlersBound) return;
    shareHandlersBound = true;
    const consent = document.getElementById('shareConsent');
    const createButton = document.getElementById('createShareBtn');
    const revokeButton = document.getElementById('revokeShareBtn');
    const copyButton = document.getElementById('copyShareBtn');
    const linkInput = document.getElementById('shareLinkInput');

    consent.addEventListener('change', () => renderSharePanel());

    createButton.addEventListener('click', async () => {
      if (!consent.checked) return;
      createButton.disabled = true;
      createButton.textContent = uiText('storyboardShare.control.creating');
      try {
        const data = await StoryboardAPI.createStoryboardShare(storyboardId);
        if (!data?.success || !data.share?.path) throw new Error(data?.code || 'CREATE_FAILED');
        currentSharePath = data.share.path;
        shareState = {
          active: true,
          expiresAt: data.share.expiresAt,
          createdAt: data.share.createdAt
        };
        consent.checked = false;
        renderSharePanel('storyboardShare.control.created');
      } catch (_) {
        renderSharePanel('storyboardShare.error.create');
      }
    });

    revokeButton.addEventListener('click', async () => {
      if (!window.confirm(uiText('storyboardShare.control.unpublishConfirm'))) return;
      revokeButton.disabled = true;
      try {
        const data = await StoryboardAPI.revokeStoryboardShare(storyboardId);
        if (!data?.success) throw new Error(data?.code || 'REVOKE_FAILED');
        shareState = { active: false, expiresAt: null };
        currentSharePath = null;
        consent.checked = false;
        renderSharePanel('storyboardShare.control.unpublished');
      } catch (_) {
        renderSharePanel('storyboardShare.error.unpublish');
      } finally {
        revokeButton.disabled = false;
      }
    });

    copyButton.addEventListener('click', async () => {
      if (!linkInput.value) return;
      try {
        if (!navigator.clipboard) throw new Error('CLIPBOARD_UNAVAILABLE');
        await navigator.clipboard.writeText(linkInput.value);
        renderSharePanel('storyboardShare.control.copied');
      } catch (_) {
        linkInput.focus();
        linkInput.select();
        renderSharePanel('common.error.copy');
      }
    });
  }

  async function initializeSharePanel() {
    bindShareHandlers();
    try {
      const data = await StoryboardAPI.getStoryboardShareStatus(storyboardId);
      if (!data?.success) throw new Error(data?.code || 'STATUS_FAILED');
      shareState = data.share || { active: false, expiresAt: null };
      if (!shareState.active) currentSharePath = null;
      renderSharePanel();
    } catch (_) {
      renderSharePanel('storyboardShare.error.status');
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('promptgen:localechange', () => {
    if (storyboardCost != null) {
      document.getElementById('refundNote').textContent = uiText('storyboardResult.refundedCredits', { credits: storyboardCost });
    }
    if (currentStatus && !currentStoryboard) showProcessing(currentStatus);
    if (currentStoryboard) {
      // Locale changes are display-only. Re-render from the already loaded
      // storyboard so rapid toggles cannot race overlapping network requests.
      renderLocalizedResult(currentStoryboard);
      renderSharePanel();
    }
  });
})();
