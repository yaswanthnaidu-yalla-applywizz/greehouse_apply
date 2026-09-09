/**
 * @fileoverview Dashboard demo fixtures for operator dry-run testing.
 * Uses the same candidate answers as `src/submitter/runUserApplication.ts`.
 */

import path from 'path';
import type {
  CandidateJobApplication,
  CandidateSegment,
  ResolvedField,
  ScannedField,
  ScannedJobTemplate,
} from '../types/index.js';
import type { ApplicationRow } from '../db/applications.js';

export const DEMO_APPLYWIZZ_ID = 'AWL-YASWANTH';
export const DEMO_JOB_URL =
  'https://job-boards.greenhouse.io/pmg/jobs/8765658002?gh_src=lcrm1uib2us';

const resumePath = path.resolve(process.cwd(), 'resumes', 'my-resume.pdf');

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
    fieldId: 'in_which_city_do_you_currently_reside',
    name: 'question_38082676002',
    type: 'text',
    label: 'In which city do you currently reside?',
    value: 'Hyderabad',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'at_pmg_we_fully_embrace_a_collaborative_work_culture_where_emplo',
    name: 'question_38082677002',
    type: 'select',
    label: 'How many days per week are you willing and able to work in-office?',
    value: '5',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'current_or_most_recent_job_title',
    name: 'question_38082678002',
    type: 'text',
    label: 'Current or Most Recent Job Title',
    value: 'Software Engineer',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'current_or_most_recent_company_employer',
    name: 'question_38082679002',
    type: 'text',
    label: 'Current or Most Recent Company/Employer',
    value: 'ApplyWizz / Tech Solutions',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'i_have_read_and_understand_pmg_s_job_applicant_privacy_notice_cl',
    name: 'question_38082680002',
    type: 'select',
    label: "I have read and understand PMG's Job Applicant Privacy Notice",
    value: 'Yes',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'i_consent_to_have_my_personal_data_disclosed_to_other_momentum_g',
    name: 'question_38082681002',
    type: 'select',
    label: 'I consent to have my personal data disclosed',
    value: 'Yes',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'what_are_your_salary_expectations',
    name: 'question_38082682002',
    type: 'text',
    label: 'What are your salary expectations?',
    value: '$130,000',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'do_you_already_reside_in_or_are_you_willing_to_relocate_to_the_c',
    name: 'question_38082683002',
    type: 'select',
    label: 'Do you already reside in or are you willing to relocate',
    value: 'Yes',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'will_you_require_sponsorship_to_work_in_the_united_states_now_or',
    name: 'question_38082684002',
    type: 'select',
    label: 'Will you require sponsorship to work in the United States now or in the future?',
    value: 'Yes',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'are_you_currently_located_in_dallas_tx_or_are_you_willing_to_rel',
    name: 'question_38125012002',
    type: 'select',
    label: 'Are you currently located in Dallas, TX, or are you willing to relocate to Dallas, TX?',
    value: 'Yes',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'are_you_willing_to_come_into_our_dallas_office_4_days_a_week',
    name: 'question_38125013002',
    type: 'select',
    label: 'Are you willing to come into our Dallas office 4 days a week?',
    value: 'Yes',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'do_you_have_at_least_2_years_of_lead_or_management_experience',
    name: 'question_38125240002',
    type: 'select',
    label: 'Do you have at-least 2+ years of Lead or Management experience?',
    value: 'Yes',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'gender',
    name: 'gender',
    type: 'select',
    label: 'Gender',
    value: 'Male',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'hispanic_ethnicity',
    name: 'hispanic_ethnicity',
    type: 'select',
    label: 'Are you Hispanic/Latino?',
    value: 'No',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'race',
    name: 'race',
    type: 'select',
    label: 'Race',
    value: 'Asian',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'veteran_status',
    name: 'veteran_status',
    type: 'select',
    label: 'Veteran Status',
    value: 'I am not a protected veteran',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
  },
  {
    fieldId: 'disability_status',
    name: 'disability_status',
    type: 'select',
    label: 'Disability Status',
    value: 'No, I do not have a disability',
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
    resumeUrl: '',
    localResumePath: resumePath,
  },
  jobs: [
    {
      rawUrl: DEMO_JOB_URL,
      canonicalUrl: DEMO_JOB_URL,
      date: new Date().toISOString().slice(0, 10),
      score: 100,
      scoredJobId: 'pmg-8765658002',
      status: 'PENDING',
    },
  ],
  totalJobs: 1,
  syncedAt: new Date().toISOString(),
};

export const demoTemplate: ScannedJobTemplate = {
  jobUrl: DEMO_JOB_URL,
  companyName: 'PMG',
  jobTitle: 'AI & Software Engineering Manager',
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
  companyName: 'PMG',
  jobTitle: 'AI & Software Engineering Manager',
  status: 'READY_FOR_REVIEW',
  resolvedFields,
};

export function toApplicationRow(app: CandidateJobApplication): ApplicationRow {
  return {
    applywizz_id: app.applywizzId,
    job_url: app.jobUrl,
    company_name: app.companyName,
    job_title: app.jobTitle,
    status: 'READY_FOR_REVIEW',
    resolved_fields: app.resolvedFields,
  };
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
