'use strict';

(function () {
  const MAX_REFS = 4;
  const refImages = []; // { id, previewUrl, expiresAt, name }
  const uiText = (key, values) => window.PromptGenI18n?.t(key, values) || key;

  function initUpload({ onRefsChange }) {
    const uploadBtn = document.getElementById('refUploadBtn');
    const fileInput = document.getElementById('refFileInput');
    const refList = document.getElementById('refList');

    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      fileInput.value = '';

      for (const file of files) {
        if (refImages.length >= MAX_REFS) {
          showUploadError(uiText('storyboard.references.error.max'));
          break;
        }

        const itemEl = addPendingItem(file.name);

        try {
          const result = await StoryboardAPI.uploadReference(file);
          if (result.success) {
            refImages.push({
              id: result.referenceImage.id,
              previewUrl: result.referenceImage.previewUrl,
              expiresAt: result.referenceImage.expiresAt,
              name: file.name
            });
            updateItem(itemEl, result.referenceImage.previewUrl, result.referenceImage.id);
            onRefsChange(refImages.map(r => r.id));
          } else {
            itemEl.remove();
            showUploadError(uiText('storyboard.references.error.upload'));
          }
        } catch (err) {
          itemEl.remove();
          showUploadError(uiText('storyboard.references.error.connection'));
        }

        updateUploadBtn();
      }
    });

    function addPendingItem(name) {
      const li = document.createElement('li');
      li.className = 'storyboard-ref-item storyboard-ref-item--loading';
      li.innerHTML = `<span class="storyboard-ref-name">${escapeHtml(name)}</span><span class="storyboard-ref-uploading">${escapeHtml(uiText('storyboard.references.uploading'))}</span>`;
      refList.appendChild(li);
      return li;
    }

    function updateItem(li, previewUrl, refId) {
      li.className = 'storyboard-ref-item';
      li.dataset.refId = refId;
      li.innerHTML = `
        <img class="storyboard-ref-thumb" src="${escapeHtml(previewUrl)}" alt="${escapeHtml(uiText('storyboard.references.alt'))}" />
        <span class="storyboard-ref-name">${escapeHtml(uiText('storyboard.references.item', { number: refImages.length }))}</span>
        <button type="button" class="storyboard-ref-remove" data-ref-id="${escapeHtml(refId)}" aria-label="${escapeHtml(uiText('storyboard.references.remove'))}">✕</button>
      `;
      li.querySelector('.storyboard-ref-remove').addEventListener('click', () => {
        const idx = refImages.findIndex(r => r.id === refId);
        if (idx !== -1) refImages.splice(idx, 1);
        li.remove();
        updateUploadBtn();
        onRefsChange(refImages.map(r => r.id));
      });
    }

    function updateUploadBtn() {
      uploadBtn.disabled = refImages.length >= MAX_REFS;
      uploadBtn.textContent = refImages.length >= MAX_REFS
        ? uiText('storyboard.references.maxAdded')
        : uiText('storyboard.references.add');
    }

    function showUploadError(msg) {
      const banner = document.getElementById('errorBanner');
      if (banner) {
        banner.textContent = msg;
        banner.style.display = 'block';
        setTimeout(() => { banner.style.display = 'none'; }, 5000);
      }
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  window.StoryboardUpload = { initUpload };
})();
