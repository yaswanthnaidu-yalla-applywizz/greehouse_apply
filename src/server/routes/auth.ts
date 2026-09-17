/**
 * @fileoverview Express Router for User Authentication (Sign In & Sign Up).
 *
 * Endpoints:
 * - POST /api/auth/verify-email: Checks email against authorized API and Supabase Auth.
 * - POST /api/auth/register: Registers new user in Supabase Auth if authorized.
 * - POST /api/auth/login: Authenticates user credentials via Supabase Auth.
 * - POST /api/auth/logout: Records sign-out (server log only; token cleared client-side).
 * - GET  /api/auth/me: Validates access token and returns user info.
 */

import { Router, Request, Response } from 'express';
import { getDbClient, getSupabaseServerApiKey, isSupabaseConfigured } from '../../db/client.js';
import { config } from '../../config/env.js';
import { sendOtpEmail } from '../../services/azureEmail.js';
import { checkOtpCooldown, generateAndStoreOtp, verifyStoredOtp } from '../../services/otpStore.js';
import { fetchAllowedCandidates, getYesterdayIST } from '../../services/workHistoryClient.js';
import { hydrateAdminProfilesFromWorkHistory } from '../../services/adminProfileHydrate.js';
import { setCachedWorkHistory } from '../workHistoryCache.js';
import { createLogger } from '../../utils/logger.js';
import { insertAuditEvent } from '../../db/events.js';
import { syncDashboardUserAfterSignIn } from '../../services/operatorManagerMapping.js';
import type { WorkHistoryResult } from '../../services/workHistoryClient.js';
import { getDashboardUserByEmail } from '../../db/users.js';
import { findAuthUserByEmail } from '../authUserLookup.js';
import { normalizeAppRole } from './requireRole.js';

const log = createLogger('Auth');

export const authRouter = Router();

const AUTHORIZED_EMAILS_API = config.AUTHORIZED_EMAILS_API || 'https://applywizz-ca-management.vercel.app/api/ca/emails';

export type AppRole = 'dev' | 'admin' | 'manager' | 'operator';

/** Privileged emails → role (keys stored lowercase; lookup always normalizes email first). */
const ROLE_BY_EMAIL: Record<string, Exclude<AppRole, 'operator'>> = {
  'yaswanthnaiduyalla@applywizz.ai': 'dev',
  'ramakrishna@applywizz.ai': 'admin',
  'anushabandreddy@applywizz.ai': 'admin',
  'balaji@applywizz.ai': 'manager',
  'ramakrishnaa.tejavath@applywizz.ai': 'manager',
};

/** Privileged emails that may sign up without the CA emails API. */
export const ALWAYS_ALLOWED_EMAILS = Object.keys(ROLE_BY_EMAIL);

export function normalizeAuthEmail(email?: string | null): string {
  return (email || '').trim().toLowerCase();
}

export function emailFromUserOrEmail(userOrEmail?: any): string {
  if (!userOrEmail) return '';
  if (typeof userOrEmail === 'string') return normalizeAuthEmail(userOrEmail);
  return normalizeAuthEmail(
    userOrEmail.email || userOrEmail.user_metadata?.email || ''
  );
}

/** Hardcoded privileged email map (break-glass override). */
export function resolveRoleFromEmail(email?: string | null): AppRole {
  const normalized = normalizeAuthEmail(email);
  if (!normalized) return 'operator';
  return ROLE_BY_EMAIL[normalized] || 'operator';
}

export function resolveRole(userOrEmail?: any): AppRole {
  return resolveRoleFromEmail(emailFromUserOrEmail(userOrEmail));
}

export function attachResolvedRole<T extends Record<string, any>>(
  user: T,
  email?: string | null,
  roleOverride?: AppRole
): T & { role: AppRole } {
  const role =
    roleOverride ??
    resolveEffectiveAppRole(email || emailFromUserOrEmail(user), (user as { role?: unknown }).role);
  return { ...user, role };
}

/** Request-time role: email map override, then JWT claim, else operator. */
export function resolveEffectiveAppRole(email?: string | null, jwtRole?: unknown): AppRole {
  const normalized = normalizeAuthEmail(email);
  if (normalized && ROLE_BY_EMAIL[normalized]) {
    return ROLE_BY_EMAIL[normalized];
  }
  const fromJwt = normalizeAppRole(jwtRole);
  if (fromJwt) return fromJwt;
  return 'operator';
}

/** Sign-in role precedence (map → users.role → operator). Pure helper for tests. */
export function resolveSignInRoleFromSources(
  normalizedEmail: string,
  dbRoleRaw: string | null | undefined
): AppRole {
  const mapped = ROLE_BY_EMAIL[normalizedEmail];
  if (mapped) return mapped;
  const dbRole = normalizeAppRole(dbRoleRaw);
  if (dbRole) return dbRole;
  return 'operator';
}

export function homePathForRole(role: AppRole): string {
  if (role === 'dev') return '/dev';
  if (role === 'admin') return '/admin';
  if (role === 'manager') return '/manager';
  return '/';
}

export function emailsForRole(role: Exclude<AppRole, 'operator'>): string[] {
  return Object.entries(ROLE_BY_EMAIL)
    .filter(([, mapped]) => mapped === role)
    .map(([email]) => email);
}

/** Dashboard session stays valid for 7 days via refresh_token rotation. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function tokensFromAuthPayload(
  payload: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    session?: { access_token?: string; refresh_token?: string; expires_in?: number };
  } | null | undefined,
  fallbackAccess?: string,
): { token: string; refreshToken: string | null; expiresIn: number; sessionTtlSeconds: number } {
  const nested = payload?.session;
  return {
    token: nested?.access_token || payload?.access_token || fallbackAccess || '',
    refreshToken: nested?.refresh_token || payload?.refresh_token || null,
    expiresIn: nested?.expires_in || payload?.expires_in || 3600,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
  };
}

async function refreshSupabaseSession(refreshToken: string): Promise<{
  token: string;
  refreshToken: string | null;
  expiresIn: number;
  sessionTtlSeconds: number;
}> {
  const res = await fetch(`${config.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      apikey: getSupabaseServerApiKey(),
      Authorization: `Bearer ${getSupabaseServerApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.msg || data.error_description || data.error || 'Session refresh failed.');
  }
  return tokensFromAuthPayload(data);
}

/** Org-wide operator access (ingest, hydrate, no CA filter). Missing email is never admin. */
export function isUserAdmin(userOrEmail?: any): boolean {
  const email = emailFromUserOrEmail(userOrEmail);
  if (!email) return false;
  const role = resolveRoleFromEmail(email);
  return role === 'dev' || role === 'admin';
}

/** Manager dashboard: managers and dev only. Missing email is never a manager. */
export function canAccessManagerDashboard(userOrEmail?: any): boolean {
  const email = emailFromUserOrEmail(userOrEmail);
  if (!email) return false;
  const role = resolveRoleFromEmail(email);
  return role === 'dev' || role === 'manager';
}

/** After JWT/session is issued — confirms role map (lowercase email). */
export function logAuthRoleResolved(email: string, role: AppRole): void {
  const normalized = normalizeAuthEmail(email);
  if (!normalized) return;
  log.info(`[Auth] ✅ ${normalized} resolved as ${role}`);
}

/** Only operators use ApplyWizz work_history on sign-in (CA assignment + manager mapping). */
export function shouldFetchOperatorWorkHistoryOnSignIn(role: AppRole): boolean {
  return role === 'operator';
}

/** Resolve role at sign-in (map → users.role → operator). */
export async function resolveSignInRoleForEmail(
  email: string
): Promise<{ normalizedEmail: string; role: AppRole }> {
  const normalizedEmail = normalizeAuthEmail(email);
  const mapped = ROLE_BY_EMAIL[normalizedEmail];
  if (mapped) {
    return { normalizedEmail, role: mapped };
  }
  const row = await getDashboardUserByEmail(normalizedEmail);
  const role = resolveSignInRoleFromSources(normalizedEmail, row?.role);
  return { normalizedEmail, role };
}

async function finalizeSuccessfulSignIn(input: {
  normalizedEmail: string;
  role: AppRole;
  userId: string;
  authUser: { email?: string | null; user_metadata?: Record<string, unknown> | null };
}): Promise<{ allowedCandidateIds: string[]; workHistoryUnreachable: boolean }> {
  let allowedCandidateIds: string[] = [];
  let workHistoryUnreachable = false;
  let whResult: WorkHistoryResult | undefined;

  if (input.role === 'operator') {
    whResult = await fetchAllowedCandidates(input.normalizedEmail);
    allowedCandidateIds = whResult.candidateIds;
    workHistoryUnreachable = whResult.unreachable;
    setCachedWorkHistory(
      input.normalizedEmail,
      whResult.records,
      whResult.candidateIds,
      workHistoryUnreachable,
      whResult.resolvedDate
    );
  }

  log.info(
    `[Auth] finalizeSuccessfulSignIn — email: ${input.normalizedEmail}, role: ${input.role}, workHistoryFetched: ${shouldFetchOperatorWorkHistoryOnSignIn(input.role)}`
  );

  // upsertDashboardUserOnSignIn runs inside syncDashboardUserAfterSignIn (users table).
  await syncDashboardUserAfterSignIn({
    email: input.normalizedEmail,
    role: input.role,
    authUser: input.authUser,
    whResult,
  });

  await persistRoleClaim(input.userId, input.role);
  void insertAuditEvent({
    actorEmail: input.normalizedEmail,
    actorRole: input.role,
    action: 'login',
    targetType: 'user',
    targetId: input.userId,
  });

  return { allowedCandidateIds, workHistoryUnreachable };
}

/** One-line logout audit log (call from POST /api/auth/logout). */
export function logAuthLogout(email: string): void {
  const normalized = normalizeAuthEmail(email);
  if (!normalized) return;
  log.info(`[Auth] 👋 ${normalized} logged out`);
}

async function persistRoleClaim(userId: string | undefined, role: AppRole): Promise<void> {
  if (!userId) return;
  try {
    const supabase = getDbClient();
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: { role },
    });
    if (error) {
      log.warn(`[Auth] Could not embed role claim: ${error.message}`);
    }
  } catch (err: any) {
    log.warn(`[Auth] Could not embed role claim: ${err?.message}`);
  }
}

/**
 * Checks whether an email is permitted to register.
 * Returns true if the email is in the role map, ALLOWED_SIGNUP_EMAILS env variable,
 * or returned by the CA management authorized emails API.
 */
export function isEmailAuthorized(email: string, authorizedList: string[]): boolean {
  const normalized = normalizeAuthEmail(email);
  if (resolveRoleFromEmail(normalized) !== 'operator') {
    return true;
  }
  const envAllowed = (config.ALLOWED_SIGNUP_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (envAllowed.includes(normalized)) {
    return true;
  }
  return authorizedList.includes(normalized);
}

/** Signup authorization when CA list may be skipped for existing dashboard users. */
export function isEmailAuthorizedForSignupSync(
  normalizedEmail: string,
  authorizedList: string[],
  hasDashboardUserRow: boolean
): boolean {
  if (resolveRoleFromEmail(normalizedEmail) !== 'operator') {
    return true;
  }
  if (hasDashboardUserRow) {
    return true;
  }
  return isEmailAuthorized(normalizedEmail, authorizedList);
}

export async function isEmailAuthorizedForSignup(
  email: string,
  authorizedList: string[]
): Promise<boolean> {
  const normalized = normalizeAuthEmail(email);
  const row = await getDashboardUserByEmail(normalized);
  return isEmailAuthorizedForSignupSync(normalized, authorizedList, Boolean(row));
}

/**
 * Helper to fetch and extract authorized emails from the management API.
 */
async function fetchAuthorizedEmails(): Promise<string[]> {
  const endpoint = config.AUTHORIZED_EMAILS_API || AUTHORIZED_EMAILS_API;
  try {
    const res = await fetch(endpoint);
    if (!res.ok) {
      throw new Error(`Failed to fetch authorized emails: HTTP ${res.status}`);
    }
    const data: any = await res.json();

    const emails: string[] = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') emails.push(item);
        else if (item && typeof item.email === 'string') emails.push(item.email);
      }
    } else if (data && Array.isArray(data.users)) {
      for (const u of data.users) {
        if (u && typeof u.email === 'string') emails.push(u.email);
      }
    } else if (data && Array.isArray(data.emails)) {
      for (const e of data.emails) {
        if (typeof e === 'string') emails.push(e);
      }
    }

    return emails.map((e) => e.trim().toLowerCase());
  } catch (err: any) {
    log.error(`[Auth] Error fetching authorized emails:`, err.message);
    throw err;
  }
}

/**
 * POST /api/auth/verify-email
 * Checks if the email is present in the authorized API and not already in Supabase Auth.
 */
authRouter.post('/verify-email', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required.' });
    return;
  }

  const normalizedEmail = normalizeAuthEmail(email);

  try {
    if (!isSupabaseConfigured()) {
      res.status(500).json({ error: 'Supabase is not configured on the server.' });
      return;
    }

    // 1. Fetch authorized list and check authorization
    let authorizedEmails: string[] = [];
    try {
      authorizedEmails = await fetchAuthorizedEmails();
    } catch (apiErr: any) {
      log.warn(`[Auth] ⚠️ CA Emails API query failed: ${apiErr.message}`);
    }

    const isAuthorized = await isEmailAuthorizedForSignup(normalizedEmail, authorizedEmails);

    if (!isAuthorized) {
      res.status(403).json({ error: 'Email not authorized to sign up.' });
      return;
    }

    const supabase = getDbClient();
    const { user: existingUser, error: lookupError } = await findAuthUserByEmail(normalizedEmail);
    if (lookupError) {
      log.error('[Auth] Failed to check existing auth users:', lookupError.message);
      res.status(500).json({ error: 'Failed to verify existing accounts.' });
      return;
    }

    if (existingUser) {
      const factorsRes = await (supabase.auth.admin as any)._listFactors({ userId: existingUser.id });
      const factors = factorsRes?.data?.factors || [];
      const hasVerifiedTotp = factors.some(
        (f: any) => f.factor_type === 'totp' && f.status === 'verified'
      );
      if (hasVerifiedTotp) {
        res.status(409).json({ error: 'Account already exists, please sign in.' });
        return;
      }
    }

    res.json({
      allowed: true,
      email: normalizedEmail,
      message: 'Email authorized.',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Verification failed.' });
  }
});

/**
 * POST /api/auth/send-signup-otp
 * Verifies email authorization and dispatches a 6-digit OTP email via Azure / M365.
 */
authRouter.post('/send-signup-otp', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required.' });
    return;
  }

  const normalizedEmail = normalizeAuthEmail(email);

  try {
    if (!isSupabaseConfigured()) {
      res.status(500).json({ error: 'Supabase is not configured on the server.' });
      return;
    }

    // 1. Verify authorization against ApplyWizz Management API & allowlist
    let authorizedEmails: string[] = [];
    try {
      authorizedEmails = await fetchAuthorizedEmails();
    } catch (apiErr: any) {
      log.warn(`[Auth] ⚠️ CA Emails API query failed: ${apiErr.message}`);
    }

    if (!(await isEmailAuthorizedForSignup(normalizedEmail, authorizedEmails))) {
      res.status(403).json({ error: 'Email not authorized to sign up.' });
      return;
    }

    const supabase = getDbClient();
    const { user: existingUser, error: lookupError } = await findAuthUserByEmail(normalizedEmail);
    if (lookupError) {
      log.error('[Auth] Failed to check existing accounts:', lookupError.message);
      res.status(500).json({ error: 'Failed to verify existing accounts.' });
      return;
    }

    if (existingUser) {
      const factorsRes = await (supabase.auth.admin as any)._listFactors({ userId: existingUser.id });
      const factors = factorsRes?.data?.factors || [];
      const hasVerifiedTotp = factors.some(
        (f: any) => f.factor_type === 'totp' && f.status === 'verified'
      );
      if (hasVerifiedTotp) {
        res.status(409).json({ error: 'Account already exists, please sign in.' });
        return;
      }
      log.info(`[Auth] User ${normalizedEmail} has unverified MFA setup. Permitting signup OTP to complete enrollment.`);
    }

    // 3. Check rate-limit cooldown
    const cooldown = checkOtpCooldown(normalizedEmail);
    if (!cooldown.allowed) {
      res.status(429).json({
        error: `Please wait ${cooldown.waitSeconds} seconds before requesting a new code.`,
        waitSeconds: cooldown.waitSeconds,
      });
      return;
    }

    // 4. Generate & store OTP
    const otp = generateAndStoreOtp(normalizedEmail);

    // 5. Send OTP email via Azure / Microsoft 365
    const emailResult = await sendOtpEmail({
      to: normalizedEmail,
      otp,
    });

    if (!emailResult.success) {
      res.status(500).json({ error: emailResult.error || 'Failed to dispatch verification email.' });
      return;
    }

    res.json({
      success: true,
      email: normalizedEmail,
      message: `Verification code sent to ${normalizedEmail}.`,
    });
  } catch (err: any) {
    log.error('[Auth] Error sending signup OTP:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send verification code.' });
  }
});

/**
 * POST /api/auth/verify-signup-otp
 * Verifies the 6-digit email OTP and initializes Microsoft Authenticator TOTP setup.
 */
authRouter.post('/verify-signup-otp', async (req: Request, res: Response): Promise<void> => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    res.status(400).json({ error: 'Email and verification code are required.' });
    return;
  }

  const normalizedEmail = normalizeAuthEmail(email);

  try {
    if (!isSupabaseConfigured()) {
      res.status(500).json({ error: 'Supabase is not configured on the server.' });
      return;
    }

    // 1. Verify OTP
    const otpResult = verifyStoredOtp(normalizedEmail, String(otp));
    if (!otpResult.valid) {
      res.status(400).json({ error: otpResult.error || 'Invalid verification code.' });
      return;
    }

    const supabase = getDbClient();
    const { user: foundUser, error: lookupError } = await findAuthUserByEmail(normalizedEmail);
    if (lookupError) {
      res.status(500).json({ error: 'Failed to query user records.' });
      return;
    }
    let user = foundUser;

    if (!user) {
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: normalizedEmail,
        email_confirm: true,
      });
      if (createError || !newUser?.user) {
        res.status(500).json({ error: createError?.message || 'Failed to provision user account.' });
        return;
      }
      user = newUser.user;
      void insertAuditEvent({
        actorEmail: normalizedEmail,
        actorRole: resolveRoleFromEmail(normalizedEmail),
        action: 'signup',
        targetType: 'user',
        targetId: user.id,
      });
    }

    // 3. Generate authenticated session via magiclink on backend
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: normalizedEmail,
    });

    if (linkError || !linkData?.properties?.email_otp) {
      res.status(500).json({ error: 'Failed to establish authentication session for MFA setup.' });
      return;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.verifyOtp({
      email: normalizedEmail,
      token: linkData.properties.email_otp,
      type: 'magiclink',
    });

    if (sessionError || !sessionData?.session?.access_token) {
      res.status(500).json({ error: sessionError?.message || 'Failed to authenticate session.' });
      return;
    }

    const token = sessionData.session.access_token;

    // Clean up any stale unverified factors for this user from aborted attempts
    try {
      const { data: factorList } = await supabase.auth.admin.mfa.listFactors({ userId: user.id });
      if (factorList?.factors) {
        for (const factor of factorList.factors) {
          if (factor.status === 'unverified') {
            await supabase.auth.admin.mfa.deleteFactor({ id: factor.id, userId: user.id });
          }
        }
      }
    } catch (cleanupErr: any) {
      log.warn('[Auth] Stale unverified factor cleanup skipped:', cleanupErr?.message);
    }

    // 4. Enroll Microsoft Authenticator (TOTP)
    const enrollRes = await fetch(`${config.SUPABASE_URL}/auth/v1/factors`, {
      method: 'POST',
      headers: {
        apikey: getSupabaseServerApiKey(),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        friendly_name: 'Microsoft Authenticator',
        factor_type: 'totp',
        issuer: 'ApplyWizz Greenhouse',
      }),
    });

    const enrollData: any = await enrollRes.json();
    if (!enrollRes.ok) {
      res.status(enrollRes.status).json({
        error: enrollData.msg || enrollData.error_description || 'Failed to initiate Microsoft Authenticator enrollment.',
      });
      return;
    }

    // Ensure raw SVG string is formatted as a base64 Data URI for image rendering
    let rawQr = enrollData.totp?.qr_code || enrollData.qr_code || '';
    let qrCode = rawQr;
    if (typeof rawQr === 'string' && rawQr.trim().length > 0) {
      let trimmedQr = rawQr.trim();
      if (!trimmedQr.startsWith('data:')) {
        if (trimmedQr.includes('<svg')) {
          if (!trimmedQr.includes('xmlns=')) {
            trimmedQr = trimmedQr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
          }
          const base64Svg = Buffer.from(trimmedQr, 'utf-8').toString('base64');
          qrCode = `data:image/svg+xml;base64,${base64Svg}`;
        } else {
          qrCode = `data:image/svg+xml;utf-8,${encodeURIComponent(trimmedQr)}`;
        }
      }
    }

    res.json({
      success: true,
      email: normalizedEmail,
      tempToken: token,
      factorId: enrollData.id,
      qrCode,
      secret: enrollData.totp?.secret || enrollData.secret,
      uri: enrollData.totp?.uri || enrollData.uri,
      user: sessionData.user || user,
    });
  } catch (err: any) {
    log.error('[Auth] verify-signup-otp error:', err.message);
    res.status(500).json({ error: err.message || 'Verification failed.' });
  }
});

/**
 * POST /api/auth/login
 * Passwordless Sign-In using Microsoft Authenticator (TOTP).
 */
authRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, code } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required.' });
    return;
  }

  const normalizedEmail = normalizeAuthEmail(email);

  try {
    if (!isSupabaseConfigured()) {
      res.status(500).json({ error: 'Supabase is not configured on the server.' });
      return;
    }

    const supabase = getDbClient();

    const { user, error: lookupError } = await findAuthUserByEmail(normalizedEmail);
    if (lookupError) {
      res.status(500).json({ error: 'Failed to query user records.' });
      return;
    }

    if (!user) {
      res.status(404).json({ error: 'Account not found. Please sign up.' });
      return;
    }

    // 2. Query user's enrolled MFA factors
    const factorsRes = await (supabase.auth.admin as any)._listFactors({ userId: user.id });
    const factors = factorsRes?.data?.factors || [];
    const verifiedTotp = factors.find(
      (f: any) => f.factor_type === 'totp' && f.status === 'verified'
    );

    if (!verifiedTotp) {
      res.status(403).json({
        error: 'Microsoft Authenticator is not configured for this account. Please sign up to link your authenticator.',
      });
      return;
    }

    // 3. If code not provided yet, return MFA challenge indicator
    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      res.json({
        mfaRequired: true,
        factorId: verifiedTotp.id,
        user: {
          id: user.id,
          email: user.email,
        },
      });
      return;
    }

    // 4. Authenticate and challenge factor
    const cleanCode = code.trim().replace(/\D/g, '');
    if (cleanCode.length !== 6) {
      res.status(400).json({ error: 'Please enter a valid 6-digit authenticator code.' });
      return;
    }

    // Create backend session for factor verification
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: normalizedEmail,
    });

    if (linkError || !linkData?.properties?.email_otp) {
      res.status(500).json({ error: 'Failed to prepare authentication challenge.' });
      return;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.verifyOtp({
      email: normalizedEmail,
      token: linkData.properties.email_otp,
      type: 'magiclink',
    });

    if (sessionError || !sessionData?.session?.access_token) {
      res.status(500).json({ error: sessionError?.message || 'Failed to authenticate session.' });
      return;
    }

    const tempToken = sessionData.session.access_token;

    // Challenge factor
    const challengeRes = await fetch(`${config.SUPABASE_URL}/auth/v1/factors/${verifiedTotp.id}/challenge`, {
      method: 'POST',
      headers: {
        apikey: getSupabaseServerApiKey(),
        Authorization: `Bearer ${tempToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const challengeData: any = await challengeRes.json();
    if (!challengeRes.ok) {
      res.status(challengeRes.status).json({
        error: challengeData.msg || challengeData.error_description || 'Failed to challenge Authenticator.',
      });
      return;
    }

    // Verify challenge
    const verifyRes = await fetch(`${config.SUPABASE_URL}/auth/v1/factors/${verifiedTotp.id}/verify`, {
      method: 'POST',
      headers: {
        apikey: getSupabaseServerApiKey(),
        Authorization: `Bearer ${tempToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        challenge_id: challengeData.id,
        code: cleanCode,
      }),
    });

    const verifyData: any = await verifyRes.json();
    if (!verifyRes.ok) {
      res.status(401).json({
        error: 'Invalid authenticator code. Please check Microsoft Authenticator and try again.',
      });
      return;
    }

    const { normalizedEmail: signInEmail, role } = await resolveSignInRoleForEmail(normalizedEmail);
    logAuthRoleResolved(signInEmail, role);
    const isAdmin = role === 'dev' || role === 'admin';
    const { allowedCandidateIds, workHistoryUnreachable } = await finalizeSuccessfulSignIn({
      normalizedEmail: signInEmail,
      role,
      userId: user.id,
      authUser: verifyData.user || user,
    });

    const sessionUser = attachResolvedRole(
      verifyData.user || { id: user.id, email: user.email },
      signInEmail,
      role
    );

    res.json({
      success: true,
      ...tokensFromAuthPayload(verifyData, tempToken),
      user: sessionUser,
      role,
      homePath: homePathForRole(role),
      allowedCandidateIds,
      workHistoryUnreachable,
      isAdmin,
    });
  } catch (err: any) {
    log.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: err.message || 'Sign in failed.' });
  }
});

/**
 * POST /api/auth/mfa/enroll
 * Starts Microsoft Authenticator / TOTP enrollment for the authenticated user.
 */
authRouter.post('/mfa/enroll', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header.' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const { config } = await import('../../config/env.js');

    const enrollRes = await fetch(`${config.SUPABASE_URL}/auth/v1/factors`, {
      method: 'POST',
      headers: {
        apikey: getSupabaseServerApiKey(),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        friendly_name: 'Microsoft Authenticator',
        factor_type: 'totp',
        issuer: 'ApplyWizz Greenhouse',
      }),
    });

    const data: any = await enrollRes.json();

    if (!enrollRes.ok) {
      res.status(enrollRes.status).json({ error: data.msg || data.error_description || data.error || 'MFA enrollment failed.' });
      return;
    }

    res.json({
      success: true,
      factorId: data.id,
      qrCode: data.totp?.qr_code,
      secret: data.totp?.secret,
      uri: data.totp?.uri,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'MFA enrollment failed.' });
  }
});

/**
 * POST /api/auth/mfa/verify
 * Verifies TOTP code from Microsoft Authenticator to complete setup or sign in.
 */
authRouter.post('/mfa/verify', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  const { factorId, code } = req.body;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header.' });
    return;
  }

  if (!factorId || !code) {
    res.status(400).json({ error: 'factorId and 6-digit code are required.' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const { config } = await import('../../config/env.js');

    // 1. Challenge factor
    const challengeRes = await fetch(`${config.SUPABASE_URL}/auth/v1/factors/${factorId}/challenge`, {
      method: 'POST',
      headers: {
        apikey: getSupabaseServerApiKey(),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const challengeData: any = await challengeRes.json();
    if (!challengeRes.ok) {
      res.status(challengeRes.status).json({
        error: challengeData.msg || challengeData.error_description || challengeData.message || 'Failed to create MFA challenge.',
      });
      return;
    }

    // 2. Verify challenge
    const verifyRes = await fetch(`${config.SUPABASE_URL}/auth/v1/factors/${factorId}/verify`, {
      method: 'POST',
      headers: {
        apikey: getSupabaseServerApiKey(),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        challenge_id: challengeData.id,
        code: String(code).trim(),
      }),
    });

    const verifyData: any = await verifyRes.json();
    if (!verifyRes.ok) {
      res.status(verifyRes.status).json({
        error: verifyData.msg || verifyData.error_description || verifyData.message || 'Invalid authenticator code. Please check your app.',
      });
      return;
    }

    const { normalizedEmail: userEmail, role } = await resolveSignInRoleForEmail(
      verifyData.user?.email || ''
    );
    logAuthRoleResolved(userEmail, role);
    const isAdmin = role === 'dev' || role === 'admin';
    let allowedCandidateIds: string[] = [];
    let workHistoryUnreachable = false;

    if (userEmail && verifyData.user?.id) {
      const finalized = await finalizeSuccessfulSignIn({
        normalizedEmail: userEmail,
        role,
        userId: verifyData.user.id,
        authUser: verifyData.user,
      });
      allowedCandidateIds = finalized.allowedCandidateIds;
      workHistoryUnreachable = finalized.workHistoryUnreachable;
    }

    res.json({
      success: true,
      ...tokensFromAuthPayload(verifyData, token),
      user: attachResolvedRole(verifyData.user || { email: userEmail }, userEmail),
      role,
      homePath: homePathForRole(role),
      allowedCandidateIds,
      workHistoryUnreachable,
      isAdmin,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'MFA verification failed.' });
  }
});

/**
 * POST /api/auth/hydrate-admin
 * Awaits org-wide work-history fetch and upserts profiles (admin session restore / dashboard gate).
 */
authRouter.post('/hydrate-admin', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header.' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    if (!isSupabaseConfigured()) {
      res.status(500).json({ error: 'Supabase is not configured on the server.' });
      return;
    }

    const supabase = getDbClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: 'Invalid or expired session token.' });
      return;
    }

    if (!isUserAdmin(data.user)) {
      res.status(403).json({ error: 'Admin access required.' });
      return;
    }

    const bodyDate = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
    const dateStr =
      /^\d{4}-\d{2}-\d{2}$/.test(bodyDate) ? bodyDate : getYesterdayIST();

    const hydratedCount = await hydrateAdminProfilesFromWorkHistory(dateStr);
    res.json({ success: true, hydratedCount, date: dateStr });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Admin hydration failed.' });
  }
});

/**
 * POST /api/auth/refresh
 * Rotates a Supabase refresh_token into a new access token. Session cap is 7 days (client).
 */
authRouter.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const refreshToken =
    (typeof req.body?.refreshToken === 'string' && req.body.refreshToken.trim()) ||
    (typeof req.body?.refresh_token === 'string' && req.body.refresh_token.trim()) ||
    '';

  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken is required.' });
    return;
  }

  try {
    if (!isSupabaseConfigured()) {
      res.status(500).json({ error: 'Supabase is not configured on the server.' });
      return;
    }

    const tokens = await refreshSupabaseSession(refreshToken);
    if (!tokens.token) {
      res.status(401).json({ error: 'Unauthorized: Invalid or expired session token.' });
      return;
    }

    res.json({ success: true, ...tokens });
  } catch (err: any) {
    res.status(401).json({ error: err.message || 'Unauthorized: Invalid or expired session token.' });
  }
});

/**
 * POST /api/auth/logout
 * Client-side session clear; server records a single logout audit line.
 */
authRouter.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header.' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    if (!isSupabaseConfigured()) {
      res.json({ success: true });
      return;
    }

    const supabase = getDbClient();
    const { data, error } = await supabase.auth.getUser(token);

    if (!error && data?.user?.email) {
      logAuthLogout(data.user.email);
      void insertAuditEvent({
        actorEmail: data.user.email,
        actorRole: resolveRoleFromEmail(data.user.email),
        action: 'logout',
        targetType: 'user',
        targetId: data.user.id,
      });
    }

    res.json({ success: true });
  } catch {
    res.json({ success: true });
  }
});

/**
 * GET /api/auth/me
 * Validates session token and returns current user details.
 */
authRouter.get('/me', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header.' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    if (!isSupabaseConfigured()) {
      res.status(500).json({ error: 'Supabase is not configured on the server.' });
      return;
    }

    const supabase = getDbClient();
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      res.status(401).json({ error: 'Invalid or expired session token.' });
      return;
    }

    const appMeta = data.user.app_metadata as Record<string, unknown> | undefined;
    const jwtRole = appMeta?.role ?? (data.user as { role?: unknown }).role;
    const role = resolveEffectiveAppRole(data.user.email, jwtRole);
    res.json({
      valid: true,
      user: {
        id: data.user.id,
        email: data.user.email,
        role,
      },
      role,
      homePath: homePathForRole(role),
      isAdmin: role === 'dev' || role === 'admin',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Token verification failed.' });
  }
});
