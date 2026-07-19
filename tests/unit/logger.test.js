'use strict';

const logger = require('../../lib/logger');

describe('structured logger', () => {
  let records;

  beforeEach(() => {
    records = [];
    logger._setSinkForTests((level, line) => {
      records.push({ level, record: JSON.parse(line) });
    });
  });

  test('emits the required structured fields', () => {
    logger.info('test.event', { requestId: 'req_12345678', statusCode: 200 });

    expect(records).toHaveLength(1);
    expect(records[0].record).toMatchObject({
      level: 'info',
      event: 'test.event',
      service: 'promptgen-api',
      requestId: 'req_12345678',
      statusCode: 200
    });
    expect(new Date(records[0].record.timestamp).toString()).not.toBe('Invalid Date');
  });

  test('redacts secrets recursively', () => {
    logger.error('test.secret', {
      authorization: 'Bearer abc',
      nested: {
        apiKey: 'secret-key',
        safe: 'visible'
      }
    });

    expect(records[0].record.authorization).toBe('[REDACTED]');
    expect(records[0].record.nested.apiKey).toBe('[REDACTED]');
    expect(records[0].record.nested.safe).toBe('visible');
  });

  test('keeps numeric token counts while redacting token credentials', () => {
    logger.info('test.usage', {
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        reasoningTokens: 12,
        totalTokens: 172
      },
      accessToken: 'secret-access-token',
      token: 'secret-token'
    });

    expect(records[0].record.usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      reasoningTokens: 12,
      totalTokens: 172
    });
    expect(records[0].record.accessToken).toBe('[REDACTED]');
    expect(records[0].record.token).toBe('[REDACTED]');
  });

  test('accepts only safe incoming request IDs', () => {
    expect(logger.createRequestId('valid-request-id-123')).toBe('valid-request-id-123');
    expect(logger.createRequestId('bad id with spaces')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
