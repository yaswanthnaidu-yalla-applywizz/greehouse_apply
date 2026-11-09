/**
 * @fileoverview Unit and integration tests for Secured Operator and Manager Review API (Task 5).
 * Tests:
 * 1. Missing or invalid Bearer token returns 401 Unauthorized.
 * 2. Forged role header / client-supplied email is ignored (server-derived identity & role).
 * 3. Cross-team / unassigned operator or manager read or write returns 403 Forbidden.
 * 4. Operator actions ('approve', 'edit', 'deny') advance item to 'pending_manager'.
 * 5. Stale revision returns 409 Conflict.
 * 6. Operator denial prevents manager from approving original AI answer (returns 400 Bad Request).
 * 7. Manager approval/edit updates QA bank; manager rejection conditionally removes matching promoted QA row.
 * 8. Idempotency key replay returns cached receipt without mutation.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express, { Express } from 'express';
import { reviewsRouter } from '../src/server/routes/reviews.js';
import {
  setTestReviewStoreEnabled,
  resetTestReviewStore,
  recordAiReviewProposals,
  promoteSubmittedAiAnswers,
  setTestOperatorAssignment,
  setTestManagerTeam,
  setTestUserRole,
  getInMemoryQaRow,
  setInMemoryQaRow,
  getReviewById,
  type AiReviewProposalItem,
} from '../src/db/aiAnswerReviews.js';

function createTestJwt(payload: {
  email: string;
  role?: string;
  exp?: number;
  sub?: string;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      email: payload.email,
      role: payload.role || 'authenticated',
      sub: payload.sub || 'usr_123',
      exp: payload.exp ?? Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url');
  const signature = 'test_signature';
  return `${header}.${body}.${signature}`;
}

/**
 * Dispatches an HTTP request directly to an Express app in-process.
 * Avoids loopback TCP socket restrictions in sandboxed environments.
 */
function dispatch(
  app: Express,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    body?: any;
  }
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as any;
    req.method = options.method || 'GET';
    req.url = options.url;
    req.headers = Object.fromEntries(
      Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    req.body = options.body;
    req.connection = { remoteAddress: '127.0.0.1' };
    req.socket = req.connection;

    const res = new EventEmitter() as any;
    let statusCode = 200;
    const resHeaders: Record<string, string> = {};
    let responseBody: any = null;

    res.statusCode = statusCode;
    res.status = function (code: number) {
      res.statusCode = code;
      return res;
    };
    res.setHeader = function (name: string, value: string) {
      resHeaders[name.toLowerCase()] = value;
      return res;
    };
    res.getHeader = function (name: string) {
      return resHeaders[name.toLowerCase()];
    };
    res.json = function (data: any) {
      res.setHeader('content-type', 'application/json');
      responseBody = data;
      res.end(JSON.stringify(data));
      return res;
    };
    res.send = function (data: any) {
      responseBody = data;
      res.end(typeof data === 'object' ? JSON.stringify(data) : String(data));
      return res;
    };
    res.end = function (chunk?: any) {
      if (chunk !== undefined && responseBody === null) {
        try {
          responseBody = JSON.parse(chunk);
        } catch {
          responseBody = chunk;
        }
      }
      resolve({ status: res.statusCode, body: responseBody, headers: resHeaders });
    };

    app(req, res, (err?: any) => {
      if (err) reject(err);
      else resolve({ status: 404, body: { error: 'Not found' }, headers: resHeaders });
    });
  });
}

describe('Secured Operator and Manager Review API (Task 5)', () => {
  let app: Express;

  const OP1_EMAIL = 'operator1@applywizz.ai';
  const OP2_EMAIL = 'operator2@applywizz.ai';
  const MGR1_EMAIL = 'manager1@applywizz.ai';
  const MGR2_EMAIL = 'manager2@applywizz.ai';
  const DEV_EMAIL = 'yaswanthnaiduyalla@applywizz.ai'; // in ROLE_BY_EMAIL -> dev
  const ADMIN_EMAIL = 'ramakrishna@applywizz.ai'; // in ROLE_BY_EMAIL -> admin

  const APP1_ID = '11111111-1111-1111-1111-111111111111';
  const APP2_ID = '22222222-2222-2222-2222-222222222222';
  const CANDIDATE1_ID = 'AWL-OP1-001';
  const CANDIDATE2_ID = 'AWL-OP2-002';

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/reviews', reviewsRouter);

    setTestReviewStoreEnabled(true);
    resetTestReviewStore();

    // Register user roles
    setTestUserRole(OP1_EMAIL, 'operator');
    setTestUserRole(OP2_EMAIL, 'operator');
    setTestUserRole(MGR1_EMAIL, 'manager');
    setTestUserRole(MGR2_EMAIL, 'manager');

    // Scoping assignments:
    // OP1 assigned to Candidate 1 and Application 1
    setTestOperatorAssignment(OP1_EMAIL, {
      candidateIds: [CANDIDATE1_ID],
      applicationIds: [APP1_ID],
    });

    // OP2 assigned to Candidate 2 and Application 2
    setTestOperatorAssignment(OP2_EMAIL, {
      candidateIds: [CANDIDATE2_ID],
      applicationIds: [APP2_ID],
    });

    // MGR1 manages OP1
    setTestManagerTeam(MGR1_EMAIL, [OP1_EMAIL]);

    // MGR2 manages OP2
    setTestManagerTeam(MGR2_EMAIL, [OP2_EMAIL]);
  });

  describe('1. Missing or invalid Bearer token returns 401 Unauthorized', () => {
    it('rejects request with missing Authorization header', async () => {
      const res = await dispatch(app, {
        method: 'GET',
        url: '/api/reviews/operator',
      });
      assert.equal(res.status, 401);
      assert.ok(res.body.error.includes('Missing or invalid Authorization header'));
    });

    it('rejects request with non-Bearer Authorization header', async () => {
      const res = await dispatch(app, {
        method: 'GET',
        url: '/api/reviews/operator',
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      });
      assert.equal(res.status, 401);
    });

    it('rejects request with empty Bearer token', async () => {
      const res = await dispatch(app, {
        method: 'GET',
        url: '/api/reviews/operator',
        headers: { Authorization: 'Bearer ' },
      });
      assert.equal(res.status, 401);
      assert.ok(res.body.error.includes('Bearer token cannot be empty'));
    });

    it('rejects request with malformed JWT token', async () => {
      const res = await dispatch(app, {
        method: 'GET',
        url: '/api/reviews/operator',
        headers: { Authorization: 'Bearer not-a-valid-jwt-token' },
      });
      assert.equal(res.status, 401);
      assert.ok(res.body.error.includes('Malformed JWT token'));
    });

    it('rejects request with expired token', async () => {
      const expiredToken = createTestJwt({
        email: OP1_EMAIL,
        exp: Math.floor(Date.now() / 1000) - 300, // expired 5 minutes ago
      });
      const res = await dispatch(app, {
        method: 'GET',
        url: '/api/reviews/operator',
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      assert.equal(res.status, 401);
      assert.ok(res.body.error.includes('Token has expired'));
    });

    it('rejects token without an email claim', async () => {
      const invalidClaimsToken = createTestJwt({ email: '' });
      const res = await dispatch(app, {
        method: 'GET',
        url: '/api/reviews/operator',
        headers: { Authorization: `Bearer ${invalidClaimsToken}` },
      });
      assert.equal(res.status, 401);
      assert.ok(res.body.error.includes('Missing email claim'));
    });
  });

  describe('2. Forged role header / client-supplied email is ignored', () => {
    it('ignores client X-User-Role, X-View-As, X-Test-Bypass, and body email claims', async () => {
      const opToken = createTestJwt({ email: OP1_EMAIL });

      // An operator attempts to masquerade as an admin/manager via headers and body
      const res = await dispatch(app, {
        method: 'GET',
        url: '/api/reviews/manager',
        headers: {
          Authorization: `Bearer ${opToken}`,
          'x-user-role': 'admin',
          'x-view-as': 'admin',
          'x-test-bypass': 'true',
          'x-user-email': ADMIN_EMAIL,
        },
      });

      // The server ignores all client-supplied role/email overrides and derives OP1's operator role -> 403 Forbidden
      assert.equal(res.status, 403);
      assert.ok(res.body.error.includes('manager role required'));
    });
  });

  describe('3. Cross-team / unassigned operator or manager read or write returns 403 Forbidden', () => {
    let review1Id: string;
    let review2Id: string;

    beforeEach(async () => {
      const proposals1: AiReviewProposalItem[] = [
        {
          fieldKey: 'fp_auth',
          questionLabel: 'Authorized to work in US?',
          fieldType: 'select',
          aiValue: 'Yes',
          aiModel: 'claude-haiku-5-5',
        },
      ];
      const proposals2: AiReviewProposalItem[] = [
        {
          fieldKey: 'fp_sponsorship',
          questionLabel: 'Need sponsorship?',
          fieldType: 'radio',
          aiValue: 'No',
          aiModel: 'deepseek-r1',
        },
      ];

      const [r1] = await recordAiReviewProposals({
        applicationId: APP1_ID,
        resolutionRevision: 1,
        applywizzId: CANDIDATE1_ID,
        proposals: proposals1,
      });
      review1Id = r1.id;

      const [r2] = await recordAiReviewProposals({
        applicationId: APP2_ID,
        resolutionRevision: 1,
        applywizzId: CANDIDATE2_ID,
        proposals: proposals2,
      });
      review2Id = r2.id;
    });

    it('operator GET /api/reviews/operator only returns items assigned to that operator', async () => {
      const op1Token = createTestJwt({ email: OP1_EMAIL });
      const res = await dispatch(app, {
        method: 'GET',
        url: '/api/reviews/operator',
        headers: { Authorization: `Bearer ${op1Token}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.count, 1);
      assert.equal(res.body.reviews[0].id, review1Id);
      assert.equal(res.body.reviews[0].applywizz_id, CANDIDATE1_ID);
    });

    it('operator cannot perform review action on an unassigned review item (returns 403)', async () => {
      const op1Token = createTestJwt({ email: OP1_EMAIL });
      // OP1 tries to act on review2 (assigned to OP2)
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${review2Id}/operator-action`,
        headers: {
          Authorization: `Bearer ${op1Token}`,
        },
        body: {
          action: 'approve',
          expectedRevision: 1,
        },
      });

      assert.equal(res.status, 403);
      assert.ok(res.body.error.includes('unassigned candidate or application'));
    });

    it('manager GET /api/reviews/manager only returns items scoped to their team', async () => {
      const op1Token = createTestJwt({ email: OP1_EMAIL });
      const op2Token = createTestJwt({ email: OP2_EMAIL });

      // Advance both to pending_manager
      await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${review1Id}/operator-action`,
        headers: { Authorization: `Bearer ${op1Token}` },
        body: { action: 'approve', expectedRevision: 1 },
      });

      await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${review2Id}/operator-action`,
        headers: { Authorization: `Bearer ${op2Token}` },
        body: { action: 'approve', expectedRevision: 1 },
      });

      // MGR1 (manages OP1) should only see review1
      const mgr1Token = createTestJwt({ email: MGR1_EMAIL });
      const res = await dispatch(app, {
        method: 'GET',
        url: '/api/reviews/manager',
        headers: { Authorization: `Bearer ${mgr1Token}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.count, 1);
      assert.equal(res.body.reviews[0].id, review1Id);
    });

    it('manager cannot act on a cross-team review item (returns 403)', async () => {
      const op2Token = createTestJwt({ email: OP2_EMAIL });
      // Advance review2 to pending_manager
      await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${review2Id}/operator-action`,
        headers: { Authorization: `Bearer ${op2Token}` },
        body: { action: 'approve', expectedRevision: 1 },
      });

      // MGR1 tries to act on review2 (belongs to OP2's team)
      const mgr1Token = createTestJwt({ email: MGR1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${review2Id}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgr1Token}`,
        },
        body: {
          action: 'approve',
          expectedRevision: 2,
        },
      });

      assert.equal(res.status, 403);
      assert.ok(res.body.error.includes('cross-team access not allowed'));
    });

    it('dev and admin roles have unrestricted cross-team access', async () => {
      const devToken = createTestJwt({ email: DEV_EMAIL });
      const res = await dispatch(app, {
        method: 'GET',
        url: '/api/reviews/operator',
        headers: { Authorization: `Bearer ${devToken}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.count, 2); // Sees both OP1 and OP2 items
    });
  });

  describe('4. Operator actions advance item to pending_manager', () => {
    let reviewId: string;

    beforeEach(async () => {
      const [r] = await recordAiReviewProposals({
        applicationId: APP1_ID,
        resolutionRevision: 1,
        applywizzId: CANDIDATE1_ID,
        proposals: [
          {
            fieldKey: 'fp_cert',
            questionLabel: 'Do you have AWS Certification?',
            fieldType: 'select',
            aiValue: 'Yes',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });
      reviewId = r.id;
    });

    it('operator approve advances status to pending_manager with AI value', async () => {
      const opToken = createTestJwt({ email: OP1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: {
          Authorization: `Bearer ${opToken}`,
        },
        body: {
          action: 'approve',
          expectedRevision: 1,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.review.status, 'pending_manager');
      assert.equal(res.body.review.operator_action, 'approved');
      assert.equal(res.body.review.operator_value, 'Yes');
      assert.equal(res.body.review.revision, 2);
    });

    it('operator edit advances status to pending_manager with edited value', async () => {
      const opToken = createTestJwt({ email: OP1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: {
          Authorization: `Bearer ${opToken}`,
        },
        body: {
          action: 'edit',
          editedValue: 'AWS Solutions Architect Associate',
          expectedRevision: 1,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.review.status, 'pending_manager');
      assert.equal(res.body.review.operator_action, 'edited');
      assert.equal(res.body.review.operator_value, 'AWS Solutions Architect Associate');
      assert.equal(res.body.review.revision, 2);
    });

    it('operator deny advances status to pending_manager with null value', async () => {
      const opToken = createTestJwt({ email: OP1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: {
          Authorization: `Bearer ${opToken}`,
        },
        body: {
          action: 'deny',
          expectedRevision: 1,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.review.status, 'pending_manager');
      assert.equal(res.body.review.operator_action, 'denied');
      assert.equal(res.body.review.operator_value, null);
      assert.equal(res.body.review.revision, 2);
    });

    it('rejects operator edit if editedValue is missing or blank (returns 400)', async () => {
      const opToken = createTestJwt({ email: OP1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: {
          Authorization: `Bearer ${opToken}`,
        },
        body: {
          action: 'edit',
          editedValue: '   ',
          expectedRevision: 1,
        },
      });

      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('Edited value must be provided'));
    });
  });

  describe('5. Stale revision returns 409 Conflict', () => {
    let reviewId: string;

    beforeEach(async () => {
      const [r] = await recordAiReviewProposals({
        applicationId: APP1_ID,
        resolutionRevision: 1,
        applywizzId: CANDIDATE1_ID,
        proposals: [
          {
            fieldKey: 'fp_salary',
            questionLabel: 'Expected Salary?',
            fieldType: 'text',
            aiValue: '$120,000',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });
      reviewId = r.id;
    });

    it('returns 409 Conflict if expectedRevision does not match current revision on operator action', async () => {
      const opToken = createTestJwt({ email: OP1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: {
          Authorization: `Bearer ${opToken}`,
        },
        body: {
          action: 'approve',
          expectedRevision: 99, // Stale!
        },
      });

      assert.equal(res.status, 409);
      assert.ok(res.body.error.includes('Stale revision'));
    });

    it('returns 409 Conflict if expectedRevision does not match on manager action', async () => {
      const opToken = createTestJwt({ email: OP1_EMAIL });
      // Operator advances revision from 1 to 2
      await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: { Authorization: `Bearer ${opToken}` },
        body: { action: 'approve', expectedRevision: 1 },
      });

      // Manager attempts action with stale revision 1
      const mgrToken = createTestJwt({ email: MGR1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgrToken}`,
        },
        body: {
          action: 'approve',
          expectedRevision: 1, // Stale! Current is 2
        },
      });

      assert.equal(res.status, 409);
      assert.ok(res.body.error.includes('Stale revision'));
    });
  });

  describe('6. Operator denial prevents manager from approving original AI answer (returns 400)', () => {
    let reviewId: string;

    beforeEach(async () => {
      const [r] = await recordAiReviewProposals({
        applicationId: APP1_ID,
        resolutionRevision: 1,
        applywizzId: CANDIDATE1_ID,
        proposals: [
          {
            fieldKey: 'fp_grad_date',
            questionLabel: 'Graduation Date?',
            fieldType: 'text',
            aiValue: 'May 2024',
            aiModel: 'deepseek-r1',
          },
        ],
      });
      reviewId = r.id;

      // Operator explicitly denies the proposal
      const opToken = createTestJwt({ email: OP1_EMAIL });
      await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: { Authorization: `Bearer ${opToken}` },
        body: { action: 'deny', expectedRevision: 1 },
      });
    });

    it('returns 400 Bad Request when manager attempts to approve operator-denied proposal without replacement', async () => {
      const mgrToken = createTestJwt({ email: MGR1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgrToken}`,
        },
        body: {
          action: 'approve',
          expectedRevision: 2,
        },
      });

      assert.equal(res.status, 400);
      assert.ok(
        res.body.error.includes(
          'Cannot approve an operator-denied proposal without providing an edited replacement'
        )
      );
    });

    it('allows manager to approve operator-denied proposal when providing an edited replacement', async () => {
      const mgrToken = createTestJwt({ email: MGR1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgrToken}`,
        },
        body: {
          action: 'approve',
          editedValue: 'December 2023',
          expectedRevision: 2,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.review.status, 'approved');
      assert.equal(res.body.review.manager_action, 'edited');
      assert.equal(res.body.review.manager_value, 'December 2023');

      // QA bank has the manager-edited value
      const qa = getInMemoryQaRow(CANDIDATE1_ID, 'fp_grad_date');
      assert.equal(qa?.value, 'December 2023');
    });

    it('allows manager to reject operator-denied proposal', async () => {
      const mgrToken = createTestJwt({ email: MGR1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgrToken}`,
        },
        body: {
          action: 'reject',
          expectedRevision: 2,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.review.status, 'rejected');
      assert.equal(res.body.review.manager_action, 'rejected');
    });
  });

  describe('7. Manager approval/edit updates QA bank; manager rejection conditionally removes matching promoted QA row', () => {
    let reviewId: string;
    const fieldKey = 'fp_location';

    beforeEach(async () => {
      const [r] = await recordAiReviewProposals({
        applicationId: APP1_ID,
        resolutionRevision: 1,
        applywizzId: CANDIDATE1_ID,
        proposals: [
          {
            fieldKey,
            questionLabel: 'Are you willing to relocate?',
            fieldType: 'select',
            aiValue: 'Yes, anywhere',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });
      reviewId = r.id;

      // Operator approves
      const opToken = createTestJwt({ email: OP1_EMAIL });
      await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: { Authorization: `Bearer ${opToken}` },
        body: { action: 'approve', expectedRevision: 1 },
      });
    });

    it('manager approval updates QA bank with approved value', async () => {
      const mgrToken = createTestJwt({ email: MGR1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgrToken}`,
        },
        body: { action: 'approve', expectedRevision: 2 },
      });

      assert.equal(res.status, 200);
      const qa = getInMemoryQaRow(CANDIDATE1_ID, fieldKey);
      assert.equal(qa?.value, 'Yes, anywhere');
    });

    it('manager edit updates QA bank with replacement value', async () => {
      const mgrToken = createTestJwt({ email: MGR1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgrToken}`,
        },
        body: {
          action: 'edit',
          editedValue: 'Yes, East Coast only',
          expectedRevision: 2,
        },
      });

      assert.equal(res.status, 200);
      const qa = getInMemoryQaRow(CANDIDATE1_ID, fieldKey);
      assert.equal(qa?.value, 'Yes, East Coast only');
    });

    it('manager rejection removes matching promoted QA row', async () => {
      // Simulate that this application was submitted, which promoted 'Yes, anywhere' to QA bank
      await promoteSubmittedAiAnswers({ applicationId: APP1_ID, actor: OP1_EMAIL });
      assert.equal(getInMemoryQaRow(CANDIDATE1_ID, fieldKey)?.value, 'Yes, anywhere');

      // Now manager rejects the review item
      const mgrToken = createTestJwt({ email: MGR1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgrToken}`,
        },
        body: { action: 'reject', expectedRevision: 2 },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.deletedQaCount, 1);
      // QA row was conditionally removed!
      assert.equal(getInMemoryQaRow(CANDIDATE1_ID, fieldKey), null);
    });

    it('manager rejection does NOT remove QA row if it was subsequently modified to a different value', async () => {
      // Application submission promotes original value
      await promoteSubmittedAiAnswers({ applicationId: APP1_ID, actor: OP1_EMAIL });

      // An explicit candidate profile update sets a newer value in the QA bank
      setInMemoryQaRow({
        applywizz_id: CANDIDATE1_ID,
        question_fingerprint: fieldKey,
        question_label: 'Are you willing to relocate?',
        field_type: 'select',
        value: 'Never, strictly remote',
        source: 'manual',
        confidence: 1.0,
        updated_at: new Date().toISOString(),
      });

      // Manager rejects the old review item
      const mgrToken = createTestJwt({ email: MGR1_EMAIL });
      const res = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgrToken}`,
        },
        body: { action: 'reject', expectedRevision: 2 },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.deletedQaCount, 0);
      // Newer value is safely preserved!
      assert.equal(getInMemoryQaRow(CANDIDATE1_ID, fieldKey)?.value, 'Never, strictly remote');
    });
  });

  describe('8. Idempotency key replay returns cached receipt without mutation', () => {
    let reviewId: string;

    beforeEach(async () => {
      const [r] = await recordAiReviewProposals({
        applicationId: APP1_ID,
        resolutionRevision: 1,
        applywizzId: CANDIDATE1_ID,
        proposals: [
          {
            fieldKey: 'fp_skills',
            questionLabel: 'Top skills?',
            fieldType: 'text',
            aiValue: 'TypeScript, Node.js',
            aiModel: 'claude-haiku-5-5',
          },
        ],
      });
      reviewId = r.id;
    });

    it('replays cached operator review action on duplicated idempotencyKey', async () => {
      const opToken = createTestJwt({ email: OP1_EMAIL });
      const idempotencyKey = 'test-idemp-op-key-001';

      // First call
      const res1 = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: {
          Authorization: `Bearer ${opToken}`,
        },
        body: {
          action: 'approve',
          expectedRevision: 1,
          idempotencyKey,
        },
      });
      assert.equal(res1.status, 200);
      assert.equal(res1.body.review.revision, 2);
      assert.equal(res1.body.cached, undefined);

      // Duplicate replay call with exact same idempotencyKey
      const res2 = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: {
          Authorization: `Bearer ${opToken}`,
        },
        body: {
          action: 'approve',
          expectedRevision: 1,
          idempotencyKey,
        },
      });
      assert.equal(res2.status, 200);
      assert.equal(res2.body.cached, true);
      assert.equal(res2.body.review.revision, 2); // Did not increment to 3

      // Stored review in DB is still at revision 2
      const stored = await getReviewById(reviewId);
      assert.equal(stored?.revision, 2);
    });

    it('replays cached manager review action on duplicated idempotencyKey', async () => {
      const opToken = createTestJwt({ email: OP1_EMAIL });
      await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/operator-action`,
        headers: { Authorization: `Bearer ${opToken}` },
        body: { action: 'approve', expectedRevision: 1 },
      });

      const mgrToken = createTestJwt({ email: MGR1_EMAIL });
      const idempotencyKey = 'test-idemp-mgr-key-002';

      // First call
      const res1 = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgrToken}`,
        },
        body: {
          action: 'approve',
          expectedRevision: 2,
          idempotencyKey,
        },
      });
      assert.equal(res1.status, 200);
      assert.equal(res1.body.review.revision, 3);

      // Replay call
      const res2 = await dispatch(app, {
        method: 'POST',
        url: `/api/reviews/${reviewId}/manager-action`,
        headers: {
          Authorization: `Bearer ${mgrToken}`,
        },
        body: {
          action: 'approve',
          expectedRevision: 2,
          idempotencyKey,
        },
      });
      assert.equal(res2.status, 200);
      assert.equal(res2.body.cached, true);
      assert.equal(res2.body.review.revision, 3);
    });
  });
});
