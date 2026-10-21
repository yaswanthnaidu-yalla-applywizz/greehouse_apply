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
  type GmailOtpApiQueryOptions,
  type RawGmailInboxMessage,
  type RawGmailInboxResponse,
  type RawGmailMessageResponse,
} from './inbox/gmailStrategy.js';
