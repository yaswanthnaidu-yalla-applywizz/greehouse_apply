/**
 * Resolves the signed-in CA email from the authenticated request (Supabase JWT user).
 */
import type { Request } from 'express';

export function getAuthenticatedCaEmail(req: Request): string | null {
  const user = (req as { user?: { email?: string } }).user;
  const email = (user?.email || '').trim().toLowerCase();
  return email.length > 0 ? email : null;
}
