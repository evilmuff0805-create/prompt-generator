'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const RETENTION_DAYS = parseInt(process.env.STORYBOARD_RETENTION_DAYS || '30', 10);

async function cleanupExpiredStoryboards() {
  console.log('[cleanup] Starting expired storyboard cleanup...');

  // Fetch expired, not-yet-soft-deleted storyboards
  const { data: expired, error } = await admin
    .from('storyboards')
    .select('id, grid_storage_path')
    .lt('expires_at', new Date().toISOString())
    .is('deleted_at', null);

  if (error) {
    console.error('[cleanup] Failed to fetch expired storyboards:', error.message);
    return;
  }

  let removed = 0;
  for (const sb of expired || []) {
    // Delete grid PNG from Storage
    if (sb.grid_storage_path) {
      const { error: storErr } = await admin.storage
        .from('storyboards')
        .remove([sb.grid_storage_path]);
      if (storErr) {
        console.warn(`[cleanup] Storage remove failed for ${sb.id}:`, storErr.message);
      }
    }

    // Soft-delete the row
    await admin
      .from('storyboards')
      .update({ deleted_at: new Date().toISOString(), status: 'deleted' })
      .eq('id', sb.id);

    removed++;
  }

  console.log(`[cleanup] Soft-deleted ${removed} expired storyboards`);
}

async function hardDeleteOldSoftDeleted() {
  console.log('[cleanup] Hard-deleting old soft-deleted storyboards...');

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: old, error } = await admin
    .from('storyboards')
    .select('id')
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff);

  if (error) {
    console.error('[cleanup] Failed to fetch old deleted storyboards:', error.message);
    return;
  }

  if (old && old.length > 0) {
    const ids = old.map(r => r.id);
    const { error: delErr } = await admin
      .from('storyboards')
      .delete()
      .in('id', ids);

    if (delErr) {
      console.error('[cleanup] Hard-delete error:', delErr.message);
    } else {
      console.log(`[cleanup] Hard-deleted ${ids.length} old storyboard rows`);
    }
  } else {
    console.log('[cleanup] No old soft-deleted storyboards to hard-delete');
  }
}

async function cleanupExpiredReferenceImages() {
  console.log('[cleanup] Starting expired reference image cleanup...');

  const { data: expired, error } = await admin
    .from('reference_images')
    .select('id, storage_path')
    .lt('expires_at', new Date().toISOString());

  if (error) {
    console.error('[cleanup] Failed to fetch expired reference images:', error.message);
    return;
  }

  let removed = 0;
  for (const ref of expired || []) {
    // Delete from Storage
    if (ref.storage_path) {
      const { error: storErr } = await admin.storage
        .from('reference-images')
        .remove([ref.storage_path]);
      if (storErr) {
        console.warn(`[cleanup] Storage remove failed for ref ${ref.id}:`, storErr.message);
      }
    }

    // Hard-delete the DB row
    await admin.from('reference_images').delete().eq('id', ref.id);
    removed++;
  }

  console.log(`[cleanup] Removed ${removed} expired reference images`);
}

async function main() {
  console.log(`[cleanup] Running at ${new Date().toISOString()}`);
  await cleanupExpiredStoryboards();
  await hardDeleteOldSoftDeleted();
  await cleanupExpiredReferenceImages();
  console.log('[cleanup] Done.');
}

main().catch(err => {
  console.error('[cleanup] Fatal error:', err.message);
  process.exit(1);
});
