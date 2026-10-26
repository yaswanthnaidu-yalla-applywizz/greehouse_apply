/**
 * @fileoverview Zoho Mail Strategy for confirmation emails and OTP polling.
 */

import { config } from '../../config/env.js';
import type { EmailProofJson } from '../../db/applications.js';
export type { EmailProofJson };
import { createLogger } from '../../utils/logger.js';
import { mailboxRateLimiter } from '../mailboxRateLimiter.js';
import {
  OTP_EMAIL_CLOCK_SKEW_MS,
  parseZohoReceivedTimestamp,
  extractOtpCodeFromText,
  stripHtml,
  normalizeCompanyName,
  getErrorCategory,
} from './inboxPoller.js';

const log = createLogger('Zoho Connector');

export interface ZohoEmailQueryOptions {
  candidateEmail: string;
  companyName: string;
  companyEmail?: string | null;
  submissionTime: string | number | Date;
  timeoutMs?: number;
  allowHistorical?: boolean;
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
  hasMore?: boolean;
  nextStart?: number;
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

const GREENHOUSE_PROOF_SENDER = 'greenhouse-mail.io';
const CONFIRMATION_SUBJECT_PATTERN =
  /thank you|application received|application confirmed|journey.*started|application.*submitted|received.*application/i;
const OTP_SUBJECT_PATTERN = /security code|\botp\b|one[-\s]?time (pass)?code/i;

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

  const subDate = new Date(options.submissionTime);
  const submissionMs = !Number.isNaN(subDate.getTime()) ? subDate.getTime() : Date.now();
  const WINDOW_MS = 10 * 60 * 1000;
  const minTimeMs = options.allowHistorical ? submissionMs - 2 * 60 * 1000 : submissionMs;
  const maxTimeMs = options.allowHistorical ? Date.now() : submissionMs + WINDOW_MS;

  const minTimeIso = new Date(minTimeMs).toISOString();
  const maxTimeIso = new Date(maxTimeMs).toISOString();
  const submissionTimeIso = new Date(submissionMs).toISOString();

  const baseUrl = (config.ZOHO_CONNECTOR_URL || 'https://zoho-mail-reader.onrender.com/').replace(/\/+$/, '');
  const normCompany = normalizeCompanyName(companyName);
  const companyLower = companyName.toLowerCase();

  log.info(
    `[Zoho Connector] 🔍 Querying inbox for ${candidateEmail} | Window: [${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}] | Company: "${companyName}" (Email: "${companyEmail || 'none'}")`
  );

  let matchingMsg: RawZohoInboxMessage | null = null;
  let matchingReceivedMs = 0;
  let totalScanned = 0;
  let lastData: RawZohoInboxResponse | null = null;
  let currentStart = 1;
  const pageSize = 40;
  const maxPages = options.allowHistorical ? 10 : 1;

  try {
    for (let page = 0; page < maxPages; page++) {
      const inboxUrl = `${baseUrl}/api/zoho/ui/inbox?email=${encodeURIComponent(candidateEmail)}&limit=${pageSize}&start=${currentStart}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25000);

      log.info(`[Zoho Connector] 🌐 GET ${inboxUrl} (page ${page + 1}/${maxPages})`);

      const res = await fetch(inboxUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      log.info(
        `[Zoho Connector] 🌐 Inbox response (p.${page + 1}): HTTP ${res.status} ${res.statusText} | content-type: ${
          res.headers.get('content-type') || 'unknown'
        }`
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        log.error(`[Zoho Connector] ❌ Raw error body: ${errText.slice(0, 500)}`);
        throw new Error(`Zoho connector returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const rawBody = await res.text();
      let data: RawZohoInboxResponse;
      try {
        data = JSON.parse(rawBody) as RawZohoInboxResponse;
      } catch (parseErr: any) {
        throw new Error(`Zoho connector returned non-JSON inbox response: ${parseErr.message}`);
      }

      lastData = data;
      const messages = data.messages || [];
      totalScanned += messages.length;

      log.info(
        `[Zoho Connector] 📬 Parsed ${messages.length} emails on page ${page + 1} (count=${data.count ?? 'n/a'}, totalMatched=${
          data.totalMatched ?? 'n/a'
        })`
      );

      if (!messages.length) {
        break;
      }

      let oldestReceivedMsOnPage: number | null = null;

      for (const msg of messages) {
        const receivedMs = parseZohoReceivedTimestamp(msg.receivedTime);
        if (receivedMs === null) {
          continue;
        }

        if (oldestReceivedMsOnPage === null || receivedMs < oldestReceivedMsOnPage) {
          oldestReceivedMsOnPage = receivedMs;
        }

        const fromAddress = (msg.from || '').toLowerCase();
        const subject = (msg.subject || '').toLowerCase();
        const normSubject = normalizeCompanyName(msg.subject || '');

        if (OTP_SUBJECT_PATTERN.test(subject)) {
          continue;
        }

        if (!fromAddress.includes(GREENHOUSE_PROOF_SENDER)) {
          continue;
        }
        const matchesConfirmationPattern = CONFIRMATION_SUBJECT_PATTERN.test(subject);

        const isTimeMatch = receivedMs >= minTimeMs && receivedMs <= maxTimeMs;
        if (!isTimeMatch) {
          continue;
        }

        const fromContainsCompanyEmail = Boolean(
          companyEmail && companyEmail.length > 3 && fromAddress.includes(companyEmail)
        );

        const subjectContainsCompanyName = Boolean(
          (companyLower && companyLower.length > 2 && subject.includes(companyLower)) ||
          (normCompany && normCompany.length > 2 && normSubject.includes(normCompany))
        );

        const fromContainsCompanyName = Boolean(
          (companyLower && companyLower.length > 2 && fromAddress.includes(companyLower)) ||
          (normCompany && normCompany.length > 2 && normAddressMatchesCompany(fromAddress, normCompany, companyLower))
        );

        const isCompanyMatch = fromContainsCompanyEmail || subjectContainsCompanyName || fromContainsCompanyName;

        if (isCompanyMatch && (matchesConfirmationPattern || subjectContainsCompanyName)) {
          matchingMsg = msg;
          matchingReceivedMs = receivedMs;
          break;
        }
      }

      if (matchingMsg) {
        break;
      }

      if (oldestReceivedMsOnPage !== null && oldestReceivedMsOnPage < minTimeMs) {
        log.info(
          `[Zoho Connector] Reached emails older than submission window (${new Date(oldestReceivedMsOnPage).toISOString()} < ${minTimeIso}). Stopping pagination.`
        );
        break;
      }

      if (!data.hasMore || messages.length < pageSize) {
        break;
      }

      currentStart = data.nextStart || (currentStart + pageSize);
    }

    if (!matchingMsg) {
      log.info(
        `[Zoho Connector] ⚠️ Zero confirmation matches for ${candidateEmail} among ${totalScanned} scanned messages in window [${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}] for company "${companyName}".`
      );
      return {
        success: false,
        matched: false,
        email: null,
        scannedCount: totalScanned,
        errorMessage: `Greenhouse confirmation email not found after submission (${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}) for company "${companyName}".`,
        window: { minTimeIso, maxTimeIso, submissionTimeIso },
      };
    }

    const folderId = matchingMsg.folderId || lastData?.folder?.folderId;
    const accountId = lastData?.accountId;
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
      messageId: matchingMsg.messageId,
      message_id: matchingMsg.messageId,
    };

    return {
      success: true,
      matched: true,
      email: emailResult,
      scannedCount: totalScanned,
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

function normAddressMatchesCompany(fromAddress: string, normCompany: string, companyLower: string): boolean {
  return (
    (companyLower.length > 2 && fromAddress.includes(companyLower)) ||
    (normCompany.length > 2 && fromAddress.includes(normCompany))
  );
}

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

          const isGreenhouseSender =
            fromAddress.includes('greenhouse-mail.io') ||
            fromAddress.includes('no-reply@us.greenhouse-mail.io') ||
            fromAddress.includes('greenhouse');

          if (!isGreenhouseSender) {
            nonGreenhouseSenders++;
            continue;
          }

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
          // Response diagnostics use status and headers only
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
