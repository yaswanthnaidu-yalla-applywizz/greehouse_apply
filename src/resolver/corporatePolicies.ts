import type { ScannedField, ResolvedField } from '../types/index.js';
import type { ProfileRow } from '../db/profiles.js';
import { matchChoiceOption } from '../utils/choiceOptions.js';

export const CORPORATE_POLICY_PROMPT_GUIDELINES = `
CORPORATE POLICIES & MANDATORY ANSWER GUIDELINES:
1. Prior Interview & Employment History: If the question asks if the candidate previously worked at, was previously employed by, or has interviewed with the hiring company in the past, always answer No (or choose the negative option).
2. Mandatory Agreements & Policies: For terms & conditions, arbitration agreements, privacy policies, AI usage/application policies, or declarations, always agree/accept (choose the affirmative option, e.g. "I agree", "Yes", or true).
3. Communication & Messaging Consent: If asked for consent to receive text messages, SMS, or WhatsApp communications regarding the application, always decline (answer No, or false).
4. Job Source / Referral: When asked how the candidate heard about this opportunity or role, select the option containing "LinkedIn" if available (fallback to "Job Board" or "Career site"), or return "LinkedIn" for free text.
5. Human Candidate Identity & Anti-Bot Screening: You are answering as the human job applicant. NEVER identify as an AI, bot, automated program, language model, or virtual assistant. When answering questions that distinguish human candidates from automated tools (e.g. "Which of the following best describes you?", "Are you an AI or automated system?"), ALWAYS select the human applicant option (e.g. "I am a human.") or answer "No".
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

  // 1d. Employee Relatives & Personal Ties (Anti-Nepotism / Conflict of Interest) -> Always "No"
  if (
    /\b(?:related to|family member|relative|personal ties|close ties)\b.*(?:employee|worker|staff|anyone (?:at|with))|any.*(?:employee|worker|staff).*(?:related to|family member|relative|personal ties|close ties)/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') {
      return 'false';
    }
    return matchChoiceOption('No', field.options) || 'No';
  }

  // 1e. Employee Referral & Internal Applicant Screening -> Always "No"
  if (
    /\b(?:referral from a current employee|referred by a current employee|are you an internal candidate|applying as an internal candidate|currently an employee (?:with|at|of))\b/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') {
      return 'false';
    }
    return matchChoiceOption('No', field.options) || 'No';
  }

  // 1c. Anti-Bot / Human Verification Screening Traps -> Always human
  if (
    /\b(?:which.*best describes you|are you a human|confirm you are human|automated program|if you are an? (?:ai|large language model|llm)|select .* if you are an? ai)\b/i.test(combined) &&
    Array.isArray(field.options) &&
    field.options.some((opt) => /\bhuman\b/i.test(opt))
  ) {
    const humanOpt = field.options.find((opt) => /\bhuman\b/i.test(opt) && !/\b(?:ai|bot|automated|nelly)\b/i.test(opt));
    if (humanOpt) return humanOpt;
    return 'Human';
  }

  // 2. Communication / SMS / WhatsApp Consent & Recruitment Marketing Opt-Out -> Always "No"
  if (
    /\b(?:sms|text message|text messages|whatsapp|mobile messaging|marketing|promotional|talent network|talent community)\b/i.test(combined) &&
    /\b(?:receive|consent|opt-in|opt in|updates|notifications|contact you|reach you|keep in touch|future opportunities|promotions)\b/i.test(combined)
  ) {
    if (field.type === 'checkbox') {
      return 'false';
    }
    const negativeOpt = field.options?.find((opt) => /\b(?:no\b|do not consent|decline|opt out)\b/i.test(opt));
    if (negativeOpt) return negativeOpt;
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
    /\b(?:how did you (?:(?:\w+)\s+)?(?:hear|learn)|where did you (?:(?:\w+)\s+)?(?:hear|learn)|source of application|job source|referral source|hear about (?:this|the|us|[A-Z])|find this (?:job|role|posting|opportunity))\b/i.test(
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

  // 4b. Availability & Notice Period -> "2 weeks" / "Immediately"
  if (
    /\b(?:current notice period|notice required|notice period)\b/i.test(combined)
  ) {
    if (Array.isArray(field.options) && field.options.length > 0) {
      const opt = field.options.find((o) => /\b(?:immediate|2 weeks|two weeks|1 month)\b/i.test(o));
      if (opt) return opt;
      return field.options[0];
    }
    return '2 weeks';
  }
  if (
    /\b(?:date (?:you can|you are available to) start|when (?:can you|are you available to) start|availability to start|earliest start date)\b/i.test(combined)
  ) {
    if (Array.isArray(field.options) && field.options.length > 0) {
      const opt = field.options.find((o) => /\b(?:immediate|immediately|within 2 weeks|two weeks)\b/i.test(o));
      if (opt) return opt;
      return field.options[0];
    }
    return 'Immediately';
  }

  // 4c. In-Person / Hybrid Work Attendance Commitment -> Affirmative
  if (
    /\b(?:work from the office|in-person.*days|hybrid.*work model|able to work in person|meet this in-person requirement|willing and able to work.*(?:onsite|on-site|hybrid))\b/i.test(combined)
  ) {
    if (field.type === 'checkbox') {
      return 'true';
    }
    if (Array.isArray(field.options) && field.options.length > 0) {
      const affOpt = field.options.find((opt) =>
        /^(?:yes\b|willing to relocate)/i.test(opt.trim()) ||
        /\b(?:based in this location|able to work from the office|meet this requirement)\b/i.test(opt)
      );
      if (affOpt) return affOpt;
      return matchChoiceOption('Yes', field.options) || field.options[0];
    }
    return 'Yes';
  }

  // 5. Sanctioned Countries & Export Controls
  // Export Administration Regulations (EAR) / ITAR U.S. Person Compliance
  if (
    /\b(?:u\.?s\.?\s*person.*(?:ear|itar)|ear.*definition.*u\.?s\.?\s*person|export control.*u\.?s\.?\s*person)\b/i.test(combined)
  ) {
    const isNonImmigrant =
      profile?.requires_sponsorship === true ||
      profile?.work_authorization === 'F1' ||
      profile?.work_authorization === 'H1B' ||
      profile?.work_authorization === 'Other';
    const target = isNonImmigrant ? 'No' : 'Yes';
    if (Array.isArray(field.options) && field.options.length > 0) {
      if (isNonImmigrant) {
        const notPersonOpt = field.options.find((opt) => /\bnot\s+a\s+u\.?s\.?\s*person\b/i.test(opt));
        if (notPersonOpt) return notPersonOpt;
      } else {
        const personOpt = field.options.find((opt) => /\bi am a u\.?s\.?\s*person\b/i.test(opt));
        if (personOpt) return personOpt;
      }
      return matchChoiceOption(target, field.options) || target;
    }
    return target;
  }

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

  // 5b. Future Sponsorship Polarity for F1 / H1B / Non-immigrants
  if (
    /\b(?:future.*(?:sponsor|visa|work auth)|(?:sponsor|visa).*future|now or in the future|at any point in the future|will you (?:at any time )?require (?:visa )?sponsorship)/i.test(
      combined
    )
  ) {
    const isNonImmigrantVisa =
      profile?.requires_sponsorship === true ||
      profile?.work_authorization === 'F1' ||
      profile?.work_authorization === 'H1B' ||
      profile?.work_authorization === 'OPT' ||
      profile?.work_authorization === 'CPT' ||
      profile?.work_authorization === 'Other';

    const target = isNonImmigrantVisa ? 'Yes' : 'No';
    if (field.type === 'checkbox') {
      return isNonImmigrantVisa ? 'true' : 'false';
    }
    return matchChoiceOption(target, field.options) || target;
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
    if (Array.isArray(field.options) && field.options.length > 0) {
      const direct = matchChoiceOption('Yes', field.options);
      if (direct) return direct;
      const sfOrUs = field.options.find((opt) => /san francisco|\b(?:us|usa|united states)\b/i.test(opt));
      if (sfOrUs) return sfOrUs;
      const firstAffirmative = field.options.find((opt) => /^(?:yes|agree)\b/i.test(opt.trim()));
      if (firstAffirmative) return firstAffirmative;
      return null;
    }
    return 'Yes';
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
    if (Array.isArray(field.options) && field.options.length > 0) {
      return matchChoiceOption('Yes', field.options);
    }
    return 'Yes';
  }

  if (
    /\b(?:willing to travel|open to travel|ability to travel)\b/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') return 'true';
    if (Array.isArray(field.options) && field.options.length > 0) {
      const direct = matchChoiceOption('Yes', field.options);
      if (direct) return direct;
      const both = field.options.find((opt) => /^both$/i.test(opt.trim()));
      if (both) return both;
      const nation = field.options.find((opt) => /nationwide|state-wide|any/i.test(opt));
      if (nation) return nation;
      return field.options[0];
    }
    return 'Yes';
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

  // If the field has options and policyVal is not in options, do not clamp
  if (Array.isArray(field.options) && field.options.length > 0 && !field.options.includes(policyVal)) {
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
