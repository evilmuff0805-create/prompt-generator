'use strict';

(function () {
  const STORAGE_KEY = 'promptgen:storyboard-progress:v1';
  const POLL_INTERVAL_MS = 8000;
  const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
  const ACTIVE_STATUSES = new Set(['pending', 'processing']);
  const TERMINAL_STATUSES = new Set(['completed', 'failed']);
  const fallbackText = {
    'storyboardProgress.starting': 'Starting Storyboard…',
    'storyboardProgress.startingHint': 'Please wait until the secure handoff finishes.',
    'storyboardProgress.generating': 'Storyboard generating…',
    'storyboardProgress.generatingMultiple': '{count} Storyboards generating…',
    'storyboardProgress.ready': 'Your Storyboard is ready.',
    'storyboardProgress.failed': 'Storyboard generation failed.',
    'storyboardProgress.open': 'Open',
    'storyboardProgress.dismiss': 'Dismiss'
  };

  let submissionPending = false;
  let refreshInFlight = null;
  let pollTimer = null;
  let indicator = null;
  let message = null;
  let hint = null;
  let openLink = null;
  let dismissButton = null;
  let spinner = null;

  function text(key, values = {}) {
    let value = window.PromptGenI18n?.t(key, values) || fallbackText[key] || key;
    Object.entries(values).forEach(([name, replacement]) => {
      value = value.replaceAll(`{${name}}`, String(replacement));
    });
    return value;
  }

  function emptyState(userId = null) {
    return { userId, jobs: [] };
  }

  function sanitizeJob(job) {
    if (!job || typeof job.id !== 'string' || !/^sb_[a-zA-Z0-9]+$/.test(job.id)) return null;
    const status = String(job.status || 'pending').toLowerCase();
    if (!ACTIVE_STATUSES.has(status) && !TERMINAL_STATUSES.has(status)) return null;
    return {
      id: job.id,
      status,
      progress: Math.max(0, Math.min(1, Number(job.progress) || 0)),
      createdAt: job.createdAt || job.created_at || new Date().toISOString(),
      updatedAt: job.updatedAt || job.updated_at || new Date().toISOString()
    };
  }

  function readState() {
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return emptyState();
      return {
        userId: typeof parsed.userId === 'string' ? parsed.userId : null,
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map(sanitizeJob).filter(Boolean).slice(0, 5) : []
      };
    } catch {
      return emptyState();
    }
  }

  function writeState(state) {
    const jobs = state.jobs
      .map(sanitizeJob)
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);
    const next = { userId: state.userId || null, jobs };
    try {
      if (next.userId && next.jobs.length) {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } else {
        window.sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // The server job remains durable even when browser storage is blocked.
    }
    return next;
  }

  function mergeJobs(state, jobs) {
    const byId = new Map(state.jobs.map(job => [job.id, job]));
    jobs.map(sanitizeJob).filter(Boolean).forEach(job => {
      byId.set(job.id, { ...(byId.get(job.id) || {}), ...job });
    });
    state.jobs = [...byId.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);
    return state;
  }

  async function getAuthContext() {
    if (typeof window.PromptGenGetAuthContext !== 'function') return null;
    try {
      const context = await window.PromptGenGetAuthContext();
      if (!context?.token || !context?.userId) return null;
      return { token: context.token, userId: context.userId };
    } catch {
      return null;
    }
  }

  async function fetchJson(path, token) {
    const response = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (response.status === 401) return { unauthorized: true };
    if (response.status === 404) return { notFound: true };
    if (!response.ok) throw new Error(`Storyboard progress request failed (${response.status})`);
    return response.json();
  }

  function ensureIndicator() {
    if (indicator) return;
    indicator = document.createElement('aside');
    indicator.id = 'storyboardGlobalProgress';
    indicator.className = 'storyboard-global-progress';
    indicator.hidden = true;
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');
    indicator.innerHTML = `
      <span class="storyboard-global-progress__spinner" aria-hidden="true"></span>
      <span class="storyboard-global-progress__copy">
        <strong class="storyboard-global-progress__message"></strong>
        <span class="storyboard-global-progress__hint"></span>
      </span>
      <a class="storyboard-global-progress__open"></a>
      <button type="button" class="storyboard-global-progress__dismiss"></button>
    `;
    message = indicator.querySelector('.storyboard-global-progress__message');
    hint = indicator.querySelector('.storyboard-global-progress__hint');
    openLink = indicator.querySelector('.storyboard-global-progress__open');
    dismissButton = indicator.querySelector('.storyboard-global-progress__dismiss');
    spinner = indicator.querySelector('.storyboard-global-progress__spinner');
    dismissButton.addEventListener('click', dismissTerminalJobs);
    document.body.appendChild(indicator);
  }

  function latestJob(jobs) {
    return [...jobs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  }

  function render() {
    ensureIndicator();
    const state = readState();
    const activeJobs = state.jobs.filter(job => ACTIVE_STATUSES.has(job.status));
    const terminalJob = latestJob(state.jobs.filter(job => TERMINAL_STATUSES.has(job.status)));

    indicator.classList.remove(
      'storyboard-global-progress--starting',
      'storyboard-global-progress--active',
      'storyboard-global-progress--ready',
      'storyboard-global-progress--failed'
    );

    if (submissionPending) {
      indicator.hidden = false;
      indicator.classList.add('storyboard-global-progress--starting');
      message.textContent = text('storyboardProgress.starting');
      hint.textContent = text('storyboardProgress.startingHint');
      spinner.hidden = false;
      openLink.hidden = true;
      dismissButton.hidden = true;
      return;
    }

    if (activeJobs.length) {
      const current = latestJob(activeJobs);
      indicator.hidden = false;
      indicator.classList.add('storyboard-global-progress--active');
      message.textContent = activeJobs.length > 1
        ? text('storyboardProgress.generatingMultiple', { count: activeJobs.length })
        : text('storyboardProgress.generating');
      hint.textContent = '';
      spinner.hidden = false;
      openLink.hidden = false;
      openLink.href = `/storyboard/${encodeURIComponent(current.id)}`;
      openLink.textContent = text('storyboardProgress.open');
      dismissButton.hidden = true;
      return;
    }

    if (terminalJob) {
      const failed = terminalJob.status === 'failed';
      indicator.hidden = false;
      indicator.classList.add(failed
        ? 'storyboard-global-progress--failed'
        : 'storyboard-global-progress--ready');
      message.textContent = text(failed ? 'storyboardProgress.failed' : 'storyboardProgress.ready');
      hint.textContent = '';
      spinner.hidden = true;
      openLink.hidden = false;
      openLink.href = `/storyboard/${encodeURIComponent(terminalJob.id)}`;
      openLink.textContent = text('storyboardProgress.open');
      dismissButton.hidden = false;
      dismissButton.textContent = '×';
      dismissButton.setAttribute('aria-label', text('storyboardProgress.dismiss'));
      return;
    }

    indicator.hidden = true;
  }

  function scheduleRefresh(hasActiveJobs) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!hasActiveJobs) return;
    pollTimer = setTimeout(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
      } else {
        scheduleRefresh(true);
      }
    }, POLL_INTERVAL_MS);
  }

  async function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const context = await getAuthContext();
      if (!context) {
        if (indicator) indicator.hidden = true;
        scheduleRefresh(false);
        return;
      }

      let state = readState();
      if (state.userId && state.userId !== context.userId) {
        state = writeState(emptyState());
      }
      state.userId = context.userId;

      let activeItems = [];
      try {
        const active = await fetchJson('/api/storyboard/active', context.token);
        if (active.unauthorized) {
          if (indicator) indicator.hidden = true;
          scheduleRefresh(false);
          return;
        }
        activeItems = Array.isArray(active.items) ? active.items : [];
        mergeJobs(state, activeItems);
      } catch {
        // Preserve the last safe client state. A status network error never
        // changes the durable server job.
      }

      const activeIds = new Set(activeItems.map(item => item.id));
      const unresolved = state.jobs.filter(job => ACTIVE_STATUSES.has(job.status) && !activeIds.has(job.id));
      await Promise.all(unresolved.map(async job => {
        try {
          const status = await fetchJson(`/api/storyboard/${encodeURIComponent(job.id)}/status`, context.token);
          if (status.notFound) {
            state.jobs = state.jobs.filter(candidate => candidate.id !== job.id);
          } else if (!status.unauthorized) {
            mergeJobs(state, [{
              id: job.id,
              status: status.status,
              progress: status.progress,
              createdAt: job.createdAt,
              updatedAt: new Date().toISOString()
            }]);
          }
        } catch {
          // Preserve the active record and retry later.
        }
      }));

      const cutoff = Date.now() - TERMINAL_RETENTION_MS;
      state.jobs = state.jobs.filter(job => (
        ACTIVE_STATUSES.has(job.status)
        || new Date(job.updatedAt || job.createdAt).getTime() >= cutoff
      ));
      state = writeState(state);
      render();
      scheduleRefresh(state.jobs.some(job => ACTIVE_STATUSES.has(job.status)));
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  function startSubmission() {
    submissionPending = true;
    render();
  }

  function finishSubmission() {
    submissionPending = false;
    render();
  }

  async function acceptJob(jobId) {
    const job = sanitizeJob({
      id: jobId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    if (!job) {
      finishSubmission();
      return false;
    }
    const context = await getAuthContext();
    if (!context) {
      finishSubmission();
      return false;
    }
    let state = readState();
    if (state.userId !== context.userId) state = emptyState(context.userId);
    mergeJobs(state, [job]);
    writeState(state);
    submissionPending = false;
    render();
    scheduleRefresh(true);
    return true;
  }

  function markViewed(jobId) {
    const state = readState();
    state.jobs = state.jobs.filter(job => job.id !== jobId);
    writeState(state);
    render();
    scheduleRefresh(state.jobs.some(job => ACTIVE_STATUSES.has(job.status)));
  }

  function dismissTerminalJobs() {
    const state = readState();
    state.jobs = state.jobs.filter(job => !TERMINAL_STATUSES.has(job.status));
    writeState(state);
    render();
  }

  function guardPendingNavigation(event) {
    if (!submissionPending) return;
    const link = event.target.closest?.('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    let destination;
    try {
      destination = new URL(link.href, window.location.href);
    } catch {
      return;
    }
    if (destination.origin !== window.location.origin) return;
    event.preventDefault();
    event.stopPropagation();
    render();
  }

  function guardPendingUnload(event) {
    if (!submissionPending) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function init() {
    ensureIndicator();
    document.addEventListener('click', guardPendingNavigation, true);
    window.addEventListener('beforeunload', guardPendingUnload);
    window.addEventListener('promptgen:auth-context-change', () => void refresh());
    document.addEventListener('promptgen:localechange', render);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refresh();
    });
    render();
    void refresh();
  }

  window.PromptGenStoryboardProgress = {
    startSubmission,
    finishSubmission,
    acceptJob,
    markViewed,
    refresh
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
