/**
 * Bundled AWL-31428 (Akshitha G) admin demo fixtures.
 * Used when AWL-31428.generated.json is absent (e.g. Railway deploy).
 */

import type {
  CandidateJobApplication,
  CandidateSegment,
  ResolvedField,
  ScannedField,
  ScannedJobTemplate,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// AKSHITHA G (AWL-31428) Admin Fixtures
// ---------------------------------------------------------------------------

export const AKSHITHA_APPLYWIZZ_ID = 'AWL-31428';
export const AKSHITHA_RESUME_STORAGE_PATH = 'resumes/AWL-31428_resume.pdf';

export const akshithaSegment: CandidateSegment = {
  applywizzId: AKSHITHA_APPLYWIZZ_ID,
  clientName: 'AKSHITHA G',
  profile: {
    applywizzId: AKSHITHA_APPLYWIZZ_ID,
    clientName: 'AKSHITHA G',
    firstName: 'AKSHITHA',
    lastName: 'G',
    email: 'akshitha.reddy@applywizard.ai',
    phone: '940-222-8193',
    country: 'United States of America',
    countryCode: '+1',
    location: 'Dallas, Texas, United States',
    linkedinUrl: 'https://www.linkedin.com/in/akshitha-reddy',
    workAuthorization: 'H1B',
    requiresSponsorship: true,
    education: [
      {
        institution: 'University of North Texas',
        degree: 'MasterΓÇÖs Degree',
        fieldOfStudy: 'Computer Science',
        graduationYear: '2023',
      },
    ],
    workExperience: [
      {
        company: 'Professional Experience',
        title: 'Business Analyst',
        startDate: '01/2020',
        endDate: 'Present',
        description: 'Total years of professional experience: 4. Role: Business Analyst',
      },
    ],
    resumeUrl: AKSHITHA_RESUME_STORAGE_PATH,
    localResumePath: AKSHITHA_RESUME_STORAGE_PATH,
    demographics: {
      gender: 'Female',
      isHispanicLatino: 'No',
      raceEthnicity: 'Asian',
      veteranStatus: 'I am not a protected veteran',
      disabilityStatus: 'No, I do not have a disability',
      willingToRelocate: true,
      canWorkInOffice: true,
      salaryRange: 'USD Yearly: 80k-100k, Hourly: 40-60',
      yearsOfExperience: '4',
      currentRole: 'Business Analyst',
    },
  },
  jobs: [
    {
      rawUrl: 'https://grnh.se/zqe6mzwz3us',
      canonicalUrl: 'https://grnh.se/zqe6mzwz3us',
      date: new Date().toISOString().slice(0, 10),
      score: 95,
      scoredJobId: 'doit-product-analyst',
      status: 'READY',
    },
  ],
  totalJobs: 1,
  syncedAt: new Date().toISOString(),
};

const doitResolvedFields: ResolvedField[] = [
  { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name', value: 'AKSHITHA', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'last_name', name: 'last_name', type: 'text', label: 'Last Name', value: 'G', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'email', name: 'email', type: 'text', label: 'Email', value: 'akshitha.reddy@applywizard.ai', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'phone', name: 'phone', type: 'text', label: 'Phone', value: '940-222-8193', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'resume', name: 'resume', type: 'file', label: 'Resume/CV', value: AKSHITHA_RESUME_STORAGE_PATH, source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'cover_letter', name: 'cover_letter', type: 'file', label: 'Cover Letter', value: '', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'website_url', name: 'question_32541698003', type: 'text', label: 'Website', value: '', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'linkedin_url', name: 'question_32541699003', type: 'text', label: 'LinkedIn Profile', value: 'https://www.linkedin.com/in/akshitha-reddy', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'are_you_currently_based_in_the_uk_ireland_sweden_the_netherlands', name: 'question_32541700003', type: 'select', label: 'Are you currently based in the UK, Ireland, Sweden, the Netherlands or Estonia?', value: 'No', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'country', name: 'question_32541701003', type: 'select', label: 'Will you now or in the future require visa sponsorship for the country you are applying?', value: 'Yes', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'have_you_used_ai_tools_e_g_gpt_gemini_etc_to_generate_product_in', name: 'question_32541702003', type: 'select', label: 'Have you used AI tools (e.g. GPT, Gemini, etc.) to generate product insights or automate analytics workflows in a production or business context?', value: 'Yes', source: 'ai', resolvedByTier: 5, confidence: 0.95 },
  { fieldId: 'do_you_have_hands_on_experience_writing_advanced_sql_and_working', name: 'question_32541703003', type: 'select', label: 'Do you have hands-on experience writing advanced SQL and working with event-based product analytics tools (e.g. Mixpanel, Amplitude, Segment)?', value: 'Yes', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'describe_a_product_decision_you_influenced_using_data_what_was_t', name: 'question_32541704003', type: 'text', label: 'Describe a product decision you influenced using data. What was the problem, how did you approach the analysis, and what was the business impact? (Max 200ΓÇô250 words)', value: 'Identified critical conversion drop-offs along user sign-up funnels via SQL event logs. Formulated revised UX milestones leading to an 18% improvement in trial-to-paid conversions.', source: 'ai', resolvedByTier: 5, confidence: 0.92 },
  { fieldId: 'walk_me_through_the_exact_ci_cd_pipeline_you_personally_built_or', name: 'question_32541705003', type: 'textarea', label: 'Walk me through the exact CI/CD pipeline you personally built or maintained for a dbt data project. What happens from the moment you commit a feature branch in Git to when that model hits production?', value: 'Feature branches trigger GitHub Actions with SQLFluff linting and staging dbt build. Merges to main trigger automated deployment running dbt test and dbt run in production warehouse with status alerts.', source: 'ai', resolvedByTier: 5, confidence: 0.94 },
  { fieldId: 'at_a_high_level_what_kind_of_compensation_range_are_you_targetin', name: 'question_32541706003', type: 'text', label: 'At a high level, what kind of compensation range are you targeting for your next move?', value: '$90,000 - $110,000', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
  { fieldId: 'voluntary_disclosure_of_gender', name: 'question_32541707003', type: 'select', label: 'Voluntary Disclosure of Gender', value: 'Female', source: 'supabase', resolvedByTier: 1, confidence: 1.0 },
];

export const akshithaApplications: CandidateJobApplication[] = [
  {
    applywizzId: AKSHITHA_APPLYWIZZ_ID,
    candidateName: 'AKSHITHA G',
    jobUrl: 'https://grnh.se/zqe6mzwz3us',
    companyName: 'DoiT',
    jobTitle: 'Product Analyst',
    status: 'READY_FOR_REVIEW',
    resolvedFields: doitResolvedFields,
  },
];

export const akshithaTemplates: ScannedJobTemplate[] = akshithaApplications.map((app) => ({
  jobUrl: app.jobUrl,
  companyName: app.companyName,
  jobTitle: app.jobTitle,
  fields: app.resolvedFields.map((f) => ({
    fieldId: f.fieldId,
    name: f.name,
    type: f.type as ScannedField['type'],
    label: f.label,
    isRequired: true,
  })),
  scannedAt: new Date().toISOString(),
  isExpired: false,
}));

