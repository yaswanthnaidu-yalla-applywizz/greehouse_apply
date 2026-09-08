/**
 * @fileoverview Question fingerprinting for deterministic Q&A caching (Greenhouse V2).
 *
 * Generates a 16-character hexadecimal prefix from SHA-256(normalized label + normalized type).
 */

import crypto from 'crypto';

/**
 * Normalizes question label text:
 * - Converts to lower case
 * - Strips asterisks, punctuation, extra symbols
 * - Trims and replaces multiple whitespace characters with a single space
 */
export function normalizeText(text: string | undefined | null): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[*?:;,.'"!@#$%^&()_+=[\]{}|\\/<>`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes form control type string (e.g. "text", "select", "radio", "textarea").
 */
export function normalizeType(type: string | undefined | null): string {
  if (!type) return 'text';
  return type.toLowerCase().trim();
}

/**
 * Generates a 16-character hexadecimal SHA-256 fingerprint for a question label and control type.
 *
 * @param label - Raw human-readable field label (e.g. "What is your LinkedIn profile? *")
 * @param type - Form control type (e.g. "text", "textarea", "select", "radio")
 * @returns 16-character hexadecimal string
 */
export function generateFingerprint(label: string, type: string): string {
  const normLabel = normalizeText(label);
  const normType = normalizeType(type);
  const payload = `${normLabel}|${normType}`;

  const hash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  return hash.substring(0, 16);
}

export default generateFingerprint;
