/**
 * @fileoverview Standalone CLI runner for Live Automated Application Submissions (Phase V2-6).
 *
 * Usage:
 *   npx tsx src/submitter/runLiveSubmitCli.ts [options]
 *
 * Options:
 *   --applicationId=<uuid>   Application record UUID
 *   --applywizzId=<id>       Candidate ApplyWizz ID
 *   --jobUrl=<url>           Greenhouse Job URL
 *   --headful                Run browser in visible (headful) mode
 *   --headless               Run browser in headless mode (default)
 *   --timeout=<ms>           Interaction timeout in milliseconds (default: 30000)
 */

import { runLiveSubmit } from './liveSubmit.js';
import { getApplicationByCandidateAndJob, listApplications } from '../db/applications.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Run Live Submit Cli');

export function parseSubmitArgs(args: string[]): {
  applicationId?: string;
  applywizzId?: string;
  jobUrl?: string;
  headless: boolean;
  timeoutMs: number;
} {
  let applicationId: string | undefined;
  let applywizzId: string | undefined;
  let jobUrl: string | undefined;
  let headless = true;
  let timeoutMs = 30000;

  for (const arg of args) {
    if (arg.startsWith('--applicationId=')) {
      applicationId = arg.slice('--applicationId='.length).trim();
    } else if (arg.startsWith('--applywizzId=')) {
      applywizzId = arg.slice('--applywizzId='.length).trim();
    } else if (arg.startsWith('--jobUrl=')) {
      jobUrl = arg.slice('--jobUrl='.length).trim();
    } else if (arg === '--headful') {
      headless = false;
    } else if (arg === '--headless') {
      headless = true;
    } else if (arg.startsWith('--timeout=')) {
      timeoutMs = parseInt(arg.slice('--timeout='.length).trim(), 10) || 30000;
    }
  }

  return { applicationId, applywizzId, jobUrl, headless, timeoutMs };
}

export async function main(): Promise<void> {
  const options = parseSubmitArgs(process.argv.slice(2));

  log.info('================================================================');
  log.info('  🚀 Greenhouse Live Submission Engine (V2)');
  log.info('================================================================');

  let targetAppId = options.applicationId;

  if (!targetAppId && options.applywizzId && options.jobUrl) {
    const found = await getApplicationByCandidateAndJob(options.applywizzId, options.jobUrl);
    if (found?.id) {
      targetAppId = found.id;
    }
  }

  if (!targetAppId) {
    // Look for first application with READY_FOR_REVIEW status
    const readyApps = await listApplications({ status: 'READY_FOR_REVIEW' });
    if (readyApps.length > 0 && readyApps[0].id) {
      targetAppId = readyApps[0].id;
      log.info(`ℹ️ No application specified. Defaulting to first READY_FOR_REVIEW app: ${targetAppId}`);
    } else {
      log.error('❌ No application ID provided and no READY_FOR_REVIEW applications found.');
      log.error('Usage: npx tsx src/submitter/runLiveSubmitCli.ts --applicationId=<uuid>');
      process.exit(1);
    }
  }

  log.info(`• Target Application ID: ${targetAppId}`);
  log.info(`• Mode:                  ${options.headless ? 'Headless' : 'Visible (Headful)'}`);
  log.info(`• Timeout:               ${options.timeoutMs}ms`);
  log.info('================================================================\n');

  try {
    const result = await runLiveSubmit(targetAppId, {
      headless: options.headless,
      timeoutMs: options.timeoutMs,
    });

    log.info('\n================================================================');
    log.info(`  Submission Result: ${result.status}`);
    log.info('================================================================');
    log.info(`• Application ID:  ${result.applicationId}`);
    log.info(`• Status:          ${result.status}`);
    log.info(`• Verified:        ${result.success ? '✅ Yes' : '❌ No'}`);
    if (result.requiresOtp || result.requiresCaptcha) {
      log.info(`• OTP/CAPTCHA:     ⚠️ Requires human intervention`);
    }
    if (result.proofWebUrl) {
      log.info(`• Proof Web URL:   ${result.proofWebUrl}`);
    }
    if (result.errorMessage) {
      log.info(`• Error Message:   ${result.errorMessage}`);
    }
    log.info('================================================================');

    if (result.status === 'APPLIED') {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (err: any) {
    log.error(`\n❌ Submission execution error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].includes('runLiveSubmitCli')) {
  main();
}
