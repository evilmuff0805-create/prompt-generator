'use strict';

const fs = require('fs');
const path = require('path');
const {
  ANALYSIS_CREDIT_COST,
  PLAN_CREDITS,
  getStoryboardCreditCost,
  getPlanCredits,
  isPaidPlan,
  getPaddlePriceId,
  getPaddleCatalogMetadata,
  getPublicProductCatalog
} = require('../../lib/product-catalog');

const projectRoot = path.join(__dirname, '..', '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('public product catalog', () => {
  test('default prices, credits, costs, and maximum usage counts stay internally consistent', () => {
    const catalog = getPublicProductCatalog({});

    expect(ANALYSIS_CREDIT_COST).toBe(10);
    expect(getStoryboardCreditCost({})).toBe(120);
    expect(catalog.creditPolicy).toEqual({ renewal: 'reset_to_plan_allotment', rollover: false });
    expect(catalog.plans.pro).toMatchObject({
      name: 'Pro', monthlyPriceUsd: 9.99, credits: 1000,
      imageAnalyses: 100, storyboards: 8, singleUser: true
    });
    expect(catalog.plans.enterprise).toMatchObject({
      name: 'Enterprise',
      description: 'For high-volume individual creators',
      monthlyPriceUsd: 19.99, credits: 4000,
      imageAnalyses: 400, storyboards: 33, singleUser: true
    });
  });

  test('Paddle public checkout configuration comes from server environment values', () => {
    const env = {
      PADDLE_CLIENT_TOKEN: 'live_public_test_token',
      PADDLE_PRO_PRICE_ID: 'pri_pro_live',
      PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise_live',
      PADDLE_PRO_PRICE_USD: '12.50',
      PADDLE_ENTERPRISE_PRICE_USD: '24.50',
      STORYBOARD_CREDIT_COST: '125'
    };
    const catalog = getPublicProductCatalog(env);

    expect(catalog.paddle).toEqual({
      clientToken: 'live_public_test_token',
      priceIds: { pro: 'pri_pro_live', enterprise: 'pri_enterprise_live' }
    });
    expect(catalog.plans.pro.monthlyPriceUsd).toBe(12.5);
    expect(catalog.plans.pro.storyboards).toBe(8);
    expect(catalog.plans.enterprise.storyboards).toBe(32);
    expect(getPaddlePriceId('pro', env)).toBe('pri_pro_live');
  });

  test('paid alias and paid-plan gates map to the Pro allotment without changing persisted plan IDs', () => {
    expect(PLAN_CREDITS).toMatchObject({ pro: 1000, paid: 1000, enterprise: 4000 });
    expect(getPlanCredits('paid')).toBe(1000);
    expect(isPaidPlan('pro')).toBe(true);
    expect(isPaidPlan('enterprise')).toBe(true);
    expect(isPaidPlan('paid')).toBe(true);
    expect(isPaidPlan('free')).toBe(false);
  });

  test('canonical Paddle metadata matches public prices and contains only implemented promises', () => {
    const metadata = getPaddleCatalogMetadata({
      PADDLE_PRO_PRICE_ID: 'pri_pro_live',
      PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise_live'
    });

    expect(metadata.pro).toMatchObject({
      productName: 'PromptGen AI Pro',
      priceName: 'Pro Monthly',
      unitAmount: '999',
      currencyCode: 'USD',
      billingCycle: { interval: 'month', frequency: 1 },
      quantity: { minimum: 1, maximum: 1 },
      priceId: 'pri_pro_live'
    });
    expect(metadata.enterprise).toMatchObject({
      productName: 'PromptGen AI Enterprise',
      priceName: 'Enterprise Monthly',
      unitAmount: '1999',
      priceId: 'pri_enterprise_live'
    });

    const salesCopy = JSON.stringify(metadata);
    expect(salesCopy).not.toMatch(/teams and businesses|api access|custom models|team dashboard|priority (support|processing)/i);
    expect(metadata.pro.productDescription).toContain('up to 8 storyboards or 100 image analyses');
    expect(metadata.enterprise.productDescription).toContain('Single-user plan');

    const alternateCost = getPaddleCatalogMetadata({ STORYBOARD_CREDIT_COST: '125' });
    expect(alternateCost.enterprise.productDescription).toContain('up to 32 storyboards');
    expect(alternateCost.enterprise.internalDescription).toContain('up to 32 storyboards');
  });
});

describe('public sales-copy regression gate', () => {
  const indexHtml = readProjectFile('public/index.html');
  const termsHtml = readProjectFile('public/terms.html');
  const refundHtml = readProjectFile('public/refund.html');
  const browserApp = readProjectFile('public/app.js');

  test('landing makes the PromptGen/Seedance boundary explicit and does not promise finished video generation', () => {
    expect(indexHtml).toContain('Final video generation happens in Seedance.');
    expect(indexHtml).toContain('use those prompts in Seedance to generate the final video');
    expect(indexHtml).not.toMatch(/From a Single Image to a Finished Video/i);
    expect(indexHtml).not.toMatch(/your 15-second video is ready/i);
  });

  test('pricing contains only implemented single-user capabilities and accurate renewal behavior', () => {
    const catalog = getPublicProductCatalog({});
    expect(indexHtml).toContain('id="productStructuredData"');
    expect(indexHtml).toContain('data-catalog-plan="pro"');
    expect(indexHtml).toContain('data-catalog-plan="enterprise"');
    expect(indexHtml).toContain(`$${catalog.plans.pro.monthlyPriceUsd.toFixed(2)}`);
    expect(indexHtml).toContain(`$${catalog.plans.enterprise.monthlyPriceUsd.toFixed(2)}`);
    expect(indexHtml).toContain(`${catalog.plans.pro.credits.toLocaleString('en-US')} credits reset each billing month`);
    expect(indexHtml).toContain(`Up to ${catalog.plans.enterprise.storyboards} storyboards`);
    expect(indexHtml).toContain('Single-user plan');
    expect(indexHtml).toContain('Credits reset to the plan allotment at renewal and do not roll over.');
    expect(indexHtml).not.toMatch(/For teams and businesses/i);
    expect(indexHtml).not.toMatch(/✓\s*(API access|Custom models|Team dashboard|Priority support)/i);
  });

  test('terms and refund copy describe monthly subscriptions, reset/no-rollover, and Paddle as Merchant of Record', () => {
    expect(termsHtml).toContain('Monthly single-user subscription with 1,000 credits per billing cycle');
    expect(termsHtml).toContain('unused credits do not roll over');
    expect(termsHtml).toContain('PromptGen does not itself generate the final video');
    expect(refundHtml).toContain('monthly subscriptions, not one-time credit bundles');
    expect(refundHtml).toContain('Paddle is the seller and Merchant of Record');
    expect(refundHtml).toContain('Nothing in this policy limits mandatory rights');
    expect(refundHtml).not.toMatch(/More than 7 days have passed/i);
  });

  test('browser checkout no longer hardcodes live Paddle price IDs or client tokens', () => {
    expect(browserApp).not.toMatch(/pri_[a-zA-Z0-9]+/);
    expect(browserApp).not.toMatch(/live_[a-zA-Z0-9]+/);
    expect(browserApp).toContain("fetch('/api/catalog')");
    expect(browserApp).toContain('hydrateProductCatalog(productCatalog)');
    expect(browserApp).toContain('catalog?.paddle?.priceIds?.[plan]');
  });

  test('landing code assets use the deployment version placeholder', () => {
    expect(indexHtml).toContain('/style.css?v=__ASSET_VERSION__');
    expect(indexHtml).toContain('/js/changePlan-helpers.js?v=__ASSET_VERSION__');
    expect(indexHtml).toContain('/app.js?v=__ASSET_VERSION__');
  });
});
