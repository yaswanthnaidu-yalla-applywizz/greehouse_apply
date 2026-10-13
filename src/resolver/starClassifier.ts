/**
 * @fileoverview Classifies questions as behavioral or motivational for STAR methodology synthesis.
 */

import type { ScannedField } from '../types/index.js';

const BEHAVIORAL_PATTERNS = [
  /\bhave you (?:ever )?worked with\b/i,
  /\bexperience (?:with|in|using)\b/i,
  /\bdescribe (?:a|an|your|the)\b/i,
  /\btell (?:us|me) about\b/i,
  /\bhow have you (?:handled|solved|approached|worked|built|scaled)\b/i,
  /\bgive (?:an? )?example of\b/i,
  /\bwalk us through\b/i,
  /\bwhat was your role in\b/i,
  /\bhow do you approach\b/i,
  /\bchallenge you (?:faced|solved|overcame)\b/i,
  /\bproject you(?:'re| are)? most proud of\b/i,
];

const MOTIVATIONAL_PATTERNS = [
  /\bwhy (?:do you want to work|do you want to join|choose|join|are you interested in)\b/i,
  /\bwhy (?:this role|our company|applywizz|us|this team)\b/i,
  /\bwhat (?:excites|interests|attracts|draws) you\b/i,
  /\bwhat makes you a good fit\b/i,
  /\bwhy should we hire you\b/i,
  /\bwhat do you know about\b/i,
];

const FACTUAL_OR_EXCLUDED_PATTERNS = [
  /\b(?:linkedin|github|website|portfolio|blog|url|link)\b/i,
  /\b(?:salary|compensation|pay|rate|expectation)\b/i,
  /\b(?:gender|race|ethnicity|hispanic|latino|veteran|disability|eeoc)\b/i,
  /\b(?:phone|mobile|cell|email|first name|last name|full name|address|city|state|zip|country)\b/i,
  /\b(?:start date|availability|notice period)\b/i,
  /\b(?:authorized to work|sponsorship|visa)\b/i,
  /\b(?:hear about|referral source)\b/i,
];

/**
 * Returns true if the question is an open-ended behavioral or motivational question
 * suitable for STAR (Situation, Task, Action, Result) methodology synthesis.
 */
export function isBehavioralOrMotivationalQuestion(
  field: Pick<ScannedField, 'label'> & { type?: string; options?: string[] }
): boolean {
  const label = (field.label || '').trim();
  if (!label) return false;

  // Never apply to structured dropdowns, radios, or checkboxes
  const rawType = (field.type || '').toLowerCase();
  if (['select', 'radio', 'checkbox'].includes(rawType)) {
    return false;
  }
  if (Array.isArray(field.options) && field.options.length > 0) {
    return false;
  }

  // Reject factual, demographic, URL, or standard form fields
  for (const excluded of FACTUAL_OR_EXCLUDED_PATTERNS) {
    if (excluded.test(label)) {
      return false;
    }
  }

  // Check behavioral or motivational triggers
  const isBehavioral = BEHAVIORAL_PATTERNS.some((pattern) => pattern.test(label));
  if (isBehavioral) return true;

  const isMotivational = MOTIVATIONAL_PATTERNS.some((pattern) => pattern.test(label));
  if (isMotivational) return true;

  return false;
}
