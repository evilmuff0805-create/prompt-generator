'use strict';

const ANALYSIS_CREDIT_COST = 10;
const DEFAULT_STORYBOARD_CREDIT_COST = 120;
const DEFAULT_PADDLE_CLIENT_TOKEN = 'live_81a81f812ec882e5536a9188161';

const PLAN_CREDITS = Object.freeze({
  free: 0,
  pro: 1000,
  paid: 1000,
  enterprise: 4000
});

const PAID_PLAN_IDS = Object.freeze(['pro', 'enterprise', 'paid']);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positivePrice(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getStoryboardCreditCost(env = process.env) {
  return positiveInteger(env.STORYBOARD_CREDIT_COST, DEFAULT_STORYBOARD_CREDIT_COST);
}

function getPlanCredits(plan) {
  return PLAN_CREDITS[String(plan || '').toLowerCase()] || 0;
}

function isPaidPlan(plan) {
  return PAID_PLAN_IDS.includes(String(plan || '').toLowerCase());
}

function getPaddlePriceId(plan, env = process.env) {
  if (plan === 'pro') return env.PADDLE_PRO_PRICE_ID || null;
  if (plan === 'enterprise') return env.PADDLE_ENTERPRISE_PRICE_ID || null;
  return null;
}

function getPaddleCatalogMetadata(env = process.env) {
  const storyboardCreditCost = getStoryboardCreditCost(env);
  const planDefinitions = {
    pro: {
      productName: 'PromptGen AI Pro',
      audience: 'For individual creators.',
      priceName: 'Pro Monthly',
      monthlyPriceUsd: positivePrice(env.PADDLE_PRO_PRICE_USD, 9.99),
      credits: PLAN_CREDITS.pro
    },
    enterprise: {
      productName: 'PromptGen AI Enterprise',
      audience: 'For high-volume individual creators.',
      priceName: 'Enterprise Monthly',
      monthlyPriceUsd: positivePrice(env.PADDLE_ENTERPRISE_PRICE_USD, 19.99),
      credits: PLAN_CREDITS.enterprise,
      singleUserLabel: ' Single-user plan.'
    }
  };

  return Object.fromEntries(Object.entries(planDefinitions).map(([plan, metadata]) => {
    const storyboards = Math.floor(metadata.credits / storyboardCreditCost);
    const analyses = Math.floor(metadata.credits / ANALYSIS_CREDIT_COST);
    return [plan, {
      ...metadata,
      productDescription: `${metadata.audience} Includes ${metadata.credits.toLocaleString('en-US')} credits/month: up to ${storyboards} storyboards or ${analyses} image analyses.${metadata.singleUserLabel || ''} Credits reset at renewal and do not roll over.`,
      priceId: getPaddlePriceId(plan, env),
      unitAmount: String(Math.round(metadata.monthlyPriceUsd * 100)),
      currencyCode: 'USD',
      billingCycle: { interval: 'month', frequency: 1 },
      quantity: { minimum: 1, maximum: 1 },
      internalDescription: `${metadata.productName.replace('PromptGen AI ', '')} - $${metadata.monthlyPriceUsd.toFixed(2)}/month - ${metadata.credits.toLocaleString('en-US')} credits - up to ${storyboards} storyboards or ${analyses} analyses`
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
  const storyboardCreditCost = getStoryboardCreditCost(env);
  return {
    version: 1,
    analysisCreditCost: ANALYSIS_CREDIT_COST,
    storyboardCreditCost,
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
        monthlyPriceUsd: positivePrice(env.PADDLE_PRO_PRICE_USD, 9.99),
        credits: PLAN_CREDITS.pro,
        storyboardCreditCost
      }),
      enterprise: buildPlan({
        id: 'enterprise',
        name: 'Enterprise',
        description: 'For high-volume individual creators',
        monthlyPriceUsd: positivePrice(env.PADDLE_ENTERPRISE_PRICE_USD, 19.99),
        credits: PLAN_CREDITS.enterprise,
        storyboardCreditCost
      })
    },
    paddle: {
      clientToken: env.PADDLE_CLIENT_TOKEN || DEFAULT_PADDLE_CLIENT_TOKEN,
      priceIds: {
        pro: getPaddlePriceId('pro', env),
        enterprise: getPaddlePriceId('enterprise', env)
      }
    }
  };
}

module.exports = {
  ANALYSIS_CREDIT_COST,
  DEFAULT_STORYBOARD_CREDIT_COST,
  PLAN_CREDITS,
  PAID_PLAN_IDS,
  getStoryboardCreditCost,
  getPlanCredits,
  isPaidPlan,
  getPaddlePriceId,
  getPaddleCatalogMetadata,
  getPublicProductCatalog
};
