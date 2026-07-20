'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Storyboard 90-day result retention contract', () => {
  test('migration extends only active rows and sets the future default to 90 days', () => {
    const migration = read('migrations/016_storyboard_result_retention_90_days.sql');

    expect(migration).toMatch(/ALTER COLUMN expires_at SET DEFAULT \(NOW\(\) \+ INTERVAL '90 days'\)/i);
    expect(migration).toMatch(/WHERE deleted_at IS NULL/i);
    expect(migration).toMatch(/created_at \+ INTERVAL '90 days'/i);
    expect(migration).not.toMatch(/SET\s+deleted_at\s*=\s*NULL/i);
  });

  test('creation and History surfaces disclose the same 90-day window', () => {
    const form = read('public/storyboard.html');
    const history = read('public/storyboard-history.html');

    expect(form).toContain('data-i18n="storyboard.retention.notice"');
    expect(history).toContain('data-i18n="storyboardHistory.retention.notice"');
    expect(form).toContain('90 days');
    expect(history).toContain('90 days');
  });

  test('Privacy separates 24-hour references from 90-day generated grids', () => {
    const privacy = read('public/privacy.html');

    expect(privacy).toContain('Storyboard reference uploads');
    expect(privacy).toContain('expire after 24 hours');
    expect(privacy).toContain('Generated Storyboard grids');
    expect(privacy).toContain('90 days from creation');
  });
});
