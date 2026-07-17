# PromptGen

PromptGen is a Node.js/Express application that turns images and scenarios into production-ready prompts and durable Storyboard generation jobs.

## Local setup

1. Install Node.js 24.x. The repository `.nvmrc`, package engine, and CI use the same major version.
2. Copy `.env.example` to `.env` and fill the required values.
3. Install dependencies with `npm ci`.
4. Start the app with `npm run dev`.
5. Check `http://localhost:3000/api/health`.

Never expose `SUPABASE_SERVICE_ROLE_KEY`, Paddle secrets, AI API keys, or alert webhook URLs to browser code.

## Validation

- Full clean-clone gate: `npm test`
- Unit tests: `npm run test:unit -- --runInBand`
- Browser E2E only: `npm run test:e2e`
- Production smoke: `APP_URL=https://promptgen-ai.com npm run smoke`
- Cleanup dry-run: `npm run cleanup:dry-run`
- Cleanup execution: `npm run cleanup`

Playwright starts and stops an isolated local server for E2E. Its test environment uses placeholder provider credentials and disables the durable worker, cleanup scheduler, and alert delivery, so the 14 browser checks cannot call production Supabase, Paddle, or AI services. Install the local Chromium binary once with `npx playwright install chromium` when needed.

The production smoke test performs read-only checks. It does not create a paid Storyboard, call Paddle, or spend AI credits.

## Operations model

### Durable Storyboard worker

Storyboard jobs live in the `storyboards` table. Workers claim jobs with a fenced token and lease, heartbeat during processing, retry bounded transient failures, and atomically refund terminal failures. The default idle poll interval is five seconds; a successful enqueue wakes the local worker immediately.

### Incident handling

Application events are emitted as one-line JSON with:

- `timestamp`
- `level`
- `event`
- `service`
- request, Storyboard, transaction, or Paddle event identifiers when applicable

Critical operational failures are deduplicated into `ops_incidents` through the service-role-only `record_ops_incident` RPC. A Supabase Cron job runs `scan_ops_health()` every five minutes and detects stuck Storyboard jobs, missing refunds, and overdue cleanup.

Set `OPS_ALERT_WEBHOOK_URL` to forward the first open critical occurrence. Supported formats are `generic`, `slack`, and `discord`. The incident remains in Supabase even when webhook delivery fails.

### Cleanup

The Railway web process starts a Storage-aware cleanup scheduler after boot and repeats it daily. It removes Storage objects before deleting metadata, processes only terminal Storyboards, retries partial failures on the next run, and stores failures as incidents.

Use `npm run cleanup:dry-run` before any manual cleanup.

## Product analytics

PromptGen records a small, allowlisted first-party funnel without third-party SDKs or persistent tracking cookies. Browser navigation and intent use a session-scoped UUID; analysis, Storyboard, signup, and payment outcomes come from authoritative server or database events.

The event table is service-role-only, rejects unknown properties and raw query/fragment paths, and is purged after 180 days. See [docs/product-analytics.md](docs/product-analytics.md) for the privacy contract, taxonomy, baseline, and read-only funnel queries.

## Deployment runbook

### Before merge

1. Confirm the branch targets the latest `master`.
2. Run unit tests and review the migration.
3. Verify active paid jobs with:
   `select count(*) from storyboards where status in ('pending','processing');`
4. Record current security and performance advisor output.
5. Run cleanup in dry-run mode.

### Safe rollout order

1. Apply the backward-compatible Supabase migration.
2. Verify RLS, grants, RPC execute privileges, Cron job registration, and a manual `scan_ops_health()`.
3. Merge only after CI passes.
4. Let Railway deploy the merge commit.
5. Check `/api/health`, the Railway commit SHA, worker start, cleanup scheduler start, and Supabase API/Cron history.
6. Confirm no new active incident except intentionally injected test incidents.
7. Observe the next real Storyboard creation from enqueue through completion or exact refund.

### Stop conditions

Stop the rollout if:

- anon or authenticated can read/write `ops_incidents`;
- an incident RPC is executable outside `service_role`;
- Cron history records a failed scan;
- cleanup reports metadata deletion after a Storage failure;
- worker claim calls return non-2xx responses;
- Railway health does not report the merge commit.

### Rollback

1. Roll Railway back to the previous healthy commit.
2. Do not remove the additive incident tables or queue columns during the incident.
3. Disable optional schedulers with `CLEANUP_SCHEDULER_ENABLED=false` or `STORYBOARD_DURABLE_WORKER_ENABLED=false` only when their component is the confirmed cause.
4. Unschedule the health scan with:
   `select cron.unschedule(jobid) from cron.job where jobname = 'promptgen-ops-health-scan';`
5. Preserve `ops_incidents`, `ops_health_checks`, Storyboard rows, and logs for diagnosis.
6. Re-run the health scan and reconcile credits before resuming traffic.

## Known operational follow-ups

- Configure an external alert webhook and verify one injected critical incident reaches the selected channel.
- Enable Supabase leaked-password protection if password login remains available.
- Continue optimizing legacy RLS policies flagged by the performance advisor.
