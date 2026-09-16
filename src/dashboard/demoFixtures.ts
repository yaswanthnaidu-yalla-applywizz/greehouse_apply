/**
 * @fileoverview Dashboard demo fixtures for operator dry-run testing.
 * Uses the same candidate answers as `src/submitter/runUserApplication.ts`.
 */

import type {
  CandidateJobApplication,
  CandidateSegment,
  ResolvedField,
  ScannedField,
  ScannedJobTemplate,
} from '../types/index.js';
import type { ApplicationRow } from '../db/applications.js';
import { akshithaInMemoryDemoJobRows } from './generatedDemoFixtures.js';
import { AKSHITHA_APPLYWIZZ_ID } from './akshithaDemoFixtures.js';

export const DEMO_APPLYWIZZ_ID = 'AWL-YASWANTH';
export const DEMO_JOB_URL =
  'https://job-boards.greenhouse.io/internshiplist2000/jobs/5376578008';

export const DEMO_STORAGE_RESUME_PATH = 'resumes/AWL-YASHANTH_resume.pdf';
const resumePath = DEMO_STORAGE_RESUME_PATH;

const resolvedFields: ResolvedField[] = [
  {
    fieldId: 'first_name',
    name: 'first_name',
    type: 'text',
    label: 'First Name',
    value: 'Yaswanth Naidu',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'last_name',
    name: 'last_name',
    type: 'text',
    label: 'Last Name',
    value: 'Yalla',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'email',
    name: 'email',
    type: 'text',
    label: 'Email',
    value: 'portgasdiscord@gmail.com',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'phone',
    name: 'phone',
    type: 'text',
    label: 'Phone',
    value: '+91 9573939153',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'location',
    name: 'candidate_location',
    type: 'location_autocomplete',
    label: 'Candidate Location',
    value: 'Hyderabad, Telangana, India',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'resume',
    name: 'resume',
    type: 'file',
    label: 'Resume/CV',
    value: resumePath,
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'cover_letter',
    name: 'cover_letter',
    type: 'file',
    label: 'Cover Letter',
    value: '',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'preferred_name',
    name: 'question_18139498008',
    type: 'text',
    label: 'Preferred name',
    value: 'Yaswanth',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'linkedin_url',
    name: 'question_18139499008',
    type: 'text',
    label: 'LinkedIn Profile',
    value: 'https://linkedin.com/in/yaswanth-yalla',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'github_url',
    name: 'question_18139500008',
    type: 'text',
    label: 'Github URL',
    value: '',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'website_url',
    name: 'question_18139501008',
    type: 'text',
    label: 'Portfolio URL',
    value: '',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'website_url',
    name: 'question_18139502008',
    type: 'text',
    label: 'Other Website',
    value: '',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'country',
    name: 'question_18139503008',
    type: 'text',
    label: 'City & Country in which you are currently located',
    value: 'Hyderabad, India',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'where_did_you_hear_about_geotab',
    name: 'question_18139504008',
    type: 'select',
    label: 'Where did you hear about Geotab?',
    value: 'LinkedIn',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'how_did_you_hear_about_this_job_opportunity',
    name: 'question_18139505008',
    type: 'select',
    label: 'How did you hear about this job opportunity?',
    value: 'Handshake',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'are_you_legally_authorized_to_work_in_the_region_in_which_the_po',
    name: 'question_18139506008',
    type: 'select',
    label: 'Are you legally authorized to work in the region in which the position you are applying for is located?',
    value: 'Yes',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'what_field_are_you_looking_to_complete_your_internship_in',
    name: 'question_18139507008',
    type: 'select',
    label: 'What field are you looking to complete your internship in?',
    value: 'Software Development',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'what_term_were_you_looking_to_start_your_internship_month_day_ye',
    name: 'question_18139508008',
    type: 'text',
    label: 'What term were you looking to start your internship? (Month/Day/Year)?',
    value: 'January 2027',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'how_long_of_an_internship_are_you_looking_for_select_all_that_ap',
    name: 'question_18139509008[]',
    type: 'select',
    label: 'How long of an internship are you looking for? (Select all that apply)',
    value: '4 months',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'what_are_your_hourly_compensation_expectations_for_the_role_you_',
    name: 'question_18139510008',
    type: 'text',
    label: 'What are your hourly compensation expectations for the role you are applying for?',
    value: 'Competitive / Open to negotiation',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'what_is_your_expected_date_of_graduation_month_year',
    name: 'question_18139511008',
    type: 'text',
    label: 'What is your expected date of graduation (month/year)?',
    value: 'May 2026',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'is_the_internship_part_of_your_co_op_requirement',
    name: 'question_18139512008',
    type: 'select',
    label: 'Is the internship part of your co-op requirement?',
    value: 'No',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'will_you_consent_to_a_background_check_all_offers_of_employment_',
    name: 'question_18139513008',
    type: 'select',
    label: 'Will you consent to a background check? (All offers of employment are contingent on passing a background check)',
    value: 'Yes',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'were_you_previously_employed_with_geotab',
    name: 'question_18139514008',
    type: 'select',
    label: 'Were you previously employed with Geotab?',
    value: 'No',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'country',
    name: 'question_18139515008',
    type: 'select',
    label: 'If you are a veteran of the armed forces in your country and would like to identify this fact to our recruiting team, please select one of the options below',
    value: 'I am not a veteran',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'school',
    name: 'school--0',
    type: 'select',
    label: 'School',
    value: 'Other',
    source: 'resume_parse',
    resolvedByTier: 2,
    confidence: 0.75,
  },
  {
    fieldId: 'degree',
    name: 'degree--0',
    type: 'select',
    label: 'Degree',
    value: "Bachelor's",
    source: 'resume_parse',
    resolvedByTier: 2,
    confidence: 0.9,
  },
  {
    fieldId: 'discipline',
    name: 'discipline--0',
    type: 'select',
    label: 'Discipline',
    value: 'Computer Science',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'end_date_month',
    name: 'end-month--0',
    type: 'select',
    label: 'End date month',
    value: 'April',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'end_date_year',
    name: 'end-year--0',
    type: 'text',
    label: 'End date year',
    value: '2027',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.8,
  },
  {
    fieldId: 'race',
    name: '4005224008',
    type: 'select',
    label: 'I identify my ethnicity as (select all that apply):',
    value: '',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'what_gender_do_you_identify_as',
    name: '4005225008',
    type: 'select',
    label: 'What gender do you identify as?',
    value: '',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'does_the_role_you_are_applying_for_include_managing_direct_repor',
    name: '4005226008',
    type: 'select',
    label: 'Does the role you are applying for include managing direct reports?',
    value: '',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'disability_status',
    name: '4005227008',
    type: 'select',
    label: 'Geotab is committed to connecting, hiring and providing equal opportunity to qualified people with disabilities. Please select a response below as it relates to disability.',
    value: '',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'by_checking_this_box_i_consent_to_internship_list_collecting_sto',
    name: 'gdpr_demographic_data_consent_given',
    type: 'checkbox',
    label: 'By checking this box, I consent to Internship List collecting, storing, and processing my responses to the demographic data surveys above.',
    value: 'true',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
];


export const demoSegment: CandidateSegment = {
  applywizzId: DEMO_APPLYWIZZ_ID,
  clientName: 'Yaswanth Naidu Yalla',
  profile: {
    applywizzId: DEMO_APPLYWIZZ_ID,
    clientName: 'Yaswanth Naidu Yalla',
    firstName: 'Yaswanth Naidu',
    lastName: 'Yalla',
    email: 'portgasdiscord@gmail.com',
    phone: '+91 9573939153',
    country: 'India',
    countryCode: '+91',
    location: 'Hyderabad, Telangana, India',
    linkedinUrl: '',
    workAuthorization: 'Requires Sponsorship',
    requiresSponsorship: true,
    education: [],
    workExperience: [],
    resumeUrl: DEMO_STORAGE_RESUME_PATH,
    localResumePath: DEMO_STORAGE_RESUME_PATH,
  },
  jobs: [
    {
      rawUrl: DEMO_JOB_URL,
      canonicalUrl: DEMO_JOB_URL,
      date: new Date().toISOString().slice(0, 10),
      score: 100,
      scoredJobId: 'internshiplist2000-5376578008',
      status: 'PENDING',
    },
  ],
  totalJobs: 1,
  syncedAt: new Date().toISOString(),
};

export const demoTemplate: ScannedJobTemplate = {
  jobUrl: DEMO_JOB_URL,
  companyName: 'Internship List',
  jobTitle: 'Software Developer Intern, Geotab Vitality (Winter/January 2027, 4 Months)',
  fields: resolvedFields.map(
    (field): ScannedField => ({
      fieldId: field.fieldId,
      name: field.name,
      type: field.type as ScannedField['type'],
      label: field.label,
      isRequired: true,
    })
  ),
  scannedAt: new Date().toISOString(),
  isExpired: false,
};

export const demoApplication: CandidateJobApplication = {
  applywizzId: DEMO_APPLYWIZZ_ID,
  candidateName: 'Yaswanth Naidu Yalla',
  jobUrl: DEMO_JOB_URL,
  companyName: 'Internship List',
  jobTitle: 'Software Developer Intern, Geotab Vitality (Winter/January 2027, 4 Months)',
  status: 'READY_FOR_REVIEW',
  resolvedFields,
};

export function toApplicationRow(app: CandidateJobApplication): ApplicationRow {
  const rowId = (app as any).id || `${app.applywizzId}_${Buffer.from(app.jobUrl).toString('base64url').slice(0, 16)}`;
  return {
    id: rowId,
    applywizz_id: app.applywizzId,
    job_url: app.jobUrl,
    company_name: app.companyName,
    job_title: app.jobTitle,
    status: 'READY_FOR_REVIEW',
    resolved_fields: app.resolvedFields,
  };
}

export function inMemoryDemoJobRowsForDashboard(applywizzId: string): Array<Record<string, unknown>> {
  const target = applywizzId.trim().toUpperCase();
  if (target === DEMO_APPLYWIZZ_ID.toUpperCase()) {
    return [
      {
        rawUrl: demoApplication.jobUrl,
        canonicalUrl: demoApplication.jobUrl,
        companyName: demoApplication.companyName,
        jobTitle: demoApplication.jobTitle,
        status: 'READY_FOR_REVIEW',
        fieldsCount: demoApplication.resolvedFields.length,
        resolved_fields: demoApplication.resolvedFields,
        resolvedFields: demoApplication.resolvedFields,
        hasManualEdits: false,
        isInMemoryDemoFixture: true,
      },
    ];
  }
  if (target === AKSHITHA_APPLYWIZZ_ID.toUpperCase()) {
    return akshithaInMemoryDemoJobRows();
  }
  return [];
}

export function mergeDemoFixtures<T extends { applywizzId?: string; jobUrl?: string }>(
  existing: T[],
  additions: T[],
  keyFn: (item: T) => string
): T[] {
  const merged = [...existing];
  for (const item of additions) {
    const key = keyFn(item);
    const index = merged.findIndex((entry) => keyFn(entry) === key);
    if (index >= 0) {
      merged[index] = item;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

export {
  AKSHITHA_APPLYWIZZ_ID,
  GENERATED_DEMO_APPLYWIZZ_ID,
  loadSecondaryDemoArtifacts,
  readGeneratedDemoFixtures,
} from './generatedDemoFixtures.js';

// AWL-31428 admin demo: src/dashboard/fixtures/AWL-31428.generated.json (npm run demo:fixture-31428)
