/**
 * @fileoverview Ashby job form scanner using the Playwright DOM.
 */

import type { ScannedField, ScannedJobTemplate } from '../types/index.js';
import { browserManager } from '../submitter/browserManager.js';

/**
 * Scans an Ashby job form directly from the browser DOM.
 * Targets [data-field-path] elements, extracting labels, required status, and field types.
 */
export async function scanAshbyDom(url: string): Promise<ScannedJobTemplate> {
  const applicationUrl = url.includes('/application') ? url : `${url.replace(/\/+$/, '')}/application`;

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
 * Scans a single Ashby job URL using Playwright DOM inspection.
 */
export async function scanAshbyJob(url: string): Promise<ScannedJobTemplate> {
  return scanAshbyDom(url);
}
