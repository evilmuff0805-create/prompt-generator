'use strict';

const fs = require('fs');
const path = require('path');
const {
  getPublicProductCatalog
} = require('../../lib/product-catalog');
const {
  applyProductCatalogToStructuredData,
  applyProductCatalogToVisiblePricing
} = require('../../lib/product-structured-data');

const indexHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'index.html'),
  'utf8'
);

function readStructuredData(html) {
  const match = html.match(
    /<script id="productStructuredData" type="application\/ld\+json">([\s\S]*?)<\/script>/
  );
  return JSON.parse(match[1]);
}

function readVisiblePrices(html) {
  return Object.fromEntries(
    [...html.matchAll(
      /data-catalog-price-fallback="(free|pro|enterprise)"[^>]*>([^<]*)<\/span>/g
    )].map((match) => [match[1], match[2]])
  );
}

describe('product structured data pricing', () => {
  test('uses the default USD 9.99 Pro catalog before cutover', () => {
    const rendered = applyProductCatalogToStructuredData(
      indexHtml,
      getPublicProductCatalog({})
    );
    const offers = readStructuredData(rendered).offers;

    expect(offers.find(offer => offer.name === 'Free').price).toBe('0');
    expect(offers.find(offer => offer.name === 'Pro').price).toBe('9.99');
    expect(offers.find(offer => offer.name === 'Enterprise').price).toBe('19.99');
  });

  test('switches the server-rendered Pro offer to USD 10.99 with the catalog flag', () => {
    const rendered = applyProductCatalogToStructuredData(
      indexHtml,
      getPublicProductCatalog({
        PRO_PRICE_1099_ENABLED: 'true',
        PADDLE_PRO_PRICE_ID: 'pri_stable_999',
        PADDLE_PRO_1099_PRICE_ID: 'pri_new_1099',
        PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise_1999'
      })
    );
    const offers = readStructuredData(rendered).offers;

    expect(offers.find(offer => offer.name === 'Pro').price).toBe('10.99');
    expect(offers.find(offer => offer.name === 'Enterprise').price).toBe('19.99');
  });

  test('keeps visible pricing and structured data identical before and after cutover', () => {
    for (const [enabled, expectedProPrice] of [
      ['false', '$9.99'],
      ['true', '$10.99']
    ]) {
      const catalog = getPublicProductCatalog({
        PRO_PRICE_1099_ENABLED: enabled,
        PADDLE_PRO_PRICE_ID: 'pri_stable_999',
        PADDLE_PRO_1099_PRICE_ID: 'pri_new_1099',
        PADDLE_ENTERPRISE_PRICE_ID: 'pri_enterprise_1999'
      });
      const rendered = applyProductCatalogToVisiblePricing(
        applyProductCatalogToStructuredData(indexHtml, catalog),
        catalog
      );
      const visible = readVisiblePrices(rendered);
      const offers = readStructuredData(rendered).offers;

      expect(visible).toEqual({
        free: '$0',
        pro: expectedProPrice,
        enterprise: '$19.99'
      });
      expect(offers.find(offer => offer.name === 'Pro').price)
        .toBe(expectedProPrice.slice(1));
      expect(offers.find(offer => offer.name === 'Enterprise').price)
        .toBe(visible.enterprise.slice(1));
    }
  });

  test('fails startup rendering when a visible pricing marker is missing or duplicated', () => {
    const catalog = getPublicProductCatalog({});
    const missingPro = indexHtml.replace('data-catalog-price-fallback="pro"', '');
    const proMarker = '<span class="price-amount" data-catalog-field="price" data-catalog-price-fallback="pro">$9.99</span>';
    const duplicatePro = indexHtml.replace(proMarker, `${proMarker}${proMarker}`);

    expect(() => applyProductCatalogToVisiblePricing(missingPro, catalog))
      .toThrow('expected exactly one visible price marker for pro');
    expect(() => applyProductCatalogToVisiblePricing(duplicatePro, catalog))
      .toThrow('expected exactly one visible price marker for pro');
  });

  test('fails startup rendering when a price marker leaves its plan card', () => {
    const catalog = getPublicProductCatalog({});
    const temporaryMarker = 'data-catalog-price-fallback="temporary"';
    const swappedMarkers = indexHtml
      .replace('data-catalog-price-fallback="pro"', temporaryMarker)
      .replace(
        'data-catalog-price-fallback="enterprise"',
        'data-catalog-price-fallback="pro"'
      )
      .replace(temporaryMarker, 'data-catalog-price-fallback="enterprise"');

    expect(() => applyProductCatalogToVisiblePricing(swappedMarkers, catalog))
      .toThrow('visible price marker for pro must belong to its pricing card');
  });

  test('fails startup rendering when a visible marker is not the card price field', () => {
    const catalog = getPublicProductCatalog({});
    const missingPriceField = indexHtml.replace(
      'data-catalog-field="price" data-catalog-price-fallback="pro"',
      'data-catalog-price-fallback="pro"'
    );

    expect(() => applyProductCatalogToVisiblePricing(missingPriceField, catalog))
      .toThrow('visible price marker for pro must be a price field');
  });

  test('fails startup rendering when the structured offer contract drifts', () => {
    const missingPro = indexHtml.replace('"name": "Pro"', '"name": "Other"');

    expect(() => applyProductCatalogToStructuredData(
      missingPro,
      getPublicProductCatalog({})
    )).toThrow('expected exactly one structured offer for Pro');
  });
});
