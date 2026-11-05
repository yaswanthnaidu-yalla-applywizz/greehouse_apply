import {
  listApplications,
  upsertApplication,
  type ApplicationRow,
} from '../db/applications.js';
import { findTemplateByJobUrl } from '../db/templates.js';
import { getProfile } from '../db/profiles.js';
import { findAnswersByCandidate } from '../db/qaBank.js';
import { getOrParseResume } from './tier2ResumeParse.js';
import {
  AnswerResolver,
  type ResolutionJobContext,
  type CachedResolutionEvidence,
} from './answerResolver.js';
import type {
  ResolutionExecution,
  ResolvedField,
  ScannedField,
  ScannedFieldType,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { hasAnyNonEmptyResolvedField } from '../utils/resolvedFields.js';

const log = createLogger('Resolver Worker Pool');

export interface ResolverWorker {
  id: number;
  applications: ApplicationRow[];
}

export interface ResolverWorkerPoolOptions {
  workerCount?: number;
  batchSize?: number;
}

function asScannedField(raw: any, index: number): ScannedField {
  const type = ['text', 'textarea', 'select', 'radio', 'checkbox', 'file', 'location_autocomplete'].includes(raw?.type)
    ? raw.type
    : 'text';
  return {
    fieldId: String(raw?.fieldId || raw?.field_id || `field-${index + 1}`),
    name: String(raw?.name || raw?.fieldId || `field-${index + 1}`),
    type: type as ScannedFieldType,
    label: String(raw?.label || raw?.question_label || ''),
    isRequired: Boolean(raw?.isRequired || raw?.required || raw?.is_required),
    options: Array.isArray(raw?.options) ? raw.options : undefined,
    optionsComplete: raw?.optionsComplete,
    metadata: raw?.metadata,
    classification: raw?.classification,
    intent: raw?.intent,
  };
}

function needsResolution(application: ApplicationRow): boolean {
  return !Array.isArray(application.resolved_fields) ||
    application.resolved_fields.some((field: any) => !String(field?.value ?? '').trim());
}

export class ResolverWorkerPool {
  private readonly workerCount: number;
  private readonly batchSize: number;

  constructor(options: ResolverWorkerPoolOptions = {}) {
    this.workerCount = Math.max(1, Math.min(3, options.workerCount ?? 3));
    this.batchSize = Math.max(1, options.batchSize ?? 100);
  }

  public async runOnce(): Promise<ResolverWorker[]> {
    const applications = (await listApplications({ status: 'READY_FOR_REVIEW' }))
      .filter(needsResolution)
      .sort((a, b) => {
        const candidateOrder = a.applywizz_id.localeCompare(b.applywizz_id);
        if (candidateOrder !== 0) return candidateOrder;
        return Date.parse(a.created_at || '') - Date.parse(b.created_at || '');
      })
      .slice(0, this.batchSize);

    const workers: ResolverWorker[] = Array.from({ length: this.workerCount }, (_, index) => ({
      id: index + 1,
      applications: [],
    }));
    applications.forEach((application, index) => {
      workers[index % this.workerCount].applications.push(application);
    });

    let busy = 0;
    await Promise.all(workers.map(async (worker) => {
      if (worker.applications.length === 0) return;
      busy++;
      log.info(`[Resolver] ${this.workerCount - busy} idle, ${busy} busy.`);
      try {
        for (const application of worker.applications) {
          await this.resolveApplication(application, worker.id);
        }
      } finally {
        busy--;
        log.info(`[Resolver] Worker ${worker.id} released | ${this.workerCount - busy} idle, ${busy} busy.`);
      }
    }));

    return workers;
  }

  private async resolveApplication(application: ApplicationRow, _workerId: number): Promise<void> {
    const profile = await getProfile(application.applywizz_id);
    const parsedResume = await getOrParseResume(application.applywizz_id);
    const qaEntries = await findAnswersByCandidate(application.applywizz_id);
    const template = await findTemplateByJobUrl(application.job_url);

    let fields: ScannedField[] = [];
    if (template && Array.isArray(template.fields_schema) && template.fields_schema.length > 0) {
      fields = template.fields_schema;
      log.info(
        `[Resolver] Loaded ${fields.length} fields from template for ${application.applywizz_id} ${application.job_url}`
      );
    } else if (Array.isArray(application.resolved_fields) && application.resolved_fields.length > 0) {
      fields = application.resolved_fields.map((field, index) => asScannedField(field, index));
    }

    if (fields.length === 0) {
      log.info(
        `[Resolver] ⏭️ Skipping ${application.applywizz_id} ${application.job_url} — no scanned fields available`
      );
      return;
    }

    const jobContext: ResolutionJobContext = {
      companyName: template?.company_name || application.company_name || 'Company',
      jobTitle: template?.job_title || application.job_title || 'Position',
      jobUrl: application.job_url,
      role: template?.job_title || application.job_title || 'Position',
      jobPostingLocation: template?.job_posting_location ?? undefined,
      jobPostingFacts: template?.job_posting_facts ?? undefined,
    };

    const resolved = await this.resolveFieldsWithSharedResolver(
      application.applywizz_id,
      fields,
      jobContext,
      { profile, parsedResume, qaEntries },
      { mode: 'live' }
    );

    const existingEdited = new Map<string, ResolvedField>();
    if (Array.isArray(application.resolved_fields)) {
      for (const rf of application.resolved_fields) {
        if (rf && rf.isEdited) {
          existingEdited.set(rf.fieldId || rf.name || rf.label, rf);
        }
      }
    }

    const finalFields = resolved.map((f) => {
      const edited = existingEdited.get(f.fieldId) || existingEdited.get(f.name) || existingEdited.get(f.label);
      return edited ? { ...f, ...edited, isEdited: true } : f;
    });

    if (!hasAnyNonEmptyResolvedField(finalFields)) {
      log.info(
        `[Resolver] ⏭️ Skipping candidate_applications upsert for ${application.applywizz_id} ${application.job_url} — no fields resolved`
      );
      return;
    }

    await upsertApplication({
      id: application.id,
      applywizz_id: application.applywizz_id,
      job_url: application.job_url,
      company_name: application.company_name,
      job_title: application.job_title,
      status: application.status,
      resolved_fields: finalFields,
    });
  }

  public async resolveFieldsWithSharedResolver(
    applywizzId: string,
    fields: ScannedField[],
    jobContext: ResolutionJobContext,
    evidence?: CachedResolutionEvidence,
    execution: ResolutionExecution = { mode: 'live' }
  ): Promise<ResolvedField[]> {
    const resolver = new AnswerResolver();
    return resolver.resolveFormFields(applywizzId, fields, jobContext, evidence, execution);
  }
}

export default ResolverWorkerPool;
