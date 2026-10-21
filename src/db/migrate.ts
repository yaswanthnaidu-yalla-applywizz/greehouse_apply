/**
 * @fileoverview Idempotent Database & Storage Migration Runner for Greenhouse V2.
 *
 * Verifies the V2 Supabase tables and ensures the required storage buckets exist.
 */

import { getDbClient } from './client.js';
import { ensureBucketsExist } from './storage.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Migrate');

export interface MigrationResult {
  success: boolean;
  tablesVerified: string[];
  bucketsEnsured: boolean;
  templatesMigrated: number;
  profilesMigrated: number;
  resumesUploaded: number;
  message: string;
}

/**
 * Runs the complete idempotent V2 database and storage migration.
 */
export async function migrate(): Promise<MigrationResult> {
  log.info('🚀 Starting V2 Supabase Foundation migration...');

  const supabase = getDbClient();
  const tables = [
    'profiles',
    'gh_scanned_job_templates',
    'gh_candidate_qa_bank',
    'gh_candidate_applications',
  ];

  // 1. Ensure Storage Buckets exist
  log.info('📦 Step 1: Initializing storage buckets...');
  await ensureBucketsExist();

  // 2. Verify database tables
  log.info('🔍 Step 2: Verifying database tables...');
  const verifiedTables: string[] = [];

  for (const table of tables) {
    const { error } = await supabase.from(table).select('id').limit(1);
    if (error) {
      log.warn(`⚠️ Table check for '${table}': ${error.message}`);
    } else {
      log.info(`✅ Table '${table}' verified.`);
      verifiedTables.push(table);
    }
  }

  if (verifiedTables.length < tables.length) {
    throw new Error(
      `Only ${verifiedTables.length}/${tables.length} tables verified. Please execute src/db/schema.sql in Supabase SQL editor.`
    );
  }

  // Steps 3-5: V1 local JSON file migration skipped in V2 (state is in Supabase)
  const templatesMigrated = 0;
  const profilesMigrated = 0;
  const resumesUploaded = 0;

  const message = `Migration complete: ${verifiedTables.length} tables verified, ${templatesMigrated} templates migrated, ${profilesMigrated} profiles migrated, ${resumesUploaded} resumes uploaded.`;
  log.info(`🎉 ${message}`);

  return {
    success: true,
    tablesVerified: verifiedTables,
    bucketsEnsured: true,
    templatesMigrated,
    profilesMigrated,
    resumesUploaded,
    message,
  };
}

// Auto-run if executed directly via CLI (npm run db:migrate)
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  migrate()
    .then((result) => {
      log.info('🎉 Migration runner completed successfully:', result.message);
      process.exit(0);
    })
    .catch((err) => {
      log.error('❌ Migration runner failed:', err);
      process.exit(1);
    });
}

export default migrate;
