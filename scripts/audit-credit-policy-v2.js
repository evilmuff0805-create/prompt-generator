'use strict';

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const {
  DEFAULT_RELEASE_CUTOVER,
  createSupabaseAuditRepository,
  collectCreditPolicyAudit
} = require('../lib/credit-policy-audit');

const DEFAULT_EXPECTED_PROJECT_REF = 'kzlovmcghswprasjaeeo';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the read-only credit policy audit.`);
  return value;
}

function assertAuditProject(supabaseUrl, expectedProjectRef = DEFAULT_EXPECTED_PROJECT_REF) {
  let projectRef;
  try {
    projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  } catch (_) {
    throw new Error('SUPABASE_URL must be a valid URL.');
  }

  if (!projectRef || projectRef !== expectedProjectRef) {
    throw new Error(
      `Refusing to audit Supabase project "${projectRef || 'unknown'}"; expected "${expectedProjectRef}".`
    );
  }
  return projectRef;
}

async function main() {
  const supabaseUrl = requiredEnv('SUPABASE_URL');
  assertAuditProject(
    supabaseUrl,
    process.env.CREDIT_POLICY_AUDIT_PROJECT_REF || DEFAULT_EXPECTED_PROJECT_REF
  );

  const supabase = createClient(
    supabaseUrl,
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      }
    }
  );

  const repository = createSupabaseAuditRepository(supabase);
  const result = await collectCreditPolicyAudit({
    repository,
    cutover: process.env.CREDIT_POLICY_V2_RELEASE_CUTOVER || DEFAULT_RELEASE_CUTOVER
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      success: false,
      error: {
        code: error.code || 'CREDIT_POLICY_AUDIT_FAILED',
        message: error.message
      }
    }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_EXPECTED_PROJECT_REF,
  main,
  requiredEnv,
  assertAuditProject
};
