'use strict';

const reporter = require('../../lib/incident-reporter');
const logger = require('../../lib/logger');

describe('incident reporter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    delete process.env.OPS_ALERT_WEBHOOK_FORMAT;
    delete process.env.OPS_ALERT_REPEAT;
    process.env.OPS_ALERT_MIN_SEVERITY = 'critical';
    logger._setSinkForTests(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('persists a sanitized incident through the service-role RPC', async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: { id: 7, occurrenceCount: 1 },
        error: null
      })
    };
    reporter._setAdminClientForTests(client);

    const result = await reporter.reportIncident({
      severity: 'critical',
      source: 'test',
      eventCode: 'TEST_FAILURE',
      message: 'failed',
      key: 'one',
      context: { token: 'secret', safe: true }
    });

    expect(result).toMatchObject({
      persisted: true,
      notified: false,
      incidentId: 7,
      occurrenceCount: 1
    });
    expect(client.rpc).toHaveBeenCalledWith('record_ops_incident', expect.objectContaining({
      p_fingerprint: 'test:TEST_FAILURE:one',
      p_severity: 'critical',
      p_context: { token: '[REDACTED]', safe: true }
    }));
  });

  test.each([
    ['generic', { severity: 'critical', eventCode: 'PAYMENT_REVIEW' }],
    ['slack', { text: '[CRITICAL] PAYMENT_REVIEW' }],
    ['discord', { content: '[CRITICAL] PAYMENT_REVIEW' }]
  ])('builds a minimal %s webhook body without incident details', (format, expected) => {
    const body = reporter.webhookBody(format, {
      id: 7,
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'PAYMENT_REVIEW',
      message: 'Manual review for txn_private_012 and user-private-123',
      fingerprint: 'paddle:PAYMENT_REVIEW:txn_private_012',
      context: {
        userId: 'user-private-123',
        customerId: 'ctm_private_456',
        subscriptionId: 'sub_private_789',
        transactionId: 'txn_private_012'
      },
      occurrenceCount: 1,
      occurredAt: '2026-07-29T00:00:00.000Z'
    });

    expect(body).toEqual(expected);
    expect(JSON.stringify(body)).not.toContain('private');
  });

  test('notifies only the first matching occurrence by default', async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';
    process.env.OPS_ALERT_WEBHOOK_FORMAT = 'slack';

    const client = {
      rpc: jest.fn()
        .mockResolvedValueOnce({ data: { id: 1, occurrenceCount: 1 }, error: null })
        .mockResolvedValueOnce({ data: { id: 1, occurrenceCount: 2 }, error: null })
    };
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    reporter._setAdminClientForTests(client);
    reporter._setFetchForTests(fetchMock);

    await reporter.reportIncident({
      severity: 'critical',
      source: 'test',
      eventCode: 'DUPLICATE',
      message: 'first',
      fingerprint: 'test:DUPLICATE:1'
    });
    await reporter.reportIncident({
      severity: 'critical',
      source: 'test',
      eventCode: 'DUPLICATE',
      message: 'second',
      fingerprint: 'test:DUPLICATE:1'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      text: '[CRITICAL] DUPLICATE'
    });
  });

  test('keeps full sanitized context internally but sends minimal generic alert metadata', async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';
    process.env.OPS_ALERT_WEBHOOK_FORMAT = 'generic';

    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: { id: 8, occurrenceCount: 1 },
        error: null
      })
    };
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const logRecords = [];
    reporter._setAdminClientForTests(client);
    reporter._setFetchForTests(fetchMock);
    logger._setSinkForTests((level, line) => {
      logRecords.push(JSON.parse(line));
    });

    const sensitiveContext = {
      userId: 'user-private-123',
      customerId: 'ctm_private_456',
      subscriptionId: 'sub_private_789',
      transactionId: 'txn_private_012',
      token: 'secret-token'
    };
    const message = 'Manual review for txn_private_012 and user-private-123';
    const fingerprint = 'paddle:PAYMENT_REVIEW:txn_private_012';

    await reporter.reportIncident({
      severity: 'critical',
      source: 'paddle-webhook',
      eventCode: 'PAYMENT_REVIEW',
      message,
      fingerprint,
      context: sensitiveContext
    });

    const sanitizedContext = {
      ...sensitiveContext,
      token: '[REDACTED]'
    };
    expect(client.rpc).toHaveBeenCalledWith('record_ops_incident', expect.objectContaining({
      p_message: message,
      p_fingerprint: fingerprint,
      p_context: sanitizedContext
    }));
    expect(logRecords[0]).toMatchObject({
      event: 'ops.incident.reported',
      message,
      fingerprint,
      context: sanitizedContext
    });

    const externalBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(externalBody).toEqual({
      severity: 'critical',
      eventCode: 'PAYMENT_REVIEW'
    });
    expect(JSON.stringify(externalBody)).not.toContain('private');
  });

  test('never throws when persistence and notification both fail', async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';

    reporter._setAdminClientForTests({
      rpc: jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'database unavailable' }
      })
    });
    reporter._setFetchForTests(jest.fn().mockRejectedValue(new Error('network down')));

    await expect(reporter.reportIncident({
      severity: 'critical',
      source: 'test',
      eventCode: 'OUTAGE',
      message: 'outage'
    })).resolves.toMatchObject({
      persisted: false,
      notified: false
    });
  });

  test('resolves a recovered incident through the service-role RPC', async () => {
    const client = {
      rpc: jest.fn().mockResolvedValue({ data: true, error: null })
    };
    reporter._setAdminClientForTests(client);

    await expect(reporter.resolveIncident('worker:FAILED:claim')).resolves.toEqual({
      checked: true,
      resolved: true,
      fingerprint: 'worker:FAILED:claim'
    });
    expect(client.rpc).toHaveBeenCalledWith('resolve_ops_incident', {
      p_fingerprint: 'worker:FAILED:claim'
    });
  });

  test('keeps product work fail-open when incident resolution is unavailable', async () => {
    reporter._setAdminClientForTests({
      rpc: jest.fn().mockResolvedValue({ data: null, error: { message: 'unavailable' } })
    });

    await expect(reporter.resolveIncident('worker:FAILED:claim')).resolves.toEqual({
      checked: false,
      resolved: false,
      fingerprint: 'worker:FAILED:claim'
    });
  });
});
