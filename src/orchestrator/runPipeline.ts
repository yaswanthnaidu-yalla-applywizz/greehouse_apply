/**
 * @fileoverview Standalone CLI Runner for End-to-End Pipeline Execution (Phase V1-6).
 *
 * Usage:
 *   npx tsx src/orchestrator/runPipeline.ts [options]
 *
 * Options:
 *   --input=<path>        Path to input CSV (default: config.INPUT_CSV_PATH)
 *   --output=<path>       Output directory (default: config.OUTPUT_DIR)
 *   --limit=<n>           Limit number of rows to parse
 *   --concurrency=<n>     Playwright worker pool size
 *   --cached              Reuse existing scanned_jobs.json if present
 */

import { config } from '../config/env.js';
import { V1Pipeline } from './pipeline.js';

/**
 * Parses command-line arguments for the pipeline runner.
 *
 * @param args - Array of CLI argument strings.
 * @returns Structured pipeline runner options.
 */
export function parsePipelineArgs(args: string[]): {
  inputPath: string;
  outputDir: string;
  limit?: number;
  concurrency?: number;
  skipScanIfCached: boolean;
} {
  let inputPath = config.INPUT_CSV_PATH;
  let outputDir = config.OUTPUT_DIR;
  let limit: number | undefined;
  let concurrency: number | undefined;
  let skipScanIfCached = false;

  for (const arg of args) {
    if (arg.startsWith('--input=')) {
      inputPath = arg.slice('--input='.length).trim();
    } else if (arg.startsWith('--output=')) {
      outputDir = arg.slice('--output='.length).trim();
    } else if (arg.startsWith('--limit=')) {
      const parsed = parseInt(arg.slice('--limit='.length).trim(), 10);
      if (!isNaN(parsed) && parsed > 0) limit = parsed;
    } else if (arg.startsWith('--concurrency=')) {
      const parsed = parseInt(arg.slice('--concurrency='.length).trim(), 10);
      if (!isNaN(parsed) && parsed > 0) concurrency = parsed;
    } else if (arg === '--cached' || arg === '--skip-scan') {
      skipScanIfCached = true;
    }
  }

  return { inputPath, outputDir, limit, concurrency, skipScanIfCached };
}

/**
 * Main entry point function for the CLI runner.
 */
export async function main(): Promise<void> {
  const { inputPath, outputDir, limit, concurrency, skipScanIfCached } = parsePipelineArgs(
    process.argv.slice(2)
  );

  const pipeline = new V1Pipeline();

  try {
    const result = await pipeline.runFullPipeline(inputPath, outputDir, {
      limit,
      concurrency,
      skipScanIfCached,
    });

    if (result.status === 'FAILED') {
      process.exitCode = 1;
    }
  } catch (err: any) {
    console.error(`[Pipeline Runner] ❌ Fatal error executing pipeline: ${err.message}`);
    process.exitCode = 1;
  }
}

// Auto-run when executed directly
if (process.argv[1] && process.argv[1].includes('runPipeline')) {
  main();
}
