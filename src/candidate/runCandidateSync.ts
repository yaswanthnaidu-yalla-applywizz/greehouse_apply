/**
 * @fileoverview Standalone CLI runner for Branch 2 Candidate Profile Sync & Segregation.
 *
 * Usage:
 *   npx tsx src/candidate/runCandidateSync.ts [options]
 *
 * Options:
 *   --input=<path>         Input CSV path (default: config.INPUT_CSV_PATH)
 *   --limit=<number>       Limit total candidates processed (e.g. --limit=5)
 *   --concurrency=<number> Override API sync concurrency (default: 10)
 *   --output=<path>        Output directory (default: config.OUTPUT_DIR)
 */

import fs from 'fs';
import { config } from '../config/env.js';
import { segregateCandidatesByApplyWizzId, exportCandidateSegments } from './segregator.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Run Candidate Sync');

/**
 * Parses command-line arguments into structured candidate sync options.
 *
 * @param args - CLI argument array (process.argv.slice(2)).
 * @returns Parsed options object.
 */
export function parseSyncArgs(args: string[]): {
  inputPath: string;
  limit?: number;
  concurrency: number;
  outputDir: string;
} {
  let inputPath = config.INPUT_CSV_PATH;
  let limit: number | undefined;
  let concurrency = 10;
  let outputDir = config.OUTPUT_DIR;

  for (const arg of args) {
    if (arg.startsWith('--input=')) {
      inputPath = arg.slice('--input='.length).trim();
    } else if (arg.startsWith('--limit=')) {
      const val = parseInt(arg.slice('--limit='.length), 10);
      if (!isNaN(val) && val > 0) limit = val;
    } else if (arg.startsWith('--concurrency=')) {
      const val = parseInt(arg.slice('--concurrency='.length), 10);
      if (!isNaN(val) && val > 0) concurrency = Math.min(25, Math.max(1, val));
    } else if (arg.startsWith('--output=')) {
      outputDir = arg.slice('--output='.length).trim();
    }
  }

  return { inputPath, limit, concurrency, outputDir };
}

/**
 * Main execution function orchestrating Branch 2 candidate segregation and sync.
 */
export async function main(): Promise<void> {
  const { inputPath, limit, concurrency, outputDir } = parseSyncArgs(process.argv.slice(2));

  log.info('================================================================');
  log.info('  Branch 2: ApplyWizz Candidate Segregator & Profile Sync');
  log.info('================================================================');
  log.info(`• Input CSV:     ${inputPath}`);
  log.info(`• Output Dir:    ${outputDir}`);
  log.info(`• Concurrency:   ${concurrency}`);
  log.info(`• Limit:         ${limit ? `${limit} candidates` : 'All'}`);
  log.info(`• ApplyWizz API: ${config.APPLYWIZZ_API_URL}`);
  log.info('================================================================\n');

  if (!fs.existsSync(inputPath)) {
    log.warn(`[Candidate Sync Runner] ⚠️ Input CSV file not found at: "${inputPath}".`);
    log.warn('[Candidate Sync Runner] Please verify the CSV path in .env (INPUT_CSV_PATH) or pass --input="<path>".');
    return;
  }

  const startTime = Date.now();

  try {
    const segments = await segregateCandidatesByApplyWizzId(inputPath, {
      limit,
      concurrency,
      syncProfiles: true,
      downloadResumes: true,
    });

    const outputPath = await exportCandidateSegments(segments, outputDir);

    let totalJobAssignments = 0;
    let syncedProfilesCount = 0;
    let downloadedResumesCount = 0;

    for (const segment of segments.values()) {
      totalJobAssignments += segment.totalJobs;
      if (segment.profile) {
        syncedProfilesCount++;
        if (segment.profile.localResumePath && fs.existsSync(segment.profile.localResumePath)) {
          downloadedResumesCount++;
        }
      }
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    log.info('\n================================================================');
    log.info('  Branch 2 Candidate Sync Completed');
    log.info('================================================================');
    log.info(`• Elapsed Time:         ${elapsedSec}s`);
    log.info(`• Unique Candidates:    ${segments.size}`);
    log.info(`• Profiles Synced:      ${syncedProfilesCount}/${segments.size}`);
    log.info(`• Resumes Downloaded:   ${downloadedResumesCount}`);
    log.info(`• Total Job Mappings:   ${totalJobAssignments}`);
    log.info(`• Output Segments File: ${outputPath}`);
    log.info('================================================================');
  } catch (error: any) {
    log.error(`[Candidate Sync Runner] ❌ Error during candidate sync: ${error.message}`);
    process.exitCode = 1;
  }
}

// Auto-run when executed directly
if (process.argv[1] && process.argv[1].includes('runCandidateSync')) {
  main();
}
