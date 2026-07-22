'use strict';

jest.mock('../../lib/storyboard-job-store', () => ({
  claimJobs: jest.fn()
}));

jest.mock('../../lib/storyboard-processor', () => ({
  processStoryboardJob: jest.fn()
}));

jest.mock('../../lib/incident-reporter', () => ({
  reportIncident: jest.fn(),
  resolveIncident: jest.fn()
}));

const jobStore = require('../../lib/storyboard-job-store');
const { processStoryboardJob } = require('../../lib/storyboard-processor');
const { resolveIncident } = require('../../lib/incident-reporter');
const { StoryboardWorker, envInt } = require('../../lib/storyboard-worker');

describe('StoryboardWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STORYBOARD_WORKER_CONCURRENCY = '2';
    process.env.STORYBOARD_WORKER_LEASE_SECONDS = '180';
    process.env.STORYBOARD_WORKER_POLL_MS = '60000';
    delete process.env.STORYBOARD_DURABLE_WORKER_ENABLED;
    resolveIncident.mockResolvedValue({ checked: true, resolved: false });
  });

  afterEach(() => {
    delete process.env.STORYBOARD_WORKER_CONCURRENCY;
    delete process.env.STORYBOARD_WORKER_LEASE_SECONDS;
    delete process.env.STORYBOARD_WORKER_POLL_MS;
  });

  test('claims only available capacity and dispatches fenced jobs', async () => {
    const jobs = [
      { id: 'sb_1', claim_token: 'token-1' },
      { id: 'sb_2', claim_token: 'token-2' }
    ];
    jobStore.claimJobs.mockResolvedValue(jobs);
    processStoryboardJob.mockResolvedValue({ status: 'completed' });

    const worker = new StoryboardWorker();
    worker.running = true;
    await worker._tick();
    await Promise.allSettled([...worker.active.values()]);

    expect(jobStore.claimJobs).toHaveBeenCalledWith(
      worker.workerId,
      2,
      180
    );
    expect(processStoryboardJob).toHaveBeenCalledTimes(2);
    expect(processStoryboardJob).toHaveBeenCalledWith(
      jobs[0],
      { leaseSeconds: 180 }
    );
    expect(resolveIncident).toHaveBeenCalledWith(
      'storyboard-worker:WORKER_TICK_FAILED:claim-loop'
    );

    await worker.stop(1);
  });

  test('checks stale tick recovery once and retries only after a failed check', async () => {
    jobStore.claimJobs.mockResolvedValue([]);
    resolveIncident
      .mockResolvedValueOnce({ checked: false, resolved: false })
      .mockResolvedValueOnce({ checked: true, resolved: false });

    const worker = new StoryboardWorker();
    worker.running = true;

    await worker._tick();
    await worker._tick();
    await worker._tick();

    expect(resolveIncident).toHaveBeenCalledTimes(2);
    await worker.stop(1);
  });

  test('re-opens the recovery check after a claim-loop failure', async () => {
    jobStore.claimJobs
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('temporary claim failure'))
      .mockResolvedValueOnce([]);

    const worker = new StoryboardWorker();
    worker.running = true;

    await worker._tick();
    await expect(worker._tick()).rejects.toThrow('temporary claim failure');
    await worker._tick();

    expect(resolveIncident).toHaveBeenCalledTimes(2);
    await worker.stop(1);
  });

  test('does not claim while local concurrency is full', async () => {
    jobStore.claimJobs.mockResolvedValue([]);

    const worker = new StoryboardWorker();
    worker.running = true;
    worker.active.set('existing-1', new Promise(() => {}));
    worker.active.set('existing-2', new Promise(() => {}));

    await worker._tick();

    expect(jobStore.claimJobs).not.toHaveBeenCalled();
    worker.active.clear();
    await worker.stop(1);
  });
});

describe('envInt', () => {
  test('clamps unsafe concurrency and lease values', () => {
    process.env.TEST_WORKER_INT = '999';
    expect(envInt('TEST_WORKER_INT', 5, 1, 20)).toBe(20);
    process.env.TEST_WORKER_INT = 'not-a-number';
    expect(envInt('TEST_WORKER_INT', 5, 1, 20)).toBe(5);
    delete process.env.TEST_WORKER_INT;
  });
});
