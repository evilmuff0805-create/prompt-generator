'use strict';

const os = require('os');
const { randomUUID } = require('crypto');
const jobStore = require('./storyboard-job-store');
const { processStoryboardJob } = require('./storyboard-processor');

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
    this.pollIntervalMs = envInt('STORYBOARD_WORKER_POLL_MS', 2000, 250, 60000);
    this.leaseSeconds = envInt('STORYBOARD_WORKER_LEASE_SECONDS', 180, 30, 900);
    this.enabled = process.env.STORYBOARD_DURABLE_WORKER_ENABLED !== 'false';

    this.running = false;
    this.ticking = false;
    this.timer = null;
    this.active = new Map();
  }

  start() {
    if (!this.enabled) {
      console.log('[storyboard-worker] Disabled by STORYBOARD_DURABLE_WORKER_ENABLED=false');
      return;
    }
    if (this.running) return;

    this.running = true;
    console.log(
      `[storyboard-worker] Started ${this.workerId} (concurrency=${this.concurrency}, lease=${this.leaseSeconds}s)`
    );
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

    console.log(`[storyboard-worker] Waiting for ${this.active.size} active job(s)`);
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
      this._tick().catch(error => {
        console.error('[storyboard-worker] Tick failed:', error.message);
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

      for (const job of jobs) {
        this._launch(job);
      }
    } finally {
      this.ticking = false;
      this._schedule(this.pollIntervalMs);
    }
  }

  _launch(job) {
    if (this.active.has(job.id)) {
      console.error('[storyboard-worker] Duplicate local claim ignored:', job.id);
      return;
    }

    const promise = processStoryboardJob(job, {
      leaseSeconds: this.leaseSeconds
    })
      .catch(error => {
        // processStoryboardJob normally persists its own failure. This catches
        // only unexpected worker-level faults; the lease still guarantees recovery.
        console.error(`[storyboard-worker] Unhandled job error ${job.id}:`, error.message);
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
