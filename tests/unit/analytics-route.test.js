'use strict';

const router = require('../../routes/analytics');

describe('analytics ingestion authentication', () => {
  test('keeps anonymous events anonymous when no bearer token is present', async () => {
    await expect(router.resolveUserId({ headers: {} })).resolves.toBeNull();
  });

  test('derives user identity only from a validated bearer token', async () => {
    const authClient = {
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: '33333333-3333-4333-8333-333333333333' } },
          error: null
        })
      }
    };
    router._setAuthClientForTests(authClient);

    const req = {
      headers: {
        authorization: 'Bearer signed-access-token'
      },
      body: {
        userId: 'attacker-controlled-id'
      }
    };

    await expect(router.resolveUserId(req)).resolves
      .toBe('33333333-3333-4333-8333-333333333333');
    expect(authClient.auth.getUser).toHaveBeenCalledWith('signed-access-token');
  });

  test('rejects an invalid bearer token instead of trusting the payload', async () => {
    router._setAuthClientForTests({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: null },
          error: { message: 'invalid JWT' }
        })
      }
    });

    await expect(router.resolveUserId({
      headers: { authorization: 'Bearer invalid' }
    })).rejects.toMatchObject({
      code: 'INVALID_PRODUCT_EVENT',
      statusCode: 401
    });
  });

  test('does not accept non-Bearer authorization schemes', () => {
    expect(router.bearerToken({
      headers: { authorization: 'Basic abc123' }
    })).toBeNull();
  });
});
