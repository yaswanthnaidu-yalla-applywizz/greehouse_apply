import type { ScannedField, ResolvedField } from '../types/index.js';
import { matchChoiceOption } from '../utils/choiceOptions.js';

export const CORPORATE_POLICY_PROMPT_GUIDELINES = `
CORPORATE POLICIES & MANDATORY ANSWER GUIDELINES:
1. Prior Interview & Employment History: If the question asks if the candidate previously worked at, was employed by, or interviewed with the hiring company in the past, always answer No (or choose the negative option).
2. Mandatory Agreements & Policies: For terms & conditions, arbitration agreements, privacy policies, AI usage/application policies, or declarations, always agree/accept (choose the affirmative option, e.g. "I agree", "Yes", or true).
3. Communication & Messaging Consent: If asked for consent to receive text messages, SMS, or WhatsApp communications regarding the application, always decline (answer No, or false).
4. Job Source / Referral: When asked how the candidate heard about this opportunity or role, select the option containing "LinkedIn" if available (fallback to "Job Board" or "Career site"), or return "LinkedIn" for free text.
`.trim();

/**
 * Checks whether a scanned field matches a non-negotiable corporate policy.
 * Returns the resolved string value, or null if the field is not a corporate policy question.
 */
export function matchCorporatePolicy(field: ScannedField): string | null {
  const label = (field.label || '').trim();
  const name = (field.name || '').trim();
  const combined = `${name} ${label}`.trim();

  // 1. Prior Interview & Employment History -> Always "No"
  if (
    /\b(?:interviewed|interviewing)\b.*(?:before|prior|in the past|past \d+|previously|with us|at this company)|history with.*(?:company|organization|firm)|previously (?:employed|worked)|former employee|past employment with|employed by/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') {
      return 'false';
    }
    return matchChoiceOption('No', field.options) || 'No';
  }

  // 2. Communication / SMS / WhatsApp Consent -> Always "No"
  if (
    /\b(?:sms|text message|text messages|whatsapp|mobile messaging)\b/i.test(combined) &&
    /\b(?:receive|consent|opt-in|opt in|updates|notifications|contact you|reach you)\b/i.test(combined)
  ) {
    if (field.type === 'checkbox') {
      return 'false';
    }
    return matchChoiceOption('No', field.options) || 'No';
  }

  // 3. Mandatory Agreements, Terms & Conditions, AI Policy, Arbitration -> Always affirmative
  if (
    /\b(?:I agree|I consent|I certify|I acknowledge|by checking|by selecting|by submitting|arbitration agreement|ai policy|application policy|read the arbitration|terms and conditions|terms & conditions|privacy policy)\b/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') {
      return 'true';
    }
    // Filter out negative options like "I do not agree" / "Disagree"
    const affirmativeMatch =
      field.options?.find((opt) =>
        !/\b(?:not|disagree|decline|no)\b/i.test(opt) &&
        /\b(?:i agree|i will read|agree|yes|accept|understood|acknowledge)\b/i.test(opt)
      ) || matchChoiceOption('Yes', field.options) || 'Yes';
    return affirmativeMatch;
  }

  // 4. Job Source / How did you hear about us -> Prefers "LinkedIn"
  if (
    /\b(?:how did you (?:hear|learn)|where did you (?:hear|learn)|source of application|job source|referral source)\b/i.test(
      combined
    )
  ) {
    if (Array.isArray(field.options) && field.options.length > 0) {
      const linkedInOpt = field.options.find((opt) => /linkedin/i.test(opt));
      if (linkedInOpt) return linkedInOpt;

      const fallbackPatterns = [
        /job board/i,
        /career(?:s)? (?:site|page|portal)/i,
        /company website|website/i,
        /online/i,
        /other/i,
      ];
      for (const pat of fallbackPatterns) {
        const found = field.options.find((opt) => pat.test(opt));
        if (found) return found;
      }

      return field.options[0];
    }
    return 'LinkedIn';
  }

  return null;
}

/**
 * Enforces non-negotiable corporate policies as a post-tier guard on any ResolvedField.
 * If a resolved field violates a non-negotiable policy, it overrides the value and marks it clamped.
 */
export function enforceCorporatePolicy(
  field: ScannedField,
  resolved: ResolvedField
): ResolvedField {
  const policyVal = matchCorporatePolicy(field);
  if (!policyVal) {
    return resolved;
  }

  // If the resolved value already matches the policy value, return as-is
  if (resolved.value === policyVal) {
    return resolved;
  }

  // Clamp the field to the corporate policy
  return {
    ...resolved,
    value: policyVal,
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  };
}
