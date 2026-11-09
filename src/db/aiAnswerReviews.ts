/**
 * @fileoverview AI Answer Reviews and Two-Level Review Service.
 * Manages immutable proposal recording, idempotent operator submission promotion,
 * two-stage review transitions (Operator -> Manager), atomic QA bank mutations,
 * optimistic concurrency control, replay-safe idempotency caching, and decoupled embeddings.
 */

import { randomUUID } from 'node:crypto';
import { getDbClient, isSupabaseConfigured } from './client.js';
import { upsertAnswer, type QABankRow } from './qaBank.js';
import { writeEmbedding } from '../resolver/semanticSearch.js';
import { memoryApplications } from './applications/memoryStore.js';
import { listOperatorEmailsForManager } from './users.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AiAnswerReviews');

export type ReviewStatus = 'pending_operator' | 'pending_manager' | 'approved' | 'rejected';
export type OperatorAction = 'approve' | 'deny' | 'edit';
export type ManagerAction = 'approve' | 'reject' | 'edit';
export type EmbeddingStatus = 'pending' | 'completed' | 'failed' | 'not_applicable';

export interface AiReviewProposalItem {
  fieldKey: string; // SHA-256(label|type)[0:16] fingerprint
  questionLabel: string;
  fieldType: string;
  options?: string[];
  aiValue: string;
  aiConfidence?: number;
  aiModel: string;
  tier5Provenance?: any;
}

export interface RecordProposalsInput {
  applicationId: string;
  resolutionRevision?: number;
  applywizzId: string;
  candidateName?: string;
  proposals: AiReviewProposalItem[];
}

export interface AiAnswerReviewRow {
  id: string;
  application_id: string;
  resolution_revision: number;
  field_key: string;
  applywizz_id: string;
  candidate_name?: string | null;
  question_label: string;
  field_type: string;
  options?: any;
  ai_value: string;
  ai_confidence?: number | null;
  ai_model: string;
  ai_provenance?: any;
  revision: number;
  status: ReviewStatus;
  promoted_at?: string | null;
  promoted_value?: string | null;
  promoted_source?: string | null;
  operator_action?: 'approved' | 'denied' | 'edited' | null;
  operator_value?: string | null;
  operator_email?: string | null;
  operator_actioned_at?: string | null;
  manager_action?: 'approved' | 'rejected' | 'edited' | null;
  manager_value?: string | null;
  manager_email?: string | null;
  manager_actioned_at?: string | null;
  embedding_status: EmbeddingStatus;
  embedding_revision: number;
  embedding_updated_at?: string | null;
  embedding_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PromoteSubmittedAiAnswersInput {
  applicationId: string;
  actorEmail?: string;
  actor?: string;
}

export interface OperatorReviewActionInput {
  reviewId: string;
  expectedRevision: number;
  action: OperatorAction;
  editedValue?: string;
  actorEmail: string;
  idempotencyKey?: string;
}

export interface ManagerReviewActionInput {
  reviewId: string;
  expectedRevision: number;
  action: ManagerAction;
  editedValue?: string;
  actorEmail: string;
  idempotencyKey?: string;
}

export interface ReviewActionResult {
  success: boolean;
  review?: AiAnswerReviewRow;
  deletedQaCount?: number;
  error?: string;
  cached?: boolean;
}

// ---------------------------------------------------------------------------
// In-Memory Test Store (for zero-dependency fast unit testing)
// ---------------------------------------------------------------------------

interface ReviewEvent {
  id: string;
  reviewId: string;
  eventType: string;
  actor: string;
  actorRole?: string;
  action?: string;
  fromStatus?: string;
  toStatus?: string;
  fromRevision?: number;
  toRevision?: number;
  payload?: any;
  createdAt: string;
}

interface IdempotencyRecord {
  key: string;
  reviewId: string;
  actionType: string;
  responsePayload: ReviewActionResult;
  createdAt: string;
}

let testStoreEnabled = false;
const inMemoryReviews = new Map<string, AiAnswerReviewRow>();
const inMemoryEvents: ReviewEvent[] = [];
const inMemoryIdempotency = new Map<string, IdempotencyRecord>();
const inMemoryQaBank = new Map<string, QABankRow>(); // key: `${applywizz_id}:${fingerprint}`
const inMemorySubmittedApps = new Set<string>();
const inMemoryOperatorAssignments = new Map<
  string,
  { candidateIds: Set<string>; applicationIds: Set<string> }
>();
const inMemoryManagerTeams = new Map<string, Set<string>>();
const inMemoryUserRoles = new Map<string, 'dev' | 'admin' | 'manager' | 'operator'>();

export function setTestReviewStoreEnabled(enabled: boolean): void {
  testStoreEnabled = enabled;
}

export function isTestReviewStoreEnabled(): boolean {
  return testStoreEnabled || !isSupabaseConfigured();
}

export function markTestApplicationSubmitted(applicationId: string): void {
  inMemorySubmittedApps.add(applicationId);
}

export function resetTestReviewStore(): void {
  inMemoryReviews.clear();
  inMemoryEvents.length = 0;
  inMemoryIdempotency.clear();
  inMemoryQaBank.clear();
  inMemorySubmittedApps.clear();
  inMemoryOperatorAssignments.clear();
  inMemoryManagerTeams.clear();
  inMemoryUserRoles.clear();
}

export function setTestOperatorAssignment(
  operatorEmail: string,
  assignment: { candidateIds?: string[]; applicationIds?: string[] }
): void {
  const norm = operatorEmail.trim().toLowerCase();
  const existing = inMemoryOperatorAssignments.get(norm) || {
    candidateIds: new Set<string>(),
    applicationIds: new Set<string>(),
  };
  if (assignment.candidateIds) {
    for (const id of assignment.candidateIds) {
      existing.candidateIds.add(id.trim().toUpperCase());
    }
  }
  if (assignment.applicationIds) {
    for (const id of assignment.applicationIds) {
      existing.applicationIds.add(id.trim());
    }
  }
  inMemoryOperatorAssignments.set(norm, existing);
}

export function setTestManagerTeam(managerEmail: string, operatorEmails: string[]): void {
  const normMgr = managerEmail.trim().toLowerCase();
  const ops = new Set(operatorEmails.map((e) => e.trim().toLowerCase()));
  inMemoryManagerTeams.set(normMgr, ops);
}

export function setTestUserRole(
  email: string,
  role: 'dev' | 'admin' | 'manager' | 'operator'
): void {
  inMemoryUserRoles.set(email.trim().toLowerCase(), role);
}

export function getTestUserRole(
  email: string
): 'dev' | 'admin' | 'manager' | 'operator' | null {
  return inMemoryUserRoles.get(email.trim().toLowerCase()) || null;
}

export function getInMemoryQaRow(applywizzId: string, fingerprint: string): QABankRow | null {
  return inMemoryQaBank.get(`${applywizzId}:${fingerprint}`) || null;
}

export function setInMemoryQaRow(row: QABankRow): void {
  inMemoryQaBank.set(`${row.applywizz_id}:${row.question_fingerprint}`, { ...row });
}

export function getInMemoryEvents(reviewId?: string): ReviewEvent[] {
  if (!reviewId) return [...inMemoryEvents];
  return inMemoryEvents.filter((e) => e.reviewId === reviewId);
}

// ---------------------------------------------------------------------------
// Data Layer Operations
// ---------------------------------------------------------------------------

/**
 * Records AI review proposals with immutable identity (application_id + resolution_revision + field_key).
 * If a proposal with this identity already exists, it is left untouched.
 */
export async function recordAiReviewProposals(
  input: RecordProposalsInput
): Promise<AiAnswerReviewRow[]> {
  const {
    applicationId,
    resolutionRevision = 1,
    applywizzId,
    candidateName,
    proposals,
  } = input;

  if (!applicationId || !applywizzId || !Array.isArray(proposals) || proposals.length === 0) {
    return [];
  }

  if (isTestReviewStoreEnabled()) {
    const results: AiAnswerReviewRow[] = [];
    for (const p of proposals) {
      const existing = Array.from(inMemoryReviews.values()).find(
        (r) =>
          r.application_id === applicationId &&
          r.resolution_revision === resolutionRevision &&
          r.field_key === p.fieldKey
      );

      if (existing) {
        results.push(existing);
        continue;
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const row: AiAnswerReviewRow = {
        id,
        application_id: applicationId,
        resolution_revision: resolutionRevision,
        field_key: p.fieldKey,
        applywizz_id: applywizzId,
        candidate_name: candidateName || null,
        question_label: p.questionLabel,
        field_type: p.fieldType,
        options: p.options || null,
        ai_value: p.aiValue,
        ai_confidence: p.aiConfidence ?? null,
        ai_model: p.aiModel,
        ai_provenance: p.tier5Provenance || null,
        revision: 1,
        status: 'pending_operator',
        promoted_at: null,
        promoted_value: null,
        promoted_source: null,
        operator_action: null,
        operator_value: null,
        operator_email: null,
        operator_actioned_at: null,
        manager_action: null,
        manager_value: null,
        manager_email: null,
        manager_actioned_at: null,
        embedding_status: 'pending',
        embedding_revision: 0,
        embedding_updated_at: null,
        embedding_error: null,
        created_at: now,
        updated_at: now,
      };

      inMemoryReviews.set(id, row);
      inMemoryEvents.push({
        id: randomUUID(),
        reviewId: id,
        eventType: 'proposal_created',
        actor: 'tier5_synthesizer',
        actorRole: 'system',
        createdAt: now,
      });
      results.push(row);
    }
    return results;
  }

  // Live Supabase path
  const supabase = getDbClient();
  const rowsToInsert = proposals.map((p) => ({
    application_id: applicationId,
    resolution_revision: resolutionRevision,
    field_key: p.fieldKey,
    applywizz_id: applywizzId,
    candidate_name: candidateName || null,
    question_label: p.questionLabel,
    field_type: p.fieldType,
    options: p.options ? JSON.stringify(p.options) : null,
    ai_value: p.aiValue,
    ai_confidence: p.aiConfidence ?? null,
    ai_model: p.aiModel,
    ai_provenance: p.tier5Provenance || null,
    revision: 1,
    status: 'pending_operator',
    embedding_status: 'pending',
  }));

  const { error } = await supabase
    .from('gh_ai_answer_reviews')
    .upsert(rowsToInsert, {
      onConflict: 'application_id,resolution_revision,field_key',
      ignoreDuplicates: true,
    });

  if (error) {
    log.error(`[aiAnswerReviews] Failed to record proposals: ${error.message}`);
    throw new Error(`Failed to record review proposals: ${error.message}`);
  }

  const { data: storedRows, error: fetchError } = await supabase
    .from('gh_ai_answer_reviews')
    .select('*')
    .eq('application_id', applicationId)
    .eq('resolution_revision', resolutionRevision);

  if (fetchError || !storedRows) {
    throw new Error(`Failed to fetch recorded proposals: ${fetchError?.message}`);
  }

  return storedRows as AiAnswerReviewRow[];
}

/**
 * Promotes all AI answers for a submitted application to gh_candidate_qa_bank idempotently.
 * Never blocks application submission if QA promotion fails.
 */
export async function promoteSubmittedAiAnswers(
  input: PromoteSubmittedAiAnswersInput
): Promise<{ promotedCount: number; reviews: AiAnswerReviewRow[] }> {
  const applicationId = input.applicationId;
  const actorEmail = input.actor || input.actorEmail || 'operator_submission';
  if (!applicationId) {
    return { promotedCount: 0, reviews: [] };
  }

  if (isTestReviewStoreEnabled()) {
    const matching = Array.from(inMemoryReviews.values()).filter(
      (r) =>
        r.application_id === applicationId &&
        ['pending_operator', 'pending_manager', 'approved'].includes(r.status)
    );

    const now = new Date().toISOString();
    let promotedCount = 0;

    for (const rev of matching) {
      const promotedValue = rev.operator_value || rev.ai_value;
      rev.promoted_at = rev.promoted_at || now;
      rev.promoted_value = promotedValue;
      rev.promoted_source = 'operator_submission';
      rev.embedding_status = 'pending';
      rev.updated_at = now;

      // Upsert to in-memory QA bank
      inMemoryQaBank.set(`${rev.applywizz_id}:${rev.field_key}`, {
        applywizz_id: rev.applywizz_id,
        question_fingerprint: rev.field_key,
        question_label: rev.question_label,
        field_type: rev.field_type,
        value: promotedValue,
        source: 'manual',
        confidence: 1.0,
        updated_at: now,
      });

      inMemoryEvents.push({
        id: randomUUID(),
        reviewId: rev.id,
        eventType: 'promoted_submission',
        actor: actorEmail,
        actorRole: 'operator',
        createdAt: now,
      });
      promotedCount++;
    }

    return { promotedCount, reviews: matching };
  }

  // Supabase live execution
  const supabase = getDbClient();
  const { data: reviews, error: selectErr } = await supabase
    .from('gh_ai_answer_reviews')
    .select('*')
    .eq('application_id', applicationId)
    .in('status', ['pending_operator', 'pending_manager', 'approved']);

  if (selectErr || !reviews) {
    throw new Error(`Failed to select reviews for promotion: ${selectErr?.message}`);
  }

  const now = new Date().toISOString();
  let promotedCount = 0;

  for (const rev of reviews as AiAnswerReviewRow[]) {
    const promotedValue = rev.operator_value || rev.ai_value;

    try {
      await upsertAnswer({
        applywizz_id: rev.applywizz_id,
        question_fingerprint: rev.field_key,
        question_label: rev.question_label,
        field_type: rev.field_type,
        value: promotedValue,
        source: 'manual',
        confidence: 1.0,
      });

      await supabase
        .from('gh_ai_answer_reviews')
        .update({
          promoted_at: rev.promoted_at || now,
          promoted_value: promotedValue,
          promoted_source: 'operator_submission',
          embedding_status: 'pending',
          updated_at: now,
        })
        .eq('id', rev.id);

      await supabase.from('gh_ai_answer_review_events').insert({
        review_id: rev.id,
        event_type: 'promoted_submission',
        actor: actorEmail,
        actor_role: 'operator',
        payload: { promoted_value: promotedValue },
      });

      promotedCount++;
    } catch (err: any) {
      log.warn(`[promoteSubmittedAiAnswers] QA upsert failed for review ${rev.id}: ${err.message}`);
    }
  }

  return { promotedCount, reviews: reviews as AiAnswerReviewRow[] };
}

/**
 * Processes an operator review action: 'approve' | 'deny' | 'edit'.
 * All operator actions ALWAYS advance the review item to 'pending_manager'.
 * Replay-safe via idempotencyKey, and guarded by optimistic revision check.
 */
export async function operatorReviewAction(
  input: OperatorReviewActionInput
): Promise<ReviewActionResult> {
  const {
    reviewId,
    expectedRevision,
    action,
    editedValue,
    actorEmail,
    idempotencyKey,
  } = input;

  if (idempotencyKey && inMemoryIdempotency.has(idempotencyKey)) {
    const cached = inMemoryIdempotency.get(idempotencyKey)!.responsePayload;
    return { ...cached, cached: true };
  }

  if (isTestReviewStoreEnabled()) {
    const rev = inMemoryReviews.get(reviewId);
    if (!rev) {
      throw new Error(`Review item ${reviewId} not found`);
    }

    if (rev.revision !== expectedRevision) {
      throw new Error(`Stale revision: expected ${expectedRevision}, got ${rev.revision}`);
    }

    if (rev.status !== 'pending_operator') {
      throw new Error(`Invalid review status for operator action: ${rev.status}`);
    }

    if (action === 'edit' && (!editedValue || !editedValue.trim())) {
      throw new Error('Edited value must be provided for edit action');
    }

    const now = new Date().toISOString();
    const prevRevision = rev.revision;
    const newRevision = prevRevision + 1;

    let opValue: string | null = null;
    let opAction: 'approved' | 'denied' | 'edited' = 'approved';

    if (action === 'approve') {
      opAction = 'approved';
      opValue = rev.ai_value;
    } else if (action === 'deny') {
      opAction = 'denied';
      opValue = null;
    } else if (action === 'edit') {
      opAction = 'edited';
      opValue = editedValue!.trim();
    }

    rev.status = 'pending_manager';
    rev.operator_action = opAction;
    rev.operator_value = opValue;
    rev.operator_email = actorEmail;
    rev.operator_actioned_at = now;
    rev.revision = newRevision;
    rev.updated_at = now;

    inMemoryEvents.push({
      id: randomUUID(),
      reviewId: rev.id,
      eventType: 'operator_action',
      actor: actorEmail,
      actorRole: 'operator',
      action,
      fromStatus: 'pending_operator',
      toStatus: 'pending_manager',
      fromRevision: prevRevision,
      toRevision: newRevision,
      payload: { action, editedValue, operator_value: opValue },
      createdAt: now,
    });

    const result: ReviewActionResult = {
      success: true,
      review: { ...rev },
    };

    if (idempotencyKey) {
      inMemoryIdempotency.set(idempotencyKey, {
        key: idempotencyKey,
        reviewId: rev.id,
        actionType: 'operator_action',
        responsePayload: result,
        createdAt: now,
      });
    }

    return result;
  }

  // Live Supabase path
  const supabase = getDbClient();

  if (idempotencyKey) {
    const { data: cached } = await supabase
      .from('gh_ai_review_idempotency_keys')
      .select('response_payload')
      .eq('key', idempotencyKey)
      .maybeSingle();

    if (cached?.response_payload) {
      return { ...(cached.response_payload as ReviewActionResult), cached: true };
    }
  }

  const { data: rev, error: fetchErr } = await supabase
    .from('gh_ai_answer_reviews')
    .select('*')
    .eq('id', reviewId)
    .single();

  if (fetchErr || !rev) {
    throw new Error(`Review item ${reviewId} not found`);
  }

  if (rev.revision !== expectedRevision) {
    throw new Error(`Stale revision: expected ${expectedRevision}, got ${rev.revision}`);
  }

  if (rev.status !== 'pending_operator') {
    throw new Error(`Invalid review status for operator action: ${rev.status}`);
  }

  if (action === 'edit' && (!editedValue || !editedValue.trim())) {
    throw new Error('Edited value must be provided for edit action');
  }

  const now = new Date().toISOString();
  const nextRev = rev.revision + 1;
  const opValue =
    action === 'edit'
      ? editedValue!.trim()
      : action === 'approve'
        ? rev.ai_value
        : null;
  const opAction =
    action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'edited';

  const { data: updated, error: updateErr } = await supabase
    .from('gh_ai_answer_reviews')
    .update({
      status: 'pending_manager',
      operator_action: opAction,
      operator_value: opValue,
      operator_email: actorEmail,
      operator_actioned_at: now,
      revision: nextRev,
      updated_at: now,
    })
    .eq('id', reviewId)
    .eq('revision', expectedRevision)
    .select()
    .single();

  if (updateErr || !updated) {
    throw new Error(`Failed to update review action: ${updateErr?.message || 'Concurrency conflict'}`);
  }

  await supabase.from('gh_ai_answer_review_events').insert({
    review_id: reviewId,
    event_type: 'operator_action',
    actor: actorEmail,
    actor_role: 'operator',
    action,
    from_status: 'pending_operator',
    to_status: 'pending_manager',
    from_revision: expectedRevision,
    to_revision: nextRev,
    payload: { action, editedValue, operator_value: opValue },
  });

  const result: ReviewActionResult = {
    success: true,
    review: updated as AiAnswerReviewRow,
  };

  if (idempotencyKey) {
    await supabase.from('gh_ai_review_idempotency_keys').insert({
      key: idempotencyKey,
      review_id: reviewId,
      action_type: 'operator_action',
      response_payload: result,
    });
  }

  return result;
}

/**
 * Processes a manager review action: 'approve' | 'reject' | 'edit'.
 * Enforces business rules:
 * - If operator denied, manager CANNOT approve the original AI answer without providing an edited replacement.
 * - Manager approval or edit writes to gh_candidate_qa_bank.
 * - Manager rejection deletes the QA entry ONLY if it still matches this review item's promoted value.
 *   Pre-existing or manually modified QA rows remain untouched.
 */
export async function managerReviewAction(
  input: ManagerReviewActionInput
): Promise<ReviewActionResult> {
  const {
    reviewId,
    expectedRevision,
    action,
    editedValue,
    actorEmail,
    idempotencyKey,
  } = input;

  if (idempotencyKey && inMemoryIdempotency.has(idempotencyKey)) {
    const cached = inMemoryIdempotency.get(idempotencyKey)!.responsePayload;
    return { ...cached, cached: true };
  }

  if (isTestReviewStoreEnabled()) {
    const rev = inMemoryReviews.get(reviewId);
    if (!rev) {
      throw new Error(`Review item ${reviewId} not found`);
    }

    if (rev.revision !== expectedRevision) {
      throw new Error(`Stale revision: expected ${expectedRevision}, got ${rev.revision}`);
    }

    if (rev.status !== 'pending_manager') {
      throw new Error(`Invalid review status for manager action: ${rev.status}`);
    }

    const now = new Date().toISOString();
    const prevRevision = rev.revision;
    const newRevision = prevRevision + 1;
    let deletedQaCount = 0;

    if (action === 'approve') {
      if (rev.operator_action === 'denied' && (!editedValue || !editedValue.trim())) {
        throw new Error('Cannot approve an operator-denied proposal without providing an edited replacement');
      }

      const effectiveValue =
        (editedValue && editedValue.trim()) || rev.operator_value || rev.ai_value;

      rev.status = 'approved';
      rev.manager_action = editedValue ? 'edited' : 'approved';
      rev.manager_value = effectiveValue;
      rev.manager_email = actorEmail;
      rev.manager_actioned_at = now;
      rev.revision = newRevision;
      rev.embedding_status = 'pending';
      rev.embedding_revision = newRevision;
      rev.updated_at = now;

      // Upsert to QA bank
      inMemoryQaBank.set(`${rev.applywizz_id}:${rev.field_key}`, {
        applywizz_id: rev.applywizz_id,
        question_fingerprint: rev.field_key,
        question_label: rev.question_label,
        field_type: rev.field_type,
        value: effectiveValue,
        source: 'manual',
        confidence: 1.0,
        updated_at: now,
      });
    } else if (action === 'edit') {
      if (!editedValue || !editedValue.trim()) {
        throw new Error('Edited value must be provided for edit action');
      }

      const effectiveValue = editedValue.trim();
      rev.status = 'approved';
      rev.manager_action = 'edited';
      rev.manager_value = effectiveValue;
      rev.manager_email = actorEmail;
      rev.manager_actioned_at = now;
      rev.revision = newRevision;
      rev.embedding_status = 'pending';
      rev.embedding_revision = newRevision;
      rev.updated_at = now;

      // Upsert to QA bank
      inMemoryQaBank.set(`${rev.applywizz_id}:${rev.field_key}`, {
        applywizz_id: rev.applywizz_id,
        question_fingerprint: rev.field_key,
        question_label: rev.question_label,
        field_type: rev.field_type,
        value: effectiveValue,
        source: 'manual',
        confidence: 1.0,
        updated_at: now,
      });
    } else if (action === 'reject') {
      rev.status = 'rejected';
      rev.manager_action = 'rejected';
      rev.manager_email = actorEmail;
      rev.manager_actioned_at = now;
      rev.revision = newRevision;
      rev.embedding_status = 'not_applicable';
      rev.updated_at = now;

      // Conditional delete: ONLY if QA row matches the review's promoted value
      if (rev.promoted_value) {
        const qaKey = `${rev.applywizz_id}:${rev.field_key}`;
        const existingQa = inMemoryQaBank.get(qaKey);
        if (existingQa && existingQa.value === rev.promoted_value) {
          inMemoryQaBank.delete(qaKey);
          deletedQaCount = 1;
        }
      }
    } else {
      throw new Error(`Unknown manager action: ${action}`);
    }

    inMemoryEvents.push({
      id: randomUUID(),
      reviewId: rev.id,
      eventType: 'manager_action',
      actor: actorEmail,
      actorRole: 'manager',
      action,
      fromStatus: 'pending_manager',
      toStatus: rev.status,
      fromRevision: prevRevision,
      toRevision: newRevision,
      payload: { action, editedValue, deletedQaCount },
      createdAt: now,
    });

    const result: ReviewActionResult = {
      success: true,
      review: { ...rev },
      deletedQaCount,
    };

    if (idempotencyKey) {
      inMemoryIdempotency.set(idempotencyKey, {
        key: idempotencyKey,
        reviewId: rev.id,
        actionType: 'manager_action',
        responsePayload: result,
        createdAt: now,
      });
    }

    return result;
  }

  // Live Supabase RPC call
  const supabase = getDbClient();
  const { data, error } = await supabase.rpc('process_manager_review_action', {
    p_review_id: reviewId,
    p_expected_revision: expectedRevision,
    p_action: action,
    p_actor_email: actorEmail,
    p_edited_value: editedValue ? editedValue.trim() : null,
    p_idempotency_key: idempotencyKey || null,
  });

  if (error) {
    throw new Error(`Manager action failed: ${error.message}`);
  }

  return data as ReviewActionResult;
}

// ---------------------------------------------------------------------------
// Decoupled Embeddings & Query Helpers
// ---------------------------------------------------------------------------

/**
 * Returns review items with pending embedding work.
 */
export async function getPendingEmbeddingReviews(
  limit: number = 50
): Promise<AiAnswerReviewRow[]> {
  if (isTestReviewStoreEnabled()) {
    return Array.from(inMemoryReviews.values())
      .filter((r) => r.embedding_status === 'pending')
      .slice(0, limit);
  }

  const supabase = getDbClient();
  const { data, error } = await supabase
    .from('gh_ai_answer_reviews')
    .select('*')
    .eq('embedding_status', 'pending')
    .limit(limit);

  if (error || !data) {
    return [];
  }
  return data as AiAnswerReviewRow[];
}

/**
 * Decoupled embedding generator/repair helper.
 * Generates embedding for approved/promoted QA answers and verifies review revision.
 */
export async function syncReviewEmbedding(
  reviewId: string,
  expectedRevision: number,
  embedder?: (label: string) => Promise<number[] | null>
): Promise<{ success: boolean; error?: string }> {
  let rev: AiAnswerReviewRow | null = null;

  if (isTestReviewStoreEnabled()) {
    rev = inMemoryReviews.get(reviewId) || null;
  } else {
    const supabase = getDbClient();
    const { data } = await supabase
      .from('gh_ai_answer_reviews')
      .select('*')
      .eq('id', reviewId)
      .maybeSingle();
    rev = data as AiAnswerReviewRow | null;
  }

  if (!rev) {
    return { success: false, error: 'Review item not found' };
  }

  if (rev.revision !== expectedRevision) {
    return { success: false, error: `Revision mismatch: expected ${expectedRevision}, got ${rev.revision}` };
  }

  const now = new Date().toISOString();

  try {
    let embeddingWritten = false;
    if (embedder) {
      const vec = await embedder(rev.question_label);
      embeddingWritten = Boolean(vec && vec.length > 0);
    } else {
      embeddingWritten = await writeEmbedding(rev.applywizz_id, rev.field_key, rev.question_label);
    }

    if (!embeddingWritten) {
      throw new Error('Embedding generation returned empty or failed');
    }

    if (isTestReviewStoreEnabled()) {
      rev.embedding_status = 'completed';
      rev.embedding_updated_at = now;
      rev.embedding_error = null;
    } else {
      const supabase = getDbClient();
      await supabase
        .from('gh_ai_answer_reviews')
        .update({
          embedding_status: 'completed',
          embedding_updated_at: now,
          embedding_error: null,
        })
        .eq('id', reviewId)
        .eq('revision', expectedRevision);
    }

    return { success: true };
  } catch (err: any) {
    const errMsg = err?.message || 'Embedding sync error';
    if (isTestReviewStoreEnabled()) {
      rev.embedding_status = 'failed';
      rev.embedding_error = errMsg;
      rev.embedding_updated_at = now;
    } else {
      const supabase = getDbClient();
      await supabase
        .from('gh_ai_answer_reviews')
        .update({
          embedding_status: 'failed',
          embedding_error: errMsg,
          embedding_updated_at: now,
        })
        .eq('id', reviewId);
    }
    return { success: false, error: errMsg };
  }
}

/**
 * Retrieves a review row by its primary key UUID.
 */
export async function getReviewById(id: string): Promise<AiAnswerReviewRow | null> {
  if (isTestReviewStoreEnabled()) {
    return inMemoryReviews.get(id) || null;
  }
  const supabase = getDbClient();
  const { data } = await supabase
    .from('gh_ai_answer_reviews')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  return (data as AiAnswerReviewRow) || null;
}

/**
 * Retrieves a review proposal by its immutable identity:
 * (application_id, resolution_revision, field_key).
 */
export async function findReviewByProposalIdentity(
  applicationId: string,
  resolutionRevision: number,
  fieldKey: string
): Promise<AiAnswerReviewRow | null> {
  if (isTestReviewStoreEnabled()) {
    return (
      Array.from(inMemoryReviews.values()).find(
        (r) =>
          r.application_id === applicationId &&
          r.resolution_revision === resolutionRevision &&
          r.field_key === fieldKey
      ) || null
    );
  }

  const supabase = getDbClient();
  const { data } = await supabase
    .from('gh_ai_answer_reviews')
    .select('*')
    .eq('application_id', applicationId)
    .eq('resolution_revision', resolutionRevision)
    .eq('field_key', fieldKey)
    .maybeSingle();

  return (data as AiAnswerReviewRow) || null;
}

// ---------------------------------------------------------------------------
// Promotion Reconciler
// ---------------------------------------------------------------------------

export interface ReconcilePromotionsOptions {
  applicationIds?: string[];
  limit?: number;
  embedder?: (label: string) => Promise<number[] | null>;
}

export interface ReconcilePromotionsResult {
  promotedCount: number;
  embeddedCount: number;
  errors: string[];
}

const SUBMITTED_STATUSES = new Set(['APPLIED', 'EMAIL_PROOF_PENDING', 'QUEUED', 'APPLYING']);

/**
 * Scans for submitted applications whose AI review proposals are not yet marked as promoted
 * (`promoted_at IS NULL`), and retries promoting them via `promoteSubmittedAiAnswers`.
 * Also triggers embedding repairs for pending embeddings (`getPendingEmbeddingReviews` + `syncReviewEmbedding`).
 */
export async function reconcileAiAnswerPromotions(
  options?: ReconcilePromotionsOptions
): Promise<ReconcilePromotionsResult> {
  let promotedCount = 0;
  let embeddedCount = 0;
  const errors: string[] = [];

  try {
    let submittedAppIds: string[] = [];

    if (isTestReviewStoreEnabled()) {
      const unpromoted = Array.from(inMemoryReviews.values()).filter(
        (r) => !r.promoted_at && ['pending_operator', 'pending_manager', 'approved'].includes(r.status)
      );

      const targetAppIds = new Set<string>();
      for (const r of unpromoted) {
        if (!r.application_id) continue;
        if (options?.applicationIds && !options.applicationIds.includes(r.application_id)) {
          continue;
        }
        if (inMemorySubmittedApps.has(r.application_id)) {
          targetAppIds.add(r.application_id);
          continue;
        }
        const memApp = memoryApplications.get(r.application_id);
        if (memApp && SUBMITTED_STATUSES.has(memApp.status)) {
          targetAppIds.add(r.application_id);
        }
      }
      submittedAppIds = Array.from(targetAppIds);
    } else {
      const supabase = getDbClient();
      let query = supabase
        .from('gh_ai_answer_reviews')
        .select('application_id')
        .is('promoted_at', null)
        .in('status', ['pending_operator', 'pending_manager', 'approved']);

      if (options?.applicationIds && options.applicationIds.length > 0) {
        query = query.in('application_id', options.applicationIds);
      }

      const { data: unpromotedRows, error: revErr } = await query;
      if (revErr) {
        errors.push(`Failed to query unpromoted reviews: ${revErr.message}`);
      } else {
        const candidateAppIds = Array.from(
          new Set((unpromotedRows || []).map((r) => r.application_id).filter(Boolean))
        );

        if (candidateAppIds.length > 0) {
          const { data: submittedApps, error: appErr } = await supabase
            .from('gh_candidate_applications')
            .select('id, status')
            .in('id', candidateAppIds)
            .in('status', Array.from(SUBMITTED_STATUSES));

          if (appErr) {
            errors.push(`Failed to query submitted applications: ${appErr.message}`);
          } else if (submittedApps) {
            submittedAppIds = submittedApps.map((a) => a.id);
          }
        }
      }
    }

    // Promote for each unpromoted submitted application
    for (const appId of submittedAppIds) {
      try {
        const res = await promoteSubmittedAiAnswers({
          applicationId: appId,
          actorEmail: 'reconciler',
        });
        promotedCount += res.promotedCount;
      } catch (err: any) {
        errors.push(`Failed to promote application ${appId}: ${err?.message || err}`);
      }
    }

    // Repair pending embeddings
    try {
      const pending = await getPendingEmbeddingReviews(options?.limit ?? 50);
      for (const rev of pending) {
        const res = await syncReviewEmbedding(rev.id, rev.revision, options?.embedder);
        if (res.success) {
          embeddedCount++;
        } else if (res.error) {
          errors.push(`Embedding sync failed for review ${rev.id}: ${res.error}`);
        }
      }
    } catch (embErr: any) {
      errors.push(`Pending embedding scan failed: ${embErr?.message || embErr}`);
    }
  } catch (err: any) {
    errors.push(`reconcileAiAnswerPromotions unexpected error: ${err?.message || err}`);
  }

  return { promotedCount, embeddedCount, errors };
}

// ---------------------------------------------------------------------------
// Review Scoping and Listing Queries
// ---------------------------------------------------------------------------

/**
 * Checks whether an operator is assigned to the review's candidate or application.
 * Admin and dev roles are automatically permitted.
 */
export async function isOperatorAllowedForReview(
  operatorEmail: string,
  review: AiAnswerReviewRow,
  role?: string
): Promise<boolean> {
  if (role === 'dev' || role === 'admin') return true;
  const op = operatorEmail.trim().toLowerCase();
  if (!op) return false;

  if (isTestReviewStoreEnabled()) {
    const assignment = inMemoryOperatorAssignments.get(op);
    if (assignment) {
      if (
        review.applywizz_id &&
        assignment.candidateIds.has(review.applywizz_id.trim().toUpperCase())
      ) {
        return true;
      }
      if (
        review.application_id &&
        assignment.applicationIds.has(review.application_id.trim())
      ) {
        return true;
      }
    }
    const memApp = memoryApplications.get(review.application_id);
    if (memApp) {
      const assigned = (
        (memApp as any).assigned_ca_email ||
        (memApp as any).assignedCaEmail ||
        ''
      )
        .trim()
        .toLowerCase();
      if (assigned === op) return true;
    }
    if (
      review.operator_email &&
      review.operator_email.trim().toLowerCase() === op
    ) {
      return true;
    }
    return false;
  }

  // Supabase live check
  const supabase = getDbClient();
  const { data: appData } = await supabase
    .from('gh_candidate_applications')
    .select('id')
    .eq('id', review.application_id)
    .ilike('assigned_ca_email', op)
    .maybeSingle();

  if (appData) return true;

  const { data: profileData } = await supabase
    .from('profiles')
    .select('applywizz_id')
    .eq('applywizz_id', review.applywizz_id)
    .ilike('ca_email', op)
    .maybeSingle();

  if (profileData) return true;

  return false;
}

/**
 * Checks whether a manager's team is assigned to the review's candidate or application.
 * Admin and dev roles are automatically permitted.
 */
export async function isManagerAllowedForReview(
  managerEmail: string,
  review: AiAnswerReviewRow,
  role?: string
): Promise<boolean> {
  if (role === 'dev' || role === 'admin') return true;
  const mgr = managerEmail.trim().toLowerCase();
  if (!mgr) return false;

  if (isTestReviewStoreEnabled()) {
    const teamOps = inMemoryManagerTeams.get(mgr);
    if (!teamOps || teamOps.size === 0) return false;
    for (const opEmail of teamOps) {
      if (await isOperatorAllowedForReview(opEmail, review)) {
        return true;
      }
    }
    return false;
  }

  // Supabase live check
  const teamEmails = await listOperatorEmailsForManager(mgr);
  if (teamEmails.length === 0) return false;

  const supabase = getDbClient();
  const { data: appData } = await supabase
    .from('gh_candidate_applications')
    .select('id')
    .eq('id', review.application_id)
    .in('assigned_ca_email', teamEmails)
    .maybeSingle();

  if (appData) return true;

  const { data: profileData } = await supabase
    .from('profiles')
    .select('applywizz_id')
    .eq('applywizz_id', review.applywizz_id)
    .in('ca_email', teamEmails)
    .maybeSingle();

  if (profileData) return true;

  return false;
}

/**
 * Lists pending_operator review items scoped to an operator (or all for dev/admin).
 */
export async function listOperatorReviews(options: {
  operatorEmail: string;
  role: 'dev' | 'admin' | 'manager' | 'operator';
  limit?: number;
}): Promise<AiAnswerReviewRow[]> {
  const { operatorEmail, role, limit = 100 } = options;

  if (isTestReviewStoreEnabled()) {
    const allPending = Array.from(inMemoryReviews.values()).filter(
      (r) => r.status === 'pending_operator'
    );
    const results: AiAnswerReviewRow[] = [];
    for (const rev of allPending) {
      if (role === 'dev' || role === 'admin') {
        results.push(rev);
      } else if (await isOperatorAllowedForReview(operatorEmail, rev, role)) {
        results.push(rev);
      }
    }
    return results
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  const supabase = getDbClient();
  if (role === 'dev' || role === 'admin') {
    const { data } = await supabase
      .from('gh_ai_answer_reviews')
      .select('*')
      .eq('status', 'pending_operator')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data as AiAnswerReviewRow[]) || [];
  }

  const op = operatorEmail.trim().toLowerCase();
  const { data: profRows } = await supabase
    .from('profiles')
    .select('applywizz_id')
    .ilike('ca_email', op);
  const candidateIds = (profRows || []).map((p) => p.applywizz_id);

  const { data: appRows } = await supabase
    .from('gh_candidate_applications')
    .select('id')
    .ilike('assigned_ca_email', op);
  const appIds = (appRows || []).map((a) => a.id);

  if (candidateIds.length === 0 && appIds.length === 0) {
    return [];
  }

  let query = supabase
    .from('gh_ai_answer_reviews')
    .select('*')
    .eq('status', 'pending_operator')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (candidateIds.length > 0 && appIds.length > 0) {
    query = query.or(
      `applywizz_id.in.(${candidateIds.join(',')}),application_id.in.(${appIds.join(',')})`
    );
  } else if (candidateIds.length > 0) {
    query = query.in('applywizz_id', candidateIds);
  } else {
    query = query.in('application_id', appIds);
  }

  const { data, error } = await query;
  if (error || !data) return [];
  return data as AiAnswerReviewRow[];
}

/**
 * Lists pending_manager review items scoped to a manager's team (or all for dev/admin).
 */
export async function listManagerReviews(options: {
  managerEmail: string;
  role: 'dev' | 'admin' | 'manager' | 'operator';
  limit?: number;
}): Promise<AiAnswerReviewRow[]> {
  const { managerEmail, role, limit = 100 } = options;

  if (isTestReviewStoreEnabled()) {
    const allPending = Array.from(inMemoryReviews.values()).filter(
      (r) => r.status === 'pending_manager'
    );
    const results: AiAnswerReviewRow[] = [];
    for (const rev of allPending) {
      if (role === 'dev' || role === 'admin') {
        results.push(rev);
      } else if (await isManagerAllowedForReview(managerEmail, rev, role)) {
        results.push(rev);
      }
    }
    return results
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  const supabase = getDbClient();
  if (role === 'dev' || role === 'admin') {
    const { data } = await supabase
      .from('gh_ai_answer_reviews')
      .select('*')
      .eq('status', 'pending_manager')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data as AiAnswerReviewRow[]) || [];
  }

  const teamEmails = await listOperatorEmailsForManager(managerEmail);
  if (teamEmails.length === 0) return [];

  const { data: profRows } = await supabase
    .from('profiles')
    .select('applywizz_id')
    .in('ca_email', teamEmails);
  const candidateIds = (profRows || []).map((p) => p.applywizz_id);

  const { data: appRows } = await supabase
    .from('gh_candidate_applications')
    .select('id')
    .in('assigned_ca_email', teamEmails);
  const appIds = (appRows || []).map((a) => a.id);

  if (candidateIds.length === 0 && appIds.length === 0) {
    return [];
  }

  let query = supabase
    .from('gh_ai_answer_reviews')
    .select('*')
    .eq('status', 'pending_manager')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (candidateIds.length > 0 && appIds.length > 0) {
    query = query.or(
      `applywizz_id.in.(${candidateIds.join(',')}),application_id.in.(${appIds.join(',')})`
    );
  } else if (candidateIds.length > 0) {
    query = query.in('applywizz_id', candidateIds);
  } else {
    query = query.in('application_id', appIds);
  }

  const { data, error } = await query;
  if (error || !data) return [];
  return data as AiAnswerReviewRow[];
}
