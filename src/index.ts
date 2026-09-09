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
import { AnswerResolver, exportResolvedApplications, resolutionSourceKey } from './resolver/answerResolver.js';
import { createServer, loadArtifacts } from './server/index.js';

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
  candidateId?: string;
  limit?: number;
  maxJobs?: number;
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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--input=') || arg.startsWith('-i=')) {
      options.inputCsv = arg.split('=')[1].trim();
    } else if (arg.startsWith('--output=') || arg.startsWith('-o=')) {
      options.outputDir = arg.split('=')[1].trim();
    } else if (arg.startsWith('--port=') || arg.startsWith('-p=')) {
      options.port = parseInt(arg.split('=')[1].trim(), 10) || config.PORT;
    } else if (arg.startsWith('--candidate=') || arg.startsWith('--candidateId=') || arg.startsWith('--applywizzId=') || arg.startsWith('-c=')) {
      options.candidateId = arg.split('=')[1].trim();
    } else if (arg === '--candidate' || arg === '--candidateId' || arg === '--applywizzId' || arg === '-c') {
      if (i + 1 < args.length) {
        options.candidateId = args[++i].trim();
      }
    } else if (arg.startsWith('--limit=') || arg.startsWith('-l=')) {
      options.limit = parseInt(arg.split('=')[1].trim(), 10);
    } else if (arg.startsWith('--maxJobs=') || arg.startsWith('--max-jobs=') || arg.startsWith('--jobs=')) {
      options.maxJobs = parseInt(arg.split('=')[1].trim(), 10);
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
  if (options.candidateId) {
    console.log(`• Target Candidate:   ${options.candidateId}`);
  }
  if (options.limit) {
    console.log(`• Candidate Limit:    ${options.limit} candidate(s)`);
  }
  if (options.maxJobs) {
    console.log(`• Max Jobs / User:    ${options.maxJobs} job link(s)`);
  }
  console.log(`• Verbose Telemetry:  ${options.verbose ? 'Enabled' : 'Disabled'}`);
  console.log(`• Supabase Ready:     ${config.SUPABASE_URL ? 'Configured' : 'Missing'}`);
  console.log(`• LLM Provider:       ${config.LLM_PROVIDER}`);
  console.log('================================================================\n');

  try {
    // -------------------------------------------------------------------------
    // Step 0: Operator Dashboard Server Launch (Early Live Boot)
    // -------------------------------------------------------------------------
    let serverInstance: any = null;
    if (!options.skipDashboard) {
      try {
        const app = createServer(options.outputDir);
        serverInstance = app.listen(options.port, () => {
          console.log(`🌐 [Live Dashboard] Server listening on http://localhost:${options.port}`);
          console.log(`   (Operator can open the dashboard right now to watch candidates populate live)\n`);
        });
        serverInstance.on('error', (e: any) => {
          if (e.code === 'EADDRINUSE') {
            console.log(`🌐 [Live Dashboard] Port ${options.port} already running dashboard instance.\n`);
          } else {
            console.warn(`[Dashboard] ⚠️ ${e.message}`);
          }
        });
      } catch (srvErr: any) {
        console.warn(`[Dashboard] ⚠️ Failed to boot early server: ${srvErr.message}`);
      }
    }

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
    if (!options.skipMigrate && !options.limit && !options.candidateId) {
      console.log('\n🔄 [Step 2/5] Checking V1 local cache data migration to Supabase...');
      try {
        await migrate();
        console.log('✅ Migration check completed.');
      } catch (migrateErr: any) {
        console.warn(`[Migration] ⚠️ Migration skipped or warning: ${migrateErr.message}`);
      }
    } else if (options.limit || options.candidateId) {
      console.log('\n🔄 [Step 2/5] Skipping historical cache migration (sample/target candidate mode enabled).');
    }

    // -------------------------------------------------------------------------
    // Step 3: Branch 1 & Branch 2 Ingestion
    // -------------------------------------------------------------------------
    const resolvedCsv = path.resolve(process.cwd(), options.inputCsv);
    if (!fs.existsSync(resolvedCsv)) {
      console.log(`ℹ️ Input CSV not found at "${resolvedCsv}".`);
      console.log(`📂 Synthesizing candidate segments from local cache/profiles...`);
      const cacheProfilesDir = path.resolve(process.cwd(), 'cache/profiles');
      const scannedJobsPath = path.resolve(process.cwd(), 'output/scanned_jobs.json');

      if (fs.existsSync(cacheProfilesDir) && fs.existsSync(scannedJobsPath)) {
        let profileFiles = fs
          .readdirSync(cacheProfilesDir)
          .filter((f) => f.endsWith('.json') && !f.includes('CI') && !f.includes('11'));
        if (options.candidateId) {
          const targetFile = `${options.candidateId}.json`;
          if (profileFiles.includes(targetFile)) {
            profileFiles = [targetFile];
          }
        }
        const limitCount = options.candidateId ? 1 : options.limit || 10;
        const selectedFiles = profileFiles.slice(0, limitCount);

        const scannedJobs = JSON.parse(fs.readFileSync(scannedJobsPath, 'utf-8'));
        const availableJobs = options.maxJobs ? scannedJobs.slice(0, options.maxJobs) : scannedJobs;
        const segments: any[] = [];

        for (const file of selectedFiles) {
          const profile = JSON.parse(fs.readFileSync(path.join(cacheProfilesDir, file), 'utf-8'));
          const applywizzId = profile.applywizzId || profile.applywizz_id || file.replace('.json', '');
          const jobs = availableJobs.map((sj: any, idx: number) => ({
            rawUrl: sj.jobUrl,
            canonicalUrl: sj.jobUrl,
            date: new Date().toLocaleDateString(),
            score: 1.0,
            scoredJobId: `${applywizzId}_${idx + 1}`,
            status: 'PENDING',
          }));

          segments.push({
            applywizzId,
            clientName:
              profile.clientName ||
              profile.client_name ||
              `${profile.firstName || ''} ${profile.lastName || ''}`.trim() ||
              applywizzId,
            jobs,
            totalJobs: jobs.length,
            syncedAt: new Date().toISOString(),
            profile,
          });
        }

        await fs.promises.writeFile(
          path.join(options.outputDir, 'candidate_segments.json'),
          JSON.stringify(segments, null, 2),
          'utf-8'
        );
        loadArtifacts(options.outputDir);
        console.log(`✅ Loaded ${segments.length} candidate profiles from cache for ${availableJobs.length} scanned job(s).`);
      }
    } else {
      let targetJobUrls: string[] = [];

      // Run Branch 2 (Candidate Sync) first so we know exact jobs needed for candidate batch
      if (!options.skipSync) {
        console.log('\n👥 [Step 3a/5] Branch 2: Syncing Candidate Profiles & Uploading Master Resumes...');
        const candidateSegments = await segregateCandidatesByApplyWizzId(resolvedCsv, {
          syncProfiles: true,
          downloadResumes: true,
          limit: options.limit,
          maxJobsPerCandidate: options.maxJobs,
          candidateId: options.candidateId,
        });
        await exportCandidateSegments(candidateSegments, options.outputDir);
        loadArtifacts(options.outputDir);
        console.log(`✅ Candidate sync completed. ${candidateSegments.size} candidate segment(s) synchronized.`);

        if ((options.limit || options.candidateId) && candidateSegments.size > 0) {
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
        console.log('\n🔍 [Step 3b/5] Branch 1: Checking Greenhouse Job Postings...');

        const scannedJobsPath = path.resolve(process.cwd(), options.outputDir, 'scanned_jobs.json');
        let existingTemplates: any[] = [];
        if (fs.existsSync(scannedJobsPath)) {
          try {
            existingTemplates = JSON.parse(fs.readFileSync(scannedJobsPath, 'utf-8'));
          } catch {}
        }
        const knownUrls = new Set(existingTemplates.map((t) => t.jobUrl));

        let candidateJobUrls = targetJobUrls;
        if (candidateJobUrls.length === 0) {
          const allCsvUrls = await readAndDeduplicateUrls(resolvedCsv);
          candidateJobUrls = options.limit ? allCsvUrls.slice(0, options.limit) : allCsvUrls;
        }

        const urlsToScan = candidateJobUrls.filter((u) => !knownUrls.has(u));

        if (urlsToScan.length === 0) {
          console.log(`✅ All ${candidateJobUrls.length} targeted job template(s) already cached. Skipping live scanning.`);
        } else {
          console.log(`🚀 Scanning ${urlsToScan.length} new Greenhouse job posting(s) (${candidateJobUrls.length - urlsToScan.length} already cached)...`);
          const scanner = new PlaywrightScanner({
            workerPoolSize: Math.min(config.WORKER_POOL_SIZE, urlsToScan.length),
            timeoutMs: config.PLAYWRIGHT_TIMEOUT,
          });
          const newlyScanned = await scanner.scanUniqueUrls(urlsToScan);

          const mergedMap = new Map<string, any>();
          for (const t of existingTemplates) mergedMap.set(t.jobUrl, t);
          for (const t of newlyScanned) mergedMap.set(t.jobUrl, t);

          const allScanned = Array.from(mergedMap.values());
          await exportScannedJobs(allScanned, options.outputDir);
          console.log(`✅ Form scanning completed. ${allScanned.length} job template(s) available.`);
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 4: 5-Tier Waterfall Answer Resolution
    // -------------------------------------------------------------------------
    if (!options.skipResolve) {
      console.log('\n💡 [Step 4/5] Executing Answer Resolution (Supabase → Resume → LLM)...');
      const candidatesPath = path.join(options.outputDir, 'candidate_segments.json');
      const scannedPath = path.join(options.outputDir, 'scanned_jobs.json');

      if (fs.existsSync(candidatesPath) && fs.existsSync(scannedPath)) {
        const segments = JSON.parse(await fs.promises.readFile(candidatesPath, 'utf-8'));
        const templates = JSON.parse(await fs.promises.readFile(scannedPath, 'utf-8'));

        const resolver = new AnswerResolver();
        const resolvedApps = await resolver.resolveAllApplications(segments, templates);
        await exportResolvedApplications(resolvedApps, options.outputDir);
        loadArtifacts(options.outputDir, { log: true });

        let total = 0;
        let supabase = 0;
        let resume = 0;
        let llm = 0;
        let unresolved = 0;
        let man = 0;
        for (const app of resolvedApps) {
          for (const f of app.resolvedFields) {
            total++;
            if (f.source === 'manual') man++;
            else {
              const key = resolutionSourceKey(f);
              if (key === 'supabase') supabase++;
              else if (key === 'resume') resume++;
              else if (key === 'llm') llm++;
              else if (key === 'unresolved') unresolved++;
              else supabase++;
            }
          }
        }

        console.log(`✅ Resolution completed. Resolved ${resolvedApps.length} applications (${total} fields).`);
        console.log(`  - 🟢 Supabase:  ${supabase} (${total ? ((supabase / total) * 100).toFixed(0) : 0}%)`);
        console.log(`  - 🔵 Resume:    ${resume} (${total ? ((resume / total) * 100).toFixed(0) : 0}%)`);
        console.log(`  - 🤖 LLM:       ${llm} (${total ? ((llm / total) * 100).toFixed(0) : 0}%)`);
        if (unresolved > 0) {
          console.log(`  - ⚪ Unresolved: ${unresolved} (${total ? ((unresolved / total) * 100).toFixed(0) : 0}%)`);
        }
      } else {
        console.log('ℹ️ Local segment/template cache files not present. Using Supabase database records.');
      }
    }

    // -------------------------------------------------------------------------
    // Step 5: Operator Dashboard Status
    // -------------------------------------------------------------------------
    const totalDurationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n================================================================');
    console.log(`  🎉 Pipeline Execution Complete in ${totalDurationSec}s!`);
    console.log('================================================================');

    if (!options.skipDashboard) {
      if (!serverInstance) {
        console.log(`\n🚀 [Step 5/5] Launching Operator Dashboard Server on port ${options.port}...`);
        const app = createServer(options.outputDir);
        serverInstance = app.listen(options.port, () => {
          console.log(`\n✅ Operator Dashboard is live and accessible at:`);
          console.log(`   👉 http://localhost:${options.port}`);
          console.log(`\nReady for operator review, inline editing, dry-runs, and live submissions!\n`);
        });
      } else {
        console.log(`\n✅ Operator Dashboard is running and ready for review:`);
        console.log(`   👉 http://localhost:${options.port}`);
        console.log(`\nReady for operator review, inline editing, dry-runs, and live submissions!\n`);
      }
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
