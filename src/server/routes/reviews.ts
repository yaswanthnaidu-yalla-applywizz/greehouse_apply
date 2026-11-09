/**
 * @fileoverview Express Router for Secured Operator and Manager AI Answer Reviews (Task 5).
 *
 * Implements strict review-session authorization:
 * - Requires and cryptographically/structurally parses Bearer JWT access tokens.
 * - Server-derives authenticated user identity and role (dev, admin, manager, operator).
 * - Does NOT trust client-supplied headers (X-Test-Bypass, X-View-As, X-User-Role, etc.) or request body emails.
 * - Enforces candidate/application scoping for operators (assigned only).
 * - Enforces team scoping for managers (cross-team access rejected with 403 Forbidden).
 * - Enforces two-level review invariants, optimistic concurrency (409 Conflict), and replay-safe idempotency.
 */

import { Router, Request, Response, NextFunction } from 'express';
import {
  getReviewById,
  operatorReviewAction,
  managerReviewAction,
  isOperatorAllowedForReview,
  isManagerAllowedForReview,
  listOperatorReviews,
  listManagerReviews,
  getTestUserRole,
  isTestReviewStoreEnabled,
} from '../../db/aiAnswerReviews.js';
import { getDbClient, isSupabaseConfigured } from '../../db/client.js';
import { resolveRoleFromEmail } from './auth.js';
import { getDashboardUserByEmail } from '../../db/users.js';
import { normalizeAppRole } from './requireRole.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ReviewRoutes');

export interface ReviewActor {
  id?: string;
  email: string;
  role: 'dev' | 'admin' | 'manager' | 'operator';
}

export interface ReviewAuthenticatedRequest extends Request {
  actor?: ReviewActor;
}

export const reviewsRouter = Router();

function extractParamId(param: string | string[] | undefined): string {
  if (Array.isArray(param)) return param[0] || '';
  return String(param || '');
}

/**
 * Derives user role on the server based on authenticated email.
 * Never trusts client-supplied headers or body fields.
 */
export async function getServerUserRole(
  email: string
): Promise<'dev' | 'admin' | 'manager' | 'operator'> {
  const normalized = email.trim().toLowerCase();

  if (isTestReviewStoreEnabled()) {
    const testRole = getTestUserRole(normalized);
    if (testRole) return testRole;
  }

  const fromEmail = resolveRoleFromEmail(normalized);
  if (fromEmail !== 'operator') return fromEmail;

  if (isSupabaseConfigured() && !isTestReviewStoreEnabled()) {
    try {
      const user = await getDashboardUserByEmail(normalized);
      if (user?.role) {
        const norm = normalizeAppRole(user.role);
        if (norm) return norm;
      }
    } catch {
      // Fallback to operator
    }
  }

  return 'operator';
}

/**
 * Strict authentication & identity middleware for AI answer review endpoints.
 * Rejects missing/malformed/expired Bearer tokens with 401 Unauthorized.
 * Completely ignores X-Test-Bypass, X-View-As, X-User-Role, or client-provided body email.
 */
export async function requireStrictReviewAuth(
  req: ReviewAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Bearer token cannot be empty' });
    return;
  }

  // Structured JWT parser
  const parts = token.split('.');
  if (parts.length !== 3) {
    res.status(401).json({ error: 'Unauthorized: Malformed JWT token' });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    res.status(401).json({ error: 'Unauthorized: Invalid token payload' });
    return;
  }

  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
    res.status(401).json({ error: 'Unauthorized: Token has expired' });
    return;
  }

  const email = (
    payload.email ||
    (payload.user_metadata as any)?.email ||
    (payload.app_metadata as any)?.email ||
    ''
  )
    .toString()
    .trim()
    .toLowerCase();

  if (!email || !email.includes('@')) {
    res.status(401).json({ error: 'Unauthorized: Missing email claim in token' });
    return;
  }

  // Live Supabase verification if configured and not running with test store
  if (isSupabaseConfigured() && !isTestReviewStoreEnabled()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) {
        res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
        return;
      }
    } catch (err: any) {
      res.status(401).json({ error: `Unauthorized: ${err.message}` });
      return;
    }
  }

  // Server-derived role (strictly ignores forged headers or body claims)
  const role = await getServerUserRole(email);

  req.actor = {
    email,
    role,
    id: typeof payload.sub === 'string' ? payload.sub : undefined,
  };

  next();
}

// ---------------------------------------------------------------------------
// Operator Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/reviews/operator
 * Returns list of pending_operator review items assigned to this operator.
 */
reviewsRouter.get(
  '/operator',
  requireStrictReviewAuth,
  async (req: ReviewAuthenticatedRequest, res: Response): Promise<void> => {
    const actor = req.actor!;
    if (actor.role !== 'operator' && actor.role !== 'dev' && actor.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden: operator role required' });
      return;
    }

    try {
      const reviews = await listOperatorReviews({
        operatorEmail: actor.email,
        role: actor.role,
      });
      res.status(200).json({ success: true, reviews, count: reviews.length });
    } catch (err: any) {
      log.error(`[ReviewRoutes] listOperatorReviews failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || 'Failed to list operator reviews' });
    }
  }
);

/**
 * POST /api/reviews/:id/operator-action
 * Action: 'approve' | 'edit' | 'deny'.
 * Always advances the review item to 'pending_manager'.
 * Returns 409 Conflict on stale revision.
 * Replay-safe via idempotencyKey.
 */
reviewsRouter.post(
  '/:id/operator-action',
  requireStrictReviewAuth,
  async (req: ReviewAuthenticatedRequest, res: Response): Promise<void> => {
    const actor = req.actor!;
    if (actor.role !== 'operator' && actor.role !== 'dev' && actor.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden: operator role required' });
      return;
    }

    const reviewId = extractParamId(req.params.id);
    const review = await getReviewById(reviewId);
    if (!review) {
      res.status(404).json({ error: `Review item ${reviewId} not found` });
      return;
    }

    // Scoping check: verify candidate/application assignment
    if (actor.role === 'operator') {
      const allowed = await isOperatorAllowedForReview(actor.email, review);
      if (!allowed) {
        res.status(403).json({ error: 'Forbidden: unassigned candidate or application' });
        return;
      }
    }

    const { action, editedValue, expectedRevision, idempotencyKey } = req.body || {};

    if (!['approve', 'edit', 'deny'].includes(action)) {
      res.status(400).json({ error: 'Invalid action. Must be approve, edit, or deny' });
      return;
    }

    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision is required and must be an integer' });
      return;
    }

    if (
      action === 'edit' &&
      (!editedValue || typeof editedValue !== 'string' || !editedValue.trim())
    ) {
      res.status(400).json({ error: 'Edited value must be provided for edit action' });
      return;
    }

    try {
      const result = await operatorReviewAction({
        reviewId,
        expectedRevision,
        action,
        editedValue,
        actorEmail: actor.email,
        idempotencyKey,
      });

      res.status(200).json({
        success: true,
        review: result.review,
        cached: result.cached,
      });
    } catch (err: any) {
      const message = err?.message || 'Operator review action failed';
      if (message.includes('Stale revision')) {
        res.status(409).json({ error: message });
        return;
      }
      res.status(400).json({ error: message });
    }
  }
);

// ---------------------------------------------------------------------------
// Manager Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/reviews/manager
 * Returns list of pending_manager review items scoped to this manager's team.
 */
reviewsRouter.get(
  '/manager',
  requireStrictReviewAuth,
  async (req: ReviewAuthenticatedRequest, res: Response): Promise<void> => {
    const actor = req.actor!;
    if (actor.role !== 'manager' && actor.role !== 'dev' && actor.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden: manager role required' });
      return;
    }

    try {
      const reviews = await listManagerReviews({
        managerEmail: actor.email,
        role: actor.role,
      });
      res.status(200).json({ success: true, reviews, count: reviews.length });
    } catch (err: any) {
      log.error(`[ReviewRoutes] listManagerReviews failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || 'Failed to list manager reviews' });
    }
  }
);

/**
 * POST /api/reviews/:id/manager-action
 * Action: 'approve' | 'edit' | 'reject'.
 * Business rule: an operator-denied proposal cannot be approved without providing an edited replacement.
 * Returns 409 Conflict on stale revision.
 * Replay-safe via idempotencyKey.
 */
reviewsRouter.post(
  '/:id/manager-action',
  requireStrictReviewAuth,
  async (req: ReviewAuthenticatedRequest, res: Response): Promise<void> => {
    const actor = req.actor!;
    if (actor.role !== 'manager' && actor.role !== 'dev' && actor.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden: manager role required' });
      return;
    }

    const reviewId = extractParamId(req.params.id);
    const review = await getReviewById(reviewId);
    if (!review) {
      res.status(404).json({ error: `Review item ${reviewId} not found` });
      return;
    }

    // Scoping check: verify manager team scope
    if (actor.role === 'manager') {
      const allowed = await isManagerAllowedForReview(actor.email, review);
      if (!allowed) {
        res.status(403).json({ error: 'Forbidden: cross-team access not allowed' });
        return;
      }
    }

    const { action, editedValue, expectedRevision, idempotencyKey } = req.body || {};

    if (!['approve', 'edit', 'reject'].includes(action)) {
      res.status(400).json({ error: 'Invalid action. Must be approve, edit, or reject' });
      return;
    }

    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision is required and must be an integer' });
      return;
    }

    if (
      action === 'edit' &&
      (!editedValue || typeof editedValue !== 'string' || !editedValue.trim())
    ) {
      res.status(400).json({ error: 'Edited value must be provided for edit action' });
      return;
    }

    // Business rule: operator-denied proposal cannot be approved without an edited replacement
    if (
      action === 'approve' &&
      review.operator_action === 'denied' &&
      (!editedValue || !editedValue.trim())
    ) {
      res.status(400).json({
        error:
          'Cannot approve an operator-denied proposal without providing an edited replacement',
      });
      return;
    }

    try {
      const result = await managerReviewAction({
        reviewId,
        expectedRevision,
        action,
        editedValue,
        actorEmail: actor.email,
        idempotencyKey,
      });

      res.status(200).json({
        success: true,
        review: result.review,
        deletedQaCount: result.deletedQaCount,
        cached: result.cached,
      });
    } catch (err: any) {
      const message = err?.message || 'Manager review action failed';
      if (message.includes('Stale revision')) {
        res.status(409).json({ error: message });
        return;
      }
      if (message.includes('Cannot approve an operator-denied proposal')) {
        res.status(400).json({ error: message });
        return;
      }
      res.status(400).json({ error: message });
    }
  }
);

// ---------------------------------------------------------------------------
// Item Detail
// ---------------------------------------------------------------------------

/**
 * GET /api/reviews/:id
 * Fetches single review item with strict scoping check.
 */
reviewsRouter.get(
  '/:id',
  requireStrictReviewAuth,
  async (req: ReviewAuthenticatedRequest, res: Response): Promise<void> => {
    const actor = req.actor!;
    const reviewId = extractParamId(req.params.id);
    const review = await getReviewById(reviewId);
    if (!review) {
      res.status(404).json({ error: `Review item ${reviewId} not found` });
      return;
    }

    if (actor.role === 'operator') {
      const allowed = await isOperatorAllowedForReview(actor.email, review);
      if (!allowed) {
        res.status(403).json({ error: 'Forbidden: unassigned candidate or application' });
        return;
      }
    } else if (actor.role === 'manager') {
      const allowed = await isManagerAllowedForReview(actor.email, review);
      if (!allowed) {
        res.status(403).json({ error: 'Forbidden: cross-team access not allowed' });
        return;
      }
    }

    res.status(200).json({ success: true, review });
  }
);
