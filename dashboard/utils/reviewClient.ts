/**
 * @fileoverview Client utilities and contract types for Operator and Manager AI Answer Reviews.
 */

export interface ReviewItem {
  id: string;
  application_id: string;
  resolution_revision: number;
  field_key: string;
  applywizz_id: string;
  candidate_name?: string | null;
  question_label: string;
  field_type: string;
  options?: string[] | any;
  ai_value: string;
  ai_confidence?: number | null;
  ai_model: string;
  ai_provenance?: any;
  revision: number;
  status: 'pending_operator' | 'pending_manager' | 'approved' | 'rejected';
  // Operator action fields (present for manager reviews)
  operator_action?: 'approved' | 'denied' | 'edited' | null;
  operator_value?: string | null;
  operator_email?: string | null;
  operator_actioned_at?: string | null;
  // Manager action fields
  manager_action?: 'approved' | 'rejected' | 'edited' | null;
  manager_value?: string | null;
  manager_email?: string | null;
  manager_actioned_at?: string | null;
}

export interface OperatorActionPayload {
  action: 'approve' | 'edit' | 'deny';
  editedValue?: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface ManagerActionPayload {
  action: 'approve' | 'edit' | 'reject';
  editedValue?: string;
  expectedRevision: number;
  idempotencyKey: string;
}

/**
 * Generates a client-side UUID idempotency key.
 * Uses native crypto.randomUUID when available, with a compliant fallback.
 */
export function generateReviewIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Validates operator review action inputs.
 */
export function validateOperatorAction(
  action: 'approve' | 'edit' | 'deny',
  editedValue?: string
): { valid: boolean; error?: string } {
  if (action === 'edit') {
    if (!editedValue || !editedValue.trim()) {
      return { valid: false, error: 'Replacement value cannot be empty' };
    }
  }
  return { valid: true };
}

/**
 * Checks whether direct manager approval is allowed for this review.
 * Business rule: if operator denied, manager cannot approve directly without providing replacement.
 */
export function isManagerDirectApproveAllowed(operatorAction?: string | null): boolean {
  return operatorAction !== 'denied';
}

/**
 * Validates manager review action inputs.
 */
export function validateManagerAction(
  action: 'approve' | 'edit' | 'reject',
  operatorAction?: string | null,
  editedValue?: string
): { valid: boolean; error?: string; disabledReason?: string } {
  if (action === 'approve') {
    if (operatorAction === 'denied' && (!editedValue || !editedValue.trim())) {
      return {
        valid: false,
        error: 'Cannot approve an operator-denied proposal without providing an edited replacement',
        disabledReason: 'Operator denied this proposal. Provide edited replacement to approve.',
      };
    }
  }
  if (action === 'edit') {
    if (!editedValue || !editedValue.trim()) {
      return { valid: false, error: 'Replacement value cannot be empty' };
    }
  }
  return { valid: true };
}

/**
 * Builds payload for POST /api/reviews/:id/operator-action.
 */
export function buildOperatorActionPayload(
  action: 'approve' | 'edit' | 'deny',
  expectedRevision: number,
  editedValue?: string,
  idempotencyKey: string = generateReviewIdempotencyKey()
): OperatorActionPayload {
  const validation = validateOperatorAction(action, editedValue);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  const payload: OperatorActionPayload = {
    action,
    expectedRevision,
    idempotencyKey,
  };
  if (action === 'edit' && editedValue !== undefined) {
    payload.editedValue = editedValue.trim();
  }
  return payload;
}

/**
 * Builds payload for POST /api/reviews/:id/manager-action.
 */
export function buildManagerActionPayload(
  action: 'approve' | 'edit' | 'reject',
  expectedRevision: number,
  editedValue?: string,
  idempotencyKey: string = generateReviewIdempotencyKey(),
  operatorAction?: string | null
): ManagerActionPayload {
  const validation = validateManagerAction(action, operatorAction, editedValue);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  const payload: ManagerActionPayload = {
    action,
    expectedRevision,
    idempotencyKey,
  };
  if (editedValue !== undefined && editedValue.trim()) {
    payload.editedValue = editedValue.trim();
  }
  return payload;
}

/**
 * Determines whether an API response status code represents a stale revision conflict.
 */
export function isStaleRevisionResponse(status: number): boolean {
  return status === 409;
}
