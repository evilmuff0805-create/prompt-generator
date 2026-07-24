'use strict';

(function () {
  const uiText = (key, values) => window.PromptGenI18n?.t(key, values) || key;
  let selectedGenres = [];
  let selectedStyle = 'Pixar 3D';
  let selectedCuts = 9;
  let referenceImageIds = [];
  let creditPolicy = { baseCost: 30, perReferenceCost: 5, maxReferences: 4 };

  function updateCostBadge() {
    const badge = document.getElementById('storyboardCostBadge');
    if (!badge) return;
    const referenceCount = referenceImageIds.length;
    const total = creditPolicy.baseCost + (referenceCount * creditPolicy.perReferenceCost);
    badge.textContent = referenceCount > 0
      ? uiText('storyboard.cost.withReferences', {
          total,
          base: creditPolicy.baseCost,
          references: referenceCount,
          referenceCredits: creditPolicy.perReferenceCost
        })
      : uiText('storyboard.cost.credits', { credits: total });
  }

  function setCreditPolicy(nextPolicy = {}) {
    creditPolicy = { ...creditPolicy, ...nextPolicy };
    updateCostBadge();
  }

  function initForm({ onSubmit }) {
    const form = document.getElementById('storyboardForm');
    const scenario = document.getElementById('scenario');
    const charCount = document.getElementById('charCount');
    const generateBtn = document.getElementById('generateBtn');

    // Char counter
    scenario.addEventListener('input', () => {
      charCount.textContent = scenario.value.length;
      validateForm();
    });

    // Genre selection
    document.getElementById('genreGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('.storyboard-genre-btn');
      if (!btn) return;
      const genre = btn.dataset.genre;
      if (selectedGenres.includes(genre)) {
        selectedGenres = selectedGenres.filter(g => g !== genre);
        btn.classList.remove('storyboard-genre-btn--active');
        btn.setAttribute('aria-pressed', 'false');
      } else if (selectedGenres.length < 3) {
        selectedGenres.push(genre);
        btn.classList.add('storyboard-genre-btn--active');
        btn.setAttribute('aria-pressed', 'true');
      }
      validateForm();
    });

    // Style selection
    document.getElementById('styleGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('.storyboard-style-btn');
      if (!btn) return;
      document.querySelectorAll('.storyboard-style-btn').forEach(b => {
        b.classList.remove('storyboard-style-btn--active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('storyboard-style-btn--active');
      btn.setAttribute('aria-pressed', 'true');
      selectedStyle = btn.dataset.style;
    });

    // Cut count selection
    document.querySelectorAll('.storyboard-cut-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.storyboard-cut-btn').forEach(b => {
          b.classList.remove('storyboard-cut-btn--active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('storyboard-cut-btn--active');
        btn.setAttribute('aria-pressed', 'true');
        selectedCuts = parseInt(btn.dataset.cuts, 10);
      });
    });

    // Reference upload integration
    StoryboardUpload.initUpload({
      onRefsChange: (ids) => {
        referenceImageIds = ids;
        updateCostBadge();
      }
    });
    updateCostBadge();
    document.addEventListener('promptgen:localechange', updateCostBadge);

    // Form submit
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateForm()) return;

      generateBtn.disabled = true;
      generateBtn.textContent = uiText('storyboard.state.generating');
      document.getElementById('errorBanner').style.display = 'none';

      try {
        await onSubmit({
          scenario: scenario.value.trim(),
          genres: selectedGenres,
          style: selectedStyle,
          cutCount: selectedCuts,
          referenceImageIds
        });
      } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = uiText('storyboard.action.generate');
      }
    });

    function validateForm() {
      const ok = scenario.value.trim().length >= 50 && selectedGenres.length >= 1;
      generateBtn.disabled = !ok;
      return ok;
    }
  }

  window.StoryboardForm = { initForm, setCreditPolicy };
})();
