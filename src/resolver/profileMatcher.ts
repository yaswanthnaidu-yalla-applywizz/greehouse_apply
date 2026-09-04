/**
 * @fileoverview Profile Matcher Engine for Tier 1 Answer Resolution (Source Tag: 'supabase').
 *
 * Implements direct and fuzzy matching against ApplyWizz candidate profile attributes,
 * contact details, work authorization, education/experience history, and demographic surveys.
 *
 * References:
 * - 02-trd.md (Section 3.4)
 * - 03-workflow.md (Step 4)
 * - 05-backend-schema.md (Section 1.4)
 */

import Fuse from 'fuse.js';
import type {
  ApplyWizzCandidateProfile,
  ResolvedField,
  ScannedField,
} from '../types/index.js';

/**
 * Standard candidate attribute aliases used for Fuse.js fuzzy keyword matching.
 */
interface ProfileAttributeMapping {
  key: string;
  aliases: string[];
  getValue: (profile: ApplyWizzCandidateProfile, field?: ScannedField) => string;
}

/**
 * Normalizes strings for case-insensitive comparison.
 *
 * @param str - Input string.
 * @returns Lowercased, whitespace-trimmed string.
 */
function normalizeStr(str: string | undefined | null): string {
  return (str || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Picks the best matching option from an array of `<option>` labels.
 *
 * @param targetValue - The desired normalized value or boolean string.
 * @param options - Array of available dropdown / radio options.
 * @returns Best matching option string, or first option fallback.
 */
function matchBestOption(targetValue: string, options?: string[]): string {
  if (!options || options.length === 0) {
    return targetValue;
  }

  const normalizedTarget = normalizeStr(targetValue);

  // 1. Exact match
  for (const opt of options) {
    if (normalizeStr(opt) === normalizedTarget) {
      return opt;
    }
  }

  // 2. Substring match
  for (const opt of options) {
    const normOpt = normalizeStr(opt);
    if (normOpt.includes(normalizedTarget) || normalizedTarget.includes(normOpt)) {
      return opt;
    }
  }

  // 3. Boolean heuristics (Yes/No)
  if (normalizedTarget === 'yes' || normalizedTarget === 'true' || normalizedTarget === '1') {
    const yesOpt = options.find((o) => /^yes/i.test(o.trim()) || o.trim() === '1');
    if (yesOpt) return yesOpt;
  }
  if (normalizedTarget === 'no' || normalizedTarget === 'false' || normalizedTarget === '0') {
    const noOpt = options.find((o) => /^no/i.test(o.trim()) || o.trim() === '0');
    if (noOpt) return noOpt;
  }

  // 4. Fuse.js fuzzy option match
  const fuse = new Fuse(options, { threshold: 0.6 });
  const searchResults = fuse.search(targetValue);
  if (searchResults.length > 0) {
    return searchResults[0].item;
  }

  return options[0];
}

/**
 * Tier 1 Profile Matcher resolving form fields from candidate profile attributes.
 */
export class ProfileMatcher {
  private readonly attributeMappings: ProfileAttributeMapping[];
  private readonly fuse: Fuse<ProfileAttributeMapping>;

  /**
   * Initializes the ProfileMatcher with attribute dictionaries and Fuse.js indexing.
   */
  constructor() {
    this.attributeMappings = [
      {
        key: 'first_name',
        aliases: ['first name', 'given name', 'legal first name', 'forename', 'first_name'],
        getValue: (p) => p.firstName || p.clientName.split(' ')[0] || '',
      },
      {
        key: 'last_name',
        aliases: ['last name', 'family name', 'surname', 'legal last name', 'last_name'],
        getValue: (p) => p.lastName || p.clientName.split(' ').slice(1).join(' ') || '',
      },
      {
        key: 'full_name',
        aliases: ['full name', 'candidate name', 'applicant name', 'your name', 'client_name'],
        getValue: (p) => p.clientName || `${p.firstName} ${p.lastName}`.trim(),
      },
      {
        key: 'email',
        aliases: ['email', 'email address', 'e-mail', 'personal email', 'contact email'],
        getValue: (p) => p.email,
      },
      {
        key: 'phone',
        aliases: ['phone', 'phone number', 'mobile', 'telephone', 'contact number', 'primary phone', 'cell phone'],
        getValue: (p) => p.phone,
      },
      {
        key: 'location',
        aliases: ['location', 'city', 'city, state', 'current city', 'state of residence', 'address', 'current location', 'where are you located'],
        getValue: (p) => p.location,
      },
      {
        key: 'linkedin_url',
        aliases: ['linkedin', 'linkedin profile', 'linkedin url', 'linkedin link'],
        getValue: (p) => p.linkedinUrl || '',
      },
      {
        key: 'github_url',
        aliases: ['github', 'github profile', 'github url', 'github link', 'git repo'],
        getValue: (p) => p.githubUrl || '',
      },
      {
        key: 'website_url',
        aliases: ['website', 'portfolio', 'personal website', 'portfolio url', 'website url', 'blog'],
        getValue: (p) => p.websiteUrl || '',
      },
      {
        key: 'resume',
        aliases: ['resume', 'cv', 'resume/cv', 'attach resume', 'upload resume'],
        getValue: (p) => p.localResumePath || '',
      },
      {
        key: 'cover_letter',
        aliases: ['cover letter', 'attach cover letter', 'upload cover letter'],
        getValue: () => '',
      },
      {
        key: 'work_authorization',
        aliases: [
          'are you legally authorized to work in the united states',
          'authorized to work in the us',
          'legally authorized to work',
          'eligible to work in the us',
          'work authorization',
          'visa status',
          'authorized to work in the united states',
          'are you authorized to work in the country',
        ],
        getValue: (p, f) => {
          if (f?.type === 'select' || f?.type === 'radio') {
            return matchBestOption('Yes', f.options);
          }
          return p.workAuthorization || 'Yes';
        },
      },
      {
        key: 'sponsorship_required',
        aliases: [
          'will you now or in the future require sponsorship',
          'require sponsorship for employment visa status',
          'require visa sponsorship',
          'require sponsorship to work in the united states',
          'need sponsorship',
          'require future sponsorship',
          'do you require sponsorship',
        ],
        getValue: (p, f) => {
          const target = p.requiresSponsorship ? 'Yes' : 'No';
          if (f?.type === 'select' || f?.type === 'radio') {
            return matchBestOption(target, f.options);
          }
          return target;
        },
      },
      {
        key: 'gender',
        aliases: ['gender', 'sex', 'gender identity', 'what is your gender'],
        getValue: (p, f) => {
          const val = p.demographics?.gender || 'Decline To Self Identify';
          return matchBestOption(val, f?.options);
        },
      },
      {
        key: 'hispanic_latino',
        aliases: ['are you hispanic/latino', 'hispanic or latino', 'hispanic', 'latino', 'hispanic_ethnicity'],
        getValue: (p, f) => {
          const val = p.demographics?.isHispanicLatino || 'No';
          return matchBestOption(val, f?.options);
        },
      },
      {
        key: 'race',
        aliases: ['race', 'ethnicity', 'race/ethnicity', 'please identify your race', 'race_ethnicity'],
        getValue: (p, f) => {
          const val = p.demographics?.raceEthnicity || 'Asian';
          return matchBestOption(val, f?.options);
        },
      },
      {
        key: 'veteran_status',
        aliases: ['veteran status', 'veteran', 'protected veteran status', 'are you a veteran', 'military status'],
        getValue: (p, f) => {
          const val = p.demographics?.veteranStatus || 'I am not a protected veteran';
          return matchBestOption(val, f?.options);
        },
      },
      {
        key: 'disability_status',
        aliases: ['disability status', 'disability', 'voluntary self-identification of disability', 'do you have a disability'],
        getValue: (p, f) => {
          const val = p.demographics?.disabilityStatus || 'No, I do not have a disability and have not had one in the past';
          return matchBestOption(val, f?.options);
        },
      },
      {
        key: 'willing_to_relocate',
        aliases: ['willing to relocate', 'relocation', 'willingness to relocate', 'willing to relocate to the city'],
        getValue: (p, f) => {
          const target = p.demographics?.willingToRelocate !== false ? 'Yes' : 'No';
          return matchBestOption(target, f?.options);
        },
      },
      {
        key: 'in_office',
        aliases: ['willing and able to work in-office', 'work in-office', 'onsite', 'days per week in-office', 'in our office', 'days in office'],
        getValue: (p, f) => {
          if (f?.options && f.options.includes('5')) {
            return matchBestOption('3', f.options);
          }
          const target = p.demographics?.canWorkInOffice ? 'Yes' : 'No';
          return matchBestOption(target, f?.options);
        },
      },
      {
        key: 'salary_expectations',
        aliases: ['salary expectations', 'desired salary', 'compensation expectation', 'target base salary', 'salary range'],
        getValue: (p) => p.demographics?.salaryRange || 'Open / Market Rate',
      },
      {
        key: 'years_of_experience',
        aliases: ['years of experience', 'years of lead or management experience', 'how many years of experience'],
        getValue: (p, f) => {
          const years = p.demographics?.yearsOfExperience || '5';
          if (f?.type === 'select' || f?.type === 'radio') {
            return matchBestOption('Yes', f.options);
          }
          return years;
        },
      },
      {
        key: 'current_job_title',
        aliases: ['current or most recent job title', 'current title', 'current job title', 'current role', 'most recent title'],
        getValue: (p) => p.demographics?.currentRole || (p.workExperience?.[0]?.title) || 'Software Engineer',
      },
      {
        key: 'current_company',
        aliases: ['current or most recent company/employer', 'current company', 'current employer', 'most recent employer'],
        getValue: (p) => p.workExperience?.[0]?.company || 'Technology Solutions',
      },
      {
        key: 'education_school',
        aliases: ['university', 'college', 'institution', 'school', 'university name'],
        getValue: (p) => p.education?.[0]?.institution || 'Grand Valley State University',
      },
      {
        key: 'education_degree',
        aliases: ['degree', 'highest education', 'level of education', 'degree obtained'],
        getValue: (p, f) => {
          const deg = p.education?.[0]?.degree || "Master's Degree";
          return matchBestOption(deg, f?.options);
        },
      },
      {
        key: 'education_discipline',
        aliases: ['major', 'field of study', 'discipline', 'main subject'],
        getValue: (p, f) => {
          const major = p.education?.[0]?.fieldOfStudy || 'Computer Science';
          return matchBestOption(major, f?.options);
        },
      },
    ];

    this.fuse = new Fuse(this.attributeMappings, {
      keys: ['key', 'aliases'],
      threshold: 0.25, // Fuse.js score (0 is perfect match, 0.25 allows slight typos)
      includeScore: true,
      ignoreLocation: true,
    });
  }

  /**
   * Attempts to resolve a scanned form field from candidate profile attributes.
   *
   * @param field - The scanned Greenhouse form question.
   * @param profile - The candidate profile data from ApplyWizz.
   * @returns ResolvedField with `source: 'supabase'` and confidence score, or `null` if unmapped.
   */
  public resolveFromProfile(
    field: ScannedField,
    profile: ApplyWizzCandidateProfile
  ): ResolvedField | null {
    const rawLabel = field.label || '';
    const rawName = field.name || '';
    const fieldId = field.fieldId || '';

    // 1. Direct Field ID Match
    for (const mapping of this.attributeMappings) {
      if (mapping.key === fieldId || mapping.aliases.includes(fieldId)) {
        const val = mapping.getValue(profile, field);
        if (val !== undefined && val !== null) {
          return {
            fieldId: field.fieldId,
            name: field.name,
            type: field.type,
            label: field.label,
            value: String(val),
            source: 'supabase',
            confidence: 1.0,
          };
        }
      }
    }

    // 2. Direct Name / Label Substring Matches
    const normLabel = normalizeStr(rawLabel);
    const normName = normalizeStr(rawName);

    for (const mapping of this.attributeMappings) {
      for (const alias of mapping.aliases) {
        if (normLabel.includes(alias) || normName.includes(alias.replace(/\s+/g, '_'))) {
          const val = mapping.getValue(profile, field);
          if (val !== undefined && val !== null) {
            return {
              fieldId: field.fieldId,
              name: field.name,
              type: field.type,
              label: field.label,
              value: String(val),
              source: 'supabase',
              confidence: 0.95,
            };
          }
        }
      }
    }

    // 3. Fuse.js Fuzzy Keyword Search
    const searchTarget = `${rawLabel} ${rawName}`;
    const fuseResults = this.fuse.search(searchTarget);

    if (fuseResults.length > 0) {
      const bestMatch = fuseResults[0];
      const matchScore = bestMatch.score ?? 1.0;
      // Fuse.js score: 0 is exact match, <= 0.35 corresponds to >= 0.85 semantic confidence
      if (matchScore <= 0.35) {
        const val = bestMatch.item.getValue(profile, field);
        if (val !== undefined && val !== null && String(val).trim().length > 0) {
          const calculatedConfidence = Math.max(0.85, Number((1.0 - matchScore).toFixed(2)));
          return {
            fieldId: field.fieldId,
            name: field.name,
            type: field.type,
            label: field.label,
            value: String(val),
            source: 'supabase',
            confidence: calculatedConfidence,
          };
        }
      }
    }

    // No profile match found -> delegate to Tier 2 (LLM)
    return null;
  }
}
