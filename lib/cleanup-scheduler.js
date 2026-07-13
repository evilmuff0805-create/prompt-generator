'use strict';

const { createClient } = require('@supabase/supabase-js');
const { runCleanup } = require('./cleanup-service');
const { reportIncident } = require('./incident-reporter');
const logger = require('./logger');

function envInt(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function makeAdminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

class CleanupScheduler {
  constructor(options = {}) {
    this.runCleanupFn = options.runCleanupFn || runCleanup;
    this.reportIncidentFn = options.reportIncidentFn || reportIncident;
    this.logger = options.logger || logger;
    this.clientFactory = options.clientFactory || makeAdminClient;

    this.enabled = process.env.CLEANUP_SCHEDULER_ENABLED !== 'false';
    this.initialDelayMs = envInt('CLEANUP_INITIAL_DELAY_MS', 60000, 1000, 3600000);
    this.intervalMs = envInt('CLEANUP_INTERVAL_MS', 86400000, 60000, 604800000);
    this.batchSize = envInt('CLEANUP_BATCH_SIZE', 100, 1, 500);
    this.retentionDays = envInt('STORYBOARD_RETENTION_DAYS', 30, 1, 365);
    this.webhookRetentionDays = envInt('WEBHOOK_EVENT_RETENTION_DAYS', 90, 7, 730);

    this.running = false;
    this.executing = false;
    this.timer = null;
  }

  start() {
    if (!this.enabled) {
      this.logger.info('cleanup.scheduler.disabled');
      return;
    }
    if (this.running) return;

    this.running = true;
    this.logger.info('cleanup.scheduler.started', {
      initialDelayMs: this.initialDelayMs,
      intervalMs: this.intervalMs,
      batchSize: this.batchSize
    });
    this._schedule(this.initialDelayMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule(delayMs) {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._run().catch((error) => {
        this.logger.error('cleanup.scheduler.unhandled', { error });
      });
    }, delayMs);
    this.timer.unref?.();
  }

  async _run() {
    if (!this.running || this.executing) return null;
    this.executing = true;

    try {
      const summary = await this.runCleanupFn({
        client: this.clientFactory(),
        retentionDays: this.retentionDays,
        webhookRetentionDays: this.webhookRetentionDays,
        batchSize: this.batchSize
      });

      this.logger.info('cleanup.run.completed', summary);

      if (summary.failures.length > 0) {
        await this.reportIncidentFn({
          severity: 'error',
          source: 'cleanup-scheduler',
          eventCode: 'CLEANUP_PARTIAL_FAILURE',
          message: `Cleanup completed with ${summary.failures.length} failure(s)`,
          fingerprint: 'cleanup-scheduler:CLEANUP_PARTIAL_FAILURE:daily',
          context: summary
        });
      }

      return summary;
    } catch (error) {
      this.logger.critical('cleanup.run.failed', { error });
      await this.reportIncidentFn({
        severity: 'critical',
        source: 'cleanup-scheduler',
        eventCode: 'CLEANUP_RUN_FAILED',
        message: error.message,
        fingerprint: 'cleanup-scheduler:CLEANUP_RUN_FAILED:daily',
        context: { error }
      });
      return null;
    } finally {
      this.executing = false;
      this._schedule(this.intervalMs);
    }
  }
}

module.exports = new CleanupScheduler();
module.exports.CleanupScheduler = CleanupScheduler;
module.exports.envInt = envInt;
