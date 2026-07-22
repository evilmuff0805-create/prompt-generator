'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(root, 'migrations', '018_optimize_rls_auth_initplan.sql'),
  'utf8'
);

describe('RLS auth initPlan optimization contract', () => {
  const policies = [
    'usage_logs: insert own',
    'usage_logs: select own',
    'prompts: select own',
    'prompts: insert own',
    'prompts: delete own',
    'reference_images: select own',
    'reference_images: insert own',
    'purchases: select own'
  ];

  test('alters each ownership policy exactly once', () => {
    for (const policy of policies) {
      const escaped = policy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = migration.match(new RegExp(`ALTER POLICY "${escaped}"`, 'gi')) || [];
      expect(matches).toHaveLength(1);
    }

    expect(migration.match(/ALTER POLICY/gi)).toHaveLength(policies.length);
  });

  test('caches auth.uid without changing policy ownership semantics', () => {
    expect(migration.match(/\(SELECT auth\.uid\(\)\) = user_id/gi)).toHaveLength(policies.length);
    expect(migration).not.toMatch(/(?<!SELECT )auth\.uid\(\)\s*=\s*user_id/i);
    expect(migration).not.toMatch(/\b(?:DROP|CREATE)\s+POLICY\b/i);
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE)\b/i);
    expect(migration).not.toMatch(/ALTER\s+TABLE/i);
  });

  test('keeps select/delete predicates separate from insert checks', () => {
    expect(migration.match(/\bUSING\s*\(\(SELECT auth\.uid\(\)\) = user_id\)/gi)).toHaveLength(5);
    expect(migration.match(/\bWITH CHECK\s*\(\(SELECT auth\.uid\(\)\) = user_id\)/gi)).toHaveLength(3);
  });
});
