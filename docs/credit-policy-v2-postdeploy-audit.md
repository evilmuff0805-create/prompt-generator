# Credit policy v2 post-deploy audit

This is a read-only production audit for the credit and payment invariants activated
by release `c472c0fb97d5c49340e5e6e00529bce7fca257c5`.

## Safety boundary

- The command only performs Supabase `SELECT` requests.
- It does not call payment, credit, cleanup, refund, or health-scan RPCs.
- It does not write to Paddle, Supabase, Railway, or customer accounts.
- It never prints the service-role key.
- It refuses any Supabase URL whose project reference is not PromptGen's
  `kzlovmcghswprasjaeeo`.
- Any missing source, pagination overflow, query failure, stale health scan, or
  accounting anomaly exits non-zero.

## Required environment

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Optional:

```text
CREDIT_POLICY_V2_RELEASE_CUTOVER=2026-07-25T02:47:27.000Z
CREDIT_POLICY_AUDIT_PROJECT_REF=kzlovmcghswprasjaeeo
```

The default cutover is the merge timestamp for release #88. Override it only when
the production activation timestamp has been independently verified. The project
reference override is intended only for a verified PromptGen project migration.

## Run

```bash
npm run audit:credit-policy-v2
```

Run at:

1. T0, immediately after activation.
2. T+24h.
3. T+72h.

Archive the JSON result in the PromptGen system-of-record page. Do not archive
environment values or secrets.

## Fail-closed checks

- profile credits below zero;
- credit-ledger discontinuity or latest-ledger/profile mismatch;
- legacy `-10`, `-120`, or `-250` deductions after the v2 cutover;
- post-cutover Storyboard cost outside `30/35/40/45/50`;
- Storyboard cost not equal to `30 + 5 × reference count`;
- failed charged Storyboard without a refund;
- expired analysis reservation, non-2-credit operation, or refund-count anomaly;
- failed Paddle webhook or expired processing lease;
- any unresolved operations incident;
- post-cutover Pro/Enterprise purchase grant other than `600/1,500`;
- missing/stale operations health scan or non-zero health result.

Live processing webhooks and active Storyboards are warnings while their leases are
valid. No post-cutover purchase, Storyboard, or analysis activity is also reported
as a coverage warning rather than fabricated as a successful production sample.
