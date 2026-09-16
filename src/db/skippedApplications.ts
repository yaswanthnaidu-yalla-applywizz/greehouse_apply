/**
 * Persists candidate_applications rows for jobs over the MAX_JOB_QUESTIONS field cap.
 */

import config from '../config/env.js';
import { OperatorErrors } from '../operator/operatorErrorMessages.js';
import { upsertApplication } from './applications.js';
import type { ScannedJobTemplate } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Skipped Applications');

export function isOverQuestionCap(fieldCount: number): boolean {
  return fieldCount >= config.MAX_JOB_QUESTIONS;
}

/**
 * Upserts (applywizz_id, job_url) with status SKIPPED so dashboard filters can target over-cap jobs.
 */
export async function upsertSkippedOverQuestionCap(
  applywizzId: string,
  persistJobUrl: string,
  template: Pick<ScannedJobTemplate, 'companyName' | 'jobTitle'>,
  questionCount: number
): Promise<void> {
  await upsertApplication({
    applywizz_id: applywizzId,
    job_url: persistJobUrl,
    company_name: template.companyName || null,
    job_title: template.jobTitle || null,
    status: 'SKIPPED',
    resolved_fields: [],
    error_message: OperatorErrors.TOO_MANY_QUESTIONS,
  });
  log.info(
    `[Answer Resolver] ⏭️ SKIPPED ${applywizzId} ${persistJobUrl} — ${questionCount} fields (>= ${config.MAX_JOB_QUESTIONS})`
  );
}
