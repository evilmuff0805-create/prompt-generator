'use strict';

const { collectMismatches } = require('../../scripts/audit-paddle-catalog');
const { getPaddleCatalogMetadata } = require('../../lib/product-catalog');

describe('read-only Paddle catalog audit', () => {
  const expected = getPaddleCatalogMetadata({
    PADDLE_PRO_PRICE_ID: 'pri_pro_live'
  }).pro;

  function matchingEntities() {
    return {
      price: {
        name: expected.priceName,
        description: expected.internalDescription,
        status: 'active',
        unit_price: { amount: expected.unitAmount, currency_code: expected.currencyCode },
        billing_cycle: { ...expected.billingCycle },
        quantity: { ...expected.quantity }
      },
      product: {
        name: expected.productName,
        description: expected.productDescription,
        status: 'active'
      }
    };
  }

  test('canonical metadata와 일치하면 mismatch가 없다', () => {
    const { price, product } = matchingEntities();
    expect(collectMismatches('pro', expected, price, product)).toEqual([]);
  });

  test('문구와 금액 drift를 필드별로 보고한다', () => {
    const { price, product } = matchingEntities();
    product.description = 'Includes priority processing';
    price.unit_price.amount = '1999';

    expect(collectMismatches('pro', expected, price, product)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'product.description' }),
      expect.objectContaining({ field: 'price.unit_price.amount' })
    ]));
  });
});
