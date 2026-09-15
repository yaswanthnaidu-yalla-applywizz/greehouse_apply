/**
 * @fileoverview Standalone CLI runner for Answer Resolution Engine (Phase V2).
 *
 * Usage:
 *   npx tsx src/resolver/runResolver.ts [options]
 *
 * Options:
 *   --candidates=<path>  Path to candidate_segments.json (default: output/candidate_segments.json)
 *   --scanned=<path>     Path to scanned_jobs.json (default: output/scanned_jobs.json)
 *   --output=<path>      Output directory (default: config.OUTPUT_DIR)
 *   --verbose            Print detailed 5-tier waterfall resolution telemetry
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';
import { AnswerResolver, exportResolvedApplications, resolutionSourceKey } from './answerResolver.js';
import type { CandidateSegment, ScannedJobTemplate } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Run Resolver');

/**
 * Parses CLI arguments for the resolver runner.
 *
 * @param args - CLI arguments (process.argv.slice(2)).
 * @returns Structured resolver options.
 */
export function parseResolverArgs(args: string[]): {
  candidatesPath: string;
  scannedPath: string;
  outputDir: string;
  verbose: boolean;
} {
  let candidatesPath = path.join(config.OUTPUT_DIR, 'candidate_segments.json');
  let scannedPath = path.join(config.OUTPUT_DIR, 'scanned_jobs.json');
  let outputDir = config.OUTPUT_DIR;
  let verbose = false;

  for (const arg of args) {
    if (arg.startsWith('--candidates=')) {
      candidatesPath = arg.slice('--candidates='.length).trim();
    } else if (arg.startsWith('--scanned=')) {
      scannedPath = arg.slice('--scanned='.length).trim();
    } else if (arg.startsWith('--output=')) {
      outputDir = arg.slice('--output='.length).trim();
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    }
  }

  return { candidatesPath, scannedPath, outputDir, verbose };
}

/**
 * Main execution function orchestrating Answer Resolution.
 */
export async function main(): Promise<void> {
  const { candidatesPath, scannedPath, outputDir, verbose } = parseResolverArgs(process.argv.slice(2));

  log.info('================================================================');
  log.info('  Answer Resolution Engine (Supabase → Resume → LLM)');
  log.info('================================================================');
  log.info(`• Candidates File: ${candidatesPath}`);
  log.info(`• Scanned Jobs:    ${scannedPath}`);
  log.info(`• Output Dir:      ${outputDir}`);
  log.info(`• Verbose Mode:    ${verbose ? 'Enabled (Detailed Telemetry)' : 'Disabled'}`);
  log.info(`• LLM Provider:    ${config.LLM_PROVIDER}`);
  log.info(`• LLM Key Ready:   ${config.ACTIVE_LLM_API_KEY ? 'Yes' : 'No (fallback mode)'}`);
  log.info('================================================================\n');

  if (!fs.existsSync(candidatesPath)) {
    log.warn(`[Resolver Runner] ⚠️ Candidate segments file not found at: "${candidatesPath}".`);
    log.warn('[Resolver Runner] Please run "npm run sync:candidates" first to generate candidate segments.');
    return;
  }

  if (!fs.existsSync(scannedPath)) {
    log.warn(`[Resolver Runner] ⚠️ Scanned jobs file not found at: "${scannedPath}".`);
    log.warn('[Resolver Runner] Please run "npm run scan" first to scan Greenhouse form structures.');
    return;
  }

  const startTime = Date.now();

  try {
    const candidatesRaw = await fs.promises.readFile(candidatesPath, 'utf-8');
    const segments: CandidateSegment[] = JSON.parse(candidatesRaw);

    const scannedRaw = await fs.promises.readFile(scannedPath, 'utf-8');
    const templates: ScannedJobTemplate[] = JSON.parse(scannedRaw);

    const resolver = new AnswerResolver();
    const resolvedApps = await resolver.resolveAllApplications(segments, templates);

    const outputPath = await exportResolvedApplications(resolvedApps, outputDir);

    let totalFields = 0;
    let supabaseCount = 0;
    let resumeCount = 0;
    let llmCount = 0;
    let manualCount = 0;
    let unresolvedCount = 0;

    for (const app of resolvedApps) {
      for (const f of app.resolvedFields) {
        totalFields++;
        if (f.source === 'manual') manualCount++;
        else {
          const key = resolutionSourceKey(f);
          if (key === 'supabase') supabaseCount++;
          else if (key === 'resume') resumeCount++;
          else if (key === 'llm') llmCount++;
          else if (key === 'unresolved') unresolvedCount++;
          else supabaseCount++;
        }
      }
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    log.info('\n================================================================');
    log.info('  Answer Resolution Completed (Supabase → Resume → LLM)');
    log.info('================================================================');
    log.info(`• Elapsed Time:           ${elapsedSec}s`);
    log.info(`• Applications Ready:     ${resolvedApps.length}`);
    log.info(`• Total Fields Populated: ${totalFields}`);
    log.info(`  - 🟢 Supabase:  ${supabaseCount} (${totalFields ? ((supabaseCount / totalFields) * 100).toFixed(1) : 0}%)`);
    log.info(`  - 🔵 Resume:    ${resumeCount} (${totalFields ? ((resumeCount / totalFields) * 100).toFixed(1) : 0}%)`);
    log.info(`  - 🤖 LLM:       ${llmCount} (${totalFields ? ((llmCount / totalFields) * 100).toFixed(1) : 0}%)`);
    if (manualCount > 0) {
      log.info(`  - 🟡 Manual Overrides:        ${manualCount} (${totalFields ? ((manualCount / totalFields) * 100).toFixed(1) : 0}%)`);
    }
    if (unresolvedCount > 0) {
      log.info(`  - 🔴 Unresolved Fields:       ${unresolvedCount} (${totalFields ? ((unresolvedCount / totalFields) * 100).toFixed(1) : 0}%)`);
    }
    log.info(`• Output JSON:            ${outputPath}`);
    log.info('================================================================');
  } catch (err: any) {
    log.error(`[Resolver Runner] ❌ Error during answer resolution: ${err.message}`);
    process.exitCode = 1;
  }
}

// Auto-run when executed directly
if (process.argv[1] && process.argv[1].includes('runResolver')) {
  main();
}
