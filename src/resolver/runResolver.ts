/**
 * @fileoverview Standalone CLI runner for Answer Resolution Engine (Phase V1-4).
 *
 * Usage:
 *   npx tsx src/resolver/runResolver.ts [options]
 *
 * Options:
 *   --candidates=<path>  Path to candidate_segments.json (default: output/candidate_segments.json)
 *   --scanned=<path>     Path to scanned_jobs.json (default: output/scanned_jobs.json)
 *   --output=<path>      Output directory (default: config.OUTPUT_DIR)
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';
import { AnswerResolver, exportResolvedApplications } from './answerResolver.js';
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
} {
  let candidatesPath = path.join(config.OUTPUT_DIR, 'candidate_segments.json');
  let scannedPath = path.join(config.OUTPUT_DIR, 'scanned_jobs.json');
  let outputDir = config.OUTPUT_DIR;

  for (const arg of args) {
    if (arg.startsWith('--candidates=')) {
      candidatesPath = arg.slice('--candidates='.length).trim();
    } else if (arg.startsWith('--scanned=')) {
      scannedPath = arg.slice('--scanned='.length).trim();
    } else if (arg.startsWith('--output=')) {
      outputDir = arg.slice('--output='.length).trim();
    }
  }

  return { candidatesPath, scannedPath, outputDir };
}

/**
 * Main execution function orchestrating Answer Resolution.
 */
export async function main(): Promise<void> {
  const { candidatesPath, scannedPath, outputDir } = parseResolverArgs(process.argv.slice(2));

  console.log('================================================================');
  console.log('  Answer Resolution Engine (Multi-Tier Tagging: supabase vs ai)');
  console.log('================================================================');
  console.log(`• Candidates File: ${candidatesPath}`);
  console.log(`• Scanned Jobs:    ${scannedPath}`);
  console.log(`• Output Dir:      ${outputDir}`);
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
    let aiCount = 0;

    for (const app of resolvedApps) {
      for (const f of app.resolvedFields) {
        totalFields++;
        if (f.source === 'supabase') supabaseCount++;
        if (f.source === 'ai') aiCount++;
      }
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n================================================================');
    console.log('  Answer Resolution Completed Successfully');
    console.log('================================================================');
    console.log(`• Elapsed Time:         ${elapsedSec}s`);
    console.log(`• Applications Ready:   ${resolvedApps.length}`);
    console.log(`• Total Fields Populated: ${totalFields}`);
    console.log(`  - 🟢 'supabase' Tagged: ${supabaseCount} (${totalFields ? ((supabaseCount / totalFields) * 100).toFixed(1) : 0}%)`);
    console.log(`  - 🟣 'ai' Tagged:       ${aiCount} (${totalFields ? ((aiCount / totalFields) * 100).toFixed(1) : 0}%)`);
    console.log(`• Output JSON:          ${outputPath}`);
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
