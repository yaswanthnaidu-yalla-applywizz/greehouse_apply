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
import { browserManager } from '../submitter/browserManager.js';

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
 * Scans an Ashby job form directly from the browser DOM.
 * Targets [data-field-path] elements, extracting labels, required status, and field types.
 */
export async function scanAshbyDom(url: string): Promise<ScannedJobTemplate> {
  const applicationUrl = url.includes('/application') ? url : `${url.replace(/\/+$/, '')}/application`;
  log.info(`[AshbyScanner] Opening DOM scanner for ${applicationUrl}...`);

  const managed = await browserManager.acquireBrowser({ headless: true });
  let page = null;

  try {
    const context = await managed.browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    });
    page = await context.newPage();
    await page.goto(applicationUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForSelector('[data-field-path]', { timeout: 15000 }).catch(() => {});

    const title = (await page.title()) || 'Ashby Opportunity';
    let companyName = '';
    let jobTitle = title;
    if (title.includes('@')) {
      const parts = title.split('@');
      jobTitle = parts[0].trim();
      companyName = parts[1].trim();
    }

    const rawFields = await page.evaluate(() => {
      const entries = Array.from(document.querySelectorAll('[data-field-path]'));
      return entries.map((container) => {
        const fieldPath = container.getAttribute('data-field-path') || '';
        const labelEl = container.querySelector('label, legend');
        let labelText = labelEl ? (labelEl as HTMLElement).innerText.trim().replace(/\s*\*\s*$/, '') : '';
        const isRequired = !!(
          container.querySelector('[class*="_required_"]') ||
          container.querySelector('[aria-required="true"]') ||
          (labelEl && (labelEl as HTMLElement).innerText.includes('*'))
        );

        let type = 'text';
        let options: string[] = [];

        if (container.querySelector('input[type="file"]') || fieldPath.includes('resume')) {
          type = 'file';
        } else if (container.querySelector('.ashby-application-form-input-yesno, button[data-option="yes"]')) {
          type = 'select';
          options = ['Yes', 'No'];
        } else if (container.querySelector('input[type="radio"]')) {
          type = 'radio';
          const radios = Array.from(container.querySelectorAll('input[type="radio"], [role="radio"]'));
          options = radios
            .map((r) => {
              const lbl = r.closest('label') || container.querySelector(`label[for="${r.id}"]`);
              return lbl
                ? (lbl as HTMLElement).innerText.trim()
                : r.getAttribute('aria-label') || (r as HTMLInputElement).value || '';
            })
            .filter(Boolean);
        } else if (container.querySelector('input[type="checkbox"]')) {
          const cbs = Array.from(container.querySelectorAll('input[type="checkbox"]'));
          if (cbs.length > 1) {
            type = 'checkbox';
            options = cbs
              .map((c) => {
                const lbl = c.closest('label') || container.querySelector(`label[for="${c.id}"]`);
                return lbl
                  ? (lbl as HTMLElement).innerText.trim()
                  : c.getAttribute('aria-label') || (c as HTMLInputElement).value || '';
              })
              .filter(Boolean);
          } else {
            type = 'checkbox';
            options = ['true'];
          }
        } else if (container.querySelector('select, [role="combobox"]')) {
          type = 'select';
          const selectEl = container.querySelector('select');
          if (selectEl) {
            options = Array.from(selectEl.options)
              .map((o) => o.text.trim())
              .filter(Boolean);
          }
        } else if (container.querySelector('textarea')) {
          type = 'textarea';
        }

        return { fieldPath, labelText, isRequired, type, options };
      });
    });

    const scannedFields: ScannedField[] = rawFields.map((f) => ({
      fieldId: f.fieldPath,
      name: f.fieldPath,
      label: f.labelText || f.fieldPath,
      type: f.type as any,
      isRequired: f.isRequired,
      options: f.options.length > 0 ? f.options : undefined,
    }));

    return {
      jobUrl: url,
      companyName: companyName || 'Company',
      jobTitle,
      fields: scannedFields,
      scannedAt: new Date().toISOString(),
      isExpired: false,
    };
  } finally {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
    await browserManager.releaseBrowser(managed.browserId).catch(() => {});
  }
}

/**
 * Scans a single Ashby job URL.
 * Attempts Ashby JSON API for jobs.ashbyhq.com links.
 * Automatically falls back to DOM scanning via Playwright.
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
      log.warn(`[AshbyScanner] API scan failed for ${url}: ${err.message}. Falling back to DOM scanner...`);
    }
  }

  // Fall back to DOM scan
  try {
    return await scanAshbyDom(url);
  } catch (domErr: any) {
    log.warn(`[AshbyScanner] Dedicated DOM scan failed for ${url}: ${domErr.message}. Checking fallback scanner...`);
    if (fallbackScanner) {
      const templates = await fallbackScanner.scanUniqueUrls([url]);
      const template = templates && templates.length > 0 ? templates[0] : null;
      if (template && template.fields.length > 0) {
        return template;
      }
    }
    throw domErr;
  }
}
