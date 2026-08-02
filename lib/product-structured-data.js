'use strict';

const STRUCTURED_DATA_PATTERN =
  /(<script id="productStructuredData" type="application\/ld\+json">)([\s\S]*?)(<\/script>)/;
const PLAN_IDS = Object.freeze(['free', 'pro', 'enterprise']);

function structuredDataError(message) {
  const error = new Error(`[structured-data] ${message}`);
  error.code = 'INVALID_PRODUCT_STRUCTURED_DATA';
  return error;
}

function applyProductCatalogToStructuredData(html, catalog) {
  if (typeof html !== 'string' || !catalog?.plans) {
    throw structuredDataError('HTML and product catalog are required');
  }

  let matched = false;
  const rendered = html.replace(
    STRUCTURED_DATA_PATTERN,
    (fullMatch, openingTag, jsonText, closingTag) => {
      matched = true;

      let document;
      try {
        document = JSON.parse(jsonText);
      } catch (_) {
        throw structuredDataError('productStructuredData must contain valid JSON');
      }

      if (!Array.isArray(document.offers)) {
        throw structuredDataError('productStructuredData must contain an offers array');
      }

      for (const planId of PLAN_IDS) {
        const plan = catalog.plans[planId];
        if (
          !plan
          || typeof plan.name !== 'string'
          || !Number.isFinite(plan.monthlyPriceUsd)
          || plan.monthlyPriceUsd < 0
        ) {
          throw structuredDataError(`catalog plan ${planId} is invalid`);
        }

        const matchingOffers = document.offers.filter(
          offer => offer?.name === plan.name
        );
        if (matchingOffers.length !== 1) {
          throw structuredDataError(
            `expected exactly one structured offer for ${plan.name}`
          );
        }

        matchingOffers[0].price = plan.monthlyPriceUsd === 0
          ? '0'
          : plan.monthlyPriceUsd.toFixed(2);
        matchingOffers[0].priceCurrency = 'USD';
      }

      return `${openingTag}\n${JSON.stringify(document, null, 2)}\n  ${closingTag}`;
    }
  );

  if (!matched) {
    throw structuredDataError('productStructuredData script was not found');
  }

  return rendered;
}

function applyProductCatalogToVisiblePricing(html, catalog) {
  if (typeof html !== 'string' || !catalog?.plans) {
    throw structuredDataError('HTML and product catalog are required');
  }

  let rendered = html;

  for (const planId of PLAN_IDS) {
    const plan = catalog.plans[planId];
    if (
      !plan
      || !Number.isFinite(plan.monthlyPriceUsd)
      || plan.monthlyPriceUsd < 0
    ) {
      throw structuredDataError(`catalog plan ${planId} is invalid`);
    }

    const markerPattern = new RegExp(
      `(<span\\b(?=[^>]*\\bdata-catalog-price-fallback="${planId}")[^>]*>)([^<]*)(<\\/span>)`,
      'g'
    );
    const matches = [...rendered.matchAll(markerPattern)];
    if (matches.length !== 1) {
      throw structuredDataError(
        `expected exactly one visible price marker for ${planId}`
      );
    }

    const cardPattern = new RegExp(
      `<!-- catalog-plan:${planId}:start -->([\\s\\S]*?)<!-- catalog-plan:${planId}:end -->`,
      'g'
    );
    const cardMatches = [...rendered.matchAll(cardPattern)];
    if (cardMatches.length !== 1) {
      throw structuredDataError(
        `expected exactly one visible pricing card contract for ${planId}`
      );
    }
    const cardHtml = cardMatches[0][1];
    const cardPlanMatches = [
      ...cardHtml.matchAll(new RegExp(`data-catalog-plan="${planId}"`, 'g'))
    ];
    const markerIds = [
      ...cardHtml.matchAll(/data-catalog-price-fallback="([^"]+)"/g)
    ].map((match) => match[1]);
    if (
      cardPlanMatches.length !== 1
      || markerIds.length !== 1
      || markerIds[0] !== planId
    ) {
      throw structuredDataError(
        `visible price marker for ${planId} must belong to its pricing card`
      );
    }
    const ownedPricePattern = new RegExp(
      `<span\\b(?=[^>]*\\bdata-catalog-field="price")(?=[^>]*\\bdata-catalog-price-fallback="${planId}")[^>]*>[^<]*<\\/span>`,
      'g'
    );
    if ([...cardHtml.matchAll(ownedPricePattern)].length !== 1) {
      throw structuredDataError(
        `visible price marker for ${planId} must be a price field`
      );
    }

    const visiblePrice = plan.monthlyPriceUsd === 0
      ? '$0'
      : `$${plan.monthlyPriceUsd.toFixed(2)}`;
    rendered = rendered.replace(
      markerPattern,
      (fullMatch, openingTag, currentPrice, closingTag) => (
        `${openingTag}${visiblePrice}${closingTag}`
      )
    );
  }

  return rendered;
}

module.exports = {
  applyProductCatalogToStructuredData,
  applyProductCatalogToVisiblePricing
};
