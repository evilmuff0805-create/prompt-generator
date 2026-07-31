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

module.exports = {
  applyProductCatalogToStructuredData
};
