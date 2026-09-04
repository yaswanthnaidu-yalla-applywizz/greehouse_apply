/**
 * @fileoverview Application entry point stub for Greenhouse Job Application Automation (V1).
 *
 * Validates runtime environment configuration, initializes core subsystem pointers,
 * and prints an operational summary banner.
 */

import { config } from './config/env.js';

export * from './types/index.js';
export * from './config/env.js';

/**
 * Bootstraps the application runtime and logs configuration parameters.
 */
export function bootstrap(): void {
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
  console.log(`• Input CSV Path:     ${config.INPUT_CSV_PATH}`);
  console.log(`• Output Directory:   ${config.OUTPUT_DIR}`);
  console.log(`• Resumes Directory:  ${config.RESUMES_DIR}`);
  console.log('================================================================');
  console.log('System scaffolding initialized successfully. Ready for Phase V1-2.');
}

// Execute bootstrap when invoked as main module
bootstrap();
