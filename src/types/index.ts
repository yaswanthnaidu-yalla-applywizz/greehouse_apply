/**
 * @fileoverview Core TypeScript domain definitions and data contracts for the Greenhouse
 * Job Application Automation System (V1).
 *
 * References:
 * - 02-trd.md (Technical Requirements Document)
 * - 05-backend-schema.md (Backend Schema & Data Specifications)
 * - 06-implementation.md (Implementation Plan)
 */

// ============================================================================
// Branch 1: Playwright Unique Link DOM Scanned Field & Template Schemas
// ============================================================================

/**
 * Permitted input control types detected on Greenhouse application forms.
 */
export type ScannedFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'location_autocomplete';

/**
 * Additional DOM context metadata captured during form scraping.
 */
export interface ScannedFieldMetadata {
  /** CSS selector used by Playwright to locate the element */
  selector?: string;
  /** Grouping section name (e.g., 'Personal Information', 'Demographics') */
  section?: string;
}

/**
 * Represents a single scanned form question/field extracted from the Greenhouse DOM.
 */
export interface ScannedField {
  /** Unique normalized identifier for the field */
  fieldId: string;
  /** HTML input name attribute (e.g., 'first_name', 'job_application[answers][123]') */
  name: string;
  /** Form control type */
  type: ScannedFieldType;
  /** Human-readable label displayed on the form (with trailing asterisks stripped) */
  label: string;
  /** Whether the field is mandatory for submission */
  isRequired: boolean;
  /** Extracted option labels/values for dropdown (select) and radio button groups */
  options?: string[];
  /** Optional metadata containing selector and section hierarchy */
  metadata?: ScannedFieldMetadata;
}

/**
 * Represents the complete form schema extracted for a unique Greenhouse job posting URL.
 */
export interface ScannedJobTemplate {
  /** Canonical job posting URL */
  jobUrl: string;
  /** Extracted company name */
  companyName: string;
  /** Extracted job title */
  jobTitle: string;
  /** Array of all scanned form fields */
  fields: ScannedField[];
  /** ISO timestamp when the job posting was scanned */
  scannedAt: string;
  /** Flag indicating if the job posting has closed or returns a 404 */
  isExpired: boolean;
}

// ============================================================================
// Branch 2: ApplyWizz Candidate Profile Schemas
// ============================================================================

/**
 * Academic credential record within candidate profile.
 */
export interface CandidateEducation {
  /** Name of the university or academic institution */
  institution: string;
  /** Degree attained or pursued (e.g., "Bachelor of Science", "Master of Science") */
  degree: string;
  /** Academic major or field of study (e.g., "Computer Science") */
  fieldOfStudy: string;
  /** Graduation year (e.g., "2024") */
  graduationYear: string;
}

/**
 * Professional work experience record within candidate profile.
 */
export interface CandidateWorkExperience {
  /** Company or employer organization name */
  company: string;
  /** Job title / position held */
  title: string;
  /** Start date string (e.g., "01/2022") */
  startDate: string;
  /** End date string or "Present" */
  endDate: string;
  /** Detailed summary of accomplishments and duties */
  description: string;
}

/**
 * Demographic and survey preferences from ApplyWizz additional information.
 */
export interface CandidateDemographics {
  gender?: string;
  isHispanicLatino?: string;
  raceEthnicity?: string;
  veteranStatus?: string;
  disabilityStatus?: string;
  willingToRelocate?: boolean;
  canWorkInOffice?: boolean;
  salaryRange?: string;
  yearsOfExperience?: string;
  currentRole?: string;
}

/**
 * Rich candidate profile retrieved from the ApplyWizz Client API.
 */
export interface ApplyWizzProfile {
  /** Unique candidate identifier (e.g., "AWL-36144") */
  applywizzId: string;
  /** Full name of the candidate */
  clientName: string;
  /** Candidate first name */
  firstName: string;
  /** Candidate last name */
  lastName: string;
  /** Primary contact email address */
  email: string;
  /** Primary contact phone number */
  phone: string;
  /** Primary residential location (City, State / Country) */
  location: string;
  /** Candidate LinkedIn profile URL */
  linkedinUrl: string;
  /** Optional portfolio / personal website URL */
  websiteUrl?: string;
  /** Optional GitHub profile URL */
  githubUrl?: string;
  /** Work authorization status (e.g., "US Citizen", "Green Card", "H1B", "F1 OPT") */
  workAuthorization: string;
  /** Whether the candidate requires employer visa sponsorship */
  requiresSponsorship: boolean;
  /** Chronological academic history */
  education: CandidateEducation[];
  /** Chronological professional employment history */
  workExperience: CandidateWorkExperience[];
  /** Remote URL to download master PDF resume */
  resumeUrl: string;
  /** Local filesystem path where the downloaded PDF resume is stored */
  localResumePath: string;
  /** Optional demographic and survey metadata */
  demographics?: CandidateDemographics;
}

/**
 * Type alias for ApplyWizzProfile providing explicit candidate terminology.
 */
export type ApplyWizzCandidateProfile = ApplyWizzProfile;

/**
 * Represents a single job assignment mapped to a candidate in the CSV.
 */
export interface CandidateJobRecord {
  /** Original raw job URL from CSV */
  rawUrl: string;
  /** Canonical normalized Greenhouse URL */
  canonicalUrl: string;
  /** Batch date string */
  date: string;
  /** Internal job match score */
  score: string | number;
  /** Internal scored job reference ID */
  scoredJobId: string;
  /** Status in CSV (e.g., 'PENDING') */
  status: string;
}

/**
 * Segregated candidate record linking candidate profile with all assigned jobs.
 */
export interface CandidateSegment {
  /** Unique candidate identifier */
  applywizzId: string;
  /** Candidate full name */
  clientName: string;
  /** Candidate profile details synced from ApplyWizz API or local cache */
  profile?: ApplyWizzCandidateProfile;
  /** List of job postings assigned to this candidate */
  jobs: CandidateJobRecord[];
  /** Total number of assigned jobs */
  totalJobs: number;
  /** ISO timestamp when the candidate segment was processed */
  syncedAt: string;
}

// ============================================================================
// Multi-Tier Answer Resolution & Queue Schemas
// ============================================================================

/**
 * Strict source attribution tag indicating how an answer was resolved:
 * - 'supabase': Resolved via direct or fuzzy match against the candidate profile / local DB.
 * - 'ai': Synthesized using LLM (Google Gemini / OpenAI) with resume and job description context.
 */
export type AnswerSource = 'supabase' | 'ai';

/**
 * Represents a resolved form answer for a specific candidate and job field.
 */
export interface ResolvedField {
  /** Unique field identifier corresponding to ScannedField.fieldId */
  fieldId: string;
  /** Form input name corresponding to ScannedField.name */
  name: string;
  /** Form input type corresponding to ScannedField.type */
  type: string;
  /** Human-readable field label */
  label: string;
  /** The populated answer value (or selected option) */
  value: string;
  /** Strict source attribution */
  source: AnswerSource;
  /** Confidence score between 0.0 and 1.0 */
  confidence: number;
}

/**
 * Application processing status in the review queue.
 */
export type ApplicationStatus = 'READY_FOR_REVIEW' | 'EXPIRED' | 'PENDING';

/**
 * Segregated candidate job queue item rendered in the operator dashboard.
 */
export interface CandidateJobQueueItem {
  /** Unique candidate identifier */
  applywizzId: string;
  /** Candidate full name */
  clientName: string;
  /** Greenhouse job posting URL */
  jobUrl: string;
  /** Company name */
  companyName: string;
  /** Job title */
  jobTitle: string;
  /** Queue state */
  status: ApplicationStatus;
  /** Form fields with resolved answers and source tags */
  formFields: ResolvedField[];
}

/**
 * Application record representation pairing candidate and resolved form questions.
 */
export interface CandidateJobApplication {
  /** Unique candidate identifier */
  applywizzId: string;
  /** Candidate full name */
  candidateName: string;
  /** Greenhouse job posting URL */
  jobUrl: string;
  /** Company name */
  companyName: string;
  /** Job title */
  jobTitle: string;
  /** Application state */
  status: ApplicationStatus;
  /** List of resolved fields */
  resolvedFields: ResolvedField[];
}

// ============================================================================
// Input Ingestion CSV Row Schema
// ============================================================================

/**
 * Raw row structure from `greenhouse_only_applywizz_prod(in).csv`.
 */
export interface InputJobRow {
  /** Batch ingestion date string */
  Date: string;
  /** Unique candidate identifier */
  'Applywizz ID': string;
  /** Candidate full name */
  'Client Name': string;
  /** Target Greenhouse job posting URL */
  url: string;
  /** Internal job match score */
  score: string | number;
  /** Scored job reference identifier */
  scored_jobId: string;
  /** Processing status flag */
  status: string;
}
