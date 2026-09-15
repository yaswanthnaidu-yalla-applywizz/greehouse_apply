/**
 * Persists candidate_applications rows for jobs over the MAX_JOB_QUESTIONS field cap.
 */

import config from '../config/env.js';
import { upsertApplication } from './applications.js';
import type { ScannedJobTemplate } from '../types/index.js';

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
  const maxAllowed = config.MAX_JOB_QUESTIONS - 1;
  await upsertApplication({
    applywizz_id: applywizzId,
    job_url: persistJobUrl,
    company_name: template.companyName || null,
    job_title: template.jobTitle || null,
    status: 'SKIPPED',
    resolved_fields: [],
    error_message: `Skipped: ${questionCount} form fields (dashboard cap allows ${maxAllowed} or fewer; MAX_JOB_QUESTIONS=${config.MAX_JOB_QUESTIONS})`,
  });
  console.log(
    `[Answer Resolver] ⏭️ SKIPPED ${applywizzId} ${persistJobUrl} — ${questionCount} fields (>= ${config.MAX_JOB_QUESTIONS})`
  );
}
