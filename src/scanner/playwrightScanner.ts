/**
 * @fileoverview Playwright Headless Scanner for Greenhouse Job Postings.
 *
 * Implements Branch 1 parallel DOM inspection across unique Greenhouse URLs, extracting
 * job titles, company names, standard and custom form inputs, select options, radio button groups,
 * and detecting expired / 404 job postings.
 *
 * Supports modern Remix-based Greenhouse job boards (via state extraction), classic Greenhouse
 * boards (`boards.greenhouse.io`), iframe embeds (`app.greenhouse.io/embed/job_app`), and custom domains.
 *
 * References:
 * - 02-trd.md (Section 3.2)
 * - 03-workflow.md (Step 2)
 * - 05-backend-schema.md (Section 1.2)
 */

import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../config/env.js';
import type {
  ScannedField,
  ScannedFieldType,
  ScannedJobTemplate,
} from '../types/index.js';

/**
 * Configuration options for initializing the PlaywrightScanner.
 */
export interface PlaywrightScannerOptions {
  /**
   * Number of parallel browser workers.
   * @default config.WORKER_POOL_SIZE (4)
   */
  workerPoolSize?: number;

  /**
   * Navigation and interaction timeout in milliseconds.
   * @default config.PLAYWRIGHT_TIMEOUT (30000)
   */
  timeoutMs?: number;

  /**
   * Minimum randomized delay in milliseconds between consecutive navigations per worker.
   * @default config.SCANNER_JITTER_MIN_MS (3000)
   */
  minJitterMs?: number;

  /**
   * Maximum randomized delay in milliseconds between consecutive navigations per worker.
   * @default config.SCANNER_JITTER_MAX_MS (6000)
   */
  maxJitterMs?: number;

  /**
   * Whether to launch the browser in headless mode.
   * @default true
   */
  headless?: boolean;

  /**
   * Optional progress callback invoked as URLs finish scanning.
   */
  onJobScanned?: (job: ScannedJobTemplate, index: number, total: number) => void;
}

/**
 * Known phrase patterns indicating an expired, closed, or removed Greenhouse job posting.
 */
const EXPIRED_PATTERNS = [
  /no longer available/i,
  /position has been filled/i,
  /job (?:not found|is closed|has ended)/i,
  /application(?:s)? (?:are )?closed/i,
  /the job you are looking for is closed/i,
  /page you were looking for doesn't exist/i,
  /404 - not found/i,
  /this posting is no longer active/i,
];

/**
 * Utility to generate a randomized delay within [min, max] range.
 *
 * @param minMs - Minimum delay in milliseconds.
 * @param maxMs - Maximum delay in milliseconds.
 * @returns Promise that resolves after the jitter period.
 */
function sleepRandomJitter(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Normalizes label text by trimming whitespace, stripping trailing asterisks,
 * and removing required/optional annotations.
 *
 * @param label - The raw label string from DOM.
 * @returns Sanitized human-readable label.
 */
function sanitizeLabelText(label: string): string {
  if (!label) return '';
  return label
    .replace(/\s*\*\s*$/, '')
    .replace(/\s*\((?:required|optional)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generates a normalized field identifier from label, name, or DOM id.
 *
 * @param name - Element HTML name attribute.
 * @param id - Element HTML id attribute.
 * @param label - Sanitized human-readable label.
 * @returns Normalized slug fieldId.
 */
function generateFieldId(name: string, id: string, label: string): string {
  const lowerName = (name || '').toLowerCase();
  const lowerId = (id || '').toLowerCase();
  const lowerLabel = (label || '').toLowerCase();

  // Standard field mappings
  if (lowerName.includes('first_name') || lowerId === 'first_name' || lowerLabel === 'first name') return 'first_name';
  if (lowerName.includes('last_name') || lowerId === 'last_name' || lowerLabel === 'last name') return 'last_name';
  if (lowerName.includes('email') || lowerId === 'email' || lowerLabel === 'email') return 'email';
  if (lowerName.includes('phone') || lowerId === 'phone' || lowerLabel === 'phone') return 'phone';
  if (lowerName.includes('resume') || lowerId === 'resume' || lowerLabel.includes('resume')) return 'resume';
  if (lowerName.includes('cover_letter') || lowerId === 'cover_letter' || lowerLabel.includes('cover letter')) return 'cover_letter';
  if (lowerName.includes('linkedin') || lowerId.includes('linkedin') || lowerLabel.includes('linkedin')) return 'linkedin_url';
  if (lowerName.includes('website') || lowerId.includes('website') || lowerName.includes('portfolio') || lowerLabel.includes('website') || lowerLabel.includes('portfolio')) return 'website_url';
  if (lowerName.includes('location') || lowerId.includes('location') || lowerLabel.includes('location')) return 'location';

  // Slugify label if available
  if (label) {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    if (slug) return slug;
  }

  // Fallback to name or id
  const fallback = (name || id || 'custom_field')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return fallback || 'custom_field';
}

/**
 * PlaywrightScanner manages a pool of headless Chromium workers to inspect
 * unique Greenhouse job postings and extract form structures.
 */
export class PlaywrightScanner {
  private readonly workerPoolSize: number;
  private readonly timeoutMs: number;
  private readonly minJitterMs: number;
  private readonly maxJitterMs: number;
  private readonly headless: boolean;
  private readonly onJobScanned?: (job: ScannedJobTemplate, index: number, total: number) => void;

  /**
   * Initializes the scanner with runtime options.
   *
   * @param options - Configuration overrides for worker pool, timeout, and jitter.
   */
  constructor(options: PlaywrightScannerOptions = {}) {
    this.workerPoolSize = options.workerPoolSize ?? config.WORKER_POOL_SIZE;
    this.timeoutMs = options.timeoutMs ?? config.PLAYWRIGHT_TIMEOUT;
    this.minJitterMs = options.minJitterMs ?? config.SCANNER_JITTER_MIN_MS;
    this.maxJitterMs = options.maxJitterMs ?? config.SCANNER_JITTER_MAX_MS;
    this.headless = options.headless ?? true;
    this.onJobScanned = options.onJobScanned;
  }

  /**
   * Scans an array of unique Greenhouse job URLs concurrently across the worker pool.
   *
   * @param urls - Array of unique canonical Greenhouse job URLs.
   * @returns Promise resolving to an array of ScannedJobTemplate objects.
   */
  public async scanUniqueUrls(urls: string[]): Promise<ScannedJobTemplate[]> {
    if (!urls || urls.length === 0) {
      console.log('[Playwright Scanner] ⚠️ No URLs provided for scanning.');
      return [];
    }

    const total = urls.length;
    console.log(
      `[Playwright Scanner] 🚀 Launching scanner pool: ${this.workerPoolSize} workers for ${total.toLocaleString()} unique URLs (Timeout: ${this.timeoutMs}ms, Jitter: ${this.minJitterMs}-${this.maxJitterMs}ms)...`
    );

    const results: ScannedJobTemplate[] = new Array(total);
    let currentIndex = 0;
    let completedCount = 0;

    let browser: Browser | null = null;

    try {
      browser = await chromium.launch({
        headless: this.headless,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      });

      const workerTasks: Promise<void>[] = [];
      const poolSize = Math.min(this.workerPoolSize, total);

      for (let workerId = 0; workerId < poolSize; workerId++) {
        const task = (async () => {
          if (!browser) return;
          const context = await browser.newContext({
            userAgent:
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
          });

          const page = await context.newPage();

          try {
            while (true) {
              const jobIndex = currentIndex++;
              if (jobIndex >= total) {
                break;
              }

              const targetUrl = urls[jobIndex];
              const template = await this.scanSingleUrl(targetUrl, page);
              results[jobIndex] = template;
              completedCount++;

              if (this.onJobScanned) {
                this.onJobScanned(template, completedCount, total);
              }

              const statusIcon = template.isExpired ? '❌ [Expired/404]' : `✅ [${template.fields.length} fields]`;
              console.log(
                `[Playwright Scanner] [${completedCount}/${total}] ${statusIcon} ${template.companyName ? `${template.companyName} — ` : ''}${template.jobTitle || 'Job'} (${targetUrl})`
              );

              // Apply jitter before next URL on this worker
              if (jobIndex + 1 < total && this.maxJitterMs > 0) {
                await sleepRandomJitter(this.minJitterMs, this.maxJitterMs);
              }
            }
          } finally {
            await page.close().catch(() => {});
            await context.close().catch(() => {});
          }
        })();

        workerTasks.push(task);
      }

      await Promise.all(workerTasks);
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }

    console.log(`[Playwright Scanner] 🏁 Finished scanning ${completedCount}/${total} URLs.`);
    return results.filter(Boolean);
  }

  /**
   * Scans a single Greenhouse job URL using an existing Playwright Page.
   *
   * @param url - Canonical Greenhouse job URL.
   * @param page - Active Playwright Page instance.
   * @returns ScannedJobTemplate representing the parsed form structure or expired state.
   */
  public async scanSingleUrl(url: string, page: Page): Promise<ScannedJobTemplate> {
    const scannedAt = new Date().toISOString();

    // Default template state
    const template: ScannedJobTemplate = {
      jobUrl: url,
      companyName: '',
      jobTitle: '',
      fields: [],
      scannedAt,
      isExpired: false,
    };

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.timeoutMs,
      });

      // Check HTTP error status
      const httpStatus = response ? response.status() : 200;
      if (httpStatus >= 400) {
        template.isExpired = true;
        return template;
      }

      // Check if redirected to generic index page without job path
      const currentUrl = page.url();
      if (!currentUrl.includes('/jobs/') && !currentUrl.includes('/embed/job_app') && !currentUrl.includes('job_app')) {
        const formCheck = await page.$('form#application_form, form#app_form, form');
        if (!formCheck) {
          template.isExpired = true;
          return template;
        }
      }

      // Extract text content for closed / expired keyword detection
      const pageText: string =
        (await page.evaluate<string>(`
          (() => {
            if (typeof window.__name === 'undefined') window.__name = function(fn) { return fn; };
            return document.body ? document.body.innerText : '';
          })()
        `)) || '';

      for (const pattern of EXPIRED_PATTERNS) {
        if (pattern.test(pageText) && !pageText.includes('Submit Application')) {
          template.isExpired = true;
          return template;
        }
      }

      // Strategy 1: Modern Remix/React State Extraction (Authoritative for job-boards.greenhouse.io)
      const remixState: any = await page.evaluate(`
        (() => {
          if (typeof window.__name === 'undefined') window.__name = function(fn) { return fn; };
          var ctx = window.__remixContext;
          if (!ctx || !ctx.state || !ctx.state.loaderData) return null;
          var loaderData = ctx.state.loaderData;
          for (var k in loaderData) {
            if (loaderData[k] && loaderData[k].jobPost) {
              return loaderData[k].jobPost;
            }
          }
          return null;
        })()
      `);

      if (remixState) {
        template.jobTitle = remixState.title || '';
        template.companyName = remixState.company_name || remixState.organization_name || '';

        const fields: ScannedField[] = [];

        // 1. Standard & Custom Questions
        if (Array.isArray(remixState.questions)) {
          for (const q of remixState.questions) {
            const rawLabel = q.label || '';
            const isReq = !!q.required;

            for (const f of q.fields || []) {
              const name = f.name || '';
              // Avoid duplicate resume_text / cover_letter_text when file upload exists
              if (name.endsWith('_text') && fields.some((existing) => existing.name === name.replace('_text', ''))) {
                continue;
              }

              let fieldType: ScannedFieldType = 'text';
              let options: string[] | undefined;

              if (f.type === 'input_file' || f.type === 'file') {
                fieldType = 'file';
              } else if (f.type === 'textarea') {
                fieldType = 'textarea';
              } else if (
                f.type === 'multi_value_single_select' ||
                f.type === 'single_select' ||
                f.type === 'select' ||
                f.type === 'multi_value_multi_select'
              ) {
                fieldType = 'select';
                if (Array.isArray(f.values)) {
                  options = f.values.map((v: any) => (typeof v === 'string' ? v : v.label || String(v.value))).filter(Boolean);
                }
              } else if (f.type === 'radio') {
                fieldType = 'radio';
                if (Array.isArray(f.values)) {
                  options = f.values.map((v: any) => (typeof v === 'string' ? v : v.label || String(v.value))).filter(Boolean);
                }
              } else if (f.type === 'checkbox') {
                fieldType = 'checkbox';
              } else if (name.includes('location') || rawLabel.toLowerCase().includes('location')) {
                fieldType = 'location_autocomplete';
              }

              const fieldId = generateFieldId(name, '', rawLabel);
              fields.push({
                fieldId,
                name,
                type: fieldType,
                label: sanitizeLabelText(rawLabel) || fieldId,
                isRequired: isReq,
                options,
                metadata: {
                  selector: `#${name}`,
                },
              });
            }
          }
        }

        // 2. Demographic / EEOC Sections
        if (Array.isArray(remixState.eeoc_sections)) {
          for (const section of remixState.eeoc_sections) {
            const sectionName = section.title || 'Voluntary Self-Identification';
            if (Array.isArray(section.questions)) {
              for (const q of section.questions) {
                const rawLabel = q.label || '';
                const isReq = !!q.required;

                for (const f of q.fields || []) {
                  const name = f.name || '';
                  let fieldType: ScannedFieldType = 'select';
                  let options: string[] | undefined;

                  if (Array.isArray(f.values)) {
                    options = f.values.map((v: any) => (typeof v === 'string' ? v : v.label || String(v.value))).filter(Boolean);
                  }

                  const fieldId = generateFieldId(name, '', rawLabel);
                  fields.push({
                    fieldId,
                    name,
                    type: fieldType,
                    label: sanitizeLabelText(rawLabel) || fieldId,
                    isRequired: isReq,
                    options,
                    metadata: {
                      section: sectionName,
                      selector: `#${name}`,
                    },
                  });
                }
              }
            }
          }
        }

        if (fields.length > 0) {
          template.fields = fields;
          return template;
        }
      }

      // Strategy 2: Deep DOM Inspection (Authoritative for boards.greenhouse.io, embed iframes, custom boards)
      const pageMeta: any = await page.evaluate(`
        (() => {
          if (typeof window.__name === 'undefined') window.__name = function(fn) { return fn; };
          var titleTag = document.title || '';
          var h1El = document.querySelector('h1.app-title, h1[data-testid="job-title"], h1, .job-title');
          var h1Text = h1El && h1El.textContent ? h1El.textContent.trim() : '';

          var compEl = document.querySelector('.company-name, [data-testid="company-name"], [class*="companyName"], [class*="company_name"], .app-title span');
          var companyElText = compEl && compEl.textContent ? compEl.textContent.trim() : '';

          var ogTitleMeta = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
          var ogTitle = ogTitleMeta ? ogTitleMeta.getAttribute('content') || '' : '';

          var ogSiteMeta = document.querySelector('meta[property="og:site_name"], meta[name="og:site_name"]');
          var ogSiteName = ogSiteMeta ? ogSiteMeta.getAttribute('content') || '' : '';

          return {
            titleTag: titleTag,
            h1Text: h1Text,
            companyElText: companyElText,
            ogTitle: ogTitle,
            ogSiteName: ogSiteName
          };
        })()
      `);

      if (!template.jobTitle) {
        template.jobTitle = pageMeta.h1Text || pageMeta.ogTitle;
        if (!template.jobTitle && pageMeta.titleTag) {
          const match = pageMeta.titleTag.match(/(?:Job Application for\s+)?(.+?)(?:\s+at\s+|$)/i);
          if (match && match[1]) {
            template.jobTitle = match[1].trim();
          } else {
            template.jobTitle = pageMeta.titleTag.split(' - ')[0].trim();
          }
        }
      }

      if (!template.companyName) {
        template.companyName = pageMeta.companyElText || pageMeta.ogSiteName;
        if (!template.companyName && pageMeta.titleTag) {
          const match = pageMeta.titleTag.match(/\sat\s+(.+)$/i);
          if (match && match[1]) {
            template.companyName = match[1].replace(/\s*-\s*Greenhouse$/i, '').trim();
          }
        }
      }

      if (!template.companyName) {
        try {
          const parsed = new URL(url);
          const segments = parsed.pathname.split('/').filter(Boolean);
          if (parsed.hostname.includes('job-boards.greenhouse.io') || parsed.hostname.includes('boards.greenhouse.io')) {
            if (segments.length > 0 && segments[0] !== 'embed') {
              template.companyName = segments[0].charAt(0).toUpperCase() + segments[0].slice(1);
            }
          }
        } catch {}
      }

      const extractedFields: any[] = await page.evaluate(`
        (() => {
          if (typeof window.__name === 'undefined') window.__name = function(fn) { return fn; };
          var fieldsList = [];
          var form = document.querySelector('form#application_form, form#app_form, form');
          if (!form) return fieldsList;

          var processedRadioNames = {};

          function clean(str) {
            if (!str) return '';
            return str.replace(/\\s*\\*\\s*$/, '').replace(/\\s*\\((?:required|optional)\\)\\s*$/i, '').replace(/\\s+/g, ' ').trim();
          }

          function getSection(el) {
            var sectionEl = el.closest('fieldset, section, .application-section, [class*="section"]');
            if (sectionEl) {
              var heading = sectionEl.querySelector('legend, h2, h3, h4, .section-header, [class*="header"]');
              if (heading && heading.textContent) return clean(heading.textContent);
            }
            return '';
          }

          var formElements = Array.from(form.querySelectorAll('input, select, textarea'));

          for (var i = 0; i < formElements.length; i++) {
            var el = formElements[i];
            var rawType = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
            if (rawType === 'hidden' || rawType === 'submit' || rawType === 'button' || rawType === 'reset') continue;

            var name = el.getAttribute('name') || '';
            var id = el.getAttribute('id') || '';

            // Ignore unnamed internal search/shadow inputs
            if (!name && !id) continue;

            var section = getSection(el);

            // 1. Radio Button Groups
            if (rawType === 'radio') {
              var groupName = name || id;
              if (!groupName || processedRadioNames[groupName]) continue;
              processedRadioNames[groupName] = true;

              var radioGroup = Array.from(form.querySelectorAll('input[type="radio"][name="' + CSS.escape(groupName) + '"]'));
              if (radioGroup.length === 0) continue;

              var firstRadio = radioGroup[0];
              var fieldset = firstRadio.closest('fieldset, .field, [class*="field"], tr, div');
              var groupLabel = '';
              if (fieldset) {
                var labelEl = fieldset.querySelector('legend, label, .field-label, [class*="label"]');
                if (labelEl && labelEl.textContent) groupLabel = clean(labelEl.textContent);
              }

              var options = [];
              for (var j = 0; j < radioGroup.length; j++) {
                var r = radioGroup[j];
                var rId = r.getAttribute('id');
                var labelFor = rId ? document.querySelector('label[for="' + CSS.escape(rId) + '"]') : null;
                var parentLabel = r.closest('label');
                var optText = clean((labelFor && labelFor.textContent) || (parentLabel && parentLabel.textContent) || r.getAttribute('value') || '');
                if (optText && options.indexOf(optText) === -1) options.push(optText);
              }

              var isReq = firstRadio.hasAttribute('required') ||
                          firstRadio.getAttribute('aria-required') === 'true' ||
                          (fieldset && fieldset.textContent && fieldset.textContent.indexOf('*') !== -1);

              fieldsList.push({
                name: groupName,
                id: firstRadio.getAttribute('id') || groupName,
                type: 'radio',
                label: groupLabel || groupName,
                isRequired: !!isReq,
                options: options,
                section: section,
                selector: 'input[type="radio"][name="' + groupName + '"]'
              });
              continue;
            }

            // 2. Select Dropdowns
            if (el.tagName.toLowerCase() === 'select') {
              var selectEl = el;
              var labelFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
              var parentLabel = el.closest('label');
              var fieldWrapper = el.closest('.field, [class*="field"]');
              var wrapperLabel = fieldWrapper ? fieldWrapper.querySelector('label, .field-label') : null;

              var rawLabel = (labelFor && labelFor.textContent) || (parentLabel && parentLabel.textContent) || (wrapperLabel && wrapperLabel.textContent) || el.getAttribute('aria-label') || name;
              var label = clean(rawLabel);

              var options = [];
              for (var k = 0; k < selectEl.options.length; k++) {
                var optText = selectEl.options[k].text ? selectEl.options[k].text.trim() : '';
                if (optText &&
                    optText.indexOf('--') !== 0 &&
                    optText.indexOf('Please select') !== 0 &&
                    optText.indexOf('Select...') !== 0) {
                  options.push(optText);
                }
              }

              var isReq = selectEl.required ||
                          selectEl.getAttribute('aria-required') === 'true' ||
                          (rawLabel && rawLabel.indexOf('*') !== -1);

              fieldsList.push({
                name: name || id,
                id: id,
                type: 'select',
                label: label || name || id,
                isRequired: !!isReq,
                options: options,
                section: section,
                selector: id ? '#' + id : 'select[name="' + name + '"]'
              });
              continue;
            }

            // 3. Text, Textarea, File, Checkbox, Location
            var labelFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
            var parentLabel = el.closest('label');
            var fieldWrapper = el.closest('.field, [class*="field"]');
            var wrapperLabel = fieldWrapper ? fieldWrapper.querySelector('label, .field-label') : null;

            var rawLabel = (labelFor && labelFor.textContent) ||
                           (parentLabel && parentLabel.textContent) ||
                           (wrapperLabel && wrapperLabel.textContent) ||
                           el.getAttribute('aria-label') ||
                           el.getAttribute('placeholder') ||
                           name ||
                           id;
            var label = clean(rawLabel);

            var detectedType = 'text';
            if (el.tagName.toLowerCase() === 'textarea') {
              detectedType = 'textarea';
            } else if (rawType === 'file') {
              detectedType = 'file';
            } else if (rawType === 'checkbox') {
              detectedType = 'checkbox';
            } else if (
              name.toLowerCase().indexOf('location') !== -1 ||
              id.toLowerCase().indexOf('location') !== -1 ||
              label.toLowerCase().indexOf('location') !== -1
            ) {
              detectedType = 'location_autocomplete';
            }

            var isReq = el.required ||
                        el.getAttribute('aria-required') === 'true' ||
                        (rawLabel && rawLabel.indexOf('*') !== -1);

            fieldsList.push({
              name: name || id,
              id: id,
              type: detectedType,
              label: label || name || id,
              isRequired: !!isReq,
              section: section,
              selector: id ? '#' + id : 'input[name="' + name + '"]'
            });
          }

          return fieldsList;
        })()
      `);

      template.fields = extractedFields.map((field) => {
        const fieldId = generateFieldId(field.name, field.id, field.label);
        const scannedField: ScannedField = {
          fieldId,
          name: field.name,
          type: field.type as ScannedFieldType,
          label: sanitizeLabelText(field.label) || fieldId,
          isRequired: field.isRequired,
        };

        if (field.options && field.options.length > 0) {
          scannedField.options = field.options;
        }

        if (field.section || field.selector) {
          scannedField.metadata = {
            section: field.section || undefined,
            selector: field.selector || undefined,
          };
        }

        return scannedField;
      });

      if (template.fields.length === 0) {
        template.isExpired = true;
      }

      return template;
    } catch (error: any) {
      console.warn(`[Playwright Scanner] ⚠️ Error scanning ${url}: ${error.message}`);
      template.isExpired = true;
      return template;
    }
  }
}
