/**
 * @fileoverview Secure in-memory store for Email Signup OTP verification.
 *
 * Implements:
 * - 6-digit cryptographic numeric OTP generation.
 * - 10-minute expiry window.
 * - 5-attempt threshold before invalidation.
 * - 30-second resend cooldown rate-limiting.
 */

import crypto from 'crypto';

interface OtpRecord {
  otp: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

const OTP_EXPIRATION_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds

const store = new Map<string, OtpRecord>();

// Periodic cleanup of expired OTPs every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [email, record] of store.entries()) {
    if (now > record.expiresAt) {
      store.delete(email);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Normalizes email address for consistent dictionary lookup.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Checks if a new OTP can be requested or if cooldown is active.
 */
export function checkOtpCooldown(email: string): { allowed: boolean; waitSeconds?: number } {
  const key = normalizeEmail(email);
  const existing = store.get(key);
  if (!existing) return { allowed: true };

  const elapsed = Date.now() - existing.lastSentAt;
  if (elapsed < RESEND_COOLDOWN_MS) {
    const remainingSec = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
    return { allowed: false, waitSeconds: remainingSec };
  }

  return { allowed: true };
}

/**
 * Generates a secure 6-digit numeric OTP and stores it.
 */
export function generateAndStoreOtp(email: string): string {
  const key = normalizeEmail(email);
  const otp = crypto.randomInt(100000, 1000000).toString();
  const now = Date.now();

  store.set(key, {
    otp,
    expiresAt: now + OTP_EXPIRATION_MS,
    attempts: 0,
    lastSentAt: now,
  });

  return otp;
}

/**
 * Verifies the user-submitted OTP against stored entry.
 */
export function verifyStoredOtp(email: string, inputOtp: string): { valid: boolean; error?: string } {
  const key = normalizeEmail(email);
  const record = store.get(key);

  if (!record) {
    return {
      valid: false,
      error: 'No active verification code found. Please request a new code.',
    };
  }

  const now = Date.now();
  if (now > record.expiresAt) {
    store.delete(key);
    return {
      valid: false,
      error: 'Verification code has expired. Please request a new code.',
    };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    store.delete(key);
    return {
      valid: false,
      error: 'Too many incorrect attempts. Please request a new code.',
    };
  }

  const cleanInput = inputOtp.trim();
  if (record.otp !== cleanInput) {
    record.attempts += 1;
    const remaining = MAX_ATTEMPTS - record.attempts;
    if (remaining <= 0) {
      store.delete(key);
      return {
        valid: false,
        error: 'Too many incorrect attempts. Please request a new code.',
      };
    }
    return {
      valid: false,
      error: `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
    };
  }

  // Verification succeeded - consume the OTP
  store.delete(key);
  return { valid: true };
}

/**
 * Explicitly removes an OTP from the store.
 */
export function clearStoredOtp(email: string): void {
  store.delete(normalizeEmail(email));
}
