'use strict';

(function () {
  const storyboardId = window.location.pathname.split('/').pop();
  let pollTimer = null;
  let currentShots = null;

  async function init() {
    window.addEventListener('scroll', () => {
      document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 10);
    });

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
        showError(data.errorMessage || 'Generation failed.');
        return;
      }

      // Still processing
      showProcessing(data);
      if (!pollTimer) {
        pollTimer = setInterval(checkStatus, 5000);
      }
    } catch (err) {
      showError('Failed to load status. Please refresh.');
    }
  }

  function showProcessing(data) {
    document.getElementById('processingState').style.display = '';
    document.getElementById('errorState').style.display = 'none';
    document.getElementById('resultState').style.display = 'none';

    document.getElementById('processingLabel').textContent = data.stepLabel || 'Processing…';
    const pct = Math.round((data.progress || 0) * 100);
    document.getElementById('progressBar').style.width = `${pct}%`;
    const eta = data.estimatedSecondsRemaining;
    document.getElementById('processingEta').textContent =
      eta > 0 ? `~${eta}s remaining` : 'Almost done…';
  }

  function showError(msg) {
    document.getElementById('processingState').style.display = 'none';
    document.getElementById('errorState').style.display = '';
    document.getElementById('resultState').style.display = 'none';
    document.getElementById('errorMsg').textContent = msg;
  }

  async function loadResult() {
    const data = await StoryboardAPI.getStoryboard(storyboardId);
    if (!data.success) {
      showError('Failed to load storyboard result.');
      return;
    }

    const sb = data.storyboard;
    document.getElementById('processingState').style.display = 'none';
    document.getElementById('errorState').style.display = 'none';
    document.getElementById('resultState').style.display = '';

    // Meta
    const meta = document.getElementById('resultMeta');
    const date = new Date(sb.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    meta.innerHTML = `
      <span class="storyboard-meta-badge">${escapeHtml(sb.style)}</span>
      <span class="storyboard-meta-badge">${sb.cutCount} Shots</span>
      ${(sb.genres || []).map(g => `<span class="storyboard-meta-badge">${escapeHtml(g)}</span>`).join('')}
      <span class="storyboard-meta-date">${date}</span>
    `;

    // Grid image
    if (sb.gridUrl) {
      const img = document.getElementById('gridImage');
      img.src = sb.gridUrl;
      img.alt = `${sb.style} storyboard grid`;
      const dlBtn = document.getElementById('downloadGridBtn');
      dlBtn.style.display = '';
      dlBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          dlBtn.textContent = '⏳ Downloading…';
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
          dlBtn.textContent = '⬇ Download Grid';
          dlBtn.disabled = false;
        }
      });
    }

    // Shots
    const shotList = document.getElementById('shotList');
    shotList.innerHTML = '';
    currentShots = sb.shots || [];

    // Copy All Prompts button (above shot list)
    const copyAllBtn = document.createElement('button');
    copyAllBtn.className = 'btn btn--secondary storyboard-copy-all-btn';
    copyAllBtn.textContent = '📋 Copy All Prompts';
    copyAllBtn.addEventListener('click', () => {
      if (!currentShots || currentShots.length === 0) return;

      const flashFail = () => {
        copyAllBtn.textContent = '복사 실패 — 다시 시도';
        setTimeout(() => { copyAllBtn.textContent = '📋 Copy All Prompts'; }, 2000);
      };

      if (!navigator.clipboard) { flashFail(); return; }

      const text = currentShots.map((shot, i) => {
        const num = shot.shotNumber || (i + 1);
        const angle = shot.cameraAngle ? ` (${shot.cameraAngle})` : '';
        return `--- Shot ${num}${angle} ---\n${(shot.videoPrompt || '').trim()}`;
      }).join('\n\n');

      navigator.clipboard.writeText(text).then(() => {
        copyAllBtn.textContent = '✓ Copied!';
        setTimeout(() => { copyAllBtn.textContent = '📋 Copy All Prompts'; }, 2000);
      }).catch(flashFail);
    });
    shotList.parentElement.insertBefore(copyAllBtn, shotList);

    currentShots.forEach((shot, i) => {
      const item = document.createElement('div');
      item.className = 'storyboard-shot-item';
      item.innerHTML = `
        <div class="storyboard-shot-header">
          <span class="storyboard-shot-num">Shot ${shot.shotNumber || i + 1}</span>
          <span class="storyboard-shot-angle">${escapeHtml(shot.cameraAngle || '')}</span>
          <span class="storyboard-shot-beat">${escapeHtml(shot.narrativeBeat || '')}</span>
        </div>
        <p class="storyboard-shot-desc">${escapeHtml(shot.description || '')}</p>
        <div class="storyboard-shot-prompt-wrap">
          <pre class="storyboard-shot-prompt" id="prompt-${i}">${escapeHtml(shot.videoPrompt || '')}</pre>
          <button class="storyboard-copy-btn" data-target="prompt-${i}" title="Copy prompt">📋 Copy</button>
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
            btn.textContent = '✓ Copied!';
            setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
          });
        }
      });
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
