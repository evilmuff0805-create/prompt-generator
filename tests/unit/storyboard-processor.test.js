'use strict';

jest.mock('../../lib/storyboard-engine', () => ({
  generateScenarioAndPrompts: jest.fn(),
  buildGridPrompt: jest.fn(() => 'grid prompt'),
  generateGridImage: jest.fn()
}));

jest.mock('../../lib/storyboard-job-store', () => ({
  heartbeatJob: jest.fn(),
  updateProgress: jest.fn(),
  completeJob: jest.fn(),
  failJob: jest.fn(),
  removeGrid: jest.fn()
}));

jest.mock('../../lib/incident-reporter', () => ({
  reportIncident: jest.fn()
}));

const engine = require('../../lib/storyboard-engine');
const jobStore = require('../../lib/storyboard-job-store');
const { reportIncident } = require('../../lib/incident-reporter');
const {
  processStoryboardJob,
  isRetryableError
} = require('../../lib/storyboard-processor');

const job = {
  id: 'sb_test',
  user_id: '00000000-0000-0000-0000-000000000001',
  scenario: 'A sufficiently long test scenario for storyboard generation.',
  genres: ['Drama'],
  style: 'Cinematic',
  cut_count: 4,
  reference_image_ids: [],
  claim_token: '10000000-0000-0000-0000-000000000001',
  attempt_count: 1,
  max_attempts: 3
};

const resultData = {
  shots: [{ cameraAngle: 'Wide', description: 'Test' }],
  characters: { lead: 'Alex' }
};

describe('durable storyboard processor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jobStore.heartbeatJob.mockResolvedValue(true);
    jobStore.updateProgress.mockResolvedValue(true);
    jobStore.completeJob.mockResolvedValue(true);
    jobStore.failJob.mockResolvedValue({
      accepted: true,
      status: 'pending',
      refunded: false
    });
    jobStore.removeGrid.mockResolvedValue();
    reportIncident.mockResolvedValue({ persisted: true });
    engine.generateScenarioAndPrompts.mockResolvedValue(resultData);
    engine.generateGridImage.mockResolvedValue(
      'user/sb_test/grid-10000000-0000-0000-0000-000000000001.png'
    );
  });

  test('completes through fenced progress and completion RPCs', async () => {
    const outcome = await processStoryboardJob(job, { leaseSeconds: 180 });

    expect(outcome).toEqual({ status: 'completed' });
    expect(jobStore.updateProgress).toHaveBeenNthCalledWith(
      1,
      job.id,
      job.claim_token,
      'analyzing_scenario',
      0.1
    );
    expect(jobStore.completeJob).toHaveBeenCalledWith(
      job.id,
      job.claim_token,
      resultData,
      expect.stringContaining('grid-')
    );
    expect(jobStore.failJob).not.toHaveBeenCalled();
    expect(jobStore.removeGrid).not.toHaveBeenCalled();
  });

  test('queues a bounded retry for transient provider failures', async () => {
    const error = new Error('rate limited');
    error.code = 'OPENAI_RATE_LIMIT';
    engine.generateScenarioAndPrompts.mockRejectedValue(error);

    const outcome = await processStoryboardJob(job, { leaseSeconds: 180 });

    expect(outcome.status).toBe('pending');
    expect(jobStore.failJob).toHaveBeenCalledWith(
      job.id,
      job.claim_token,
      expect.stringContaining('OPENAI_RATE_LIMIT'),
      true,
      15
    );
    expect(reportIncident).not.toHaveBeenCalled();
  });

  test('does not retry permanent provider request errors', async () => {
    const error = new Error('invalid request');
    error.code = 'OPENAI_TEXT_INVALID_REQUEST';
    engine.generateScenarioAndPrompts.mockRejectedValue(error);
    jobStore.failJob.mockResolvedValue({
      accepted: true,
      status: 'failed',
      refunded: true
    });

    const outcome = await processStoryboardJob(job, { leaseSeconds: 180 });

    expect(outcome.status).toBe('failed');
    expect(jobStore.failJob).toHaveBeenCalledWith(
      job.id,
      job.claim_token,
      expect.stringContaining('OPENAI_TEXT_INVALID_REQUEST'),
      false,
      15
    );
    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'error',
      eventCode: 'STORYBOARD_FINAL_FAILURE',
      fingerprint: expect.stringContaining(job.id)
    }));
  });

  test('deletes an attempt grid when fenced completion loses ownership', async () => {
    jobStore.completeJob.mockResolvedValue(false);

    const outcome = await processStoryboardJob(job, { leaseSeconds: 180 });

    expect(outcome).toEqual({ status: 'claim_lost' });
    expect(jobStore.removeGrid).toHaveBeenCalledWith(expect.stringContaining('grid-'));
    expect(jobStore.failJob).not.toHaveBeenCalled();
  });

  test('leaves recovery to the lease when failure persistence is unavailable', async () => {
    const providerError = new Error('temporary outage');
    providerError.code = 'OPENAI_IMAGE_FAILED';
    engine.generateGridImage.mockRejectedValue(providerError);
    jobStore.failJob.mockRejectedValue(new Error('database unavailable'));

    await expect(
      processStoryboardJob(job, { leaseSeconds: 180 })
    ).rejects.toThrow('database unavailable');
    expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      eventCode: 'FAILURE_TRANSITION_UNAVAILABLE'
    }));
  });
});

describe('retry classification', () => {
  test.each([
    ['OPENAI_RATE_LIMIT', true],
    ['OPENAI_TIMEOUT', true],
    ['VALIDATION_FAILED', true],
    ['STORAGE_UPLOAD_ERROR', true],
    ['OPENAI_INVALID_REQUEST', false],
    ['OPENAI_TEXT_INVALID_REQUEST', false],
    ['LEASE_LOST', false]
  ])('%s => retryable=%s', (code, expected) => {
    expect(isRetryableError({ code })).toBe(expected);
  });
});
