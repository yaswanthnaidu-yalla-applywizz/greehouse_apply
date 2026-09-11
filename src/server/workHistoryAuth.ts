/**
 * Resolves the signed-in CA email from the authenticated request (Supabase JWT user).
 */
import type { Request } from 'express';

/** Canonical ApplyWizz CA work-history API base (includes /api/ca/work-history). */
export const WORK_HISTORY_API_BASE_URL =
  'https://applywizz-ca-management.vercel.app/api/ca/work-history';

export function getAuthenticatedCaEmail(req: Request): string | null {
  const user = (req as { user?: { email?: string } }).user;
  const email = (user?.email || '').trim().toLowerCase();
  return email.length > 0 ? email : null;
}
