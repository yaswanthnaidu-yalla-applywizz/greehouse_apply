/**
 * @fileoverview Zoho Mail Connector Service.
 *
 * Directly queries Zoho Mail inbox via the connector REST API:
 * 1. Filters messages by submission timestamp window:
 *    (received_time >= submission_time AND received_time <= submission_time + 10min)
 * 2. Filters to Greenhouse confirmation mail only:
 *    from CONTAINS greenhouse-mail.io AND subject looks like an application confirmation.
 *    OTP / security-code mail is always rejected.
 * 3. Filters by company:
 *    (from_address CONTAINS company_email OR subject CONTAINS company_name)
 * 4. Extracts structured JSON (from, to, subject, received_at, body_text, body_html).
 *    NEVER takes screenshots — returns pure email JSON payload.
 * 5. Gracefully handles zero-match cases.
 */

import { config } from '../config/env.js';
import type { EmailProofJson } from '../db/applications.js';
import { createLogger } from '../utils/logger.js';
import { mailboxRateLimiter } from './mailboxRateLimiter.js';

const log = createLogger('Zoho Connector');

export interface ZohoEmailQueryOptions {
  candidateEmail: string;
  companyName: string;
  companyEmail?: string | null;
  submissionTime: string | number | Date;
  timeoutMs?: number;
}

export interface ZohoEmailQueryResult {
  success: boolean;
  matched: boolean;
  email: EmailProofJson | null;
  errorMessage?: string;
  scannedCount?: number;
  window?: {
    minTimeIso: string;
    maxTimeIso: string;
    submissionTimeIso: string;
  };
}

interface RawZohoInboxMessage {
  messageId: string;
  subject?: string;
  from?: string;
  to?: string;
  receivedTime?: unknown;
  folderId?: string;
  hasAttachment?: boolean;
}

interface RawZohoInboxResponse {
  email?: string;
  accountId?: string;
  folder?: { folderId?: string };
  messages?: RawZohoInboxMessage[];
  count?: number;
  totalMatched?: number;
}

interface RawZohoMessageResponse {
  message?: {
    messageId: string;
    subject?: string;
    from?: string;
    to?: string;
    receivedTime?: unknown;
    textContent?: string;
    htmlContent?: string;
  };
}

/** Greenhouse sends both confirmation and OTP mail from this domain. */
const GREENHOUSE_PROOF_SENDER = 'greenhouse-mail.io';

/** Subject shapes that identify an application confirmation email. */
const CONFIRMATION_SUBJECT_PATTERN =
  /thank you|application received|application confirmed|journey.*started|application.*submitted|received.*application/i;

/** Subject shapes that identify an OTP / security-code email — never valid proof. */
const OTP_SUBJECT_PATTERN = /security code|\botp\b|one[-\s]?time (pass)?code/i;

function stripHtml(html: string): string {
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

/**
 * Normalizes company name for robust substring matching.
 * Strips common corporate suffixes ("Inc", "LLC", "Ltd", "Technologies", "Corp").
 */
function normalizeCompanyName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|technologies|tech|solutions|co)\b[.]?/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function getErrorCategory(error: unknown): string {
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
 * Queries Zoho Mail connector API to find an application confirmation email
 * matching all of:
 * 1. Timestamp window: [submission_time, submission_time + 10min]
 * 2. Greenhouse confirmation mail: from CONTAINS greenhouse-mail.io AND a confirmation
 *    subject; OTP / security-code subjects are rejected.
 * 3. Company criteria: (from_address CONTAINS company_email OR subject CONTAINS company_name)
 */
export async function queryZohoConfirmationEmail(
  options: ZohoEmailQueryOptions
): Promise<ZohoEmailQueryResult> {
  const candidateEmail = (options.candidateEmail || '').trim().toLowerCase();
  const companyName = (options.companyName || '').trim();
  const companyEmail = (options.companyEmail || '').trim().toLowerCase();

  if (!candidateEmail) {
    return {
      success: false,
      matched: false,
      email: null,
      errorMessage: 'Candidate email is required to query Zoho Mail inbox.',
    };
  }

  if (!companyName && !companyEmail) {
    return {
      success: false,
      matched: false,
      email: null,
      errorMessage: 'Company name or company email is required to verify confirmation email.',
    };
  }

  // Parse submission time. Proof mail must arrive at or after submission — never before,
  // otherwise the OTP mail that preceded the submit gets captured as proof.
  const subDate = new Date(options.submissionTime);
  const submissionMs = !Number.isNaN(subDate.getTime()) ? subDate.getTime() : Date.now();
  // Matches the 10-minute retry budget of emailProofPoller, so a late confirmation
  // that still arrives while the poller is running is accepted.
  const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  const minTimeMs = submissionMs;
  const maxTimeMs = submissionMs + WINDOW_MS;

  const minTimeIso = new Date(minTimeMs).toISOString();
  const maxTimeIso = new Date(maxTimeMs).toISOString();
  const submissionTimeIso = new Date(submissionMs).toISOString();

  const baseUrl = (config.ZOHO_CONNECTOR_URL || 'https://zoho-mail-reader.onrender.com/').replace(/\/+$/, '');
  const normCompany = normalizeCompanyName(companyName);
  const companyLower = companyName.toLowerCase();

  log.info(
    `[Zoho Connector] 🔍 Querying inbox for ${candidateEmail} | Window: [${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}] | Company: "${companyName}" (Email: "${companyEmail || 'none'}")`
  );

  try {
    const inboxUrl = `${baseUrl}/api/zoho/ui/inbox?email=${encodeURIComponent(candidateEmail)}&limit=40&start=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25000);

    // This REST path carries no client-side credentials: the connector holds Zoho OAuth
    // tokens per mailbox, so a "Mailbox not connected" 400 means the mailbox needs linking.
    log.info(`[Zoho Connector] 🌐 GET ${inboxUrl} (no auth header — server-side mailbox OAuth)`);

    const res = await fetch(inboxUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    log.info(
      `[Zoho Connector] 🌐 Inbox response: HTTP ${res.status} ${res.statusText} | content-type: ${
        res.headers.get('content-type') || 'unknown'
      }`
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.error(`[Zoho Connector] ❌ Raw error body: ${errText.slice(0, 500)}`);
      throw new Error(`Zoho connector returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    // Log the raw payload before parsing so malformed/unexpected shapes are visible
    const rawBody = await res.text();
    log.info(`[Zoho Connector] 📥 Raw inbox response (${rawBody.length} chars): ${rawBody.slice(0, 1500)}`);

    let data: RawZohoInboxResponse;
    try {
      data = JSON.parse(rawBody) as RawZohoInboxResponse;
    } catch (parseErr: any) {
      throw new Error(`Zoho connector returned non-JSON inbox response: ${parseErr.message}`);
    }

    const messages = data.messages || [];
    const accountId = data.accountId;

    log.info(
      `[Zoho Connector] 📬 Parsed ${messages.length} emails (count=${data.count ?? 'n/a'}, totalMatched=${
        data.totalMatched ?? 'n/a'
      }, accountId=${accountId || 'none'}, folderId=${data.folder?.folderId || 'none'})`
    );
    messages.forEach((m, i) => {
      const ms = parseZohoReceivedTimestamp(m.receivedTime);
      log.info(
        `[Zoho Connector] 📧 [${i + 1}/${messages.length}] from="${m.from || ''}" | subject="${
          m.subject || ''
        }" | receivedAt=${ms === null ? 'UNPARSEABLE' : new Date(ms).toISOString()}`
      );
    });

    if (!messages.length) {
      log.info(`[Zoho Connector] ℹ️ Inbox is empty for ${candidateEmail}. Zero matches.`);
      return {
        success: false,
        matched: false,
        email: null,
        scannedCount: 0,
        errorMessage: `No emails found in inbox for ${candidateEmail}.`,
        window: { minTimeIso, maxTimeIso, submissionTimeIso },
      };
    }

    // Iterate through messages to find an exact match satisfying ALL conditions:
    // (received_time >= submission_time AND received_time <= submission_time + 10min)
    // AND from CONTAINS greenhouse-mail.io AND subject is a confirmation (not an OTP)
    // AND (from_address CONTAINS company_email OR subject CONTAINS company_name)
    let matchingMsg: RawZohoInboxMessage | null = null;
    let matchingReceivedMs = 0;

    for (const msg of messages) {
      const receivedMs = parseZohoReceivedTimestamp(msg.receivedTime);
      if (receivedMs === null) {
        continue;
      }

      const fromAddress = (msg.from || '').toLowerCase();
      const subject = (msg.subject || '').toLowerCase();
      const normSubject = normalizeCompanyName(msg.subject || '');

      // 1. Never accept OTP / security-code mail as proof
      if (OTP_SUBJECT_PATTERN.test(subject)) {
        log.info(`[Zoho Connector] 🚫 Rejected email (OTP/security code): ${msg.subject || ''}`);
        continue;
      }

      // 2. Sender gate: Greenhouse proof mail only
      if (!fromAddress.includes(GREENHOUSE_PROOF_SENDER)) {
        continue;
      }
      const matchesConfirmationPattern = CONFIRMATION_SUBJECT_PATTERN.test(subject);

      // 3. Strict Timestamp Filter: at or after submission, within 10 minutes
      const isTimeMatch = receivedMs >= minTimeMs && receivedMs <= maxTimeMs;
      if (!isTimeMatch) {
        continue;
      }

      // 4. Company Filter:
      // from_address CONTAINS company_email OR subject CONTAINS company_name
      const fromContainsCompanyEmail = Boolean(
        companyEmail && companyEmail.length > 3 && fromAddress.includes(companyEmail)
      );

      const subjectContainsCompanyName = Boolean(
        (companyLower && companyLower.length > 2 && subject.includes(companyLower)) ||
        (normCompany && normCompany.length > 2 && normSubject.includes(normCompany))
      );

      const fromContainsCompanyName = Boolean(
        (companyLower && companyLower.length > 2 && fromAddress.includes(companyLower)) ||
        (normCompany && normCompany.length > 2 && fromAddress.includes(normCompany))
      );

      const isCompanyMatch = fromContainsCompanyEmail || subjectContainsCompanyName || fromContainsCompanyName;

      // Accept if company matches AND either confirmation pattern matches or subject contains company name
      if (isCompanyMatch && (matchesConfirmationPattern || subjectContainsCompanyName)) {
        matchingMsg = msg;
        matchingReceivedMs = receivedMs;
        break;
      }
    }

    // Zero-match case handled gracefully
    if (!matchingMsg) {
      log.info(
        `[Zoho Connector] ⚠️ Zero confirmation matches for ${candidateEmail} among ${messages.length} messages in window [${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}] for company "${companyName}".`
      );
      return {
        success: false,
        matched: false,
        email: null,
        scannedCount: messages.length,
        errorMessage: `Greenhouse confirmation email not found within 10 minutes after submission (${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}) for company "${companyName}".`,
        window: { minTimeIso, maxTimeIso, submissionTimeIso },
      };
    }

    // Match verified! Fetch full message body
    const folderId = matchingMsg.folderId || data.folder?.folderId;
    let textContent = '';
    let htmlContent = '';
    let fullSubject = matchingMsg.subject || 'Application Confirmation';
    let fullFrom = matchingMsg.from || 'Unknown';
    let fullTo = matchingMsg.to || candidateEmail;

    if (accountId && folderId && matchingMsg.messageId) {
      try {
        const msgQs = new URLSearchParams({
          email: candidateEmail,
          accountId,
          folderId,
          messageId: matchingMsg.messageId,
        });
        const msgRes = await fetch(`${baseUrl}/api/zoho/ui/message?${msgQs}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });

        if (msgRes.ok) {
          const msgData = (await msgRes.json()) as RawZohoMessageResponse;
          if (msgData.message) {
            fullSubject = msgData.message.subject || fullSubject;
            fullFrom = msgData.message.from || fullFrom;
            fullTo = msgData.message.to || fullTo;
            htmlContent = msgData.message.htmlContent || '';
            textContent = msgData.message.textContent || stripHtml(htmlContent);
          }
        }
      } catch (err: any) {
        log.warn(`[Zoho Connector] ⚠️ Failed to fetch full message body: ${err.message}`);
      }
    }

    if (!textContent && htmlContent) {
      textContent = stripHtml(htmlContent);
    }

    const receivedAtIso = new Date(matchingReceivedMs).toISOString();

    log.info(
      `[Zoho Connector] 🎉 Proof email captured: ${fullSubject} from ${fullFrom} at ${receivedAtIso}`
    );

    const emailResult: EmailProofJson = {
      from: fullFrom,
      to: fullTo,
      subject: fullSubject,
      received_at: receivedAtIso,
      body_text: textContent || fullSubject,
      body_html: htmlContent || undefined,
    };

    return {
      success: true,
      matched: true,
      email: emailResult,
      scannedCount: messages.length,
      window: { minTimeIso, maxTimeIso, submissionTimeIso },
    };
  } catch (err: any) {
    log.error(`[Zoho Connector] ❌ Error querying Zoho Mail for ${candidateEmail}: ${err.message}`);
    return {
      success: false,
      matched: false,
      email: null,
      errorMessage: err.message || 'Failed to query Zoho Mail connector.',
      window: { minTimeIso, maxTimeIso, submissionTimeIso },
    };
  }
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

export interface ZohoOtpApiQueryOptions {
  candidateEmail: string;
  correlationId?: string;
  sinceTimestamp: number;
  companyName?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  newerThanTimestamp?: number;
  excludedMessageIds?: string[];
  excludedCodes?: string[];
}

export interface ZohoOtpApiResult {
  success: boolean;
  otp?: string;
  subject?: string;
  receivedAt?: string;
  receivedAtMs?: number;
  messageId?: string;
  errorMessage?: string;
  reason?: string;
  reasonCode?: string;
}

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

/**
 * Fast REST API-based OTP polling service.
 * Repeatedly queries the Zoho connector REST API at `pollIntervalMs` (default 2000ms)
 * until a matching Greenhouse security code email arrives or `timeoutMs` expires.
 */
export async function fetchZohoOtpViaApi(
  options: ZohoOtpApiQueryOptions
): Promise<ZohoOtpApiResult> {
  const candidateEmail = (options.candidateEmail || '').trim().toLowerCase();
  const sinceTimestamp = options.sinceTimestamp;
  const timeoutMs = options.timeoutMs ?? 30000;
  const pollIntervalMs = options.pollIntervalMs ?? 4000;
  const companyName = (options.companyName || '').trim();
  const validEmailFormat = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail);

  if (!candidateEmail || !validEmailFormat) {
    log.error(
      `[Zoho Connector] event=otp_preflight_failed correlation_id=${options.correlationId || 'unknown'} ` +
        `reason=INVALID_CANDIDATE_EMAIL email_present=${Boolean(candidateEmail)} ` +
        `email_format_valid=${validEmailFormat}`
    );
    return {
      success: false,
      reason: candidateEmail ? 'invalid email format' : 'email unavailable',
      reasonCode: 'INVALID_CANDIDATE_EMAIL',
      errorMessage: candidateEmail
        ? 'Candidate email has an invalid format for OTP resolution.'
        : 'Candidate email is required for OTP resolution.',
    };
  }
  if (!Number.isFinite(sinceTimestamp) || sinceTimestamp <= 0) {
    log.error(
      `[Zoho Connector] event=otp_preflight_failed correlation_id=${options.correlationId || 'unknown'} ` +
        `reason=INVALID_SUBMIT_TIMESTAMP timestamp_finite=${Number.isFinite(sinceTimestamp)}`
    );
    return {
      success: false,
      reason: 'invalid submit timestamp',
      reasonCode: 'INVALID_SUBMIT_TIMESTAMP',
      errorMessage: 'A valid submit-click timestamp is required for OTP resolution.',
    };
  }

  const baseUrl = (config.ZOHO_CONNECTOR_URL || 'https://zoho-mail-reader.onrender.com/').replace(
    /\/+$/,
    ''
  );
  const minTimeMs = sinceTimestamp - OTP_EMAIL_CLOCK_SKEW_MS;
  const excludedMessageIds = new Set(options.excludedMessageIds || []);
  const excludedCodes = new Set(options.excludedCodes || []);
  const startTime = Date.now();
  let attempt = 0;
  let successfulInboxResponses = 0;
  let inboxHttpErrors = 0;
  let inboxNetworkErrors = 0;
  let malformedInboxResponses = 0;
  let securityCodeMessages = 0;
  let freshSecurityCodeMessages = 0;
  let companyMismatches = 0;
  let detailRequestFailures = 0;
  let staleOrInvalidTimestamps = 0;
  let missingTimestamps = 0;
  let staleTimestamps = 0;
  let nonNewerTimestamps = 0;
  let messagesWithoutCodes = 0;
  let excludedMessageIdCount = 0;
  let messagesWithoutIds = 0;
  let nonGreenhouseSenders = 0;
  let nonSecuritySubjects = 0;
  let detailContextMissing = 0;
  let ambiguousCompanyCandidates = false;
  const inboxHttpStatusCounts: Record<string, number> = {};
  const detailHttpStatusCounts: Record<string, number> = {};
  const networkErrorCounts: Record<string, number> = {};
  const correlation = options.correlationId || 'unknown';

  log.info(
    `[Zoho Connector] event=otp_fetch_started application=${correlation} ` +
      `poll_interval_ms=${pollIntervalMs} budget_ms=${timeoutMs} ` +
      `submit_age_ms=${Math.max(0, Date.now() - sinceTimestamp)} company_match_enabled=${companyName.length > 2} ` +
      `excluded_message_count=${excludedMessageIds.size} excluded_code_count=${excludedCodes.size}`
  );

  while (timeoutMs - (Date.now() - startTime) >= pollIntervalMs || attempt === 0) {
    attempt++;
    const cycleStart = Date.now();

    try {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startTime));
      const inboxUrl = `${baseUrl}/api/zoho/ui/inbox?email=${encodeURIComponent(
        candidateEmail
      )}&limit=15&start=1`;
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), Math.min(10000, remainingMs));

      await mailboxRateLimiter.acquire();
      const res = await fetch(inboxUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(fetchTimeout));
      const inboxStatusKey = String(res.status);
      inboxHttpStatusCounts[inboxStatusKey] = (inboxHttpStatusCounts[inboxStatusKey] || 0) + 1;

      if (res.ok) {
        successfulInboxResponses++;
        const rawBody = await res.text();
        let data: RawZohoInboxResponse | null = null;
        try {
          data = JSON.parse(rawBody) as RawZohoInboxResponse;
        } catch {
          data = null;
        }

        const messages = Array.isArray(data?.messages) ? data.messages : [];
        if (!data || !Array.isArray(data.messages)) malformedInboxResponses++;
        const accountId = data?.accountId;

        const freshMessages: Array<{
          otp?: string;
          messageId: string;
          subject: string;
          receivedMs: number;
          companyMatched: boolean;
          matchTier: 1 | 2 | 3;
          excludedCode: boolean;
        }> = [];

        for (const msg of messages) {
          const fromAddress = (msg.from || '').toLowerCase();
          const subject = msg.subject || '';
          const subjectLower = subject.toLowerCase();
          const messageId = msg.messageId || '';

          if (!messageId) {
            messagesWithoutIds++;
            continue;
          }
          if (excludedMessageIds.has(messageId)) {
            excludedMessageIdCount++;
            continue;
          }

          // Senders that deliver Greenhouse security codes
          const isGreenhouseSender =
            fromAddress.includes('greenhouse-mail.io') ||
            fromAddress.includes('no-reply@us.greenhouse-mail.io') ||
            fromAddress.includes('greenhouse');

          if (!isGreenhouseSender) {
            nonGreenhouseSenders++;
            continue;
          }

          // Subject must indicate a security / verification code
          const isSecurityCodeSubject =
            /security\s*code|\botp\b|verification\s*code|verify/i.test(subjectLower);

          if (!isSecurityCodeSubject) {
            nonSecuritySubjects++;
            continue;
          }
          securityCodeMessages++;

          const folderId = msg.folderId || data?.folder?.folderId;
          let msgData: RawZohoMessageResponse | null = null;
          if (accountId && folderId) {
            try {
              const msgQs = new URLSearchParams({
                email: candidateEmail,
                accountId,
                folderId,
                messageId,
              });
              const detailController = new AbortController();
              const detailTimeout = setTimeout(
                () => detailController.abort(),
                Math.min(10000, Math.max(1, timeoutMs - (Date.now() - startTime)))
              );
              const msgRes = await fetch(`${baseUrl}/api/zoho/ui/message?${msgQs}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: detailController.signal,
              }).finally(() => clearTimeout(detailTimeout));
              if (msgRes.ok) {
                msgData = (await msgRes.json()) as RawZohoMessageResponse;
              } else {
                detailRequestFailures++;
                const statusKey = String(msgRes.status);
                detailHttpStatusCounts[statusKey] = (detailHttpStatusCounts[statusKey] || 0) + 1;
              }
            } catch (error: unknown) {
              detailRequestFailures++;
              const category = getErrorCategory(error);
              networkErrorCounts[`detail_${category}`] = (networkErrorCounts[`detail_${category}`] || 0) + 1;
            }
          } else {
            detailRequestFailures++;
            detailContextMissing++;
          }

          const listReceivedMs = parseZohoReceivedTimestamp(msg.receivedTime);
          const detailReceivedMs = parseZohoReceivedTimestamp(msgData?.message?.receivedTime);
          const receivedMs = listReceivedMs ?? detailReceivedMs;
          if (receivedMs === null) {
            missingTimestamps++;
            staleOrInvalidTimestamps++;
            continue;
          }
          if (receivedMs < minTimeMs) {
            staleTimestamps++;
            staleOrInvalidTimestamps++;
            continue;
          }
          if (
            options.newerThanTimestamp !== undefined &&
            receivedMs <= options.newerThanTimestamp
          ) {
            nonNewerTimestamps++;
            staleOrInvalidTimestamps++;
            continue;
          }

          freshSecurityCodeMessages++;
          const detailFrom = msgData?.message?.from || '';
          const bodyText =
            msgData?.message?.textContent || stripHtml(msgData?.message?.htmlContent || '');
          const extractedOtp = extractOtpCodeFromText(bodyText);
          const normalizedCompany = normalizeCompanyName(companyName);
          const subjectMatchesCompany =
            companyName.length > 2 &&
            (subjectLower.includes(companyName.toLowerCase()) ||
              (normalizedCompany.length > 2 &&
                normalizeCompanyName(subject).includes(normalizedCompany)));
          const bodyOrSenderMatchesCompany =
            companyName.length > 2 &&
            [fromAddress, detailFrom.toLowerCase(), bodyText.toLowerCase()].some(
                (value) =>
                  value.includes(companyName.toLowerCase()) ||
                  (normalizedCompany.length > 2 &&
                    normalizeCompanyName(value).includes(normalizedCompany))
              );
          const companyMatched = subjectMatchesCompany || bodyOrSenderMatchesCompany;
          if (!companyMatched) companyMismatches++;

          const excludedCode = Boolean(extractedOtp && excludedCodes.has(extractedOtp));
          if (!extractedOtp || excludedCode) {
            messagesWithoutCodes++;
          }
          freshMessages.push({
            otp: extractedOtp && !excludedCode ? extractedOtp : undefined,
            messageId,
            subject,
            receivedMs,
            companyMatched,
            matchTier: subjectMatchesCompany ? 1 : bodyOrSenderMatchesCompany ? 2 : 3,
            excludedCode,
          });
        }

        const companyMatches = freshMessages.filter(
          (message) => message.companyMatched && message.otp
        );
        const tierCCandidates = freshMessages.filter((message) => !message.excludedCode);
        const tierCMatches =
          tierCCandidates.length === 1 ? tierCCandidates.filter((message) => message.otp) : [];
        const candidates = companyMatches.length > 0 ? companyMatches : tierCMatches;
        if (tierCCandidates.length > 1 && companyMatches.length === 0) {
          ambiguousCompanyCandidates = true;
        }
        candidates.sort(
          (left, right) =>
            left.matchTier - right.matchTier || right.receivedMs - left.receivedMs
        );
        const newestMessage = candidates[0];
        if (newestMessage) {
          const receivedAt = new Date(newestMessage.receivedMs).toISOString();
          log.info(
            `[Zoho Connector] event=otp_fetch_succeeded application=${correlation} ` +
              `polls=${attempt} elapsed_ms=${Date.now() - startTime} ` +
              `match_tier=${newestMessage.matchTier} message_id=${newestMessage.messageId} ` +
              `received_at=${receivedAt} message_age_ms=${Math.max(0, Date.now() - newestMessage.receivedMs)} ` +
              `received_relative_to_submit_ms=${newestMessage.receivedMs - sinceTimestamp} ` +
              `email_code_length=${newestMessage.otp?.length ?? 0} code=[REDACTED] ` +
              `inbox_http_statuses=${JSON.stringify(inboxHttpStatusCounts)} ` +
              `security_messages=${securityCodeMessages} fresh_security_messages=${freshSecurityCodeMessages} ` +
              `company_mismatches=${companyMismatches} detail_failures=${detailRequestFailures}`
          );
          return {
            success: true,
            otp: newestMessage.otp,
            subject: newestMessage.subject,
            receivedAt,
            receivedAtMs: newestMessage.receivedMs,
            messageId: newestMessage.messageId,
          };
        }
      } else {
        inboxHttpErrors++;
        const status = res.status;
        try {
          await res.body?.cancel();
        } catch {
          // Response diagnostics use status and headers only; response bodies may contain PII.
        }
        if (status === 401 || status === 403 || status === 404) {
          log.warn(
            `[Zoho Connector] application=${correlation} status=${status} reason=MAILBOX_NOT_CONFIGURED`
          );
          return {
            success: false,
            reason: 'mailbox not configured',
            reasonCode: 'MAILBOX_NOT_CONFIGURED',
            errorMessage: 'Candidate mailbox is not configured upstream.',
          };
        }
      }
    } catch (error: unknown) {
      inboxNetworkErrors++;
      const category = getErrorCategory(error);
      networkErrorCounts[`inbox_${category}`] = (networkErrorCounts[`inbox_${category}`] || 0) + 1;
    }

    const elapsed = Date.now() - cycleStart;
    log.debug(
      `[Zoho Connector] event=otp_poll_cycle application=${correlation} poll=${attempt} ` +
        `elapsed_ms=${elapsed} inbox_ok=${successfulInboxResponses} inbox_http_errors=${inboxHttpErrors} ` +
        `inbox_network_errors=${inboxNetworkErrors} security_messages=${securityCodeMessages} ` +
        `fresh_security_messages=${freshSecurityCodeMessages} company_mismatches=${companyMismatches} ` +
        `detail_failures=${detailRequestFailures}`
    );
    if (successfulInboxResponses > 0 && freshSecurityCodeMessages === 0) {
      log.info(
        `[Zoho Connector] application=${correlation} poll=${attempt} found=false reason=not_yet`
      );
      return {
        success: false,
        reason: 'not_yet',
        reasonCode: securityCodeMessages === 0 ? 'NO_MESSAGES_SINCE_SUBMIT' : 'STALE_TIMESTAMPS_ONLY',
        errorMessage: 'Zoho OTP not yet received.',
      };
    }

    const remainingBudget = timeoutMs - (Date.now() - startTime);
    const sleepMs = Math.max(100, pollIntervalMs - elapsed);
    if (remainingBudget < pollIntervalMs || remainingBudget <= sleepMs) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  const reasonCode =
    attempt === 0
      ? 'POLL_BUDGET_EXHAUSTED'
      : successfulInboxResponses === 0
      ? inboxHttpErrors > 0
        ? 'ZOHO_INBOX_HTTP_ERROR'
        : inboxNetworkErrors > 0
          ? 'ZOHO_INBOX_UNAVAILABLE'
          : 'ZOHO_INBOX_INVALID_RESPONSE'
      : securityCodeMessages === 0
        ? 'NO_MESSAGES_SINCE_SUBMIT'
        : freshSecurityCodeMessages === 0
          ? 'STALE_TIMESTAMPS_ONLY'
          : ambiguousCompanyCandidates
            ? 'COMPANY_MISMATCH_MULTIPLE_CANDIDATES'
            : detailRequestFailures > 0
              ? 'DETAIL_FETCH_FAILED'
              : messagesWithoutCodes > 0
                ? 'NO_EXTRACTABLE_CODE'
                : malformedInboxResponses > 0
                  ? 'ZOHO_INBOX_INVALID_RESPONSE'
                  : 'NO_MATCHING_OTP_EMAIL';
  const reason = reasonCode.toLowerCase();
  const elapsedMs = Date.now() - startTime;
  log.warn(
    `[Zoho Connector] event=otp_fetch_failed application=${correlation} ` +
      `reason=${reasonCode} polls=${attempt} elapsed_ms=${elapsedMs} ` +
      `inbox_ok=${successfulInboxResponses}, inbox_http_errors=${inboxHttpErrors}, ` +
      `inbox_http_statuses=${JSON.stringify(inboxHttpStatusCounts)} ` +
      `detail_http_statuses=${JSON.stringify(detailHttpStatusCounts)} ` +
      `network_error_types=${JSON.stringify(networkErrorCounts)} ` +
      `inbox_network_errors=${inboxNetworkErrors}, malformed_inbox=${malformedInboxResponses}, ` +
      `security_messages=${securityCodeMessages}, fresh_security_messages=${freshSecurityCodeMessages}, ` +
      `company_mismatches=${companyMismatches}, missing_ids=${messagesWithoutIds}, ` +
      `excluded_ids=${excludedMessageIdCount}, non_greenhouse_senders=${nonGreenhouseSenders}, ` +
      `non_security_subjects=${nonSecuritySubjects}, missing_detail_context=${detailContextMissing}, ` +
      `detail_failures=${detailRequestFailures}, stale_or_invalid_timestamps=${staleOrInvalidTimestamps}, ` +
      `missing_timestamps=${missingTimestamps}, stale_timestamps=${staleTimestamps}, ` +
      `non_newer_timestamps=${nonNewerTimestamps}, messages_without_code=${messagesWithoutCodes}, ` +
      `ambiguous_candidates=${ambiguousCompanyCandidates}`
  );
  return {
    success: false,
    reason,
    reasonCode,
    errorMessage: `Automatic OTP fetch ended with ${reasonCode}.`,
  };
}

export interface GmailOtpApiQueryOptions extends ZohoOtpApiQueryOptions {}

export interface RawGmailInboxMessage {
  messageId: string;
  threadId?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  receivedAt?: number | string;
  hasAttachment?: boolean;
}

export interface RawGmailInboxResponse {
  email?: string;
  count?: number;
  hasMore?: boolean;
  nextPageToken?: string;
  messages?: RawGmailInboxMessage[];
  reason?: string;
}

export interface RawGmailMessageResponse {
  message?: {
    messageId: string;
    subject?: string;
    from?: string;
    to?: string;
    receivedAt?: number | string;
    textContent?: string;
    htmlContent?: string;
    labelNames?: string[];
  };
}

/**
 * Fetch Greenhouse security code via Gmail REST API endpoints:
 * 1. GET /api/gmail/ui/inbox?email=<candidateEmail>&limit=15
 * 2. GET /api/gmail/ui/message?email=<candidateEmail>&messageId=<messageId>
 */
export async function fetchGmailOtpViaApi(
  options: GmailOtpApiQueryOptions
): Promise<ZohoOtpApiResult> {
  const candidateEmail = (options.candidateEmail || '').trim().toLowerCase();
  const sinceTimestamp = options.sinceTimestamp;
  const companyName = (options.companyName || '').trim();
  const correlation = options.correlationId || 'unknown';
  const timeoutMs = options.timeoutMs ?? 30000;
  const pollIntervalMs = options.pollIntervalMs ?? 4000;

  const validEmailFormat = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail);
  if (!candidateEmail || !validEmailFormat) {
    log.error(
      `[Gmail Connector] event=gmail_otp_preflight_failed correlation_id=${correlation} ` +
        `reason=INVALID_CANDIDATE_EMAIL email_present=${Boolean(candidateEmail)} ` +
        `email_format_valid=${validEmailFormat}`
    );
    return {
      success: false,
      reason: candidateEmail ? 'invalid email format' : 'email unavailable',
      reasonCode: 'INVALID_CANDIDATE_EMAIL',
      errorMessage: candidateEmail
        ? 'Candidate email has an invalid format for OTP resolution.'
        : 'Candidate email is required for OTP resolution.',
    };
  }

  const baseUrl = (config.ZOHO_CONNECTOR_URL || 'https://zoho-mail-reader.onrender.com/').replace(
    /\/+$/,
    ''
  );

  const minTimeMs = (sinceTimestamp && Number.isFinite(sinceTimestamp) && sinceTimestamp > 0)
    ? sinceTimestamp - OTP_EMAIL_CLOCK_SKEW_MS
    : 0;
  const excludedMessageIds = new Set(options.excludedMessageIds || []);
  const excludedCodes = new Set(
    (options.excludedCodes || []).map((c) => c.trim().toLowerCase()).filter(Boolean)
  );

  const startTime = Date.now();
  let attempt = 0;
  let successfulInboxResponses = 0;
  let inboxHttpErrors = 0;
  let inboxNetworkErrors = 0;
  let securityCodeMessages = 0;
  let freshSecurityCodeMessages = 0;
  let companyMismatches = 0;
  let detailRequestFailures = 0;

  log.info(
    `[Gmail Connector] event=gmail_otp_fetch_started application=${correlation} ` +
      `email=${candidateEmail} company=${companyName} poll_interval_ms=${pollIntervalMs} budget_ms=${timeoutMs} ` +
      `submit_age_ms=${sinceTimestamp ? Math.max(0, Date.now() - sinceTimestamp) : 'n/a'}`
  );

  while (timeoutMs - (Date.now() - startTime) >= pollIntervalMs || attempt === 0) {
    attempt++;
    const cycleStart = Date.now();

    try {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startTime));
      const inboxUrl = `${baseUrl}/api/gmail/ui/inbox?email=${encodeURIComponent(
        candidateEmail
      )}&limit=15`;
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), Math.min(10000, remainingMs));

      await mailboxRateLimiter.acquire();
      const res = await fetch(inboxUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(fetchTimeout));

      if (res.ok) {
        successfulInboxResponses++;
        const data = (await res.json()) as RawGmailInboxResponse;
        const messages = Array.isArray(data?.messages) ? data.messages : [];

        const freshMessages: Array<{
          otp?: string;
          messageId: string;
          subject: string;
          receivedMs: number;
          companyMatched: boolean;
          matchTier: 1 | 2 | 3;
          excludedCode: boolean;
        }> = [];

        for (const msg of messages) {
          const fromAddress = (msg.from || '').toLowerCase();
          const subject = msg.subject || '';
          const subjectLower = subject.toLowerCase();
          const messageId = msg.messageId || '';

          if (!messageId || excludedMessageIds.has(messageId)) {
            continue;
          }

          const isGreenhouseSender =
            fromAddress.includes('greenhouse-mail.io') ||
            fromAddress.includes('no-reply@us.greenhouse-mail.io') ||
            fromAddress.includes('greenhouse');

          if (!isGreenhouseSender) {
            continue;
          }

          const isSecurityCodeSubject =
            /security\s*code|\botp\b|verification\s*code|verify/i.test(subjectLower);

          if (!isSecurityCodeSubject) {
            continue;
          }
          securityCodeMessages++;

          let msgData: RawGmailMessageResponse | null = null;
          try {
            const detailQs = new URLSearchParams({
              email: candidateEmail,
              messageId,
            });
            const detailController = new AbortController();
            const detailTimeout = setTimeout(
              () => detailController.abort(),
              Math.min(10000, Math.max(1, timeoutMs - (Date.now() - startTime)))
            );
            const msgRes = await fetch(`${baseUrl}/api/gmail/ui/message?${detailQs}`, {
              method: 'GET',
              headers: { 'Content-Type': 'application/json' },
              signal: detailController.signal,
            }).finally(() => clearTimeout(detailTimeout));

            if (msgRes.ok) {
              msgData = (await msgRes.json()) as RawGmailMessageResponse;
            } else {
              detailRequestFailures++;
            }
          } catch {
            detailRequestFailures++;
          }

          const rawReceived = msgData?.message?.receivedAt ?? msg.receivedAt;
          const receivedMs =
            typeof rawReceived === 'number'
              ? rawReceived
              : typeof rawReceived === 'string'
              ? Date.parse(rawReceived)
              : null;

          if (receivedMs === null || (minTimeMs > 0 && receivedMs < minTimeMs)) {
            continue;
          }
          if (
            options.newerThanTimestamp !== undefined &&
            receivedMs <= options.newerThanTimestamp
          ) {
            continue;
          }

          freshSecurityCodeMessages++;
          const detailFrom = msgData?.message?.from || '';
          const bodyText =
            msgData?.message?.textContent || stripHtml(msgData?.message?.htmlContent || '');
          const extractedOtp = extractOtpCodeFromText(bodyText);

          const normalizedCompany = normalizeCompanyName(companyName);
          const subjectMatchesCompany =
            companyName.length > 2 &&
            (subjectLower.includes(companyName.toLowerCase()) ||
              (normalizedCompany.length > 2 &&
                normalizeCompanyName(subject).includes(normalizedCompany)));
          const bodyOrSenderMatchesCompany =
            companyName.length > 2 &&
            [fromAddress, detailFrom.toLowerCase(), bodyText.toLowerCase()].some(
              (value) =>
                value.includes(companyName.toLowerCase()) ||
                (normalizedCompany.length > 2 &&
                  normalizeCompanyName(value).includes(normalizedCompany))
            );
          const companyMatched = subjectMatchesCompany || bodyOrSenderMatchesCompany;
          if (!companyMatched) companyMismatches++;

          const excludedCode = Boolean(extractedOtp && excludedCodes.has(extractedOtp.toLowerCase()));

          freshMessages.push({
            otp: extractedOtp && !excludedCode ? extractedOtp : undefined,
            messageId,
            subject,
            receivedMs,
            companyMatched,
            matchTier: subjectMatchesCompany ? 1 : bodyOrSenderMatchesCompany ? 2 : 3,
            excludedCode,
          });
        }

        const companyMatches = freshMessages.filter(
          (message) => message.companyMatched && message.otp
        );
        const tierCCandidates = freshMessages.filter((message) => !message.excludedCode);
        const tierCMatches =
          tierCCandidates.length === 1 ? tierCCandidates.filter((message) => message.otp) : [];
        const candidates = companyMatches.length > 0 ? companyMatches : tierCMatches;

        candidates.sort(
          (left, right) =>
            left.matchTier - right.matchTier || right.receivedMs - left.receivedMs
        );

        const newestMessage = candidates[0];
        if (newestMessage) {
          const receivedAt = new Date(newestMessage.receivedMs).toISOString();
          log.info(
            `[Gmail Connector] event=gmail_otp_fetch_succeeded application=${correlation} ` +
              `polls=${attempt} elapsed_ms=${Date.now() - startTime} ` +
              `match_tier=${newestMessage.matchTier} message_id=${newestMessage.messageId} ` +
              `received_at=${receivedAt} email_code_length=${newestMessage.otp?.length ?? 0} code=[REDACTED]`
          );
          return {
            success: true,
            otp: newestMessage.otp,
            subject: newestMessage.subject,
            receivedAt,
            receivedAtMs: newestMessage.receivedMs,
            messageId: newestMessage.messageId,
          };
        }
      } else {
        inboxHttpErrors++;
        const status = res.status;
        try {
          await res.body?.cancel();
        } catch {
          // Response diagnostics use status and headers only
        }
        if (status === 401 || status === 403 || status === 404) {
          log.warn(
            `[Gmail Connector] application=${correlation} status=${status} reason=MAILBOX_NOT_CONFIGURED`
          );
          return {
            success: false,
            reason: 'mailbox not configured',
            reasonCode: 'MAILBOX_NOT_CONFIGURED',
            errorMessage: 'Candidate mailbox is not configured upstream.',
          };
        }
      }
    } catch (err: unknown) {
      inboxNetworkErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `[Gmail Connector] application=${correlation} poll=${attempt} request_error=${msg}`
      );
    }

    const elapsed = Date.now() - cycleStart;
    log.debug(
      `[Gmail Connector] event=otp_poll_cycle application=${correlation} poll=${attempt} ` +
        `elapsed_ms=${elapsed} inbox_ok=${successfulInboxResponses} inbox_http_errors=${inboxHttpErrors} ` +
        `inbox_network_errors=${inboxNetworkErrors} security_messages=${securityCodeMessages} ` +
        `fresh_security_messages=${freshSecurityCodeMessages} company_mismatches=${companyMismatches} ` +
        `detail_failures=${detailRequestFailures}`
    );

    if (successfulInboxResponses > 0 && freshSecurityCodeMessages === 0 && attempt === 1) {
      log.info(
        `[Gmail Connector] application=${correlation} poll=${attempt} found=false reason=not_yet`
      );
      return {
        success: false,
        reason: 'not_yet',
        reasonCode: securityCodeMessages === 0 ? 'NO_MESSAGES_SINCE_SUBMIT' : 'STALE_TIMESTAMPS_ONLY',
        errorMessage: 'Gmail OTP not yet received.',
      };
    }

    const remainingBudget = timeoutMs - (Date.now() - startTime);
    const sleepMs = Math.max(100, pollIntervalMs - elapsed);
    if (remainingBudget < pollIntervalMs || remainingBudget <= sleepMs) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  const elapsedMs = Date.now() - startTime;
  log.warn(
    `[Gmail Connector] event=gmail_otp_fetch_timeout application=${correlation} polls=${attempt} elapsed_ms=${elapsedMs}`
  );

  return {
    success: false,
    reason: 'no matching gmail otp code found',
    reasonCode: 'GMAIL_OTP_NOT_FOUND',
    errorMessage: `Automatic Gmail OTP fetch timed out after ${elapsedMs}ms across ${attempt} poll attempts.`,
  };
}
