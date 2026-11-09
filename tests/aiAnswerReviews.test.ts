/**
 * @fileoverview Unit and data-layer tests for AI auto-queue and two-level review service.
 * Tests:
 * 1. Immutable proposal identity (application_id + resolution_revision + field_key)
 * 2. Idempotent submission promotion
 * 3. Operator actions (approve, edit, deny) always advance to manager review
 * 4. Operator denial prevents manager from approving original AI answer (manager can reject or provide edited replacement)
 * 5. Manager approval/edit writes to QA bank
 * 6. Manager rejection deletes matching QA row ONLY if it still matches the review item's promoted value (leaves pre-existing or edited QA rows untouched)
 * 7. Stale revision rejection (optimistic locking)
 * 8. Idempotency key caching & replay
 * 9. Embedding repair selector/decoupled embedding handling
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setTestReviewStoreEnabled,
  resetTestReviewStore,
  recordAiReviewProposals,
  promoteSubmittedAiAnswers,
  operatorReviewAction,
  managerReviewAction,
  getPendingEmbeddingReviews,
  syncReviewEmbedding,
  getReviewById,
  findReviewByProposalIdentity,
  getInMemoryQaRow,
  setInMemoryQaRow,
  getInMemoryEvents,
  type AiReviewProposalItem,
} from '../src/db/aiAnswerReviews.js';

describe('AI Answer Reviews Data Layer (Task 3)', () => {
  const appId1 = '11111111-1111-1111-1111-111111111111';
  const appId2 = '22222222-2222-2222-2222-222222222222';
  const candidateId = 'AWL-TEST-001';

  beforeEach(() => {
    setTestReviewStoreEnabled(true);
    resetTestReviewStore();
  });

  describe('1. Immutable proposal identity', () => {
    it('creates proposals keyed by (application_id, resolution_revision, field_key)', async () => {
      const proposals: AiReviewProposalItem[] = [
        {
          fieldKey: 'fp_auth_status',
          questionLabel: 'Are you authorized to work in the US?',
          fieldType: 'select',
          options: ['Yes', 'No'],
          aiValue: 'Yes',
          aiConfidence: 0.95,
          aiModel: 'claude-haiku-5-5',
        },
        {
          fieldKey: 'fp_sponsorship',
          questionLabel: 'Will you now or in the future require sponsorship?',
          fieldType: 'radio',
          options: ['Yes', 'No'],
          aiValue: 'No',
          aiConfidence: 0.88,
          aiModel: 'deepseek/deepseek-r1-0528',
        },
      ];

      const recorded = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        candidateName: 'John Doe',
        proposals,
      });

      assert.equal(recorded.length, 2);
      assert.equal(recorded[0].application_id, appId1);
      assert.equal(recorded[0].resolution_revision, 1);
      assert.equal(recorded[0].revision, 1);
      assert.equal(recorded[0].status, 'pending_operator');
      assert.equal(recorded[0].embedding_status, 'pending');

      const byIdentity = await findReviewByProposalIdentity(appId1, 1, 'fp_auth_status');
      assert.ok(byIdentity);
      assert.equal(byIdentity.id, recorded[0].id);
      assert.equal(byIdentity.ai_value, 'Yes');
    });

    it('preserves immutable proposal values on duplicate recording attempts', async () => {
      await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_auth_status',
            questionLabel: 'Are you authorized to work in the US?',
            fieldType: 'select',
            aiValue: 'Yes',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      // Second recording attempt with same identity but different value
      const secondCall = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_auth_status',
            questionLabel: 'Are you authorized to work in the US?',
            fieldType: 'select',
            aiValue: 'MUTATED_VALUE_IGNORED',
            aiModel: 'different-model',
          },
        ],
      });

      assert.equal(secondCall.length, 1);
      assert.equal(secondCall[0].ai_value, 'Yes'); // Retained original immutable value
    });

    it('creates distinct proposals for a new resolution_revision of the same application', async () => {
      const rev1 = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_auth_status',
            questionLabel: 'Are you authorized to work in the US?',
            fieldType: 'select',
            aiValue: 'Yes',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      const rev2 = await recordAiReviewProposals({
        applicationId: appId1,
        resolutionRevision: 2,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_auth_status',
            questionLabel: 'Are you authorized to work in the US?',
            fieldType: 'select',
            aiValue: 'Yes - Permanent Resident',
            aiModel: 'deepseek/deepseek-r1-0528',
          },
        ],
      });

      assert.notEqual(rev1[0].id, rev2[0].id);
      assert.equal(rev1[0].resolution_revision, 1);
      assert.equal(rev2[0].resolution_revision, 2);
      assert.equal(rev1[0].ai_value, 'Yes');
      assert.equal(rev2[0].ai_value, 'Yes - Permanent Resident');
    });
  });

  describe('2. Idempotent submission promotion', () => {
    it('promotes all active AI answers for an application to QA bank idempotently', async () => {
      const proposals = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_years_exp',
            questionLabel: 'Years of Experience in Python',
            fieldType: 'text',
            aiValue: '5 years',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      // Initially no QA bank row exists
      assert.equal(getInMemoryQaRow(candidateId, 'fp_years_exp'), null);

      // Operator submission promotion
      const firstPromo = await promoteSubmittedAiAnswers({ applicationId: appId1 });
      assert.equal(firstPromo.promotedCount, 1);

      const qaRow = getInMemoryQaRow(candidateId, 'fp_years_exp');
      assert.ok(qaRow);
      assert.equal(qaRow.value, '5 years');
      assert.equal(qaRow.source, 'manual');
      assert.equal(qaRow.confidence, 1.0);

      const updatedRev = await getReviewById(proposals[0].id);
      assert.ok(updatedRev?.promoted_at);
      assert.equal(updatedRev?.promoted_value, '5 years');
      assert.equal(updatedRev?.promoted_source, 'operator_submission');

      // Second promotion for the same application is idempotent
      const secondPromo = await promoteSubmittedAiAnswers({ applicationId: appId1 });
      assert.equal(secondPromo.promotedCount, 1);
      const qaRow2 = getInMemoryQaRow(candidateId, 'fp_years_exp');
      assert.equal(qaRow2?.value, '5 years');
    });
  });

  describe('3. Operator actions always advance to manager review', () => {
    it('operator approve advances status to pending_manager with AI value', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_relocate',
            questionLabel: 'Willing to relocate?',
            fieldType: 'select',
            aiValue: 'Yes',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      const result = await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'approve',
        actorEmail: 'ca@applywizz.com',
      });

      assert.equal(result.success, true);
      assert.equal(result.review?.status, 'pending_manager');
      assert.equal(result.review?.operator_action, 'approved');
      assert.equal(result.review?.operator_value, 'Yes');
      assert.equal(result.review?.revision, 2);

      const events = getInMemoryEvents(review.id);
      const opEvent = events.find((e) => e.eventType === 'operator_action');
      assert.ok(opEvent);
      assert.equal(opEvent.fromStatus, 'pending_operator');
      assert.equal(opEvent.toStatus, 'pending_manager');
    });

    it('operator edit advances status to pending_manager with edited value', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_salary',
            questionLabel: 'Expected Salary',
            fieldType: 'text',
            aiValue: '$100,000',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      const result = await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'edit',
        editedValue: '$120,000',
        actorEmail: 'ca@applywizz.com',
      });

      assert.equal(result.success, true);
      assert.equal(result.review?.status, 'pending_manager');
      assert.equal(result.review?.operator_action, 'edited');
      assert.equal(result.review?.operator_value, '$120,000');
      assert.equal(result.review?.revision, 2);
    });

    it('operator deny advances status to pending_manager with null operator value', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_hallucination',
            questionLabel: 'Describe your secret security clearance level',
            fieldType: 'text',
            aiValue: 'Top Secret Level 5',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      const result = await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'deny',
        actorEmail: 'ca@applywizz.com',
      });

      assert.equal(result.success, true);
      assert.equal(result.review?.status, 'pending_manager');
      assert.equal(result.review?.operator_action, 'denied');
      assert.equal(result.review?.operator_value, null);
      assert.equal(result.review?.revision, 2);
    });

    it('rejects operator edit if editedValue is missing or blank', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_test',
            questionLabel: 'Test',
            fieldType: 'text',
            aiValue: 'Val',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      await assert.rejects(
        () =>
          operatorReviewAction({
            reviewId: review.id,
            expectedRevision: 1,
            action: 'edit',
            editedValue: '   ',
            actorEmail: 'ca@applywizz.com',
          }),
        /Edited value must be provided for edit action/
      );
    });
  });

  describe('4. Operator denial prevents manager from approving original AI answer', () => {
    it('manager CANNOT approve an operator-denied proposal without providing an edited replacement', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_denied_q',
            questionLabel: 'Are you currently working?',
            fieldType: 'select',
            aiValue: 'Yes',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      // Operator denies
      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'deny',
        actorEmail: 'ca@applywizz.com',
      });

      // Manager attempts to approve original answer without replacement
      await assert.rejects(
        () =>
          managerReviewAction({
            reviewId: review.id,
            expectedRevision: 2,
            action: 'approve',
            actorEmail: 'manager@applywizz.com',
          }),
        /Cannot approve an operator-denied proposal without providing an edited replacement/
      );
    });

    it('manager CAN approve an operator-denied proposal by providing an edited replacement', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_denied_q',
            questionLabel: 'Are you currently working?',
            fieldType: 'select',
            aiValue: 'Yes',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'deny',
        actorEmail: 'ca@applywizz.com',
      });

      // Manager provides edited replacement
      const result = await managerReviewAction({
        reviewId: review.id,
        expectedRevision: 2,
        action: 'approve',
        editedValue: 'No, available immediately',
        actorEmail: 'manager@applywizz.com',
      });

      assert.equal(result.success, true);
      assert.equal(result.review?.status, 'approved');
      assert.equal(result.review?.manager_value, 'No, available immediately');

      const qaRow = getInMemoryQaRow(candidateId, 'fp_denied_q');
      assert.ok(qaRow);
      assert.equal(qaRow.value, 'No, available immediately');
    });

    it('manager CAN reject an operator-denied proposal', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_denied_q',
            questionLabel: 'Are you currently working?',
            fieldType: 'select',
            aiValue: 'Yes',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'deny',
        actorEmail: 'ca@applywizz.com',
      });

      const result = await managerReviewAction({
        reviewId: review.id,
        expectedRevision: 2,
        action: 'reject',
        actorEmail: 'manager@applywizz.com',
      });

      assert.equal(result.success, true);
      assert.equal(result.review?.status, 'rejected');
      assert.equal(result.review?.manager_action, 'rejected');
    });
  });

  describe('5. Manager approval/edit writes to QA bank', () => {
    it('manager approval writes operator-approved value to QA bank', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_lead_source',
            questionLabel: 'How did you hear about us?',
            fieldType: 'select',
            aiValue: 'LinkedIn',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'approve',
        actorEmail: 'ca@applywizz.com',
      });

      const result = await managerReviewAction({
        reviewId: review.id,
        expectedRevision: 2,
        action: 'approve',
        actorEmail: 'manager@applywizz.com',
      });

      assert.equal(result.success, true);
      assert.equal(result.review?.status, 'approved');
      assert.equal(result.review?.embedding_status, 'pending');

      const qaRow = getInMemoryQaRow(candidateId, 'fp_lead_source');
      assert.ok(qaRow);
      assert.equal(qaRow.value, 'LinkedIn');
      assert.equal(qaRow.source, 'manual');
      assert.equal(qaRow.confidence, 1.0);
    });

    it('manager edit overrides value and writes to QA bank', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_lead_source',
            questionLabel: 'How did you hear about us?',
            fieldType: 'select',
            aiValue: 'LinkedIn',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'approve',
        actorEmail: 'ca@applywizz.com',
      });

      const result = await managerReviewAction({
        reviewId: review.id,
        expectedRevision: 2,
        action: 'edit',
        editedValue: 'Company Career Website',
        actorEmail: 'manager@applywizz.com',
      });

      assert.equal(result.success, true);
      assert.equal(result.review?.status, 'approved');
      assert.equal(result.review?.manager_value, 'Company Career Website');

      const qaRow = getInMemoryQaRow(candidateId, 'fp_lead_source');
      assert.ok(qaRow);
      assert.equal(qaRow.value, 'Company Career Website');
    });
  });

  describe('6. Manager rejection conditional QA deletion', () => {
    it('deletes matching QA row if it still matches review item promoted value', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_remote_pref',
            questionLabel: 'Preferred Workplace',
            fieldType: 'select',
            aiValue: 'Remote',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      // Application was submitted -> promoted to QA bank
      await promoteSubmittedAiAnswers({ applicationId: appId1 });
      assert.equal(getInMemoryQaRow(candidateId, 'fp_remote_pref')?.value, 'Remote');

      // Operator action -> manager review
      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'approve',
        actorEmail: 'ca@applywizz.com',
      });

      // Manager rejects
      const result = await managerReviewAction({
        reviewId: review.id,
        expectedRevision: 2,
        action: 'reject',
        actorEmail: 'manager@applywizz.com',
      });

      assert.equal(result.success, true);
      assert.equal(result.deletedQaCount, 1);
      // Matching promoted QA row has been removed
      assert.equal(getInMemoryQaRow(candidateId, 'fp_remote_pref'), null);
    });

    it('leaves QA row untouched if value was subsequently modified', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_remote_pref',
            questionLabel: 'Preferred Workplace',
            fieldType: 'select',
            aiValue: 'Remote',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      // Promoted
      await promoteSubmittedAiAnswers({ applicationId: appId1 });
      assert.equal(getInMemoryQaRow(candidateId, 'fp_remote_pref')?.value, 'Remote');

      // Subsequently, an operator manually edits QA bank to 'Hybrid'
      setInMemoryQaRow({
        applywizz_id: candidateId,
        question_fingerprint: 'fp_remote_pref',
        question_label: 'Preferred Workplace',
        field_type: 'select',
        value: 'Hybrid',
        source: 'manual',
        confidence: 1.0,
      });

      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'approve',
        actorEmail: 'ca@applywizz.com',
      });

      // Manager rejects the old review
      const result = await managerReviewAction({
        reviewId: review.id,
        expectedRevision: 2,
        action: 'reject',
        actorEmail: 'manager@applywizz.com',
      });

      assert.equal(result.success, true);
      assert.equal(result.deletedQaCount, 0); // Did not delete
      // Modified QA row remains untouched!
      assert.equal(getInMemoryQaRow(candidateId, 'fp_remote_pref')?.value, 'Hybrid');
    });

    it('leaves pre-existing QA row untouched if review was never promoted', async () => {
      // Pre-existing manual QA row exists before review proposal
      setInMemoryQaRow({
        applywizz_id: candidateId,
        question_fingerprint: 'fp_preexisting',
        question_label: 'Pre-existing Question',
        field_type: 'text',
        value: 'Legacy Authoritative Answer',
        source: 'manual',
        confidence: 1.0,
      });

      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_preexisting',
            questionLabel: 'Pre-existing Question',
            fieldType: 'text',
            aiValue: 'AI Guessed Answer',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      // Never promoted!
      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'deny',
        actorEmail: 'ca@applywizz.com',
      });

      const result = await managerReviewAction({
        reviewId: review.id,
        expectedRevision: 2,
        action: 'reject',
        actorEmail: 'manager@applywizz.com',
      });

      assert.equal(result.success, true);
      assert.equal(result.deletedQaCount, 0);
      // Pre-existing QA row remains completely untouched
      assert.equal(
        getInMemoryQaRow(candidateId, 'fp_preexisting')?.value,
        'Legacy Authoritative Answer'
      );
    });
  });

  describe('7. Stale revision rejection (optimistic locking)', () => {
    it('rejects operator action if revision does not match', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_opt_lock',
            questionLabel: 'Question',
            fieldType: 'text',
            aiValue: 'Val',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      await assert.rejects(
        () =>
          operatorReviewAction({
            reviewId: review.id,
            expectedRevision: 99, // Stale!
            action: 'approve',
            actorEmail: 'ca@applywizz.com',
          }),
        /Stale revision: expected 99, got 1/
      );

      // Verify revision did not increment
      const untouched = await getReviewById(review.id);
      assert.equal(untouched?.revision, 1);
      assert.equal(untouched?.status, 'pending_operator');
    });

    it('rejects manager action if revision does not match', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_opt_lock',
            questionLabel: 'Question',
            fieldType: 'text',
            aiValue: 'Val',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'approve',
        actorEmail: 'ca@applywizz.com',
      });

      // Review is now revision 2. Manager passes stale revision 1
      await assert.rejects(
        () =>
          managerReviewAction({
            reviewId: review.id,
            expectedRevision: 1, // Stale!
            action: 'approve',
            actorEmail: 'manager@applywizz.com',
          }),
        /Stale revision: expected 1, got 2/
      );
    });
  });

  describe('8. Idempotency key caching and replay', () => {
    it('replays cached operator action without repeating mutations or revision increments', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_idemp',
            questionLabel: 'Notice Period',
            fieldType: 'text',
            aiValue: '2 weeks',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      const first = await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'approve',
        actorEmail: 'ca@applywizz.com',
        idempotencyKey: 'idemp-op-key-1',
      });

      assert.equal(first.success, true);
      assert.equal(first.review?.revision, 2);
      assert.equal(first.cached, undefined);

      // Replay identical call
      const replay = await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1, // Even with old expectedRevision
        action: 'approve',
        actorEmail: 'ca@applywizz.com',
        idempotencyKey: 'idemp-op-key-1',
      });

      assert.equal(replay.success, true);
      assert.equal(replay.cached, true);
      assert.equal(replay.review?.revision, 2); // Did not increment again

      const latest = await getReviewById(review.id);
      assert.equal(latest?.revision, 2);
    });

    it('replays cached manager action without repeating mutations', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_idemp_mgr',
            questionLabel: 'Notice Period',
            fieldType: 'text',
            aiValue: '2 weeks',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'approve',
        actorEmail: 'ca@applywizz.com',
      });

      const firstMgr = await managerReviewAction({
        reviewId: review.id,
        expectedRevision: 2,
        action: 'approve',
        actorEmail: 'manager@applywizz.com',
        idempotencyKey: 'idemp-mgr-key-1',
      });

      assert.equal(firstMgr.success, true);
      assert.equal(firstMgr.review?.revision, 3);
      assert.equal(firstMgr.cached, undefined);

      // Replay
      const replayMgr = await managerReviewAction({
        reviewId: review.id,
        expectedRevision: 2,
        action: 'approve',
        actorEmail: 'manager@applywizz.com',
        idempotencyKey: 'idemp-mgr-key-1',
      });

      assert.equal(replayMgr.success, true);
      assert.equal(replayMgr.cached, true);
      assert.equal(replayMgr.review?.revision, 3);
    });
  });

  describe('9. Decoupled embeddings and repair selector', () => {
    it('returns pending embedding reviews via selector', async () => {
      await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_emb_1',
            questionLabel: 'Question 1',
            fieldType: 'text',
            aiValue: 'Ans 1',
            aiModel: 'claude-haiku-5-5',
          },
          {
            fieldKey: 'fp_emb_2',
            questionLabel: 'Question 2',
            fieldType: 'text',
            aiValue: 'Ans 2',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      const pending = await getPendingEmbeddingReviews();
      assert.equal(pending.length, 2);
      assert.equal(pending[0].embedding_status, 'pending');
      assert.equal(pending[1].embedding_status, 'pending');
    });

    it('syncReviewEmbedding generates embedding and updates embedding_status to completed', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_emb_sync',
            questionLabel: 'Primary programming language',
            fieldType: 'text',
            aiValue: 'TypeScript',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      const mockVector = new Array(1536).fill(0.05);
      const syncResult = await syncReviewEmbedding(review.id, 1, async (text) => {
        assert.equal(text, 'Primary programming language');
        return mockVector;
      });

      assert.equal(syncResult.success, true);

      const updated = await getReviewById(review.id);
      assert.equal(updated?.embedding_status, 'completed');
      assert.ok(updated?.embedding_updated_at);
      assert.equal(updated?.embedding_error, null);
    });

    it('syncReviewEmbedding rejects stale revision to prevent overwriting newer QA state', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_emb_stale',
            questionLabel: 'Primary programming language',
            fieldType: 'text',
            aiValue: 'TypeScript',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      // Advance review revision
      await operatorReviewAction({
        reviewId: review.id,
        expectedRevision: 1,
        action: 'approve',
        actorEmail: 'ca@applywizz.com',
      });

      // Pass stale revision 1 to syncReviewEmbedding
      const result = await syncReviewEmbedding(review.id, 1, async () => [0.1, 0.2]);
      assert.equal(result.success, false);
      assert.match(result.error || '', /Revision mismatch/);

      const unchanged = await getReviewById(review.id);
      assert.notEqual(unchanged?.embedding_status, 'completed');
    });

    it('syncReviewEmbedding marks embedding_status as failed on embedder error', async () => {
      const [review] = await recordAiReviewProposals({
        applicationId: appId1,
        applywizzId: candidateId,
        proposals: [
          {
            fieldKey: 'fp_emb_fail',
            questionLabel: 'Broken embed',
            fieldType: 'text',
            aiValue: 'Val',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });

      const result = await syncReviewEmbedding(review.id, 1, async () => {
        throw new Error('OpenRouter 503 Service Unavailable');
      });

      assert.equal(result.success, false);
      const updated = await getReviewById(review.id);
      assert.equal(updated?.embedding_status, 'failed');
      assert.equal(updated?.embedding_error, 'OpenRouter 503 Service Unavailable');
    });
  });
});
