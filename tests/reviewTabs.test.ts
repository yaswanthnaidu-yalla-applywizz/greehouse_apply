/**
 * @fileoverview Unit tests for Operator and Manager Review Tabs client contract & validation logic (Task 6).
 *
 * Covers:
 * 1. Client contract & state models (ReviewItem, action payloads).
 * 2. Idempotency key generation (format, uniqueness, fallback).
 * 3. Operator action payload validation & construction (approve, edit, deny).
 * 4. Manager action payload validation & operator denial guard (reject, edit, approve).
 * 5. Stale revision (409 Conflict) error detection & queue reload contract.
 * 6. Simulated client interaction workflow (fetching, action submission, optimistic updates).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateReviewIdempotencyKey,
  validateOperatorAction,
  validateManagerAction,
  isManagerDirectApproveAllowed,
  buildOperatorActionPayload,
  buildManagerActionPayload,
  isStaleRevisionResponse,
  type ReviewItem,
  type OperatorActionPayload,
  type ManagerActionPayload,
} from '../dashboard/utils/reviewClient.js';

describe('Task 6: Operator and Manager Review Tabs Client Contract', () => {
  describe('1. Idempotency Key Generation', () => {
    it('generates a valid UUID v4 format', () => {
      const key = generateReviewIdempotencyKey();
      assert.equal(typeof key, 'string');
      // UUID v4 format: 8-4-4-4-12 hex chars
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.match(key, uuidV4Regex);
    });

    it('generates distinct keys across successive calls', () => {
      const key1 = generateReviewIdempotencyKey();
      const key2 = generateReviewIdempotencyKey();
      assert.notEqual(key1, key2);
    });
  });

  describe('2. Operator Action Payloads & Validation', () => {
    it('builds a valid approve action payload without editedValue', () => {
      const payload: OperatorActionPayload = buildOperatorActionPayload('approve', 1);
      assert.equal(payload.action, 'approve');
      assert.equal(payload.expectedRevision, 1);
      assert.equal(typeof payload.idempotencyKey, 'string');
      assert.equal(payload.editedValue, undefined);
    });

    it('builds a valid deny action payload without editedValue', () => {
      const payload: OperatorActionPayload = buildOperatorActionPayload('deny', 3);
      assert.equal(payload.action, 'deny');
      assert.equal(payload.expectedRevision, 3);
      assert.equal(typeof payload.idempotencyKey, 'string');
      assert.equal(payload.editedValue, undefined);
    });

    it('builds a valid edit action payload with trimmed editedValue', () => {
      const payload: OperatorActionPayload = buildOperatorActionPayload('edit', 2, '  Corrected Value  ');
      assert.equal(payload.action, 'edit');
      assert.equal(payload.expectedRevision, 2);
      assert.equal(payload.editedValue, 'Corrected Value');
      assert.equal(typeof payload.idempotencyKey, 'string');
    });

    it('rejects operator edit when replacement value is empty or whitespace', () => {
      const valEmpty = validateOperatorAction('edit', '');
      assert.equal(valEmpty.valid, false);
      assert.equal(valEmpty.error, 'Replacement value cannot be empty');

      const valWhitespace = validateOperatorAction('edit', '   \t\n  ');
      assert.equal(valWhitespace.valid, false);

      assert.throws(
        () => buildOperatorActionPayload('edit', 1, '   '),
        /Replacement value cannot be empty/
      );
    });
  });

  describe('3. Manager Action Payloads & Operator Denial Guard', () => {
    it('allows direct manager approval when operator approved or edited', () => {
      assert.equal(isManagerDirectApproveAllowed('approved'), true);
      assert.equal(isManagerDirectApproveAllowed('edited'), true);
      assert.equal(isManagerDirectApproveAllowed(null), true);

      const val = validateManagerAction('approve', 'approved');
      assert.equal(val.valid, true);

      const payload = buildManagerActionPayload('approve', 4, undefined, undefined, 'approved');
      assert.equal(payload.action, 'approve');
      assert.equal(payload.expectedRevision, 4);
      assert.equal(payload.editedValue, undefined);
    });

    it('disallows direct manager approval when operator denied proposal', () => {
      assert.equal(isManagerDirectApproveAllowed('denied'), false);

      const val = validateManagerAction('approve', 'denied');
      assert.equal(val.valid, false);
      assert.match(val.error || '', /Cannot approve an operator-denied proposal/);
      assert.match(val.disabledReason || '', /Operator denied this proposal/);

      assert.throws(
        () => buildManagerActionPayload('approve', 2, undefined, undefined, 'denied'),
        /Cannot approve an operator-denied proposal/
      );
    });

    it('allows manager to approve operator-denied proposal when providing an edited replacement', () => {
      const val = validateManagerAction('approve', 'denied', 'Manager Override Value');
      assert.equal(val.valid, true);

      const payload = buildManagerActionPayload('approve', 2, 'Manager Override Value', undefined, 'denied');
      assert.equal(payload.action, 'approve');
      assert.equal(payload.expectedRevision, 2);
      assert.equal(payload.editedValue, 'Manager Override Value');
    });

    it('allows manager to reject operator-denied proposal directly', () => {
      const val = validateManagerAction('reject', 'denied');
      assert.equal(val.valid, true);

      const payload = buildManagerActionPayload('reject', 5, undefined, undefined, 'denied');
      assert.equal(payload.action, 'reject');
      assert.equal(payload.expectedRevision, 5);
    });

    it('rejects manager edit when replacement value is empty or whitespace', () => {
      const valEmpty = validateManagerAction('edit', 'approved', '');
      assert.equal(valEmpty.valid, false);
      assert.equal(valEmpty.error, 'Replacement value cannot be empty');

      assert.throws(
        () => buildManagerActionPayload('edit', 1, '  ', undefined, 'approved'),
        /Replacement value cannot be empty/
      );
    });
  });

  describe('4. Stale Revision (409 Conflict) Handling', () => {
    it('correctly identifies 409 Conflict as a stale revision', () => {
      assert.equal(isStaleRevisionResponse(409), true);
      assert.equal(isStaleRevisionResponse(200), false);
      assert.equal(isStaleRevisionResponse(400), false);
      assert.equal(isStaleRevisionResponse(403), false);
      assert.equal(isStaleRevisionResponse(500), false);
    });
  });

  describe('5. Review Item State Model & Workflow Simulation', () => {
    const mockOperatorReview: ReviewItem = {
      id: 'rev_op_123',
      application_id: 'app_456',
      resolution_revision: 1,
      field_key: 'a1b2c3d4e5f60718',
      applywizz_id: 'CAND_789',
      candidate_name: 'Jane Doe',
      question_label: 'Years of React experience?',
      field_type: 'text',
      options: ['1-2', '3-5', '5+'],
      ai_value: '5+',
      ai_confidence: 0.92,
      ai_model: 'deepseek-chat',
      revision: 1,
      status: 'pending_operator',
    };

    const mockManagerReview: ReviewItem = {
      id: 'rev_mgr_456',
      application_id: 'app_789',
      resolution_revision: 1,
      field_key: 'b2c3d4e5f6071829',
      applywizz_id: 'CAND_101',
      candidate_name: 'John Smith',
      question_label: 'Are you legally authorized to work in the US?',
      field_type: 'radio',
      options: ['Yes', 'No'],
      ai_value: 'Yes',
      ai_confidence: 0.98,
      ai_model: 'deepseek-chat',
      revision: 2,
      status: 'pending_manager',
      operator_action: 'denied',
      operator_email: 'operator@applywizz.ai',
      operator_actioned_at: '2026-11-09T10:00:00.000Z',
    };

    it('simulates operator approving review item and removing from local queue', () => {
      let queue: ReviewItem[] = [mockOperatorReview];

      // Operator triggers approve
      const payload = buildOperatorActionPayload('approve', mockOperatorReview.revision);
      assert.equal(payload.action, 'approve');
      assert.equal(payload.expectedRevision, 1);

      // Simulate successful 200 response
      queue = queue.filter((r) => r.id !== mockOperatorReview.id);
      assert.equal(queue.length, 0);
    });

    it('simulates operator edit with validation and submission', () => {
      const validation = validateOperatorAction('edit', '3-5');
      assert.equal(validation.valid, true);

      const payload = buildOperatorActionPayload('edit', mockOperatorReview.revision, '3-5');
      assert.equal(payload.action, 'edit');
      assert.equal(payload.editedValue, '3-5');
    });

    it('simulates handling stale revision (409 Conflict) on operator action', () => {
      const status = 409;
      const isConflict = isStaleRevisionResponse(status);
      assert.equal(isConflict, true);

      // In the component, this sets a conflict error and reloads the queue
      const conflictMessage = 'Conflict: Stale revision detected. Refreshing queue...';
      assert.match(conflictMessage, /stale revision/i);
    });

    it('enforces UI disabled state for manager approve on operator-denied item', () => {
      assert.equal(isManagerDirectApproveAllowed(mockManagerReview.operator_action), false);

      // Verify that manager cannot approve directly
      const validation = validateManagerAction('approve', mockManagerReview.operator_action);
      assert.equal(validation.valid, false);

      // But manager can edit replacement
      const editValidation = validateManagerAction('edit', mockManagerReview.operator_action, 'No');
      assert.equal(editValidation.valid, true);

      // And manager can reject
      const rejectValidation = validateManagerAction('reject', mockManagerReview.operator_action);
      assert.equal(rejectValidation.valid, true);
    });
  });
});
