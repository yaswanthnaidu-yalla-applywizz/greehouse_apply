/**
 * @fileoverview Gmail Strategy for OTP polling via connector REST API.
 */

import { config } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';
import { mailboxRateLimiter } from '../mailboxRateLimiter.js';
import {
  OTP_EMAIL_CLOCK_SKEW_MS,
  extractOtpCodeFromText,
  stripHtml,
  normalizeCompanyName,
} from './inboxPoller.js';
import type { ZohoOtpApiQueryOptions, ZohoOtpApiResult } from './zohoStrategy.js';

const log = createLogger('Gmail Connector');

export interface GmailOtpApiQueryOptions extends ZohoOtpApiQueryOptions {}

export interface RawGmailInboxMessage {
  messageId: string;
  threadId?: string;
  subject?: string;
  from?: string;
  to?: string;
  receivedAt?: number | string;
  snippet?: string;
}

export interface RawGmailInboxResponse {
  email?: string;
  messages?: RawGmailInboxMessage[];
  count?: number;
  totalMatched?: number;
}

export interface RawGmailMessageResponse {
  message?: {
    messageId: string;
    threadId?: string;
    subject?: string;
    from?: string;
    to?: string;
    receivedAt?: number | string;
    textContent?: string;
    htmlContent?: string;
    snippet?: string;
  };
}

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
