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
