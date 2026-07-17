'use strict';

// Pure helpers — no DOM/browser deps. UMD: works in browser (window global) and Node (require).

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.ChangePlanHelpers = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const PLAN_CREDIT_LIMIT = { free: 0, pro: 1000, paid: 1000, enterprise: 4000 };
  const DEFAULT_API_ERROR = 'The billing service returned an invalid response. Please try again later.';

  /**
   * Parses an API response body without exposing HTML gateway/error pages to users.
   * Always returns an object so callers can use the same success/error path for
   * JSON errors, empty bodies, and non-JSON upstream responses.
   */
  function parseApiJson(text, fallbackError) {
    const fallback = {
      success: false,
      error: fallbackError || DEFAULT_API_ERROR,
      code: 'INVALID_RESPONSE'
    };

    if (typeof text !== 'string' || !text.trim()) return fallback;

    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
      return parsed;
    } catch (_) {
      return fallback;
    }
  }

  /**
   * Extracts display-ready charge info from a change-plan preview response body.
   * All monetary values returned in dollars (input is cents as string).
   * Returns null if data is falsy.
   */
  function parsePlanPreview(data) {
    if (!data) return null;
    const currency = data.currency_code || 'USD';

    const immRaw = data.immediate_transaction?.details?.totals?.grand_total;
    const recRaw = data.recurring_transaction_details?.totals?.grand_total;

    const immediateAmount  = (immRaw !== undefined && immRaw !== null) ? Number(immRaw) / 100 : null;
    const recurringAmount  = (recRaw !== undefined && recRaw !== null) ? Number(recRaw) / 100 : null;
    const immediateApplicable = immediateAmount !== null && immediateAmount > 0;

    return { immediateAmount, recurringAmount, currency, immediateApplicable };
  }

  /**
   * Determines whether a downgrade credit warning should be shown.
   * Uses LEAST(currentCredits, targetPlanLimit) — mirrors apply_plan_change RPC.
   * Returns { show, from, to }.
   */
  function calcCreditWarning(currentCredits, targetPlan, catalogLimit) {
    const limit = Number.isFinite(catalogLimit) ? catalogLimit : PLAN_CREDIT_LIMIT[targetPlan];
    if (limit === undefined) return { show: false, from: currentCredits, to: currentCredits };
    const to = Math.min(currentCredits, limit);
    return { show: to < currentCredits, from: currentCredits, to };
  }

  /**
   * Polls checkFn every intervalMs (max maxAttempts times).
   * Calls onDone when checkFn() resolves to targetPlan; onTimeout when exhausted.
   * Returns a cancel function.
   */
  function createPlanPoller(checkFn, targetPlan, options) {
    const { maxAttempts = 5, intervalMs = 2000, onDone, onTimeout } = options || {};
    let attempts = 0;
    const id = setInterval(async function () {
      attempts++;
      try {
        const current = await checkFn();
        if (current === targetPlan) {
          clearInterval(id);
          if (onDone) onDone();
          return;
        }
      } catch (_) { /* ignore transient check errors */ }
      if (attempts >= maxAttempts) {
        clearInterval(id);
        if (onTimeout) onTimeout();
      }
    }, intervalMs);
    return function cancel() { clearInterval(id); };
  }

  return {
    parseApiJson,
    parsePlanPreview,
    calcCreditWarning,
    createPlanPoller,
    PLAN_CREDIT_LIMIT,
    DEFAULT_API_ERROR
  };
}));
