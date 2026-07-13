'use strict';

const logger = require('../../lib/logger');
const analytics = require('../../lib/product-analytics');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

describe('product analytics', () => {
  beforeEach(() => {
    logger._setSinkForTests(() => {});
  });

  test('normalizes Storyboard result paths without recording identifiers', () => {
    expect(analytics.normalizePagePath('/storyboard/sb_secret123'))
      .toBe('/storyboard/:id');
    expect(analytics.normalizePagePath('/storyboard/sb_secret123?token=nope')).toBeNull();
    expect(analytics.normalizePagePath('/unknown')).toBeNull();
  });

  test('accepts an allowlisted client event and strips no hidden data', () => {
    expect(analytics.validateProductEvent({
      eventId: EVENT_ID,
      eventName: 'checkout_started',
      source: 'client',
      userId: USER_ID,
      sessionId: SESSION_ID,
      pagePath: '/',
      properties: { plan: 'pro', surface: 'pricing' }
    })).toEqual({
      event_id: EVENT_ID,
      event_name: 'checkout_started',
      source: 'client',
      user_id: USER_ID,
      session_id: SESSION_ID,
      page_path: '/',
      properties: { plan: 'pro', surface: 'pricing' }
    });
  });

  test.each([
    [{ eventName: 'made_up', source: 'client' }, 'event name'],
    [{
      eventId: EVENT_ID,
      eventName: 'page_viewed',
      source: 'client',
      sessionId: 'not-a-uuid',
      pagePath: '/'
    }, 'sessionId'],
    [{
      eventId: EVENT_ID,
      eventName: 'page_viewed',
      source: 'client',
      sessionId: SESSION_ID,
      pagePath: '/?email=user@example.com'
    }, 'pagePath'],
    [{
      eventId: EVENT_ID,
      eventName: 'analysis_started',
      source: 'client',
      sessionId: SESSION_ID,
      pagePath: '/',
      properties: { email: 'user@example.com' }
    }, 'not allowed'],
    [{
      eventId: EVENT_ID,
      eventName: 'analysis_started',
      source: 'client',
      sessionId: SESSION_ID,
      pagePath: '/',
      properties: { plan: 'user@example.com' }
    }, 'value is not allowed'],
    [{
      eventId: EVENT_ID,
      eventName: 'signup_completed',
      source: 'client',
      sessionId: SESSION_ID,
      pagePath: '/'
    }, 'event name']
  ])('rejects malformed or privacy-unsafe events', (input, message) => {
    expect(() => analytics.validateProductEvent(input)).toThrow(message);
  });

  test('accepts signup completion only as an authoritative server event', () => {
    expect(analytics.validateProductEvent({
      eventName: 'signup_completed',
      source: 'server',
      userId: USER_ID,
      properties: { provider: 'supabase_auth' }
    })).toMatchObject({
      event_name: 'signup_completed',
      source: 'server',
      user_id: USER_ID
    });
  });

  test('requires server events to have an authenticated user', () => {
    expect(() => analytics.validateProductEvent({
      eventName: 'analysis_succeeded',
      source: 'server',
      properties: { plan: 'free', creditsCharged: 0 }
    })).toThrow('userId');
  });

  test('treats a unique event replay as an idempotent duplicate', async () => {
    const client = {
      from: jest.fn().mockReturnValue({
        insert: jest.fn().mockResolvedValue({
          error: { code: '23505', message: 'duplicate key' }
        })
      })
    };

    await expect(analytics.recordProductEvent({
      eventId: EVENT_ID,
      eventName: 'page_viewed',
      source: 'client',
      sessionId: SESSION_ID,
      pagePath: '/'
    }, { client })).resolves.toMatchObject({
      persisted: true,
      duplicate: true
    });
  });

  test('never throws into a product path when persistence fails', async () => {
    const client = {
      from: jest.fn().mockReturnValue({
        insert: jest.fn().mockResolvedValue({
          error: { code: '08006', message: 'database unavailable' }
        })
      })
    };

    await expect(analytics.recordServerEvent({
      eventName: 'storyboard_completed',
      userId: USER_ID,
      properties: { cutCount: 9, attemptCount: 1, durationBucket: '60-120s' }
    }, { client })).resolves.toMatchObject({
      persisted: false,
      duplicate: false
    });
  });
});
