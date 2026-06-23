/* ── Supabase Init ── */
const SUPABASE_URL = 'https://kzlovmcghswprasjaeeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bG92bWNnaHN3cHJhc2phZWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1ODkyOTEsImV4cCI6MjA5MzE2NTI5MX0.aivqzUI4jpGgIMEpo6NMy8JL3iBxp49RqoCJU0NLOGE';
const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true }
});

/* ── Paddle Init ── */
Paddle.Initialize({
  token: 'live_81a81f812ec882e5536a9188161',
  eventCallback: function (event) {
    if (event.name === 'checkout.completed') {
      sbClient.auth.getSession().then(function ({ data: { session } }) {
        if (session) {
          setTimeout(function () { refreshUserProfile(session); }, 1500);
        }
      });
    }
  }
});

/* ── State ── */
const state = {
  file: null,
  result: null,
  bracketValues: {},
  activeChip: null,
  analyzing: false
};

let currentUserPlan = null;
let currentUserCredits = 0;

function getPlanTotalCredits(plan) {
  if (plan === 'enterprise') return 4000;
  if (['pro', 'paid'].includes(plan)) return 1000;
  return 0;
}

function updateAnalyzeButtonState() {
  const creditsErrorEl = document.getElementById('creditsError');
  const isPaid = ['pro', 'enterprise', 'paid'].includes(currentUserPlan);
  if (!state.file) {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = isPaid ? '✨ Analyze (10 Credits)' : '✨ Analyze Image';
    if (creditsErrorEl) creditsErrorEl.style.display = 'none';
    return;
  }
  if (isPaid && currentUserCredits < 10) {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = '✨ Analyze (10 Credits)';
    if (creditsErrorEl) { creditsErrorEl.textContent = 'Not enough credits. Upgrade your plan.'; creditsErrorEl.style.display = ''; }
  } else if (isPaid) {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = '✨ Analyze (10 Credits)';
    if (creditsErrorEl) creditsErrorEl.style.display = 'none';
  } else {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = '✨ Analyze Image';
    if (creditsErrorEl) creditsErrorEl.style.display = 'none';
  }
}

/* ── DOM ── */
const dropZone         = document.getElementById('dropZone');
const fileInput        = document.getElementById('fileInput');
const previewContainer = document.getElementById('previewContainer');
const previewImg       = document.getElementById('previewImg');
const clearBtn         = document.getElementById('clearBtn');
const analyzeBtn       = document.getElementById('analyzeBtn');
const loadingOverlay   = document.getElementById('loadingOverlay');
const resultsSection   = document.getElementById('resultsSection');
const promptDisplay    = document.getElementById('promptDisplay');
const copyBtn          = document.getElementById('copyBtn');
const analysisToggle   = document.getElementById('analysisToggle');
const analysisBody     = document.getElementById('analysisBody');
const analysisGrid     = document.getElementById('analysisGrid');
const errorDisplay     = document.getElementById('errorDisplay');

/* ── Upload Handling ── */
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
});

clearBtn.addEventListener('click', clearFile);

function handleFileSelect(file) {
  if (state.analyzing) return;
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!ALLOWED.includes(file.type)) {
    showError('Please upload a JPEG, PNG, WebP, or GIF image.');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showError('File size must be 20 MB or less.');
    return;
  }
  hideError();
  state.file = file;
  const url = URL.createObjectURL(file);
  previewImg.src = url;
  previewContainer.classList.add('visible');
  updateAnalyzeButtonState();
  hideResults();
}

function clearFile() {
  state.file = null;
  fileInput.value = '';
  previewImg.src = '';
  previewContainer.classList.remove('visible');
  updateAnalyzeButtonState();
  hideResults();
  hideError();
}

/* ── Analyze ── */
analyzeBtn.addEventListener('click', async () => {
  if (!state.file || state.analyzing) return;

  // Check auth first
  const { data: { session } } = await sbClient.auth.getSession();
  if (!session) {
    openAuthRequiredModal();
    return;
  }

  setLoading(true);
  hideError();
  hideResults();

  try {
    const formData = new FormData();
    formData.append('image', state.file);

    const res = await fetch('/api/analyze', {
      method: 'POST',
      body: formData,
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });

    if (res.status === 401) {
      setLoading(false);
      openAuthRequiredModal();
      return;
    }

    if (res.status === 403) {
      setLoading(false);
      const data = await res.json();
      if (data.code === 'DAILY_LIMIT' || data.code === 'NO_CREDITS') {
        openUpgradeModal(data.code);
        return;
      }
      throw new Error(data.error || 'Access denied');
    }

    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Analysis failed');

    state.result = data;
    state.bracketValues = {};
    (data.brackets || []).forEach(b => {
      state.bracketValues[b.original] = b.original;
    });

    renderResults(data);

    // Refresh usage display
    await refreshUserProfile(session);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

/* ── Render Results ── */
function renderResults(data) {
  renderPrompt(data.prompt, data.brackets || []);
  renderAnalysis(data.analysis || {});
  resultsSection.classList.add('visible');
}

// Section headers found in the AI-generated prompt
const SECTION_HEADERS = [
  'SUBJECT', 'CLOTHING & STYLING', 'LAYOUT & COMPOSITION',
  'LIGHTING', 'COLOR & TONE', 'BACKGROUND & SETTING',
  'LAYER STRUCTURE & GRAPHICS', 'TYPOGRAPHY & TEXT', 'TECHNICAL QUALITY', 'OUTPUT'
];

function renderPrompt(prompt, brackets) {
  promptDisplay.innerHTML = '';

  const bracketMap = {};
  brackets.forEach(b => { bracketMap[b.original] = b; });

  // Split prompt into lines, then render each line with section-header detection
  const lines = prompt.split('\n');

  lines.forEach((line, lineIdx) => {
    const trimmed = line.trim();

    // Check if this line is a section header
    const isHeader = SECTION_HEADERS.some(h => trimmed === h || trimmed.startsWith(h + ' —') || trimmed.startsWith(h + ' -'));

    if (isHeader) {
      // Add spacer before header (except for first line)
      if (lineIdx > 0) {
        const spacer = document.createElement('div');
        spacer.className = 'prompt-section-spacer';
        promptDisplay.appendChild(spacer);
      }
      const headerEl = document.createElement('div');
      headerEl.className = 'prompt-section-header';
      headerEl.textContent = trimmed;
      promptDisplay.appendChild(headerEl);
    } else {
      // Render line content with bracket chips
      const lineEl = document.createElement('div');
      lineEl.className = 'prompt-line';

      const parts = line.split(/(\[[^\]]+\])/g);
      parts.forEach(part => {
        if (/^\[[^\]]+\]$/.test(part)) {
          const original = part.slice(1, -1);
          const bracketData = bracketMap[original] || { original, description: '', suggestions: [] };
          lineEl.appendChild(createChip(bracketData, part));
        } else {
          lineEl.appendChild(document.createTextNode(part));
        }
      });

      promptDisplay.appendChild(lineEl);
    }
  });
}

function createChip(bracketData, originalWithBrackets) {
  const wrapper = document.createElement('span');
  wrapper.className = 'bracket-chip';

  const label = document.createElement('span');
  label.className = 'bracket-chip__label';
  label.textContent = state.bracketValues[bracketData.original] || bracketData.original;

  const popover = document.createElement('div');
  popover.className = 'bracket-popover hidden';

  if (bracketData.description) {
    const desc = document.createElement('p');
    desc.className = 'bracket-popover__desc';
    desc.textContent = bracketData.description;
    popover.appendChild(desc);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.value = state.bracketValues[bracketData.original] || bracketData.original;
  input.placeholder = bracketData.original;
  input.addEventListener('input', () => {
    state.bracketValues[bracketData.original] = input.value;
    label.textContent = input.value || bracketData.original;
  });
  input.addEventListener('click', e => e.stopPropagation());
  popover.appendChild(input);

  if (bracketData.suggestions && bracketData.suggestions.length > 0) {
    const sugLabel = document.createElement('p');
    sugLabel.className = 'suggestions-label';
    sugLabel.textContent = 'Suggestions';
    popover.appendChild(sugLabel);

    const row = document.createElement('div');
    row.className = 'suggestions-row';

    bracketData.suggestions.forEach(sug => {
      const chip = document.createElement('button');
      chip.className = 'suggestion-chip';
      chip.textContent = sug;
      chip.addEventListener('click', e => {
        e.stopPropagation();
        input.value = sug;
        state.bracketValues[bracketData.original] = sug;
        label.textContent = sug;
        closeActiveChip();
      });
      row.appendChild(chip);
    });

    popover.appendChild(row);
  }

  label.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = !popover.classList.contains('hidden');
    closeActiveChip();
    if (!isOpen) {
      popover.classList.remove('hidden');
      state.activeChip = { popover, wrapper };
      input.focus();
      input.select();
    }
  });

  wrapper.appendChild(label);
  wrapper.appendChild(popover);
  return wrapper;
}

function closeActiveChip() {
  if (state.activeChip) {
    state.activeChip.popover.classList.add('hidden');
    state.activeChip = null;
  }
}

document.addEventListener('click', closeActiveChip);

/* ── Analysis Toggle ── */
analysisToggle.addEventListener('click', () => {
  const expanded = analysisToggle.getAttribute('aria-expanded') === 'true';
  analysisToggle.setAttribute('aria-expanded', String(!expanded));
  analysisBody.classList.toggle('hidden', expanded);
});

function renderAnalysis(analysis) {
  const labels = {
    composition: 'Composition',
    lighting:    'Lighting',
    mood:        'Mood',
    style:       'Style',
    technique:   'Technique',
    layers:      'Layers',
    aspectRatio: 'Aspect Ratio',
    spatialRelationship: 'Spatial'
  };

  const wideKeys = new Set(['layers', 'technique', 'spatialRelationship']);

  analysisGrid.innerHTML = '';

  const populated = Object.entries(labels).filter(([key]) => analysis[key]);

  if (populated.length === 0) {
    const dd = document.createElement('dd');
    dd.className = 'wide';
    dd.style.color = 'var(--text-muted, #888)';
    dd.style.fontStyle = 'italic';
    dd.textContent = 'No analysis available';
    analysisGrid.appendChild(dd);
  } else {
    populated.forEach(([key, label]) => {
      const isWide = wideKeys.has(key);
      const dt = document.createElement('dt');
      dt.textContent = label;
      if (isWide) dt.classList.add('wide');
      const dd = document.createElement('dd');
      dd.textContent = analysis[key];
      if (isWide) dd.classList.add('wide');
      analysisGrid.appendChild(dt);
      analysisGrid.appendChild(dd);
    });
  }

  analysisToggle.setAttribute('aria-expanded', 'false');
  analysisBody.classList.add('hidden');
}

/* ── Download ── */
const downloadBtn = document.getElementById('downloadBtn');
downloadBtn.addEventListener('click', () => {
  if (!state.result) return;

  const prompt = buildFinalPrompt(state.result.prompt, state.result.brackets || []);
  const blob = new Blob([prompt], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `prompt-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const original = downloadBtn.textContent;
  downloadBtn.textContent = '✓ Downloaded!';
  setTimeout(() => { downloadBtn.textContent = original; }, 2000);
});

/* ── Copy ── */
copyBtn.addEventListener('click', async () => {
  if (!state.result) return;

  const prompt = buildFinalPrompt(state.result.prompt, state.result.brackets || []);

  try {
    await navigator.clipboard.writeText(prompt);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = prompt;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  const original = copyBtn.textContent;
  copyBtn.textContent = '✓ Copied!';
  setTimeout(() => { copyBtn.textContent = original; }, 2000);
});

function buildFinalPrompt(prompt, brackets) {
  let result = prompt;
  brackets.forEach(b => {
    const current = state.bracketValues[b.original] || b.original;
    result = result.split(`[${b.original}]`).join(current);
  });
  result = result.replace(/\[([^\]]+)\]/g, '$1');
  return result;
}

/* ── UI Helpers ── */
function setLoading(on) {
  loadingOverlay.classList.toggle('visible', on);
  state.analyzing = on;
  if (on) {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = '✨ Analyzing... Please wait';
    analyzeBtn.style.opacity = '0.6';
    analyzeBtn.style.cursor = 'not-allowed';
  } else {
    analyzeBtn.style.opacity = '';
    analyzeBtn.style.cursor = '';
    updateAnalyzeButtonState();
  }
}

function hideResults() {
  resultsSection.classList.remove('visible');
  state.result = null;
}

function showError(msg) {
  errorDisplay.textContent = msg;
  errorDisplay.classList.add('visible');
}

function hideError() {
  errorDisplay.classList.remove('visible');
  errorDisplay.textContent = '';
}

/* ══════════════════════════════════════
   NAVBAR SCROLL
══════════════════════════════════════ */
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

/* ══════════════════════════════════════
   HAMBURGER MENU
══════════════════════════════════════ */
const hamburger = document.getElementById('hamburger');
const navMenu   = document.getElementById('navMenu');

hamburger.addEventListener('click', e => {
  e.stopPropagation();
  hamburger.classList.toggle('open');
  navMenu.classList.toggle('open');
});

navMenu.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    hamburger.classList.remove('open');
    navMenu.classList.remove('open');
  });
});

/* ══════════════════════════════════════
   LOGIN MODAL (Google OAuth)
══════════════════════════════════════ */
const loginModal  = document.getElementById('loginModal');
const loginNavBtn = document.getElementById('loginNavBtn');
const modalClose  = document.getElementById('modalClose');

function openModal() {
  loginModal.classList.add('open');
  loginModal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  loginModal.classList.remove('open');
  loginModal.setAttribute('aria-hidden', 'true');
}

loginNavBtn.addEventListener('click', e => { e.preventDefault(); openModal(); });
modalClose.addEventListener('click', closeModal);
loginModal.addEventListener('click', e => { if (e.target === loginModal) closeModal(); });

/* ── In-App Browser Detection ── */
function isInAppBrowser() {
  return /KAKAOTALK|Instagram|NAVER|Line|FBAN|FBAV|FB_IAB|Twitter|Snapchat|MicroMessenger/i.test(navigator.userAgent || '');
}

/* ── Google Sign-In ── */
async function signInWithGoogle() {
  if (isInAppBrowser()) return; // blocked; warning already shown in modal
  await sbClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
}

document.getElementById('googleLoginBtn').addEventListener('click', signInWithGoogle);

/* ══════════════════════════════════════
   AUTH REQUIRED MODAL
══════════════════════════════════════ */
const authRequiredModal     = document.getElementById('authRequiredModal');
const authRequiredClose     = document.getElementById('authRequiredClose');
const authRequiredGoogleBtn = document.getElementById('authRequiredGoogleBtn');

function openAuthRequiredModal() {
  authRequiredModal.classList.add('open');
  authRequiredModal.setAttribute('aria-hidden', 'false');
}

function closeAuthRequiredModal() {
  authRequiredModal.classList.remove('open');
  authRequiredModal.setAttribute('aria-hidden', 'true');
}

authRequiredClose.addEventListener('click', closeAuthRequiredModal);
authRequiredModal.addEventListener('click', e => { if (e.target === authRequiredModal) closeAuthRequiredModal(); });
authRequiredGoogleBtn.addEventListener('click', () => {
  closeAuthRequiredModal();
  signInWithGoogle();
});

/* ── In-App Browser Warning Injection ── */
(function () {
  if (!isInAppBrowser()) return;

  const WARNING_MSG = 'Please open this page in Chrome or Safari. Google login is not supported in in-app browsers.';

  function injectWarning(modal) {
    if (!modal || modal.querySelector('.inapp-warning')) return;
    const notice = document.createElement('p');
    notice.className = 'inapp-warning';
    notice.textContent = WARNING_MSG;
    const btn = modal.querySelector('.btn--google');
    if (btn) {
      btn.parentNode.insertBefore(notice, btn);
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    }
  }

  injectWarning(document.getElementById('loginModal'));
  injectWarning(document.getElementById('authRequiredModal'));
})();

/* ══════════════════════════════════════
   UPGRADE MODAL
══════════════════════════════════════ */
const upgradeModal = document.getElementById('upgradeModal');
const upgradeClose = document.getElementById('upgradeClose');
const upgradeTitle = document.getElementById('upgradeTitle');
const upgradeDesc  = document.getElementById('upgradeDesc');
const upgradeBtn   = document.getElementById('upgradeBtn');

function openUpgradeModal(code) {
  if (code === 'NO_CREDITS') {
    upgradeTitle.textContent = 'Insufficient Credits';
    upgradeDesc.textContent = 'All credits have been used up. Add more credits or upgrade your plan.';
  } else {
    upgradeTitle.textContent = 'Daily Limit Reached';
    upgradeDesc.textContent = 'The free plan allows 1 generation per day. Try again tomorrow or upgrade to Pro.';
  }
  upgradeModal.classList.add('open');
  upgradeModal.setAttribute('aria-hidden', 'false');
}

function closeUpgradeModal() {
  upgradeModal.classList.remove('open');
  upgradeModal.setAttribute('aria-hidden', 'true');
}

upgradeClose.addEventListener('click', closeUpgradeModal);
upgradeModal.addEventListener('click', e => { if (e.target === upgradeModal) closeUpgradeModal(); });
upgradeBtn.addEventListener('click', closeUpgradeModal);

/* ── ESC closes all modals ── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
    closeAuthRequiredModal();
    closeUpgradeModal();
    closeChangePlanModal();
  }
});

/* ══════════════════════════════════════
   AUTH STATE MANAGEMENT
══════════════════════════════════════ */
const userProfileEl  = document.getElementById('userProfile');
const userAvatarEl   = document.getElementById('userAvatar');
const userNameEl     = document.getElementById('userName');
const planBadgeEl    = document.getElementById('planBadge');
const usageDisplayEl = document.getElementById('usageDisplay');
const manageSubBtn   = document.getElementById('manageSubBtn');
const logoutBtn      = document.getElementById('logoutBtn');

async function refreshUserProfile(session) {
  if (!session) return;
  try {
    const resp = await fetch('/api/user/profile', {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });
    const data = await resp.json();
    if (data.success) {
      userNameEl.textContent = data.user.full_name || data.user.email;
      if (userAvatarEl) userAvatarEl.style.display = 'flex';
      const planLabels = { free: 'Free', pro: 'Pro', enterprise: 'Enterprise', paid: 'Pro' };
      const planKey = data.plan || 'free';
      planBadgeEl.textContent = planLabels[planKey] || 'Free';
      const badgeClass = planKey === 'enterprise' ? 'enterprise' : (planKey === 'free' ? 'free' : 'pro');
      planBadgeEl.className = `plan-badge plan-badge--${badgeClass}`;
      currentUserPlan = planKey;
      currentUserCredits = data.credits || 0;
      if (['pro', 'enterprise', 'paid'].includes(planKey)) {
        const total = getPlanTotalCredits(planKey);
        usageDisplayEl.textContent = `Credits: ${currentUserCredits.toLocaleString()} / ${total.toLocaleString()}`;
        if (manageSubBtn) manageSubBtn.style.display = '';
      } else {
        usageDisplayEl.textContent = `Today ${data.daily_used}/1 used`;
        if (manageSubBtn) manageSubBtn.style.display = 'none';
      }
      updateAnalyzeButtonState();
      updatePricingButtons();
    }
  } catch (e) {
    // ignore profile fetch errors
  }
}

function updateNavUI(session) {
  if (session) {
    loginNavBtn.style.display = 'none';
    userProfileEl.style.display = 'flex';
  } else {
    loginNavBtn.style.display = '';
    userProfileEl.style.display = 'none';
  }
}

sbClient.auth.onAuthStateChange(async (event, session) => {
  updateNavUI(session);
  if (session) {
    await refreshUserProfile(session);
  }
  if (event === 'SIGNED_IN') {
    closeModal();
    closeAuthRequiredModal();
  }
});

// Init on page load
(async () => {
  const { data: { session } } = await sbClient.auth.getSession();
  updateNavUI(session);
  if (session) {
    await refreshUserProfile(session);
  }
})();

/* ══════════════════════════════════════
   HISTORY
══════════════════════════════════════ */
const historyBtn       = document.getElementById('historyBtn');
const historySection   = document.getElementById('historySection');
const historyList      = document.getElementById('historyList');
const historyCloseBtn  = document.getElementById('historyCloseBtn');

let historyOpen = false;

historyBtn.addEventListener('click', async () => {
  if (historyOpen) {
    historySection.style.display = 'none';
    historyOpen = false;
    return;
  }
  await loadHistory();
  historySection.style.display = 'block';
  historyOpen = true;
  historySection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

historyCloseBtn.addEventListener('click', () => {
  historySection.style.display = 'none';
  historyOpen = false;
});

async function loadHistory() {
  const { data: { session } } = await sbClient.auth.getSession();
  if (!session) return;

  historyList.innerHTML = '<li class="history-loading">Loading…</li>';

  try {
    const res = await fetch('/api/user/history?limit=10', {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });
    const data = await res.json();

    if (!data.success || !data.history.length) {
      historyList.innerHTML = '<li class="history-empty">No prompts yet. Analyze an image to get started!</li>';
      return;
    }

    historyList.innerHTML = data.history.map(item => {
      const date = new Date(item.created_at).toLocaleDateString('ko-KR', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const preview = item.prompt.replace(/\[([^\]]+)\]/g, '$1').slice(0, 120);
      return `
        <li class="history-item" data-id="${item.id}">
          <div class="history-item__meta">${date}</div>
          <div class="history-item__preview">${preview}…</div>
          <div class="history-item__actions">
            <button class="btn--text history-restore" data-prompt="${encodeURIComponent(item.prompt)}">Restore</button>
            <button class="btn--text history-delete" data-id="${item.id}">Delete</button>
          </div>
        </li>`;
    }).join('');

    // Restore 버튼
    historyList.querySelectorAll('.history-restore').forEach(btn => {
      btn.addEventListener('click', () => {
        const prompt = decodeURIComponent(btn.dataset.prompt);
        state.result = { prompt, brackets: [], analysis: {} };
        state.bracketValues = {};
        renderResults(state.result);
        historySection.style.display = 'none';
        historyOpen = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    // Delete 버튼
    historyList.querySelectorAll('.history-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const { data: { session } } = await sbClient.auth.getSession();
        if (!session) return;
        const res = await fetch(`/api/user/history/${id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${session.access_token}` }
        });
        if ((await res.json()).success) {
          btn.closest('.history-item').remove();
          if (!historyList.querySelector('.history-item')) {
            historyList.innerHTML = '<li class="history-empty">No prompts yet.</li>';
          }
        }
      });
    });
  } catch (e) {
    historyList.innerHTML = '<li class="history-empty">Failed to load history.</li>';
  }
}

logoutBtn.addEventListener('click', async () => {
  await sbClient.auth.signOut();
  currentUserPlan = null;
  currentUserCredits = 0;
  updateAnalyzeButtonState();
  updatePricingButtons();
  updateNavUI(null);
});

if (manageSubBtn) {
  manageSubBtn.addEventListener('click', async () => {
    const { data: { session } } = await sbClient.auth.getSession();
    if (!session) { openAuthRequiredModal(); return; }

    const original = manageSubBtn.textContent;
    manageSubBtn.disabled = true;
    manageSubBtn.textContent = 'Opening…';
    try {
      const res = await fetch('/api/payment/cancel', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.access_token}` }
      });
      const data = await res.json();
      if (data.success && data.url) {
        window.open(data.url, '_blank', 'noopener');
      } else {
        alert(data.error || 'Could not open subscription management. Please try again.');
      }
    } catch (e) {
      alert('Could not open subscription management. Please try again.');
    } finally {
      manageSubBtn.disabled = false;
      manageSubBtn.textContent = original;
    }
  });
}

/* ══════════════════════════════════════
   PRICING CHECKOUT (Paddle overlay)
══════════════════════════════════════ */
async function handleCheckout(plan) {
  const { data: { session } } = await sbClient.auth.getSession();
  if (!session) {
    openModal();
    return;
  }

  const priceId = plan === 'pro'
    ? 'pri_01kqntd17xt6hwpf7m7v4m6n4x'
    : 'pri_01kqntg37hydkapmpycwh1x29b';

  Paddle.Checkout.open({
    items: [{ priceId: priceId, quantity: 1 }],
    customer: { email: session.user.email },
    customData: { userId: session.user.id, plan: plan }
  });
}

document.getElementById('proPlanBtn')?.addEventListener('click', () => handlePlanButtonClick('pro'));
document.getElementById('enterprisePlanBtn')?.addEventListener('click', () => handlePlanButtonClick('enterprise'));

/* ── Plan button dispatcher: free → checkout, paid → change-plan modal ── */
// CRITICAL: paid users must NEVER go through handleCheckout — that creates a 2nd subscription.
async function handlePlanButtonClick(targetPlan) {
  const { data: { session } } = await sbClient.auth.getSession();
  if (!session) { openModal(); return; }
  if (['pro', 'enterprise', 'paid'].includes(currentUserPlan)) {
    openChangePlanModal(targetPlan);
  } else {
    handleCheckout(targetPlan);
  }
}

/* ── Pricing button states based on current plan ── */
// Tiers: free(0) < pro/paid(1) < enterprise(2)
const PLAN_TIER = { free: 0, paid: 1, pro: 1, enterprise: 2 };
const PLAN_LABEL = { free: 'Free', pro: 'Pro', enterprise: 'Enterprise' };
const SWITCH_TOOLTIP = 'Plan switching is coming soon. Contact support to change your plan.';

const PRICING_BUTTONS = [
  { el: document.getElementById('freePlanBtn'),       plan: 'free',       defaultLabel: 'Get Started' },
  { el: document.getElementById('proPlanBtn'),        plan: 'pro',        defaultLabel: 'Get Started' },
  { el: document.getElementById('enterprisePlanBtn'), plan: 'enterprise', defaultLabel: 'Get Started' }
];

function resetPricingButton(btn) {
  if (!btn.el) return;
  btn.el.textContent = btn.defaultLabel;
  btn.el.disabled = false;
  btn.el.classList.remove('btn--current');
  btn.el.removeAttribute('title');
}

function updatePricingButtons() {
  // Logged out → restore default state (pro/ent buttons open login modal on click)
  if (!currentUserPlan) {
    PRICING_BUTTONS.forEach(resetPricingButton);
    return;
  }

  const curTier = PLAN_TIER[currentUserPlan] ?? 0;

  PRICING_BUTTONS.forEach((btn) => {
    if (!btn.el) return;
    const btnTier = PLAN_TIER[btn.plan];

    if (btnTier === curTier) {
      // Current plan
      btn.el.textContent = '✓ Current Plan';
      btn.el.disabled = true;
      btn.el.classList.add('btn--current');
      btn.el.removeAttribute('title');
    } else if (btnTier > curTier) {
      btn.el.classList.remove('btn--current');
      btn.el.textContent = `Upgrade to ${PLAN_LABEL[btn.plan]}`;
      btn.el.disabled = false;
      btn.el.removeAttribute('title');
    } else {
      // Downgrade
      btn.el.classList.remove('btn--current');
      btn.el.textContent = `Downgrade to ${PLAN_LABEL[btn.plan]}`;
      btn.el.disabled = false;
      btn.el.removeAttribute('title');
    }
  });
}

// Handle redirect back from payment
(async () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('payment') === 'success') {
    const { data: { session } } = await sbClient.auth.getSession();
    if (session) {
      await refreshUserProfile(session);
    }
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  }
})();

/* ══════════════════════════════════════
   CHANGE PLAN MODAL
══════════════════════════════════════ */
const changePlanModal      = document.getElementById('changePlanModal');
const changePlanClose      = document.getElementById('changePlanClose');
const changePlanIcon       = document.getElementById('changePlanIcon');
const changePlanTitle      = document.getElementById('changePlanTitle');
const changePlanPriceInfo  = document.getElementById('changePlanPriceInfo');
const changePlanCreditWarn = document.getElementById('changePlanCreditWarn');
const changePlanCreditText = document.getElementById('changePlanCreditText');
const changePlanCancelBtn  = document.getElementById('changePlanCancelBtn');
const changePlanConfirmBtn = document.getElementById('changePlanConfirmBtn');
const changePlanUpdatingMsg = document.getElementById('changePlanUpdatingMsg');
const changePlanErrorMsg   = document.getElementById('changePlanErrorMsg');
const changePlanDismissBtn = document.getElementById('changePlanDismissBtn');

const cpStateLoading  = document.getElementById('cpStateLoading');
const cpStateReady    = document.getElementById('cpStateReady');
const cpStateUpdating = document.getElementById('cpStateUpdating');
const cpStateError    = document.getElementById('cpStateError');

let _cpTargetPlan = null;
let _cpPollCancel = null;

function cpShowState(state) {
  [cpStateLoading, cpStateReady, cpStateUpdating, cpStateError].forEach(el => {
    if (el) el.style.display = 'none';
  });
  if (state) state.style.display = '';
}

function openChangePlanModal(targetPlan) {
  // Guard: only for paid users (free must use checkout)
  if (!['pro', 'enterprise', 'paid'].includes(currentUserPlan)) return;

  _cpTargetPlan = targetPlan;
  const isUpgrade = (PLAN_TIER[targetPlan] || 0) > (PLAN_TIER[currentUserPlan] || 0);

  changePlanIcon.textContent  = isUpgrade ? '⬆️' : '⬇️';
  changePlanTitle.textContent = isUpgrade
    ? `Upgrade to ${PLAN_LABEL[targetPlan]}`
    : `Downgrade to ${PLAN_LABEL[targetPlan]}`;
  changePlanCreditWarn.style.display = 'none';
  changePlanPriceInfo.textContent    = '';
  cpShowState(cpStateLoading);

  changePlanModal.classList.add('open');
  changePlanModal.setAttribute('aria-hidden', 'false');

  _cpLoadPreview(targetPlan, isUpgrade);
}

function closeChangePlanModal() {
  if (!changePlanModal) return;
  changePlanModal.classList.remove('open');
  changePlanModal.setAttribute('aria-hidden', 'true');
  _cpTargetPlan = null;
  if (_cpPollCancel) { _cpPollCancel(); _cpPollCancel = null; }
}

async function _cpLoadPreview(targetPlan, isUpgrade) {
  try {
    const { data: { session } } = await sbClient.auth.getSession();
    if (!session) { closeChangePlanModal(); openAuthRequiredModal(); return; }

    const res = await fetch('/api/payment/change-plan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ plan: targetPlan, preview: true })
    });
    const json = await res.json();

    if (!res.ok || !json.success) throw new Error(json.error || 'Could not load plan details.');

    _cpRenderReady(ChangePlanHelpers.parsePlanPreview(json.data), targetPlan, isUpgrade);
  } catch (err) {
    changePlanTitle.textContent = 'Could not load plan details';
    changePlanErrorMsg.textContent = err.message || 'Please try again.';
    cpShowState(cpStateError);
  }
}

function _cpRenderReady(preview, targetPlan, isUpgrade) {
  if (!preview) {
    changePlanErrorMsg.textContent = 'Preview unavailable. Please try again.';
    cpShowState(cpStateError);
    return;
  }

  const { immediateAmount, recurringAmount, currency, immediateApplicable } = preview;
  const fmt = (n) => currency === 'USD' ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`;

  const lines = [];
  if (immediateApplicable) {
    lines.push(`Due now (prorated): ${fmt(immediateAmount)}`);
  } else {
    lines.push('Applies from your next billing date.');
  }
  if (recurringAmount !== null) lines.push(`Then: ${fmt(recurringAmount)} / month`);
  changePlanPriceInfo.textContent = lines.join('\n');

  if (!isUpgrade) {
    const warn = ChangePlanHelpers.calcCreditWarning(currentUserCredits, targetPlan);
    if (warn.show) {
      changePlanCreditText.textContent =
        `⚠ Credits will change: ${warn.from.toLocaleString()} → ${warn.to.toLocaleString()}`;
      changePlanCreditWarn.style.display = '';
    }
  }

  cpShowState(cpStateReady);
}

changePlanConfirmBtn?.addEventListener('click', async () => {
  const targetPlan = _cpTargetPlan;
  if (!targetPlan) return;
  // Guard: free must never reach here
  if (!['pro', 'enterprise', 'paid'].includes(currentUserPlan)) { closeChangePlanModal(); return; }

  changePlanIcon.textContent  = '⏳';
  changePlanTitle.textContent = 'Applying change…';
  changePlanUpdatingMsg.textContent = 'Applying your plan change…';
  cpShowState(cpStateUpdating);

  try {
    const { data: { session } } = await sbClient.auth.getSession();
    if (!session) { closeChangePlanModal(); openAuthRequiredModal(); return; }

    const res = await fetch('/api/payment/change-plan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ plan: targetPlan })
    });
    const json = await res.json();

    if (!res.ok || !json.success) throw new Error(json.error || 'Could not change your plan. Please try again later.');

    // PATCH accepted — webhook is async, poll until plan is reflected
    changePlanTitle.textContent = 'Updating…';
    changePlanUpdatingMsg.textContent = 'Applying your plan change…';

    _cpPollCancel = ChangePlanHelpers.createPlanPoller(
      async () => { await refreshUserProfile(session); return currentUserPlan; },
      targetPlan,
      {
        maxAttempts: 5,
        intervalMs: 2000,
        onDone: () => { _cpPollCancel = null; closeChangePlanModal(); },
        onTimeout: () => {
          _cpPollCancel = null;
          changePlanTitle.textContent = 'Almost done';
          changePlanUpdatingMsg.textContent = '변경이 곧 반영됩니다. 새로고침해 주세요.';
          setTimeout(() => { closeChangePlanModal(); window.location.reload(); }, 3000);
        }
      }
    );
  } catch (err) {
    changePlanTitle.textContent = 'Something went wrong';
    changePlanErrorMsg.textContent = err.message || 'Could not change your plan. Please try again later.';
    cpShowState(cpStateError);
  }
});

changePlanClose?.addEventListener('click', closeChangePlanModal);
changePlanCancelBtn?.addEventListener('click', closeChangePlanModal);
changePlanDismissBtn?.addEventListener('click', closeChangePlanModal);
changePlanModal?.addEventListener('click', e => { if (e.target === changePlanModal) closeChangePlanModal(); });

/* ══════════════════════════════════════
   SCROLL REVEAL
══════════════════════════════════════ */
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('revealed');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.08, rootMargin: '0px 0px -60px 0px' });

document.querySelectorAll('.section-reveal').forEach(el => revealObserver.observe(el));
