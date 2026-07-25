/* ── Supabase Init ── */
const SUPABASE_URL = 'https://kzlovmcghswprasjaeeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bG92bWNnaHN3cHJhc2phZWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1ODkyOTEsImV4cCI6MjA5MzE2NTI5MX0.aivqzUI4jpGgIMEpo6NMy8JL3iBxp49RqoCJU0NLOGE';
const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true }
});

function uiText(key, values) {
  return window.PromptGenI18n?.t(key, values) || key;
}

/* ── Product catalog + Paddle Init ── */
let productCatalog = null;
let productCatalogPromise = null;
let paddleInitialized = false;

async function loadProductCatalog() {
  if (productCatalog) return productCatalog;
  if (!productCatalogPromise) {
    productCatalogPromise = fetch('/api/catalog')
      .then(async (res) => {
        if (!res.ok) throw new Error('Product catalog request failed');
        const body = await res.json();
        if (!body?.catalog?.plans) throw new Error('Product catalog is invalid');
        productCatalog = body.catalog;
        hydrateProductCatalog(productCatalog);
        return productCatalog;
      })
      .catch((error) => {
        console.error('[catalog] Failed to load public product catalog:', error.message);
        productCatalogPromise = null;
        throw error;
      });
  }
  return productCatalogPromise;
}

function getCatalogPlan(plan) {
  const key = plan === 'paid' ? 'pro' : plan;
  return productCatalog?.plans?.[key] || null;
}

function getPlanLabel(plan) {
  const key = plan === 'paid' ? 'pro' : String(plan || 'free');
  const localized = window.PromptGenI18n?.t(`pricing.plan.${key}.name`);
  if (localized && !localized.startsWith('[')) return localized;
  return getCatalogPlan(plan)?.name || (plan === 'paid' ? 'Pro' : key.replace(/^./, c => c.toUpperCase()));
}

function getPlanTotalCredits(plan) {
  const catalogPlan = getCatalogPlan(plan);
  if (!catalogPlan || !Number.isFinite(Number(catalogPlan.credits))) return undefined;
  return Number(catalogPlan.credits);
}

function getAnalysisCreditCost() {
  return Number(productCatalog?.analysisCreditCost) || 2;
}

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return window.PromptGenI18n?.formatCurrency(amount, 'USD', {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }) || `$${amount.toFixed(2).replace(/\.00$/, '')}`;
}

function setCatalogText(card, field, value) {
  const element = card.querySelector(`[data-catalog-field="${field}"]`);
  if (element && value != null) element.textContent = value;
}

function hydrateProductCatalog(catalog) {
  for (const card of document.querySelectorAll('[data-catalog-plan]')) {
    const plan = catalog?.plans?.[card.dataset.catalogPlan];
    if (!plan) continue;
    setCatalogText(card, 'name', uiText(`pricing.plan.${card.dataset.catalogPlan}.name`));
    setCatalogText(card, 'description', uiText(`pricing.plan.${card.dataset.catalogPlan}.description`));
    setCatalogText(card, 'price', formatUsd(plan.monthlyPriceUsd));
    if (plan.credits > 0) {
      setCatalogText(card, 'credits', uiText('pricing.feature.creditsMonthly', {
        credits: window.PromptGenI18n?.formatNumber(plan.credits) || plan.credits
      }));
      setCatalogText(card, 'storyboards', uiText('pricing.feature.storyboards', {
        count: window.PromptGenI18n?.formatNumber(plan.storyboards) || plan.storyboards,
        credits: window.PromptGenI18n?.formatNumber(catalog.storyboardCreditCost) || catalog.storyboardCreditCost,
        referenceCredits: window.PromptGenI18n?.formatNumber(catalog.storyboardCreditPolicy?.perReferenceCost || 5)
          || catalog.storyboardCreditPolicy?.perReferenceCost
          || 5
      }));
      setCatalogText(card, 'analyses', uiText('pricing.feature.analyses', {
        count: window.PromptGenI18n?.formatNumber(plan.imageAnalyses) || plan.imageAnalyses,
        credits: window.PromptGenI18n?.formatNumber(catalog.analysisCreditCost) || catalog.analysisCreditCost
      }));
    }
  }

  const structuredData = document.getElementById('productStructuredData');
  if (!structuredData) return;
  try {
    const schema = JSON.parse(structuredData.textContent);
    schema.offers = Object.values(catalog.plans).map(plan => ({
      '@type': 'Offer',
      name: plan.name,
      price: Number(plan.monthlyPriceUsd).toFixed(2),
      priceCurrency: 'USD'
    }));
    structuredData.textContent = JSON.stringify(schema);
  } catch (error) {
    console.error('[catalog] Failed to hydrate structured pricing data:', error.message);
  }
}

async function ensurePaddleInitialized() {
  const catalog = await loadProductCatalog();
  if (paddleInitialized) return catalog;
  const clientToken = catalog?.paddle?.clientToken;
  if (!clientToken || !window.Paddle) {
    throw new Error('Checkout configuration is unavailable');
  }
  Paddle.Initialize({
    token: clientToken,
    eventCallback: function (event) {
      if (event.name === 'checkout.completed') {
        window.PromptGenAnalytics?.track('checkout_completed', { surface: 'paddle_overlay' });
        sbClient.auth.getSession().then(function ({ data: { session } }) {
          if (session) {
            setTimeout(function () { refreshUserProfile(session); }, 1500);
          }
        });
      }
    }
  });
  paddleInitialized = true;
  return catalog;
}

/* ── State ── */
const state = {
  file: null,
  result: null,
  bracketValues: {},
  activeChip: null,
  analyzing: false,
  analysisOperationId: null
};

let currentUserPlan = null;
let currentUserCredits = 0;

function updateAnalyzeButtonState() {
  if (!analyzeBtn) return;
  const creditsErrorEl = document.getElementById('creditsError');
  const isPaid = ['pro', 'enterprise', 'paid'].includes(currentUserPlan);
  const analysisCreditCost = getAnalysisCreditCost();
  if (!state.file) {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = isPaid
      ? uiText('generator.action.analyzeCredits', { credits: analysisCreditCost })
      : uiText('generator.action.analyze');
    if (creditsErrorEl) creditsErrorEl.style.display = 'none';
    return;
  }
  if (isPaid && currentUserCredits < analysisCreditCost) {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = uiText('generator.action.analyzeCredits', { credits: analysisCreditCost });
    if (creditsErrorEl) { creditsErrorEl.textContent = uiText('generator.error.insufficientCredits'); creditsErrorEl.style.display = ''; }
  } else if (isPaid) {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = uiText('generator.action.analyzeCredits', { credits: analysisCreditCost });
    if (creditsErrorEl) creditsErrorEl.style.display = 'none';
  } else {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = uiText('generator.action.analyze');
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
dropZone?.addEventListener('click', () => fileInput.click());
dropZone?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone?.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
});

fileInput?.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
});

clearBtn?.addEventListener('click', clearFile);

function handleFileSelect(file) {
  if (state.analyzing) return;
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!ALLOWED.includes(file.type)) {
    showError(uiText('generator.error.fileType'));
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showError(uiText('generator.error.fileSize'));
    return;
  }
  hideError();
  state.file = file;
  state.analysisOperationId = crypto.randomUUID();
  const url = URL.createObjectURL(file);
  previewImg.src = url;
  previewContainer.classList.add('visible');
  updateAnalyzeButtonState();
  hideResults();
}

function clearFile() {
  state.file = null;
  state.analysisOperationId = null;
  fileInput.value = '';
  previewImg.src = '';
  previewContainer.classList.remove('visible');
  updateAnalyzeButtonState();
  hideResults();
  hideError();
}

/* ── Analyze ── */
analyzeBtn?.addEventListener('click', async () => {
  if (!state.file || state.analyzing) return;

  // Check auth first
  const { data: { session } } = await sbClient.auth.getSession();
  if (!session) {
    openAuthRequiredModal();
    return;
  }

  window.PromptGenAnalytics?.setAuthToken(session.access_token);
  window.PromptGenAnalytics?.track('analysis_started', {
    surface: 'home_generator',
    plan: currentUserPlan || 'unknown'
  });

  setLoading(true);
  hideError();
  hideResults();

  try {
    const formData = new FormData();
    formData.append('image', state.file);

    const res = await fetch('/api/analyze', {
      method: 'POST',
      body: formData,
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'X-Analysis-Operation-Id': state.analysisOperationId || crypto.randomUUID()
      }
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
      throw new Error(uiText('generator.error.accessDenied'));
    }

    const data = await res.json();
    if (!data.success) throw new Error(uiText('generator.error.analysisFailed'));

    state.result = data;
    state.bracketValues = {};
    (data.brackets || []).forEach(b => {
      state.bracketValues[b.original] = b.original;
    });

    renderResults(data);
    state.analysisOperationId = null;

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
    sugLabel.textContent = uiText('generator.suggestions');
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
analysisToggle?.addEventListener('click', () => {
  const expanded = analysisToggle.getAttribute('aria-expanded') === 'true';
  analysisToggle.setAttribute('aria-expanded', String(!expanded));
  analysisBody.classList.toggle('hidden', expanded);
});

function renderAnalysis(analysis) {
  const labels = {
    composition: uiText('generator.analysis.composition'),
    lighting:    uiText('generator.analysis.lighting'),
    mood:        uiText('generator.analysis.mood'),
    style:       uiText('generator.analysis.style'),
    technique:   uiText('generator.analysis.technique'),
    layers:      uiText('generator.analysis.layers'),
    aspectRatio: uiText('generator.analysis.aspectRatio'),
    spatialRelationship: uiText('generator.analysis.spatial')
  };

  const wideKeys = new Set(['layers', 'technique', 'spatialRelationship']);

  analysisGrid.innerHTML = '';

  const populated = Object.entries(labels).filter(([key]) => analysis[key]);

  if (populated.length === 0) {
    const dd = document.createElement('dd');
    dd.className = 'wide';
    dd.style.color = 'var(--text-muted, #888)';
    dd.style.fontStyle = 'italic';
    dd.textContent = uiText('generator.analysis.empty');
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
downloadBtn?.addEventListener('click', () => {
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
  downloadBtn.textContent = uiText('common.state.downloaded');
  setTimeout(() => { downloadBtn.textContent = original; }, 2000);
});

/* ── Copy ── */
copyBtn?.addEventListener('click', async () => {
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
  copyBtn.textContent = uiText('common.state.copied');
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
    analyzeBtn.textContent = uiText('generator.state.analyzingWait');
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

function setNavigationOpen(isOpen, { restoreFocus = false } = {}) {
  hamburger.classList.toggle('open', isOpen);
  navMenu.classList.toggle('open', isOpen);
  hamburger.setAttribute('aria-expanded', String(isOpen));
  hamburger.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
  document.body.classList.toggle('nav-open', isOpen);

  if (restoreFocus) hamburger.focus();
}

hamburger.addEventListener('click', e => {
  e.stopPropagation();
  const willOpen = !navMenu.classList.contains('open');
  setNavigationOpen(willOpen);

  if (willOpen) {
    window.setTimeout(() => {
      if (navMenu.classList.contains('open')) navMenu.querySelector('.nav-link')?.focus();
    }, 120);
  }
});

navMenu.querySelectorAll('a, button').forEach(link => {
  if (link.id === 'accountMenuTrigger') return;
  link.addEventListener('click', () => {
    setNavigationOpen(false);
  });
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navMenu.classList.contains('open')) {
    setNavigationOpen(false, { restoreFocus: true });
  }
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 1040 && navMenu.classList.contains('open')) {
    setNavigationOpen(false);
  }
}, { passive: true });

/* ══════════════════════════════════════
   HERO POINTER LIGHT + PARALLAX
   Fine pointers only; touch and reduced-motion users get a static composition.
══════════════════════════════════════ */
const hero = document.querySelector('.hero');
const canTrackHeroPointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

if (hero && canTrackHeroPointer.matches && !prefersReducedMotion.matches) {
  let pointerFrame = null;

  hero.addEventListener('pointermove', event => {
    if (pointerFrame) return;

    pointerFrame = window.requestAnimationFrame(() => {
      const bounds = hero.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));

      hero.style.setProperty('--pointer-x', `${(x * 100).toFixed(2)}%`);
      hero.style.setProperty('--pointer-y', `${(y * 100).toFixed(2)}%`);
      hero.style.setProperty('--grid-x', `${((x - 0.5) * -16).toFixed(2)}px`);
      hero.style.setProperty('--grid-y', `${((y - 0.5) * -12).toFixed(2)}px`);
      hero.style.setProperty('--demo-x', `${((x - 0.5) * 3.2).toFixed(2)}deg`);
      hero.style.setProperty('--demo-y', `${((0.5 - y) * 2.2).toFixed(2)}deg`);
      pointerFrame = null;
    });
  }, { passive: true });

  hero.addEventListener('pointerleave', () => {
    hero.style.removeProperty('--pointer-x');
    hero.style.removeProperty('--pointer-y');
    hero.style.removeProperty('--grid-x');
    hero.style.removeProperty('--grid-y');
    hero.style.removeProperty('--demo-x');
    hero.style.removeProperty('--demo-y');
  }, { passive: true });
}

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
window.PromptGenGoogleAuth?.mount({
  client: sbClient,
  buttonIds: ['googleLoginBtn', 'authRequiredGoogleBtn'],
  surface: 'home'
});

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

/* ── In-App Browser Warning Injection ── */
(function () {
  if (!isInAppBrowser()) return;

  function injectWarning(modal) {
    if (!modal || modal.querySelector('.inapp-warning')) return;
    const notice = document.createElement('p');
    notice.className = 'inapp-warning';
    notice.setAttribute('data-i18n', 'auth.inAppBrowserWarning');
    notice.textContent = uiText('auth.inAppBrowserWarning');
    const btn = modal.querySelector('.google-auth-button');
    if (btn) {
      btn.parentNode.insertBefore(notice, btn);
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('google-auth-button--disabled');
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
    upgradeTitle.textContent = uiText('auth.credits.title');
    upgradeDesc.textContent = uiText('auth.credits.description');
  } else {
    upgradeTitle.textContent = uiText('auth.limit.title');
    upgradeDesc.textContent = uiText('auth.limit.description');
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
const accountMenuTrigger = document.getElementById('accountMenuTrigger');
const accountMenu        = document.getElementById('accountMenu');

function setAccountMenuOpen(isOpen, { restoreFocus = false } = {}) {
  if (!accountMenuTrigger || !accountMenu) return;
  accountMenu.hidden = !isOpen;
  accountMenuTrigger.setAttribute('aria-expanded', String(isOpen));
  accountMenuTrigger.classList.toggle('open', isOpen);
  if (restoreFocus) accountMenuTrigger.focus();
}

if (accountMenuTrigger && accountMenu) {
  accountMenuTrigger.addEventListener('click', event => {
    event.stopPropagation();
    setAccountMenuOpen(accountMenu.hidden);
  });

  accountMenu.addEventListener('click', event => {
    event.stopPropagation();
  });

  accountMenu.querySelectorAll('[role="menuitem"]').forEach(item => {
    item.addEventListener('click', () => setAccountMenuOpen(false));
  });

  document.addEventListener('click', event => {
    if (!accountMenu.hidden && !userProfileEl.contains(event.target)) {
      setAccountMenuOpen(false);
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !accountMenu.hidden) {
      setAccountMenuOpen(false, { restoreFocus: true });
    }
  });
}

async function refreshUserProfile(session) {
  if (!session) return;
  try {
    await loadProductCatalog().catch(() => null);
    const resp = await fetch('/api/user/profile', {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });
    const data = await resp.json();
    if (data.success) {
      userNameEl.textContent = data.user.full_name || data.user.email;
      if (userAvatarEl) userAvatarEl.style.display = 'flex';
      const planKey = data.plan || 'free';
      planBadgeEl.textContent = getPlanLabel(planKey);
      const badgeClass = planKey === 'enterprise' ? 'enterprise' : (planKey === 'free' ? 'free' : 'pro');
      planBadgeEl.className = `plan-badge plan-badge--${badgeClass}`;
      currentUserPlan = planKey;
      currentUserCredits = data.credits || 0;
      if (['pro', 'enterprise', 'paid'].includes(planKey)) {
        const total = getPlanTotalCredits(planKey);
        usageDisplayEl.textContent = total == null
          ? uiText('account.credits.remaining', {
              remaining: window.PromptGenI18n?.formatNumber(currentUserCredits) || currentUserCredits
            })
          : uiText('account.credits.remainingOfTotal', {
              remaining: window.PromptGenI18n?.formatNumber(currentUserCredits) || currentUserCredits,
              total: window.PromptGenI18n?.formatNumber(total) || total
            });
        if (manageSubBtn) manageSubBtn.style.display = '';
      } else {
        usageDisplayEl.textContent = uiText('account.dailyUsage', { used: data.daily_used, total: 1 });
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
    setAccountMenuOpen(false);
    loginNavBtn.style.display = '';
    userProfileEl.style.display = 'none';
  }
}

sbClient.auth.onAuthStateChange(async (event, session) => {
  updateNavUI(session);
  window.PromptGenAnalytics?.setAuthToken(session?.access_token || null);
  if (session) {
    await refreshUserProfile(session);
  }
  if (event === 'SIGNED_IN') {
    window.PromptGenAnalytics?.track('auth_completed', {
      surface: 'home',
      provider: 'google'
    });
    closeModal();
    closeAuthRequiredModal();
  }
});

// Init on page load
(async () => {
  const { data: { session } } = await sbClient.auth.getSession();
  updateNavUI(session);
  window.PromptGenAnalytics?.setAuthToken(session?.access_token || null);
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

historyBtn?.addEventListener('click', async () => {
  if (!historySection) {
    window.location.assign('/image-to-prompt?history=open');
    return;
  }
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

historyCloseBtn?.addEventListener('click', () => {
  historySection.style.display = 'none';
  historyOpen = false;
});

if (historySection && new URLSearchParams(window.location.search).get('history') === 'open') {
  window.setTimeout(() => historyBtn?.click(), 0);
  window.history.replaceState({}, '', window.location.pathname + window.location.hash);
}

async function loadHistory() {
  const { data: { session } } = await sbClient.auth.getSession();
  if (!session) return;

  historyList.innerHTML = `<li class="history-loading">${uiText('common.state.loading')}</li>`;

  try {
    const res = await fetch('/api/user/history?limit=10', {
      headers: { 'Authorization': `Bearer ${session.access_token}` }
    });
    const data = await res.json();

    if (!data.success || !data.history.length) {
      historyList.innerHTML = `<li class="history-empty">${uiText('generator.history.empty')}</li>`;
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
            historyList.innerHTML = `<li class="history-empty">${uiText('generator.history.none')}</li>`;
          }
        }
      });
    });
  } catch (e) {
    historyList.innerHTML = `<li class="history-empty">${uiText('generator.history.failed')}</li>`;
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
    manageSubBtn.textContent = uiText('common.state.opening');
    try {
      const res = await fetch('/api/payment/cancel', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.access_token}` }
      });
      const data = await res.json();
      if (data.success && data.url) {
        window.open(data.url, '_blank', 'noopener');
      } else {
        console.error('[subscription] Failed to open management portal:', data.error || 'unknown error');
        alert(uiText('subscription.error.openManagement'));
      }
    } catch (e) {
      alert(uiText('subscription.error.openManagement'));
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

  let catalog;
  try {
    catalog = await ensurePaddleInitialized();
  } catch (error) {
    console.error('[checkout] Catalog/Paddle initialization failed:', error.message);
    alert(uiText('checkout.error.unavailable'));
    return;
  }
  const priceId = catalog?.paddle?.priceIds?.[plan];
  if (!priceId) {
    console.error('[checkout] Missing server-provided Paddle price ID for plan=' + plan);
    alert(uiText('checkout.error.unavailable'));
    return;
  }

  window.PromptGenAnalytics?.setAuthToken(session.access_token);
  window.PromptGenAnalytics?.track('checkout_started', {
    plan: plan,
    surface: 'pricing'
  });

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
const PRICING_BUTTONS = [
  { el: document.getElementById('freePlanBtn'),       plan: 'free' },
  { el: document.getElementById('proPlanBtn'),        plan: 'pro' },
  { el: document.getElementById('enterprisePlanBtn'), plan: 'enterprise' }
];

loadProductCatalog()
  .then(() => {
    updateAnalyzeButtonState();
    updatePricingButtons();
  })
  .catch(() => null);

function resetPricingButton(btn) {
  if (!btn.el) return;
  btn.el.textContent = uiText('common.action.getStarted');
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
      btn.el.textContent = uiText('pricing.action.currentPlan');
      btn.el.disabled = true;
      btn.el.classList.add('btn--current');
      btn.el.removeAttribute('title');
    } else if (btnTier > curTier) {
      btn.el.classList.remove('btn--current');
      btn.el.textContent = uiText('pricing.action.upgradeTo', { plan: getPlanLabel(btn.plan) });
      btn.el.disabled = false;
      btn.el.removeAttribute('title');
    } else {
      // Downgrade
      btn.el.classList.remove('btn--current');
      btn.el.textContent = uiText('pricing.action.downgradeTo', { plan: getPlanLabel(btn.plan) });
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
const changePlanRefreshBtn = document.getElementById('changePlanRefreshBtn');
const cpUpdatingSpinner    = document.getElementById('cpUpdatingSpinner');
const changePlanResubscribeMsg = document.getElementById('changePlanResubscribeMsg');
const changePlanResubscribeBtn = document.getElementById('changePlanResubscribeBtn');
const changePlanResubscribeCancelBtn = document.getElementById('changePlanResubscribeCancelBtn');
const changePlanErrorMsg   = document.getElementById('changePlanErrorMsg');
const changePlanDismissBtn = document.getElementById('changePlanDismissBtn');

const cpStateLoading  = document.getElementById('cpStateLoading');
const cpStateReady    = document.getElementById('cpStateReady');
const cpStateUpdating = document.getElementById('cpStateUpdating');
const cpStateResubscribe = document.getElementById('cpStateResubscribe');
const cpStateError    = document.getElementById('cpStateError');

let _cpTargetPlan = null;
let _cpPollCancel = null;

function cpShowState(state) {
  [cpStateLoading, cpStateReady, cpStateUpdating, cpStateResubscribe, cpStateError].forEach(el => {
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
    ? uiText('pricing.action.upgradeTo', { plan: getPlanLabel(targetPlan) })
    : uiText('pricing.action.downgradeTo', { plan: getPlanLabel(targetPlan) });
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
    const json = ChangePlanHelpers.parseApiJson(
      await res.text(),
      uiText('plan.change.error.loadDetails')
    );

    if (!res.ok || !json.success) {
      if (ChangePlanHelpers.shouldOfferNewSubscription(json.code)) {
        _cpRenderResubscribe(targetPlan);
        return;
      }
      throw new Error(uiText('plan.change.error.loadDetails'));
    }

    _cpRenderReady(ChangePlanHelpers.parsePlanPreview(json.data), targetPlan, isUpgrade);
  } catch (err) {
    changePlanTitle.textContent = uiText('plan.change.error.title');
    changePlanErrorMsg.textContent = err.message || uiText('common.error.tryAgain');
    cpShowState(cpStateError);
  }
}

function _cpRenderResubscribe(targetPlan) {
  const planLabel = getPlanLabel(targetPlan);
  changePlanIcon.textContent = '↻';
  changePlanTitle.textContent = uiText('plan.change.resubscribe.title');
  changePlanResubscribeMsg.textContent = uiText('plan.change.resubscribe.description', { plan: planLabel });
  changePlanResubscribeBtn.textContent = uiText('plan.change.resubscribe.action', { plan: planLabel });
  changePlanResubscribeBtn.disabled = false;
  cpShowState(cpStateResubscribe);
}

function _cpRenderReady(preview, targetPlan, isUpgrade) {
  if (!preview) {
    changePlanErrorMsg.textContent = uiText('plan.change.error.previewUnavailable');
    cpShowState(cpStateError);
    return;
  }

  const { immediateAmount, recurringAmount, currency, immediateApplicable } = preview;
  const fmt = (n) => window.PromptGenI18n?.formatCurrency(n, currency) || `${n.toFixed(2)} ${currency}`;

  const lines = [];
  if (immediateApplicable) {
    lines.push(uiText('plan.change.dueNow', { amount: fmt(immediateAmount) }));
  } else {
    lines.push(uiText('plan.change.nextBillingDate'));
  }
  if (recurringAmount !== null) lines.push(uiText('plan.change.thenMonthly', { amount: fmt(recurringAmount) }));
  changePlanPriceInfo.textContent = lines.join('\n');

  if (!isUpgrade) {
    const warn = ChangePlanHelpers.calcCreditWarning(currentUserCredits, targetPlan, getPlanTotalCredits(targetPlan));
    if (warn.show) {
      changePlanCreditText.textContent =
        uiText('plan.change.creditWarning', {
          from: window.PromptGenI18n?.formatNumber(warn.from) || warn.from,
          to: window.PromptGenI18n?.formatNumber(warn.to) || warn.to
        });
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
  changePlanTitle.textContent = uiText('plan.change.applyingShort');
  changePlanUpdatingMsg.textContent = uiText('plan.change.applying');
  if (cpUpdatingSpinner) cpUpdatingSpinner.style.display = 'flex';
  if (changePlanRefreshBtn) changePlanRefreshBtn.style.display = 'none';
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
    const json = ChangePlanHelpers.parseApiJson(
      await res.text(),
      uiText('plan.change.error.changeFailed')
    );

    if (!res.ok || !json.success) {
      if (ChangePlanHelpers.shouldOfferNewSubscription(json.code)) {
        _cpRenderResubscribe(targetPlan);
        return;
      }
      throw new Error(uiText('plan.change.error.changeFailed'));
    }

    // PATCH accepted — webhook is async, poll until plan is reflected
    changePlanTitle.textContent = uiText('plan.change.updating');
    changePlanUpdatingMsg.textContent = uiText('plan.change.applying');

    _cpPollCancel = ChangePlanHelpers.createPlanPoller(
      async () => { await refreshUserProfile(session); return currentUserPlan; },
      targetPlan,
      {
        maxAttempts: 5,
        intervalMs: 2000,
        onDone: () => { _cpPollCancel = null; closeChangePlanModal(); },
        onTimeout: () => {
          // PATCH already succeeded (Paddle accepted the change + charged). The
          // webhook is just slow to reflect locally — reassure, do NOT force reload.
          _cpPollCancel = null;
          changePlanIcon.textContent = '✅';
          changePlanTitle.textContent = uiText('plan.change.confirmed');
          if (cpUpdatingSpinner) cpUpdatingSpinner.style.display = 'none';
          changePlanUpdatingMsg.textContent = uiText('plan.change.confirmedPending');
          if (changePlanRefreshBtn) changePlanRefreshBtn.style.display = '';
        }
      }
    );
  } catch (err) {
    changePlanTitle.textContent = uiText('common.error.title');
    changePlanErrorMsg.textContent = err.message || uiText('plan.change.error.changeFailed');
    cpShowState(cpStateError);
  }
});

changePlanClose?.addEventListener('click', closeChangePlanModal);
changePlanCancelBtn?.addEventListener('click', closeChangePlanModal);
changePlanResubscribeCancelBtn?.addEventListener('click', closeChangePlanModal);
changePlanResubscribeBtn?.addEventListener('click', async () => {
  const targetPlan = _cpTargetPlan;
  if (!['pro', 'enterprise'].includes(targetPlan)) return;

  // Checkout is intentionally opened only after this explicit user action.
  changePlanResubscribeBtn.disabled = true;
  closeChangePlanModal();
  await handleCheckout(targetPlan);
});
changePlanDismissBtn?.addEventListener('click', closeChangePlanModal);
changePlanRefreshBtn?.addEventListener('click', () => window.location.reload());
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

document.addEventListener('promptgen:localechange', async () => {
  if (productCatalog) hydrateProductCatalog(productCatalog);
  updateAnalyzeButtonState();
  updatePricingButtons();
  if (state.result) renderAnalysis(state.result.analysis || {});
  const { data: { session } } = await sbClient.auth.getSession();
  if (session) await refreshUserProfile(session);
});
