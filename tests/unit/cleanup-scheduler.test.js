'use strict';

const { CleanupScheduler } = require('../../lib/cleanup-scheduler');

describe('cleanup scheduler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CLEANUP_INITIAL_DELAY_MS: '60000',
      CLEANUP_INTERVAL_MS: '60000'
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllTimers();
  });

  test('reports a durable incident when a run is partially successful', async () => {
    const reportIncidentFn = jest.fn().mockResolvedValue({});
    const scheduler = new CleanupScheduler({
      runCleanupFn: jest.fn().mockResolvedValue({
        failures: [{ kind: 'reference_image', id: 'ref_1' }]
      }),
      reportIncidentFn,
      clientFactory: () => ({}),
      logger: { info: jest.fn(), error: jest.fn(), critical: jest.fn() }
    });

    scheduler.running = true;
    await scheduler._run();
    scheduler.stop();

    expect(reportIncidentFn).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'error',
      eventCode: 'CLEANUP_PARTIAL_FAILURE'
    }));
  });

  test('converts a fatal cleanup exception into a critical incident', async () => {
    const reportIncidentFn = jest.fn().mockResolvedValue({});
    const scheduler = new CleanupScheduler({
      runCleanupFn: jest.fn().mockRejectedValue(new Error('database down')),
      reportIncidentFn,
      clientFactory: () => ({}),
      logger: { info: jest.fn(), error: jest.fn(), critical: jest.fn() }
    });

    scheduler.running = true;
    const result = await scheduler._run();
    scheduler.stop();

    expect(result).toBeNull();
    expect(reportIncidentFn).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      eventCode: 'CLEANUP_RUN_FAILED'
    }));
  });

  test('prevents overlapping cleanup runs', async () => {
    const runCleanupFn = jest.fn();
    const scheduler = new CleanupScheduler({
      runCleanupFn,
      clientFactory: () => ({}),
      logger: { info: jest.fn(), error: jest.fn(), critical: jest.fn() }
    });

    scheduler.running = true;
    scheduler.executing = true;
    const result = await scheduler._run();
    scheduler.stop();

    expect(result).toBeNull();
    expect(runCleanupFn).not.toHaveBeenCalled();
  });
});
