/**
 * @fileoverview End-to-End Integration Test for AI Auto-Queue and Two-Level Review Architecture (Task 7).
 *
 * Verifies the complete end-to-end integration lifecycle across 10 core capability areas:
 * 1. Auto-queueing: Resolution marks application eligible for auto-queue (READY_FOR_REVIEW / QUEUED)
 *    without being blocked by AI fields or field count.
 * 2. Review capture: `recordAiReviewProposals` stores immutable proposals keyed by
 *    `(application_id, resolution_revision, field_key)` with full Tier 5 lineage.
 * 3. Operator submission promotion: Operator submits application -> active AI fields are promoted
 *    to `gh_candidate_qa_bank` with authoritative status and audit events logged.
 * 4. Non-blocking error isolation: Promotion failures never block or reverse application submission.
 * 5. Promotion recovery: `reconcileAiAnswerPromotions()` detects unpromoted submitted proposals,
 *    promotes them, and repairs pending embeddings.
 * 6. Operator review action: Operator edits or denies an item -> status advances to `pending_manager`
 *    with updated revision.
 * 7. Manager replacement / approval: Manager confirms or provides edited replacement -> updates QA bank.
 * 8. Operator denial guard: Manager cannot directly approve an operator-denied proposal without replacement.
 * 9. Conditional manager rejection: Manager rejects an item -> removes QA row ONLY if it still matches
 *    the promoted value; leaves modified or pre-existing QA rows intact.
 * 10. Concurrency & Replay: Rejects stale revisions (409) and returns cached receipts for replayed
 *     idempotency keys.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setTestReviewStoreEnabled,
  resetTestReviewStore,
  recordAiReviewProposals,
  promoteSubmittedAiAnswers,
  reconcileAiAnswerPromotions,
  operatorReviewAction,
  managerReviewAction,
  getReviewById,
  findReviewByProposalIdentity,
  getInMemoryQaRow,
  setInMemoryQaRow,
  getInMemoryEvents,
  markTestApplicationSubmitted,
  getPendingEmbeddingReviews,
  syncReviewEmbedding,
  type AiReviewProposalItem,
  type AiAnswerReviewRow,
} from '../src/db/aiAnswerReviews.js';
import {
  applicationNeedsOperatorReview,
  applicationShouldBeFilteredOut,
} from '../src/resolver/needsReview.js';
import { isOverQuestionCap } from '../src/db/skippedApplications.js';
import {
  persistApprovedAiAnswersToQaBank,
  persistManualFieldEditsToQaBank,
} from '../src/db/qaBankPersistence.js';
import { generateFingerprint } from '../src/resolver/fingerprint.js';
import { memoryApplications } from '../src/db/applications/memoryStore.js';
import type { ResolvedField } from '../src/types/index.js';

describe('AI Auto-Queue & Two-Level Review End-to-End Integration Suite (Task 7)', () => {
  const candidateId = 'AWL-E2E-CANDIDATE-007';
  const candidateName = 'Alex River';
  const appId1 = '11111111-7777-1111-1111-111111111111';
  const appId2 = '22222222-7777-2222-2222-222222222222';
  const appId3 = '33333333-7777-3333-3333-333333333333';

  const mockEmbedder = async (_label: string) => [0.01, 0.02, 0.03];

  beforeEach(() => {
    setTestReviewStoreEnabled(true);
    resetTestReviewStore();
    memoryApplications.clear();
  });

  describe('1. Auto-queueing & execution routing', () => {
    it('allows applications with required AI-resolved fields to auto-queue when required fields are satisfied', () => {
      const fields: ResolvedField[] = [
        {
          fieldId: 'f1',
          name: 'first_name',
          type: 'text',
          label: 'First Name',
          value: 'Alex',
          source: 'supabase',
          isRequired: true,
        },
        {
          fieldId: 'f2',
          name: 'work_auth',
          type: 'select',
          label: 'Are you legally authorized to work in the United States?',
          value: 'Yes',
          source: 'ai',
          resolvedByTier: 5,
          confidence: 0.95,
          isRequired: true,
        },
        {
          fieldId: 'f3',
          name: 'experience_years',
          type: 'text',
          label: 'Years of React experience?',
          value: '5 years',
          source: 'ai',
          resolvedByTier: 5,
          confidence: 0.88,
          isRequired: true,
        },
        {
          fieldId: 'f4',
          name: 'salary_expectation',
          type: 'text',
          label: 'Target base compensation?',
          value: '$165,000',
          source: 'ai',
          resolvedByTier: 5,
          confidence: 0.82,
          isRequired: false,
        },
      ];

      // Does not need operator review because all required fields are satisfied (even if by AI)
      const needsReview = applicationNeedsOperatorReview(fields);
      assert.equal(needsReview, false, 'Should auto-queue without operator review bottleneck');

      // Does not get filtered out because required fields are resolved
      const shouldFilter = applicationShouldBeFilteredOut(fields);
      assert.equal(shouldFilter, false, 'Should not be filtered out for AI-resolved fields');
    });

    it('does not filter out applications having >3 required fields resolved by AI', () => {
      const aiResolvedFields: ResolvedField[] = [
        { fieldId: 'q1', name: 'q1', type: 'text', label: 'Q1', value: 'Ans 1', source: 'ai', isRequired: true },
        { fieldId: 'q2', name: 'q2', type: 'text', label: 'Q2', value: 'Ans 2', source: 'ai', isRequired: true },
        { fieldId: 'q3', name: 'q3', type: 'text', label: 'Q3', value: 'Ans 3', source: 'ai', isRequired: true },
        { fieldId: 'q4', name: 'q4', type: 'text', label: 'Q4', value: 'Ans 4', source: 'ai', isRequired: true },
        { fieldId: 'q5', name: 'q5', type: 'text', label: 'Q5', value: 'Ans 5', source: 'ai', isRequired: true },
      ];

      assert.equal(applicationShouldBeFilteredOut(aiResolvedFields), false);
    });

    it('never skips applications based on question count alone (MAX_JOB_QUESTIONS retired)', () => {
      assert.equal(isOverQuestionCap(50), false);
      assert.equal(isOverQuestionCap(150), false);
      assert.equal(isOverQuestionCap(500), false);
    });

    it('strictly preserves unresolved required fields and negative compensation execution guards', () => {
      // Unresolved required field triggers operator review
      assert.equal(
        applicationNeedsOperatorReview([
          { fieldId: 'q1', name: 'q1', type: 'text', label: 'Auth', source: 'unresolved', isRequired: true },
        ]),
        true
      );

      // Negative compensation answer triggers operator review
      assert.equal(
        applicationNeedsOperatorReview([
          { fieldId: 'q1', name: 'q1', type: 'text', label: 'Salary', value: 'No', source: 'supabase', isRequired: false },
        ]),
        true
      );
    });
  });

  describe('2. Review capture & immutable proposal identity', () => {
    it('captures immutable review proposals keyed by (application_id, resolution_revision, field_key) with Tier 5 lineage', async () => {
      const fp1 = generateFingerprint('Work Authorization', 'select');
      const fp2 = generateFingerprint('Prior Experience', 'text');

      const proposals: AiReviewProposalItem[] = [
        {
          fieldKey: fp1,
          questionLabel: 'Work Authorization',
          fieldType: 'select',
          options: ['Yes', 'No'],
          aiValue: 'Yes',
          aiConfidence: 0.96,
          aiModel: 'claude-3-5-haiku-20241022',
          tier5Provenance: {
            fieldKey: fp1,
            winningModel: 'claude-3-5-haiku-20241022',
            attempts: [
              { model: 'claude-3-5-haiku-20241022', rawAnswer: 'Yes', confidence: 0.96 },
            ],
          },
        },
        {
          fieldKey: fp2,
          questionLabel: 'Prior Experience',
          fieldType: 'text',
          aiValue: '4 years backend Node.js',
          aiConfidence: 0.72,
          aiModel: 'deepseek/deepseek-r1-0528',
          tier5Provenance: {
            fieldKey: fp2,
            winningModel: 'deepseek/deepseek-r1-0528',
            attempts: [
              { model: 'claude-3-5-haiku-20241022', rawAnswer: '4 years', confidence: 0.74 },
              { model: 'deepseek/deepseek-r1-0528', rawAnswer: '4 years backend Node.js', confidence: 0.72 },
            ],
          },
        },
      ];

      const recorded = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals,
      });

      assert.equal(recorded.length, 2);

      const rev1 = await findReviewByProposalIdentity(appId1, 1, fp1);
      assert.ok(rev1, 'Review proposal 1 should be findable by identity');
      assert.equal(rev1?.ai_value, 'Yes');
      assert.equal(rev1?.status, 'pending_operator');
      assert.equal(rev1?.revision, 1);
      assert.equal(rev1?.ai_model, 'claude-3-5-haiku-20241022');
      assert.equal(rev1?.ai_provenance?.attempts?.length, 1);

      const rev2 = await findReviewByProposalIdentity(appId1, 1, fp2);
      assert.ok(rev2, 'Review proposal 2 should be findable by identity');
      assert.equal(rev2?.ai_value, '4 years backend Node.js');
      assert.equal(rev2?.ai_model, 'deepseek/deepseek-r1-0528');
      assert.equal(rev2?.ai_provenance?.attempts?.length, 2);

      // Re-recording same application and revision is strictly idempotent and does not overwrite
      const duplicateRecord = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals: [
          {
            fieldKey: fp1,
            questionLabel: 'Work Authorization',
            fieldType: 'select',
            aiValue: 'OVERWRITE_ATTEMPT',
            aiModel: 'attacker-model',
          },
        ],
      });
      assert.equal(duplicateRecord.length, 1);
      assert.equal(duplicateRecord[0].ai_value, 'Yes', 'Must retain immutable original proposal value');

      // Recording for revision 2 creates a new distinct proposal record
      const rev2Recorded = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 2,
        applywizzId: candidateId,
        candidateName,
        proposals: [
          {
            fieldKey: fp1,
            questionLabel: 'Work Authorization',
            fieldType: 'select',
            aiValue: 'Yes, Authorized',
            aiModel: 'claude-3-5-haiku-20241022',
          },
        ],
      });
      assert.equal(rev2Recorded.length, 1);
      assert.equal(rev2Recorded[0].resolution_revision, 2);
      assert.equal(rev2Recorded[0].ai_value, 'Yes, Authorized');
    });
  });

  describe('3. Operator submission promotion & QA bank learning', () => {
    it('promotes all AI fields to QA bank with authoritative status and logs audit events', async () => {
      const fp = generateFingerprint('Favorite Programming Language', 'text');
      const proposals: AiReviewProposalItem[] = [
        {
          fieldKey: fp,
          questionLabel: 'Favorite Programming Language',
          fieldType: 'text',
          aiValue: 'TypeScript',
          aiConfidence: 0.99,
          aiModel: 'claude-3-5-haiku-20241022',
        },
      ];

      await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals,
      });

      // Before promotion: QA bank is empty
      assert.equal(getInMemoryQaRow(candidateId, fp), null);

      // Operator submits application
      const promoResult = await promoteSubmittedAiAnswers({
        applicationId: appId1,
        actor: 'operator@applywizz.ai',
      });

      assert.equal(promoResult.promotedCount, 1);
      assert.equal(promoResult.reviews[0].status, 'pending_operator');
      assert.ok(promoResult.reviews[0].promoted_at);
      assert.equal(promoResult.reviews[0].promoted_value, 'TypeScript');

      // QA bank now contains promoted answer with authoritative source 'manual' and confidence 1.0
      const qaRow = getInMemoryQaRow(candidateId, fp);
      assert.ok(qaRow, 'QA row must exist');
      assert.equal(qaRow?.value, 'TypeScript');
      assert.equal(qaRow?.source, 'manual');
      assert.equal(qaRow?.confidence, 1.0);

      // Audit event emitted
      const events = getInMemoryEvents(promoResult.reviews[0].id);
      const promoEvent = events.find((e) => e.eventType === 'promoted_submission');
      assert.ok(promoEvent, 'promoted_submission audit event must be logged');
      assert.equal(promoEvent?.actor, 'operator@applywizz.ai');

      // Duplicate submission promotion is strictly idempotent
      const repeatPromo = await promoteSubmittedAiAnswers({
        applicationId: appId1,
        actor: 'operator@applywizz.ai',
      });
      assert.equal(repeatPromo.promotedCount, 1);
      assert.equal(getInMemoryQaRow(candidateId, fp)?.value, 'TypeScript');
    });
  });

  describe('4. Non-blocking error isolation during submission', () => {
    it('ensures promotion errors never block or throw during application submission', async () => {
      const fields: ResolvedField[] = [
        {
          fieldId: 'f1',
          name: 'q1',
          type: 'text',
          label: 'Hobbies',
          value: 'Reading',
          source: 'ai',
          resolvedByTier: 5,
        },
      ];

      // Should complete cleanly without uncaught exceptions
      await assert.doesNotReject(async () => {
        await persistApprovedAiAnswersToQaBank(
          candidateId,
          fields,
          'non-existent-app-id',
          'operator@applywizz.ai'
        );
      });
    });
  });

  describe('5. Promotion reconciler & embedding recovery', () => {
    it('detects unpromoted submitted applications, promotes AI answers, and repairs pending embeddings', async () => {
      const fp = generateFingerprint('Remote work preference', 'select');
      const proposals: AiReviewProposalItem[] = [
        {
          fieldKey: fp,
          questionLabel: 'Remote work preference',
          fieldType: 'select',
          options: ['Remote', 'Hybrid', 'Onsite'],
          aiValue: 'Remote',
          aiConfidence: 0.94,
          aiModel: 'claude-3-5-haiku-20241022',
        },
      ];

      const [recorded] = await recordAiReviewProposals({
        applicationId: appId2,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals,
      });

      // Mark application submitted without calling promoteSubmittedAiAnswers (simulating transient network error during submission)
      markTestApplicationSubmitted(appId2);
      assert.equal(getInMemoryQaRow(candidateId, fp), null, 'QA row not yet written');

      // Run reconciler with mock embedder
      const reconResult = await reconcileAiAnswerPromotions({
        limit: 10,
        embedder: mockEmbedder,
      });
      assert.ok(reconResult.promotedCount >= 1, 'Should promote unpromoted submitted proposal');
      assert.ok(reconResult.embeddedCount >= 1, 'Should repair pending embedding');
      assert.equal(reconResult.errors.length, 0);

      // QA row is now promoted and active
      const qaRow = getInMemoryQaRow(candidateId, fp);
      assert.ok(qaRow, 'QA row must now be present in QA bank');
      assert.equal(qaRow?.value, 'Remote');

      // Review embedding status should be completed
      const updatedRev = await getReviewById(recorded.id);
      assert.equal(updatedRev?.embedding_status, 'completed');
    });
  });

  describe('6. Operator review action', () => {
    it('advances review status to pending_manager when operator edits or denies', async () => {
      const fpEdit = generateFingerprint('Willingness to Relocate', 'select');
      const fpDeny = generateFingerprint('Unwanted AI Proposal', 'text');

      const proposals: AiReviewProposalItem[] = [
        {
          fieldKey: fpEdit,
          questionLabel: 'Willingness to Relocate',
          fieldType: 'select',
          options: ['Yes', 'No'],
          aiValue: 'No',
          aiConfidence: 0.82,
          aiModel: 'claude-3-5-haiku-20241022',
        },
        {
          fieldKey: fpDeny,
          questionLabel: 'Unwanted AI Proposal',
          fieldType: 'text',
          aiValue: 'Hallucinated text',
          aiConfidence: 0.66,
          aiModel: 'deepseek/deepseek-r1-0528',
        },
      ];

      const [revEdit, revDeny] = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals,
      });

      // Operator edits the first item
      const editResult = await operatorReviewAction({
        reviewId: revEdit.id,
        expectedRevision: revEdit.revision,
        action: 'edit',
        editedValue: 'Yes',
        actorEmail: 'operator@applywizz.ai',
      });
      assert.equal(editResult.success, true);
      assert.equal(editResult.review.status, 'pending_manager');
      assert.equal(editResult.review.operator_action, 'edited');
      assert.equal(editResult.review.operator_value, 'Yes');
      assert.equal(editResult.review.revision, 2);

      // Operator denies the second item
      const denyResult = await operatorReviewAction({
        reviewId: revDeny.id,
        expectedRevision: revDeny.revision,
        action: 'deny',
        actorEmail: 'operator@applywizz.ai',
      });
      assert.equal(denyResult.success, true);
      assert.equal(denyResult.review.status, 'pending_manager');
      assert.equal(denyResult.review.operator_action, 'denied');
      assert.equal(denyResult.review.operator_value, null);
      assert.equal(denyResult.review.revision, 2);
    });
  });

  describe('7. Manager replacement / approval & QA bank write', () => {
    it('allows manager to confirm or replace answer in QA bank upon approval', async () => {
      const fp1 = generateFingerprint('Degree Type', 'select');
      const fp2 = generateFingerprint('Graduation Year', 'text');

      const [rev1, rev2] = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals: [
          {
            fieldKey: fp1,
            questionLabel: 'Degree Type',
            fieldType: 'select',
            options: ['Bachelors', 'Masters', 'PhD'],
            aiValue: 'Masters',
            aiModel: 'claude-3-5-haiku-20241022',
          },
          {
            fieldKey: fp2,
            questionLabel: 'Graduation Year',
            fieldType: 'text',
            aiValue: '2023',
            aiModel: 'claude-3-5-haiku-20241022',
          },
        ],
      });

      // Operator approves rev1 and forwards to manager
      const op1 = await operatorReviewAction({
        reviewId: rev1.id,
        expectedRevision: rev1.revision,
        action: 'approve',
        actorEmail: 'operator@applywizz.ai',
      });

      // Manager confirms (approves) rev1 -> updates QA bank with approved value
      const mgrApprove = await managerReviewAction({
        reviewId: op1.review.id,
        expectedRevision: op1.review.revision,
        action: 'approve',
        actorEmail: 'manager@applywizz.ai',
      });
      assert.equal(mgrApprove.success, true);
      assert.equal(mgrApprove.review.status, 'approved');
      assert.equal(mgrApprove.review.manager_action, 'approved');
      assert.equal(mgrApprove.review.manager_value, 'Masters');
      assert.equal(getInMemoryQaRow(candidateId, fp1)?.value, 'Masters');

      // Operator forwards rev2
      const op2 = await operatorReviewAction({
        reviewId: rev2.id,
        expectedRevision: rev2.revision,
        action: 'approve',
        actorEmail: 'operator@applywizz.ai',
      });

      // Manager edits rev2 with replacement value -> updates QA bank with replacement value
      const mgrEdit = await managerReviewAction({
        reviewId: op2.review.id,
        expectedRevision: op2.review.revision,
        action: 'edit',
        editedValue: '2024',
        actorEmail: 'manager@applywizz.ai',
      });
      assert.equal(mgrEdit.success, true);
      assert.equal(mgrEdit.review.status, 'approved');
      assert.equal(mgrEdit.review.manager_action, 'edited');
      assert.equal(mgrEdit.review.manager_value, '2024');
      assert.equal(getInMemoryQaRow(candidateId, fp2)?.value, '2024');
    });
  });

  describe('8. Operator denial guard', () => {
    it('blocks manager from directly approving an operator-denied proposal without replacement', async () => {
      const fp = generateFingerprint('Question Denied By Operator', 'text');
      const [proposal] = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals: [
          {
            fieldKey: fp,
            questionLabel: 'Question Denied By Operator',
            fieldType: 'text',
            aiValue: 'Flawed AI answer',
            aiModel: 'claude-3-5-haiku-20241022',
          },
        ],
      });

      // Operator denies item
      const opDeny = await operatorReviewAction({
        reviewId: proposal.id,
        expectedRevision: proposal.revision,
        action: 'deny',
        actorEmail: 'operator@applywizz.ai',
      });
      assert.equal(opDeny.review.status, 'pending_manager');
      assert.equal(opDeny.review.operator_action, 'denied');

      // Manager directly approving without editedValue must fail
      await assert.rejects(
        async () => {
          await managerReviewAction({
            reviewId: opDeny.review.id,
            expectedRevision: opDeny.review.revision,
            action: 'approve',
            actorEmail: 'manager@applywizz.ai',
          });
        },
        {
          message: /cannot approve an operator-denied proposal without providing an edited replacement/i,
        }
      );

      // Manager CAN provide an edited replacement
      const mgrReplacement = await managerReviewAction({
        reviewId: opDeny.review.id,
        expectedRevision: opDeny.review.revision,
        action: 'edit',
        editedValue: 'Manager Validated Answer',
        actorEmail: 'manager@applywizz.ai',
      });
      assert.equal(mgrReplacement.success, true);
      assert.equal(mgrReplacement.review.status, 'approved');
      assert.equal(mgrReplacement.review.manager_value, 'Manager Validated Answer');
      assert.equal(getInMemoryQaRow(candidateId, fp)?.value, 'Manager Validated Answer');
    });
  });

  describe('9. Conditional manager rejection & QA deletion safety', () => {
    it('removes matching QA row when manager rejects, but preserves modified or pre-existing QA rows', async () => {
      const fpMatching = generateFingerprint('Question For Removal', 'text');
      const fpModified = generateFingerprint('Question Modified Later', 'text');

      const [revMatching, revModified] = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals: [
          {
            fieldKey: fpMatching,
            questionLabel: 'Question For Removal',
            fieldType: 'text',
            aiValue: 'Answer to be rejected',
            aiModel: 'claude-3-5-haiku-20241022',
          },
          {
            fieldKey: fpModified,
            questionLabel: 'Question Modified Later',
            fieldType: 'text',
            aiValue: 'Original Answer',
            aiModel: 'claude-3-5-haiku-20241022',
          },
        ],
      });

      // Operator submits application -> both answers promoted to QA bank
      await promoteSubmittedAiAnswers({
        applicationId: appId1,
        actor: 'operator@applywizz.ai',
      });

      assert.equal(getInMemoryQaRow(candidateId, fpMatching)?.value, 'Answer to be rejected');
      assert.equal(getInMemoryQaRow(candidateId, fpModified)?.value, 'Original Answer');

      // Someone later modifies fpModified in QA bank to a newer answer
      setInMemoryQaRow({
        applywizz_id: candidateId,
        question_fingerprint: fpModified,
        question_label: 'Question Modified Later',
        field_type: 'text',
        value: 'Newer Authoritative Answer',
        source: 'manual',
        confidence: 1.0,
      });

      // 1. Manager rejects revMatching (unchanged) -> QA row must be removed
      const currentRevMatching = (await getReviewById(revMatching.id))!;
      const op1 = await operatorReviewAction({
        reviewId: currentRevMatching.id,
        expectedRevision: currentRevMatching.revision,
        action: 'deny',
        actorEmail: 'operator@applywizz.ai',
      });

      const mgrRej1 = await managerReviewAction({
        reviewId: op1.review.id,
        expectedRevision: op1.review.revision,
        action: 'reject',
        actorEmail: 'manager@applywizz.ai',
      });
      assert.equal(mgrRej1.success, true);
      assert.equal(mgrRej1.review.status, 'rejected');

      assert.equal(
        getInMemoryQaRow(candidateId, fpMatching),
        null,
        'QA row matching rejected proposal value must be deleted'
      );

      // 2. Manager rejects revModified (value was changed in QA bank) -> QA row must be preserved!
      const currentRevModified = (await getReviewById(revModified.id))!;
      const op2 = await operatorReviewAction({
        reviewId: currentRevModified.id,
        expectedRevision: currentRevModified.revision,
        action: 'deny',
        actorEmail: 'operator@applywizz.ai',
      });

      const mgrRej2 = await managerReviewAction({
        reviewId: op2.review.id,
        expectedRevision: op2.review.revision,
        action: 'reject',
        actorEmail: 'manager@applywizz.ai',
      });
      assert.equal(mgrRej2.success, true);
      assert.equal(mgrRej2.review.status, 'rejected');

      assert.equal(
        getInMemoryQaRow(candidateId, fpModified)?.value,
        'Newer Authoritative Answer',
        'Modified QA row must NOT be deleted upon manager rejection'
      );
    });
  });

  describe('10. Concurrency & Replay Safety', () => {
    it('rejects stale revisions with 409 Conflict', async () => {
      const fp = generateFingerprint('Concurrency Test Question', 'text');
      const [proposal] = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals: [
          {
            fieldKey: fp,
            questionLabel: 'Concurrency Test Question',
            fieldType: 'text',
            aiValue: 'Initial Value',
            aiModel: 'claude-3-5-haiku-20241022',
          },
        ],
      });

      // Submit operator action with mismatched revision
      await assert.rejects(
        async () => {
          await operatorReviewAction({
            reviewId: proposal.id,
            expectedRevision: 999, // Stale revision
            action: 'approve',
            actorEmail: 'operator@applywizz.ai',
          });
        },
        {
          message: /stale revision/i,
        }
      );
    });

    it('returns cached receipt on replayed idempotency key without duplicate mutation', async () => {
      const fp = generateFingerprint('Replay Test Question', 'text');
      const [proposal] = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals: [
          {
            fieldKey: fp,
            questionLabel: 'Replay Test Question',
            fieldType: 'text',
            aiValue: 'Replay Value',
            aiModel: 'claude-3-5-haiku-20241022',
          },
        ],
      });

      const idempotencyKey = 'replay-token-unique-uuid-12345';

      // First action
      const firstResult = await operatorReviewAction({
        reviewId: proposal.id,
        expectedRevision: proposal.revision,
        action: 'approve',
        actorEmail: 'operator@applywizz.ai',
        idempotencyKey,
      });

      // Replayed action with same idempotency key
      const replayedResult = await operatorReviewAction({
        reviewId: proposal.id,
        expectedRevision: proposal.revision,
        action: 'approve',
        actorEmail: 'operator@applywizz.ai',
        idempotencyKey,
      });

      assert.equal(firstResult.review.id, replayedResult.review.id);
      assert.equal(firstResult.review.revision, replayedResult.review.revision);
      assert.equal(replayedResult.review.status, 'pending_manager');
    });
  });

  describe('11. Complete End-to-End Golden Path Lifecycle Simulation', () => {
    it('executes resolution -> proposal capture -> submission promotion -> operator edit -> manager confirmation in sequence', async () => {
      const fp = generateFingerprint('Notice Period', 'select');

      // 1. Resolution produces AI answer and verifies auto-queue routing
      const resolvedFields: ResolvedField[] = [
        {
          fieldId: 'notice_q',
          name: 'notice_period',
          type: 'select',
          label: 'Notice Period',
          value: '2 weeks',
          source: 'ai',
          resolvedByTier: 5,
          confidence: 0.91,
          isRequired: true,
        },
      ];
      assert.equal(applicationNeedsOperatorReview(resolvedFields), false);
      assert.equal(applicationShouldBeFilteredOut(resolvedFields), false);

      // 2. Proposal is captured with revision 1
      const [proposal] = await recordAiReviewProposals({
        applicationId: appId3,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName,
        proposals: [
          {
            fieldKey: fp,
            questionLabel: 'Notice Period',
            fieldType: 'select',
            options: ['Immediately', '2 weeks', '1 month'],
            aiValue: '2 weeks',
            aiConfidence: 0.91,
            aiModel: 'claude-3-5-haiku-20241022',
          },
        ],
      });
      assert.equal(proposal.status, 'pending_operator');
      assert.equal(proposal.revision, 1);

      // 3. Application submitted by operator -> promoted to QA bank
      const promoResult = await promoteSubmittedAiAnswers({
        applicationId: appId3,
        actor: 'operator@applywizz.ai',
      });
      assert.equal(promoResult.promotedCount, 1);
      assert.equal(getInMemoryQaRow(candidateId, fp)?.value, '2 weeks');

      // 4. Operator reviews item in Review tab and clarifies to 'Immediately'
      const updatedRev = (await getReviewById(proposal.id))!;
      const opAction = await operatorReviewAction({
        reviewId: updatedRev.id,
        expectedRevision: updatedRev.revision,
        action: 'edit',
        editedValue: 'Immediately',
        actorEmail: 'operator@applywizz.ai',
      });
      assert.equal(opAction.review.status, 'pending_manager');
      assert.equal(opAction.review.operator_value, 'Immediately');
      assert.equal(opAction.review.revision, 2);

      // 5. Manager reviews in Manager Review tab and confirms operator's edit
      const mgrAction = await managerReviewAction({
        reviewId: opAction.review.id,
        expectedRevision: opAction.review.revision,
        action: 'approve',
        actorEmail: 'manager@applywizz.ai',
      });
      assert.equal(mgrAction.review.status, 'approved');
      assert.equal(mgrAction.review.manager_action, 'approved');
      assert.equal(mgrAction.review.revision, 3);

      // 6. QA bank is updated with the manager-confirmed value
      const finalQaRow = getInMemoryQaRow(candidateId, fp);
      assert.ok(finalQaRow);
      assert.equal(finalQaRow?.value, 'Immediately');
      assert.equal(finalQaRow?.source, 'manual');
      assert.equal(finalQaRow?.confidence, 1.0);
    });
  });
});
