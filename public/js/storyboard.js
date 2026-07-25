'use strict';

(function () {
  const uiText = (key, values) => window.PromptGenI18n?.t(key, values) || key;
  let currentUser = null;
  let _rendering = false;
  let _pendingRender = false;
  // Safe static fallback; overwritten by /api/storyboard/config.
  let storyboardCreditPolicy = {
    baseCost: 30,
    perReferenceCost: 5,
    maxReferences: 4,
    minCost: 30,
    maxCost: 50
  };
  let productCatalog = null;
  let lastProfile = null;

  async function loadConfig() {
    const cfg = await StoryboardAPI.getConfig();
    if (cfg && typeof cfg.storyboardCost === 'number') {
      storyboardCreditPolicy = {
        ...storyboardCreditPolicy,
        ...(cfg.storyboardCreditPolicy || cfg.catalog?.storyboardCreditPolicy || {}),
        baseCost: cfg.storyboardCreditPolicy?.baseCost
          || cfg.catalog?.storyboardCreditPolicy?.baseCost
          || cfg.storyboardCost
      };
      productCatalog = cfg.catalog || null;
      StoryboardForm.setCreditPolicy(storyboardCreditPolicy);
      window.PromptGenI18n?.apply(document);
    }
    // On failure the static 30 + 5/reference fallback remains usable.
  }

  async function init() {
    await loadConfig();

    // Navbar scroll
    window.addEventListener('scroll', () => {
      document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 10);
    });

    // Auth state — onAuthStateChange fires INITIAL_SESSION on subscribe, so it
    // drives the first render too (no separate getCurrentUser round-trip, no
    // duplicate render). currentUser comes from the local session.
    StoryboardAPI.onAuthStateChange(async (event, session) => {
      currentUser = session?.user || null;
      window.PromptGenAnalytics?.setAuthToken(session?.access_token || null);
      if (event === 'SIGNED_IN') {
        window.PromptGenAnalytics?.track('auth_completed', {
          surface: 'storyboard',
          provider: 'google'
        });
      }
      await renderAuthState();
    });

    StoryboardAPI.mountGoogleSignIn({
      buttonIds: ['loginBtn', 'googleLoginBtn'],
      surface: 'storyboard'
    });

    document.getElementById('modalClose')?.addEventListener('click', () => {
      document.getElementById('loginModal').setAttribute('aria-hidden', 'true');
    });

    // Form submit
    StoryboardForm.initForm({ onSubmit: handleGenerate });
  }

  async function renderAuthState() {
    if (_rendering) { _pendingRender = true; return; }
    _rendering = true;
    _pendingRender = false;
    try {
      const authGate = document.getElementById('authGate');
      const planGate = document.getElementById('planGate');
      const loadingGate = document.getElementById('loadingGate');
      const mainForm = document.getElementById('mainForm');
      const creditsDisplay = document.getElementById('creditsDisplay');
      const errorBanner = document.getElementById('errorBanner');

      const hideAll = () => {
        authGate.style.display = 'none';
        planGate.style.display = 'none';
        if (loadingGate) loadingGate.style.display = 'none';
        mainForm.style.display = 'none';
        if (creditsDisplay) creditsDisplay.style.display = 'none';
      };

      if (!currentUser) {
        hideAll();
        authGate.style.display = '';
        return;
      }

      // Optimistic render: show a lightweight loading skeleton immediately while
      // the profile (plan + credits) loads in the background — no blank screen.
      hideAll();
      if (loadingGate) loadingGate.style.display = '';

      let profile = null;
      try {
        const fetchTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
        profile = await Promise.race([StoryboardAPI.getUserProfile(), fetchTimeout]);
      } catch {
        hideAll();
        if (errorBanner) {
          errorBanner.textContent = uiText('account.error.profile');
          errorBanner.style.display = '';
        }
        return;
      }

      const allowedPlans = ['pro', 'enterprise', 'paid'];
      const planOk = profile && allowedPlans.includes((profile.plan || 'free').toLowerCase());

      if (!planOk) {
        hideAll();
        planGate.style.display = '';
        return;
      }

      // Profile resolved and plan allowed — reveal the form with accurate credits.
      hideAll();
      mainForm.style.display = '';

      if (errorBanner) errorBanner.style.display = 'none';

      renderUserChip(profile);
    } finally {
      _rendering = false;
      if (_pendingRender) { _pendingRender = false; renderAuthState(); }
    }
  }

  // Fill the header user chip — same rendering rules as app.js refreshUserProfile
  // (name, plan badge label/class, "Credits: N / total") for cross-page consistency.
  function renderUserChip(profile) {
    const chip = document.getElementById('creditsDisplay');
    if (!chip || !profile) return;
    const nameEl = document.getElementById('sbUserName');
    const badgeEl = document.getElementById('sbPlanBadge');
    const usageEl = document.getElementById('sbUsageDisplay');

    const planKey = (profile.plan || 'free').toLowerCase();
    const catalogKey = planKey === 'paid' ? 'pro' : planKey;
    const catalogPlan = productCatalog?.plans?.[catalogKey] || null;
    lastProfile = profile;
    if (nameEl) nameEl.textContent = profile.user?.full_name || profile.user?.email || '';
    if (badgeEl) {
      badgeEl.textContent = uiText(`pricing.plan.${catalogKey}.name`);
      const badgeClass = planKey === 'enterprise' ? 'enterprise' : (planKey === 'free' ? 'free' : 'pro');
      badgeEl.className = `plan-badge plan-badge--${badgeClass}`;
    }
    if (usageEl) {
      const total = Number(catalogPlan?.credits) || 0;
      usageEl.textContent = total > 0
        ? uiText('account.credits.remainingOfTotal', {
            remaining: window.PromptGenI18n?.formatNumber(profile.credits || 0) || profile.credits || 0,
            total: window.PromptGenI18n?.formatNumber(total) || total
          })
        : uiText('account.dailyUsage', { used: profile.daily_used ?? 0, total: 1 });
    }
    chip.style.display = 'inline-flex';
  }

  async function handleGenerate(formData) {
    const errorBanner = document.getElementById('errorBanner');
    const token = await StoryboardAPI.getAuthToken();
    window.PromptGenAnalytics?.setAuthToken(token);
    window.PromptGenAnalytics?.track('storyboard_started', {
      style: formData.style,
      cutCount: formData.cutCount,
      referenceCount: formData.referenceImageIds.length
    });

    const actualCost = storyboardCreditPolicy.baseCost
      + (formData.referenceImageIds.length * storyboardCreditPolicy.perReferenceCost);
    const result = await StoryboardAPI.generateStoryboard(formData);
    if (!result.success) console.error('[storyboard] generate error:', JSON.stringify(result));

    if (!result.success) {
      const messages = {
        PLAN_NOT_ALLOWED: uiText('storyboard.error.plan'),
        INSUFFICIENT_CREDITS: uiText('storyboard.error.credits', { credits: actualCost }),
        RATE_LIMITED: uiText('storyboard.error.rateLimit'),
        TOO_MANY_CONCURRENT_JOBS: uiText('storyboard.error.concurrent'),
        MODERATION_REJECTED: uiText('storyboard.error.moderation'),
        INVALID_INPUT: uiText('storyboard.error.invalidInput'),
        REFERENCE_EXPIRED_SOON: uiText('storyboard.error.referencesExpiring')
      };
      const msg = messages[result.code] || uiText('storyboard.error.generation');
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
      return;
    }

    // Redirect to result page
    window.location.href = `/storyboard/${result.storyboard.id}`;
  }

  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('promptgen:localechange', () => {
    if (lastProfile) renderUserChip(lastProfile);
  });
})();
