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

Known code gate: usage add-on requests do not yet carry an approved request
TTL or a temporal eligibility decision for a delayed
`transaction.completed`. The feature must remain disabled until PromptGen can
distinguish a charge completed before a later cancellation from a charge
completed after the subscription became ineligible, record a withheld
entitlement without retrying the charge, and reconcile/refund that payment.

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
   opaque request ID before Paddle is called. At most one open request exists
   per user.
7. The server calls Paddle's immediate subscription charge endpoint with
   `effective_from=immediately`, `on_payment_failure=prevent_change`, quantity
   one, and transaction-specific non-catalog price/product metadata containing
   only the opaque purchase request ID and pack key.
8. The browser polls the authenticated request-status endpoint. The request ID
   is retained across reloads so returning to Pricing resumes status display
   instead of issuing a second charge.
   If the browser lost the charge response before learning the request ID, it
   performs one authenticated, owner-scoped lookup for the newest non-terminal
   request and resumes that request. It never repeats the purchase POST.
9. Only a valid signed `transaction.completed` event with
   `origin=subscription_charge`, the exact request/subscription/customer
   binding, one custom line item, and the exact pack contract grants credits.

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
The read-only audit must confirm all of them are archived:

```text
npm run audit:paddle-credit-packs
```

## Ledger, refunds, chargebacks, and expiry

Migration 023 introduces source-aware credit lots and allocations. Plan-cycle,
migration, and add-on credits remain separately attributable; a refund must
never debit an unrelated lot.

- A successful add-on lot expires at signed Paddle `occurred_at + 365 days`,
  not browser time, API-response time, webhook receive time, or processing
  time.
- Duplicate completed transactions grant once.
- A full refund of a wholly unspent pack revokes that source lot once.
- A full refund after spending, a chargeback, or any state that cannot be
  mapped exactly creates a critical reconciliation incident rather than
  subtracting unrelated credits.
- An approved partial refund immediately changes the remaining source lot to
  `quarantined`. Quarantined credits cannot be consumed and are excluded from
  the spendable profile balance until an operator performs source-aware
  reconciliation.
- Canceling or losing the paid plan blocks add-on purchase and consumption; it
  does not silently remap or destroy audit records.

## Mandatory migration order

Apply and verify the migrations exactly in this order:

1. `migrations/023_credit_lot_ledger.sql`
2. `migrations/024_paddle_event_ordering.sql`
3. `migrations/025_secure_payment_requests.sql`
4. `migrations/026_secure_subscription_checkout.sql`

Do not skip or reorder them. Migration 025 depends on the ledger and ordered
subscription state. Migration 026 depends on the payment-request foundation and
adds durable subscription checkout attempts.

`CREDIT_LEDGER_V2_ENABLED=false` is an application activation guard, not a
database rollback. Migration 023 replaces existing consumption/refund RPCs and
triggers as soon as it is applied. A failed clone migration or concurrency test
therefore blocks production migration even while every feature flag is false.

Before any production migration:

- test backup and restore;
- apply all four migrations to a clone of the actual production schema;
- run migration invariants and inspect RLS, grants, constraints, and function
  signatures;
- test concurrent checkout attempts, add-on requests, renewal/cancellation
  events, duplicate webhooks, equal timestamps, and stale leases;
- reconcile `profiles.credits` with active ledger lots; and
- confirm no image-analysis reservations or pending/processing storyboard jobs
  exist at the cutover.

After migration 024's bootstrap barrier, reconcile every stored Paddle
subscription against a fresh Paddle response before reopening webhook-driven
mutations. Events older than the barrier are intentionally stale-blocked and
must not be blindly replayed.

## Blocking gates

No feature flag or production checkout may be enabled until all items pass:

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
- [ ] Any historical reusable add-on prices are inventoried and audited as
  archived.
- [ ] An approved add-on request TTL and signed-event temporal eligibility
  rule are implemented and proven for completion-before-cancellation,
  completion-after-cancellation, delayed delivery, `provider_unknown`, and
  manual refund/reconciliation paths.
- [ ] Production backup/restore is tested and migrations 023 through 026 pass
  against a clone of the actual production schema, including race and rollback
  tests.
- [ ] Paddle Sandbox proves checkout, preview, explicit total confirmation,
  receipt, renewal, retry, refund, partial refund quarantine, chargeback,
  cancellation, expiry, and reconciliation behavior.
- [ ] Product name, amount, currency, tax, one-time/monthly wording, and credit
  terms match PromptGen UI, Paddle preview/checkout, receipt/invoice, customer
  portal, and legal pages in all six supported locales.
- [ ] Monitoring, durable incident records, and an operator escalation path
  exist for withheld direct payments, `provider_unknown`, stale leases,
  duplicate/missing grants, refunds, and balance divergence.
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
3. Run the complete unit suite, build, dependency audit, and diff/secret scan.
4. Confirm the public catalog/API responses contain no Paddle Price IDs or
   server-owned custom data.
5. Confirm all three flags remain `false` in the release configuration.

### 2. Production-schema clone verification

1. Restore an actual production backup into an isolated clone.
2. Apply migrations 023, 024, 025, and 026 in sequence.
3. Run invariant queries before and after each migration.
4. Exercise concurrent create/bind/consume flows and ensure lock ordering is
   consistent.
5. Verify duplicate events are idempotent, equal-timestamp conflicts fail
   closed, terminal subscription state cannot reactivate, and a stale lease is
   never stolen automatically.
6. Prove that a forward fix and reconciliation can recover without dropping
   ledger/payment evidence.

### 3. Paddle Sandbox verification

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
| `transaction.completed` delivered twice | Exactly one grant from the bound request |
| Webhook arrives before browser response | Webhook grants once; browser only reports durable status |
| Full refund before spending | Exact source lot revoked once |
| Full refund after spending or chargeback | No unrelated debit; critical manual reconciliation |
| Partial refund | Remaining pack lot quarantined immediately and removed from spendable balance |
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
6. If Paddle definitively did not create a charge, close the request as failed
   through the approved reconciliation procedure before allowing another
   attempt.
7. Keep the incident open until Paddle, the request state, entitlement, and
   ledger agree.

### Direct or unbound subscription payment

1. Withhold entitlement and create a critical incident.
2. Verify the transaction's origin, items, customer, subscription, and custom
   data directly in Paddle.
3. Confirm no valid server attempt was consumed.
4. Issue a manual refund when the payment cannot be safely bound to an
   authenticated server attempt.
5. Record the operator, Paddle transaction/refund IDs, reason, and final
   subscription state.

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
   `CREDIT_PACK_PURCHASES_ENABLED=false`.
2. Freeze payment/credit mutations, take and verify a backup, and confirm no
   active credit reservations or pending storyboard jobs.
3. Apply migrations 023, 024, 025, and 026 in order.
4. Run invariants, balance reconciliation, and the fresh Paddle subscription
   reconciliation.
5. Deploy application code with all flags still disabled.
6. Enable only `CREDIT_LEDGER_V2_ENABLED`; verify analysis/storyboard
   reservation/refund, renewal, plan change, cancellation, expiry, and legacy
   USD 9.99 mapping.
7. Configure and audit the stable, staged, Enterprise, and legacy Paddle
   catalog. Do not configure reusable add-on Price IDs.
8. Re-run the complete Sandbox matrix against the exact release configuration.
9. After notice and price gates pass, enable `PRO_PRICE_1099_ENABLED` and
   only after reconciling all open checkout attempts; then verify a new
   USD 10.99 checkout/receipt plus a USD 9.99 renewal.
10. After every add-on gate passes, enable
    `CREDIT_PACK_PURCHASES_ENABLED`.
11. Monitor provider errors, attempt/request ages, webhook retries, withheld
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

After money has been accepted, do not drop migrations, revert to a
profile-only credit balance, delete attempts/requests, or run the pre-024
webhook implementation. Migration 024 changes ordering and reducer invariants;
rolling application code back to the old webhook after 024 or later can bypass
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
