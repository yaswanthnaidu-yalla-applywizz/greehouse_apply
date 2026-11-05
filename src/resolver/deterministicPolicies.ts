/**
 * @fileoverview Approved deterministic policies evaluated immediately before Tier 5.
 */

import type {
  FieldIntent,
  JobPostingFacts,
  ResolutionProvenance,
  ScannedField,
} from '../types/index.js';
import type { ProfileRow } from '../db/profiles.js';
import {
  matchChoiceOption,
  mapSalaryRangeToOption,
  mapWorkplaceLocationToOption,
} from '../utils/choiceOptions.js';

export interface PolicyResolution {
  value: string;
  source: 'policy';
  policyId: string;
  confidence: number;
  provenance: ResolutionProvenance;
}

export interface JobContext {
  jobPostingLocation?: string;
  jobPostingFacts?: JobPostingFacts;
  companyName?: string;
  jobTitle?: string;
}

export function resolveDeterministicPolicy(
  field: ScannedField,
  intent: FieldIntent,
  profile?: ProfileRow | null,
  jobContext?: JobContext
): PolicyResolution | null {
  const options = field.options || [];
  const text = `${field.label} ${field.name} ${field.fieldId}`.toLowerCase();

  // 1. SMS / WhatsApp consent
  if (intent.family === 'agreement_consent' && intent.qualifier === 'sms') {
    if (field.type === 'text' || field.metadata?.inputType === 'tel') {
      return null;
    }
    const noChoice = matchChoiceOption('No', options);
    if (noChoice) {
      return {
        value: noChoice,
        source: 'policy',
        policyId: 'policy_sms_consent',
        confidence: 0.99,
        provenance: {
          family: intent.family,
          policyId: 'policy_sms_consent',
          choiceMatch: noChoice,
          confidence: 0.99,
        },
      };
    }
    return null;
  }

  // 2. Mandatory agreements (AI policy, terms, privacy, recording, certification)
  if (intent.family === 'agreement_consent') {
    const agreeChoice = matchChoiceOption('Yes', options) || matchChoiceOption('I Agree', options);
    if (agreeChoice) {
      return {
        value: agreeChoice,
        source: 'policy',
        policyId: 'policy_mandatory_agreements',
        confidence: 0.99,
        provenance: {
          family: intent.family,
          policyId: 'policy_mandatory_agreements',
          choiceMatch: agreeChoice,
          confidence: 0.99,
        },
      };
    }
    return null;
  }

  // 3. Work Authorization
  if (intent.family === 'work_authorization') {
    const payload = profile?.raw_api_payload || {};
    const visaType = (profile as any)?.visa_type || payload.visa_type || payload.visa_status;
    if (/visa.*type|visa.*status/i.test(text) && visaType) {
      const mapped = matchChoiceOption(String(visaType), options);
      if (mapped) {
        return {
          value: mapped,
          source: 'policy',
          policyId: 'policy_visa_type',
          confidence: 0.95,
          provenance: {
            family: intent.family,
            policyId: 'policy_visa_type',
            evidenceKind: 'profile_payload',
            evidenceKey: 'visa_type',
            choiceMatch: mapped,
            confidence: 0.95,
          },
        };
      }
    }
    const authChoice = matchChoiceOption('Yes', options);
    if (authChoice) {
      return {
        value: authChoice,
        source: 'policy',
        policyId: 'policy_work_authorization_positive',
        confidence: 0.98,
        provenance: {
          family: intent.family,
          policyId: 'policy_work_authorization_positive',
          choiceMatch: authChoice,
          confidence: 0.98,
        },
      };
    }
    return null;
  }

  // 4. Sponsorship
  if (intent.family === 'sponsorship') {
    if (profile?.requires_sponsorship !== undefined && profile?.requires_sponsorship !== null) {
      const isYes =
        profile.requires_sponsorship === true ||
        String(profile.requires_sponsorship).toLowerCase() === 'yes';
      const mapped = matchChoiceOption(isYes ? 'Yes' : 'No', options);
      if (mapped) {
        return {
          value: mapped,
          source: 'policy',
          policyId: 'policy_sponsorship_profile',
          confidence: 0.98,
          provenance: {
            family: intent.family,
            policyId: 'policy_sponsorship_profile',
            evidenceKind: 'profile_payload',
            evidenceKey: 'requires_sponsorship',
            choiceMatch: mapped,
            confidence: 0.98,
          },
        };
      }
    }
    return null;
  }

  // 5. Legal History (Felony / Conviction)
  if (intent.family === 'legal_history') {
    const felonyVal = (profile as any)?.felony ?? (profile as any)?.has_felony;
    if (felonyVal !== undefined && felonyVal !== null) {
      const mapped = matchChoiceOption(String(felonyVal), options);
      if (mapped) {
        return {
          value: mapped,
          source: 'policy',
          policyId: 'policy_legal_history_profile',
          confidence: 0.98,
          provenance: {
            family: intent.family,
            policyId: 'policy_legal_history_profile',
            choiceMatch: mapped,
            confidence: 0.98,
          },
        };
      }
    }
    const noChoice = matchChoiceOption('No', options);
    if (noChoice) {
      return {
        value: noChoice,
        source: 'policy',
        policyId: 'policy_legal_history_default_no',
        confidence: 0.95,
        provenance: {
          family: intent.family,
          policyId: 'policy_legal_history_default_no',
          choiceMatch: noChoice,
          confidence: 0.95,
        },
      };
    }
    return null;
  }

  // 6. Former employment relationship
  if (intent.family === 'employer_history') {
    if (/worked here|former employee|previous employee|prior employee|employed by/i.test(text)) {
      const noChoice = matchChoiceOption('No', options);
      if (noChoice) {
        return {
          value: noChoice,
          source: 'policy',
          policyId: 'policy_prior_employment_no',
          confidence: 0.95,
          provenance: {
            family: intent.family,
            policyId: 'policy_prior_employment_no',
            choiceMatch: noChoice,
            confidence: 0.95,
          },
        };
      }
    }
    return null;
  }

  // 7. Age (18 or older)
  if (/18.*years|legal.*age|age.*18/i.test(text)) {
    const yesChoice = matchChoiceOption('Yes', options);
    if (yesChoice) {
      return {
        value: yesChoice,
        source: 'policy',
        policyId: 'policy_age_affirmative',
        confidence: 0.98,
        provenance: {
          family: intent.family,
          policyId: 'policy_age_affirmative',
          choiceMatch: yesChoice,
          confidence: 0.98,
        },
      };
    }
  }

  // 8. Demographics
  if (intent.family === 'demographics') {
    const payload = profile?.raw_api_payload || {};
    if (/pronoun/i.test(text)) {
      const gender = String((profile as any)?.gender || payload.gender || '').toLowerCase();
      if (gender === 'male') {
        const choice = matchChoiceOption('he/him', options);
        if (choice) {
          return {
            value: choice,
            source: 'policy',
            policyId: 'policy_pronoun_male',
            confidence: 0.98,
            provenance: {
              family: intent.family,
              policyId: 'policy_pronoun_male',
              choiceMatch: choice,
              confidence: 0.98,
            },
          };
        }
      } else if (gender === 'female') {
        const choice = matchChoiceOption('she/her', options);
        if (choice) {
          return {
            value: choice,
            source: 'policy',
            policyId: 'policy_pronoun_female',
            confidence: 0.98,
            provenance: {
              family: intent.family,
              policyId: 'policy_pronoun_female',
              choiceMatch: choice,
              confidence: 0.98,
            },
          };
        }
      }
    }

    if (/veteran|military/i.test(text)) {
      const vetVal =
        (profile as any)?.is_veteran ??
        (profile as any)?.veteran_status ??
        payload.is_veteran ??
        payload.veteran_status;
      if (vetVal !== undefined && vetVal !== null) {
        const mapped = matchChoiceOption(String(vetVal), options);
        if (mapped) {
          return {
            value: mapped,
            source: 'policy',
            policyId: 'policy_veteran_profile',
            confidence: 0.98,
            provenance: {
              family: intent.family,
              policyId: 'policy_veteran_profile',
              choiceMatch: mapped,
              confidence: 0.98,
            },
          };
        }
      }
      const noChoice = matchChoiceOption('No', options) || matchChoiceOption('not a veteran', options);
      if (noChoice) {
        return {
          value: noChoice,
          source: 'policy',
          policyId: 'policy_veteran_default_no',
          confidence: 0.95,
          provenance: {
            family: intent.family,
            policyId: 'policy_veteran_default_no',
            choiceMatch: noChoice,
            confidence: 0.95,
          },
        };
      }
    }

    if (/race|ethnic/i.test(text)) {
      const raceVal = (profile as any)?.race || payload.race || payload.ethnicity;
      if (raceVal) {
        const mapped = matchChoiceOption(String(raceVal), options);
        if (mapped) {
          return {
            value: mapped,
            source: 'policy',
            policyId: 'policy_race_profile',
            confidence: 0.98,
            provenance: {
              family: intent.family,
              policyId: 'policy_race_profile',
              choiceMatch: mapped,
              confidence: 0.98,
            },
          };
        }
      }
      const asianChoice = matchChoiceOption('Asian', options);
      if (asianChoice) {
        return {
          value: asianChoice,
          source: 'policy',
          policyId: 'policy_race_default_asian',
          confidence: 0.95,
          provenance: {
            family: intent.family,
            policyId: 'policy_race_default_asian',
            choiceMatch: asianChoice,
            confidence: 0.95,
          },
        };
      }
    }

    // Default decline/prefer not to answer option for remaining demographic fields
    const declineChoice = matchChoiceOption('decline', options);
    if (declineChoice) {
      return {
        value: declineChoice,
        source: 'policy',
        policyId: 'policy_demographic_decline',
        confidence: 0.95,
        provenance: {
          family: intent.family,
          policyId: 'policy_demographic_decline',
          choiceMatch: declineChoice,
          confidence: 0.95,
        },
      };
    }

    return null;
  }

  // 9. Outside employment, relationship, conflict, export control, prior application
  if (/outside employment|conflict of interest|export control|prior application|applied before|relative/i.test(text)) {
    const noChoice = matchChoiceOption('No', options);
    if (noChoice) {
      return {
        value: noChoice,
        source: 'policy',
        policyId: 'policy_conflict_outside_employment_no',
        confidence: 0.95,
        provenance: {
          family: intent.family,
          policyId: 'policy_conflict_outside_employment_no',
          choiceMatch: noChoice,
          confidence: 0.95,
        },
      };
    }
    return null;
  }

  // 10. Workplace location & Relocation
  if (intent.family === 'workplace_preference') {
    const targetLocation =
      jobContext?.jobPostingLocation ||
      (jobContext as any)?.postingLocation ||
      jobContext?.jobPostingFacts?.location;
    if (targetLocation) {
      const mapped = mapWorkplaceLocationToOption(targetLocation, options);
      if (mapped) {
        return {
          value: mapped,
          source: 'policy',
          policyId: 'policy_workplace_location',
          confidence: 0.98,
          provenance: {
            family: intent.family,
            policyId: 'policy_workplace_location',
            evidenceKind: 'job_posting_location',
            evidenceKey: targetLocation,
            choiceMatch: mapped,
            confidence: 0.98,
          },
        };
      }
      return null;
    }

    // When no posting location exists, check for relocation question
    if (/relocat/i.test(text)) {
      const affChoice = matchChoiceOption('Yes', options) || matchChoiceOption('willing', options);
      if (affChoice) {
        return {
          value: affChoice,
          source: 'policy',
          policyId: 'policy_relocation_affirmative',
          confidence: 0.95,
          provenance: {
            family: intent.family,
            policyId: 'policy_relocation_affirmative',
            choiceMatch: affChoice,
            confidence: 0.95,
          },
        };
      }
    }
    return null;
  }

  // 11. Salary / Compensation
  if (intent.family === 'compensation') {
    const salary = (profile as any)?.desired_salary || (profile as any)?.salary_expectation;
    if (salary) {
      const mapped = mapSalaryRangeToOption(salary, options);
      if (mapped) {
        return {
          value: mapped,
          source: 'policy',
          policyId: 'policy_salary_band',
          confidence: 0.95,
          provenance: {
            family: intent.family,
            policyId: 'policy_salary_band',
            choiceMatch: mapped,
            confidence: 0.95,
          },
        };
      }
    }
    return null;
  }

  return null;
}
