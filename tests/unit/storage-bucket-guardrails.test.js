'use strict';

const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  '..',
  'migrations',
  '019_harden_storage_bucket_upload_limits.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

describe('PromptGen Storage bucket guardrails migration', () => {
  test('keeps both application buckets private and fails closed on drift', () => {
    expect(sql).toContain("id IN ('reference-images', 'storyboards')");
    expect(sql).toMatch(/AND public\s*\)/);
    expect(sql).toContain("coalesce(metadata ->> 'mimetype', '') <> 'image/png'");
    expect(sql).toContain('RAISE EXCEPTION');
  });

  test('sets conservative per-bucket size ceilings and a PNG-only upload contract', () => {
    expect(sql).toContain('v_reference_limit CONSTANT bigint := 10 * 1024 * 1024');
    expect(sql).toContain('v_storyboard_limit CONSTANT bigint := 20 * 1024 * 1024');
    expect(sql.match(/allowed_mime_types = ARRAY\['image\/png'\]::text\[\]/g)).toHaveLength(2);
    expect(sql).toMatch(/file_size_limit = v_reference_limit[\s\S]+WHERE id = 'reference-images'/);
    expect(sql).toMatch(/file_size_limit = v_storyboard_limit[\s\S]+WHERE id = 'storyboards'/);
  });

  test('does not change bucket visibility, object rows, or Storage policies', () => {
    expect(sql).not.toMatch(/SET\s+public\s*=/i);
    expect(sql).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?storage\.objects/i);
    expect(sql).not.toMatch(/(?:CREATE|ALTER|DROP)\s+POLICY/i);
  });
});
