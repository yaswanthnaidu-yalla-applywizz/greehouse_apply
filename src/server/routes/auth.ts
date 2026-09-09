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

export const authRouter = Router();

const AUTHORIZED_EMAILS_API = 'https://applywizz-ca-management.vercel.app/api/ca/emails';

/**
 * Helper to fetch and extract authorized emails from the management API.
 */
async function fetchAuthorizedEmails(): Promise<string[]> {
  try {
    const res = await fetch(AUTHORIZED_EMAILS_API);
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

    // 1. Fetch authorized list
    const authorizedEmails = await fetchAuthorizedEmails();
    const isAuthorized = authorizedEmails.includes(normalizedEmail);

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

    const alreadyExists = usersData?.users?.some(
      (u) => u.email?.trim().toLowerCase() === normalizedEmail
    );

    if (alreadyExists) {
      res.status(409).json({ error: 'Account already exists, please sign in.' });
      return;
    }

    res.json({
      allowed: true,
      email: normalizedEmail,
      message: 'Email authorized. Please set your password.',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Verification failed.' });
  }
});

/**
 * POST /api/auth/register
 * Completes sign-up by creating user in Supabase Auth.
 */
authRouter.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { email, password, confirmPassword } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required.' });
    return;
  }

  if (!password || typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    return;
  }

  if (confirmPassword !== undefined && password !== confirmPassword) {
    res.status(400).json({ error: 'Passwords do not match.' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    if (!isSupabaseConfigured()) {
      res.status(500).json({ error: 'Supabase is not configured on the server.' });
      return;
    }

    // Re-verify authorization
    const authorizedEmails = await fetchAuthorizedEmails();
    if (!authorizedEmails.includes(normalizedEmail)) {
      res.status(403).json({ error: 'Email not authorized to sign up.' });
      return;
    }

    const supabase = getDbClient();
    const { data: userData, error: createError } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
    });

    if (createError) {
      if (
        createError.message.toLowerCase().includes('already registered') ||
        createError.message.toLowerCase().includes('already exists')
      ) {
        res.status(409).json({ error: 'Account already exists, please sign in.' });
        return;
      }
      res.status(400).json({ error: createError.message });
      return;
    }

    res.status(201).json({
      success: true,
      email: normalizedEmail,
      message: 'Account created successfully! Please sign in with your password.',
      userId: userData?.user?.id,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Registration failed.' });
  }
});

/**
 * POST /api/auth/login
 * Signs in using Supabase Auth password grant.
 */
authRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    if (!isSupabaseConfigured()) {
      res.status(500).json({ error: 'Supabase is not configured on the server.' });
      return;
    }

    const supabase = getDbClient();
    const { data, error: loginError } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (loginError || !data?.session) {
      res.status(401).json({ error: loginError?.message || 'Invalid email or password.' });
      return;
    }

    res.json({
      success: true,
      token: data.session.access_token,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Sign in failed.' });
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
