export const APPLICATION_SUMMARY_COLUMNS = [
  'id',
  'applywizz_id',
  'job_url',
  'company_name',
  'job_title',
  'location',
  'status',
  'match_score',
  'failure_reason',
  'retry_count',
  'last_error',
  'proof_url',
  'proof_failed_url',
  'assigned_ca_email',
  'created_at',
  'updated_at',
  'task_id',
] as const;

export type ApplicationSummaryColumn = typeof APPLICATION_SUMMARY_COLUMNS[number];

export interface ApplicationSummaryDto {
  id: string;
  applywizz_id: string;
  job_url: string;
  company_name?: string;
  job_title?: string;
  location?: string;
  status: string;
  match_score?: number;
  failure_reason?: string;
  retry_count?: number;
  last_error?: string;
  proof_url?: string;
  proof_failed_url?: string;
  assigned_ca_email?: string;
  created_at: string;
  updated_at: string;
  task_id?: string;
}

export interface ApplicationDetailDto extends ApplicationSummaryDto {
  resolved_fields?: Record<string, any>;
  user_inputs?: Record<string, any>;
  [key: string]: any;
}
