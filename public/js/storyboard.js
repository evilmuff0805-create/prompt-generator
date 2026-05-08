'use strict';

(function () {
  let currentUser = null;

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
    const authGate = document.getElementById('authGate');
    const planGate = document.getElementById('planGate');
    const mainForm = document.getElementById('mainForm');
    const creditsDisplay = document.getElementById('creditsDisplay');

    if (!currentUser) {
      authGate.style.display = '';
      planGate.style.display = 'none';
      mainForm.style.display = 'none';
      return;
    }

    const profile = await StoryboardAPI.getUserProfile();
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

    if (creditsDisplay && profile) {
      creditsDisplay.textContent = `${profile.credits.toLocaleString()} credits available`;
    }
  }

  async function handleGenerate(formData) {
    const errorBanner = document.getElementById('errorBanner');

    const result = await StoryboardAPI.generateStoryboard(formData);

    if (!result.success) {
      const messages = {
        PLAN_NOT_ALLOWED: 'Your plan does not allow Storyboard generation.',
        INSUFFICIENT_CREDITS: 'Not enough credits. Storyboard requires 250 credits.',
        RATE_LIMITED: 'Please wait 60 seconds between requests.',
        TOO_MANY_CONCURRENT_JOBS: 'You already have the maximum number of jobs running.',
        MODERATION_REJECTED: 'Your scenario was flagged by our safety system. Please revise it.',
        INVALID_INPUT: result.errors?.join(', ') || 'Invalid input.',
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
