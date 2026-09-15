/**
 * Ensures candidate_applications rows exist for CSV-segment jobs (idempotent upsert).
 */

import { upsertApplication, type ApplicationStatus } from './applications.js';
import { findTemplateByJobUrl } from './templates.js';
import { isOverQuestionCap, upsertSkippedOverQuestionCap } from './skippedApplications.js';
import type { CandidateSegment } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Ensure Candidate Application Rows');

export interface EnsureApplicationRowResult {
  attempted: number;
  upserted: number;
  skippedOverCap: number;
  failed: number;
}

/**
 * Upserts one application row per job in the segment, enriching company/title from scanned_job_templates when available.
 */
export async function ensureApplicationRowsForSegment(
  segment: CandidateSegment
): Promise<EnsureApplicationRowResult> {
  const result: EnsureApplicationRowResult = {
    attempted: segment.jobs.length,
    upserted: 0,
    skippedOverCap: 0,
    failed: 0,
  };

  for (const job of segment.jobs) {
    const persistJobUrl = (job.canonicalUrl || job.rawUrl || '').trim();
    if (!persistJobUrl) {
      result.failed++;
      continue;
    }

    const template =
      (await findTemplateByJobUrl(persistJobUrl)) ||
      (job.rawUrl && job.rawUrl !== persistJobUrl ? await findTemplateByJobUrl(job.rawUrl) : null);

    const fieldCount = template?.fields_schema?.length ?? 0;
    if (template && isOverQuestionCap(fieldCount)) {
      try {
        await upsertSkippedOverQuestionCap(
          segment.applywizzId,
          persistJobUrl,
          {
            companyName: template.company_name || segment.clientName || segment.applywizzId,
            jobTitle: template.job_title || '',
          },
          fieldCount
        );
        result.upserted++;
        result.skippedOverCap++;
      } catch (err: any) {
        result.failed++;
        log.warn(
          `[Segregator] ⚠️ Could not upsert SKIPPED candidate_applications for ${segment.applywizzId} ${persistJobUrl}: ${err.message}`
        );
      }
      continue;
    }

    let companyName = template?.company_name || segment.clientName || segment.applywizzId;
    let jobTitle = template?.job_title || null;
    let status: ApplicationStatus = 'READY_FOR_REVIEW';

    try {
      await upsertApplication({
        applywizz_id: segment.applywizzId,
        job_url: persistJobUrl,
        company_name: companyName,
        job_title: jobTitle,
        status,
        resolved_fields: [],
      });
      result.upserted++;
    } catch (err: any) {
      result.failed++;
      log.warn(
        `[Segregator] ⚠️ Could not upsert candidate_applications for ${segment.applywizzId} ${persistJobUrl}: ${err.message}`
      );
    }
  }

  return result;
}
