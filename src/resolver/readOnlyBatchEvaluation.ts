import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { segregateCandidatesByApplyWizzId } from '../candidate/segregator.js';
import { readAndDeduplicateUrls } from '../scanner/csvDeduplicator.js';
import { alignAndFilterCandidateSegmentJobs } from '../orchestrator/pipeline.js';
import { AnswerResolver, isAttachmentObligation, mergeTier5ResolvedField } from './answerResolver.js';
import type {
  ResolutionExecution,
  ScannedJobTemplate,
  SemanticSearchAdapters,
} from '../types/index.js';
import { profileRowToCandidateProfile, type ProfileRow } from '../db/profiles.js';
import type { QABankRow } from '../db/qaBank.js';
import type { ResumeParsedRow } from './tier2ResumeParse.js';
import { Pool, type PoolClient } from 'pg';
import { isCandidateEligibleForZohoGate } from '../db/zohoConnected.js';
import config from '../config/env.js';
import { PlaywrightScanner } from '../scanner/playwrightScanner.js';
import { scanAshbyJob } from '../scanner/ashbyScanner.js';
import { atsFromUrl } from '../scanner/csvDeduplicator.js';
import { createIngestTier5Stages, type Tier5UsageRecord } from './tier5LLM.js';
import { JsonBatchRunStateStore } from './anthropicMessageBatch.js';
import { generateFingerprint } from './fingerprint.js';
import { classifyTier5Question, LLMSynthesizer } from './llmSynthesizer.js';
import { buildQuestionRelevantEvidence } from './candidateEvidence.js';
import { IngestTier5BatchPendingError, resolveIngestTier5, type IngestTier5StageDecision, type IngestTier5Stages, type IngestTier5Work } from './ingestTier5Coordinator.js';
import { applicationNeedsOperatorReview, applicationShouldBeFilteredOut } from './needsReview.js';
import { hasAnyNonEmptyResolvedField } from '../utils/resolvedFields.js';
import { hasSecurityClearanceQuestion } from '../scanner/securityClearance.js';
import { getApplicationExclusionReasons } from './applicationExclusions.js';
import { ensurePrivateArtifactDirectory } from '../utils/privateArtifactDirectory.js';

export interface ReadOnlyEvaluationApplicationSnapshot {
  applywizz_id: string;
  job_url: string;
  task_id?: string | null;
  status?: string | null;
  created_at?: string | null;
  resolved_fields?: Array<{ label?: string; type?: string; value?: string; source?: string; fieldId?: string; field_id?: string; slotIndex?: number; index?: number }> | null;
}

export type ReadOnlyFunnelDisposition =
  | 'created_auto_queue_eligible'
  | 'created_review'
  | 'created_filtered'
  | 'existing_task_updated'
  | 'existing_pair_updated'
  | 'expired'
  | 'missing_output'
  | 'excluded'
  | 'unknown_creation';

export interface ReadOnlyFunnelAssignment {
  applywizzId: string;
  jobUrl: string;
  taskId: string | null;
  assignmentOrdinal: number;
  output: 'resolved' | 'expired' | 'missing' | 'excluded';
  hasResolvedFields: boolean;
  filtered: boolean;
  needsReview: boolean;
}

/** Mirrors production's task_id lookup, falling back to candidate/job only when task_id is absent. */
export function reconcileReadOnlyFunnel(
  assignments: ReadOnlyFunnelAssignment[],
  existingApplications: ReadOnlyEvaluationApplicationSnapshot[] | undefined,
  taskIdsGloballyCovered = false,
): { dispositions: Array<ReadOnlyFunnelAssignment & { disposition: ReadOnlyFunnelDisposition }>; counts: Record<ReadOnlyFunnelDisposition, number>; createdDenominator: number; actualQueued: null } {
  const counts: Record<ReadOnlyFunnelDisposition, number> = {
    created_auto_queue_eligible: 0, created_review: 0, created_filtered: 0,
    existing_task_updated: 0, existing_pair_updated: 0, expired: 0,
    missing_output: 0, excluded: 0, unknown_creation: 0,
  };
  const taskIdCounts = new Map<string, number>();
  for (const assignment of assignments) {
    if (assignment.taskId) taskIdCounts.set(assignment.taskId, (taskIdCounts.get(assignment.taskId) || 0) + 1);
  }
  const dispositions = assignments.map((assignment) => {
    const pairRows = existingApplications?.filter((row) =>
      row.applywizz_id.trim().toUpperCase() === assignment.applywizzId.trim().toUpperCase() && row.job_url === assignment.jobUrl,
    ) || [];
    const taskRows = assignment.taskId ? existingApplications?.filter((row) => row.task_id === assignment.taskId) || [] : [];
    const rows = assignment.taskId
      ? taskRows
      : pairRows.filter((row) => row.task_id == null);
    const taskIdentityConflicts = Boolean(assignment.taskId && taskRows.some((row) =>
      row.applywizz_id.trim().toUpperCase() !== assignment.applywizzId.trim().toUpperCase() || row.job_url !== assignment.jobUrl,
    ));
    let disposition: ReadOnlyFunnelDisposition;
    if (assignment.output === 'expired') disposition = 'expired';
    else if (assignment.output === 'excluded') disposition = 'excluded';
    else if (assignment.output === 'missing' || !assignment.hasResolvedFields) disposition = 'missing_output';
    else if (assignment.taskId && taskIdCounts.get(assignment.taskId)! > 1) disposition = 'unknown_creation';
    else if (taskIdentityConflicts || rows.length > 1) disposition = 'unknown_creation';
    else if (rows.length === 1) disposition = assignment.taskId ? 'existing_task_updated' : 'existing_pair_updated';
    else if (!assignment.taskId && pairRows.length) disposition = 'unknown_creation';
    else if (assignment.taskId && !taskIdsGloballyCovered) disposition = 'unknown_creation';
    else if (existingApplications === undefined) disposition = 'unknown_creation';
    else if (assignment.filtered) disposition = 'created_filtered';
    else if (assignment.needsReview) disposition = 'created_review';
    else disposition = 'created_auto_queue_eligible';
    counts[disposition]++;
    return { ...assignment, disposition };
  });
  return {
    dispositions,
    counts,
    createdDenominator: counts.created_auto_queue_eligible + counts.created_review + counts.created_filtered,
    actualQueued: null,
  };
}

export interface ReadOnlyCandidateEvidence {
  profile: ProfileRow | null;
  parsedResume: ResumeParsedRow | null;
  qaEntries: QABankRow[];
}

/** Rehydrates the exact parsed-resume cache shape consumed by Tier 2 without parsing or downloading. */
export function cachedResumeFromProfile(
  applywizzId: string,
  profile: ProfileRow | null,
): ResumeParsedRow | null {
  if (!profile?.resume_text?.trim()) return null;
  const rawText = profile.resume_text;
  return {
    applywizz_id: applywizzId,
    raw_text: rawText,
    structured: profile.resume_facts || { skills: [], experience: [], education: [], rawSections: {} },
    parse_failed: false,
  };
}

export interface ReadOnlyEvidenceSession {
  readCandidateEvidence(applywizzId: string): Promise<ReadOnlyCandidateEvidence>;
  readExistingApplications?(pairs: Array<{ applywizzId: string; jobUrl: string }>): Promise<ReadOnlyEvaluationApplicationSnapshot[]>;
  /** True only when task_id lookups for this evaluation's input IDs were captured globally, not just by pair. */
  taskIdsGloballyCovered?: boolean;
  readBaselineApplications?(fromUtc: string, toUtc: string): Promise<ReadOnlyEvaluationApplicationSnapshot[]>;
  semanticSearchAdapters: SemanticSearchAdapters;
  close(): Promise<void>;
}

export function isReadOnlyEvaluationCandidateEligible(
  profile: ProfileRow | null,
  requireZohoConnected: boolean,
): boolean {
  return !requireZohoConnected || isCandidateEligibleForZohoGate(profile).eligible;
}

export function isReadOnlyTier5Field(field: ScannedJobTemplate['fields'][number], original: { source: string; isRequired?: boolean } | null | undefined): boolean {
  return Boolean(original && original.source === 'unresolved' &&
    (original.isRequired || isAttachmentObligation(field) || classifyTier5Question(field) === 'creative'));
}

export function createReadOnlyTier5FieldKey(input: {
  candidateId: string;
  jobUrl: string;
  taskId: string | null;
  assignmentOrdinal: number;
  field: ScannedJobTemplate['fields'][number];
  slotIndex: number;
}): string {
  const { candidateId, jobUrl, taskId, assignmentOrdinal, field, slotIndex } = input;
  return `${candidateId.trim().toUpperCase()}|${jobUrl}|${taskId ? `task:${taskId}` : 'task:none'}|assignment:${assignmentOrdinal}|${generateFingerprint(field.label, field.type)}|${field.fieldId}|${slotIndex}`;
}

function attachTier5AnswerAudit(
  applications: ReadOnlyBatchEvaluationResult['applications'],
  work: readonly IngestTier5Work[],
  decisions: readonly IngestTier5StageDecision[],
): void {
  for (const item of work) {
    const application = applications.find((row) => row.applywizzId === item.candidateId && row.jobUrl === item.jobUrl &&
      row.taskId === item.taskId && row.assignmentOrdinal === item.assignmentOrdinal);
    if (!application) continue;
    const slotIndex = item.assignmentOrdinal === undefined ? -1 : Number(item.fieldKey.split('|').at(-1));
    const record = application.answerAudit.find((entry) => entry.slotIndex === slotIndex && entry.fieldId === item.field.fieldId);
    if (record) record.stageDecisions = decisions.filter((decision) => decision.fieldKey === item.fieldKey);
  }
  for (const application of applications) {
    for (const audit of application.answerAudit) {
      const field = application.resolvedFields[audit.slotIndex];
      audit.sourceTier = field?.resolvedByTier ?? null;
      audit.answerDecision = field?.value?.trim() ? 'resolved' : 'unresolved';
    }
  }
}

export interface ReadOnlyBatchEvaluationPorts {
  ingestRunId?: string;
  // Must reject unless its backing connection or transaction has database-enforced read-only access.
  openReadOnlyEvidenceSession(): Promise<ReadOnlyEvidenceSession>;
  resolveShortlinksBatch(urls: string[], concurrency?: number): Promise<Map<string, string>>;
  scanUrls(urls: string[]): Promise<ReadOnlyScanResult>;
  createTier5Stages?(runKey: string, localStatePath: string, onUsage?: (record: Tier5UsageRecord) => void): IngestTier5Stages;
}

export interface ReadOnlyScanResult {
  templates: ScannedJobTemplate[];
  errors: Array<{ url: string; message: string }>;
}

export const READ_ONLY_SEMANTIC_RPC_PREFLIGHT_SQL = `
  SELECT to_regprocedure('public.match_candidate_qa(extensions.vector,text,double precision,integer)') IS NOT NULL AS function_exists,
         has_function_privilege(current_user, 'public.match_candidate_qa(extensions.vector,text,double precision,integer)', 'EXECUTE') AS can_execute
`;

export interface ReadOnlyBatchDatabaseOptions {
  databaseUrl?: string;
  embedTexts: SemanticSearchAdapters['embedTexts'];
  poolFactory?: (connectionString: string) => Pick<Pool, 'connect' | 'end'>;
}

/** Opens one PostgreSQL transaction and verifies read-only mode on that same session. */
export async function openPostgresReadOnlyEvidenceSession(
  options: ReadOnlyBatchDatabaseOptions,
): Promise<ReadOnlyEvidenceSession> {
  const databaseUrl = options.databaseUrl || process.env.BATCH_EVAL_READONLY_DATABASE_URL;
  if (!databaseUrl) throw new Error('BATCH_EVAL_READONLY_DATABASE_URL is required.');
  const pool = options.poolFactory
    ? options.poolFactory(databaseUrl)
    : new Pool({ connectionString: databaseUrl, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only');
    if (rows[0]?.transaction_read_only !== 'on') {
      throw new Error('Database session did not confirm transaction_read_only=on.');
    }
    const rpcAccess = await client.query<{ function_exists: boolean; can_execute: boolean }>(READ_ONLY_SEMANTIC_RPC_PREFLIGHT_SQL);
    if (!rpcAccess.rows[0]?.function_exists || !rpcAccess.rows[0]?.can_execute) {
      throw new Error('Read-only evaluation requires EXECUTE on public.match_candidate_qa(extensions.vector,text,double precision,integer); verify the function signature and role grant.');
    }
    const activeClient = client;
    return {
      async readCandidateEvidence(applywizzId) {
        const [profileResult, qaResult] = await Promise.all([
          activeClient.query('SELECT * FROM profiles WHERE applywizz_id = $1 LIMIT 1', [applywizzId]),
          activeClient.query('SELECT * FROM gh_candidate_qa_bank WHERE applywizz_id = $1', [applywizzId]),
        ]);
        return {
          profile: (profileResult.rows[0] as ProfileRow | undefined) ?? null,
          parsedResume: cachedResumeFromProfile(
            applywizzId,
            (profileResult.rows[0] as ProfileRow | undefined) ?? null,
          ),
          qaEntries: qaResult.rows as QABankRow[],
        };
      },
      semanticSearchAdapters: {
        embedTexts: options.embedTexts,
        async matchCandidateQa(args) {
          const vector = `[${args.queryVector.join(',')}]`;
          const result = await activeClient.query(
            'SELECT question_label, value, similarity FROM public.match_candidate_qa($1::extensions.vector, $2, $3, $4)',
            [vector, args.matchApplywizzId, args.matchThreshold, args.matchCount],
          );
          return { data: result.rows };
        },
      },
      async close() {
        try { await activeClient.query('ROLLBACK'); } finally {
          activeClient.release();
          await pool.end();
        }
      },
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* connection may already be closed */ }
      client.release();
    }
    await pool.end();
    throw error;
  }
}

/** Reuses the production ATS scanners while replacing their database diagnostic sink. */
export function createReadOnlyProductionScannerAdapter(): ReadOnlyBatchEvaluationPorts['scanUrls'] {
  return async (urls) => {
    const errors: Array<{ url: string; message: string }> = [];
    const scanner = new PlaywrightScanner({
      onFailureDiagnostic: async (input) => {
        errors.push({ url: String(input.jobUrl || ''), message: input.reason });
      },
      onFatal: (_module, message, error) => {
        throw new Error(error ? `${message}: ${String(error)}` : message);
      },
    });
    const greenhouseUrls = urls.filter((url) => atsFromUrl(url) !== 'ashby');
    const ashbyUrls = urls.filter((url) => atsFromUrl(url) === 'ashby');
    const greenhouseTemplates = greenhouseUrls.length > 0
      ? await scanner.scanUniqueUrls(greenhouseUrls)
      : [];
    const ashbyTemplates: ScannedJobTemplate[] = [];
    for (const url of ashbyUrls) {
      try {
        ashbyTemplates.push(await scanAshbyJob(url));
      } catch (error) {
        errors.push({ url, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { templates: [...greenhouseTemplates, ...ashbyTemplates], errors };
  };
}

export interface ReadOnlyBatchEvaluationResult {
  status: 'complete' | 'pending';
  pendingBatch?: { stage: 'haiku' | 'sonnet'; batchIds: readonly string[] };
  tier5Usage?: Tier5UsageSummary;
  uniqueUrls: string[];
  candidateCount: number;
  eligibleCandidateCount: number;
  excludedCandidates: Array<{ applywizzId: string; reason: string }>;
  excludedJobs: Array<{ applywizzId: string; jobUrl: string; reason: string }>;
  scannedTemplates: number;
  scanErrors: Array<{ url: string; message: string }>;
  candidateQaInventory: Array<{ applywizzId: string; qaEntries: Array<Pick<QABankRow, 'id' | 'question_fingerprint' | 'question_label' | 'field_type' | 'value' | 'source' | 'confidence' | 'updated_at'>> }>;
  applications: Array<{
    applywizzId: string;
    jobUrl: string;
    ingestRunId: string;
    taskId: string | null;
    assignmentOrdinal: number;
    resolvedFields: Awaited<ReturnType<AnswerResolver['resolveFormFields']>>;
    answerAudit: Array<{
      ingestRunId: string;
      taskId: string | null;
      assignmentOrdinal: number;
      candidateId: string;
      jobUrl: string;
      fieldId: string;
      fieldFingerprint: string;
      slotIndex: number;
      sourceTier: number | null;
      evidenceReferences: string[];
      options: string[];
      optionsComplete: boolean | null;
      stageDecisions: IngestTier5StageDecision[];
      answerDecision: 'resolved' | 'unresolved';
      reviewerVerdict: 'supported' | 'unsupported' | 'contradicted' | 'misassociated' | 'unavailable' | 'unreviewed';
    }>;
    reviewEvidence: Array<{
      fieldId: string;
      questionFingerprint: string;
      candidateEvidence: string;
      qaEntries: Array<Pick<QABankRow, 'id' | 'question_fingerprint' | 'question_label' | 'field_type' | 'value' | 'source' | 'confidence' | 'updated_at'>>;
    }>;
  }>;
  metrics?: {
    totalDurationMs: number;
    phaseDurationMs: Record<string, number>;
    createdApplicationDenominator: number;
    wouldAutoQueueEligible: number;
    wouldRequireReview: number;
    wouldBeFilteredOut: number;
    funnel: {
      counts: Record<ReadOnlyFunnelDisposition, number>;
      dispositions: Array<ReadOnlyFunnelAssignment & { disposition: ReadOnlyFunnelDisposition }>;
      actualQueued: null;
      actualQueueStatus: 'not_measured_read_only_evaluation';
    };
    answerOutcomes: Record<string, number>;
    tier5Usage: Tier5UsageSummary;
    baseline: {
      windowUtc: { from: string; to: string };
      matchedPairs: number;
      unmatchedApplications: number;
      duplicatePairs: Array<{ applywizzId: string; jobUrl: string; count: number; selectedLatestCreatedAt: string | null; allCreatedAt: Array<string | null> }>;
      answerChanges: Array<{ ingestRunId: string; applywizzId: string; jobUrl: string; taskId: string | null; assignmentOrdinal: number; fieldId: string; slotIndex: number; fieldFingerprint: string; outcome: 'changed' | 'unchanged' | 'newly_resolved' | 'newly_unresolved' | 'unknown_legacy_identity' }>;
      removedHistoricalAnswers: Array<{ ingestRunId: string; applywizzId: string; jobUrl: string; taskId: string | null; assignmentOrdinal: number; slotIndex: number; fieldId: string | null; fieldFingerprint: string; outcome: 'removed' | 'unknown_legacy_identity' }>;
    };
  };
}

type Tier5UsageSummary = { promptTokens: number | null; completionTokens: number | null; cost: number | null; costStatus: 'provider_reported' | 'unknown'; byModel: Record<string, { promptTokens: number | null; completionTokens: number | null; cost: number | null }> };

export async function runReadOnlyBatchEvaluation(
  csvPath: string,
  ports: ReadOnlyBatchEvaluationPorts,
  localOutputPath?: string,
): Promise<ReadOnlyBatchEvaluationResult> {
  const startedAt = Date.now();
  const ingestRunId = ports.ingestRunId?.trim() || randomUUID();
  const phaseDurationMs: Record<string, number> = {};
  const usageByModel = new Map<string, { promptTokens: number; completionTokens: number; cost: number | null }>();
  const unknownTokenModels = new Set<string>();
  const accountedUsageKeys = new Set<string>();
  const addUsage = (record: Tier5UsageRecord) => {
    const usageKey = record.batchIds?.length ? record.batchIds.slice().sort().join('|') : `${record.model}:${record.promptTokens}:${record.completionTokens}:${usageByModel.size}`;
    if (accountedUsageKeys.has(usageKey)) return;
    accountedUsageKeys.add(usageKey);
    if (record.promptTokens === undefined || record.completionTokens === undefined) unknownTokenModels.add(record.model);
    const prior = usageByModel.get(record.model) || { promptTokens: 0, completionTokens: 0, cost: 0 };
    prior.promptTokens += record.promptTokens ?? 0;
    prior.completionTokens += record.completionTokens ?? 0;
    prior.cost = prior.cost === null || record.cost === undefined ? null : prior.cost + record.cost;
    usageByModel.set(record.model, prior);
  };
  const usageSnapshot = () => {
    const values = [...usageByModel.values()];
    const costKnown = values.length > 0 && values.every((usage) => usage.cost !== null);
    return {
      promptTokens: values.length && !unknownTokenModels.size ? values.reduce((sum, usage) => sum + usage.promptTokens, 0) : null,
      completionTokens: values.length && !unknownTokenModels.size ? values.reduce((sum, usage) => sum + usage.completionTokens, 0) : null,
      cost: costKnown ? values.reduce((sum, usage) => sum + (usage.cost || 0), 0) : null,
      costStatus: costKnown ? 'provider_reported' as const : 'unknown' as const,
      byModel: Object.fromEntries([...usageByModel].map(([model, usage]) => [model, {
        promptTokens: unknownTokenModels.has(model) ? null : usage.promptTokens,
        completionTokens: unknownTokenModels.has(model) ? null : usage.completionTokens,
        cost: usage.cost,
      }])),
    };
  };
  const markPhase = (name: string, phaseStartedAt: number) => { phaseDurationMs[name] = Date.now() - phaseStartedAt; };
  const evidence = await ports.openReadOnlyEvidenceSession();

  try {
    let phaseStartedAt = Date.now();
    let resolvedShortlinks = new Map<string, string>();
    const uniqueUrls = await readAndDeduplicateUrls(csvPath, {
      resolveShortlinks: true,
      resolveShortlinksBatch: async (urls, concurrency) => {
        resolvedShortlinks = await ports.resolveShortlinksBatch(urls, concurrency);
        return resolvedShortlinks;
      },
      onFatal: (message, error) => { throw new Error(error ? `${message}: ${String(error)}` : message); },
    });
    markPhase('csv_deduplication', phaseStartedAt);
    phaseStartedAt = Date.now();
    const candidateMap = await segregateCandidatesByApplyWizzId(csvPath, {
      syncProfiles: false,
      downloadResumes: false,
      allowOutboundApi: false,
      onFatal: (message, error) => { throw new Error(error ? `${message}: ${String(error)}` : message); },
    });
    const segments = Array.from(candidateMap.values());
    markPhase('candidate_segregation', phaseStartedAt);
    phaseStartedAt = Date.now();
    const scanResult = await ports.scanUrls(uniqueUrls);
    markPhase('fresh_scan', phaseStartedAt);
    phaseStartedAt = Date.now();
    await alignAndFilterCandidateSegmentJobs(
      segments,
      new Set(uniqueUrls),
      async (url) => resolvedShortlinks.get(url) || url,
    );
    markPhase('shortlink_alignment', phaseStartedAt);

    const templateByUrl = new Map(scanResult.templates.map((template) => [template.jobUrl, template]));
    const resolver = new AnswerResolver();
    const applications: ReadOnlyBatchEvaluationResult['applications'] = [];
    const tier5Decisions: IngestTier5StageDecision[] = [];
    const evidenceByCandidate = new Map<string, ReadOnlyCandidateEvidence>();
    const excludedCandidates: ReadOnlyBatchEvaluationResult['excludedCandidates'] = [];
    const excludedJobs: ReadOnlyBatchEvaluationResult['excludedJobs'] = [];

    phaseStartedAt = Date.now();
    for (const segment of segments) {
      let candidateEvidence = evidenceByCandidate.get(segment.applywizzId);
      if (!candidateEvidence) {
        candidateEvidence = await evidence.readCandidateEvidence(segment.applywizzId);
        if (!candidateEvidence || !Array.isArray(candidateEvidence.qaEntries)) {
          throw new Error(`Read-only evidence is incomplete for ${segment.applywizzId}.`);
        }
        evidenceByCandidate.set(segment.applywizzId, candidateEvidence);
      }

      if (!candidateEvidence.profile) {
        excludedCandidates.push({ applywizzId: segment.applywizzId, reason: 'profile_missing (production segregator excludes candidates without a profile)' });
        continue;
      }
      if (!isReadOnlyEvaluationCandidateEligible(candidateEvidence.profile, config.REQUIRE_ZOHO_CONNECTED)) {
        excludedCandidates.push({ applywizzId: segment.applywizzId, reason: 'zoho_not_connected' });
        continue;
      }

      for (let assignmentOrdinal = 0; assignmentOrdinal < segment.jobs.length; assignmentOrdinal++) {
        const job = segment.jobs[assignmentOrdinal];
        const jobUrl = job.canonicalUrl || job.rawUrl;
        const template = templateByUrl.get(jobUrl);
        if (!template) {
          const scanError = scanResult.errors.find((error) => error.url === jobUrl);
          excludedJobs.push({
            applywizzId: segment.applywizzId,
            jobUrl,
            reason: scanError ? `scan_failed: ${scanError.message}` : 'scan_template_missing',
          });
          continue;
        }
        if (hasSecurityClearanceQuestion(template)) {
          excludedJobs.push({ applywizzId: segment.applywizzId, jobUrl, reason: 'security_clearance_question' });
          continue;
        }
        const exclusionReasons = getApplicationExclusionReasons(
          profileRowToCandidateProfile(candidateEvidence.profile),
          template.companyName || '',
        );
        if (exclusionReasons.length) {
          excludedJobs.push({ applywizzId: segment.applywizzId, jobUrl, reason: `company_exclusion: ${exclusionReasons.join(',')}` });
          continue;
        }

        const execution: ResolutionExecution = {
          mode: 'evaluation',
          readExactQaAnswer: async (candidateId, fingerprint) => {
            const row = candidateEvidence!.qaEntries.find(
              (entry) => entry.question_fingerprint === fingerprint && entry.applywizz_id === candidateId,
            );
            return row ? { value: row.value } : null;
          },
          semanticSearchAdapters: evidence.semanticSearchAdapters,
        };

        const resolvedFields = await resolver.resolveFormFields(
          segment.applywizzId,
          template.fields,
          {
            companyName: template.companyName,
            jobTitle: template.jobTitle,
            jobUrl: template.jobUrl,
            jobPostingLocation: template.jobPostingLocation,
            jobPostingFacts: template.jobPostingFacts,
          },
          {
            profile: candidateEvidence.profile,
            parsedResume: candidateEvidence.parsedResume,
            qaEntries: candidateEvidence.qaEntries,
          },
          execution,
        );
        applications.push({
          applywizzId: segment.applywizzId,
          jobUrl,
          ingestRunId,
          taskId: job.taskId || null,
          assignmentOrdinal,
          resolvedFields,
          answerAudit: resolvedFields.map((resolved, slotIndex) => {
            const field = template.fields[slotIndex];
            const candidateEvidenceText = buildQuestionRelevantEvidence(field, candidateEvidence!.profile!, candidateEvidence!.parsedResume?.raw_text || '');
            return {
              ingestRunId,
              taskId: job.taskId || null,
              assignmentOrdinal,
              candidateId: segment.applywizzId,
              jobUrl,
              fieldId: field.fieldId,
              fieldFingerprint: generateFingerprint(field.label, field.type),
              slotIndex,
              sourceTier: resolved.resolvedByTier,
              evidenceReferences: candidateEvidenceText ? [`sha256:${createHash('sha256').update(candidateEvidenceText).digest('hex').slice(0, 16)}`] : [],
              options: [...(field.options || [])],
              optionsComplete: typeof field.optionsComplete === 'boolean' ? field.optionsComplete : null,
              stageDecisions: [],
              answerDecision: resolved.value?.trim() ? 'resolved' as const : 'unresolved' as const,
              reviewerVerdict: 'unreviewed' as const,
            };
          }),
          reviewEvidence: template.fields.map((field) => ({
            fieldId: field.fieldId,
            questionFingerprint: generateFingerprint(field.label, field.type),
            candidateEvidence: buildQuestionRelevantEvidence(field, candidateEvidence!.profile!, candidateEvidence!.parsedResume?.raw_text || ''),
            qaEntries: candidateEvidence!.qaEntries.filter((entry) => entry.question_fingerprint === generateFingerprint(field.label, field.type)).map(({ id, question_fingerprint, question_label, field_type, value, source, confidence, updated_at }) => ({
              id, question_fingerprint, question_label, field_type, value, source, confidence, updated_at,
            })),
          })),
        });
      }
    }
    markPhase('deterministic_resolution', phaseStartedAt);

    const tier5Work: IngestTier5Work[] = [];
    for (const application of applications) {
      const template = templateByUrl.get(application.jobUrl);
      const candidateEvidence = evidenceByCandidate.get(application.applywizzId);
      if (!template || !candidateEvidence?.profile) continue;
      for (let index = 0; index < application.resolvedFields.length; index++) {
        const scannedField = template.fields[index];
        const field = {
          ...scannedField,
          isRequired: Boolean(scannedField.isRequired || (scannedField as any).required || (scannedField as any).is_required),
        };
        const original = application.resolvedFields[index];
        if (!isReadOnlyTier5Field(field, original)) continue;
        tier5Work.push({
          candidateId: application.applywizzId,
          jobUrl: application.jobUrl,
          taskId: application.taskId,
          assignmentOrdinal: application.assignmentOrdinal,
          fieldKey: createReadOnlyTier5FieldKey({ candidateId: application.applywizzId, jobUrl: application.jobUrl, taskId: application.taskId, assignmentOrdinal: application.assignmentOrdinal, field, slotIndex: index }),
          questionFingerprint: generateFingerprint(field.label, field.type),
          field,
          original,
          profile: candidateEvidence.profile,
          resumeText: candidateEvidence.parsedResume?.raw_text || '',
          jobTitle: template.jobTitle || 'Position',
          companyName: template.companyName || 'Company',
          jobPostingFacts: template.jobPostingFacts,
        });
      }
    }
    phaseStartedAt = Date.now();
    if (tier5Work.length) {
      const runKey = `readonly-${generateFingerprint(tier5Work.map((item) => item.fieldKey).sort().join('\n'), 'tier5')}`;
      const stateDirectory = localOutputPath
        ? path.dirname(path.resolve(localOutputPath))
        : path.resolve('.ai/diagnostics/read-only-batch-evaluation', runKey);
      const createdStateDirectory = await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await ensurePrivateArtifactDirectory(stateDirectory, createdStateDirectory !== undefined);
      const statePath = localOutputPath
        ? `${path.resolve(localOutputPath)}.message-batches.json`
        : path.join(stateDirectory, 'message-batches.json');
      const stages = ports.createTier5Stages?.(runKey, statePath, addUsage) || createIngestTier5Stages(
        runKey,
        new LLMSynthesizer({ batchStateStore: new JsonBatchRunStateStore(statePath) }),
        addUsage,
      );
      let tier5Results: Map<string, import('../types/index.js').ResolvedField>;
      try {
        tier5Results = await resolveIngestTier5(tier5Work, stages, (decision) => tier5Decisions.push(decision));
      } catch (error) {
        if (!(error instanceof IngestTier5BatchPendingError)) throw error;
        attachTier5AnswerAudit(applications, tier5Work, tier5Decisions);
        return {
          status: 'pending',
          pendingBatch: { stage: error.stage, batchIds: error.batchIds },
          uniqueUrls,
          candidateCount: segments.length,
          eligibleCandidateCount: segments.length - excludedCandidates.length,
          excludedCandidates,
          excludedJobs,
          scannedTemplates: scanResult.templates.length,
          scanErrors: scanResult.errors,
          tier5Usage: usageSnapshot(),
          candidateQaInventory: [...evidenceByCandidate.entries()].map(([applywizzId, candidate]) => ({
            applywizzId,
            qaEntries: candidate.qaEntries.map(({ id, question_fingerprint, question_label, field_type, value, source, confidence, updated_at }) => ({ id, question_fingerprint, question_label, field_type, value, source, confidence, updated_at })),
          })),
          applications,
        };
      }
      for (const application of applications) {
        const template = templateByUrl.get(application.jobUrl);
        if (!template) continue;
        for (let index = 0; index < template.fields.length; index++) {
          const field = template.fields[index];
          const key = createReadOnlyTier5FieldKey({ candidateId: application.applywizzId, jobUrl: application.jobUrl, taskId: application.taskId, assignmentOrdinal: application.assignmentOrdinal, field, slotIndex: index });
          const resolved = tier5Results.get(key);
          if (!resolved) continue;
          application.resolvedFields[index] = mergeTier5ResolvedField(field, resolved);
        }
      }
      attachTier5AnswerAudit(applications, tier5Work, tier5Decisions);
    }
    markPhase('tier5_batches', phaseStartedAt);

    const funnelAssignments: ReadOnlyFunnelAssignment[] = segments.flatMap((segment) => segment.jobs.map((job, assignmentOrdinal) => {
      const jobUrl = job.canonicalUrl || job.rawUrl;
      const template = templateByUrl.get(jobUrl);
      const application = applications.find((row) => row.applywizzId === segment.applywizzId && row.assignmentOrdinal === assignmentOrdinal);
      const excluded = excludedCandidates.some((row) => row.applywizzId === segment.applywizzId) || excludedJobs.some((row) => row.applywizzId === segment.applywizzId && row.jobUrl === jobUrl);
      return {
        applywizzId: segment.applywizzId,
        jobUrl,
        taskId: job.taskId || null,
        assignmentOrdinal,
        output: template?.isExpired ? 'expired' as const : excluded ? 'excluded' as const : application ? 'resolved' as const : 'missing' as const,
        hasResolvedFields: application ? hasAnyNonEmptyResolvedField(application.resolvedFields) : false,
        filtered: application ? applicationShouldBeFilteredOut(application.resolvedFields) : false,
        needsReview: application ? applicationNeedsOperatorReview(application.resolvedFields) : false,
      };
    }));
    const applicationPairs = funnelAssignments.map(({ applywizzId, jobUrl }) => ({ applywizzId, jobUrl }));
    const [existingApplications, baselineApplications] = await Promise.all([
      evidence.readExistingApplications ? evidence.readExistingApplications(applicationPairs) : Promise.resolve(undefined),
      evidence.readBaselineApplications?.('2026-11-10T18:30:00.000Z', '2026-11-11T18:30:00.000Z') ?? Promise.resolve([]),
    ]);
    const funnel = reconcileReadOnlyFunnel(funnelAssignments, existingApplications, evidence.taskIdsGloballyCovered === true);
    const baselineByPair = new Map<string, ReadOnlyEvaluationApplicationSnapshot[]>();
    for (const row of baselineApplications) {
      const key = `${row.applywizz_id.trim().toUpperCase()}|${row.job_url}`;
      baselineByPair.set(key, [...(baselineByPair.get(key) || []), row]);
    }
    const currentAssignmentsByPair = new Map<string, number>();
    for (const application of applications) {
      const key = `${application.applywizzId.trim().toUpperCase()}|${application.jobUrl}`;
      currentAssignmentsByPair.set(key, (currentAssignmentsByPair.get(key) || 0) + 1);
    }
    const answerOutcomes: Record<string, number> = {};
    const answerChanges: Array<{ ingestRunId: string; applywizzId: string; jobUrl: string; taskId: string | null; assignmentOrdinal: number; fieldId: string; slotIndex: number; fieldFingerprint: string; outcome: 'changed' | 'unchanged' | 'newly_resolved' | 'newly_unresolved' | 'unknown_legacy_identity' }> = [];
    const createdApplicationDenominator = funnel.createdDenominator;
    const wouldAutoQueueEligible = funnel.counts.created_auto_queue_eligible;
    const wouldRequireReview = funnel.counts.created_review;
    const wouldBeFilteredOut = funnel.counts.created_filtered;
    let matchedPairs = 0;
    let unmatchedApplications = 0;
    const removedHistoricalAnswers: Array<{ ingestRunId: string; applywizzId: string; jobUrl: string; taskId: string | null; assignmentOrdinal: number; slotIndex: number; fieldId: string | null; fieldFingerprint: string; outcome: 'removed' | 'unknown_legacy_identity' }> = [];
    for (const application of applications) {
      const key = `${application.applywizzId.trim().toUpperCase()}|${application.jobUrl}`;
      const currentAssignmentCount = currentAssignmentsByPair.get(key) || 0;
      const matches = baselineByPair.get(key) || [];
      if (matches.length) matchedPairs++;
      else unmatchedApplications++;
      const taskMatches = application.taskId ? matches.filter((row) => row.task_id === application.taskId) : matches;
      const latestBaseline = application.taskId
        ? taskMatches.length === 1 ? taskMatches[0] : taskMatches.length > 1 ? [...taskMatches].sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''))[0] : undefined
        : matches.length === 1 && currentAssignmentCount === 1 ? matches[0] : undefined;
      const oldFields = latestBaseline?.resolved_fields || [];
      const historicalByFingerprint = new Map<string, typeof oldFields>();
      oldFields.forEach((field) => { const fingerprint = generateFingerprint(field.label || '', field.type || ''); historicalByFingerprint.set(fingerprint, [...(historicalByFingerprint.get(fingerprint) || []), field]); });
      const currentByFingerprint = new Map<string, number>();
      application.resolvedFields.forEach((field) => { const fingerprint = generateFingerprint(field.label, field.type); currentByFingerprint.set(fingerprint, (currentByFingerprint.get(fingerprint) || 0) + 1); });
      for (let slotIndex = 0; slotIndex < application.resolvedFields.length; slotIndex++) {
        const field = application.resolvedFields[slotIndex];
        const outcome = field.value?.trim() ? 'resolved' : 'unresolved';
        answerOutcomes[outcome] = (answerOutcomes[outcome] || 0) + 1;
        const fingerprint = generateFingerprint(field.label, field.type);
        const old = oldFields.find((historical) => {
          const historicalIndex = historical.slotIndex ?? historical.index;
          const historicalId = historical.fieldId ?? historical.field_id;
          const historicalFingerprint = generateFingerprint(historical.label || '', historical.type || '');
          return historicalIndex === slotIndex && historicalId === field.fieldId && historicalFingerprint === fingerprint;
        });
        const legacyCandidates = historicalByFingerprint.get(fingerprint) || [];
        const matchedOld = old || (currentByFingerprint.get(fingerprint) === 1 && legacyCandidates.length === 1 ? legacyCandidates[0] : undefined);
        const pairIdentityIsUnique = Boolean(application.taskId || currentAssignmentCount === 1);
        const identityKnown = Boolean(pairIdentityIsUnique && latestBaseline && (old || (currentByFingerprint.get(fingerprint) === 1 && legacyCandidates.length === 1)));
        const oldValue = matchedOld?.value?.trim() || '';
        const newValue = field.value?.trim() || '';
        const change = !identityKnown ? 'unknown_legacy_identity' : !oldValue && newValue ? 'newly_resolved' : oldValue && !newValue ? 'newly_unresolved' : oldValue === newValue ? 'unchanged' : 'changed';
        answerChanges.push({ ingestRunId, applywizzId: application.applywizzId, jobUrl: application.jobUrl, taskId: application.taskId, assignmentOrdinal: application.assignmentOrdinal, fieldId: field.fieldId, slotIndex, fieldFingerprint: fingerprint, outcome: change });
      }
      const oldByFingerprint = new Map<string, number>();
      oldFields.forEach((historical) => { const fingerprint = generateFingerprint(historical.label || '', historical.type || ''); oldByFingerprint.set(fingerprint, (oldByFingerprint.get(fingerprint) || 0) + 1); });
      for (let historicalSlotIndex = 0; historicalSlotIndex < oldFields.length; historicalSlotIndex++) {
        const historical = oldFields[historicalSlotIndex];
        const fingerprint = generateFingerprint(historical.label || '', historical.type || '');
        const historicalFieldId = historical.fieldId ?? historical.field_id ?? null;
        const exactCurrentSlot = application.resolvedFields[historical.slotIndex ?? historical.index ?? historicalSlotIndex];
        const exactSlotMatches = Boolean(exactCurrentSlot && historicalFieldId && exactCurrentSlot.fieldId === historicalFieldId && generateFingerprint(exactCurrentSlot.label, exactCurrentSlot.type) === fingerprint);
        const legacyMatches = currentByFingerprint.get(fingerprint) === 1 && oldByFingerprint.get(fingerprint) === 1;
        if (!exactSlotMatches && !legacyMatches) removedHistoricalAnswers.push({ ingestRunId, applywizzId: application.applywizzId, jobUrl: application.jobUrl, taskId: application.taskId, assignmentOrdinal: application.assignmentOrdinal, slotIndex: historical.slotIndex ?? historical.index ?? historicalSlotIndex, fieldId: historicalFieldId, fieldFingerprint: fingerprint, outcome: currentByFingerprint.has(fingerprint) ? 'unknown_legacy_identity' : 'removed' });
      }
    }
    const duplicatePairs = [...baselineByPair.entries()].filter(([, rows]) => rows.length > 1).map(([key, rows]) => {
      const [applywizzId, jobUrl] = key.split('|');
      const latest = [...rows].sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''))[0];
      return { applywizzId, jobUrl, count: rows.length, selectedLatestCreatedAt: latest.created_at || null, allCreatedAt: rows.map((row) => row.created_at || null) };
    });

    const result: ReadOnlyBatchEvaluationResult = {
      status: 'complete',
      uniqueUrls,
      candidateCount: segments.length,
      eligibleCandidateCount: segments.length - excludedCandidates.length,
      excludedCandidates,
      excludedJobs,
      scannedTemplates: scanResult.templates.length,
      scanErrors: scanResult.errors,
      candidateQaInventory: [...evidenceByCandidate.entries()].map(([applywizzId, candidate]) => ({
        applywizzId,
        qaEntries: candidate.qaEntries.map(({ id, question_fingerprint, question_label, field_type, value, source, confidence, updated_at }) => ({ id, question_fingerprint, question_label, field_type, value, source, confidence, updated_at })),
      })),
      applications,
      metrics: {
        totalDurationMs: Date.now() - startedAt,
        phaseDurationMs,
        createdApplicationDenominator,
        wouldAutoQueueEligible,
        wouldRequireReview,
        wouldBeFilteredOut,
          funnel: {
            counts: funnel.counts,
            dispositions: funnel.dispositions,
            actualQueued: funnel.actualQueued,
            actualQueueStatus: 'not_measured_read_only_evaluation',
          },
        answerOutcomes,
        tier5Usage: usageSnapshot(),
        baseline: {
          windowUtc: { from: '2026-11-10T18:30:00.000Z', to: '2026-11-11T18:30:00.000Z' },
          matchedPairs,
          unmatchedApplications,
          duplicatePairs,
          answerChanges,
          removedHistoricalAnswers,
        },
      },
    };
    if (localOutputPath) await writeReadOnlyEvaluationOutput(localOutputPath, result);
    return result;
  } finally {
    await evidence.close();
  }
}

export async function writeReadOnlyEvaluationOutput(
  outputPath: string,
  result: ReadOnlyBatchEvaluationResult,
): Promise<void> {
  const resolvedPath = path.resolve(outputPath);
  const directoryPath = path.dirname(resolvedPath);
  const createdDirectory = await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await ensurePrivateArtifactDirectory(directoryPath, createdDirectory !== undefined);
  await fs.writeFile(resolvedPath, JSON.stringify(result, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(resolvedPath, 0o600);
}
