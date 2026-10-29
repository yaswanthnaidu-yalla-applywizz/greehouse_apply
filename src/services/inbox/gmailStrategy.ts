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
import {
  ASHBY_CONFIRMATION_CLOCK_SKEW_MS,
  isAshbySenderCandidate,
  matchAshbyConfirmationEmail,
} from './ashbyConfirmationMatcher.js';
import type {
  ZohoOtpApiQueryOptions,
  ZohoOtpApiResult,
  ZohoEmailQueryOptions,
  ZohoEmailQueryResult,
  EmailProofJson,
} from './zohoStrategy.js';

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

function normAddressMatchesCompany(fromAddress: string, normCompany: string, companyLower: string): boolean {
  const atIdx = fromAddress.indexOf('@');
  const domainPart = atIdx >= 0 ? fromAddress.slice(atIdx + 1) : fromAddress;
  return domainPart.includes(normCompany) || domainPart.includes(companyLower);
}

export async function queryGmailConfirmationEmail(
  options: ZohoEmailQueryOptions
): Promise<ZohoEmailQueryResult> {
  const candidateEmail = (options.candidateEmail || '').trim().toLowerCase();
  const companyName = (options.companyName || '').trim();
  const companyEmail = (options.companyEmail || '').trim().toLowerCase();
  const isAshby = options.ats === 'ashby';

  if (!candidateEmail) {
    return {
      success: false,
      matched: false,
      email: null,
      errorMessage: 'Candidate email is required to query Gmail inbox.',
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
  const minTimeMs = options.allowHistorical
    ? submissionMs - 2 * 60 * 1000
    : isAshby
    ? submissionMs - ASHBY_CONFIRMATION_CLOCK_SKEW_MS
    : submissionMs;
  const maxTimeMs = options.allowHistorical ? Date.now() : submissionMs + WINDOW_MS;

  const minTimeIso = new Date(minTimeMs).toISOString();
  const maxTimeIso = new Date(maxTimeMs).toISOString();
  const submissionTimeIso = new Date(submissionMs).toISOString();

  const baseUrl = (config.ZOHO_CONNECTOR_URL || 'https://zoho-mail-reader.onrender.com/').replace(/\/+$/, '');
  const normCompany = normalizeCompanyName(companyName);
  const companyLower = companyName.toLowerCase();

  log.info(
    `[Gmail Connector] 🔍 Querying inbox for ${candidateEmail} | ATS: ${options.ats || 'greenhouse'} | Window: [${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}] | Company: "${companyName}" (Email: "${companyEmail || 'none'}")`
  );

  let matchingMsg: RawGmailInboxMessage | null = null;
  let matchingReceivedMs = 0;
  let totalScanned = 0;
  let nextPageToken: string | undefined = undefined;
  const pageSize = 40;
  const maxPages = options.allowHistorical ? 10 : 1;

  try {
    for (let page = 0; page < maxPages; page++) {
      let inboxUrl = `${baseUrl}/api/gmail/ui/inbox?email=${encodeURIComponent(candidateEmail)}&limit=${pageSize}`;
      if (nextPageToken) {
        inboxUrl += `&pageToken=${encodeURIComponent(nextPageToken)}`;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25000);

      log.info(`[Gmail Connector] 🌐 GET ${inboxUrl} (page ${page + 1}/${maxPages})`);

      await mailboxRateLimiter.acquire();
      const res = await fetch(inboxUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      log.info(
        `[Gmail Connector] 🌐 Inbox response (p.${page + 1}): HTTP ${res.status} ${res.statusText} | content-type: ${
          res.headers.get('content-type') || 'unknown'
        }`
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        log.warn(`[Gmail Connector] ⚠️ Inbox request error: HTTP ${res.status}: ${errText.slice(0, 300)}`);
        return {
          success: false,
          matched: false,
          email: null,
          scannedCount: totalScanned,
          errorMessage: `Gmail connector returned HTTP ${res.status}: ${errText.slice(0, 200)}`,
          window: { minTimeIso, maxTimeIso, submissionTimeIso },
        };
      }

      const rawBody = await res.text();
      let data: RawGmailInboxResponse & { error?: string; nextPageToken?: string };
      try {
        data = JSON.parse(rawBody);
      } catch (parseErr: any) {
        throw new Error(`Gmail connector returned non-JSON inbox response: ${parseErr.message}`);
      }

      if (data.error) {
        log.warn(`[Gmail Connector] ⚠️ Connector reported error for ${candidateEmail}: ${data.error}`);
        return {
          success: false,
          matched: false,
          email: null,
          scannedCount: totalScanned,
          errorMessage: data.error,
          window: { minTimeIso, maxTimeIso, submissionTimeIso },
        };
      }

      const messages = Array.isArray(data.messages) ? data.messages : [];
      totalScanned += messages.length;

      log.info(
        `[Gmail Connector] 📬 Parsed ${messages.length} emails on page ${page + 1} (count=${data.count ?? 'n/a'}, totalMatched=${
          data.totalMatched ?? 'n/a'
        })`
      );

      if (!messages.length) {
        break;
      }

      let oldestReceivedMsOnPage: number | null = null;

      for (const msg of messages) {
        const rawReceived = msg.receivedAt;
        const receivedMs =
          typeof rawReceived === 'number'
            ? rawReceived
            : typeof rawReceived === 'string'
            ? Date.parse(rawReceived)
            : null;

        if (receivedMs === null || Number.isNaN(receivedMs)) {
          continue;
        }

        if (oldestReceivedMsOnPage === null || receivedMs < oldestReceivedMsOnPage) {
          oldestReceivedMsOnPage = receivedMs;
        }

        const fromAddress = (msg.from || '').toLowerCase();
        const subject = (msg.subject || '').toLowerCase();
        const normSubject = normalizeCompanyName(msg.subject || '');

        if (/security\s*code|\botp\b|one[-\s]?time (pass)?code/i.test(subject)) {
          continue;
        }

        const isTimeMatch = receivedMs >= minTimeMs && receivedMs <= maxTimeMs;
        if (!isTimeMatch) {
          continue;
        }

        if (isAshby) {
          if (!isAshbySenderCandidate(msg.from || '', companyName)) {
            continue;
          }

          let msgData: RawGmailMessageResponse | null = null;
          if (msg.messageId) {
            try {
              const msgQs = new URLSearchParams({
                email: candidateEmail,
                messageId: msg.messageId,
              });
              await mailboxRateLimiter.acquire();
              const msgRes = await fetch(`${baseUrl}/api/gmail/ui/message?${msgQs}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
              });
              if (msgRes.ok) {
                msgData = (await msgRes.json()) as RawGmailMessageResponse;
              }
            } catch (err: any) {
              log.warn(`[Gmail Connector] ⚠️ Failed to fetch full message body for ${msg.messageId}: ${err.message}`);
            }
          }

          const fullSubject = msgData?.message?.subject || msg.subject || 'Application Confirmation';
          const fullFrom = msgData?.message?.from || msg.from || 'Unknown';
          const fullTo = msgData?.message?.to || msg.to || candidateEmail;
          const htmlContent = msgData?.message?.htmlContent || '';
          const textContent = msgData?.message?.textContent || stripHtml(htmlContent);
          const snippet = msgData?.message?.snippet || msg.snippet || '';
          const bodyText = textContent || stripHtml(htmlContent) || snippet || fullSubject;

          const matchResult = matchAshbyConfirmationEmail(
            {
              from: fullFrom,
              to: fullTo,
              subject: fullSubject,
              bodyText,
            },
            {
              candidateEmail,
              companyName,
              jobTitle: options.jobTitle ?? null,
            }
          );

          if (matchResult.matched === true) {
            const receivedAtIso = new Date(receivedMs).toISOString();
            log.info(
              `[Gmail Connector] 🎉 Ashby proof email captured: ${fullSubject} from ${fullFrom} at ${receivedAtIso}`
            );

            const emailResult: EmailProofJson = {
              from: fullFrom,
              to: fullTo,
              subject: fullSubject,
              received_at: receivedAtIso,
              receivedTime: receivedAtIso,
              body_text: bodyText,
              bodyText: bodyText,
              body_html: htmlContent || undefined,
              messageId: msg.messageId,
              message_id: msg.messageId,
              snippet: snippet || (bodyText ? bodyText.slice(0, 200) : undefined),
              matchedAt: new Date().toISOString(),
            };

            return {
              success: true,
              matched: true,
              email: emailResult,
              scannedCount: totalScanned,
              window: { minTimeIso, maxTimeIso, submissionTimeIso },
            };
          } else {
            if (matchResult.reason === 'rejection') {
              log.debug(
                `[Gmail Connector] Skipping Ashby rejection message ${msg.messageId} for company "${companyName}".`
              );
            } else {
              log.debug(
                `[Gmail Connector] Ashby matcher rejected candidate message ${msg.messageId}: ${matchResult.reason}`
              );
            }
            continue;
          }
        }

        const isGreenhouseSender =
          fromAddress.includes('greenhouse-mail.io') ||
          fromAddress.includes('greenhouse');
        if (!isGreenhouseSender) {
          continue;
        }

        const matchesConfirmationPattern =
          /thank you|application received|application confirmed|journey.*started|application.*submitted|received.*application/i.test(
            subject
          );

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
          `[Gmail Connector] Reached emails older than submission window (${new Date(oldestReceivedMsOnPage).toISOString()} < ${minTimeIso}). Stopping pagination.`
        );
        break;
      }

      if (!data.nextPageToken || messages.length < pageSize) {
        break;
      }

      nextPageToken = data.nextPageToken;
    }

    if (!matchingMsg) {
      log.info(
        `[Gmail Connector] ⚠️ Zero confirmation matches for ${candidateEmail} among ${totalScanned} scanned messages in window [${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}] for company "${companyName}".`
      );
      const atsLabel = isAshby ? 'Ashby' : 'Greenhouse';
      return {
        success: false,
        matched: false,
        email: null,
        scannedCount: totalScanned,
        errorMessage: `${atsLabel} confirmation email not found in Gmail after submission (${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}) for company "${companyName}".`,
        window: { minTimeIso, maxTimeIso, submissionTimeIso },
      };
    }

    let textContent = '';
    let htmlContent = '';
    let fullSubject = matchingMsg.subject || 'Application Confirmation';
    let fullFrom = matchingMsg.from || 'Unknown';
    let fullTo = matchingMsg.to || candidateEmail;

    if (matchingMsg.messageId) {
      try {
        const msgQs = new URLSearchParams({
          email: candidateEmail,
          messageId: matchingMsg.messageId,
        });
        await mailboxRateLimiter.acquire();
        const msgRes = await fetch(`${baseUrl}/api/gmail/ui/message?${msgQs}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });

        if (msgRes.ok) {
          const msgData = (await msgRes.json()) as RawGmailMessageResponse;
          if (msgData?.message) {
            fullSubject = msgData.message.subject || fullSubject;
            fullFrom = msgData.message.from || fullFrom;
            fullTo = msgData.message.to || fullTo;
            htmlContent = msgData.message.htmlContent || '';
            textContent = msgData.message.textContent || stripHtml(htmlContent);
          }
        }
      } catch (err: any) {
        log.warn(`[Gmail Connector] ⚠️ Failed to fetch full message body: ${err.message}`);
      }
    }

    if (!textContent && htmlContent) {
      textContent = stripHtml(htmlContent);
    }

    const receivedAtIso = new Date(matchingReceivedMs).toISOString();

    log.info(
      `[Gmail Connector] 🎉 Proof email captured: ${fullSubject} from ${fullFrom} at ${receivedAtIso}`
    );

    const emailResult: EmailProofJson = {
      from: fullFrom,
      to: fullTo,
      subject: fullSubject,
      received_at: receivedAtIso,
      receivedTime: receivedAtIso,
      body_text: textContent || fullSubject,
      bodyText: textContent || fullSubject,
      body_html: htmlContent || undefined,
      messageId: matchingMsg.messageId,
      message_id: matchingMsg.messageId,
      snippet: textContent ? textContent.slice(0, 200) : undefined,
      matchedAt: new Date().toISOString(),
    };

    return {
      success: true,
      matched: true,
      email: emailResult,
      scannedCount: totalScanned,
      window: { minTimeIso, maxTimeIso, submissionTimeIso },
    };
  } catch (err: any) {
    log.error(`[Gmail Connector] ❌ Error checking Gmail confirmation: ${err.message}`);
    return {
      success: false,
      matched: false,
      email: null,
      scannedCount: totalScanned,
      errorMessage: `Gmail query failed: ${err.message}`,
      window: { minTimeIso, maxTimeIso, submissionTimeIso },
    };
  }
}
