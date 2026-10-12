export const FAILURE_DIAGNOSTIC_CATEGORIES = [
  'SCAN_PLAYWRIGHT_LAUNCH',
  'SCAN_PLAYWRIGHT_TIMEOUT',
  'SCAN_PLAYWRIGHT_NAVIGATE',
  'SCAN_FIELD_EXTRACTION',
  'SCAN_CSV_PARSE',
  'SCAN_TEMPLATE_PERSIST',
  'SYNC_APPLYWIZZ_FETCH',
  'SYNC_PROFILE_PERSIST',
  'SYNC_PROFILE_LOOKUP',
  'SYNC_RESUME_DOWNLOAD',
  'SYNC_RESUME_UPLOAD',
  'SYNC_ZOHO_CHECK',
  'RESOLVE_TIER2_PARSE',
  'RESOLVE_TIER2_PROFILE_LOOKUP',
  'RESOLVE_TIER3_EMBEDDING',
  'RESOLVE_TIER3_VECTOR_SEARCH',
  'RESOLVE_TIER5_PROVIDER_FAILURE',
  'RESOLVE_TIER5_PARSE',
  'RESOLVE_CANDIDATE_JOB_FAILURE',
  'RESOLVE_APPLICATION_PERSIST',
  'RESOLVE_REQUIRED_FIELDS_UNRESOLVED',
  'SUBMIT_RESUME_MISSING',
  'SUBMIT_FORM_FILL_ERROR',
  'SUBMIT_REQUIRED_FIELD_EMPTY',
  'SUBMIT_OTP_TIMEOUT',
  'SUBMIT_OTP_FETCH',
  'SUBMIT_CONFIRMATION_TIMEOUT',
  'SUBMIT_PROOF_CAPTURE',
  'SUBMIT_STATUS_PERSIST',
  'SUBMIT_PLAYWRIGHT_LAUNCH',
  'SUBMIT_PLAYWRIGHT_NAVIGATE',
  'SUBMIT_PLAYWRIGHT_TIMEOUT',
  'SUBMIT_OTP_SUBMISSION',
  'SUBMIT_APPLICATION_LOAD',
  'SUBMIT_JOB_URL_MISSING',
] as const;

export type FailureDiagnosticCategory = (typeof FAILURE_DIAGNOSTIC_CATEGORIES)[number];
export type FailureDiagnosticPhase = 'SCAN' | 'SYNC' | 'RESOLVE' | 'SUBMIT';

export interface FailureDiagnosticRow {
  id?: string;
  phase: FailureDiagnosticPhase;
  stage: string;
  category: FailureDiagnosticCategory;
  reason: string;
  error_name?: string | null;
  error_code?: string | null;
  is_terminal: boolean;
  is_retryable: boolean;
  applywizz_id?: string | null;
  application_id?: string | null;
  run_id?: string | null;
  job_url_ref?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface FailureDiagnosticInput {
  stage?: string;
  category: FailureDiagnosticCategory;
  reason: string;
  error?: unknown;
  errorCode?: string | number | null;
  isTerminal: boolean;
  isRetryable: boolean;
  applywizzId?: string | null;
  applicationId?: string | null;
  runId?: string | null;
  jobUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface FailureDiagnosticsFilter {
  limit: number;
  offset: number;
  phase?: FailureDiagnosticPhase;
  category?: FailureDiagnosticCategory;
  applywizzId?: string;
  applicationId?: string;
  runId?: string;
}
