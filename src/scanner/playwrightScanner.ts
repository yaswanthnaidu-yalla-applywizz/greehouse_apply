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
import { getUnmappedVisibleFields, extractVisibleFormFields } from '../submitter/cascadeDetector.js';
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
  if (
    lowerName.includes('first_name') ||
    lowerName.includes('firstname') ||
    lowerName.includes('given_name') ||
    lowerId.includes('first_name') ||
    lowerId.includes('firstname') ||
    lowerLabel.includes('first name') ||
    lowerLabel.includes('firstname') ||
    lowerLabel.includes('given name')
  ) return 'first_name';

  if (
    lowerName.includes('last_name') ||
    lowerName.includes('lastname') ||
    lowerName.includes('family_name') ||
    lowerId.includes('last_name') ||
    lowerId.includes('lastname') ||
    lowerLabel.includes('last name') ||
    lowerLabel.includes('lastname') ||
    lowerLabel.includes('family name') ||
    lowerLabel.includes('surname')
  ) return 'last_name';

  if (lowerName.includes('email') || lowerId.includes('email') || lowerLabel.includes('email')) return 'email';
  if (lowerName.includes('phone') || lowerId.includes('phone') || lowerLabel.includes('phone') || lowerLabel.includes('mobile')) return 'phone';
  if (lowerName.includes('resume') || lowerId === 'resume' || lowerLabel.includes('resume')) return 'resume';
  if (lowerName.includes('cover_letter') || lowerId === 'cover_letter' || lowerLabel.includes('cover letter')) return 'cover_letter';
  if (lowerName.includes('linkedin') || lowerId.includes('linkedin') || lowerLabel.includes('linkedin')) return 'linkedin_url';
  if (lowerName.includes('website') || lowerId.includes('website') || lowerName.includes('portfolio') || lowerLabel.includes('website') || lowerLabel.includes('portfolio')) return 'website_url';
  if (lowerName.includes('country') || lowerId.includes('country') || lowerLabel.includes('country')) return 'country';
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
          '--disable-gpu',
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
          template.fields = await this.exploreCascadingFields(page, fields);
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

      // Strategy 2: Deep DOM Inspection (Authoritative for boards.greenhouse.io, embed iframes, custom boards)
      const domFields = await extractVisibleFormFields(page);

      if (domFields.length > 0) {
        template.fields = await this.exploreCascadingFields(page, domFields);
      } else {
        template.isExpired = true;
      }

      return template;
    } catch (error: any) {
      console.warn(`[Playwright Scanner] ⚠️ Error scanning ${url}: ${error.message}`);
      template.isExpired = true;
      return template;
    }
  }

  /**
   * Explores conditional cascading fields in the DOM by testing candidate option values
   * on select dropdowns, radio groups, and checkbox toggles.
   */
  private async exploreCascadingFields(
    page: Page,
    baseFields: ScannedField[]
  ): Promise<ScannedField[]> {
    const allFields = [...baseFields];
    const knownFieldIds = new Set(baseFields.map((f) => f.fieldId));
    const knownNames = new Set(baseFields.map((f) => f.name).filter(Boolean));

    // Identify candidate choice fields that might trigger cascading DOM updates
    const choiceFields = baseFields.filter(
      (f) =>
        (f.type === 'select' || f.type === 'radio' || f.type === 'checkbox') &&
        ((f.options && f.options.length > 0) || f.type === 'checkbox')
    );

    // Limit exploration to avoid anti-bot delays (max 6 candidate fields per form)
    const fieldsToTest = choiceFields.slice(0, 6);

    for (const parentField of fieldsToTest) {
      // Determine values to test
      let optionsToTest: string[] = [];
      if (parentField.type === 'checkbox') {
        optionsToTest = ['true'];
      } else if (parentField.options && parentField.options.length > 0) {
        // Prioritize common conditional trigger options like "No", "Yes", "Other", "Decline"
        const priorityTokens = ['no', 'yes', 'other', 'decline', 'male', 'female'];
        const foundPriority = parentField.options.filter((opt) =>
          priorityTokens.some((pt) => opt.toLowerCase() === pt)
        );
        const rest = parentField.options.filter((opt) => !foundPriority.includes(opt));
        optionsToTest = [...foundPriority, ...rest].slice(0, 3);
      }

      for (const optVal of optionsToTest) {
        try {
          // Select or toggle the option value in the active DOM
          if (parentField.type === 'select') {
            const selSelectors = [
              parentField.metadata?.selector,
              `select#${parentField.name}`,
              `select#${parentField.fieldId}`,
              `#${parentField.name}`,
              `#${parentField.fieldId}`,
              `input[id*="${parentField.name}"]`,
              `input[id*="${parentField.fieldId}"]`,
            ].filter(Boolean) as string[];

            for (const sel of selSelectors) {
              const loc = page.locator(sel).first();
              if ((await loc.count()) > 0) {
                const tagName = await loc.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => 'SELECT');
                if (tagName === 'SELECT') {
                  await loc.selectOption({ label: optVal }, { timeout: 1500 }).catch(() => {});
                } else {
                  // React-Select combobox
                  await loc.click({ timeout: 1500 }).catch(() => {});
                  await page.waitForTimeout(100);
                  await loc.pressSequentially(optVal, { delay: 25 }).catch(() => {});
                  await page.waitForTimeout(200);
                  const optLoc = page.locator('.select__option, [id*="-option"]').filter({ hasText: optVal }).first();
                  if ((await optLoc.count()) > 0) {
                    await optLoc.click({ timeout: 1500 }).catch(() => {});
                  }
                }
                break;
              }
            }
          } else if (parentField.type === 'radio') {
            const radioByVal = page
              .locator(
                `input[type="radio"][name="${parentField.name}"][value="${optVal}"], input[type="radio"][name="${parentField.fieldId}"][value="${optVal}"]`
              )
              .first();

            if ((await radioByVal.count()) > 0) {
              await radioByVal.check({ force: true }).catch(() => {});
            } else {
              const labelLoc = page.locator('label').filter({ hasText: optVal }).first();
              if ((await labelLoc.count()) > 0) {
                const innerRadio = labelLoc.locator('input[type="radio"]').first();
                if ((await innerRadio.count()) > 0) {
                  await innerRadio.check({ force: true }).catch(() => {});
                } else {
                  await labelLoc.click({ force: true }).catch(() => {});
                }
              }
            }
          } else if (parentField.type === 'checkbox') {
            const cb = page.locator(parentField.metadata?.selector || `input[type="checkbox"]#${parentField.fieldId}`).first();
            if ((await cb.count()) > 0) {
              await cb.check({ force: true }).catch(() => {});
            }
          }

          // Wait 500ms for DOM mutations
          await page.waitForTimeout(500);

          // Check for newly visible form fields
          const newlyVisible = await getUnmappedVisibleFields(page, knownFieldIds, knownNames);

          for (const newField of newlyVisible) {
            knownFieldIds.add(newField.fieldId);
            if (newField.name) knownNames.add(newField.name);

            newField.metadata = {
              ...(newField.metadata || {}),
              dependsOn: parentField.fieldId,
              triggerValue: optVal,
            };

            allFields.push(newField);
            console.log(
              `[Playwright Scanner] 🔗 Detected cascading field "${newField.label}" (${newField.fieldId}) triggered by ${parentField.fieldId} = "${optVal}"`
            );
          }
        } catch {
          // Continue exploration resiliently
        }
      }
    }

    return allFields;
  }
}
