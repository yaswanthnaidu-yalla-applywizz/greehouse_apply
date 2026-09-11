/**
 * @fileoverview Express Router for User Authentication (Sign In & Sign Up).
 *
 * Endpoints:
 * - POST /api/auth/verify-email: Checks email against authorized API and Supabase Auth.
 * - POST /api/auth/register: Registers new user in Supabase Auth if authorized.
 * - POST /api/auth/login: Authenticates user credentials via Supabase Auth.
 * - GET  /api/auth/me: Validates access token and returns user info.
 */

import { Router, Request, Response } from 'express';
import { getDbClient, isSupabaseConfigured } from '../../db/client.js';
import { config } from '../../config/env.js';
import { sendOtpEmail } from '../../services/azureEmail.js';
import { checkOtpCooldown, generateAndStoreOtp, verifyStoredOtp } from '../../services/otpStore.js';
import { fetchAllowedCandidates, getISTDateString } from '../../services/workHistoryClient.js';
import { hydrateAdminProfilesFromWorkHistory } from '../../services/adminProfileHydrate.js';
import { setCachedWorkHistory } from '../workHistoryCache.js';

export const authRouter = Router();

const AUTHORIZED_EMAILS_API = config.AUTHORIZED_EMAILS_API || 'https://applywizz-ca-management.vercel.app/api/ca/emails';

/**
 * Hardcoded allowlist of administrative emails explicitly permitted to sign up,
 * bypassing external CA management API dependencies.
 */
export const ALWAYS_ALLOWED_EMAILS = [
  'yaswanthnaiduyalla@applywizz.ai',
  'yaswanhnaiduyalla@applywizz.ai',
];

/**
 * Checks whether a given user object, session, or email belongs to an administrator.
 */
export function isUserAdmin(userOrEmail?: any): boolean {
  if (!userOrEmail) return true; // Offline / test / dev bypass without email

  let email = '';
  let role = '';

  if (typeof userOrEmail === 'string') {
    email = userOrEmail;
  } else if (typeof userOrEmail === 'object') {
    email = userOrEmail.email || userOrEmail.user_metadata?.email || '';
    role = userOrEmail.role || userOrEmail.app_metadata?.role || userOrEmail.user_metadata?.role || '';
  }

  if (role === 'admin') return true;

  const normalized = email.trim().toLowerCase();
  if (!normalized) return true; // Unauthenticated / dev requests default to admin

  if (ALWAYS_ALLOWED_EMAILS.some((e) => e.trim().toLowerCase() === normalized)) {
    return true;
  }

  const envAllowed = (config.ALLOWED_SIGNUP_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (envAllowed.includes(normalized)) {
    return true;
  }

  if (process.env.ADMIN_EMAILS) {
    const envAdmins = process.env.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (envAdmins.includes(normalized)) {
      return true;
    }
  }

  // Common administrator email patterns
  if (
    normalized.startsWith('yaswanth') ||
    normalized.startsWith('admin@') ||
    normalized.startsWith('operator@')
  ) {
    return true;
  }

  return false;
}

/**
 * Checks whether an email is permitted to register.
 * Returns true if the email is in the admin allowlist, ALLOWED_SIGNUP_EMAILS env variable,
 * or returned by the CA management authorized emails API.
 */
export function isEmailAuthorized(email: string, authorizedList: string[]): boolean {
  const normalized = email.trim().toLowerCase();
  if (isUserAdmin(normalized)) {
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
    console.error(`[Auth] Error fetching authorized emails:`, err.message);
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

  const normalizedEmail = email.trim().toLowerCase();

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
      console.warn(`[Auth] ⚠️ CA Emails API query failed: ${apiErr.message}`);
    }

    const isAuthorized = isEmailAuthorized(normalizedEmail, authorizedEmails);

    if (!isAuthorized) {
      res.status(403).json({ error: 'Email not authorized to sign up.' });
      return;
    }

    // 2. Check if already exists in Supabase Auth
    const supabase = getDbClient();
    const { data: usersData, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) {
      console.error('[Auth] Failed to check existing auth users:', listError.message);
      res.status(500).json({ error: 'Failed to verify existing accounts.' });
      return;
    }

    const existingUser = usersData?.users?.find(
      (u) => u.email?.trim().toLowerCase() === normalizedEmail
    );

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

  const normalizedEmail = email.trim().toLowerCase();

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
      console.warn(`[Auth] ⚠️ CA Emails API query failed: ${apiErr.message}`);
    }

    if (!isEmailAuthorized(normalizedEmail, authorizedEmails)) {
      res.status(403).json({ error: 'Email not authorized to sign up.' });
      return;
    }

    // 2. Check if account already exists
    const supabase = getDbClient();
    const { data: usersData, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) {
      console.error('[Auth] Failed to check existing accounts:', listError.message);
      res.status(500).json({ error: 'Failed to verify existing accounts.' });
      return;
    }

    const existingUser = usersData?.users?.find(
      (u) => u.email?.trim().toLowerCase() === normalizedEmail
    );

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
      console.log(`[Auth] User ${normalizedEmail} has unverified MFA setup. Permitting signup OTP to complete enrollment.`);
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
    console.error('[Auth] Error sending signup OTP:', err.message);
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

  const normalizedEmail = email.trim().toLowerCase();

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

    // 2. Ensure user exists in Supabase Auth (create without password)
    const supabase = getDbClient();
    const { data: usersData } = await supabase.auth.admin.listUsers();
    let user = usersData?.users?.find((u) => u.email?.trim().toLowerCase() === normalizedEmail);

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
      console.warn('[Auth] Stale unverified factor cleanup skipped:', cleanupErr?.message);
    }

    // 4. Enroll Microsoft Authenticator (TOTP)
    const enrollRes = await fetch(`${config.SUPABASE_URL}/auth/v1/factors`, {
      method: 'POST',
      headers: {
        apikey: config.SUPABASE_SERVICE_KEY || '',
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
    console.error('[Auth] verify-signup-otp error:', err.message);
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

  const normalizedEmail = email.trim().toLowerCase();

  try {
    if (!isSupabaseConfigured()) {
      res.status(500).json({ error: 'Supabase is not configured on the server.' });
      return;
    }

    const supabase = getDbClient();

    // 1. Locate user in Supabase Auth
    const { data: usersData, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) {
      res.status(500).json({ error: 'Failed to query user records.' });
      return;
    }

    const user = usersData?.users?.find(
      (u) => u.email?.trim().toLowerCase() === normalizedEmail
    );

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
        apikey: config.SUPABASE_SERVICE_KEY || '',
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
        apikey: config.SUPABASE_SERVICE_KEY || '',
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

    // Fetch work-history for CA filtering (skip for admins)
    let allowedCandidateIds: string[] = [];
    let workHistoryUnreachable = false;
    const isAdmin = isUserAdmin(normalizedEmail);

    if (!isAdmin) {
      const whResult = await fetchAllowedCandidates(normalizedEmail);
      allowedCandidateIds = whResult.candidateIds;
      workHistoryUnreachable = whResult.unreachable;
      setCachedWorkHistory(normalizedEmail, whResult.records, whResult.candidateIds, workHistoryUnreachable, whResult.resolvedDate);
    } else {
      try {
        await hydrateAdminProfilesFromWorkHistory(getISTDateString(0));
      } catch (hydrateErr: any) {
        console.warn('[Auth] Admin profile hydration on login failed:', hydrateErr?.message);
      }
    }

    res.json({
      success: true,
      token: verifyData.access_token || tempToken,
      user: verifyData.user || {
        id: user.id,
        email: user.email,
      },
      allowedCandidateIds,
      workHistoryUnreachable,
      isAdmin,
    });
  } catch (err: any) {
    console.error('[Auth] Login error:', err.message);
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
        apikey: config.SUPABASE_SERVICE_KEY || '',
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
        apikey: config.SUPABASE_SERVICE_KEY || '',
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
        apikey: config.SUPABASE_SERVICE_KEY || '',
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

    const userEmail = (verifyData.user?.email || '').trim().toLowerCase();
    let allowedCandidateIds: string[] = [];
    let workHistoryUnreachable = false;
    const isAdmin = isUserAdmin(verifyData.user || userEmail);

    if (userEmail && !isAdmin) {
      const whResult = await fetchAllowedCandidates(userEmail);
      allowedCandidateIds = whResult.candidateIds;
      workHistoryUnreachable = whResult.unreachable;
      setCachedWorkHistory(userEmail, whResult.records, whResult.candidateIds, workHistoryUnreachable, whResult.resolvedDate);
    } else if (isAdmin) {
      try {
        await hydrateAdminProfilesFromWorkHistory(getISTDateString(0));
      } catch (hydrateErr: any) {
        console.warn('[Auth] Admin profile hydration on MFA verify failed:', hydrateErr?.message);
      }
    }

    res.json({
      success: true,
      token: verifyData.access_token || token,
      user: verifyData.user,
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
      /^\d{4}-\d{2}-\d{2}$/.test(bodyDate) ? bodyDate : getISTDateString(0);

    const hydratedCount = await hydrateAdminProfilesFromWorkHistory(dateStr);
    res.json({ success: true, hydratedCount, date: dateStr });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Admin hydration failed.' });
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

    res.json({
      valid: true,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Token verification failed.' });
  }
});
