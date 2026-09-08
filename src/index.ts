/**
 * @fileoverview Master End-to-End Orchestration Entry Point (Phase V2-6).
 *
 * Coordinates the full Greenhouse V2 Automation Pipeline:
 * 1. Pre-flight & Supabase Storage Bucket Provisioning (`ensureBucketsExist`)
 * 2. V1 -> V2 Data Migration (`migrate`)
 * 3. Branch 1: Deduplication & Playwright Form Scanning (`PlaywrightScanner`)
 * 4. Branch 2: ApplyWizz Candidate Profile Sync & Resume PDF Storage Upload (`segregateCandidatesByApplyWizzId`)
 * 5. 5-Tier Waterfall Answer Resolution (`AnswerResolver`) with Supabase Persistence
 * 6. Operator Dashboard REST API Server Launch (Port 3001)
 *
 * References:
 * - 02-trd.md
 * - 03-workflow.md
 * - V2-implementation.md (Phase V2-6)
 */

import fs from 'fs';
import path from 'path';
import { config } from './config/env.js';
import { ensureBucketsExist } from './db/storage.js';
import { migrate } from './db/migrate.js';
import { readAndDeduplicateUrls } from './scanner/csvDeduplicator.js';
import { PlaywrightScanner } from './scanner/playwrightScanner.js';
import { exportScannedJobs } from './scanner/exportScannedJobs.js';
import { segregateCandidatesByApplyWizzId, exportCandidateSegments } from './candidate/segregator.js';
import { AnswerResolver, exportResolvedApplications } from './resolver/answerResolver.js';
import { createServer } from './server/index.js';

export * from './config/env.js';
export * from './scanner/index.js';
export * from './candidate/index.js';
export * from './resolver/index.js';
export * from './submitter/index.js';
export * from './server/index.js';
export * from './orchestrator/index.js';
export * from './db/index.js';

export interface CliOptions {
  inputCsv: string;
  outputDir: string;
  verbose: boolean;
  port: number;
  skipMigrate: boolean;
  skipScan: boolean;
  skipSync: boolean;
  skipResolve: boolean;
  skipDashboard: boolean;
  applicationId?: string;
  limit?: number;
}

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    inputCsv: config.INPUT_CSV_PATH,
    outputDir: config.OUTPUT_DIR,
    verbose: false,
    port: config.PORT,
    skipMigrate: false,
    skipScan: false,
    skipSync: false,
    skipResolve: false,
    skipDashboard: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--input=') || arg.startsWith('-i=')) {
      options.inputCsv = arg.split('=')[1].trim();
    } else if (arg.startsWith('--output=') || arg.startsWith('-o=')) {
      options.outputDir = arg.split('=')[1].trim();
    } else if (arg.startsWith('--port=') || arg.startsWith('-p=')) {
      options.port = parseInt(arg.split('=')[1].trim(), 10) || config.PORT;
    } else if (arg.startsWith('--limit=') || arg.startsWith('-l=')) {
      options.limit = parseInt(arg.split('=')[1].trim(), 10);
    } else if (arg.startsWith('--applicationId=')) {
      options.applicationId = arg.split('=')[1].trim();
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--skip-migrate') {
      options.skipMigrate = true;
    } else if (arg === '--skip-scan') {
      options.skipScan = true;
    } else if (arg === '--skip-sync') {
      options.skipSync = true;
    } else if (arg === '--skip-resolve') {
      options.skipResolve = true;
    } else if (arg === '--skip-dashboard') {
      options.skipDashboard = true;
    }
  }

  return options;
}

/**
 * Executes the complete End-to-End Master Pipeline.
 */
export async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const startTime = Date.now();

  console.log('================================================================');
  console.log('  🌟 Greenhouse Automation Platform — Master Pipeline (V2)');
  console.log('================================================================');
  console.log(`• Environment:        ${config.NODE_ENV}`);
  console.log(`• Input CSV:          ${options.inputCsv}`);
  console.log(`• Output Dir:         ${options.outputDir}`);
  console.log(`• Express Port:       ${options.port}`);
  if (options.limit) {
    console.log(`• Candidate Limit:    ${options.limit} candidate(s)`);
  }
  console.log(`• Verbose Telemetry:  ${options.verbose ? 'Enabled' : 'Disabled'}`);
  console.log(`• Supabase Ready:     ${config.SUPABASE_URL ? 'Configured' : 'Missing'}`);
  console.log(`• LLM Provider:       ${config.LLM_PROVIDER}`);
  console.log('================================================================\n');

  try {
    // -------------------------------------------------------------------------
    // Step 1: Storage & Pre-flight Provisioning
    // -------------------------------------------------------------------------
    console.log('📦 [Step 1/5] Ensuring Supabase Storage buckets exist...');
    try {
      await ensureBucketsExist();
    } catch (bucketErr: any) {
      console.warn(`[Pre-flight] ⚠️ Storage bucket check warning: ${bucketErr.message}`);
    }

    // -------------------------------------------------------------------------
    // Step 2: V1 Data Migration
    // -------------------------------------------------------------------------
    if (!options.skipMigrate) {
      console.log('\n🔄 [Step 2/5] Checking V1 local cache data migration to Supabase...');
      try {
        await migrate();
        console.log('✅ Migration check completed.');
      } catch (migrateErr: any) {
        console.warn(`[Migration] ⚠️ Migration skipped or warning: ${migrateErr.message}`);
      }
    }

    // -------------------------------------------------------------------------
    // Step 3: Branch 1 & Branch 2 Ingestion
    // -------------------------------------------------------------------------
    const resolvedCsv = path.resolve(process.cwd(), options.inputCsv);
    if (!fs.existsSync(resolvedCsv)) {
      console.log(`ℹ️ Input CSV not found at "${resolvedCsv}". Using cached database records.`);
    } else {
      let targetJobUrls: string[] = [];

      // Run Branch 2 (Candidate Sync) first so we know exact jobs needed for candidate batch
      if (!options.skipSync) {
        console.log('\n👥 [Step 3a/5] Branch 2: Syncing Candidate Profiles & Uploading Master Resumes...');
        const candidateSegments = await segregateCandidatesByApplyWizzId(resolvedCsv, {
          syncProfiles: true,
          downloadResumes: true,
          limit: options.limit,
        });
        await exportCandidateSegments(candidateSegments, options.outputDir);
        console.log(`✅ Candidate sync completed. ${candidateSegments.size} candidate segment(s) synchronized.`);

        if (options.limit && candidateSegments.size > 0) {
          const urlSet = new Set<string>();
          for (const segment of candidateSegments.values()) {
            for (const job of segment.jobs) {
              if (job.canonicalUrl) {
                urlSet.add(job.canonicalUrl);
              }
            }
          }
          targetJobUrls = Array.from(urlSet);
          console.log(`🎯 Targeted ${targetJobUrls.length} unique job URL(s) for the ${candidateSegments.size} selected candidate(s).`);
        }
      }

      // Run Branch 1 (Form Scanning) for the targeted job URLs (or all URLs if no limit)
      if (!options.skipScan) {
        console.log('\n🔍 [Step 3b/5] Branch 1: Ingesting CSV and Scanning Unique Greenhouse Jobs...');
        const uniqueUrls = targetJobUrls.length > 0 ? targetJobUrls : await readAndDeduplicateUrls(resolvedCsv);
        const scanner = new PlaywrightScanner({
          workerPoolSize: config.WORKER_POOL_SIZE,
          timeoutMs: config.PLAYWRIGHT_TIMEOUT,
        });
        const scannedTemplates = await scanner.scanUniqueUrls(uniqueUrls);
        await exportScannedJobs(scannedTemplates, options.outputDir);
        console.log(`✅ Form scanning completed. ${scannedTemplates.length} job template(s) scanned.`);
      }
    }

    // -------------------------------------------------------------------------
    // Step 4: 5-Tier Waterfall Answer Resolution
    // -------------------------------------------------------------------------
    if (!options.skipResolve) {
      console.log('\n💡 [Step 4/5] Executing 5-Tier Waterfall Answer Resolution Engine...');
      const candidatesPath = path.join(options.outputDir, 'candidate_segments.json');
      const scannedPath = path.join(options.outputDir, 'scanned_jobs.json');

      if (fs.existsSync(candidatesPath) && fs.existsSync(scannedPath)) {
        const segments = JSON.parse(await fs.promises.readFile(candidatesPath, 'utf-8'));
        const templates = JSON.parse(await fs.promises.readFile(scannedPath, 'utf-8'));

        const resolver = new AnswerResolver();
        const resolvedApps = await resolver.resolveAllApplications(segments, templates);
        await exportResolvedApplications(resolvedApps, options.outputDir);

        let total = 0;
        let t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, man = 0;
        for (const app of resolvedApps) {
          for (const f of app.resolvedFields) {
            total++;
            if (f.source === 'manual') man++;
            else if (f.source === 'supabase' || f.resolvedByTier === 1) t1++;
            else if (f.source === 'resume_parse' || f.resolvedByTier === 2) t2++;
            else if (f.source === 'fuzzy_match' || f.resolvedByTier === 3) t3++;
            else if (f.source === 'api' || f.resolvedByTier === 4) t4++;
            else if (f.source === 'ai' || f.resolvedByTier === 5) t5++;
            else t1++;
          }
        }

        console.log(`✅ 5-Tier Resolution completed. Resolved ${resolvedApps.length} applications (${total} fields).`);
        console.log(`  - 🟢 Tier 1 (Supabase/Exact): ${t1} (${total ? ((t1/total)*100).toFixed(0) : 0}%)`);
        console.log(`  - 🔵 Tier 2 (Resume Parse):   ${t2} (${total ? ((t2/total)*100).toFixed(0) : 0}%)`);
        console.log(`  - 🔷 Tier 3 (Fuzzy QA):       ${t3} (${total ? ((t3/total)*100).toFixed(0) : 0}%)`);
        console.log(`  - 🟣 Tier 4 (API Refetch):    ${t4} (${total ? ((t4/total)*100).toFixed(0) : 0}%)`);
        console.log(`  - 🟣 Tier 5 (LLM Synthesis):  ${t5} (${total ? ((t5/total)*100).toFixed(0) : 0}%)`);
      } else {
        console.log('ℹ️ Local segment/template cache files not present. Using Supabase database records.');
      }
    }

    // -------------------------------------------------------------------------
    // Step 5: Operator Dashboard Server Launch
    // -------------------------------------------------------------------------
    const totalDurationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n================================================================');
    console.log(`  🎉 Pipeline Execution Complete in ${totalDurationSec}s!`);
    console.log('================================================================');

    if (!options.skipDashboard) {
      console.log(`\n🚀 [Step 5/5] Launching Operator Dashboard Server on port ${options.port}...`);
      const app = createServer();
      app.listen(options.port, () => {
        console.log(`\n✅ Operator Dashboard is live and accessible at:`);
        console.log(`   👉 http://localhost:${options.port}`);
        console.log(`\nReady for operator review, inline editing, dry-runs, and live submissions!\n`);
      });
    }
  } catch (err: any) {
    console.error(`\n❌ Fatal pipeline execution error: ${err.message}`);
    process.exit(1);
  }
}

// Auto-run if executed as main script
if (process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js') || process.argv[1].endsWith('main.ts'))) {
  main();
}
