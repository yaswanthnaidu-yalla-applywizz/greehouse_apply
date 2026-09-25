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
  receivedTime: string | number;
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
    receivedTime?: string | number;
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
      const ms = Number(m.receivedTime);
      log.info(
        `[Zoho Connector] 📧 [${i + 1}/${messages.length}] from="${m.from || ''}" | subject="${
          m.subject || ''
        }" | receivedAt=${Number.isNaN(ms) || ms <= 0 ? `UNPARSEABLE(${m.receivedTime})` : new Date(ms).toISOString()}`
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
      const receivedMs = Number(msg.receivedTime);
      if (Number.isNaN(receivedMs) || receivedMs <= 0) {
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
    /copy\s*and\s*paste\s*this\s*code[^:\n]{0,120}:\s*([A-Za-z0-9]{6,16})\b/i;
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
  sinceTimestamp: number;
  companyName?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ZohoOtpApiResult {
  success: boolean;
  otp?: string;
  subject?: string;
  receivedAt?: string;
  errorMessage?: string;
  reason?: string;
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
  const sinceTimestamp = options.sinceTimestamp || Date.now() - 3 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? 30000;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const companyName = (options.companyName || '').trim();

  if (!candidateEmail) {
    return {
      success: false,
      reason: 'invalid email',
      errorMessage: 'Candidate email is required for OTP resolution.',
    };
  }

  const baseUrl = (config.ZOHO_CONNECTOR_URL || 'https://zoho-mail-reader.onrender.com/').replace(
    /\/+$/,
    ''
  );
  // Allow up to 2 minutes of clock skew before the reported challenge timestamp
  const minTimeMs = sinceTimestamp - 2 * 60 * 1000;
  const startTime = Date.now();
  let attempt = 0;

  log.info(
    `[Zoho Connector] ⚡ Starting fast REST OTP poll for ${candidateEmail} ` +
      `(pollInterval=${pollIntervalMs}ms, timeout=${timeoutMs / 1000}s, since=${new Date(
        sinceTimestamp
      ).toLocaleTimeString()})`
  );

  while (Date.now() - startTime < timeoutMs) {
    attempt++;
    const cycleStart = Date.now();

    try {
      const inboxUrl = `${baseUrl}/api/zoho/ui/inbox?email=${encodeURIComponent(
        candidateEmail
      )}&limit=15&start=1`;
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), Math.min(10000, timeoutMs));

      const res = await fetch(inboxUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(fetchTimeout));

      if (res.ok) {
        const rawBody = await res.text();
        let data: RawZohoInboxResponse | null = null;
        try {
          data = JSON.parse(rawBody) as RawZohoInboxResponse;
        } catch {
          data = null;
        }

        const messages = data?.messages || [];
        const accountId = data?.accountId;

        for (const msg of messages) {
          const receivedMs = Number(msg.receivedTime);
          if (Number.isNaN(receivedMs) || receivedMs < minTimeMs) {
            continue;
          }

          const fromAddress = (msg.from || '').toLowerCase();
          const subject = msg.subject || '';
          const subjectLower = subject.toLowerCase();

          // Senders that deliver Greenhouse security codes
          const isGreenhouseSender =
            fromAddress.includes('greenhouse-mail.io') ||
            fromAddress.includes('no-reply@us.greenhouse-mail.io') ||
            fromAddress.includes('greenhouse');

          if (!isGreenhouseSender) {
            continue;
          }

          // Subject must indicate a security / verification code
          const isSecurityCodeSubject =
            /security\s*code|\botp\b|verification\s*code|verify/i.test(subjectLower);

          if (!isSecurityCodeSubject) {
            continue;
          }

          // Optional company filter
          if (companyName && companyName.length > 2) {
            const normComp = normalizeCompanyName(companyName);
            const normSub = normalizeCompanyName(subject);
            const matchesCompany =
              subjectLower.includes(companyName.toLowerCase()) ||
              (normComp.length > 2 && normSub.includes(normComp));
            if (!matchesCompany) {
              // If company name was provided but subject explicitly names a DIFFERENT company, continue
              log.info(
                `[Zoho Connector] Security code subject "${subject}" did not match target company "${companyName}". Checking next.`
              );
              continue;
            }
          }

          // 1. Try extracting OTP directly from subject
          let extractedOtp = extractOtpCodeFromText(subject);

          // 2. If not in subject, fetch the message body
          const folderId = msg.folderId || data?.folder?.folderId;
          if (!extractedOtp && accountId && folderId && msg.messageId) {
            try {
              const msgQs = new URLSearchParams({
                email: candidateEmail,
                accountId,
                folderId,
                messageId: msg.messageId,
              });
              const msgRes = await fetch(`${baseUrl}/api/zoho/ui/message?${msgQs}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
              });

              if (msgRes.ok) {
                const msgData = (await msgRes.json()) as RawZohoMessageResponse;
                const bodyText =
                  msgData.message?.textContent || stripHtml(msgData.message?.htmlContent || '');
                extractedOtp = extractOtpCodeFromText(bodyText);
              }
            } catch (bodyErr: any) {
              log.warn(
                `[Zoho Connector] ⚠️ Failed to fetch message detail for OTP: ${bodyErr.message}`
              );
            }
          }

          if (extractedOtp) {
            const receivedAt = new Date(receivedMs).toISOString();
            log.info(
              `[Zoho Connector] 🎯 Found OTP via REST API in attempt #${attempt}: ${extractedOtp} ` +
                `(subject: "${subject}", received: ${receivedAt})`
            );
            return {
              success: true,
              otp: extractedOtp,
              subject,
              receivedAt,
            };
          }
        }
      } else {
        log.warn(`[Zoho Connector] ⚠️ Inbox query returned HTTP ${res.status}`);
      }
    } catch (pollErr: any) {
      log.warn(`[Zoho Connector] ⚠️ Poll attempt #${attempt} error: ${pollErr.message}`);
    }

    const elapsed = Date.now() - cycleStart;
    const remaining = pollIntervalMs - elapsed;
    if (remaining > 50 && Date.now() - startTime + remaining < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  const reason = 'no matching greenhouse OTP email found';
  log.warn(
    `[Zoho Connector] ⏱️ Timeout after ${Math.round(
      (Date.now() - startTime) / 1000
    )}s (${attempt} attempts). ${reason} for ${candidateEmail}`
  );
  return {
    success: false,
    reason,
    errorMessage: `Timed out waiting for Greenhouse verification email for ${candidateEmail}.`,
  };
}
