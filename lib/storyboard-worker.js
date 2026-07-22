'use strict';

const os = require('os');
const { randomUUID } = require('crypto');
const jobStore = require('./storyboard-job-store');
const { processStoryboardJob } = require('./storyboard-processor');
const { reportIncident, resolveIncident } = require('./incident-reporter');
const logger = require('./logger');

const TICK_INCIDENT_FINGERPRINT = 'storyboard-worker:WORKER_TICK_FAILED:claim-loop';

function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

class StoryboardWorker {
  constructor() {
    const instance = process.env.RAILWAY_REPLICA_ID
      || process.env.HOSTNAME
      || os.hostname()
      || 'local';

    this.workerId = `${instance}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.concurrency = envInt(
      'STORYBOARD_WORKER_CONCURRENCY',
      envInt('STORYBOARD_MAX_CONCURRENT_JOBS', 5, 1, 20),
      1,
      20
    );
    this.pollIntervalMs = envInt('STORYBOARD_WORKER_POLL_MS', 5000, 500, 60000);
    this.leaseSeconds = envInt('STORYBOARD_WORKER_LEASE_SECONDS', 180, 30, 900);
    this.enabled = process.env.STORYBOARD_DURABLE_WORKER_ENABLED !== 'false';

    this.running = false;
    this.ticking = false;
    this.timer = null;
    this.active = new Map();
    this.tickRecoveryChecked = false;
  }

  start() {
    if (!this.enabled) {
      logger.info('storyboard.worker.disabled');
      return;
    }
    if (this.running) return;

    this.running = true;
    logger.info('storyboard.worker.started', {
      workerId: this.workerId,
      concurrency: this.concurrency,
      leaseSeconds: this.leaseSeconds,
      pollIntervalMs: this.pollIntervalMs
    });
    this._schedule(0);
  }

  wake() {
    if (!this.running) return;
    this._schedule(0, true);
  }

  async stop(graceMs = 25000) {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.active.size === 0) return;

    logger.info('storyboard.worker.draining', { activeJobs: this.active.size });
    const active = Promise.allSettled([...this.active.values()]);
    const timeout = new Promise(resolve => setTimeout(resolve, graceMs));
    await Promise.race([active, timeout]);
  }

  _schedule(delayMs, replace = false) {
    if (!this.running) return;
    if (this.timer && !replace) return;
    if (this.timer) clearTimeout(this.timer);

    this.timer = setTimeout(() => {
      this.timer = null;
      this._tick().catch(async (error) => {
        logger.error('storyboard.worker.tick_failed', {
          workerId: this.workerId,
          error
        });
        await reportIncident({
          severity: 'critical',
          source: 'storyboard-worker',
          eventCode: 'WORKER_TICK_FAILED',
          message: error.message,
          fingerprint: TICK_INCIDENT_FINGERPRINT,
          context: { workerId: this.workerId, error }
        });
        this._schedule(this.pollIntervalMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  async _tick() {
    if (!this.running || this.ticking) return;
    this.ticking = true;

    try {
      const available = this.concurrency - this.active.size;
      if (available <= 0) {
        this._schedule(this.pollIntervalMs);
        return;
      }

      const jobs = await jobStore.claimJobs(
        this.workerId,
        available,
        this.leaseSeconds
      );

      if (!this.tickRecoveryChecked) {
        const recovery = await resolveIncident(TICK_INCIDENT_FINGERPRINT);
        this.tickRecoveryChecked = recovery.checked;
      }

      for (const job of jobs) {
        this._launch(job);
      }
    } catch (error) {
      this.tickRecoveryChecked = false;
      throw error;
    } finally {
      this.ticking = false;
      this._schedule(this.pollIntervalMs);
    }
  }

  _launch(job) {
    if (this.active.has(job.id)) {
      logger.error('storyboard.worker.duplicate_local_claim', { storyboardId: job.id, workerId: this.workerId });
      return;
    }

    const promise = processStoryboardJob(job, {
      leaseSeconds: this.leaseSeconds
    })
      .catch(async (error) => {
        // processStoryboardJob normally persists its own failure. This catches
        // only unexpected worker-level faults; the lease still guarantees recovery.
        logger.critical('storyboard.worker.job_unhandled', {
          storyboardId: job.id,
          workerId: this.workerId,
          error
        });
        await reportIncident({
          severity: 'critical',
          source: 'storyboard-worker',
          eventCode: 'WORKER_JOB_UNHANDLED',
          message: error.message,
          fingerprint: `storyboard-worker:WORKER_JOB_UNHANDLED:${job.id}`,
          context: {
            storyboardId: job.id,
            workerId: this.workerId,
            attempt: job.attempt_count,
            error
          }
        });
      })
      .finally(() => {
        this.active.delete(job.id);
        this.wake();
      });

    this.active.set(job.id, promise);
  }
}

module.exports = new StoryboardWorker();
module.exports.StoryboardWorker = StoryboardWorker;
module.exports.envInt = envInt;
