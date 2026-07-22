'use strict';

const reporter = require('../../lib/incident-reporter');
const logger = require('../../lib/logger');

describe('incident reporter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPS_ALERT_WEBHOOK_URL;
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
      text: '[CRITICAL] DUPLICATE: first'
    });
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
