/**
 * @fileoverview Shared utilities and helpers for inbox polling, proof confirmation, and OTP extraction.
 */

import {
  queryConfirmationEmail,
  type ZohoEmailQueryOptions,
  type ZohoEmailQueryResult,
} from '../zoho-connector.js';
import {
  getApplication,
  updateStatus,
  attachEmailProofJsonToApplication,
  type ApplicationRow,
  type ApplicationStatus,
  type EmailProofJson,
} from '../../db/applications.js';
import { getProfile, getCompanyEmail } from '../../db/profiles.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('InboxPoller');

export const OTP_EMAIL_CLOCK_SKEW_MS = 5_000;

export function parseZohoReceivedTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isMessageEligibleByTimestamp(
  receivedTimeMs: number,
  sinceTimestamp: number,
  clockSkewMs: number = OTP_EMAIL_CLOCK_SKEW_MS
): boolean {
  if (!sinceTimestamp || !Number.isFinite(sinceTimestamp) || sinceTimestamp <= 0) {
    return true;
  }
  const minTimeMs = sinceTimestamp - clockSkewMs;
  return receivedTimeMs >= minTimeMs;
}

export function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCompanyName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|technologies|tech|solutions|co)\b[.]?/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

export function getErrorCategory(error: unknown): string {
  const typed =
    error && typeof error === 'object'
      ? (error as { name?: unknown; code?: unknown; cause?: { code?: unknown } })
      : {};
  const name =
    typeof typed.name === 'string' ? typed.name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : 'UnknownError';
  const codeValue = typed.code ?? typed.cause?.code;
  const code =
    typeof codeValue === 'string' ? codeValue.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
  return code ? `${name}_${code}` : name;
}

/**
 * Extracts an alphanumeric or numeric OTP code from email text or subject.
 */
export function extractOtpCodeFromText(text: string): string | null {
  if (!text) return null;

  // Pattern 0: Greenhouse's exact wording:
  // "Copy and paste this code into the security code field on your application: NgW4NT62"
  const greenhousePattern =
    /copy\s*and\s*paste\s*this\s*code[\s\S]{0,140}?(?::|\bis\b)[\s\r\n]*([A-Za-z0-9]{6,16})\b/i;
  const match0 = text.match(greenhousePattern);
  if (match0 && match0[1]) {
    return match0[1].trim();
  }

  // Pattern 1: Explicit labeled OTP code
  const explicitPattern =
    /(?:security\s*code|verification\s*code|verify\s*your\s*account\s*with|one-time\s*(?:passcode|code|password)|your\s*(?:verification\s*)?code|enter\s*(?:the\s*)?(?:following\s*)?code|confirmation\s*code|temporary\s*code)[^:\n]{0,80}(?:\s+is|\s*:)[\s\r\n:=]*([A-Za-z0-9]{6,16})\b/i;
  const match1 = text.match(explicitPattern);
  if (match1 && match1[1]) {
    return match1[1].trim();
  }

  // Pattern 2: 8-character alphanumeric code standalone (e.g. Aebf0aDc)
  const standalonePattern = /\b([A-Za-z0-9]{8})\b/g;
  const words = text.match(standalonePattern) || [];
  const stopWords = new Set([
    'security',
    'complete',
    'received',
    'position',
    'employer',
    'location',
    'continue',
    'question',
    'response',
    'required',
    'password',
    'username',
    'greenhou',
    'candidate',
    'settings',
  ]);
  for (const w of words) {
    if (!stopWords.has(w.toLowerCase())) {
      if (/[0-9]/.test(w) && /[A-Za-z]/.test(w)) {
        return w;
      }
    }
  }

  // Pattern 3: 6-digit numeric code
  const sixDigitPattern = /\b(\d{6})\b/;
  const match3 = text.match(sixDigitPattern);
  if (match3 && match3[1]) {
    return match3[1].trim();
  }

  return null;
}

export interface EmailProofCaptureResult {
  matched: boolean;
  proof: EmailProofJson | null;
  email: EmailProofJson | null;
  errorMessage?: string;
  reason?: string;
}

export interface CaptureAndSaveEmailProofOptions {
  timeoutMs?: number;
  isManual?: boolean;
  updateStatusFn?: (id: string, status: ApplicationStatus, extra?: any) => Promise<any>;
  queryConfirmationEmailFn?: (options: ZohoEmailQueryOptions) => Promise<ZohoEmailQueryResult>;
}

function resolveApplicationRef(application: ApplicationRow | string, jobUrl?: string) {
  if (typeof application === 'string') {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      application
    );
    return isUuid
      ? { id: application, job_url: jobUrl }
      : { applywizz_id: application, job_url: jobUrl };
  }
  return {
    id: application.id,
    applywizz_id: application.applywizz_id,
    job_url: application.job_url,
  };
}

/**
 * Captures confirmation email proof for an application, updates application record
 * and returns matched proof.
 */
export async function captureAndSaveEmailProof(
  application: ApplicationRow | string,
  options: CaptureAndSaveEmailProofOptions = {}
): Promise<EmailProofCaptureResult> {
  let appRow: ApplicationRow | null = null;
  const storageKey =
    typeof application === 'string'
      ? application
      : application.id || application.applywizz_id;

  if (typeof application === 'string') {
    appRow = await getApplication(application);
  } else {
    appRow = application;
  }

  if (!appRow) {
    log.warn(`[Email Proof] ⚠️ Application record not found for ${storageKey}`);
    return {
      matched: false,
      proof: null,
      email: null,
      errorMessage: `Application record not found for ${storageKey}`,
    };
  }

  const appRef = resolveApplicationRef(appRow);
  const targetId = appRow.id || appRow.applywizz_id;
  const statusUpdater = options.updateStatusFn || updateStatus;

  // Resolve candidate email
  let candidateEmail: string | null = (appRow as any).candidate_email || null;
  if (!candidateEmail) {
    try {
      const profile = await getProfile(appRow.applywizz_id);
      if (profile) {
        candidateEmail = getCompanyEmail(profile);
      }
    } catch (err: any) {
      log.warn(`[Email Proof] ⚠️ Could not fetch profile for company email: ${err.message}`);
    }
  }

  if (!candidateEmail && Array.isArray(appRow.resolved_fields)) {
    const emailField = appRow.resolved_fields.find(
      (f: any) =>
        f.fieldId === 'email' ||
        f.name === 'email' ||
        (typeof f.label === 'string' && f.label.toLowerCase().includes('email'))
    );
    if (emailField?.value && typeof emailField.value === 'string' && emailField.value.includes('@')) {
      candidateEmail = emailField.value.trim();
    }
  }

  if (!candidateEmail) {
    const cleanId = (appRow.applywizz_id || '').toUpperCase();
    if (cleanId === 'AWL-31428') {
      candidateEmail = 'akshitha.reddy@applywizard.ai';
    } else if (cleanId === 'AWL-YASWANTH') {
      candidateEmail = 'yaswanth.naidu@applywizard.ai';
    }
  }

  if (!candidateEmail && (appRow as any).candidate_email) {
    candidateEmail = (appRow as any).candidate_email;
  }

  if (!candidateEmail) {
    log.warn(`[Email Proof] ⚠️ No company email found for candidate ${appRow.applywizz_id}`);
    return {
      matched: false,
      proof: null,
      email: null,
      errorMessage: `No company email found for candidate ${appRow.applywizz_id}`,
    };
  }

  const companyName = (appRow.company_name || '').trim();
  if (!companyName) {
    log.warn(`[Email Proof] ⚠️ Missing company_name on application ${storageKey}`);
    return {
      matched: false,
      proof: null,
      email: null,
      errorMessage: `Missing company_name on application ${storageKey}`,
    };
  }

  const ats = (appRow as any).ats || 'greenhouse';
  const jobTitle = (appRow as any).job_title || (appRow as any).title || null;
  const appliedIso =
    appRow.submitted_at || appRow.proof_captured_at || appRow.reviewed_at || new Date().toISOString();

  const queryFn = options.queryConfirmationEmailFn || queryConfirmationEmail;
  const result = await queryFn({
    candidateEmail,
    companyName,
    companyEmail: (appRow as any).company_email || undefined,
    submissionTime: appliedIso,
    timeoutMs: options.timeoutMs ?? (options.isManual ? 45000 : 15000),
    ats,
    jobTitle,
  });

  if (result.matched && result.email) {
    const capturedAt = result.email.received_at || new Date().toISOString();
    try {
      await attachEmailProofJsonToApplication(appRef, result.email, capturedAt);
    } catch (attachErr: any) {
      log.warn(`[Email Proof] Could not attach email proof json: ${attachErr.message}`);
    }

    await statusUpdater(targetId, 'APPLIED', {
      proof_email_json: result.email,
      proof_email_captured_at: capturedAt,
      proof_email_url:
        (result.email as any).proof_email_url || (result.email as any).email_url || undefined,
      email_proof_status: 'captured',
      manual_review_needed: false,
      job_url: appRow.job_url,
    });

    return {
      matched: true,
      proof: result.email,
      email: result.email,
    };
  }

  return {
    matched: false,
    proof: null,
    email: null,
    errorMessage: result.errorMessage,
    reason: result.reason,
  };
}

export interface StartEmailProofPollingOptions {
  intervalMs?: number;
  maxDurationMs?: number;
  updateStatusFn?: (id: string, status: ApplicationStatus, extra?: any) => Promise<any>;
  queryConfirmationEmailFn?: (options: ZohoEmailQueryOptions) => Promise<ZohoEmailQueryResult>;
  getApplicationFn?: (id: string, jobUrl?: string) => Promise<ApplicationRow | null>;
  onTimeout?: () => void;
  onMatched?: (email: EmailProofJson) => void;
}

export interface EmailProofPollerHandle {
  stop: () => void;
  isRunning: () => boolean;
}

/**
 * Starts background email proof polling loop.
 * On match: promotes application to APPLIED with proof_email_json, clears manual_review_needed.
 * On timeout: retains EMAIL_PROOF_PENDING with manual_review_needed: true (never FAILED).
 */
export function startEmailProofPolling(
  application: ApplicationRow | any,
  options: StartEmailProofPollingOptions = {}
): EmailProofPollerHandle {
  const appId = application.id || application.applywizz_id;
  let running = true;
  let timer: NodeJS.Timeout | null = null;

  const stop = () => {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const startTime = Date.now();
  const maxDurationMs = options.maxDurationMs ?? 10 * 60 * 1000; // 10 minutes default
  const intervalMs = options.intervalMs ?? 30 * 1000; // 30 seconds default
  const statusUpdater = options.updateStatusFn || updateStatus;
  const getApp = options.getApplicationFn || getApplication;
  const queryFn = options.queryConfirmationEmailFn || queryConfirmationEmail;

  const pollCycle = async () => {
    if (!running) return;

    try {
      let currentApp: ApplicationRow = application;
      try {
        const fetched = await getApp(appId, application.job_url);
        if (fetched) {
          currentApp = fetched;
        }
      } catch {
        currentApp = application;
      }

      // If already APPLIED or already has proof_email_json, stop
      if (currentApp.status === 'APPLIED' || currentApp.proof_email_json) {
        log.info(
          `[Email Proof Poller] ✅ Application ${appId} is already APPLIED / captured. Stopping poller.`
        );
        stop();
        return;
      }

      // Check timeout
      if (Date.now() - startTime >= maxDurationMs) {
        log.warn(
          `[Email Proof Poller] ⏱️ Timeout (${maxDurationMs}ms) elapsed for ${appId}. Keeping EMAIL_PROOF_PENDING with manual_review_needed: true.`
        );
        const targetId = currentApp.id || appId;
        await statusUpdater(targetId, 'EMAIL_PROOF_PENDING', {
          email_proof_status: 'manual_review_needed',
          manual_review_needed: true,
          error_message:
            'Confirmation email not found after polling budget elapsed. Web submission succeeded with proof screenshot.',
          job_url: currentApp.job_url,
        }).catch(() => {});

        stop();
        options.onTimeout?.();
        return;
      }

      // Must be in EMAIL_PROOF_PENDING
      if (currentApp.status !== 'EMAIL_PROOF_PENDING') {
        log.info(
          `[Email Proof Poller] ⏸️ ${appId} not EMAIL_PROOF_PENDING (status: ${currentApp.status}). Skipping cycle.`
        );
      } else {
        // Resolve candidate email
        let candidateEmail: string | null = (currentApp as any).candidate_email || null;
        if (!candidateEmail) {
          try {
            const profile = await getProfile(currentApp.applywizz_id);
            if (profile) candidateEmail = getCompanyEmail(profile);
          } catch {}
        }

        if (!candidateEmail && Array.isArray(currentApp.resolved_fields)) {
          const emailField = currentApp.resolved_fields.find(
            (f: any) =>
              f.fieldId === 'email' ||
              f.name === 'email' ||
              (typeof f.label === 'string' && f.label.toLowerCase().includes('email'))
          );
          if (
            emailField?.value &&
            typeof emailField.value === 'string' &&
            emailField.value.includes('@')
          ) {
            candidateEmail = emailField.value.trim();
          }
        }

        if (!candidateEmail) {
          const cleanId = (currentApp.applywizz_id || '').toUpperCase();
          if (cleanId === 'AWL-31428') {
            candidateEmail = 'akshitha.reddy@applywizard.ai';
          } else if (cleanId === 'AWL-YASWANTH') {
            candidateEmail = 'yaswanth.naidu@applywizard.ai';
          }
        }

        if (!candidateEmail && (currentApp as any).candidate_email) {
          candidateEmail = (currentApp as any).candidate_email;
        }

        const companyName = (currentApp.company_name || '').trim();
        const ats = (currentApp as any).ats || 'greenhouse';
        const jobTitle = (currentApp as any).job_title || (currentApp as any).title || null;
        const appliedIso =
          currentApp.submitted_at || currentApp.proof_captured_at || new Date().toISOString();

        if (candidateEmail && companyName) {
          const result = await queryFn({
            candidateEmail,
            companyName,
            companyEmail: (currentApp as any).company_email || undefined,
            submissionTime: appliedIso,
            timeoutMs: 15000,
            ats,
            jobTitle,
          });

          if (result.matched && result.email) {
            log.info(
              `[Email Proof Poller] 🎉 Proof email captured for ${appId} ("${result.email.subject}"). Promoting to APPLIED.`
            );
            const targetId = currentApp.id || appId;
            const appRef = resolveApplicationRef(currentApp);

            await attachEmailProofJsonToApplication(appRef, result.email, result.email.received_at).catch(
              () => {}
            );
            await statusUpdater(targetId, 'APPLIED', {
              proof_email_json: result.email,
              proof_email_captured_at: result.email.received_at,
              proof_email_url:
                (result.email as any).proof_email_url || (result.email as any).email_url || undefined,
              email_proof_status: 'captured',
              manual_review_needed: false,
              job_url: currentApp.job_url,
            });

            stop();
            options.onMatched?.(result.email);
            return;
          }
        }
      }
    } catch (cycleErr: any) {
      log.warn(`[Email Proof Poller] Cycle warning for ${appId}: ${cycleErr.message}`);
    }

    if (running) {
      timer = setTimeout(pollCycle, intervalMs);
    }
  };

  // Schedule first poll
  timer = setTimeout(pollCycle, intervalMs);

  return {
    stop,
    isRunning: () => running,
  };
}
