'use strict';

const CREDIT_POLICY_VERSION = 2;
const ANALYSIS_CREDIT_COST = 2;
const STORYBOARD_BASE_CREDIT_COST = 30;
const STORYBOARD_REFERENCE_CREDIT_COST = 5;
const STORYBOARD_MAX_REFERENCES = 4;
const DEFAULT_PRO_PRICE_USD = 9.99;
const PRO_1099_PRICE_USD = 10.99;
const DEFAULT_ENTERPRISE_PRICE_USD = 19.99;
// Backwards-compatible export for callers/tests that still use the old name.
const DEFAULT_STORYBOARD_CREDIT_COST = STORYBOARD_BASE_CREDIT_COST;
const DEFAULT_PADDLE_CLIENT_TOKEN = 'live_81a81f812ec882e5536a9188161';

const PLAN_CREDITS = Object.freeze({
  free: 0,
  pro: 600,
  paid: 600,
  enterprise: 1500
});

const PAID_PLAN_IDS = Object.freeze(['pro', 'enterprise', 'paid']);
const PADDLE_PLAN_PRICE_ENV = Object.freeze({
  pro: Object.freeze({
    current: 'PADDLE_PRO_PRICE_ID',
    stagedCurrent: 'PADDLE_PRO_1099_PRICE_ID',
    stagedFlag: 'PRO_PRICE_1099_ENABLED',
    legacy: 'PADDLE_PRO_LEGACY_PRICE_IDS'
  }),
  enterprise: Object.freeze({
    current: 'PADDLE_ENTERPRISE_PRICE_ID',
    legacy: 'PADDLE_ENTERPRISE_LEGACY_PRICE_IDS'
  })
});

function positivePrice(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getStoryboardCreditCost() {
  return STORYBOARD_BASE_CREDIT_COST;
}

function calculateStoryboardCreditCost(referenceCount = 0) {
  const parsedCount = Number(referenceCount);
  if (!Number.isInteger(parsedCount) || parsedCount < 0 || parsedCount > STORYBOARD_MAX_REFERENCES) {
    const error = new RangeError(`referenceCount must be an integer between 0 and ${STORYBOARD_MAX_REFERENCES}`);
    error.code = 'INVALID_REFERENCE_COUNT';
    throw error;
  }
  return STORYBOARD_BASE_CREDIT_COST + (parsedCount * STORYBOARD_REFERENCE_CREDIT_COST);
}

function getPlanCredits(plan) {
  return PLAN_CREDITS[String(plan || '').toLowerCase()] || 0;
}

function isPaidPlan(plan) {
  return PAID_PLAN_IDS.includes(String(plan || '').toLowerCase());
}

function normalizePaddlePriceId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function parsePaddlePriceIds(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(
    value
      .split(',')
      .map(normalizePaddlePriceId)
      .filter(Boolean)
  )];
}

function isPro1099Enabled(env = process.env) {
  return String(env.PRO_PRICE_1099_ENABLED || '').trim().toLowerCase() === 'true';
}

function getProMonthlyPriceUsd(env = process.env) {
  return isPro1099Enabled(env) ? PRO_1099_PRICE_USD : DEFAULT_PRO_PRICE_USD;
}

function getPaddlePriceId(plan, env = process.env) {
  const normalizedPlan = String(plan || '').toLowerCase();
  const config = PADDLE_PLAN_PRICE_ENV[normalizedPlan];
  if (!config) return null;
  if (normalizedPlan === 'pro' && isPro1099Enabled(env)) {
    return normalizePaddlePriceId(env[config.stagedCurrent]);
  }
  return normalizePaddlePriceId(env[config.current]);
}

function getAcceptedPaddlePriceIds(plan, env = process.env) {
  const normalizedPlan = String(plan || '').toLowerCase();
  const config = PADDLE_PLAN_PRICE_ENV[normalizedPlan];
  if (!config) return [];

  const current = getPaddlePriceId(normalizedPlan, env);
  const stableCurrent = normalizePaddlePriceId(env[config.current]);
  const stagedCurrent = normalizePaddlePriceId(env[config.stagedCurrent]);
  return [...new Set([
    current,
    stableCurrent,
    stagedCurrent,
    ...parsePaddlePriceIds(env[config.legacy])
  ].filter(Boolean))];
}

function validateProPriceCutover(env = process.env) {
  if (!isPro1099Enabled(env)) return;

  const stablePriceId = normalizePaddlePriceId(env.PADDLE_PRO_PRICE_ID);
  const stagedPriceId = normalizePaddlePriceId(env.PADDLE_PRO_1099_PRICE_ID);
  const explicitLegacyIds = parsePaddlePriceIds(env.PADDLE_PRO_LEGACY_PRICE_IDS);

  if (!stablePriceId) {
    const error = new Error(
      '[paddle] PRO_PRICE_1099_ENABLED requires PADDLE_PRO_PRICE_ID for legacy renewals'
    );
    error.code = 'PADDLE_PRO_LEGACY_PRICE_ID_MISSING';
    throw error;
  }
  if (!stagedPriceId) {
    const error = new Error(
      '[paddle] PRO_PRICE_1099_ENABLED requires PADDLE_PRO_1099_PRICE_ID'
    );
    error.code = 'PADDLE_PRO_1099_PRICE_ID_MISSING';
    throw error;
  }
  if (stagedPriceId === stablePriceId || explicitLegacyIds.includes(stagedPriceId)) {
    const error = new Error(
      '[paddle] PADDLE_PRO_1099_PRICE_ID must be distinct from the existing Pro price IDs'
    );
    error.code = 'PADDLE_PRO_1099_PRICE_ID_CONFLICT';
    error.priceId = stagedPriceId;
    throw error;
  }
}

function validatePaddlePriceMappings(env = process.env) {
  validateProPriceCutover(env);
  const owners = new Map();

  for (const plan of Object.keys(PADDLE_PLAN_PRICE_ENV)) {
    for (const priceId of getAcceptedPaddlePriceIds(plan, env)) {
      const existingPlan = owners.get(priceId);
      if (existingPlan && existingPlan !== plan) {
        const error = new Error(
          `[paddle] Price ID ${priceId} is configured for both ${existingPlan} and ${plan}`
        );
        error.code = 'PADDLE_PRICE_ID_CONFLICT';
        error.priceId = priceId;
        error.plans = [existingPlan, plan];
        throw error;
      }
      owners.set(priceId, plan);
    }
  }

  return Object.freeze(Object.fromEntries(owners));
}

function getPlanForPaddlePriceId(priceId, env = process.env) {
  const normalizedPriceId = normalizePaddlePriceId(priceId);
  if (!normalizedPriceId) return null;
  const mappings = validatePaddlePriceMappings(env);
  return mappings[normalizedPriceId] || null;
}

function getPaddleCatalogMetadata(env = process.env) {
  const storyboardCreditCost = getStoryboardCreditCost();
  const planDefinitions = {
    pro: {
      productName: 'PromptGen AI Pro',
      audience: 'For individual creators.',
      priceName: 'Pro Monthly',
      monthlyPriceUsd: getProMonthlyPriceUsd(env),
      credits: PLAN_CREDITS.pro
    },
    enterprise: {
      productName: 'PromptGen AI Enterprise',
      audience: 'For high-volume individual creators.',
      priceName: 'Enterprise Monthly',
      monthlyPriceUsd: positivePrice(env.PADDLE_ENTERPRISE_PRICE_USD, DEFAULT_ENTERPRISE_PRICE_USD),
      credits: PLAN_CREDITS.enterprise,
      singleUserLabel: ' Single-user plan.'
    }
  };

  return Object.fromEntries(Object.entries(planDefinitions).map(([plan, metadata]) => {
    const storyboards = Math.floor(metadata.credits / storyboardCreditCost);
    const analyses = Math.floor(metadata.credits / ANALYSIS_CREDIT_COST);
    return [plan, {
      ...metadata,
      productDescription: `${metadata.audience} Includes ${metadata.credits.toLocaleString('en-US')} credits/month: up to ${storyboards} base-cost storyboards (30 credits; +5 per reference image, max 4) or ${analyses} image analyses.${metadata.singleUserLabel || ''} Credits reset at renewal and do not roll over.`,
      priceId: getPaddlePriceId(plan, env),
      unitAmount: String(Math.round(metadata.monthlyPriceUsd * 100)),
      currencyCode: 'USD',
      billingCycle: { interval: 'month', frequency: 1 },
      quantity: { minimum: 1, maximum: 1 },
      internalDescription: `${metadata.productName.replace('PromptGen AI ', '')} - $${metadata.monthlyPriceUsd.toFixed(2)}/month - ${metadata.credits.toLocaleString('en-US')} credits - up to ${storyboards} base-cost storyboards or ${analyses} analyses`
    }];
  }));
}

function buildPlan({ id, name, description, monthlyPriceUsd, credits, storyboardCreditCost }) {
  return {
    id,
    name,
    description,
    monthlyPriceUsd,
    billingInterval: id === 'free' ? null : 'month',
    credits,
    imageAnalyses: credits > 0 ? Math.floor(credits / ANALYSIS_CREDIT_COST) : null,
    storyboards: credits > 0 ? Math.floor(credits / storyboardCreditCost) : null,
    singleUser: true,
    features: id === 'free'
      ? ['image_to_prompt', 'bracket_editing', 'suggestion_chips', 'endframe_extractor']
      : ['image_to_prompt', 'bracket_editing', 'suggestion_chips', 'endframe_extractor', 'storyboard_generator']
  };
}

function getPublicProductCatalog(env = process.env) {
  const storyboardCreditCost = getStoryboardCreditCost();
  return {
    version: CREDIT_POLICY_VERSION,
    creditPolicyVersion: CREDIT_POLICY_VERSION,
    analysisCreditCost: ANALYSIS_CREDIT_COST,
    storyboardCreditCost,
    storyboardCreditPolicy: {
      baseCost: STORYBOARD_BASE_CREDIT_COST,
      perReferenceCost: STORYBOARD_REFERENCE_CREDIT_COST,
      maxReferences: STORYBOARD_MAX_REFERENCES,
      minCost: STORYBOARD_BASE_CREDIT_COST,
      maxCost: calculateStoryboardCreditCost(STORYBOARD_MAX_REFERENCES)
    },
    creditPolicy: {
      renewal: 'reset_to_plan_allotment',
      rollover: false
    },
    plans: {
      free: buildPlan({
        id: 'free',
        name: 'Free',
        description: 'For trying the core tools',
        monthlyPriceUsd: 0,
        credits: 0,
        storyboardCreditCost
      }),
      pro: buildPlan({
        id: 'pro',
        name: 'Pro',
        description: 'For individual creators',
        monthlyPriceUsd: getProMonthlyPriceUsd(env),
        credits: PLAN_CREDITS.pro,
        storyboardCreditCost
      }),
      enterprise: buildPlan({
        id: 'enterprise',
        name: 'Enterprise',
        description: 'For high-volume individual creators',
        monthlyPriceUsd: positivePrice(env.PADDLE_ENTERPRISE_PRICE_USD, DEFAULT_ENTERPRISE_PRICE_USD),
        credits: PLAN_CREDITS.enterprise,
        storyboardCreditCost
      })
    },
    paddle: {
      clientToken: env.PADDLE_CLIENT_TOKEN || DEFAULT_PADDLE_CLIENT_TOKEN
    }
  };
}

module.exports = {
  CREDIT_POLICY_VERSION,
  ANALYSIS_CREDIT_COST,
  STORYBOARD_BASE_CREDIT_COST,
  STORYBOARD_REFERENCE_CREDIT_COST,
  STORYBOARD_MAX_REFERENCES,
  DEFAULT_PRO_PRICE_USD,
  PRO_1099_PRICE_USD,
  DEFAULT_ENTERPRISE_PRICE_USD,
  DEFAULT_STORYBOARD_CREDIT_COST,
  PLAN_CREDITS,
  PAID_PLAN_IDS,
  PADDLE_PLAN_PRICE_ENV,
  getStoryboardCreditCost,
  calculateStoryboardCreditCost,
  getPlanCredits,
  isPaidPlan,
  isPro1099Enabled,
  getProMonthlyPriceUsd,
  getPaddlePriceId,
  getAcceptedPaddlePriceIds,
  getPlanForPaddlePriceId,
  validateProPriceCutover,
  validatePaddlePriceMappings,
  getPaddleCatalogMetadata,
  getPublicProductCatalog
};
