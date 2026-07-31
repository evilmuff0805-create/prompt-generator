'use strict';

const {
  INVENTORY_NOT_AUDITED_CODE,
  parsePriceIds,
  collectLegacyPriceIds,
  collectArchivedPriceMismatches,
  auditCreditPackCatalog
} = require('../../scripts/audit-credit-pack-catalog');

const BASE_ENV = {
  NODE_ENV: 'test',
  PADDLE_API_KEY: 'test-read-only-key',
  PADDLE_API_BASE: 'https://sandbox-api.paddle.test',
  CREDIT_PACK_EXPIRY_DAYS: '365'
};

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({ data })
  };
}

describe('read-only legacy Paddle add-on price audit', () => {
  test('normalizes and de-duplicates explicit legacy IDs', () => {
    expect(parsePriceIds(' pri_old_a,pri_old_b, pri_old_a ')).toEqual([
      'pri_old_a',
      'pri_old_b'
    ]);
  });

  test('fails closed when no legacy IDs are declared and full inventory is not audited', async () => {
    const fetchImpl = jest.fn();
    await expect(auditCreditPackCatalog({
      env: { CREDIT_PACK_EXPIRY_DAYS: '365' },
      fetchImpl
    })).rejects.toMatchObject({
      code: INVENTORY_NOT_AUDITED_CODE,
      message: expect.stringMatching(/not audited; manual inventory required/i)
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('requires each explicitly listed legacy one-time price to be archived', async () => {
    const env = {
      ...BASE_ENV,
      PADDLE_CREDIT_PACK_600_LEGACY_PRICE_IDS: 'pri_old_600',
      PADDLE_CREDIT_PACK_1500_LEGACY_PRICE_IDS: 'pri_old_1500'
    };
    const fetchImpl = jest.fn(async (url, options) => {
      expect(options).toEqual({
        method: 'GET',
        headers: { Authorization: 'Bearer test-read-only-key' }
      });
      const id = url.split('/').pop();
      return jsonResponse({
        id,
        status: 'archived',
        billing_cycle: null
      });
    });

    await expect(auditCreditPackCatalog({ env, fetchImpl })).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([, options]) => (
      options.method === 'GET' && options.body === undefined
    ))).toBe(true);
  });

  test('reports an active or recurring legacy price as a release blocker', () => {
    expect(collectArchivedPriceMismatches(
      'usage_3000',
      'pri_old_3000',
      {
        id: 'pri_old_3000',
        status: 'active',
        billing_cycle: { interval: 'month', frequency: 1 }
      }
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'price.status',
        expected: 'archived'
      }),
      expect.objectContaining({
        field: 'price.billing_cycle',
        expected: null
      })
    ]));
  });

  test('rejects one reusable price assigned to multiple packs', () => {
    expect(() => collectLegacyPriceIds({
      PADDLE_CREDIT_PACK_600_LEGACY_PRICE_IDS: 'pri_shared',
      PADDLE_CREDIT_PACK_1500_LEGACY_PRICE_IDS: 'pri_shared'
    })).toThrow('assigned to multiple packs');
  });

  test('requires an API key only when legacy IDs need provider verification', async () => {
    await expect(auditCreditPackCatalog({
      env: {
        CREDIT_PACK_EXPIRY_DAYS: '365',
        PADDLE_CREDIT_PACK_600_LEGACY_PRICE_IDS: 'pri_old_600'
      },
      fetchImpl: jest.fn()
    })).rejects.toThrow('PADDLE_API_KEY');
  });

  test('rejects an untrusted bearer-token destination before any catalog read', async () => {
    const fetchImpl = jest.fn();
    await expect(auditCreditPackCatalog({
      env: {
        ...BASE_ENV,
        NODE_ENV: 'production',
        PADDLE_API_BASE: 'https://api.paddle.com.attacker.example',
        PADDLE_CREDIT_PACK_600_LEGACY_PRICE_IDS: 'pri_old_600'
      },
      fetchImpl
    })).rejects.toThrow('PADDLE_API_BASE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
