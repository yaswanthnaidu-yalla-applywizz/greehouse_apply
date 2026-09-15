/**
 * Hydrates candidate_applications.resolved_fields from scanned_job_templates.fields_schema
 * when the application row exists but resolution never populated fields (common after segregator-only upsert).
 */

import type { ApplicationRow } from './applications.js';
import { findTemplateByJobUrl } from './templates.js';
import type { ResolvedField, ScannedField } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Application Field Hydration');

export function scannedFieldsToResolvedShells(fields: ScannedField[]): ResolvedField[] {
  return fields.map((f) => ({
    fieldId: f.fieldId,
    name: f.name,
    type: f.type,
    label: f.label,
    value: '',
    source: 'unresolved',
    resolvedByTier: null,
    confidence: 0,
  }));
}

export interface HydrateResolvedFieldsResult {
  application: ApplicationRow;
  /** True when fields_schema was copied into resolved_fields for the API response */
  hydratedFromTemplate: boolean;
  templateFieldCount: number;
  templateJobUrl?: string;
}

/**
 * When resolved_fields is empty, load fields_schema from scanned_job_templates (by job URL variants).
 */
export async function hydrateApplicationResolvedFields(
  app: ApplicationRow
): Promise<HydrateResolvedFieldsResult> {
  const existing = app.resolved_fields;
  if (Array.isArray(existing) && existing.length > 0) {
    return {
      application: app,
      hydratedFromTemplate: false,
      templateFieldCount: 0,
    };
  }

  const template = await findTemplateByJobUrl(app.job_url);
  const schema = template?.fields_schema;
  if (!template || !Array.isArray(schema) || schema.length === 0) {
    log.info(
      `[Hydrate] No fields_schema for job_url=${app.job_url} applywizz_id=${app.applywizz_id} ` +
        `(resolved_fields empty — scan/migrate templates or run resolve pipeline)`
    );
    return {
      application: app,
      hydratedFromTemplate: false,
      templateFieldCount: 0,
    };
  }

  const shells = scannedFieldsToResolvedShells(schema as ScannedField[]);
  log.info(
    `[Hydrate] fields_schema → resolved_fields applywizz_id=${app.applywizz_id} ` +
      `application_job_url=${app.job_url} template_job_url=${template.job_url} field_count=${shells.length}`
  );

  const nextStatus =
    template.is_expired && app.status === 'READY_FOR_REVIEW' ? ('EXPIRED' as const) : app.status;

  return {
    application: {
      ...app,
      resolved_fields: shells,
      company_name: app.company_name || template.company_name || null,
      job_title: app.job_title || template.job_title || null,
      status: nextStatus,
    },
    hydratedFromTemplate: true,
    templateFieldCount: shells.length,
    templateJobUrl: template.job_url,
  };
}
