import type { ScannedField, ResolvedField } from '../types/index.js';
import type { ProfileRow } from '../db/profiles.js';
import { matchChoiceOption } from '../utils/choiceOptions.js';

export const CORPORATE_POLICY_PROMPT_GUIDELINES = `
CORPORATE POLICIES & MANDATORY ANSWER GUIDELINES:
1. Prior Interview & Employment History: If the question asks if the candidate previously worked at, was previously employed by, or has interviewed with the hiring company in the past, always answer No (or choose the negative option).
2. Mandatory Agreements & Policies: For terms & conditions, arbitration agreements, privacy policies, AI usage/application policies, or declarations, always agree/accept (choose the affirmative option, e.g. "I agree", "Yes", or true).
3. Communication & Messaging Consent: If asked for consent to receive text messages, SMS, or WhatsApp communications regarding the application, always decline (answer No, or false).
4. Job Source / Referral: When asked how the candidate heard about this opportunity or role, select the option containing "LinkedIn" if available (fallback to "Job Board" or "Career site"), or return "LinkedIn" for free text.
`.trim();

/**
 * Checks whether a scanned field matches a non-negotiable corporate policy.
 * Returns the resolved string value, or null if the field is not a corporate policy question.
 */
export function matchCorporatePolicy(field: ScannedField, profile?: ProfileRow | null): string | null {
  const label = (field.label || '').trim();
  const name = (field.name || '').trim();
  const combined = `${name} ${label}`.trim();

  // 1. Prior Interview & Employment History -> Always "No"
  // "employed by" is restricted to past-tense phrasings to avoid matching sponsorship questions
  // like "to be employed by [Company]" which contain the same substring.
  if (
    /\b(?:interviewed|interviewing)\b.*(?:before|prior|in the past|past \d+|previously|with us|at this company)|history with.*(?:company|organization|firm)|previously (?:employed|worked)|former employee|past employment with|\b(?:have you (?:been|ever been|previously been) employed by|were you (?:ever )?employed by|check if you have previously been employed by)\b/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') {
      return 'false';
    }
    return matchChoiceOption('No', field.options) || 'No';
  }

  // 2. Communication / SMS / WhatsApp Consent
  // On ATS forms with explicit affirmative SMS consent radio options (e.g. Ashby), choose affirmative SMS consent.
  if (
    Array.isArray(field.options) &&
    field.options.some((opt) => /receiving (?:sms|text messages)/i.test(opt))
  ) {
    const smsConsent = field.options.find((opt) => /yes.*consent.*sms/i.test(opt));
    if (smsConsent) return smsConsent;
  }

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

  // 5. Sanctioned Countries & Export Controls
  if (
    /\b(?:cuba|iran|north korea|syria|crimea|donetsk|luhansk|sanctioned countr|export control)\b/i.test(
      combined
    )
  ) {
    const sanctionedTokens = [
      'cuba',
      'iran',
      'north korea',
      'syria',
      'russia',
      'crimea',
      'donetsk',
      'luhansk',
      'belarus',
    ];
    const questionSanctioned = sanctionedTokens.filter((token) =>
      combined.toLowerCase().includes(token)
    );
    if (questionSanctioned.length > 0) {
      const candidateCountry = (profile?.country || '').toLowerCase().trim();
      const candidateLocation = (profile?.location || '').toLowerCase().trim();
      const isCandidateSanctioned = questionSanctioned.some(
        (s) => candidateCountry.includes(s) || candidateLocation.includes(s)
      );

      if (field.type === 'checkbox') {
        return isCandidateSanctioned ? 'true' : 'false';
      }
      const target = isCandidateSanctioned ? 'Yes' : 'No';
      return matchChoiceOption(target, field.options) || target;
    }
  }

  // 6. Work Authorization Status Dropdown (e.g. Similarweb)
  if (
    /\b(?:work authorization status|current (?:visa|work) status|immigration status|visa status|current work authorization)\b/i.test(
      combined
    ) &&
    Array.isArray(field.options) &&
    field.options.length > 0
  ) {
    if (profile) {
      if (
        profile.requires_sponsorship === false &&
        (profile as any).us_work_authorized !== false &&
        profile.work_authorization !== 'No'
      ) {
        const citizenMatch =
          matchChoiceOption('US Citizen', field.options) ||
          matchChoiceOption('Green Card', field.options);
        if (citizenMatch) return citizenMatch;
      } else if (profile.requires_sponsorship === true) {
        const visaType =
          (profile as any)?.visa_type ||
          profile.raw_api_payload?.visa_type ||
          'H-1B';
        const visaMatch =
          matchChoiceOption(String(visaType), field.options) ||
          matchChoiceOption('H-1B', field.options) ||
          matchChoiceOption('Other', field.options);
        if (visaMatch) return visaMatch;
      }
    }
  }

  // 7. Commute & Office Attendance Schedule (e.g. 3 days a week)
  if (
    /\b(?:comfortable commuting|able to commute|willing to commute|commute to.*office|days a week.*office|office.*(?:three|\d+)\s*days a week|(?:three|\d+)\s*days a week.*office)\b/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') return 'true';
    return matchChoiceOption('Yes', field.options) || 'Yes';
  }

  // 8. Numbered Work Experience (1)-(3) (e.g. employer (1), job title (2))
  const numberedMatch = combined.match(
    /\(([1-3])\)|#([1-3])|\bemployer\s*([1-3])\b|\bcompany\s*([1-3])\b|\btitle\s*([1-3])\b|\bjob title\s*\(([1-3])\)/i
  );
  if (numberedMatch && profile) {
    const numStr =
      numberedMatch[1] ||
      numberedMatch[2] ||
      numberedMatch[3] ||
      numberedMatch[4] ||
      numberedMatch[5] ||
      numberedMatch[6];
    const idx = parseInt(numStr, 10) - 1;
    const expList = Array.isArray(profile.work_experience)
      ? profile.work_experience
      : [];
    const exp = expList[idx] as any;
    if (exp) {
      if (/\b(?:employer|company|organization|name of.*employer)\b/i.test(combined)) {
        return exp.company || exp.employer || null;
      }
      if (/\b(?:title|job title|role|position)\b/i.test(combined)) {
        return exp.title || exp.job_title || exp.role || null;
      }
      if (/\b(?:duration|dates?|employment dates?)\b/i.test(combined)) {
        return exp.duration || exp.dates || null;
      }
    }
  }

  // 9. Compliance Defaults: Military Service, Overtime, Travel
  if (
    /\b(?:served in the (?:u\.?s\.?\s*)?armed forces|military service|armed forces|veteran status.*list duties)\b/i.test(
      combined
    )
  ) {
    if (field.type === 'textarea' || field.type === 'text') {
      return 'N/A';
    }
  }

  if (
    /\b(?:willing to work overtime|work overtime if necessary|work overtime)\b/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') return 'true';
    return matchChoiceOption('Yes', field.options) || 'Yes';
  }

  if (
    /\b(?:willing to travel|open to travel|ability to travel)\b/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') return 'true';
    return matchChoiceOption('Yes', field.options) || 'Yes';
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
