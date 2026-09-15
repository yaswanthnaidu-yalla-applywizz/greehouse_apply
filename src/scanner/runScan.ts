/**
 * @fileoverview Standalone CLI runner for Branch 1 Scanner pipeline.
 *
 * Usage:
 *   npx tsx src/scanner/runScan.ts [options]
 *
 * Options:
 *   --input=<path>     Input CSV path (default: config.INPUT_CSV_PATH)
 *   --limit=<number>   Limit total URLs scanned (e.g. --limit=10)
 *   --workers=<number> Override worker pool size (1-10)
 *   --output=<path>    Output directory (default: config.OUTPUT_DIR)
 */

import fs from 'fs';
import { config } from '../config/env.js';
import { readAndDeduplicateUrls } from './csvDeduplicator.js';
import { PlaywrightScanner } from './playwrightScanner.js';
import { exportScannedJobs } from './exportScannedJobs.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Run Scan');

/**
 * Parses command-line arguments into structured runner options.
 *
 * @param args - Array of CLI argument strings (process.argv.slice(2)).
 * @returns Structured CLI options object.
 */
export function parseCliArgs(args: string[]): {
  inputPath: string;
  limit?: number;
  workers: number;
  outputDir: string;
} {
  let inputPath = config.INPUT_CSV_PATH;
  let limit: number | undefined;
  let workers = config.WORKER_POOL_SIZE;
  let outputDir = config.OUTPUT_DIR;

  for (const arg of args) {
    if (arg.startsWith('--input=')) {
      inputPath = arg.slice('--input='.length).trim();
    } else if (arg.startsWith('--limit=')) {
      const val = parseInt(arg.slice('--limit='.length), 10);
      if (!isNaN(val) && val > 0) limit = val;
    } else if (arg.startsWith('--workers=')) {
      const val = parseInt(arg.slice('--workers='.length), 10);
      if (!isNaN(val) && val > 0) workers = Math.min(10, Math.max(1, val));
    } else if (arg.startsWith('--output=')) {
      outputDir = arg.slice('--output='.length).trim();
    }
  }

  return { inputPath, limit, workers, outputDir };
}

/**
 * Main execution function orchestrating Branch 1 deduplication, scanning, and export.
 */
export async function main(): Promise<void> {
  const { inputPath, limit, workers, outputDir } = parseCliArgs(process.argv.slice(2));

  log.info('================================================================');
  log.info('  Branch 1: Greenhouse Unique Link Scanner');
  log.info('================================================================');
  log.info(`• Input CSV:   ${inputPath}`);
  log.info(`• Output Dir:  ${outputDir}`);
  log.info(`• Workers:     ${workers}`);
  log.info(`• Limit:       ${limit ? limit : 'All'}`);
  log.info('================================================================\n');

  if (!fs.existsSync(inputPath)) {
    log.warn(`[Runner] ⚠️ Input CSV file not found at: "${inputPath}".`);
    log.warn('[Runner] Please verify the CSV path in .env (INPUT_CSV_PATH) or pass --input="<path>".');
    return;
  }

  const startTime = Date.now();

  try {
    // 1. Read & Deduplicate URLs
    const uniqueUrls = await readAndDeduplicateUrls(inputPath, { limit });
    if (uniqueUrls.length === 0) {
      log.info('[Runner] ⚠️ No valid Greenhouse URLs found to scan.');
      return;
    }

    const urlsToScan = limit ? uniqueUrls.slice(0, limit) : uniqueUrls;

    // 2. Scan URLs with Playwright Worker Pool
    const scanner = new PlaywrightScanner({ workerPoolSize: workers });
    const scannedTemplates = await scanner.scanUniqueUrls(urlsToScan);

    // 3. Export to JSON and CSV
    const exportResult = await exportScannedJobs(scannedTemplates, outputDir);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const activeJobs = scannedTemplates.filter((t) => !t.isExpired).length;
    const expiredJobs = scannedTemplates.filter((t) => t.isExpired).length;

    log.info('\n================================================================');
    log.info('  Branch 1 Scanner Run Completed');
    log.info('================================================================');
    log.info(`• Elapsed Time:    ${elapsedSec}s`);
    log.info(`• Total Scanned:   ${scannedTemplates.length}`);
    log.info(`• Active Jobs:     ${activeJobs}`);
    log.info(`• Expired/404:     ${expiredJobs}`);
    log.info(`• Field CSV Rows:  ${exportResult.totalFieldRows}`);
    log.info(`• Output JSON:     ${exportResult.jsonPath}`);
    log.info(`• Output CSV:      ${exportResult.csvPath}`);
    log.info('================================================================');
  } catch (error: any) {
    log.error(`[Runner] ❌ Error during scan execution: ${error.message}`);
    process.exitCode = 1;
  }
}

// Auto-run when invoked directly
if (process.argv[1] && process.argv[1].includes('runScan')) {
  main();
}
