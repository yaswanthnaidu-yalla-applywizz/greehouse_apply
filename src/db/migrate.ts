/**
 * @fileoverview Idempotent Database & Storage Migration Runner for Greenhouse V2.
 *
 * Steps:
 * 1. Checks and verifies Supabase table schema & creates storage buckets
 * 2. Migrates output/scanned_jobs.json -> scanned_job_templates
 * 3. Migrates cache/profiles/*.json -> profiles
 * 4. Uploads resumes/*.pdf -> Supabase Storage resumes bucket and updates profiles
 */

import fs from 'fs';
import path from 'path';
import { getDbClient } from './client.js';
import { ensureBucketsExist, uploadResume } from './storage.js';
import { getProfile } from './profiles.js';
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
    'scanned_job_templates',
    'candidate_qa_bank',
    'candidate_applications',
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

  // 3. Migrate output/scanned_jobs.json -> scanned_job_templates
  log.info('📄 Step 3: Migrating scanned job templates...');
  let templatesMigrated = 0;
  const scannedJobsPath = path.resolve(process.cwd(), 'output', 'scanned_jobs.json');

  if (fs.existsSync(scannedJobsPath)) {
    try {
      const rawData = fs.readFileSync(scannedJobsPath, 'utf-8');
      const scannedJobs = JSON.parse(rawData);

      if (Array.isArray(scannedJobs) && scannedJobs.length > 0) {
        log.info(`Found ${scannedJobs.length} scanned jobs in ${scannedJobsPath}. Upserting...`);

        const records = scannedJobs.map((job: any) => ({
          job_url: job.jobUrl,
          company_name: job.companyName || null,
          job_title: job.jobTitle || null,
          fields_schema: job.fields || [],
          is_expired: Boolean(job.isExpired),
          scanned_at: job.scannedAt || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }));

        // Batch in chunks of 50
        const chunkSize = 50;
        for (let i = 0; i < records.length; i += chunkSize) {
          const chunk = records.slice(i, i + chunkSize);
          const { error } = await supabase
            .from('scanned_job_templates')
            .upsert(chunk, { onConflict: 'job_url' });

          if (error) {
            log.error(`Error migrating scanned jobs chunk ${i}-${i + chunk.length}:`, error.message);
          } else {
            templatesMigrated += chunk.length;
          }
        }
        log.info(`✅ Successfully migrated/upserted ${templatesMigrated} scanned job templates.`);
      }
    } catch (err: any) {
      log.warn(`⚠️ Could not process scanned_jobs.json: ${err.message}`);
    }
  } else {
    log.info(`ℹ️ ${scannedJobsPath} not found. Skipping template migration.`);
  }

  // 4. Migrate cache/profiles/*.json -> profiles
  log.info('👤 Step 4: Migrating candidate profiles from cache...');
  let profilesMigrated = 0;
  const profilesDir = path.resolve(process.cwd(), 'cache', 'profiles');

  if (fs.existsSync(profilesDir)) {
    const files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json'));
    log.info(`Found ${files.length} candidate profile cache files in ${profilesDir}.`);

    const profileRecords: any[] = [];
    for (const file of files) {
      try {
        const filePath = path.join(profilesDir, file);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);

        if (data.applywizzId && data.clientName) {
          profileRecords.push({
            applywizz_id: data.applywizzId,
            client_name: data.clientName,
            first_name: data.firstName || null,
            last_name: data.lastName || null,
            email: data.email || null,
            phone: data.phone || null,
            location: data.location || null,
            linkedin_url: data.linkedinUrl || null,
            website_url: data.websiteUrl || null,
            github_url: data.githubUrl || null,
            work_authorization: data.workAuthorization || null,
            requires_sponsorship: Boolean(data.requiresSponsorship),
            education: data.education || [],
            work_experience: data.workExperience || [],
            resume_url: data.resumeUrl || null,
            raw_api_payload: data.demographics ? { demographics: data.demographics } : null,
            updated_at: new Date().toISOString(),
          });
        }
      } catch (err: any) {
        log.warn(`⚠️ Failed to parse profile cache file ${file}: ${err.message}`);
      }
    }

    // Batch upsert in chunks of 50
    const chunkSize = 50;
    for (let i = 0; i < profileRecords.length; i += chunkSize) {
      const chunk = profileRecords.slice(i, i + chunkSize);
      const { error } = await supabase
        .from('profiles')
        .upsert(chunk, { onConflict: 'applywizz_id' });

      if (error) {
        log.error(`Error migrating profiles chunk ${i}-${i + chunk.length}:`, error.message);
      } else {
        profilesMigrated += chunk.length;
      }
    }
    log.info(`✅ Successfully migrated/upserted ${profilesMigrated} candidate profiles.`);
  } else {
    log.info(`ℹ️ ${profilesDir} not found. Skipping profile migration.`);
  }

  // 5. Upload local resume PDFs -> Supabase Storage resumes bucket
  log.info('📑 Step 5: Uploading master resumes to Supabase Storage...');
  let resumesUploaded = 0;
  const resumesDir = path.resolve(process.cwd(), 'resumes');

  if (fs.existsSync(resumesDir)) {
    const pdfFiles = fs.readdirSync(resumesDir).filter((f) => f.endsWith('.pdf'));
    log.info(`Found ${pdfFiles.length} PDF resumes in ${resumesDir}. Uploading...`);

    for (const pdfFile of pdfFiles) {
      try {
        const applywizzId = pdfFile.replace('_resume.pdf', '').replace('.pdf', '');
        const pdfPath = path.join(resumesDir, pdfFile);
        const buffer = fs.readFileSync(pdfPath);

        const profile = await getProfile(applywizzId);
        const storagePath = await uploadResume(applywizzId, buffer, 'application/pdf', {
          firstName: profile?.first_name,
          lastName: profile?.last_name,
          jobTitle: (profile as any)?.job_title,
          workExperience: profile?.work_experience,
        });

        // Update profile with storage path
        await supabase
          .from('profiles')
          .update({
            resume_storage_path: storagePath,
            updated_at: new Date().toISOString(),
          })
          .eq('applywizz_id', applywizzId);

        resumesUploaded++;
      } catch (err: any) {
        log.warn(`⚠️ Failed to upload resume ${pdfFile}: ${err.message}`);
      }
    }
    log.info(`✅ Successfully uploaded and linked ${resumesUploaded} resume PDFs.`);
  } else {
    log.info(`ℹ️ ${resumesDir} not found. Skipping resume uploads.`);
  }

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
