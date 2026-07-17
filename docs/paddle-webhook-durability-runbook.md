# Paddle webhook durability runbook

## Purpose

Migration `015_durable_paddle_webhook_inbox.sql` separates webhook receipt, claim, business completion, and failure. It also moves subscription payment and full-refund ledger/profile changes into single Postgres transactions.

## Historical backfill policy

The legacy table recorded `processed_at = now()` before business processing. Its historical rows therefore cannot prove business completion. Migration 015 preserves every legacy row as `completed`, sets `attempt_count = 1`, and copies `processed_at` to `received_at`. This avoids automatically replaying old monetary events. The production audit performed before this migration found 19 such rows and no current purchase/credit-ledger/profile inconsistency, but that is an operational reconciliation result rather than proof of historical execution.

## Safe rollout

1. Confirm the current server still inserts only `event_id` into `webhook_events`.
2. Confirm no known payment, refund, or cancellation incident is awaiting manual replay.
3. Apply migration 015. It is backward-compatible with the old server because `status` and `processed_at` still default to `completed` and `now()` for legacy direct inserts.
4. Verify schema, grants, constraints, and the 19-row backfill.
5. Deploy the server release that calls `claim_paddle_webhook_event`, `complete_paddle_webhook_event`, and `fail_paddle_webhook_event`.
6. Replay Paddle sandbox fixtures for `transaction.completed`, `subscription.updated`, `subscription.canceled`, and `adjustment.created`. For each fixture, force the first business attempt to fail, then resend the same `notification_id` and verify that the second attempt completes exactly once.
7. Monitor failed and expired-processing rows for at least one complete billing/refund test cycle.

Do not deploy the new server before the migration. If that happens, claim RPC calls fail closed with HTTP 503; no monetary mutation should run, but Paddle deliveries will be delayed.

## Verification queries

```sql
select status, count(*)
from public.webhook_events
group by status
order by status;

select count(*) as invalid_state_rows
from public.webhook_events
where not (
  (status = 'completed' and processed_at is not null and claim_token is null and claimed_at is null and lease_expires_at is null)
  or (status = 'processing' and processed_at is null and claim_token is not null and claimed_at is not null and lease_expires_at is not null)
  or (status = 'failed' and processed_at is null and claim_token is null and claimed_at is null and lease_expires_at is null)
);

select event_id, status, attempt_count, received_at, processed_at,
       lease_expires_at, left(last_error, 160) as last_error
from public.webhook_events
where status <> 'completed'
order by updated_at desc;

select
  has_function_privilege('service_role', 'public.claim_paddle_webhook_event(text,uuid,integer)', 'execute') as service_can_claim,
  has_function_privilege('authenticated', 'public.claim_paddle_webhook_event(text,uuid,integer)', 'execute') as user_can_claim,
  has_function_privilege('service_role', 'public.apply_subscription_payment(text,uuid,text,integer,boolean)', 'execute') as service_can_apply_payment,
  has_function_privilege('authenticated', 'public.apply_subscription_payment(text,uuid,text,integer,boolean)', 'execute') as user_can_apply_payment,
  has_function_privilege('service_role', 'public.apply_purchase_refund(text,text,integer,boolean)', 'execute') as service_can_refund,
  has_function_privilege('authenticated', 'public.apply_purchase_refund(text,text,integer,boolean)', 'execute') as user_can_refund;
```

Expected privilege results are `true, false, true, false, true, false`. `invalid_state_rows` must be zero.

## Failure and replay expectations

- A business failure changes the inbox row to `failed`, clears the lease, increments no money twice, and stores a single-line error capped at 1,000 characters.
- The next delivery of the same `notification_id` reclaims the failed row and increments `attempt_count`.
- A concurrent delivery while a lease is active receives HTTP 503 with `Retry-After: 5`; it must not run business code.
- A delivery after completion receives HTTP 200 and must not run business code.
- A missing `notification_id` is rejected. Falling back to `data.id` is unsafe because multiple subscription notifications can share the same business object ID.
- Partial refunds never revoke a full credit allotment. They create a critical incident for manual review.

## Rollback

Prefer an application-only rollback:

1. Stop or drain the new server release.
2. Confirm `status = 'processing'` count is zero. Preserve every `failed` row for audit and manual replay.
3. Deploy the previous server. It remains compatible with the additive migration.
4. Leave the migration in place unless removal is operationally required.

If schema removal is required, do it only after the previous server is active and no claims are in flight. Drop the five new functions, the two partial indexes, the three new constraints, and then only the additive columns. Never delete or rewrite `event_id` or `processed_at` history. A schema rollback is not safe while the new server is running.

## Stop conditions

Stop deployment and do not acknowledge the affected webhook if any of the following occurs:

- purchase status, profile plan/credits, and the credits ledger disagree after replay;
- the same notification performs a business mutation more than once;
- a failed row cannot be reclaimed, or a completed row can be reclaimed;
- authenticated or anonymous roles can execute any new privileged RPC;
- the old-server/migration/new-server ordering produces a schema error or silently acknowledges a failed monetary event.
