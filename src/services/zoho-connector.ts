/**
 * @fileoverview Facade re-export for inbox strategies (Zoho, Gmail, shared poller).
 * Maintained for 100% backward compatibility across all existing callers and tests.
 */

export {
  OTP_EMAIL_CLOCK_SKEW_MS,
  parseZohoReceivedTimestamp,
  isMessageEligibleByTimestamp,
  stripHtml,
  normalizeCompanyName,
  getErrorCategory,
  extractOtpCodeFromText,
} from './inbox/inboxPoller.js';

export {
  queryZohoConfirmationEmail,
  fetchZohoOtpViaApi,
  type ZohoEmailQueryOptions,
  type ZohoEmailQueryResult,
  type ZohoOtpApiQueryOptions,
  type ZohoOtpApiResult,
} from './inbox/zohoStrategy.js';

export {
  fetchGmailOtpViaApi,
  queryGmailConfirmationEmail,
  type GmailOtpApiQueryOptions,
  type RawGmailInboxMessage,
  type RawGmailInboxResponse,
  type RawGmailMessageResponse,
} from './inbox/gmailStrategy.js';

import { queryZohoConfirmationEmail, type ZohoEmailQueryOptions, type ZohoEmailQueryResult } from './inbox/zohoStrategy.js';
import { queryGmailConfirmationEmail } from './inbox/gmailStrategy.js';

/**
 * Resolves the candidate mailbox provider based on email domain.
 * Routes @gmail.com and @googlemail.com to Gmail connector endpoints, and others to Zoho.
 */
export function resolveInboxProvider(candidateEmail: string): 'gmail' | 'zoho' {
  const normalized = (candidateEmail || '').trim().toLowerCase();
  if (normalized.endsWith('@gmail.com') || normalized.endsWith('@googlemail.com')) {
    return 'gmail';
  }
  return 'zoho';
}

/**
 * Universal confirmation email query that routes dynamically to either Zoho or Gmail
 * depending on candidate email address domain.
 */
export async function queryConfirmationEmail(
  options: ZohoEmailQueryOptions
): Promise<ZohoEmailQueryResult> {
  const provider = resolveInboxProvider(options.candidateEmail);
  if (provider === 'gmail') {
    return queryGmailConfirmationEmail(options);
  }
  return queryZohoConfirmationEmail(options);
}
