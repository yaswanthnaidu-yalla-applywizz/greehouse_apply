import { isSupabaseConfigured, getDbClient } from '../src/db/client.js';

export type ChoiceMetadataAuditInput = {
  label: string;
  options?: string[] | null;
  templateOptions?: string[] | null;
};

export type ChoiceMetadataAuditResult =
  | 'valid'
  | 'invalid-binary'
  | 'replace-from-template';

function isYesNo(options?: string[] | null): boolean {
  if (!Array.isArray(options) || options.length !== 2) return false;
  const normalized = options.map((option) => option.trim().toLowerCase());
  return normalized.includes('yes') && normalized.includes('no');
}

function isClearlyNonBinaryFactQuestion(label: string): boolean {
  return /\bwhat\s+(city|location|country|state|address|postal|zip)\b|how did you hear|what is your (religion|belief)|ethnic|school|university|degree|major|salary|job title|department|years? of experience/i.test(
    label
  );
}

function isBinaryQuestion(label: string): boolean {
  return /^(are|is|do|does|did|will|would|can|could|have|has|had)\b|relocat|authorized to work|sponsorship|require.*visa|located in|in-person|on-site|onsite|acknowledge|agree|certif|consent/i.test(
    label.trim()
  );
}

export function classifyChoiceMetadata(input: ChoiceMetadataAuditInput): ChoiceMetadataAuditResult {
  if (!isYesNo(input.options)) return 'valid';
  if (!isClearlyNonBinaryFactQuestion(input.label) || isBinaryQuestion(input.label)) return 'valid';
  if (Array.isArray(input.templateOptions) && input.templateOptions.length > 0 && !isYesNo(input.templateOptions)) {
    return 'replace-from-template';
  }
  return 'invalid-binary';
}

type ApplicationRow = {
  id: string;
  applywizz_id: string;
  job_url: string;
  status: string;
  resolved_fields: unknown;
};

type TemplateRow = {
  job_url: string;
  fields_schema: unknown;
};

export async function auditChoiceMetadata(): Promise<Array<Record<string, unknown>>> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const { data: applications, error: applicationError } = await getDbClient()
    .from('gh_candidate_applications')
    .select('id, applywizz_id, job_url, status, resolved_fields');
  if (applicationError) throw applicationError;

  const rows = (applications || []) as ApplicationRow[];
  const jobUrls = [...new Set(rows.map((row) => row.job_url).filter(Boolean))];
  const templates: TemplateRow[] = [];
  for (let offset = 0; offset < jobUrls.length; offset += 100) {
    const chunk = jobUrls.slice(offset, offset + 100);
    const { data, error } = await getDbClient()
      .from('gh_scanned_job_templates')
      .select('job_url, fields_schema')
      .in('job_url', chunk);
    if (error) throw error;
    templates.push(...((data || []) as TemplateRow[]));
  }

  const templatesByUrl = new Map(templates.map((template) => [template.job_url, template]));
  const results: Array<Record<string, unknown>> = [];

  for (const application of rows) {
    const template = templatesByUrl.get(application.job_url);
    const templateFields = Array.isArray(template?.fields_schema) ? template.fields_schema : [];
    const templateById = new Map(
      templateFields
        .filter((field): field is Record<string, unknown> => Boolean(field && typeof field === 'object'))
        .map((field) => [String(field.fieldId || field.name || ''), field])
    );
    const fields = Array.isArray(application.resolved_fields) ? application.resolved_fields : [];

    for (const field of fields) {
      if (!field || typeof field !== 'object') continue;
      const current = field as Record<string, unknown>;
      const fieldKey = String(current.fieldId || current.name || '');
      const scanned = templateById.get(fieldKey);
      const classification = classifyChoiceMetadata({
        label: String(current.label || ''),
        options: Array.isArray(current.options) ? current.options.map(String) : null,
        templateOptions: Array.isArray(scanned?.options) ? scanned.options.map(String) : null,
      });
      if (classification === 'valid') continue;
      results.push({
        classification,
        applicationId: application.id,
        applywizzId: application.applywizz_id,
        jobUrl: application.job_url,
        status: application.status,
        fieldId: fieldKey,
        label: current.label || null,
        options: current.options || null,
        templateOptions: scanned?.options || null,
        value: current.value || null,
        source: current.source || null,
      });
    }
  }

  return results;
}

async function main(): Promise<void> {
  const results = await auditChoiceMetadata();
  console.log(JSON.stringify({ readOnly: true, count: results.length, results }, null, 2));
}

if (process.argv[1]?.endsWith('auditChoiceMetadata.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
