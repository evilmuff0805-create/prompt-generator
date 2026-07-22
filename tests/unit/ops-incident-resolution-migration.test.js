'use strict';

const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(
  __dirname,
  '..',
  '..',
  'migrations',
  '021_resolve_recovered_ops_incidents.sql'
), 'utf8');

describe('recovered ops incident resolution migration', () => {
  test('preserves the incident row and closes only its open fingerprint', () => {
    expect(sql).toContain('UPDATE public.ops_incidents');
    expect(sql).toContain('SET resolved_at = clock_timestamp()');
    expect(sql).toContain('WHERE fingerprint = v_fingerprint');
    expect(sql).toContain('AND resolved_at IS NULL');
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.ops_incidents/i);
  });

  test('is a pinned security-definer RPC callable only by service_role', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
  });
});
