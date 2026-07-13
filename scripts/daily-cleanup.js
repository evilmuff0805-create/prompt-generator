'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runCleanup } = require('../lib/cleanup-service');
const { reportIncident } = require('../lib/incident-reporter');
const logger = require('../lib/logger');

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const dryRun = process.argv.includes('--dry-run');
const retentionDays = Number.parseInt(process.env.STORYBOARD_RETENTION_DAYS || '30', 10);
const webhookRetentionDays = Number.parseInt(
  process.env.WEBHOOK_EVENT_RETENTION_DAYS || '90',
  10
);
const batchSize = Number.parseInt(process.env.CLEANUP_BATCH_SIZE || '100', 10);

async function main() {
  const summary = await runCleanup({
    client: admin,
    dryRun,
    retentionDays,
    webhookRetentionDays,
    batchSize
  });

  logger.info('cleanup.cli.completed', summary);

  if (summary.failures.length > 0) {
    await reportIncident({
      severity: 'error',
      source: 'cleanup-cli',
      eventCode: 'CLEANUP_PARTIAL_FAILURE',
      message: `Cleanup completed with ${summary.failures.length} failure(s)`,
      fingerprint: 'cleanup-cli:CLEANUP_PARTIAL_FAILURE:manual',
      context: summary
    });
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  logger.critical('cleanup.cli.failed', { error });
  await reportIncident({
    severity: 'critical',
    source: 'cleanup-cli',
    eventCode: 'CLEANUP_RUN_FAILED',
    message: error.message,
    fingerprint: 'cleanup-cli:CLEANUP_RUN_FAILED:manual',
    context: { error }
  });
  process.exitCode = 1;
});
