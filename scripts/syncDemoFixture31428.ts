/**
 * Full scan + sync + resolve for AWL-31428, then writes admin demo fixture JSON.
 *
 * Usage:
 *   npm run demo:fixture-31428
 *   npm run demo:fixture-31428 -- --maxJobs=5
 */

import { config } from '../src/config/env.js';
import {
  buildDemoFixtureFromOutput,
  GENERATED_DEMO_APPLYWIZZ_ID,
  writeGeneratedDemoFixtures,
} from '../src/dashboard/generatedDemoFixtures.js';
import { main } from '../src/index.js';

function parseMaxJobs(args: string[]): number | undefined {
  for (const arg of args) {
    if (arg.startsWith('--maxJobs=') || arg.startsWith('--max-jobs=') || arg.startsWith('--jobs=')) {
      const n = parseInt(arg.split('=')[1]?.trim() || '', 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

async function run(): Promise<void> {
  const passthrough = process.argv.slice(2);
  const maxJobs = parseMaxJobs(passthrough) ?? 10;

  const pipelineArgv = [
    'tsx',
    'src/index.ts',
    `--candidate=${GENERATED_DEMO_APPLYWIZZ_ID}`,
    `--maxJobs=${maxJobs}`,
    '--skip-dashboard',
    '--skip-migrate',
  ];

  console.log('================================================================');
  console.log('  Demo fixture sync — AWL-31428 (scan → sync → resolve → fixture)');
  console.log('================================================================');
  console.log(`• Candidate:   ${GENERATED_DEMO_APPLYWIZZ_ID}`);
  console.log(`• Max jobs:    ${maxJobs}`);
  console.log(`• Output dir:  ${config.OUTPUT_DIR}`);
  console.log('');

  const previousArgv = process.argv;
  process.argv = pipelineArgv;
  try {
    await main();
  } finally {
    process.argv = previousArgv;
  }

  const fixture = buildDemoFixtureFromOutput(GENERATED_DEMO_APPLYWIZZ_ID, config.OUTPUT_DIR);
  const outPath = writeGeneratedDemoFixtures(fixture);

  console.log('');
  console.log(`✅ Wrote demo fixture: ${outPath}`);
  console.log(`   segment jobs: ${fixture.segment.jobs?.length ?? 0}`);
  console.log(`   applications: ${fixture.applications.length}`);
  console.log(`   templates:    ${fixture.templates.length}`);
  console.log('');
  console.log('Restart the dashboard (or POST /api/admin/refresh-artifacts) to load the new admin demo candidate.');
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`❌ demo:fixture-31428 failed: ${message}`);
  process.exit(1);
});
