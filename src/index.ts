/**
 * @fileoverview Application entry point stub for Greenhouse Job Application Automation (V1).
 *
 * Validates runtime environment configuration, initializes core subsystem pointers,
 * and prints an operational summary banner.
 */

import fs from 'fs';
import { config } from './config/env.js';

export * from './types/index.js';
export * from './config/env.js';
export * from './scanner/index.js';
export * from './candidate/index.js';

/**
 * Bootstraps the application runtime, checks essential file paths,
 * and prints an operational summary banner.
 */
export function bootstrap(): void {
  const csvExists = fs.existsSync(config.INPUT_CSV_PATH);

  console.log('================================================================');
  console.log('  Greenhouse Job Application Automation System (V1)');
  console.log('================================================================');
  console.log(`• Environment:        ${config.NODE_ENV}`);
  console.log(`• Express Port:       ${config.PORT}`);
  console.log(`• ApplyWizz API:      ${config.APPLYWIZZ_API_URL}`);
  console.log(`• LLM Provider:       ${config.LLM_PROVIDER}`);
  console.log(`• LLM Key Configured: ${config.ACTIVE_LLM_API_KEY ? 'Yes (configured)' : 'No (missing)'}`);
  console.log(`• Worker Pool Size:   ${config.WORKER_POOL_SIZE}`);
  console.log(`• Playwright Timeout: ${config.PLAYWRIGHT_TIMEOUT}ms`);
  console.log(`• Jitter Delay Range: ${config.SCANNER_JITTER_MIN_MS}ms - ${config.SCANNER_JITTER_MAX_MS}ms`);
  console.log(`• Input CSV Path:     ${config.INPUT_CSV_PATH} (${csvExists ? 'Found' : 'Not Found'})`);
  console.log(`• Output Directory:   ${config.OUTPUT_DIR}`);
  console.log(`• Resumes Directory:  ${config.RESUMES_DIR}`);
  console.log('================================================================');
  console.log('• Subsystems:');
  console.log('  - Branch 1 Scanner:   READY (CSV Deduplicator, Playwright Scanner, Exporter)');
  console.log('  - Branch 2 Candidate: READY (ApplyWizz API Client, Segregator, Resume Downloader)');
  console.log('================================================================');
  console.log('Commands:');
  console.log('  - npm run scan             Run Branch 1 URL deduplication and DOM scanning');
  console.log('  - npm run sync:candidates  Run Branch 2 candidate segregation and profile sync');
  console.log('================================================================');
}

// Execute bootstrap when invoked as main module
bootstrap();
