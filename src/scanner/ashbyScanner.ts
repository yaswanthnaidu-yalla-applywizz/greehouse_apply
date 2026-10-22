/**
 * @fileoverview Ashby Job Form Scanner via Ashby Public JSON API.
 *
 * Calls Ashby's public API for form schema, falling back to PlaywrightScanner
 * for custom-domain job links.
 */

import axios from 'axios';
import { extractAshbyJobIds } from './atsDetector.js';
import type { PlaywrightScanner } from './playwrightScanner.js';
import type { ScannedField, ScannedFieldType, ScannedJobTemplate } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AshbyScanner');

export interface AshbyApiSelectableValue {
  label?: string;
  value?: string;
}

export interface AshbyApiField {
  path: string;
  title?: string;
  type?: string;
  isRequired?: boolean;
  selectableValues?: AshbyApiSelectableValue[];
  description?: string;
}

export interface AshbyApiResponse {
  applicationForm: {
    sections?: Array<{
      fields?: AshbyApiField[];
      title?: string;
    }>;
    fields?: AshbyApiField[];
  };
  jobPosting?: {
    title?: string;
    companyName?: string;
  };
}

/**
 * Validates and unwraps the Ashby API response payload.
 */
export function validateAshbyApiResponse(data: unknown): AshbyApiResponse {
  if (!data || typeof data !== 'object' || !('applicationForm' in data)) {
    throw new Error('Ashby API response invalid: missing applicationForm payload');
  }
  return data as AshbyApiResponse;
}

/**
 * Maps an Ashby API field descriptor to the system's canonical ScannedField shape.
 */
export function mapAshbyFieldToScannedField(field: AshbyApiField): ScannedField {
  const rawType = (field.type || 'ShortText').toLowerCase();
  let type: ScannedFieldType = 'text';

  if (rawType.includes('select')) {
    type = 'select';
  } else if (rawType.includes('boolean')) {
    type = 'checkbox';
  } else if (rawType.includes('file')) {
    type = 'file';
  } else if (rawType.includes('date')) {
    type = 'date';
  } else if (rawType.includes('longtext') || rawType.includes('textarea')) {
    type = 'textarea';
  } else if (rawType.includes('location')) {
    type = 'location_autocomplete';
  }

  const options: string[] = [];
  if (Array.isArray(field.selectableValues)) {
    for (const opt of field.selectableValues) {
      const label = (opt.label || opt.value || '').trim();
      if (label && !options.includes(label)) {
        options.push(label);
      }
    }
  }

  const label = (field.title || field.path).replace(/\*+$/, '').trim();

  return {
    fieldId: field.path,
    name: field.path,
    type,
    label,
    isRequired: Boolean(field.isRequired),
    options: options.length > 0 ? options : undefined,
    optionsComplete: options.length > 0,
    metadata: {
      section: undefined,
    },
  };
}

/**
 * Scans a single Ashby job URL.
 * Uses Ashby JSON API for jobs.ashbyhq.com links.
 * Falls back to PlaywrightScanner for custom domains.
 */
export async function scanAshbyJob(
  url: string,
  fallbackScanner?: PlaywrightScanner
): Promise<ScannedJobTemplate> {
  const ids = extractAshbyJobIds(url);

  if (ids) {
    const apiUrl = `https://api.ashbyhq.com/applicationForm.info?jobPostingId=${encodeURIComponent(ids.jobPostingId)}&organizationHostedJobsPageName=${encodeURIComponent(ids.orgSlug)}`;
    log.info(`[AshbyScanner] Fetching API schema for ${ids.orgSlug}/${ids.jobPostingId}...`);

    try {
      const response = await axios.get(apiUrl, { timeout: 15000 });
      const validated = validateAshbyApiResponse(response.data);

      const rawFields: AshbyApiField[] = [];
      if (Array.isArray(validated.applicationForm.sections)) {
        for (const sec of validated.applicationForm.sections) {
          if (Array.isArray(sec.fields)) {
            rawFields.push(...sec.fields);
          }
        }
      }
      if (Array.isArray(validated.applicationForm.fields)) {
        rawFields.push(...validated.applicationForm.fields);
      }

      const scannedFields = rawFields
        .filter((f) => f && f.path)
        .map(mapAshbyFieldToScannedField);

      return {
        jobUrl: url,
        companyName: validated.jobPosting?.companyName || ids.orgSlug,
        jobTitle: validated.jobPosting?.title || 'Ashby Opportunity',
        fields: scannedFields,
        scannedAt: new Date().toISOString(),
        isExpired: false,
      };
    } catch (err: any) {
      log.warn(`[AshbyScanner] API scan failed for ${url}: ${err.message}. Attempting fallback if available...`);
      if (!fallbackScanner) {
        throw new Error(`Ashby API scan failed and no fallback scanner provided: ${err.message}`);
      }
    }
  }

  // Custom-domain Ashby URL or API fallback
  if (fallbackScanner) {
    log.info(`[AshbyScanner] Executing Playwright DOM fallback scan for ${url}...`);
    const template = await fallbackScanner.scanSingleUrl(url);
    if (!template || template.fields.length === 0) {
      throw new Error(`DOM fallback scan returned 0 fields for Ashby URL: ${url}`);
    }
    return template;
  }

  throw new Error(`Could not scan Ashby URL (no slug extracted and no DOM fallback): ${url}`);
}
