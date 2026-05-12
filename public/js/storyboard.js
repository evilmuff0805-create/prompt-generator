'use strict';

(function () {
  let currentUser = null;
  let _rendering = false;
  let _pendingRender = false;

  async function init() {
    // Navbar scroll
    window.addEventListener('scroll', () => {
      document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 10);
    });

    // Auth state
    StoryboardAPI.onAuthStateChange(async (event, session) => {
      currentUser = session?.user || null;
      await renderAuthState();
    });

    // Initial auth check
    currentUser = await StoryboardAPI.getCurrentUser();
    await renderAuthState();

    // Login button
    document.getElementById('loginBtn')?.addEventListener('click', () => StoryboardAPI.signInWithGoogle());
    document.getElementById('googleLoginBtn')?.addEventListener('click', () => StoryboardAPI.signInWithGoogle());
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
      const mainForm = document.getElementById('mainForm');
      const creditsDisplay = document.getElementById('creditsDisplay');
      const errorBanner = document.getElementById('errorBanner');

      if (!currentUser) {
        authGate.style.display = '';
        planGate.style.display = 'none';
        mainForm.style.display = 'none';
        return;
      }

      let profile = null;
      try {
        const fetchTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
        profile = await Promise.race([StoryboardAPI.getUserProfile(), fetchTimeout]);
      } catch {
        authGate.style.display = 'none';
        planGate.style.display = 'none';
        mainForm.style.display = 'none';
        if (errorBanner) {
          errorBanner.textContent = '프로필을 불러오지 못했습니다. 페이지를 새로고침해 주세요.';
          errorBanner.style.display = '';
        }
        return;
      }

      const allowedPlans = ['pro', 'enterprise', 'paid'];
      const planOk = profile && allowedPlans.includes((profile.plan || 'free').toLowerCase());

      if (!planOk) {
        authGate.style.display = 'none';
        planGate.style.display = '';
        mainForm.style.display = 'none';
        return;
      }

      authGate.style.display = 'none';
      planGate.style.display = 'none';
      mainForm.style.display = '';

      if (errorBanner) errorBanner.style.display = 'none';

      if (creditsDisplay && profile) {
        creditsDisplay.textContent = `${profile.credits.toLocaleString()} credits available`;
      }
    } finally {
      _rendering = false;
      if (_pendingRender) { _pendingRender = false; renderAuthState(); }
    }
  }

  async function handleGenerate(formData) {
    const errorBanner = document.getElementById('errorBanner');

    const result = await StoryboardAPI.generateStoryboard(formData);
    if (!result.success) console.error('[storyboard] generate error:', JSON.stringify(result));

    if (!result.success) {
      const messages = {
        PLAN_NOT_ALLOWED: 'Your plan does not allow Storyboard generation.',
        INSUFFICIENT_CREDITS: 'Not enough credits. Storyboard requires 250 credits.',
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
