import {
  listApplications,
  upsertApplication,
  type ApplicationRow,
} from '../db/applications.js';
import { getProfile } from '../db/profiles.js';
import { findAnswersByCandidate } from '../db/qaBank.js';
import { getOrParseResume } from './tier2ResumeParse.js';
import { resolveTier1 } from './tier1Supabase.js';
import { resolveTier2 } from './tier2ResumeParse.js';
import { resolveTier3 } from './tier3FuzzyMatch.js';
import { resolveBatchLlmFields, type UnresolvedFieldGroup } from './batchLlmResolver.js';
import type { ResolvedField, ScannedField, ScannedFieldType } from '../types/index.js';

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
      console.log(`[Resolver] ${this.workerCount - busy} idle, ${busy} busy.`);
      try {
        for (const application of worker.applications) {
          await this.resolveApplication(application, worker.id);
        }
      } finally {
        busy--;
        console.log(`[Resolver] Worker ${worker.id} released | ${this.workerCount - busy} idle, ${busy} busy.`);
      }
    }));

    return workers;
  }

  private async resolveApplication(application: ApplicationRow, workerId: number): Promise<void> {
    const profile = await getProfile(application.applywizz_id);
    const parsedResume = await getOrParseResume(application.applywizz_id);
    const qaEntries = await findAnswersByCandidate(application.applywizz_id);
    const existing = Array.isArray(application.resolved_fields) ? application.resolved_fields : [];
    const fields = existing.map((field, index) => asScannedField(field, index));
    const resolved: ResolvedField[] = [];
    const pending: ScannedField[] = [];

    for (const field of fields) {
      const tier1 = await resolveTier1(application.applywizz_id, field, profile);
      const tier2 = tier1 || await resolveTier2(application.applywizz_id, field, parsedResume);
      const tier3 = tier2 || await resolveTier3(application.applywizz_id, field, qaEntries);
      if (tier3) resolved.push(tier3);
      else pending.push(field);
    }

    console.log(
      `[Resolver] Worker ${workerId} resolving ${application.applywizz_id} ${application.id || application.job_url} ` +
      `(Tier 1-4 complete, ${pending.length} questions pending LLM) | ` +
      `${this.workerCount - 1} idle, 1 busy.`
    );

    if (pending.length > 0) {
      const group: UnresolvedFieldGroup = {
        applywizzId: application.applywizz_id,
        jobUrl: application.job_url,
        resumeText: parsedResume?.raw_text || '',
        jobDescription: `${application.job_title || 'Position'} at ${application.company_name || 'Company'}`,
        fields: pending,
      };
      const [batch] = await resolveBatchLlmFields([group]);
      resolved.push(...batch.fields.map((field) => ({
        ...field,
        fieldId: field.label,
        name: field.label,
        type: field.type as ResolvedField['type'],
        label: field.label,
        resolvedByTier: 5 as const,
      })));
    }

    const resolvedByKey = new Map(resolved.map((field) => [field.label, field]));
    const finalFields = fields.map((field) => resolvedByKey.get(field.label) || {
      fieldId: field.fieldId,
      name: field.name,
      type: field.type,
      label: field.label,
      value: '',
      source: 'unresolved' as const,
      resolvedByTier: null,
      confidence: 0,
    });

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
}

export default ResolverWorkerPool;
