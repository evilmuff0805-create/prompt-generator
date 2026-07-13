'use strict';

(function () {
  let currentUser = null;
  let _rendering = false;
  let _pendingRender = false;
  // Storyboard credit cost for display. Safe default matches the backend env
  // fallback; overwritten by /api/storyboard/config so env changes need no deploy.
  let storyboardCost = 120;

  async function loadConfig() {
    const cfg = await StoryboardAPI.getConfig();
    if (cfg && typeof cfg.storyboardCost === 'number') {
      storyboardCost = cfg.storyboardCost;
      document.querySelectorAll('.sb-cost-value').forEach(el => {
        el.textContent = String(storyboardCost);
      });
    }
    // On failure the static "120" defaults stay — no blanks, no NaN.
  }

  async function init() {
    loadConfig(); // fire-and-forget: display-only, must not block first render

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

    async function startStoryboardSignIn() {
      window.PromptGenAnalytics?.track('signup_started', {
        surface: 'storyboard',
        provider: 'google'
      });
      await StoryboardAPI.signInWithGoogle();
    }

    // Login button
    document.getElementById('loginBtn')?.addEventListener('click', startStoryboardSignIn);
    document.getElementById('googleLoginBtn')?.addEventListener('click', startStoryboardSignIn);
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
          errorBanner.textContent = '프로필을 불러오지 못했습니다. 페이지를 새로고침해 주세요.';
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

    const planLabels = { free: 'Free', pro: 'Pro', enterprise: 'Enterprise', paid: 'Pro' };
    const planKey = (profile.plan || 'free').toLowerCase();
    if (nameEl) nameEl.textContent = profile.user?.full_name || profile.user?.email || '';
    if (badgeEl) {
      badgeEl.textContent = planLabels[planKey] || 'Free';
      const badgeClass = planKey === 'enterprise' ? 'enterprise' : (planKey === 'free' ? 'free' : 'pro');
      badgeEl.className = `plan-badge plan-badge--${badgeClass}`;
    }
    if (usageEl) {
      const totals = { enterprise: 4000, pro: 1000, paid: 1000 };
      const total = totals[planKey] || 0;
      usageEl.textContent = total > 0
        ? `Credits: ${(profile.credits || 0).toLocaleString()} / ${total.toLocaleString()}`
        : `Today ${profile.daily_used ?? 0}/1 used`;
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

    const result = await StoryboardAPI.generateStoryboard(formData);
    if (!result.success) console.error('[storyboard] generate error:', JSON.stringify(result));

    if (!result.success) {
      const messages = {
        PLAN_NOT_ALLOWED: 'Your plan does not allow Storyboard generation.',
        INSUFFICIENT_CREDITS: `Not enough credits. Storyboard requires ${storyboardCost} credits.`,
        RATE_LIMITED: 'Please wait 60 seconds between requests.',
        TOO_MANY_CONCURRENT_JOBS: 'You already have the maximum number of jobs running.',
        MODERATION_REJECTED: 'Your scenario was flagged by our safety system. Please revise it.',
        INVALID_INPUT: result.errors?.join(', ') || result.message || 'Invalid input.',
        REFERENCE_EXPIRED_SOON: 'One or more reference images are about to expire. Please re-upload them.'
      };
      const msg = messages[result.code] || result.message || 'Generation failed. Please try again.';
      errorBanner.textContent = msg;
      errorBanner.style.display = 'block';
      return;
    }

    // Redirect to result page
    window.location.href = `/storyboard/${result.storyboard.id}`;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
