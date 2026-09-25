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
  return fields.map((f) => {
    const isBool = /\b(do you|are you|have you|will you|can you|would you|is your|were you|did you)\b/i.test(f.label || '');
    const options = (Array.isArray(f.options) && f.options.length > 0)
      ? f.options
      : ((f.type === 'select' || f.type === 'radio') && isBool ? ['Yes', 'No'] : undefined);
    return {
      fieldId: f.fieldId,
      name: f.name,
      type: f.type,
      label: f.label,
      value: '',
      source: 'unresolved',
      resolvedByTier: null,
      confidence: 0,
      isRequired: Boolean(f.isRequired),
      ...(options ? { options } : {}),
    };
  });
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
 * When resolved_fields exists, enrich any choice fields with missing/empty options from the template schema.
 */
export async function hydrateApplicationResolvedFields(
  app: ApplicationRow
): Promise<HydrateResolvedFieldsResult> {
  const existing = app.resolved_fields;
  const template = await findTemplateByJobUrl(app.job_url);
  const schema = template?.fields_schema;

  if (Array.isArray(existing) && existing.length > 0) {
    let enriched = false;
    const schemaMap = new Map<string, ScannedField>();
    if (Array.isArray(schema)) {
      for (const sf of schema as ScannedField[]) {
        if (sf.fieldId) schemaMap.set(sf.fieldId, sf);
        if (sf.name) schemaMap.set(sf.name, sf);
      }
    }

    const updatedFields = existing.map((f: ResolvedField) => {
      const fieldType = String(f.type || '').toLowerCase();
      const needsOptions =
        (fieldType === 'select' || fieldType === 'radio' || fieldType === 'checkbox') &&
        (!Array.isArray(f.options) || f.options.length === 0);
      if (needsOptions) {
        const schemaField = schemaMap.get(f.fieldId) || schemaMap.get(f.name);
        const isBool = /\b(do you|are you|have you|will you|can you|would you|is your|were you|did you)\b/i.test(
          f.label || ''
        );
        const options =
          schemaField && Array.isArray(schemaField.options) && schemaField.options.length > 0
            ? schemaField.options
            : isBool
            ? ['Yes', 'No']
            : undefined;
        if (options && options.length > 0) {
          enriched = true;
          return { ...f, options };
        }
      }
      return f;
    });

    if (enriched) {
      log.info(`[Hydrate] Enriched options for existing resolved_fields on ${app.id || app.applywizz_id}`);
      return {
        application: {
          ...app,
          resolved_fields: updatedFields,
        },
        hydratedFromTemplate: true,
        templateFieldCount: updatedFields.length,
        templateJobUrl: template?.job_url,
      };
    }

    return {
      application: app,
      hydratedFromTemplate: false,
      templateFieldCount: 0,
    };
  }

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
