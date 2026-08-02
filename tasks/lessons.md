# Engineering lessons

## 2026-08-02 — Secret-shaped test fixtures

- Failure mode: a deterministic, non-working Paddle Sandbox fixture used the
  complete modern key shape in source and GitHub Push Protection rejected the
  commit as a secret.
- Detection signal: remote push failed with `GH013` and identified the exact
  fixture path and line.
- Prevention rule: construct full-format credential fixtures at runtime from
  noncontiguous deterministic components, never approve a push-protection
  bypass for test data, and repeat staged secret scanning before push.

## 2026-08-02 — Provider audits need literal commercial invariants

- Failure mode: the Paddle no-entity Preview audit derived the expected
  Enterprise amount from `PADDLE_ENTERPRISE_PRICE_USD`, so a stale temporary
  environment value could redefine the audit's answer instead of detecting
  drift.
- Detection signal: an independent contract review compared the approved USD
  19.99 catalog with every environment-controlled expectation before a second
  provider call.
- Prevention rule: provider verification tools must fail before network I/O
  when a commercial invariant differs from the approved literal contract;
  configurable runtime display values cannot be the sole source of truth for
  their own audit.

## 2026-08-02 — Legacy balances need explicit provenance

- Failure mode: a source-aware ledger migration treated every legacy scalar
  balance as subscription credit, even though plan state, Paddle binding, and
  arithmetic history cannot prove whether an admin or promotion granted it.
- Detection signal: group positive balances by binding and ledger transition,
  then trace every renewal, plan-change, and cancellation expiry predicate.
- Prevention rule: require an operator-reviewed, snapshot-bound classification
  manifest and fail the migration on missing or drifted rows; never infer a
  monetary balance source from account state alone.

## 2026-08-02 — Unknown-payment release needs a late-event path

- Failure mode: changing a `provider_unknown` checkout to a terminal status
  would free a new purchase while a late original payment could still arrive.
- Detection signal: trace both the partial unique index and the webhook lookup
  and terminal-state behavior before adding an operator release RPC.
- Prevention rule: terminalization requires delayed independent provider
  scans, immutable evidence and CAS, plus a late-payment path that grants no
  entitlement and creates durable refund review.
