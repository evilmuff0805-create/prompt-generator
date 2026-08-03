# Payment pricing and credit-pack rollout

## Current release status

This payment change is a **Draft-PR-only, no-deploy foundation**. Do not merge,
deploy, apply the migrations to the live database, create or archive live Paddle
prices, or enable a feature flag until every blocking gate in this runbook is
complete and the release is explicitly approved.

The intended commercial contract is:

| Offering | Price | Included or purchased credits | Billing |
| --- | ---: | ---: | --- |
| Existing Pro subscriber | USD 9.99 | 600 per subscription cycle | Monthly renewal, grandfathered |
| New Pro subscriber after cutover | USD 10.99 | 600 per subscription cycle | Monthly |
| Enterprise | USD 19.99 | 1,500 per subscription cycle | Monthly |
| Usage Add-on — 600 Credits | USD 10 | 600 | One-time immediate subscription charge |
| Usage Add-on — 1,500 Credits | USD 20 | 1,500 | One-time immediate subscription charge |
| Usage Add-on — 3,000 Credits | USD 40 | 3,000 | One-time immediate subscription charge |

Add-on credits are PromptGen-only, non-transferable, have no cash value, and
expire 365 days after Paddle's signed transaction `occurred_at` timestamp.
Purchase and consumption require an eligible, active paid subscription.

All payment and ledger feature flags default to `false`.

The Draft PR now contains the **static code foundation** for the approved
temporal rule. A usage add-on authorization is valid only from its immutable
server authorization timestamp up to, but not including, 15 minutes later.
The signed `transaction.completed` timestamp, captured-payment evidence,
immutable PromptGen request, Paddle Subscription History proof, and durable
subscription lifecycle history are evaluated before entitlement is granted.
An expired, ineligible, unavailable, ambiguous, already-adjusted, or otherwise
unsafe payment is recorded as `withheld` without creating a spendable credit
lot, and its later refund or chargeback remains attributable.

This static foundation is not release proof. The Paddle API key must be granted
and verified for Subscription History reads, the complete temporal and
adjustment matrix must pass in Paddle Sandbox, and migrations 023 through 027
must pass against a production-schema clone. All payment and ledger flags
remain `false`; no production migration, deployment, or checkout activation is
authorized by this document.

Known cutover gate: an already-bound subscription checkout preserves its
immutable price contract. Before enabling the USD 10.99 flag, every open
USD 9.99 checkout attempt must be inventoried and either completed under an
explicitly approved grace policy or canceled at Paddle and closed through an
audited reconciliation path. Do not rely on toggling the flag to invalidate an
already-created provider transaction.

## Non-negotiable payment invariants

1. The browser never chooses or submits a Paddle Price ID, user ID, credit
   quantity, amount, product name, or grant date.
2. The public product catalog exposes Paddle's client token and display data,
   but no subscription or add-on Price IDs.
3. A durable database attempt or request is created before any provider call
   that may charge money.
4. A browser response never grants a plan or credits. Only a valid, timely,
   signed Paddle webhook may complete fulfillment.
5. Provider timeouts, network failures, malformed success responses, and HTTP
   5xx responses are `provider_unknown`. They are never retried automatically,
   because Paddle may already have charged the customer.
6. Webhooks are idempotent, entity ordered, source aware, and fail closed when
   the provider contract, database binding, amount, currency, or state is
   ambiguous.
7. Disabling new sales must not disable webhook, refund, chargeback,
   reconciliation, or expiry processing for money already accepted.

## Secure subscription checkout

New subscriptions use a server-created Paddle transaction:

1. The authenticated browser sends only the requested PromptGen plan to
   `POST /api/payment/checkout`.
2. The server selects the flag-controlled, allowlisted Price ID and immutable
   plan contract.
3. `create_subscription_checkout_attempt` records the authenticated user,
   plan, expected Price ID, amount, currency, and a generated attempt ID before
   contacting Paddle. At most one open attempt exists per user.
4. The server creates the Paddle transaction through the API with
   `origin=api` and server-owned custom data identifying
   `promptgenKind=subscription_checkout` and the opaque attempt ID.
5. The returned transaction is validated and bound to the same database
   attempt before its transaction ID is returned to the browser.
6. Paddle.js opens only that server-created transaction ID.
7. A signed `transaction.completed` webhook must consume the exact attempt
   binding before the initial subscription can provision a paid plan.

An initial subscription transaction with `origin=web`,
`origin=checkout`, an unknown server transaction binding, a reused
transaction, a mismatched user/plan/Price ID/amount/currency, or a terminal
attempt must be recorded as a payment incident and **must not** provision
entitlement. Operators must reconcile the payment in Paddle and issue a manual
refund when appropriate.

Paddle custom data is an optional integrity signal, not the ownership source.
It can be changed at checkout and copied from an initial transaction onto later
subscription transactions. Initial checkout ownership is therefore resolved by
the immutable database attempt bound to Paddle's transaction ID. If PromptGen
checkout metadata is present it must match that attempt exactly; if it is absent
or unrelated, the server transaction binding remains authoritative.

Renewals and later subscription lifecycle events do not depend on browser
custom data. They resolve ownership through the stored Paddle subscription and
customer bindings plus the ordered subscription-state reducer.

The reducer locks and rechecks the profile's current subscription binding
inside the same database transaction. A late cancellation or renewal from a
superseded subscription is recorded against that old subscription but cannot
expire or overwrite the newer entitlement. A superseded paid transaction is
recorded without entitlement and raises a critical reconciliation incident.

Paid-plan mutation through PromptGen's plan-change endpoint is intentionally
disabled in this foundation. Preview is read-only and returns an allowlisted
currency/total summary; the endpoint does not pass Paddle's raw response to the
browser. A real plan change must not be enabled until it has the same
request-first durability, unknown-provider reconciliation, webhook ordering,
and duplicate-submit protection as initial checkout and usage add-ons.

## Pro USD 10.99 cutover and USD 9.99 grandfathering

Never edit the amount of the stable USD 9.99 Pro price. Keep its ID in
`PADDLE_PRO_PRICE_ID` so existing subscribers remain mapped to Pro and their
renewals can be reconciled. Put the new USD 10.99 recurring price in
`PADDLE_PRO_1099_PRICE_ID`.

With `PRO_PRICE_1099_ENABLED=false`, new Pro checkout remains on the stable
USD 9.99 price. With the flag enabled, the server alone selects the USD 10.99
price for new Pro checkout; the stable USD 9.99 price remains inbound-only for
grandfathered subscriptions.

Do not assume that archiving the USD 9.99 price preserves existing renewals.
Before changing its status, obtain written Paddle confirmation and prove the
exact renewal, customer-portal, retry, pause/resume, and cancel/resubscribe
behavior in Sandbox. Set `PADDLE_PRO_999_EXPECTED_STATUS` to the verified
state. Every additional historical Pro Price ID must be listed in
`PADDLE_PRO_LEGACY_PRICE_IDS` with an exact amount/status expectation in
`PADDLE_PRO_LEGACY_PRICE_EXPECTATIONS`.

The staged catalog audit must verify the current, new, and legacy prices,
products, amounts, currency, cadence, status, product names, and collisions:

```text
npm run audit:paddle-catalog
```

## Secure usage add-on purchase

Usage add-ons deliberately have **no reusable active Paddle Price IDs**.
Each purchase is an immediate one-time charge attached to the customer's
existing active subscription and uses a transaction-specific non-catalog price
and product.

The flow is:

1. The authenticated user chooses only the pack key.
2. The server reloads both PromptGen subscription state and the live Paddle
   subscription. It accepts only the same bound customer and subscription with
   `status=active`, automatic collection, the expected single plan item, no
   disqualifying scheduled change, and an eligible paid PromptGen plan.
3. `POST /api/payment/credit-packs/preview` asks Paddle to preview the exact
   immediate charge using the server-owned pack contract.
4. The UI displays Paddle's authoritative subtotal, tax, currency, and final
   total. The customer must explicitly confirm the final total; merely choosing
   a pack is not consent to charge.
5. The purchase endpoint recomputes eligibility and preview. If the confirmed
   total no longer matches, it returns a fresh preview and does not charge.
6. `create_credit_pack_purchase_request` durably records the immutable pack
   key, credits, USD contract, customer, subscription, expiry policy, and
   opaque request ID before Paddle is called. It also records the verified
   Paddle subscription response timestamp and request ID, the current signed
   active lifecycle snapshot, and the exclusive 15-minute authorization
   window. At most one unresolved request exists per user.
7. The server calls Paddle's immediate subscription charge endpoint with
   `effective_from=immediately`, `on_payment_failure=prevent_change`, quantity
   one, and transaction-specific non-catalog price/product metadata containing
   only the opaque purchase request ID and pack key.
8. The browser polls the authenticated request-status endpoint. The request ID
   is retained across reloads so returning to Pricing resumes status display
   instead of issuing a second charge.
   If the browser lost the charge response before learning the request ID, it
   performs one authenticated, owner-scoped lookup for the newest non-terminal
   request and resumes that request. A 72-hour reconciled no-match remains
   review-locked and discoverable from `reconciliation_closed_at` rather than
   disappearing because its original `created_at` is old. The browser never
   repeats the purchase POST.
9. Only a valid signed `transaction.completed` event with
   `origin=subscription_charge`, the exact request/subscription/customer
   binding, one custom line item, one captured payment, the exact pack
   contract, and eligible Subscription History proof can grant credits.

An exhaustive no-match reconciliation applies only after the authorization
window plus 72 hours for `charging`, `submitted`, or `provider_unknown`.
Before any Paddle transaction scan, the operator is restricted to PromptGen's
exact Supabase project and reads the exact Paddle subscription with the same
API key. Subscription ID, customer ID, bound recurring plan Price ID, API
environment, and provider request ID must all match. A wrong project, key/base
environment mismatch, wrong Paddle seller, missing permission, malformed
response, or failed entity read stops before both the scan and database RPC.

Paddle's list API and PostgreSQL cannot share one atomic transaction. An
exhaustive no-match scan therefore records its evidence but deliberately keeps
the request review-locked as `provider_unknown`; it never reopens purchasing.
The confirmation scan must take a fresh cutoff immediately before the write so
a transaction created after the first scan is inside the second scan. If an
exact signed completion is then delivered, only that specific reconciled
request may continue through all normal identity, amount, authorization-window,
Subscription History, lifecycle, adjustment, and receipt-idempotency checks. A
fully valid completion grants once, preserves the reconciliation evidence, and
records a critical `CREDIT_PACK_RECONCILIATION_SUPERSEDED` incident. Every
ordinary failure or mismatch remains withheld and review-locked until a
confirmed full refund clears it. Releasing a no-match lock requires a separate,
audited provider-terminal operator procedure; that release procedure is not
part of this foundation.

The temporal interval is exactly:

```text
authorized_at <= transaction.completed.occurred_at < authorization_expires_at
authorization_expires_at = authorized_at + 15 minutes
authorized_at - 5 minutes <= eligibility_check_started_at
eligibility_check_started_at <= authorized_at + 30 seconds

history_start_at = min(eligibility_check_started_at, authorized_at)
history_start_at <= subscription_history.occurred_at
subscription_history.occurred_at <= transaction.completed.occurred_at
```

PromptGen requests Paddle Subscription History from the earlier of
`eligibility_check_started_at` and `authorized_at` through the signed completion
time, inclusive, and validates every page and provider request ID. The immutable
request also stores when that eligibility check began. A check older than five
minutes at database authorization, or more than 30 seconds ahead of the
database clock, is rejected before a charge request can proceed; the 30-second
allowance is only a bounded clock-skew tolerance. A pause, past-due transition,
cancellation, disqualifying subscription-history action, database lifecycle
event, or adjustment at or before completion makes the payment ineligible.
History permission errors, incomplete pagination, malformed evidence, clock
ambiguity, and missing proof fail closed to `withheld`. A withheld payment is
audited with its provider event, transaction creation, capture, completion,
request, subscription, amount, and history evidence; no credit lot is minted.
It is never charged again automatically.

An eligible History proof contains **exactly one**
`subscription_one_off_charge_applied` event whose `effective_from` is
`immediately`, whose transaction ID is the exact completed transaction, and
whose event time is from `authorized_at` through the signed completion time,
inclusive. No matching event, a duplicate matching event, a match before
authorization, an unknown or malformed action, or any other documented
subscription action in the inspected interval fails closed. Route validation
and the money-moving database RPC both enforce this proof so a caller cannot
bypass it by invoking the RPC directly.

The initial add-on release does not support Paddle discounts or customer credit
balances. A valid preview must have `discount=0`, `credit=0`,
`total=subtotal+tax`, `grand_total=total`, `balance=grand_total`, and
`grand_total_tax=tax`. The signed completed transaction must preserve the
approved subtotal, discount, tax, total, credit, grand total, and grand-total
tax; its post-payment balance must be zero and its single captured payment must
equal the grand total. A discount or customer credit detected in preview is
rejected before charging. If any amount changes or a customer credit is applied
after confirmation but before completion, fulfillment is withheld and the
payment must follow the manual refund/reconciliation runbook.

If an adjustment arrives before `transaction.completed`, its immutable receipt
is retained even though the payment receipt does not exist yet. Fulfillment
later resolves an approved full refund or credit directly to `refunded`, or an
approved full chargeback to `chargeback`, marks the adjustment matched/applied,
and returns without creating a credit lot. A pre-completion refund closes
without manual entitlement work; a chargeback remains review-required while
still being terminal for payment and entitlement. Partial, unapproved, or
otherwise ambiguous preceding adjustments remain withheld for manual review.

Account deletion never deletes the immutable payment, request, provider-event,
or adjustment receipts. User-owned checkout, purchase, and credit-lot rows may
be removed by their foreign-key policy, while retained evidence sets `user_id`
to null. A later signed, approved full refund, credit, or chargeback
terminalizes those retained records without calling a user balance or lot
mutator. Partial, unapproved, or ambiguous adjustments remain review-required.

The three allowed non-catalog contracts are:

| Product | Price | Credits | Required checkout and receipt wording |
| --- | ---: | ---: | --- |
| PromptGen AI Usage Add-on — 600 Credits | USD 10 one-time | 600 | Expires 365 days after purchase; active paid plan required; PromptGen use only; non-transferable; no cash value |
| PromptGen AI Usage Add-on — 1,500 Credits | USD 20 one-time | 1,500 | Expires 365 days after purchase; active paid plan required; PromptGen use only; non-transferable; no cash value |
| PromptGen AI Usage Add-on — 3,000 Credits | USD 40 one-time | 3,000 | Expires 365 days after purchase; active paid plan required; PromptGen use only; non-transferable; no cash value |

`PADDLE_CREDIT_PACK_TAX_CATEGORY` must be confirmed for this product before
release. Keep `PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED=false` until that
written confirmation exists; checkout activation fails closed unless the
category is configured and the confirmation flag is exactly `true`. If
reusable add-on prices were created during an earlier experiment,
list them in the matching `PADDLE_CREDIT_PACK_*_LEGACY_PRICE_IDS` variables.
The read-only audit verifies only explicitly declared IDs; it does not enumerate
the full Paddle catalog. Blank legacy-ID variables therefore do **not** prove
that no reusable prices exist. With zero declared IDs the command reports
`not audited; manual inventory required` and exits nonzero, so activation
remains fail-closed. First inventory the full Paddle catalog manually and retain
the evidence, then list every reusable add-on Price ID found. The read-only
audit must confirm every declared ID is archived:

```text
npm run audit:paddle-credit-packs
```

## Ledger, refunds, chargebacks, and expiry

Migration 023 creates the private, operator-reviewed legacy-balance manifest.
Migration 024 introduces source-aware credit lots and allocations. Plan-cycle,
subscription carry-in, manual carryover, and add-on credits remain separately
attributable; a refund must
never debit an unrelated lot.

- A successful add-on lot expires at signed Paddle `occurred_at + 365 days`,
  not browser time, API-response time, webhook receive time, or processing
  time.
- Duplicate completed transactions grant once.
- A full refund of a wholly unspent pack revokes that source lot once.
- A full refund after spending, a chargeback, or any state that cannot be
  mapped exactly creates a critical reconciliation incident rather than
  subtracting unrelated credits.
- A non-credit-pack `chargeback`, `chargeback_warning`, or corresponding
  reverse action is always persisted as a critical manual-review incident.
  Forward and reversal states remain distinct, no automatic credit or plan
  mutation is inferred, and a failed incident write keeps the webhook retryable.
- An approved partial refund immediately changes the remaining source lot to
  `quarantined`. Quarantined credits cannot be consumed and are excluded from
  the spendable profile balance until an operator performs source-aware
  reconciliation.
- Canceling or losing the paid plan blocks add-on purchase and consumption; it
  does not silently remap or destroy audit records.

## Mandatory migration order

Apply and verify the migrations exactly in this order:

1. `migrations/023_legacy_credit_classification_manifest.sql`
2. Populate and independently review the private manifest as described below.
3. `migrations/024_credit_lot_ledger.sql`
4. `migrations/025_paddle_event_ordering.sql`
5. `migrations/026_secure_payment_requests.sql`
6. `migrations/027_secure_subscription_checkout.sql`

Do not skip or reorder them. Migration 024 consumes the exact Migration 023
snapshot. Migration 026 depends on the ledger and ordered subscription state.
Migration 027 depends on the payment-request foundation and
adds durable subscription checkout attempts.

Before step 1, run both migration-history and schema-landmark checks against
the exact target project. The history query must return zero rows and every
landmark boolean must be `false`:

```sql
SELECT version, name
FROM supabase_migrations.schema_migrations
WHERE version IN ('023', '024', '025', '026', '027')
   OR name IN (
     'legacy_credit_classification_manifest',
     'credit_lot_ledger',
     'paddle_event_ordering',
     'secure_payment_requests',
     'secure_subscription_checkout'
   )
ORDER BY version;

SELECT
  to_regnamespace('promptgen_private') IS NOT NULL
    AS private_schema_exists,
  to_regclass(
    'promptgen_private.legacy_credit_classification_manifest'
  ) IS NOT NULL AS legacy_manifest_exists,
  to_regclass('public.credit_lots') IS NOT NULL AS credit_lots_exists,
  to_regclass('public.paddle_event_watermarks') IS NOT NULL
    AS paddle_event_watermarks_exists,
  to_regclass('public.credit_pack_purchase_requests') IS NOT NULL
    AS credit_pack_purchase_requests_exists,
  to_regclass('public.subscription_checkout_attempts') IS NOT NULL
    AS subscription_checkout_attempts_exists;
```

This gate covers both tracked and manually applied SQL. If any row or landmark
exists, stop: do not repair migration history, rename an applied migration, or
rerun these files. First produce and independently review a forward-only
reconciliation migration for the observed target state.

### Private legacy-credit manifest

Migration 023 creates `promptgen_private`, which is not included in the current
Data API exposed schemas and grants no access to `PUBLIC`, `anon`,
`authenticated`, or `service_role`. It
does not contain email, name, or raw Paddle identifiers. Apply it first, freeze
profile, purchase, ledger, analysis, and Storyboard writers, and prepare the
manifest only from a restricted database-owner session. Do not save the
production UUID values in this repository, CI output, Notion, or chat.

The approved cutover decision is:

- the reviewed 570-credit family test profile is `manual_carryover`;
- the reviewed 30-credit Paddle-bound profile is `subscription_carry_in`.

At the maintenance window, create a temporary decision table and enter the
reviewed production UUIDs only in that database session. Every placeholder below
is deliberately rejected until replaced:

```sql
BEGIN;

LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.purchases IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.credits_ledger IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE legacy_credit_decisions (
  user_id uuid PRIMARY KEY,
  classification text NOT NULL CHECK (
    classification IN ('subscription_carry_in', 'manual_carryover')
  ),
  review_reference text NOT NULL CHECK (
    btrim(review_reference) <> ''
    AND btrim(review_reference) !~ '^<[^>]+>$'
  )
) ON COMMIT DROP;

INSERT INTO legacy_credit_decisions (
  user_id,
  classification,
  review_reference
) VALUES
  ('<replace-with-reviewed-570-profile-uuid>'::uuid,
   'manual_carryover',
   '<opaque-review-reference>'),
  ('<replace-with-reviewed-30-profile-uuid>'::uuid,
   'subscription_carry_in',
   '<opaque-review-reference>');

WITH
batch AS MATERIALIZED (
  SELECT gen_random_uuid() AS batch_id, clock_timestamp() AS captured_at
)
INSERT INTO promptgen_private.legacy_credit_classification_manifest (
  batch_id,
  user_id,
  snapshot_captured_at,
  expected_plan,
  expected_credits,
  expected_has_paddle_customer,
  expected_has_paddle_subscription,
  expected_purchase_count,
  expected_ledger_count,
  expected_evidence_fingerprint,
  classification,
  review_reference,
  reviewed_by,
  reviewed_at
)
SELECT
  batch.batch_id,
  p.id,
  batch.captured_at,
  p.plan,
  p.credits,
  NULLIF(btrim(p.paddle_customer_id), '') IS NOT NULL,
  NULLIF(btrim(p.paddle_subscription_id), '') IS NOT NULL,
  (SELECT count(*) FROM public.purchases x WHERE x.user_id = p.id),
  (SELECT count(*) FROM public.credits_ledger l WHERE l.user_id = p.id),
  promptgen_private.legacy_credit_evidence_fingerprint(p.id),
  d.classification,
  d.review_reference,
  '<opaque-operator-id>',
  batch.captured_at
FROM legacy_credit_decisions d
JOIN public.profiles p ON p.id = d.user_id
CROSS JOIN batch;

-- Review only counts and totals. Both mismatch counts must be zero.
SELECT
  count(*) AS manifest_rows,
  sum(expected_credits) AS manifest_credits,
  count(*) FILTER (WHERE classification = 'manual_carryover') AS manual_rows,
  sum(expected_credits) FILTER (
    WHERE classification = 'manual_carryover'
  ) AS manual_credits,
  count(*) FILTER (
    WHERE classification = 'subscription_carry_in'
  ) AS subscription_rows,
  sum(expected_credits) FILTER (
    WHERE classification = 'subscription_carry_in'
  ) AS subscription_credits
FROM promptgen_private.legacy_credit_classification_manifest;

SELECT count(*) AS missing_manifest_rows
FROM public.profiles p
LEFT JOIN promptgen_private.legacy_credit_classification_manifest m
  ON m.user_id = p.id
WHERE p.credits > 0 AND m.user_id IS NULL;

SELECT count(*) AS extra_manifest_rows
FROM promptgen_private.legacy_credit_classification_manifest m
LEFT JOIN public.profiles p ON p.id = m.user_id
WHERE p.id IS NULL OR p.credits <= 0;

COMMIT;
```

Migration 024 accepts only one batch captured within the preceding 24 hours.
It locks the full evidence boundary, rejects missing, extra, duplicate, mixed,
stale, pre-consumed, or drifted decisions, then backfills and consumes the
manifest in one transaction. `subscription_carry_in` follows subscription
renewal/change/cancellation expiry; `manual_carryover` never expires with the
subscription and is spent only after subscription and expiring credit-pack
lots.

`CREDIT_LEDGER_V2_ENABLED=false` is an application activation guard, not a
database rollback. Migration 024 replaces existing consumption/refund RPCs and
triggers as soon as it is applied. A failed clone migration or concurrency test
therefore blocks production migration even while every feature flag is false.

Before any production migration:

- test backup and restore;
- repeat the migration-history and schema-landmark gate above against the exact
  target project immediately before the maintenance window;
- apply all five migrations, including the reviewed manifest population between
  migrations 023 and 024, to a clone of the actual production schema;
- inventory every positive legacy `profiles.credits` balance and explicitly
  classify it as subscription carry-in or manual/carryover credit against an
  operator-reviewed snapshot. Plan, Paddle binding, and arithmetic history are
  supporting evidence only and must never auto-classify provenance;
- prove every non-null Paddle subscription/customer ID is already trimmed,
  non-empty, and at most 255 characters before migration 025;
- prove every profile with a Paddle subscription also has a Paddle customer,
  uses exactly one of the lowercase canonical values `free`, `paid`, `pro`, or
  `enterprise`, and has been reconciled against Paddle before the bootstrap
  reducer is created;
- allow a `free` profile with a retained subscription ID only when Paddle
  confirms that subscription is terminal; if Paddle reports `active` or
  `trialing`, correct the profile/ownership before migration 025 or stop the
  rollout, because a terminal bootstrap row cannot be reactivated in place;
- keep profile/payment writers frozen while migration 025 holds its profile
  bootstrap lock, and set an operator-reviewed session `lock_timeout` so a
  conflicting writer stops the rollout instead of waiting indefinitely;
- run migration invariants and inspect RLS, grants, constraints, and function
  signatures;
- test concurrent checkout attempts, add-on requests, renewal/cancellation
  events, duplicate webhooks, equal timestamps, and stale leases;
- reconcile `profiles.credits` with active ledger lots; and
- confirm no image-analysis reservations or pending/processing storyboard jobs
  exist at the cutover.

After migration 025's bootstrap barrier, reconcile every stored Paddle
subscription against a fresh Paddle response before reopening webhook-driven
mutations. Events older than the barrier are intentionally stale-blocked and
must not be blindly replayed.

## Blocking gates

No merge, production deployment, production migration, production feature flag,
or production Checkout activation may proceed until all items pass and explicit
approval is recorded:

- [ ] Paddle provides written approval that PromptGen's expiring,
  non-transferable, non-cash usage-credit model and subscription-attached
  one-time charges are acceptable for the account.
- [ ] Paddle confirms the correct tax category and the final receipt/invoice
  wording for non-catalog immediate subscription charges.
- [ ] Actual account fees, taxes, refunds, chargebacks, and net margin are
  calculated from Paddle's current account terms, not estimates.
- [ ] The material pricing/legal notice is compared against all affected terms,
  delivered with the required lead time, and its notice/effective dates are
  recorded.
- [ ] The stable USD 9.99 price's active/archived state and grandfathered
  renewal behavior are confirmed in writing and proven in Sandbox.
- [ ] Every open subscription checkout attempt is reconciled before the
  USD 10.99 cutover; no old bound USD 9.99 transaction remains indefinitely
  payable after the effective date.
- [ ] The full Paddle catalog is manually inventoried with retained evidence;
  every historical reusable add-on Price ID found is declared, and the
  read-only audit confirms every declared ID is archived. Zero declared IDs
  alone are `not audited` and cannot open the activation gate.
- [ ] An approved add-on request TTL and signed-event temporal eligibility
  rule have passed database-clone and Paddle Sandbox proof for the exclusive
  15-minute boundary, completion-before-cancellation,
  completion-after-cancellation, delayed delivery, `provider_unknown`,
  adjustment-before-completion, and manual refund/reconciliation paths. The
  static implementation in this Draft PR does not satisfy this gate by itself.
- [ ] The production Paddle API key has the required Subscription History read
  permission, and authenticated paginated history queries are proven in
  Sandbox for eligible, ineligible, empty, unavailable, malformed, and
  multi-page results.
- [ ] The reconciliation key has `subscription.read` and `transaction.read`;
  wrong Supabase project, key/API-base mismatch, wrong Paddle seller, failed
  subscription binding, incomplete pagination, and malformed provider evidence
  all prove zero reconciliation writes.
- [ ] A prior local run recorded the then-numbered migrations 023 through 026
  (now 024 through 027) passing against an
  isolated PostgreSQL 17 clone built from a read-only production `public`
  schema dump and anonymized, production-shaped data. Repeat the full run with
  retained command/output evidence before closing the failure, race, and
  rollback gate.
- [ ] A full production backup/restore rehearsal, including Auth, Storage, and
  Supabase platform metadata, is tested before any target-database migration.
- [ ] Migrations 023 and 024 pass a complete operator-reviewed legacy-balance
  manifest replay, reject missing/extra/duplicate, stale, pre-consumed, or
  drifted rows, and keep `manual_carryover` lots out of subscription renewal,
  plan-change, and cancellation expiry.
- [ ] Paddle Sandbox proves checkout, preview, explicit total confirmation,
  receipt, renewal, retry, refund, partial refund quarantine, chargeback,
  cancellation, expiry, and reconciliation behavior.
- [ ] Product name, amount, currency, tax, one-time/monthly wording, and credit
  terms match PromptGen UI, Paddle preview/checkout, receipt/invoice, customer
  portal, and legal pages in all six supported locales.
- [ ] Monitoring, durable incident records, and an operator escalation path
  exist for withheld direct payments, `provider_unknown`, stale leases,
  duplicate/missing grants, refunds, and balance divergence. A subscription
  checkout `provider_unknown` attempt may be terminalized only after two
  independent complete Paddle scans and a 72-hour delay, with immutable
  evidence, CAS, and a late-payment webhook path that grants no entitlement and
  creates a durable refund-review incident. A status-only release is forbidden.
- [ ] External alert webhooks receive only minimal event metadata; customer,
  user, subscription, transaction, request, message, and incident context stay
  in PromptGen's internal incident store.
- [ ] Real paid-plan mutation remains disabled, or its request-first,
  idempotent, timeout-reconciliation and Sandbox gates are implemented and
  proven independently.

## Stepwise verification and acceptance matrix

### 1. Local and static verification

1. Run changed-file syntax/static checks.
2. Run focused unit tests for catalog selection, server checkout, add-on
   preview/purchase/status, webhook signature/fulfillment, migrations,
   refunds, event ordering, environment validation, and audits.
3. Run the complete unit suite, every repository-defined build/lint command,
   dependency audit, and diff/secret scan. This repository currently defines no
   build or lint script, so record those checks as not applicable rather than
   claiming they passed.
4. Confirm the public catalog/API responses contain no Paddle Price IDs or
   server-owned custom data.
5. Confirm `PRO_PRICE_1099_ENABLED`, `CREDIT_LEDGER_V2_ENABLED`, and
   `CREDIT_PACK_PURCHASES_ENABLED` remain `false`, and confirm
   `PADDLE_SANDBOX_CHECKOUT_CONFIRMED=false` in the production release
   configuration.

Latest local evidence (2026-08-03):

- focused migration contracts: 5 suites and 96 tests passed;
- focused payment/lifecycle regression after removing the obsolete direct
  subscription-mutation helpers: 6 suites and 251 tests passed;
- `npm run test:unit`: 69 suites and 1,091 tests passed;
- `npm audit --omit=dev`: 0 vulnerabilities;
- the full local Playwright run under an unavailable local Supabase and
  parallel page-load pressure was not clean: 110 passed, 3 flaky, and 1 timed
  out after retry. The final timeout case passed when rerun alone with one
  worker, so this is recorded as an environment-sensitive result, not a clean
  full-suite pass;
- a fresh Supabase-compatible PostgreSQL 17.6.1 replay applied migration 023,
  populated the two-row reviewed synthetic manifest, and applied migrations
  024 through 027 in order;
- a read-only target-project check found no migration-history rows for the five
  current migration names and none of their landmark schemas/tables. The latest
  tracked migration remained `atomic_analysis_credit_operations`; no target
  data or schema was changed. Repeat this drift-sensitive gate at the actual
  maintenance window;
- the replay rejected raw Paddle-ID whitespace drift with
  `LEGACY_CREDIT_MANIFEST_SNAPSHOT_DRIFT`, rejected a conflicting profile lock
  after the five-second timeout, rejected a concurrent migration with
  `CREDIT_LEDGER_MIGRATION_ALREADY_RUNNING`, and rejected a successful rerun
  with `CREDIT_LEDGER_MIGRATION_ALREADY_APPLIED`; every failure left zero
  partial ledger DDL and zero consumed manifest rows;
- lifecycle replay preserved the 570-credit `manual_carryover` through plan
  change, cancellation, and renewal while replacing the 30-credit
  `subscription_carry_in` under subscription rules. Final profile and active-lot
  totals both equaled 1,170, and final RPC privilege checks exposed only the
  ordered runtime entry points;
- build/lint: not applicable because the repository defines neither script;
- prior GitHub Actions run 30757192139 passed the then-current Linux Node 24
  dependency audit, all 68 unit suites / 1,091 tests, and all 114 Playwright
  tests. Fresh CI is still required for this commit;
- production backup/restore, target application, deployment runtime, the wider
  payment concurrency matrix, and live/Sandbox Checkout remain
  deployment-blocking.

### 2. Production-schema clone verification

Recorded isolated runs (2026-08-01 through 2026-08-03):

- the retained report states that a read-only production `public` schema-only
  dump and an anonymized,
  production-shaped fixture were restored into disposable Supabase-compatible
  PostgreSQL 17.6.1 stacks;
- the report records the then-numbered migrations 023, 024, 025, and 026
  applying in order; it predates the new manifest migration;
- the report records 13 new tables and 40 secured functions passing existence, RLS, owner,
  `search_path`, role-grant, signature, and validated-constraint checks;
- the report records a PostgREST schema reload returning HTTP 200 with the expected payment and
  credit surfaces;
- the report records failure injection for missing dependencies, active-work preflight,
  invalid subscription bootstrap data, lock timeout, and transactional
  rollback;
- the report records behavior tests for credit reservation/completion idempotency, Paddle
  ordering and stale leases, add-on preview contention, subscription checkout
  contention, immutable binding, and single entitlement consumption;
- after the host reboot, the retained isolated failure-injection database was
  started and its final invariant SQL returned exit code 0: profile credits and
  active lots both 1,198; zero open add-on requests and zero open subscription
  checkout attempts.
- the fresh 2026-08-03 run used the same anonymized, production-shaped public
  schema boundary and the current 023-to-027 chain. It proves the reviewed
  legacy-balance cutover, failure rollback, migration lock guards, lifecycle
  separation, balance invariants, and final RPC ACLs described above.

This reduces schema-shaped migration risk but does not close the release gate.
The exercise did not restore a full Supabase physical backup, and the current
payment-request tables contain no real Sandbox scenarios. Auth, Storage,
platform metadata, the deployment runtime, the target database, and the wider
payment concurrency matrix therefore remain unproven.

1. Restore an actual production backup into an isolated clone.
2. Apply migration 023, populate and independently review the private manifest,
   then apply migrations 024, 025, 026, and 027 in sequence.
3. Run invariant queries before and after every migration and after manifest
   population.
4. Exercise concurrent create/bind/consume flows and ensure lock ordering is
   consistent.
5. Verify duplicate events are idempotent, equal-timestamp conflicts fail
   closed, terminal subscription state cannot reactivate, and a stale lease is
   never stolen automatically.
6. Prove that a forward fix and reconciliation can recover without dropping
   ledger/payment evidence.

### 3. Paddle Sandbox verification

Verified Sandbox catalog snapshot (2026-08-02, no checkout or customer
transaction created):

| Contract | Paddle Sandbox ID | Verified state |
| --- | --- | --- |
| PromptGen AI Pro product | `pro_01kz1c63973n5dhe85zzwem8sk` | active, standard, `saas` |
| Pro USD 9.99 monthly | `pri_01kz1c64mvgy2g77zh9sa42xj9` | active, USD 999, quantity 1-1, no trial |
| Pro USD 10.99 monthly | `pri_01kz1ced16q6831vgfqabavydb` | active, USD 1099, quantity 1-1, no trial |
| PromptGen AI Enterprise product | `pro_01kz1cee379z4e1ajk8tbxq2ks` | active, standard, `saas` |
| Enterprise USD 19.99 monthly | `pri_01kz1ceey4eeaktcjf9pw7qb7t` | active, USD 1999, quantity 1-1, no trial |

All three prices have no unit-price overrides and are linked to the expected
product. The create request used `tax_mode=account_setting`; Paddle persisted
`tax_mode=location` because automatic tax localization is the Sandbox account
default. This is Paddle's documented normalization behavior, not catalog
drift: <https://developer.paddle.com/changelog/2025/default-automatic-tax-setting/>.
Set `PADDLE_CATALOG_EXPECTED_TAX_MODE=location` and
`PADDLE_PRO_999_EXPECTED_TAX_MODE=location` only in the temporary Sandbox
catalog-audit process. Do not copy these Sandbox IDs into production
configuration. All release feature flags remain `false`.

**Current gate: BLOCKED.** The 2026-08-02 request returned HTTP 403, so no
price/tax total was verified and no entity was created.

Before opening Checkout, validate the exact customer-facing contract through
Paddle's official transaction-preview endpoint. Paddle documents this POST as
requiring only `transaction.read`, creating no transaction entity, and
returning no transaction ID:
<https://developer.paddle.com/api-reference/transactions/preview-transaction-create/>.
The operator verifies all three prices independently, including product name,
price name, USD unit amount, monthly billing cycle, no trial, quantity 1,
product linkage, tax mode, and Paddle-calculated subtotal/tax/total. It rejects
an unexpected transaction ID, reused provider request evidence, any contract
drift, or any non-Sandbox credential before continuing.
It also rejects `PADDLE_ENTERPRISE_PRICE_USD` unless it is unset or exactly
`19.99`, and independently requires the approved 1,999-cent contract, before
the first provider request.

Use a generic non-sensitive location and a temporary process environment:

```text
PADDLE_SANDBOX_PREVIEW_CONFIRMED=true
PADDLE_API_BASE=https://sandbox-api.paddle.com
PADDLE_API_KEY=<modern Sandbox key with transaction.read>
PADDLE_PRO_PRICE_ID=pri_01kz1c64mvgy2g77zh9sa42xj9
PADDLE_PRO_1099_PRICE_ID=pri_01kz1ced16q6831vgfqabavydb
PADDLE_ENTERPRISE_PRICE_ID=pri_01kz1ceey4eeaktcjf9pw7qb7t
PADDLE_CATALOG_EXPECTED_TAX_MODE=location
PADDLE_PRO_999_EXPECTED_TAX_MODE=location
PADDLE_SANDBOX_PREVIEW_COUNTRY_CODE=US
PADDLE_SANDBOX_PREVIEW_POSTAL_CODE=10001
npm run audit:paddle-sandbox-checkout-preview
```

This preview does not prove the hosted Checkout or PDF/email receipt. Those
still require a completed Sandbox payment. Do not use the PromptGen app for
that payment yet. This branch removes the hardcoded production browser
configuration, but the isolated deployment values, migrations 023 through 027,
dedicated test user, alerts, and Sandbox notification destination have not been
verified together. Subscription checkout writes an attempt before contacting
Paddle, and a completed webhook writes subscription, purchase, and profile
bindings, so a real app Checkout remains blocked until all of those isolation
requirements are proven.

The server also fails startup when Paddle Sandbox is paired with the PromptGen
production Supabase project or with a project that is not explicitly listed in
`PADDLE_SANDBOX_ALLOWED_SUPABASE_PROJECT_REFS`. This guard is necessary but not
sufficient for app Checkout. The browser configuration is now runtime-injected
from the same server environment, but its isolated deployment values must still
be proven before use. In addition, `PADDLE_SANDBOX_CHECKOUT_CONFIRMED` defaults
to `false`; while false, subscription checkout returns before any attempt RPC or
Paddle request. Set it to `true` only for the bounded isolated E2E window.
The inverse boundary is also enforced: a configured Paddle Production boundary
may use only the PromptGen production Supabase project. Browser runtime config
accepts only an `sb_publishable_` key or a matching legacy `anon` JWT, and server
startup rejects secret/service-role credentials in the public-key variable.

Latest provider-side check (2026-08-02): the operator audit made one Preview
request and stopped without retry when Paddle returned HTTP 403 because the
temporary Sandbox key lacked `transaction.read`. No transaction entity,
Checkout, payment, webhook, or receipt was created or verified. Repeat the
no-entity Preview audit with a least-privilege Sandbox key that includes
`transaction.read` before opening any Checkout window; do not record the key in
the repository or operator output.

Before any purchase/refund scenario, inventory the Sandbox account with the
dedicated read-only command. Inject credentials through a temporary local
environment rather than CLI arguments or committed files:

```text
PADDLE_SANDBOX_AUDIT_CONFIRMED=true
PADDLE_API_BASE=https://sandbox-api.paddle.com
PADDLE_API_KEY=<modern Sandbox read-only key>
npm run audit:paddle-sandbox
```

The key needs `product.read`, `price.read`, `transaction.read`,
`subscription.read`, `notification_setting.read`, and `notification.read`.
The command performs only authenticated `GET` requests. Products and prices
are emitted as a constrained catalog inventory; transaction, subscription,
notification-setting, and notification results are aggregate-only. Any
missing scope, malformed/incomplete pagination, non-Sandbox base/key, or
unavailable endpoint makes the audit incomplete and exits nonzero. Never copy
the key, raw Paddle response, customer data, portal URL, webhook destination,
endpoint secret, or notification payload into the repository or release
evidence.

| Scenario | Required result |
| --- | --- |
| Anonymous or Free user attempts purchase | Server rejects; no Paddle transaction or database money request is created |
| New Pro checkout | Server-created `origin=api` transaction; Paddle and receipt show USD 10.99/month after cutover |
| Existing USD 9.99 renewal | Remains Pro at USD 9.99; pause/resume/retry/customer-portal behavior matches written Paddle confirmation |
| Forged browser Price ID, user ID, quantity, amount, or custom data | Ignored or rejected; server contract is authoritative |
| Direct Paddle.js `web`/`checkout` transaction | Payment is withheld from entitlement, incident is created, and operator follows the manual-refund runbook |
| Add-on preview | Paddle subtotal, tax, currency, and final total are displayed before an explicit confirmation |
| Each add-on purchase | One immediate `subscription_charge`, one transaction-specific non-catalog line, exact pack contract |
| Canceled, paused, past-due, trialing, manual-collection, mismatched, multi-item, or scheduled-change subscription | Rejected before charge |
| Browser closes or reloads after submission | Same durable request resumes; no new charge is issued |
| Network timeout, HTTP 5xx, or malformed success | `provider_unknown`; no automatic retry; reconciliation required |
| Charge API succeeds as `submitted`, but the webhook is never delivered | After 72 hours, the same exhaustive reconciliation rules apply; no automatic retry |
| A markerless one-item subscription charge matches the exact subscription, customer, and origin but has changed or incomplete totals/details | Classify as ambiguous partial evidence; never close the request as a definitive no-match |
| A write-capable no-match reconciliation is attempted | Perform two complete Paddle scans with disjoint provider request IDs and a fresh second cutoff; any match, partial, malformed page, or reused/stale evidence blocks the write |
| Both no-match scans complete | Persist the evidence but keep the request `provider_unknown` with review required; never enable a replacement purchase |
| A markerless `subscription_charge` completion is delivered | Grant nothing, create a durable critical incident with minimal identifiers, and keep the account purchase-locked for review |
| Operator no-match scan completes immediately before an exact signed completion is processed | The exact completion may supersede only the review-locked reconciled request, grants once after all normal checks, preserves evidence, and emits a critical incident |
| Reconciliation runs with a wrong Supabase project, Paddle environment, seller, subscription, customer, or plan Price ID | Stops before transaction scan and database reconciliation RPC |
| `transaction.completed` delivered twice | Exactly one grant from the bound request |
| Webhook arrives before browser response | Webhook grants once; browser only reports durable status |
| Eligibility check began exactly 5:00 before database authorization | Accepted by the freshness bound; all other evidence must still pass |
| Eligibility check began more than 5:00 before database authorization | Request rejected as stale before charge submission |
| Eligibility-check timestamp is exactly 0:30 ahead of database authorization | Accepted only as bounded clock skew; all other evidence must still pass |
| Eligibility-check timestamp is more than 0:30 ahead of database authorization | Request rejected as stale/clock-invalid before charge submission |
| Completion at 14:59.999 after authorization | Eligible only if all other evidence passes; exactly one grant |
| Completion exactly 15:00.000 after authorization | Withheld; no lot and no balance change |
| Exactly one matching immediate one-off History event inside authorization | Eligible only if every other identity, lifecycle, and amount invariant passes |
| Missing, duplicate, pre-authorization, malformed, or wrong-transaction one-off History event | Withheld; no lot and no automatic retry |
| Subscription History permission unavailable, pagination incomplete, or proof malformed | Withheld with a durable incident; no lot and no automatic retry |
| Pause, past-due, cancellation, or disqualifying history event before completion | Withheld; transaction and proof retained for refund |
| Ineligibility occurs strictly after a timely completion | Historical payment remains eligible, subject to the exact Sandbox evidence |
| Preview contains a discount or customer credit balance | Rejected before purchase request or charge |
| Signed completion contains a discount, customer credit, changed total, nonzero post-payment balance, or capture mismatch | Withheld; immutable amount evidence retained for refund/reconciliation |
| Approved full refund or credit arrives before `transaction.completed` | Adjustment receipt is retained; later completion atomically finalizes the payment as refunded, marks the adjustment applied, and mints no lot |
| Approved full chargeback arrives before `transaction.completed` | Later completion atomically records chargeback with review required, marks the adjustment applied, and mints no lot |
| Partial, unapproved, or ambiguous adjustment arrives before completion | Later completion is withheld with review required and mints no lot |
| Full refund of an already-withheld payment | Payment/request/receipt become refunded without looking up or mutating a credit lot |
| Full refund before spending | Exact source lot revoked once |
| Full refund of a withheld payment | Payment/request/purchase become refunded, durable review lock clears, and no credit lot is created |
| Full refund after spending or chargeback | No unrelated debit; critical manual reconciliation |
| Partial refund | Remaining pack lot quarantined immediately and removed from spendable balance |
| Account deleted after authorization or grant, then full refund/credit/chargeback arrives | Retained immutable evidence is terminalized without recreating a user, lot, or balance mutation |
| 365-day expiry | Only unspent credits in that source lot expire from Paddle `occurred_at` |
| Paid plan becomes ineligible | New purchase and add-on consumption blocked without deleting ledger evidence |
| Out-of-order/equal-time events | Ordered reducer applies only valid successor; ambiguity fails closed |

Repeat all customer-visible preview, confirmation, checkout, receipt/invoice,
portal, refund, and error-copy checks in English, Korean, Japanese, Simplified
Chinese, French, and Russian. Store release screenshots and Paddle transaction
IDs outside the repository without customer personal data.

## Reconciliation runbooks

### `provider_unknown`

1. Disable only new requests for the affected path if the incident is not
   isolated.
2. Do not click, call, queue, or script a retry.
3. Search Paddle by the opaque checkout attempt or purchase request metadata,
   customer, subscription, and time window.
4. Compare the provider transaction with the durable attempt/request, webhook
   inbox, subscription state, purchase, lot, allocation, and profile balance.
5. If Paddle charged, bind/replay the original signed event or use an audited
   reconciliation path; never create a replacement charge.
6. If both scans find no charge, keep the request review-locked as
   `provider_unknown`. Do not allow another attempt. Only a separate audited
   procedure with provider-terminal evidence may release that lock; this
   foundation intentionally does not implement that release.
7. Keep the incident open until Paddle, the request state, entitlement, and
   ledger agree.

The operator is dry-run by default:

```text
npm run reconcile:credit-pack -- --request-id=<opaque UUID>
```

For a Sandbox rehearsal, use a separate non-production Supabase project and
explicitly allow only its exact project ref. The Paddle base and modern API key
must both be Sandbox values:

```text
CREDIT_PACK_RECONCILIATION_SANDBOX_PROJECT_REFS=<exact staging project ref>
PADDLE_API_BASE=https://sandbox-api.paddle.com
PADDLE_API_KEY=pdl_sdbx_apikey_<redacted>
npm run reconcile:credit-pack -- --request-id=<opaque UUID>
```

This Sandbox path is read-only and always reports `readyToApply: false`.
Never include the PromptGen production ref in the allowlist and never add
`--apply` to a Sandbox or staging run.

It scans only after the request is at least 72 hours past authorization,
validates every Paddle page and provider request ID, and never prints keys or
customer payloads. A markerless transaction with the exact subscription,
customer, `subscription_charge` origin, and one-item envelope is partial
evidence even when totals or details differ or are incomplete; it is never
treated as an unrelated definitive no-match. The explicit write performs a
second complete scan with a new cutoff and requires request IDs disjoint from
the first scan. The write is rejected if the completed scan evidence is more
than two minutes old; rerun the scan rather than extending that window. A
successful no-match write stores review evidence and leaves the request locked
as `provider_unknown`; it does not authorize a retry. Review the dry-run
evidence and retained external audit record before the explicit write:

```text
npm run reconcile:credit-pack -- --request-id=<opaque UUID> --apply
```

`--apply` is production-only: it requires the exact PromptGen Supabase project,
`https://api.paddle.com`, a modern `pdl_live_apikey_...` key, and a successful
exact subscription/customer/recurring-Price binding read before the transaction
scan. Sandbox or legacy credentials cannot persist the review record. A
write-capable run
performs a second complete provider scan immediately before the database CAS
and requires provider response request IDs disjoint from the first scan. Any
match, partial evidence, malformed page, or reused request ID blocks the write.

If the database commit succeeded but the CLI response was lost, rerunning the
same command never writes again. It first revalidates the Paddle binding and
rescans Paddle: a still-empty result reports the retained and current evidence
as idempotent, while a late exact match is reported as revalidation evidence
that requires replay of the original signed webhook event.

### Direct or unbound subscription payment

1. Withhold entitlement and create a critical incident.
2. Verify the transaction's origin, items, customer, subscription, and custom
   data directly in Paddle.
3. Confirm no valid server attempt was consumed.
4. Issue a manual refund when the payment cannot be safely bound to an
   authenticated server attempt.
5. Record the operator, Paddle transaction/refund IDs, reason, and final
   subscription state.

### Withheld usage add-on payment

1. Keep `CREDIT_PACK_PURCHASES_ENABLED=false` for a systemic incident; do not
   retry the charge or create a replacement request.
2. Locate the immutable purchase request, payment receipt, adjustment receipt,
   signed webhook inbox row, Paddle transaction, captured payment, Subscription
   History response/request ID, and lifecycle history. If the account still
   exists, also inspect the purchase, lot, and profile rows. If the retained
   evidence has `user_id=NULL`, explicitly record that the account was deleted
   and that the migration-023 user-owned purchase/lot graph may correctly be
   absent; do not recreate it.
3. Classify the durable reason: expired authorization, event before
   authorization, ineligible subscription history, unavailable or ambiguous
   history, adjustment before completion, previously failed request, or
   conflicting transaction binding.
4. If money was captured and entitlement was withheld, issue or confirm the
   approved Paddle full refund. Do not call the grant RPC, manually add credits,
   or replay the purchase POST.
5. Allow the signed adjustment webhook to update every surviving purchase row
   plus the payment, request, and adjustment receipts. With `user_id=NULL`, the
   immutable receipts and request alone are terminalized. A withheld refund
   must complete without requiring a credit-lot lookup or balance mutation.
6. For a partial adjustment, chargeback, missing adjustment, mismatched
   evidence, or any non-terminal provider state, keep manual review open and
   preserve every receipt. Never debit unrelated subscription or add-on lots.
7. Record the operator, Paddle transaction/adjustment IDs, Subscription History
   request ID, reason, timestamps, final monetary state, zero-lot evidence, and
   final profile balance when the profile still exists. Close the incident only
   when Paddle and every applicable durable PromptGen record agree.

### Stale event-order lease

The application never auto-steals an expired
`paddle_event_watermarks` lease:

1. stop new requests for the affected workflow while continuing safe inbox
   capture;
2. confirm the original worker is no longer running;
3. compare Paddle with the durable inbox, attempt/request, purchase,
   adjustment, lot, allocation, subscription state, and profile records;
4. record the event ID, entity, exact claim token, and reconciliation result;
5. call `release_stale_paddle_event_order` only with that exact expired token;
6. allow Paddle to retry the event and verify one resulting mutation; and
7. keep the incident open until all states agree.

## Eventual production sequence

This sequence is not authorized by the current Draft PR. Use it only after all
blocking gates and an explicit production approval:

1. Keep `PRO_PRICE_1099_ENABLED=false`,
   `CREDIT_LEDGER_V2_ENABLED=false`, and
   `CREDIT_PACK_PURCHASES_ENABLED=false`. Also keep
   `PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED=false` and
   `PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED=false`,
   `PADDLE_TRANSACTION_READ_CONFIRMED=false`, and
   `PADDLE_SANDBOX_CHECKOUT_CONFIRMED=false`.
2. Freeze payment/credit mutations, take and verify a backup, and confirm no
   active credit reservations or pending storyboard jobs.
3. Apply migration 023, populate and independently review the private manifest,
   then apply migrations 024, 025, 026, and 027 in order.
4. Run invariants, balance reconciliation, and the fresh Paddle subscription
   reconciliation.
5. Deploy application code with all flags still disabled.
6. Enable only `CREDIT_LEDGER_V2_ENABLED`; verify analysis/storyboard
   reservation/refund, renewal, plan change, cancellation, expiry, and legacy
   USD 9.99 mapping.
7. Configure and audit the stable, staged, Enterprise, and legacy Paddle
   catalog. Do not configure reusable add-on Price IDs.
8. While new add-on sales remain disabled, set
   `PADDLE_CREDIT_PACK_TAX_CATEGORY=<Paddle-confirmed value>`, verify that exact
   value and receipt treatment in Sandbox, and only then set
   `PADDLE_CREDIT_PACK_TAX_CATEGORY_CONFIRMED=true`. Prove the production API
   key's paginated Subscription History reads against the exact release
   configuration, and only then set
   `PADDLE_SUBSCRIPTION_HISTORY_CONFIRMED=true`. Prove a complete paginated
   transaction scan with the exact release key, and only then set
   `PADDLE_TRANSACTION_READ_CONFIRMED=true`.
9. Re-run the complete Sandbox matrix with all three credit-pack confirmation
   gates enabled and `CREDIT_PACK_PURCHASES_ENABLED=false`. Set
   `PADDLE_SANDBOX_CHECKOUT_CONFIRMED=true` only during the bounded, isolated
   Checkout E2E window, then restore it to `false` immediately afterward.
10. After notice and price gates pass, enable `PRO_PRICE_1099_ENABLED` and
   only after reconciling all open checkout attempts; then verify a new
   USD 10.99 checkout/receipt plus a USD 9.99 renewal.
11. After every add-on gate passes, enable
    `CREDIT_PACK_PURCHASES_ENABLED`.
12. Monitor provider errors, attempt/request ages, webhook retries, withheld
    direct payments, grants, refunds, quarantined lots, and balance
    reconciliation throughout the release window.

## Stop and rollback rules

Before the first USD 10.99 checkout, leave
`PRO_PRICE_1099_ENABLED=false`. After any USD 10.99 subscriber exists,
disabling the flag stops new USD 10.99 checkout, but the USD 10.99 Price ID must
remain accepted inbound for renewals.

Before or after an add-on sale, setting
`CREDIT_PACK_PURCHASES_ENABLED=false` stops new preview/purchase requests.
It must not stop:

- signed webhook inbox and completion processing;
- subscription renewal/lifecycle reduction;
- refund, partial-refund quarantine, and chargeback processing;
- expiry and ledger reconciliation;
- status lookup for already-created attempts/requests; or
- operator reconciliation of `provider_unknown` and withheld payments.

The authenticated browser must likewise keep owner-scoped recovery independent
from the sales catalog. Even when the add-on panel is hidden because new sales
are disabled, an existing stored request continues status lookup and shows its
durable result. `pending` remains locked against another submission,
`withheld` remains stored and visibly review-required, and a confirmed
`refunded` result clears the local request lock only after the status endpoint
returns that terminal state. `chargeback` remains a distinct, review-required
status: the browser retains its request lock, disables another add-on attempt,
and shows chargeback-specific copy instead of labeling it as a refund.

After money has been accepted, do not drop migrations, revert to a
profile-only credit balance, delete attempts/requests, or run the pre-025
webhook implementation. Migration 025 changes ordering and reducer invariants;
rolling application code back to the old webhook after 025 or later can bypass
those protections. Stop new requests, keep the compatible processors running,
preserve evidence, and correct forward with an audited migration or application
patch.

Stop the rollout immediately for:

- a wrong amount, currency, product, cadence, tax, or receipt;
- a legacy USD 9.99 renewal changing price or plan unexpectedly;
- a direct/unbound payment provisioning entitlement;
- a duplicate, missing, or wrong-source grant/revocation;
- a `provider_unknown` request being automatically retried;
- a partial refund leaving credits spendable;
- profile and spendable-lot balances diverging;
- incomplete Paddle approval or material-change notice; or
- any critical incident that cannot be reconciled deterministically.
