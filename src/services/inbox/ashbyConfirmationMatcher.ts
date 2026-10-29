/**
 * @fileoverview Pure deterministic matcher for Ashby ATS confirmation emails.
 * Inspects sender, recipient, company entity alignment, fail-closed adverse
 * rejection patterns, and positive application-receipt signals.
 */

import { normalizeCompanyName } from './inboxPoller.js';

export const ASHBY_CONFIRMATION_CLOCK_SKEW_MS = 5_000;

export interface AshbyConfirmationMessage {
  from: string;
  to?: string;
  subject: string;
  bodyText: string;
}

export interface AshbyConfirmationContext {
  candidateEmail: string;
  companyName: string;
  jobTitle?: string | null;
}

export type AshbyConfirmationMatchReason =
  | 'matched'
  | 'recipient_mismatch'
  | 'sender_mismatch'
  | 'company_mismatch'
  | 'rejection'
  | 'missing_success_signal';

export type AshbyConfirmationMatchResult =
  | { matched: true; reason: 'matched' }
  | { matched: false; reason: Exclude<AshbyConfirmationMatchReason, 'matched'> };

/**
 * Rejection patterns - must match declarative adverse decisions, never hypotheticals.
 * Evaluated before positive confirmation patterns to prevent courteous rejection
 * openings from being promoted to successful application receipts.
 */
export const ASHBY_REJECTION_PATTERNS: RegExp[] = [
  /(?:decided|chosen)\s+to\s+move\s+forward\s+with\s+other\s+candidates/i,
  /other\s+candidates\s+whose\s+experience\s+more\s+closely\s+(?:matches|aligns)/i,
  /(?:will\s+not\s+be|decided\s+not\s+to|unable\s+to)\s+move\s+forward\s+with\s+your\s+(?:candidacy|application)/i,
  /(?:unable|not\s+going)\s+to\s+move\s+forward\s+(?:at\s+this\s+time|with\s+your)/i,
  /not\s+(?:able|eligible)\s+to\s+meet\s+the\s+.*expectations/i,
  /(?:all\s+the\s+best|every\s+success|the\s+best)\s+in\s+your\s+job\s+search/i,
  /difficult\s+decision\s+due\s+to\s+the\s+high\s+volume/i,
];

/**
 * Positive confirmation patterns indicating receipt and active pipeline review.
 */
export const ASHBY_CONFIRMATION_PATTERNS: RegExp[] = [
  /(?:we(?:'ve|\s+have)?\s+received|confirm(?:ing)?\s+receipt\s+of)\s+your\s+application/i,
  /your\s+application\s+has\s+been\s+received/i,
  /(?:thanks|thank\s+you)\s+for\s+applying(?:\s+(?:to|for|@))?/i,
  /(?:thanks|thank\s+you)\s+for\s+your\s+application/i,
  /(?:will|team\s+will)\s+review\s+your\s+application/i,
  /application\s+(?:is|will\s+be)\s+reviewed\s+by\s+our\s+team/i,
  /(?:app|application)\s+is\s+in\s+(?:good|great)\s+hands/i,
];

/**
 * Extracts and normalizes an email address from potential angle bracket wrappers or HTML entities.
 */
export function extractEmailAddress(raw: string): string {
  if (!raw) return '';
  const decoded = raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const angleMatch = decoded.match(/<([^>]+)>/);
  if (angleMatch && angleMatch[1]) {
    return angleMatch[1].trim().toLowerCase();
  }
  return decoded.replace(/["']/g, '').trim().toLowerCase();
}

/**
 * Validates whether the sender address is a legitimate Ashby notification gateway
 * or a verified company vanity domain matching the context company name.
 */
export function isAshbySenderCandidate(from: string, companyName: string): boolean {
  const email = extractEmailAddress(from);
  if (!email || !email.includes('@')) {
    return false;
  }

  const [localPart, domain] = email.split('@');
  if (!domain) {
    return false;
  }

  // 1. Ashby standard gateway (e.g. no-reply@ashbyhq.com, hiring@ashbyhq.com)
  if (domain === 'ashbyhq.com' || domain.endsWith('.ashbyhq.com')) {
    return true;
  }

  // 2. Custom company no-reply vanity domain
  const allowedPrefixes = ['no-reply', 'noreply', 'hiring', 'recruiting', 'jobs', 'careers'];
  const isAllowedPrefix = allowedPrefixes.includes(localPart.toLowerCase());
  if (!isAllowedPrefix) {
    return false;
  }

  const normCompany = normalizeCompanyName(companyName);
  if (!normCompany) {
    return false;
  }

  const normDomain = domain.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normDomain.includes(normCompany);
}

/**
 * Verifies whether the company name appears in subject or body text.
 */
function matchesCompany(text: string, companyName: string): boolean {
  if (!companyName || !companyName.trim()) {
    return false;
  }
  const rawTarget = companyName.trim().toLowerCase();
  const rawText = text.toLowerCase();
  if (rawText.includes(rawTarget)) {
    return true;
  }

  const normTarget = normalizeCompanyName(companyName);
  if (normTarget.length >= 2) {
    const normText = rawText.replace(/[^a-z0-9]/g, '');
    if (normText.includes(normTarget)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates an incoming email message against application context to determine
 * if it represents a valid Ashby submission confirmation receipt.
 *
 * Evaluation Order:
 * 1. Recipient check: message.to matches candidateEmail (if to is present).
 * 2. Sender check: sender is Ashby gateway or verified company vanity domain.
 * 3. Company check: company name appears in subject or body.
 * 4. Rejection gate (Fail-Closed): matches any declarative adverse pattern.
 * 5. Positive confirmation gate: matches any receipt acknowledgment pattern.
 * 6. Missing signal: fails closed if no confirmation pattern matched.
 */
export function matchAshbyConfirmationEmail(
  message: AshbyConfirmationMessage,
  context: AshbyConfirmationContext
): AshbyConfirmationMatchResult {
  // 1. Recipient check
  if (message.to) {
    const messageRecipient = extractEmailAddress(message.to);
    const targetRecipient = extractEmailAddress(context.candidateEmail);
    if (!messageRecipient || messageRecipient !== targetRecipient) {
      return { matched: false, reason: 'recipient_mismatch' };
    }
  }

  // 2. Sender check
  if (!isAshbySenderCandidate(message.from, context.companyName)) {
    return { matched: false, reason: 'sender_mismatch' };
  }

  // 3. Company check
  const combinedText = `${message.subject || ''}\n${message.bodyText || ''}`;
  if (!matchesCompany(combinedText, context.companyName)) {
    return { matched: false, reason: 'company_mismatch' };
  }

  // 4. Rejection gate (Fail-Closed)
  for (const pattern of ASHBY_REJECTION_PATTERNS) {
    if (pattern.test(combinedText)) {
      return { matched: false, reason: 'rejection' };
    }
  }

  // 5. Positive confirmation gate
  for (const pattern of ASHBY_CONFIRMATION_PATTERNS) {
    if (pattern.test(combinedText)) {
      return { matched: true, reason: 'matched' };
    }
  }

  // 6. Missing positive signal
  return { matched: false, reason: 'missing_success_signal' };
}
