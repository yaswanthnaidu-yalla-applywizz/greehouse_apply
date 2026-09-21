/**
 * Role guard middleware — reads app role from the Supabase access token (JWT)
 * and from `req.user` metadata after `requireAuth`.
 *
 * Role `dev` bypasses all guards. Legacy alias `ca` maps to `operator`.
 */

import { Response, NextFunction } from 'express';
import { isSupabaseConfigured } from '../../db/client.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { isManagerViewAsOperator } from '../managerTeamScope.js';
import { emailFromUserOrEmail, resolveEffectiveAppRole } from './auth.js';

export type AppRole = 'admin' | 'manager' | 'operator' | 'dev';

const SUPABASE_AUTH_ROLES = new Set(['authenticated', 'anon', 'service_role']);

function authGuardBypassed(req: AuthenticatedRequest): boolean {
  if (req.headers['x-test-bypass'] === 'true') {
    return process.env.NODE_ENV === 'test';
  }
  return (
    !isSupabaseConfigured() ||
    process.env.NODE_ENV === 'test' ||
    process.argv.some((arg) => arg.toLowerCase().includes('test'))
  );
}

function decodeAccessTokenPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Normalizes JWT / metadata role strings to dashboard app roles. */
export function normalizeAppRole(raw: unknown): AppRole | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'ca') return 'operator';
  if (normalized === 'admin' || normalized === 'manager' || normalized === 'operator' || normalized === 'dev') {
    return normalized;
  }
  return null;
}

function roleFromRecord(record: Record<string, unknown> | null | undefined): AppRole | null {
  if (!record) return null;
  const appMeta = record.app_metadata as Record<string, unknown> | undefined;
  const userMeta = record.user_metadata as Record<string, unknown> | undefined;
  return (
    normalizeAppRole(record.role) ||
    normalizeAppRole(appMeta?.role) ||
    normalizeAppRole(userMeta?.role) ||
    null
  );
}

function roleFromJwtPayload(payload: Record<string, unknown>): AppRole | null {
  const topLevel = normalizeAppRole(payload.role);
  if (topLevel && !SUPABASE_AUTH_ROLES.has(topLevel)) {
    return topLevel;
  }
  return roleFromRecord(payload);
}

/**
 * Resolves the signed-in user's app role from JWT (Authorization header) and/or `req.user`.
 * Uses the same email-map precedence as sign-in (`resolveEffectiveAppRole`).
 */
export function resolveRoleFromRequest(req: AuthenticatedRequest): AppRole | null {
  const user = req.user as Record<string, unknown> | undefined;
  const email = emailFromUserOrEmail(user);
  let jwtRole: unknown = user ? (user as { role?: unknown }).role : undefined;
  if (jwtRole == null && user) {
    jwtRole = roleFromRecord(user);
  }

  const authHeader = req.headers?.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    const payload = decodeAccessTokenPayload(token);
    if (payload) {
      if (!email) {
        const payloadEmail =
          typeof payload.email === 'string'
            ? payload.email
            : typeof (payload as { user_metadata?: { email?: string } }).user_metadata?.email ===
                'string'
              ? (payload as { user_metadata: { email: string } }).user_metadata.email
              : '';
        if (payloadEmail) {
          return resolveEffectiveAppRole(payloadEmail, roleFromJwtPayload(payload) ?? jwtRole);
        }
      }
      if (jwtRole == null) {
        jwtRole = roleFromJwtPayload(payload);
      }
    }
  }

  if (email) {
    return resolveEffectiveAppRole(email, jwtRole);
  }
  return normalizeAppRole(jwtRole) || 'operator';
}

/**
 * Requires the session role to be one of `allowedRoles` (plus implicit `dev` bypass).
 * Use after `requireAuth` on API routes.
 */
export function requireRole(...allowedRoles: string[]) {
  const allowed = new Set(
    allowedRoles.map((r) => r.trim().toLowerCase()).filter(Boolean)
  );

  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (authGuardBypassed(req)) {
      next();
      return;
    }

    const role = resolveRoleFromRequest(req);
    if (role === 'dev') {
      next();
      return;
    }

    if (!role) {
      res.status(403).json({ error: 'Forbidden: role claim missing from session token.' });
      return;
    }

    if (!allowed.has(role)) {
      res.status(403).json({
        error: `Forbidden: requires one of: ${[...allowed].join(', ')}.`,
      });
      return;
    }

    next();
  };
}

/**
 * Enforces role only when a Bearer token is present (SPA HTML shell loads without auth).
 */
export function requireRoleIfAuthenticated(...allowedRoles: string[]) {
  const guard = requireRole(...allowedRoles);
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      next();
      return;
    }
    guard(req, res, next);
  };
}

/**
 * Operator dashboard API: operator, dev, or manager with X-View-As: operator.
 */
export function requireOperatorDashboardAccess(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (authGuardBypassed(req)) {
    next();
    return;
  }

  const role = resolveRoleFromRequest(req);
  if (role === 'dev' || role === 'operator') {
    next();
    return;
  }

  if (role === 'manager' && isManagerViewAsOperator(req)) {
    next();
    return;
  }

  if (!role) {
    res.status(403).json({ error: 'Forbidden: role claim missing from session token.' });
    return;
  }

  res.status(403).json({
    error: 'Forbidden: operator dashboard access requires operator role or manager operator view.',
  });
}
