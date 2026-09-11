/**
 * @fileoverview Zoho Mail Connector Service.
 *
 * Directly queries Zoho Mail inbox via the connector REST API:
 * 1. Filters messages by submission timestamp window:
 *    (received_time >= submission_time - 5min AND received_time <= submission_time + 5min)
 * 2. Filters by company:
 *    (from_address CONTAINS company_email OR subject CONTAINS company_name)
 * 3. Extracts structured JSON (from, to, subject, received_at, body_text, body_html).
 *    NEVER takes screenshots — returns pure email JSON payload.
 * 4. Gracefully handles zero-match cases.
 */

import { config } from '../config/env.js';
import type { EmailProofJson } from '../db/applications.js';

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
 * matching both:
 * 1. Timestamp window: [submission_time - 5min, submission_time + 5min]
 * 2. Company criteria: (from_address CONTAINS company_email OR subject CONTAINS company_name)
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

  // Parse submission time and calculate strict +/- 5 minute window
  const subDate = new Date(options.submissionTime);
  const submissionMs = !Number.isNaN(subDate.getTime()) ? subDate.getTime() : Date.now();
  const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const minTimeMs = submissionMs - WINDOW_MS;
  const maxTimeMs = submissionMs + WINDOW_MS;

  const minTimeIso = new Date(minTimeMs).toISOString();
  const maxTimeIso = new Date(maxTimeMs).toISOString();
  const submissionTimeIso = new Date(submissionMs).toISOString();

  const baseUrl = (config.ZOHO_CONNECTOR_URL || 'https://zoho-mail-reader.onrender.com/').replace(/\/+$/, '');
  const normCompany = normalizeCompanyName(companyName);
  const companyLower = companyName.toLowerCase();

  console.log(
    `[Zoho Connector] 🔍 Querying inbox for ${candidateEmail} | Window: [${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}] | Company: "${companyName}" (Email: "${companyEmail || 'none'}")`
  );

  try {
    const inboxUrl = `${baseUrl}/api/zoho/ui/inbox?email=${encodeURIComponent(candidateEmail)}&limit=40&start=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25000);

    const res = await fetch(inboxUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Zoho connector returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as RawZohoInboxResponse;
    const messages = data.messages || [];
    const accountId = data.accountId;

    if (!messages.length) {
      console.log(`[Zoho Connector] ℹ️ Inbox is empty for ${candidateEmail}. Zero matches.`);
      return {
        success: false,
        matched: false,
        email: null,
        scannedCount: 0,
        errorMessage: `No emails found in inbox for ${candidateEmail}.`,
        window: { minTimeIso, maxTimeIso, submissionTimeIso },
      };
    }

    // Iterate through messages to find an exact match satisfying BOTH conditions:
    // (received_time >= submission_time - 5min AND received_time <= submission_time + 5min)
    // AND (from_address CONTAINS company_email OR subject CONTAINS company_name)
    let matchingMsg: RawZohoInboxMessage | null = null;
    let matchingReceivedMs = 0;

    for (const msg of messages) {
      const receivedMs = Number(msg.receivedTime);
      if (Number.isNaN(receivedMs) || receivedMs <= 0) {
        continue;
      }

      // 1. Strict Timestamp Filter: within +/- 5 minutes of submission
      const isTimeMatch = receivedMs >= minTimeMs && receivedMs <= maxTimeMs;
      if (!isTimeMatch) {
        continue;
      }

      const fromAddress = (msg.from || '').toLowerCase();
      const subject = (msg.subject || '').toLowerCase();
      const normSubject = normalizeCompanyName(msg.subject || '');

      // 2. Company Filter:
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

      if (isCompanyMatch) {
        matchingMsg = msg;
        matchingReceivedMs = receivedMs;
        break;
      }
    }

    // Zero-match case handled gracefully
    if (!matchingMsg) {
      console.log(
        `[Zoho Connector] ⚠️ Zero matches found for ${candidateEmail} among ${messages.length} messages in window [${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}] for company "${companyName}".`
      );
      return {
        success: false,
        matched: false,
        email: null,
        scannedCount: messages.length,
        errorMessage: `Confirmation email not found within 5 minutes of submission (${new Date(minTimeMs).toLocaleTimeString()} - ${new Date(maxTimeMs).toLocaleTimeString()}) for company "${companyName}".`,
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
        console.warn(`[Zoho Connector] ⚠️ Failed to fetch full message body: ${err.message}`);
      }
    }

    if (!textContent && htmlContent) {
      textContent = stripHtml(htmlContent);
    }

    const receivedAtIso = new Date(matchingReceivedMs).toISOString();

    console.log(
      `[Zoho Connector] 🎉 Verified confirmation email: "${fullSubject}" from <${fullFrom}> received at ${receivedAtIso}`
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
    console.error(`[Zoho Connector] ❌ Error querying Zoho Mail for ${candidateEmail}: ${err.message}`);
    return {
      success: false,
      matched: false,
      email: null,
      errorMessage: err.message || 'Failed to query Zoho Mail connector.',
      window: { minTimeIso, maxTimeIso, submissionTimeIso },
    };
  }
}
