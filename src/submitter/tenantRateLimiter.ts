/**
 * @fileoverview Global tenant-level rate limiter for ATS submissions.
 * Prevents multiple workers from hammering the same company board in rapid bursts,
 * which triggers tenant-level abuse detection / interactive CAPTCHAs on Ashby and Greenhouse.
 */

import { createLogger } from '../utils/logger.js';
import type { ApplicationRow } from '../db/applications.js';

const log = createLogger('TenantRateLimiter');

export const DEFAULT_TENANT_INTERVAL_MS = 120_000; // 2 minutes between submissions to same employer
export const DEFAULT_CAPTCHA_PENALTY_MS = 15 * 60 * 1000; // 15 minutes backoff when challenge is hit

export function extractTenantKey(applicationOrUrl: string | ApplicationRow | { job_url?: string; company_name?: string }): string {
  let url = '';
  let fallbackName = '';

  if (typeof applicationOrUrl === 'string') {
    url = applicationOrUrl;
  } else if (applicationOrUrl) {
    url = (applicationOrUrl as any).job_url || (applicationOrUrl as any).jobUrl || '';
    fallbackName = (applicationOrUrl as any).company_name || (applicationOrUrl as any).companyName || '';
  }

  if (url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const port = parsed.port ? `:${parsed.port}` : '';
      const segments = parsed.pathname.split('/').filter(Boolean);

      // Ashby: jobs.ashbyhq.com/<companySlug>/...
      // Lever: jobs.lever.co/<companySlug>/...
      // Greenhouse: job-boards.greenhouse.io/<boardToken>/... or boards.greenhouse.io/<boardToken>/...
      const isMultiTenant =
        host.includes('ashbyhq.com') ||
        host.includes('lever.co') ||
        host.includes('greenhouse.io') ||
        host === '127.0.0.1' ||
        host === 'localhost';

      if (isMultiTenant && segments.length > 0) {
        // e.g. jobs.ashbyhq.com/clera or job-boards.greenhouse.io/alixpartners
        return `${host}${port}/${segments[0].toLowerCase()}`;
      }
      return `${host}${port}`;
    } catch {
      // url was not valid URL, fall through to fallbackName
    }
  }

  if (fallbackName) {
    return `company:${fallbackName.trim().toLowerCase()}`;
  }

  return 'unknown_tenant';
}

export class TenantRateLimiter {
  private readonly lastSubmissionTime = new Map<string, number>();
  private readonly penaltyUntil = new Map<string, number>();
  private readonly defaultIntervalMs: number;

  constructor(defaultIntervalMs: number = DEFAULT_TENANT_INTERVAL_MS) {
    this.defaultIntervalMs = defaultIntervalMs;
  }

  public recordCaptcha(tenantKey: string, penaltyDurationMs: number = DEFAULT_CAPTCHA_PENALTY_MS): void {
    const penaltyExpiry = Date.now() + penaltyDurationMs;
    this.penaltyUntil.set(tenantKey, penaltyExpiry);
    log.warn(
      `[TenantRateLimiter] 🛑 Interactive CAPTCHA recorded for ${tenantKey}. Tenant backoff escalated for ${(
        penaltyDurationMs /
        1000 /
        60
      ).toFixed(1)}m (until ${new Date(penaltyExpiry).toISOString()})`
    );
  }

  public getRemainingCooldownMs(tenantKey: string, intervalMs?: number): number {
    const penaltyExpiry = this.penaltyUntil.get(tenantKey) || 0;
    const penaltyRemaining = Math.max(0, penaltyExpiry - Date.now());

    const interval = intervalMs ?? this.defaultIntervalMs;
    const lastTime = this.lastSubmissionTime.get(tenantKey) || 0;
    const elapsed = Date.now() - lastTime;
    const normalRemaining = Math.max(0, interval - elapsed);

    return Math.max(normalRemaining, penaltyRemaining);
  }

  public isUnderCooldown(tenantKey: string, intervalMs?: number): boolean {
    return this.getRemainingCooldownMs(tenantKey, intervalMs) > 0;
  }

  public recordSubmission(tenantKey: string, timestamp: number = Date.now()): void {
    this.lastSubmissionTime.set(tenantKey, timestamp);
    log.debug(`[TenantRateLimiter] Recorded submission for ${tenantKey} at ${new Date(timestamp).toISOString()}`);
  }

  public async waitForCooldown(tenantKey: string, intervalMs?: number): Promise<number> {
    const remaining = this.getRemainingCooldownMs(tenantKey, intervalMs);
    if (remaining > 0) {
      log.info(`[TenantRateLimiter] ⏳ Pacing submission for ${tenantKey}: waiting ${(remaining / 1000).toFixed(1)}s to respect rate limit interval...`);
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    this.recordSubmission(tenantKey);
    return remaining;
  }

  public reset(tenantKey?: string): void {
    if (tenantKey) {
      this.lastSubmissionTime.delete(tenantKey);
      this.penaltyUntil.delete(tenantKey);
    } else {
      this.lastSubmissionTime.clear();
      this.penaltyUntil.clear();
    }
  }
}

export const tenantRateLimiter = new TenantRateLimiter();
