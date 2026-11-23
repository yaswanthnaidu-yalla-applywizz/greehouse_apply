/**
 * @fileoverview Ashby job form scanner using the Playwright DOM.
 * Supports single-job scanning and concurrent worker-pool scanning.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../config/env.js';
import type { ScannedField, ScannedJobTemplate } from '../types/index.js';
import { browserManager } from '../submitter/browserManager.js';
import { toAshbyApplicationUrl } from './atsDetector.js';
import { createLogger, haltWithDevAlert } from '../utils/logger.js';
import { isPipelineCompactLogging } from '../utils/pipelineLogging.js';
import { throwIfPipelineAborted } from '../orchestrator/pipelineAbort.js';
import { emitFailureDiagnostic } from '../utils/failureDiagnostics.js';
import type { FailureDiagnosticInput } from '../types/failureDiagnostics.js';
import { observeAtsVerification } from '../submitter/atsVerification.js';
import {
  AtsScanFailure,
  classifyAtsNavigationStatus,
  navigationFailure,
  extractAtsHostKey,
} from './atsScanFailure.js';

const log = createLogger('Ashby Scanner');

class AshbyNavigationError extends Error {
  constructor(error: unknown) {
    super(`Ashby navigation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function navigateAshby(page: Page, url: string, timeoutMs: number) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response) throw new Error('Navigation returned no response');
    return response;
  } catch (error) {
    throw new AshbyNavigationError(error);
  }
}

async function validateAshbyResponse(page: Page, response: Awaited<ReturnType<typeof navigateAshby>>): Promise<boolean> {
  const status = response.status();
  const classification = classifyAtsNavigationStatus(status);
  if (classification === 'expired') return true;
  if (classification !== 'ok' && classification !== 'blocked') {
    throw navigationFailure(status, await response.headerValue('retry-after').catch(() => null));
  }

  const verification = await observeAtsVerification(page, 'ashby');
  if (verification.kind === 'interactive') {
    throw new AtsScanFailure('challenge', `Ashby verification challenge detected (${verification.provider}/${verification.evidence})`);
  }
  if (verification.kind === 'widget_error') {
    throw new AtsScanFailure('blocked', `Ashby verification widget error detected (${verification.provider})`);
  }
  if (classification === 'blocked') {
    throw navigationFailure(status, await response.headerValue('retry-after').catch(() => null));
  }
  return false;
}

export function expiredAshbyTemplate(url: string): ScannedJobTemplate {
  return {
    jobUrl: url,
    companyName: '',
    jobTitle: '',
    fields: [],
    scannedAt: new Date().toISOString(),
    isExpired: true,
  };
}

export async function isAshbyJobClosedOnDom(page: Page): Promise<boolean> {
  const pageText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  return /404|no longer available|position has been filled|job (?:not found|is closed|has ended)|no longer accepting/i.test(pageText);
}

function sleepRandomJitter(minMs: number, maxMs: number): Promise<void> {
  if (maxMs <= 0 || maxMs < minMs) return Promise.resolve();
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export interface AshbyScannerOptions {
  /** Number of parallel browser workers. @default config.WORKER_POOL_SIZE (4) */
  workerPoolSize?: number;
  /** Navigation and interaction timeout in ms. @default config.PLAYWRIGHT_TIMEOUT (45000) */
  timeoutMs?: number;
  /** Minimum randomized delay in ms between consecutive navigations per worker. @default config.SCANNER_JITTER_MIN_MS (3000) */
  minJitterMs?: number;
  /** Maximum randomized delay in ms between consecutive navigations per worker. @default config.SCANNER_JITTER_MAX_MS (6000) */
  maxJitterMs?: number;
  /** Whether to launch browser in headless mode. @default true */
  headless?: boolean;
  /** Optional progress callback invoked as URLs finish scanning. */
  onJobScanned?: (job: ScannedJobTemplate, index: number, total: number) => void;
  onScanFailed?: (url: string, index: number, total: number) => void;
  /** Diagnostic persistence override. */
  onFailureDiagnostic?: (input: FailureDiagnosticInput) => Promise<void>;
  /** Fatal error handler. */
  onFatal?: (module: string, message: string, error?: unknown) => never;
}

/**
 * Extracts form fields and job metadata from an Ashby page DOM.
 */
export async function extractAshbyFieldsFromPage(
  page: Page,
  url: string,
  options?: { timeoutMs?: number; throwOnZeroFields?: boolean; skipNavigation?: boolean }
): Promise<ScannedJobTemplate> {
  const applicationUrl = toAshbyApplicationUrl(url) || url;
  const timeoutMs = options?.timeoutMs ?? 45000;

  if (!options?.skipNavigation) {
    const response = await navigateAshby(page, applicationUrl, timeoutMs);
    if (await validateAshbyResponse(page, response)) return expiredAshbyTemplate(url);

    // Check if current page is on a custom domain with an embedded Ashby iframe (e.g. ?ashby_jid=...)
    const isDirectAshbyHost = new URL(page.url()).hostname.toLowerCase().includes('ashbyhq.com');
    if (!isDirectAshbyHost) {
      // Wait briefly for client-side embedded iframe injection on custom domains
      await page.waitForSelector('iframe[src*="ashbyhq.com"]', { timeout: 4000 }).catch(() => null);

      const ashbyFrame = page.frames().find((f) => f.url().includes('ashbyhq.com'));
      if (ashbyFrame && ashbyFrame.url() !== page.url()) {
        const targetUrl = toAshbyApplicationUrl(ashbyFrame.url()) || ashbyFrame.url();
        const embeddedResponse = await navigateAshby(page, targetUrl, timeoutMs);
        if (await validateAshbyResponse(page, embeddedResponse)) return expiredAshbyTemplate(url);
      } else {
        const iframeSrc = await page.evaluate(() => {
          const el = document.querySelector('iframe[src*="ashbyhq.com"]');
          return el ? el.getAttribute('src') : null;
        }).catch(() => null);
        if (iframeSrc && iframeSrc.startsWith('http')) {
          const targetUrl = toAshbyApplicationUrl(iframeSrc) || iframeSrc;
          const embeddedResponse = await navigateAshby(page, targetUrl, timeoutMs);
          if (await validateAshbyResponse(page, embeddedResponse)) return expiredAshbyTemplate(url);
        }
      }
    }
  }

  // Fast check: is job closed or 404?
  if (await isAshbyJobClosedOnDom(page)) {
    log.info(`[Ashby Scanner] Fast-detected closed/404 job posting on ${url}`);
    return expiredAshbyTemplate(url);
  }

  let selectorFound = await page.waitForSelector('[data-field-path]', { timeout: 15000 }).catch(() => null);
  let isExplicitlyClosed = false;
  if (!selectorFound) {
    const pageText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    isExplicitlyClosed = /404|no longer available|position has been filled|job (?:not found|is closed|has ended)|no longer accepting/i.test(pageText);
    if (!isExplicitlyClosed) {
      // Attempt clicking visible "Application" or "Apply" button / tab
      const clickedTab = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="button"]'));
        const tab = candidates.find((el) => {
          const t = (el.textContent || '').trim().toLowerCase();
          return t === 'application' || t === 'apply' || t === 'apply now' || t === 'apply for this job' || t.startsWith('apply for');
        });
        if (tab) {
          (tab as HTMLElement).click();
          return true;
        }
        return false;
      }).catch(() => false);

      if (clickedTab) {
        selectorFound = await page.waitForSelector('[data-field-path]', { timeout: 8000 }).catch(() => null);
      } else {
        // Settle brief wait for dynamic hydration under concurrency load
        selectorFound = await page.waitForSelector('[data-field-path]', { timeout: 4000 }).catch(() => null);
      }
    }
  }

  const title = (await page.title()) || 'Ashby Opportunity';
  let companyName = '';
  let jobTitle = title;
  if (title.includes('@')) {
    const parts = title.split('@');
    jobTitle = parts[0].trim();
    companyName = parts[1].trim();
  }

  const headerInfo = await page.evaluate(() => {
    let location = '';
    let address = '';
    let locationType = '';
    const rawFacts: Record<string, string> = {};

    const textNodes = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3, h4'))
      .map((el) => (el as HTMLElement).innerText?.trim())
      .filter(Boolean);

    for (let i = 0; i < textNodes.length; i++) {
      const t = textNodes[i];
      if (/^location$/i.test(t) && textNodes[i + 1] && !location) {
        location = textNodes[i + 1];
        rawFacts.location = location;
      } else if (/^address$/i.test(t) && textNodes[i + 1] && !address) {
        address = textNodes[i + 1];
        rawFacts.address = address;
      } else if (/^location\s*type$/i.test(t) && textNodes[i + 1] && !locationType) {
        locationType = textNodes[i + 1];
        rawFacts.locationType = locationType;
      }
    }
    return { location, address, locationType, rawFacts };
  });

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

      let classification: 'answerable' | 'system_widget' = 'answerable';
      if (
        fieldPath.startsWith('_systemfield_education') ||
        fieldPath.includes('education_history') ||
        /^education\s*history$/i.test(labelText)
      ) {
        classification = 'system_widget';
      }

      let type = 'text';
      let options: string[] = [];

      if (container.querySelector('input[type="file"]') || fieldPath.includes('resume')) {
        type = 'file';
      } else if (
        container.querySelector('input[type="tel"]') ||
        fieldPath.includes('phone') ||
        fieldPath.includes('mobile')
      ) {
        type = 'text';
      } else if ((() => {
        const optionButtons = Array.from(container.querySelectorAll('button[data-option]'))
          .map((button) => button.getAttribute('data-option')?.trim().toLowerCase())
          .filter(Boolean);
        const hasYes = optionButtons.some((option) => option === 'yes');
        const hasNo = optionButtons.some((option) => option === 'no');
        return hasYes && hasNo;
      })()) {
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

      return { fieldPath, labelText, isRequired, type, options, classification };
    });
  });

  const scannedFields: ScannedField[] = rawFields.map((f) => ({
    fieldId: f.fieldPath,
    name: f.fieldPath,
    label: f.labelText || f.fieldPath,
    type: f.type as any,
    isRequired: f.isRequired,
    options: f.options.length > 0 ? f.options : undefined,
    classification: f.classification,
  }));

  if (scannedFields.length === 0) {
    if (isExplicitlyClosed) return { ...expiredAshbyTemplate(url), companyName: companyName || 'Company', jobTitle, jobPostingLocation: headerInfo.location || undefined };
    throw new AtsScanFailure('extraction', `Scan failed: Ashby form yielded zero fields for ${url}`);
  }

  const jobPostingLocation = headerInfo.location || undefined;
  const jobPostingFacts = jobPostingLocation
    ? {
        location: jobPostingLocation,
        locations: [jobPostingLocation],
        raw: headerInfo.rawFacts,
      }
    : undefined;

  return {
    jobUrl: url,
    companyName: companyName || 'Company',
    jobTitle,
    fields: scannedFields,
    scannedAt: new Date().toISOString(),
    isExpired: false,
    jobPostingLocation,
    jobPostingFacts,
  };
}

/**
 * Scans an Ashby job form directly from the browser DOM.
 * Targets [data-field-path] elements, extracting labels, required status, and field types.
 */
export async function scanAshbyDom(url: string): Promise<ScannedJobTemplate> {
  const managed = await browserManager.acquireBrowser({ headless: true });
  let page = null;

  try {
    const context = await managed.browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    });
    page = await context.newPage();
    return await extractAshbyFieldsFromPage(page, url, { throwOnZeroFields: true });
  } finally {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
    await browserManager.releaseBrowser(managed.browserId).catch(() => {});
  }
}

/**
 * Scans a single Ashby job URL.
 */
export async function scanAshbyJob(url: string): Promise<ScannedJobTemplate> {
  return scanAshbyDom(url);
}

/**
 * AshbyScanner manages a pool of headless Chromium workers to inspect
 * unique Ashby job postings in parallel.
 */
export class AshbyScanner {
  private workerPoolSize: number;
  private timeoutMs: number;
  private minJitterMs: number;
  private maxJitterMs: number;
  private headless: boolean;
  private onJobScanned?: (job: ScannedJobTemplate, index: number, total: number) => void;
  private onScanFailed?: (url: string, index: number, total: number) => void;
  private onFailureDiagnostic: (input: FailureDiagnosticInput) => Promise<void>;
  private onFatal: (module: string, message: string, error?: unknown) => never;

  public readonly hostCooldownUntil = new Map<string, number>();

  constructor(options: AshbyScannerOptions = {}) {
    this.workerPoolSize = options.workerPoolSize ?? config.WORKER_POOL_SIZE ?? 4;
    this.timeoutMs = options.timeoutMs ?? config.PLAYWRIGHT_TIMEOUT ?? 45000;
    this.minJitterMs = options.minJitterMs ?? config.SCANNER_JITTER_MIN_MS ?? 3000;
    this.maxJitterMs = options.maxJitterMs ?? config.SCANNER_JITTER_MAX_MS ?? 6000;
    this.headless = process.env.RAILWAY_ENV === 'true' ? true : (options.headless ?? true);
    this.onJobScanned = options.onJobScanned;
    this.onScanFailed = options.onScanFailed;
    this.onFailureDiagnostic = options.onFailureDiagnostic ?? emitFailureDiagnostic;
    this.onFatal = options.onFatal ?? haltWithDevAlert;
  }

  /**
   * Scans a single Ashby job URL using an existing Playwright Page.
   */
  public async scanSingleUrl(
    url: string,
    page: Page,
    compactLogs = isPipelineCompactLogging()
  ): Promise<ScannedJobTemplate | null> {
    try {
      return await extractAshbyFieldsFromPage(page, url, {
        timeoutMs: this.timeoutMs,
        throwOnZeroFields: false,
      });
    } catch (error: any) {
      if (!compactLogs) {
        log.warn(`[Ashby Scanner] ⚠️ Error scanning ${url}: ${error.message}`);
      }
      const scanFailure = error instanceof AtsScanFailure ? error : null;
      const isTimeout = /time.*out/i.test(error?.message || '');
      const isNav = error instanceof AshbyNavigationError || /net::|navigation|resolve|dns|load/i.test(error?.message || '');
      const category: FailureDiagnosticInput['category'] = scanFailure?.kind === 'throttled'
        ? 'SCAN_HTTP_THROTTLED'
        : scanFailure?.kind === 'temporary'
          ? 'SCAN_TEMPORARY_FAILURE'
          : scanFailure?.kind === 'challenge'
            ? 'SCAN_INTERACTIVE_CHALLENGE'
            : isTimeout
        ? 'SCAN_PLAYWRIGHT_TIMEOUT'
        : isNav
          ? 'SCAN_PLAYWRIGHT_NAVIGATE'
          : 'SCAN_FIELD_EXTRACTION';

      const isRetryable = scanFailure
        ? scanFailure.kind === 'throttled' || scanFailure.kind === 'temporary' || scanFailure.kind === 'extraction'
        : true;

      await this.onFailureDiagnostic({
        category,
        stage: 'url_scan',
        reason: error?.message || 'Error scanning Ashby job posting URL',
        error,
        errorCode: scanFailure?.httpStatus,
        jobUrl: url,
        metadata: scanFailure?.httpStatus === null || !scanFailure
          ? undefined
          : { httpStatus: scanFailure.httpStatus, ...(scanFailure.retryAfterMs === null ? {} : { retryAfterMs: scanFailure.retryAfterMs }) },
        isTerminal: !isRetryable,
        isRetryable,
      }).catch(() => {});

      if (scanFailure?.kind === 'throttled') {
        const retryAfterMs = scanFailure.retryAfterMs ?? 5000;
        const hostKey = extractAtsHostKey(url, 'ashby');
        this.hostCooldownUntil.set(hostKey, Date.now() + retryAfterMs);
      }

      return null;
    }
  }

  /**
   * Scans an array of unique Ashby job URLs concurrently across the worker pool.
   */
  public async scanUniqueUrls(urls: string[]): Promise<ScannedJobTemplate[]> {
    if (!urls || urls.length === 0) {
      log.info('[Ashby Scanner] ⚠️ No URLs provided for scanning.');
      return [];
    }

    const total = urls.length;
    if (!this.onJobScanned) {
      log.info(
        `[Ashby Scanner] 🚀 Starting scan for ${total.toLocaleString()} unique URLs (workers: ${this.workerPoolSize}, timeout: ${this.timeoutMs}ms)`
      );
    }

    const results: ScannedJobTemplate[] = new Array(total);
    let currentIndex = 0;
    let completedCount = 0;
    let activeJobs = 0;
    let expiredJobs = 0;
    let failedJobs = 0;
    let totalFields = 0;
    const scanStartedAt = Date.now();
    const compact = isPipelineCompactLogging();

    let browser: Browser | null = null;

    try {
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
      } catch (launchErr: any) {
        await this.onFailureDiagnostic({
          category: 'SCAN_PLAYWRIGHT_LAUNCH',
          stage: 'browser_launch',
          reason: `Ashby browser launch failed: ${launchErr?.message || String(launchErr)}`,
          error: launchErr,
          isTerminal: true,
          isRetryable: false,
        }).catch(() => {});
        this.onFatal(
          'Ashby Scanner',
          'Playwright failed to launch for Ashby — check RAILWAY_ENV and browser binary',
          launchErr
        );
      }

      const workerTasks: Promise<void>[] = [];
      const poolSize = Math.min(this.workerPoolSize, total);
      const deferredUrls: Array<{ url: string; index: number }> = [];

      for (let workerId = 0; workerId < poolSize; workerId++) {
        const task = (async () => {
          if (!browser) return;
          const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            userAgent:
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          });

          try {
            while (true) {
              const jobIndex = currentIndex++;
              if (jobIndex >= total) {
                break;
              }

              const targetUrl = urls[jobIndex];
              throwIfPipelineAborted('Ashby scan');

              const hostKey = extractAtsHostKey(targetUrl, 'ashby');
              const cooldownUntil = this.hostCooldownUntil.get(hostKey) ?? 0;
              if (Date.now() < cooldownUntil) {
                log.info(`[Ashby Scanner] ⏸️ Host ${hostKey} in cooldown until ${new Date(cooldownUntil).toISOString()}. Deferring ${targetUrl}.`);
                deferredUrls.push({ url: targetUrl, index: jobIndex });
                continue;
              }

              const page = await context.newPage();
              try {
                const template = await this.scanSingleUrl(targetUrl, page, compact);
                if (template) {
                  completedCount++;
                  results[jobIndex] = template;
                  if (template.isExpired) expiredJobs++;
                  else activeJobs++;
                  totalFields += template.fields?.length || 0;
                  this.onJobScanned?.(template, completedCount, total);
                } else if ((this.hostCooldownUntil.get(hostKey) ?? 0) > Date.now()) {
                  log.warn(`[Ashby Scanner] ⚠️ Throttled on ${hostKey}. Deferring ${targetUrl} for end-of-queue retry.`);
                  deferredUrls.push({ url: targetUrl, index: jobIndex });
                } else {
                  completedCount++;
                  failedJobs++;
                  this.onScanFailed?.(targetUrl, completedCount, total);
                }

                const isMilestone = completedCount === total || completedCount % 25 === 0;
                if (isMilestone && !this.onJobScanned) {
                  const elapsedSec = ((Date.now() - scanStartedAt) / 1000).toFixed(0);
                  log.info(
                    `[Ashby Scanner] Progress: ${completedCount}/${total} scanned (active: ${activeJobs}, expired: ${expiredJobs}, failed: ${failedJobs}, elapsed: ${elapsedSec}s)`
                  );
                }
              } finally {
                await Promise.race([
                  page.close(),
                  new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('page.close timed out after 5000ms')), 5000)
                  ),
                ]).catch((err) => {
                  log.error(
                    `[Ashby Scanner] worker=${workerId} page.close failed job=${jobIndex}`,
                    err
                  );
                });
              }

              throwIfPipelineAborted('Ashby scan');

              if (jobIndex + 1 < total && this.maxJitterMs > 0) {
                await sleepRandomJitter(this.minJitterMs, this.maxJitterMs);
              }
            }
          } finally {
            await context.close().catch(() => {});
          }
        })();

        workerTasks.push(task);
      }

      await Promise.all(workerTasks);

      // End-of-queue second pass retry for deferred 429 URLs
      if (deferredUrls.length > 0) {
        log.info(`[Ashby Scanner] 🔄 Main queue complete. Starting second-pass retry for ${deferredUrls.length} deferred URL(s)...`);
        const now = Date.now();
        let maxWait = 0;
        for (const item of deferredUrls) {
          const hostKey = extractAtsHostKey(item.url, 'ashby');
          const cooldown = this.hostCooldownUntil.get(hostKey) ?? 0;
          if (cooldown > now) {
            maxWait = Math.max(maxWait, cooldown - now);
          }
        }
        if (maxWait > 0) {
          const sleepMs = Math.min(maxWait, 60_000);
          log.info(`[Ashby Scanner] ⏳ Waiting ${sleepMs}ms for host cooldown(s) to expire before second pass...`);
          await new Promise((r) => setTimeout(r, sleepMs));
        }

        if (browser) {
          const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            userAgent:
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          });
          const page = await context.newPage();
          try {
            for (const item of deferredUrls) {
              try {
                const template = await this.scanSingleUrl(item.url, page, compact);
                if (template) {
                  results[item.index] = template;
                  if (template.isExpired) expiredJobs++;
                  else activeJobs++;
                  totalFields += template.fields?.length || 0;
                  this.onJobScanned?.(template, ++completedCount, total);
                } else {
                  failedJobs++;
                  this.onScanFailed?.(item.url, ++completedCount, total);
                }
              } catch {
                failedJobs++;
                this.onScanFailed?.(item.url, ++completedCount, total);
              }
            }
          } finally {
            await page.close().catch(() => {});
            await context.close().catch(() => {});
          }
        }
      }
    } finally {
      if (browser) {
        await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
      }
    }

    const elapsedSec = ((Date.now() - scanStartedAt) / 1000).toFixed(1);
    if (!this.onJobScanned) {
      log.info(
        `[Ashby Scanner] ✅ Scan complete: ${completedCount}/${total} URLs processed (active: ${activeJobs}, expired: ${expiredJobs}, failed: ${failedJobs}, total_fields: ${totalFields}, workers: ${Math.min(this.workerPoolSize, total)}, elapsed: ${elapsedSec}s)`
      );
    }
    return results.filter(Boolean);
  }
}
