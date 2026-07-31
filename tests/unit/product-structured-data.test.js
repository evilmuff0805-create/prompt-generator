'use strict';

const fs = require('fs');
const path = require('path');
const {
  getPublicProductCatalog
} = require('../../lib/product-catalog');
const {
  applyProductCatalogToStructuredData
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

  test('fails startup rendering when the structured offer contract drifts', () => {
    const missingPro = indexHtml.replace('"name": "Pro"', '"name": "Other"');

    expect(() => applyProductCatalogToStructuredData(
      missingPro,
      getPublicProductCatalog({})
    )).toThrow('expected exactly one structured offer for Pro');
  });
});
