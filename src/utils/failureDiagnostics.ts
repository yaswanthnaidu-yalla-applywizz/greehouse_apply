import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { persistFailureDiagnostic } from '../db/failureDiagnostics.js';
import {
  FAILURE_DIAGNOSTIC_CATEGORIES,
  type FailureDiagnosticCategory,
  type FailureDiagnosticInput,
  type FailureDiagnosticPhase,
  type FailureDiagnosticRow,
} from '../types/failureDiagnostics.js';

export { FAILURE_DIAGNOSTIC_CATEGORIES };

const CATEGORY_PHASE: Record<FailureDiagnosticCategory, FailureDiagnosticPhase> = {
  SCAN_PLAYWRIGHT_LAUNCH: 'SCAN',
  SCAN_PLAYWRIGHT_TIMEOUT: 'SCAN',
  SCAN_PLAYWRIGHT_NAVIGATE: 'SCAN',
  SCAN_FIELD_EXTRACTION: 'SCAN',
  SCAN_CSV_PARSE: 'SCAN',
  SCAN_TEMPLATE_PERSIST: 'SCAN',
  SYNC_APPLYWIZZ_FETCH: 'SYNC',
  SYNC_PROFILE_PERSIST: 'SYNC',
  SYNC_PROFILE_LOOKUP: 'SYNC',
  SYNC_RESUME_DOWNLOAD: 'SYNC',
  SYNC_RESUME_UPLOAD: 'SYNC',
  SYNC_ZOHO_CHECK: 'SYNC',
  RESOLVE_TIER2_PARSE: 'RESOLVE',
  RESOLVE_TIER2_PROFILE_LOOKUP: 'RESOLVE',
  RESOLVE_TIER3_EMBEDDING: 'RESOLVE',
  RESOLVE_TIER3_VECTOR_SEARCH: 'RESOLVE',
  RESOLVE_TIER5_PROVIDER_FAILURE: 'RESOLVE',
  RESOLVE_TIER5_PARSE: 'RESOLVE',
  RESOLVE_CANDIDATE_JOB_FAILURE: 'RESOLVE',
  RESOLVE_APPLICATION_PERSIST: 'RESOLVE',
  RESOLVE_REQUIRED_FIELDS_UNRESOLVED: 'RESOLVE',
  SUBMIT_RESUME_MISSING: 'SUBMIT',
  SUBMIT_FORM_FILL_ERROR: 'SUBMIT',
  SUBMIT_REQUIRED_FIELD_EMPTY: 'SUBMIT',
  SUBMIT_OTP_TIMEOUT: 'SUBMIT',
  SUBMIT_OTP_FETCH: 'SUBMIT',
  SUBMIT_CONFIRMATION_TIMEOUT: 'SUBMIT',
  SUBMIT_PROOF_CAPTURE: 'SUBMIT',
  SUBMIT_STATUS_PERSIST: 'SUBMIT',
  SUBMIT_PLAYWRIGHT_LAUNCH: 'SUBMIT',
  SUBMIT_PLAYWRIGHT_NAVIGATE: 'SUBMIT',
  SUBMIT_PLAYWRIGHT_TIMEOUT: 'SUBMIT',
  SUBMIT_OTP_SUBMISSION: 'SUBMIT',
  SUBMIT_APPLICATION_LOAD: 'SUBMIT',
  SUBMIT_JOB_URL_MISSING: 'SUBMIT',
};

const SAFE_METADATA_KEYS = new Set([
  'httpStatus',
  'providerCode',
  'fieldCount',
  'tier',
  'elapsedMs',
  'retryCount',
  'attempt',
  'timeoutMs',
  'responseBytes',
  'contentChars',
  'matchCount',
  'transition',
  'reasonCode',
  'retryable',
  'terminal',
  'fieldFingerprint',
  'fieldType',
  'fieldLabel',
]);

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const bearerPattern = /\bBearer\s+\S+/gi;
const secretPattern = /\b(?:sk-[A-Z0-9_-]{8,}|eyJ[A-Z0-9_-]{20,}|sb_(?:secret|publishable)_[A-Z0-9_-]{8,})\b/gi;
const urlPattern = /\bhttps?:\/\/[^\s"'<>]+/gi;
const phonePattern = /(?<!\w)\+?[\d ().-]{8,}\d(?!\w)/g;
const otpValuePattern = /\b((?:otp|one[-\s]?time(?: password)?|verification|security)\s*(?:code|token)?\s*(?:is|:|=)\s*)[A-Z0-9]{4,12}\b/gi;
const quotedValuePattern = /\b(?:answer|value|token|code)\s*[:=]\s*(['"])[\s\S]*?\1/gi;

function sanitizeText(value: string, maxLength: number): string {
  const sanitized = value
    .replace(emailPattern, '[REDACTED_EMAIL]')
    .replace(bearerPattern, 'Bearer [REDACTED]')
    .replace(secretPattern, '[REDACTED_SECRET]')
    .replace(urlPattern, (match) => sanitizeJobUrlRef(match) || '[REDACTED_URL]')
    .replace(phonePattern, (match) => {
      const digitCount = (match.match(/\d/g) || []).length;
      return digitCount >= 10 ? '[REDACTED_PHONE]' : match;
    })
    .replace(otpValuePattern, '$1[REDACTED]')
    .replace(quotedValuePattern, '[REDACTED_VALUE]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return sanitized.slice(0, maxLength);
}

export function sanitizeJobUrlRef(value?: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return `${parsed.host}${parsed.pathname}`.slice(0, 300);
  } catch {
    return null;
  }
}

function errorRecord(error: unknown): Record<string, unknown> | null {
  return error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
}

function cleanErrorName(error: unknown): string | null {
  const record = errorRecord(error);
  const name = error instanceof Error ? error.name : record?.name;
  return typeof name === 'string' ? sanitizeText(name, 80) || null : null;
}

function cleanErrorCode(error: unknown, explicit?: string | number | null): string | null {
  const record = errorRecord(error);
  const status = record?.status ?? (record?.response as { status?: unknown })?.status;
  const code = explicit ?? record?.code ?? status;
  if (typeof code !== 'string' && typeof code !== 'number') return null;
  return sanitizeText(String(code), 100) || null;
}

function safeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!metadata) return result;

  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'string') result[key] = sanitizeText(value, key === 'fieldLabel' ? 180 : 120);
  }
  if (metadata.fieldLabel && typeof metadata.fieldLabel === 'string') {
    result.fieldLabel = sanitizeText(metadata.fieldLabel, 180);
  }

  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1900) {
    const removable = Object.keys(result).pop();
    if (!removable) break;
    delete result[removable];
  }
  return result;
}

const diagnosticRun = new AsyncLocalStorage<string>();
const log = createLogger('Failure Diagnostic');

export function currentDiagnosticRunId(): string | null {
  return diagnosticRun.getStore() || null;
}

export function withDiagnosticRun<T>(runId: string | null | undefined, work: () => T): T {
  const id = runId || currentDiagnosticRunId() || randomUUID();
  return diagnosticRun.run(id, work);
}

export function buildFailureDiagnostic(
  input: FailureDiagnosticInput,
  contextualRunId: string | null = currentDiagnosticRunId()
): FailureDiagnosticRow {
  const candidateId = input.applywizzId?.trim();
  const appId = input.applicationId?.trim();
  const explicitRunId = input.runId?.trim();
  const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const applywizzPattern = /^AWL-[A-Z0-9-]{2,40}$/i;

  return {
    phase: CATEGORY_PHASE[input.category],
    stage: (input.stage ? sanitizeText(input.stage, 80) : '') || input.category,
    category: input.category,
    reason: sanitizeText(input.reason, 500) || input.category,
    error_name: cleanErrorName(input.error),
    error_code: cleanErrorCode(input.error, input.errorCode),
    is_terminal: input.isTerminal,
    is_retryable: input.isRetryable,
    applywizz_id: candidateId && applywizzPattern.test(candidateId) ? candidateId.toUpperCase() : null,
    application_id: appId && idPattern.test(appId) ? appId : null,
    run_id:
      explicitRunId && idPattern.test(explicitRunId)
        ? explicitRunId
        : contextualRunId && idPattern.test(contextualRunId)
          ? contextualRunId
          : null,
    job_url_ref: sanitizeJobUrlRef(input.jobUrl),
    metadata: safeMetadata(input.metadata),
  };
}

export async function emitFailureDiagnostic(input: FailureDiagnosticInput): Promise<void> {
  const record = buildFailureDiagnostic(input);
  const stdoutRecord = {
    phase: record.phase,
    stage: record.stage,
    category: record.category,
    reason: record.reason,
    error_name: record.error_name,
    error_code: record.error_code,
    is_terminal: record.is_terminal,
    is_retryable: record.is_retryable,
    application_id: record.application_id,
    run_id: record.run_id,
    job_url_ref: record.job_url_ref,
    metadata: record.metadata,
  };
  log.error(JSON.stringify(stdoutRecord));

  try {
    await persistFailureDiagnostic(record);
  } catch (error) {
    log.error(
      JSON.stringify({
        phase: record.phase,
        stage: 'diagnostic_persistence',
        category: record.category,
        reason: 'Failure diagnostic could not be persisted.',
        error_name: cleanErrorName(error),
        error_code: cleanErrorCode(error),
        is_terminal: false,
        is_retryable: true,
        application_id: record.application_id,
        run_id: record.run_id,
      })
    );
  }
}
