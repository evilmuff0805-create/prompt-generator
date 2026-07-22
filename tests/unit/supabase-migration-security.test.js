'use strict';

const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');
const migration = read('migrations', '020_default_deny_future_public_objects.sql');
const contract = read('docs', 'supabase-migration-security.md');

describe('Supabase migration security baseline', () => {
  test('future postgres-owned public objects start without Data API privileges', () => {
    expect(migration.match(/ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public/g)).toHaveLength(4);
    expect(migration).toContain('REVOKE ALL ON TABLES FROM anon, authenticated, service_role');
    expect(migration).toContain('REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role');
    expect(migration).toContain('REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role');
    expect(migration).toContain('REVOKE ALL ON FUNCTIONS FROM PUBLIC');
    expect(migration).not.toMatch(/\bGRANT\b/);
  });

  test('the table template couples grants, RLS, policies, and sequence access', () => {
    expect(contract).toContain('ALTER TABLE public.example ENABLE ROW LEVEL SECURITY');
    expect(contract).toContain('REVOKE ALL ON TABLE public.example FROM PUBLIC, anon, authenticated');
    expect(contract).toContain('GRANT SELECT ON TABLE public.example TO authenticated');
    expect(contract).toContain('GRANT ALL ON TABLE public.example TO service_role');
    expect(contract).toContain('REVOKE ALL ON SEQUENCE public.example_id_seq');
    expect(contract).toContain('USING ((SELECT auth.uid()) = user_id)');
  });

  test('the function template pins search_path and denies implicit execution', () => {
    expect(contract).toContain('SECURITY DEFINER');
    expect(contract).toContain('SET search_path = public, pg_temp');
    expect(contract).toContain('REVOKE ALL ON FUNCTION public.example_action() FROM PUBLIC, anon, authenticated');
    expect(contract).toContain('GRANT EXECUTE ON FUNCTION public.example_action() TO service_role');
    expect(contract).toContain('App objects are not created from the Dashboard');
  });
});
