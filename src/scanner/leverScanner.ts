/**
 * @fileoverview Lever ATS job posting and application form scanner using Playwright DOM.
 * Supports single-job scanning, REST API metadata enrichment, and concurrent worker-pool scanning.
 */

import type { Page } from 'playwright';
import { config } from '../config/env.js';
import type { ScannedField, ScannedFieldType, ScannedJobTemplate, JobPostingFacts } from '../types/index.js';
import { browserManager } from '../submitter/browserManager.js';
import { toLeverApplicationUrl, extractLeverJobIds } from './atsDetector.js';
import { generateFingerprint } from '../resolver/fingerprint.js';
import { createLogger } from '../utils/logger.js';
import { throwIfPipelineAborted } from '../orchestrator/pipelineAbort.js';
import type { FailureDiagnosticInput } from '../types/failureDiagnostics.js';
import { observeAtsVerification } from '../submitter/atsVerification.js';
import {
  AtsScanFailure,
  classifyAtsNavigationStatus,
  navigationFailure,
  extractAtsHostKey,
} from './atsScanFailure.js';

const log = createLogger('Lever Scanner');

class LeverNavigationError extends Error {
  constructor(error: unknown) {
    super(`Lever navigation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function navigateLever(page: Page, url: string, timeoutMs: number) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response) throw new Error('Navigation returned no response');
    return response;
  } catch (error) {
    throw new LeverNavigationError(error);
  }
}

function sleepRandomJitter(minMs: number, maxMs: number): Promise<void> {
  if (maxMs <= 0 || maxMs < minMs) return Promise.resolve();
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export interface LeverScannerOptions {
  workerPoolSize?: number;
  timeoutMs?: number;
  minJitterMs?: number;
  maxJitterMs?: number;
  headless?: boolean;
  onJobScanned?: (job: ScannedJobTemplate, index: number, total: number) => void;
  onScanFailed?: (url: string, index: number, total: number) => void;
  onFailureDiagnostic?: (input: FailureDiagnosticInput) => Promise<void>;
  onFatal?: (module: string, message: string, error?: unknown) => never;
}

interface LeverApiPosting {
  id?: string;
  text?: string;
  country?: string;
  workplaceType?: string;
  categories?: {
    commitment?: string;
    department?: string;
    location?: string;
    team?: string;
    allLocations?: string[];
  };
  descriptionPlain?: string;
}

async function fetchLeverPostingApi(company: string, jobId: string): Promise<LeverApiPosting | null> {
  try {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(jobId)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return null;
    return (await resp.json()) as LeverApiPosting;
  } catch {
    return null;
  }
}

/**
 * Extracts form fields and job metadata from a Lever application page.
 */
export async function extractLeverFieldsFromPage(
  page: Page,
  url: string,
  options?: { timeoutMs?: number; throwOnZeroFields?: boolean; skipNavigation?: boolean }
): Promise<ScannedJobTemplate> {
  const applicationUrl = toLeverApplicationUrl(url) || url;
  const timeoutMs = options?.timeoutMs ?? 45000;

  const ids = extractLeverJobIds(url);
  let apiData: LeverApiPosting | null = null;
  if (ids) {
    apiData = await fetchLeverPostingApi(ids.company, ids.jobId);
  }

  if (!options?.skipNavigation) {
    const response = await navigateLever(page, applicationUrl, timeoutMs);
    const httpStatus = response.status();
    const statusKind = classifyAtsNavigationStatus(httpStatus);
    if (statusKind === 'expired') {
      return {
        jobUrl: url,
        companyName: ids?.company || '',
        jobTitle: apiData?.text || '',
        fields: [],
        scannedAt: new Date().toISOString(),
        isExpired: true,
        ats: 'lever',
      };
    }
    if (statusKind !== 'ok' && statusKind !== 'blocked') {
      throw navigationFailure(httpStatus, await response.headerValue('retry-after').catch(() => null));
    }
    const verification = await observeAtsVerification(page, 'lever');
    if (verification.kind === 'interactive') {
      throw new AtsScanFailure('challenge', `Lever verification challenge detected (${verification.provider}/${verification.evidence})`);
    }
    if (verification.kind === 'widget_error') {
      throw new AtsScanFailure('blocked', `Lever verification widget error detected (${verification.provider})`);
    }
    if (statusKind === 'blocked') {
      throw navigationFailure(httpStatus, await response.headerValue('retry-after').catch(() => null));
    }
  }

  // Check for expired or closed posting signals
  const isExpired = await page.evaluate(() => {
    const text = document.body ? document.body.innerText.toLowerCase() : '';
    return (
      text.includes('no job postings currently open') ||
      text.includes('the position has been filled') ||
      text.includes('this job is no longer available') ||
      text.includes('not found – 404 error') ||
      document.title.toLowerCase().includes('404')
    );
  });

  if (isExpired) {
    return {
      jobUrl: url,
      companyName: ids?.company || '',
      jobTitle: apiData?.text || '',
      fields: [],
      scannedAt: new Date().toISOString(),
      isExpired: true,
      ats: 'lever',
    };
  }

  // Wait for application form to be present
  await page.waitForSelector('form#application-form, .application-form, #btn-submit', { timeout: 15000 }).catch(() => null);

  // Extract metadata and fields from the live DOM
  const rawData = await page.evaluate(() => {
    // Company name
    const companyEl = document.querySelector('.main-header-logo img, .posting-headline h2, .main-header-logo');
    const companyFromHeader = companyEl ? (companyEl.getAttribute('alt') || companyEl.textContent || '').trim() : '';

    // Job title
    const titleEl = document.querySelector('.posting-headline h2, h2.posting-title, [data-qa="posting-name"]');
    const title = titleEl ? titleEl.textContent?.trim() || '' : '';

    // Location & team categories
    const catEls = Array.from(document.querySelectorAll('.posting-categories .posting-category'));
    const categories = catEls.map((c) => c.textContent?.trim() || '').filter(Boolean);

    // Standard fields
    const standardFields: Array<{
      name: string;
      id: string;
      type: string;
      label: string;
      required: boolean;
      options?: string[];
    }> = [];

    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'));
    inputs.forEach((el) => {
      const name = el.getAttribute('name') || '';
      if (!name || name.startsWith('cards[') || name.startsWith('surveysResponses[')) {
        return; // custom cards and demographic surveys handled separately
      }

      const inputType = el.getAttribute('type') || el.tagName.toLowerCase();
      const isRequired = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';

      let label = '';
      const parentQuestion = el.closest('.application-question');
      if (parentQuestion) {
        const labelEl = parentQuestion.querySelector('.application-label');
        if (labelEl) label = labelEl.textContent || '';
      }
      if (!label) {
        const labelEl = el.closest('label');
        if (labelEl) label = labelEl.textContent || '';
      }
      label = label.replace(/[✱*]/g, '').trim();

      let options: string[] | undefined;
      if (el.tagName.toLowerCase() === 'select') {
        const opts = Array.from(el.querySelectorAll('option'));
        options = opts
          .map((o) => o.textContent?.trim() || '')
          .filter((t) => t && !t.toLowerCase().includes('select...'));
      }

      standardFields.push({
        name,
        id: el.id || name,
        type: inputType,
        label: label || name,
        required: isRequired,
        options,
      });
    });

    // Custom cards via hidden baseTemplate inputs
    const baseTemplates: Array<{ cardId: string; json: string }> = [];
    const templateInputs = Array.from(document.querySelectorAll('input[type="hidden"][name^="cards["][name$="[baseTemplate]"]'));
    templateInputs.forEach((inp) => {
      const name = inp.getAttribute('name') || '';
      const match = name.match(/^cards\[([^\]]+)\]/);
      if (match && inp.getAttribute('value')) {
        baseTemplates.push({ cardId: match[1], json: inp.getAttribute('value')! });
      }
    });

    return {
      companyName: companyFromHeader,
      jobTitle: title,
      categories,
      standardFields,
      baseTemplates,
    };
  });

  const fields: ScannedField[] = [];

  // 1. Process standard fields
  for (const std of rawData.standardFields) {
    let type: ScannedFieldType = 'text';
    const rawType = std.type.toLowerCase();
    if (rawType === 'file') type = 'file';
    else if (rawType === 'select' || rawType === 'select-one') type = 'select';
    else if (rawType === 'checkbox') type = 'checkbox';
    else if (rawType === 'textarea') type = 'textarea';
    else if (std.name === 'location') type = 'location_autocomplete';
    else type = 'text';

    const cleanLabel = std.label || std.name;
    const fieldId = generateFingerprint(cleanLabel, type);

    fields.push({
      fieldId,
      name: std.name,
      type,
      label: cleanLabel,
      isRequired: std.required,
      options: std.options,
    });
  }

  // 2. Process custom cards from baseTemplates
  for (const bt of rawData.baseTemplates) {
    try {
      const parsed = JSON.parse(bt.json);
      const cardFields = Array.isArray(parsed.fields) ? parsed.fields : [];
      cardFields.forEach((cf: any, fieldIdx: number) => {
        const questionText = (cf.text || '').trim();
        if (!questionText) return;

        let type: ScannedFieldType = 'text';
        let options: string[] | undefined;

        if (cf.type === 'multiple-choice') {
          type = 'radio';
          if (Array.isArray(cf.options)) {
            options = cf.options.map((o: any) => (typeof o === 'string' ? o : o.text)).filter(Boolean);
          }
        } else if (cf.type === 'multiple-select') {
          type = 'checkbox';
          if (Array.isArray(cf.options)) {
            options = cf.options.map((o: any) => (typeof o === 'string' ? o : o.text)).filter(Boolean);
          }
        } else if (cf.type === 'dropdown') {
          type = 'select';
          if (Array.isArray(cf.options)) {
            options = cf.options.map((o: any) => (typeof o === 'string' ? o : o.text)).filter(Boolean);
          }
        } else if (cf.type === 'textarea') {
          type = 'textarea';
        } else {
          type = 'text';
        }

        const inputName = `cards[${bt.cardId}][field${fieldIdx}]`;
        const fieldId = generateFingerprint(questionText, type);

        fields.push({
          fieldId,
          name: inputName,
          type,
          label: questionText,
          isRequired: cf.required === true,
          options,
        });
      });
    } catch {
      // ignore JSON parse failures
    }
  }

  if (fields.length === 0) {
    throw new AtsScanFailure('extraction', `Scan failed: Lever application form yielded zero fields for ${url}`);
  }

  const companyName = apiData?.categories?.department || rawData.companyName || ids?.company || '';
  const jobTitle = apiData?.text || rawData.jobTitle || '';
  const jobPostingLocation = apiData?.categories?.location || rawData.categories[0] || undefined;

  let jobPostingFacts: JobPostingFacts | undefined;
  if (apiData) {
    jobPostingFacts = {
      location: apiData.categories?.location,
      locations: apiData.categories?.allLocations,
      raw: {
        workplaceType: apiData.workplaceType,
        department: apiData.categories?.department,
        descriptionSummary: apiData.descriptionPlain?.slice(0, 300),
      },
    };
  }

  return {
    jobUrl: url,
    companyName,
    jobTitle,
    jobPostingLocation,
    jobPostingFacts,
    fields,
    scannedAt: new Date().toISOString(),
    isExpired: false,
    ats: 'lever',
  };
}

export class LeverScanner {
  private readonly options: LeverScannerOptions;

  constructor(options: LeverScannerOptions = {}) {
    this.options = {
      workerPoolSize: options.workerPoolSize ?? config.WORKER_POOL_SIZE ?? 4,
      timeoutMs: options.timeoutMs ?? config.PLAYWRIGHT_TIMEOUT ?? 45000,
      minJitterMs: options.minJitterMs ?? config.SCANNER_JITTER_MIN_MS ?? 3000,
      maxJitterMs: options.maxJitterMs ?? config.SCANNER_JITTER_MAX_MS ?? 6000,
      headless: options.headless ?? true,
      ...options,
    };
  }

  public async scanAll(urls: string[]): Promise<ScannedJobTemplate[]> {
    return this.scanUniqueUrls(urls);
  }

  public async scanUniqueUrls(urls: string[]): Promise<ScannedJobTemplate[]> {
    if (urls.length === 0) return [];

    log.info(`[LeverScanner] Starting scan for ${urls.length} Lever URLs with ${this.options.workerPoolSize} workers.`);
    const results: ScannedJobTemplate[] = [];
    const queue = [...urls];
    const deferredQueue: string[] = [];
    const hostCooldownUntil = new Map<string, number>();
    let scannedCount = 0;
    const total = urls.length;

    const worker = async () => {
      let managed = await browserManager.acquireBrowser({ headless: this.options.headless });
      let context = await browserManager.createSterileContext(managed.browser);
      let page = await context.newPage();

      try {
        while (queue.length > 0) {
          throwIfPipelineAborted();
          const targetUrl = queue.shift();
          if (!targetUrl) break;

          const hostKey = extractAtsHostKey(targetUrl, 'lever');
          const cooldownUntil = hostCooldownUntil.get(hostKey) ?? 0;
          if (Date.now() < cooldownUntil) {
            log.info(`[LeverScanner] ⏸️ Host ${hostKey} is in cooldown until ${new Date(cooldownUntil).toISOString()}. Deferring ${targetUrl}.`);
            deferredQueue.push(targetUrl);
            continue;
          }

          try {
            await sleepRandomJitter(this.options.minJitterMs!, this.options.maxJitterMs!);
            const template = await extractLeverFieldsFromPage(page, targetUrl, {
              timeoutMs: this.options.timeoutMs,
            });
            results.push(template);
            scannedCount++;
            this.options.onJobScanned?.(template, scannedCount, total);
          } catch (err: any) {
            log.warn(`[LeverScanner] Failed scanning ${targetUrl}: ${err?.message || err}`);
            const scanFailure = err instanceof AtsScanFailure ? err : null;
            const category: FailureDiagnosticInput['category'] =
              scanFailure?.kind === 'throttled'
                ? 'SCAN_HTTP_THROTTLED'
                : scanFailure?.kind === 'temporary'
                  ? 'SCAN_TEMPORARY_FAILURE'
                : scanFailure?.kind === 'challenge'
                  ? 'SCAN_INTERACTIVE_CHALLENGE'
                  : err instanceof LeverNavigationError
                    ? 'SCAN_PLAYWRIGHT_NAVIGATE'
                    : 'SCAN_FIELD_EXTRACTION';
            const isRetryable = scanFailure
              ? scanFailure.kind === 'throttled' || scanFailure.kind === 'temporary' || scanFailure.kind === 'extraction'
              : true;
            await this.options.onFailureDiagnostic?.({
              category,
              stage: 'url_scan',
              reason: err?.message || 'Error scanning Lever job posting URL',
              error: err,
              errorCode: scanFailure?.httpStatus,
              jobUrl: targetUrl,
              metadata: scanFailure?.httpStatus === null || !scanFailure
                ? undefined
                : { httpStatus: scanFailure.httpStatus, ...(scanFailure.retryAfterMs === null ? {} : { retryAfterMs: scanFailure.retryAfterMs }) },
              isTerminal: !isRetryable,
              isRetryable,
            }).catch(() => {});

            if (scanFailure?.kind === 'throttled') {
              const retryAfterMs = scanFailure.retryAfterMs ?? 5000;
              hostCooldownUntil.set(hostKey, Date.now() + retryAfterMs);
              log.warn(`[LeverScanner] ⚠️ Throttled by ${hostKey}. Quarantining host for ${retryAfterMs}ms. Deferring ${targetUrl}.`);
              deferredQueue.push(targetUrl);
            } else {
              this.options.onScanFailed?.(targetUrl, scannedCount, total);
            }

            // Re-open page on crash
            try {
              await page.close().catch(() => {});
              page = await context.newPage();
            } catch {
              await browserManager.releaseBrowser(managed.browserId).catch(() => {});
              managed = await browserManager.acquireBrowser({ headless: this.options.headless });
              context = await browserManager.createSterileContext(managed.browser);
              page = await context.newPage();
            }
          }
        }
      } finally {
        await context.close().catch(() => {});
        await browserManager.releaseBrowser(managed.browserId).catch(() => {});
      }
    };

    const workerCount = Math.min(this.options.workerPoolSize!, urls.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    // End-of-queue second pass retry for deferred 429 URLs
    if (deferredQueue.length > 0) {
      log.info(`[LeverScanner] 🔄 Main queue complete. Starting second-pass retry for ${deferredQueue.length} deferred URL(s)...`);
      const now = Date.now();
      let maxWait = 0;
      for (const url of deferredQueue) {
        const hostKey = extractAtsHostKey(url, 'lever');
        const cooldown = hostCooldownUntil.get(hostKey) ?? 0;
        if (cooldown > now) {
          maxWait = Math.max(maxWait, cooldown - now);
        }
      }
      if (maxWait > 0) {
        const sleepMs = Math.min(maxWait, 60_000);
        log.info(`[LeverScanner] ⏳ Waiting ${sleepMs}ms for host cooldown(s) to expire before second pass...`);
        await new Promise((r) => setTimeout(r, sleepMs));
      }

      queue.push(...deferredQueue);
      deferredQueue.length = 0;

      const secondPassWorker = async () => {
        let managed = await browserManager.acquireBrowser({ headless: this.options.headless });
        let context = await browserManager.createSterileContext(managed.browser);
        let page = await context.newPage();

        try {
          while (queue.length > 0) {
            throwIfPipelineAborted();
            const targetUrl = queue.shift();
            if (!targetUrl) break;

            try {
              await sleepRandomJitter(this.options.minJitterMs!, this.options.maxJitterMs!);
              const template = await extractLeverFieldsFromPage(page, targetUrl, {
                timeoutMs: this.options.timeoutMs,
              });
              results.push(template);
              scannedCount++;
              this.options.onJobScanned?.(template, scannedCount, total);
            } catch (err: any) {
              log.warn(`[LeverScanner] Failed second pass scanning ${targetUrl}: ${err?.message || err}`);
              this.options.onScanFailed?.(targetUrl, scannedCount, total);
            }
          }
        } finally {
          await context.close().catch(() => {});
          await browserManager.releaseBrowser(managed.browserId).catch(() => {});
        }
      };

      await secondPassWorker();
    }

    return results;
  }
}
