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

  console.log('================================================================');
  console.log('  Answer Resolution Engine (Supabase → Resume → LLM)');
  console.log('================================================================');
  console.log(`• Candidates File: ${candidatesPath}`);
  console.log(`• Scanned Jobs:    ${scannedPath}`);
  console.log(`• Output Dir:      ${outputDir}`);
  console.log(`• Verbose Mode:    ${verbose ? 'Enabled (Detailed Telemetry)' : 'Disabled'}`);
  console.log(`• LLM Provider:    ${config.LLM_PROVIDER}`);
  console.log(`• LLM Key Ready:   ${config.ACTIVE_LLM_API_KEY ? 'Yes' : 'No (fallback mode)'}`);
  console.log('================================================================\n');

  if (!fs.existsSync(candidatesPath)) {
    console.warn(`[Resolver Runner] ⚠️ Candidate segments file not found at: "${candidatesPath}".`);
    console.warn('[Resolver Runner] Please run "npm run sync:candidates" first to generate candidate segments.');
    return;
  }

  if (!fs.existsSync(scannedPath)) {
    console.warn(`[Resolver Runner] ⚠️ Scanned jobs file not found at: "${scannedPath}".`);
    console.warn('[Resolver Runner] Please run "npm run scan" first to scan Greenhouse form structures.');
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

    console.log('\n================================================================');
    console.log('  Answer Resolution Completed (Supabase → Resume → LLM)');
    console.log('================================================================');
    console.log(`• Elapsed Time:           ${elapsedSec}s`);
    console.log(`• Applications Ready:     ${resolvedApps.length}`);
    console.log(`• Total Fields Populated: ${totalFields}`);
    console.log(`  - 🟢 Supabase:  ${supabaseCount} (${totalFields ? ((supabaseCount / totalFields) * 100).toFixed(1) : 0}%)`);
    console.log(`  - 🔵 Resume:    ${resumeCount} (${totalFields ? ((resumeCount / totalFields) * 100).toFixed(1) : 0}%)`);
    console.log(`  - 🤖 LLM:       ${llmCount} (${totalFields ? ((llmCount / totalFields) * 100).toFixed(1) : 0}%)`);
    if (manualCount > 0) {
      console.log(`  - 🟡 Manual Overrides:        ${manualCount} (${totalFields ? ((manualCount / totalFields) * 100).toFixed(1) : 0}%)`);
    }
    if (unresolvedCount > 0) {
      console.log(`  - 🔴 Unresolved Fields:       ${unresolvedCount} (${totalFields ? ((unresolvedCount / totalFields) * 100).toFixed(1) : 0}%)`);
    }
    console.log(`• Output JSON:            ${outputPath}`);
    console.log('================================================================');
  } catch (err: any) {
    console.error(`[Resolver Runner] ❌ Error during answer resolution: ${err.message}`);
    process.exitCode = 1;
  }
}

// Auto-run when executed directly
if (process.argv[1] && process.argv[1].includes('runResolver')) {
  main();
}
