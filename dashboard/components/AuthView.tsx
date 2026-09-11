/**
 * @fileoverview AuthView Component for Operator Sign In and Sign Up with Azure Email OTP and Microsoft Authenticator TOTP.
 *
 * Implements:
 * - Email OTP verification via Azure Communication Services / Microsoft 365.
 * - Passwordless signup flow (Email -> Email OTP -> Microsoft Authenticator Setup).
 * - Passwordless signin flow using Microsoft Authenticator (TOTP) only.
 * - Neo-brutalist styling aligned with ApplyWizz design system.
 */

import React, { useState, useEffect } from 'react';

export interface AuthUser {
  id: string;
  email: string;
}

interface AuthViewProps {
  onAuthSuccess: (user: AuthUser) => void;
  apiBaseUrl?: string;
}

type AuthMode = 'signin' | 'signup';
type SignUpStep = 'email' | 'otp' | 'mfa_enroll';

export const formatQrCodeSrc = (qr: string): string => {
  if (!qr) return '';
  let trimmed = qr.trim();
  if (trimmed.startsWith('data:image/')) return trimmed;
  if (trimmed.startsWith('<svg') || trimmed.includes('<svg')) {
    if (!trimmed.includes('xmlns=')) {
      trimmed = trimmed.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    try {
      return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(trimmed)))}`;
    } catch {
      return `data:image/svg+xml;utf-8,${encodeURIComponent(trimmed)}`;
    }
  }
  return trimmed;
};

export const AuthView: React.FC<AuthViewProps> = ({ onAuthSuccess, apiBaseUrl = '' }) => {
  const [tab, setTab] = useState<AuthMode>('signin');

  // Sign In state (Passwordless - Email + Microsoft Authenticator TOTP)
  const [signInEmail, setSignInEmail] = useState('');
  const [signInTotpCode, setSignInTotpCode] = useState('');
  const [signInStep, setSignInStep] = useState<'prompt' | 'verify'>('prompt');
  const [signInLoading, setSignInLoading] = useState(false);
  const [signInError, setSignInError] = useState('');
  const [signInSuccessMsg, setSignInSuccessMsg] = useState('');

  // Sign Up state (Passwordless - Email -> Azure OTP -> Microsoft Authenticator Setup)
  const [signUpEmail, setSignUpEmail] = useState('');
  const [signUpOtpCode, setSignUpOtpCode] = useState('');
  const [signUpStep, setSignUpStep] = useState<SignUpStep>('email');
  const [signUpLoading, setSignUpLoading] = useState(false);
  const [signUpError, setSignUpError] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  // Microsoft Authenticator Enrollment State
  const [mfaFactorId, setMfaFactorId] = useState('');
  const [mfaTempToken, setMfaTempToken] = useState('');
  const [mfaQrCode, setMfaQrCode] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [mfaTotpCode, setMfaTotpCode] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaError, setMfaError] = useState('');
  const [pendingUser, setPendingUser] = useState<AuthUser | null>(null);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const interval = setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendCooldown]);

  const resetAll = () => {
    setSignInError('');
    setSignUpError('');
    setMfaError('');
    setSignUpStep('email');
    setSignInStep('prompt');
    setSignUpOtpCode('');
    setMfaTotpCode('');
    setMfaQrCode('');
    setMfaSecret('');
    setMfaFactorId('');
    setMfaTempToken('');
    setPendingUser(null);
  };

  // -------------------------------------------------------------
  // Sign Up Handlers
  // -------------------------------------------------------------

  // Step 1: Send OTP to email via Azure / M365
  const handleSendSignUpOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSignUpError('');
    const trimmed = signUpEmail.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setSignUpError('Please enter a valid email address.');
      return;
    }

    setSignUpLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/send-signup-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSignUpError(data.error || 'Failed to dispatch verification code.');
        return;
      }

      setSignUpStep('otp');
      setResendCooldown(30);
    } catch (err: any) {
      setSignUpError('Network error dispatching verification email. Please check your connection.');
    } finally {
      setSignUpLoading(false);
    }
  };

  // Step 2: Verify 6-digit Email OTP and load Microsoft Authenticator QR code
  const handleVerifySignUpOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSignUpError('');
    const cleanOtp = signUpOtpCode.trim().replace(/\D/g, '');
    if (!cleanOtp || cleanOtp.length !== 6) {
      setSignUpError('Please enter the 6-digit verification code sent to your email.');
      return;
    }

    setSignUpLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/verify-signup-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: signUpEmail.trim(),
          otp: cleanOtp,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSignUpError(data.error || 'Verification failed. Please check the code and try again.');
        return;
      }

      // Store temp token and Authenticator enrollment payload
      setMfaTempToken(data.tempToken);
      setMfaFactorId(data.factorId);
      setMfaQrCode(data.qrCode || '');
      setMfaSecret(data.secret || '');
      if (data.user) setPendingUser(data.user);

      setSignUpStep('mfa_enroll');
    } catch (err: any) {
      setSignUpError('Network error validating code. Please try again.');
    } finally {
      setSignUpLoading(false);
    }
  };

  // Step 3: Verify Microsoft Authenticator code to activate account
  const handleCompleteMfaSetup = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setMfaError('');
    const cleanCode = mfaTotpCode.trim().replace(/\D/g, '');
    if (!cleanCode || cleanCode.length !== 6) {
      setMfaError('Please enter the 6-digit code from Microsoft Authenticator.');
      return;
    }

    setMfaLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/mfa/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mfaTempToken}`,
        },
        body: JSON.stringify({
          factorId: mfaFactorId,
          code: cleanCode,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setMfaError(data.error || 'Invalid authenticator code. Please check Microsoft Authenticator.');
        return;
      }

      const verifiedUser = data.user || pendingUser || {
        id: 'operator',
        email: signUpEmail.trim(),
      };

      localStorage.setItem('applywizz_auth_token', data.token);
      localStorage.setItem('applywizz_auth_user', JSON.stringify(verifiedUser));
      if (data.isAdmin) {
        localStorage.setItem('applywizz_is_admin', 'true');
      } else {
        localStorage.removeItem('applywizz_is_admin');
      }
      if (data.workHistoryUnreachable) {
        localStorage.setItem('applywizz_wh_unreachable', 'true');
      } else {
        localStorage.removeItem('applywizz_wh_unreachable');
      }
      onAuthSuccess(verifiedUser);
    } catch (err: any) {
      setMfaError('Network error activating Microsoft Authenticator.');
    } finally {
      setMfaLoading(false);
    }
  };

  // -------------------------------------------------------------
  // Sign In Handler (Passwordless - Microsoft Authenticator)
  // -------------------------------------------------------------
  const handleSignIn = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSignInError('');
    setSignInSuccessMsg('');
    const trimmedEmail = signInEmail.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setSignInError('Please enter your email address.');
      return;
    }

    const cleanCode = signInTotpCode.trim().replace(/\D/g, '');

    // If on prompt step and no code entered, check if account exists and requires MFA
    if (signInStep === 'prompt' && (!cleanCode || cleanCode.length < 6)) {
      setSignInLoading(true);
      try {
        const res = await fetch(`${apiBaseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: trimmedEmail }),
        });
        const data = await res.json();
        if (!res.ok) {
          setSignInError(data.error || 'Sign in failed.');
          return;
        }

        if (data.mfaRequired) {
          setSignInStep('verify');
          return;
        }
      } catch (err: any) {
        setSignInError('Network error. Please try again.');
      } finally {
        setSignInLoading(false);
      }
      return;
    }

    if (cleanCode.length !== 6) {
      setSignInError('Please enter the 6-digit code from Microsoft Authenticator.');
      return;
    }

    setSignInLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmedEmail,
          code: cleanCode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSignInError(data.error || 'Invalid authenticator code. Please check your app.');
        return;
      }

      localStorage.setItem('applywizz_auth_token', data.token);
      localStorage.setItem('applywizz_auth_user', JSON.stringify(data.user));
      if (data.isAdmin) {
        localStorage.setItem('applywizz_is_admin', 'true');
      } else {
        localStorage.removeItem('applywizz_is_admin');
      }
      if (data.workHistoryUnreachable) {
        localStorage.setItem('applywizz_wh_unreachable', 'true');
      } else {
        localStorage.removeItem('applywizz_wh_unreachable');
      }
      onAuthSuccess(data.user);
    } catch (err: any) {
      setSignInError('Network error during sign in.');
    } finally {
      setSignInLoading(false);
    }
  };

  // -------------------------------------------------------------
  // Step 3 UI: Microsoft Authenticator Enrollment (QR Setup)
  // -------------------------------------------------------------
  if (signUpStep === 'mfa_enroll') {
    return (
      <div className="w-full max-w-md bg-white border-2 border-[#1A1A2E] rounded-2xl shadow-[6px_6px_0px_#1A1A2E] p-8">
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-full bg-[#1A1A2E] text-[#FFF5EB] flex items-center justify-center font-black text-base border-2 border-[#1A1A2E] shadow-[2px_2px_0px_#E88474]">
            AW
          </div>
          <div>
            <h1 className="text-xl font-black text-[#1A1A2E] tracking-tight uppercase">ApplyWizz</h1>
            <span className="text-[11px] block font-mono text-[#64748B] font-bold tracking-wider">
              Setup Microsoft Authenticator
            </span>
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl p-4 shadow-[2px_2px_0px_#1A1A2E] text-center">
            <p className="text-xs font-bold text-[#1A1A2E] mb-3">
              Scan this QR code with <strong>Microsoft Authenticator</strong> on your phone:
            </p>
            {mfaQrCode ? (
              <div className="flex justify-center my-3">
                {mfaQrCode.trim().startsWith('<svg') ? (
                  <div
                    className="w-44 h-44 border-2 border-[#1A1A2E] rounded-xl p-1.5 bg-white shadow-[2px_2px_0px_#1A1A2E] flex items-center justify-center [&>svg]:w-full [&>svg]:h-full [&>svg]:block"
                    dangerouslySetInnerHTML={{ __html: mfaQrCode }}
                  />
                ) : (
                  <img
                    src={formatQrCodeSrc(mfaQrCode)}
                    alt="MFA QR Code"
                    className="w-44 h-44 border-2 border-[#1A1A2E] rounded-xl p-1 bg-white shadow-[2px_2px_0px_#1A1A2E] object-contain"
                  />
                )}
              </div>
            ) : (
              <div className="w-44 h-44 mx-auto border-2 border-[#1A1A2E] rounded-xl flex items-center justify-center bg-gray-100 text-xs font-mono text-gray-500">
                Loading QR Code...
              </div>
            )}

            {mfaSecret && (
              <div className="mt-2 text-left">
                <span className="text-[10px] uppercase font-bold tracking-wider text-[#64748B] block">
                  Manual Entry Key:
                </span>
                <code className="text-xs font-mono font-bold text-[#1A1A2E] break-all bg-white px-2 py-1 rounded border border-[#1A1A2E] inline-block mt-0.5">
                  {mfaSecret}
                </code>
              </div>
            )}
          </div>

          {mfaError && (
            <div className="bg-[#EF4444]/15 border-2 border-[#1A1A2E] text-[#991B1B] text-xs font-bold p-3 rounded-xl shadow-[2px_2px_0px_#1A1A2E] flex items-start gap-2">
              <span className="text-sm">⚠️</span>
              <span>{mfaError}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A2E] mb-1.5">
              Enter 6-Digit Code from App
            </label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={mfaTotpCode}
              onChange={(e) => setMfaTotpCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="w-full text-center tracking-[0.5em] text-lg font-mono font-black px-3.5 py-2.5 bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl text-[#1A1A2E] focus:outline-none focus:bg-white shadow-[2px_2px_0px_#1A1A2E]"
            />
          </div>

          <button
            type="button"
            onClick={() => handleCompleteMfaSetup()}
            disabled={mfaLoading || mfaTotpCode.length < 6}
            className="w-full py-3 bg-[#10B981] hover:bg-[#059669] text-white font-black text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[3px_3px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mfaLoading ? 'Activating Authenticator...' : 'Link & Complete Setup →'}
          </button>

          <button
            type="button"
            onClick={resetAll}
            className="w-full py-2 text-xs font-bold text-[#64748B] hover:text-[#1A1A2E] text-center"
          >
            Cancel & Back to Sign In
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // Sign In & Sign Up Main Card
  // -------------------------------------------------------------
  return (
    <div className="w-full max-w-md bg-white border-2 border-[#1A1A2E] rounded-2xl shadow-[6px_6px_0px_#1A1A2E] p-8">
      <div className="flex items-center justify-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-[#1A1A2E] text-[#FFF5EB] flex items-center justify-center font-black text-base border-2 border-[#1A1A2E] shadow-[2px_2px_0px_#E88474]">
          AW
        </div>
        <div>
          <h1 className="text-xl font-black text-[#1A1A2E] tracking-tight uppercase">ApplyWizz</h1>
          <span className="text-[11px] block font-mono text-[#64748B] font-bold tracking-wider">
            Operator Portal
          </span>
        </div>
      </div>

      <div className="flex border-2 border-[#1A1A2E] rounded-xl p-1 bg-[#FAF4EB] mb-6 shadow-[2px_2px_0px_#1A1A2E]">
        <button
          type="button"
          onClick={() => {
            setTab('signin');
            resetAll();
          }}
          className={`flex-1 py-2 text-xs font-black rounded-lg transition-all ${
            tab === 'signin'
              ? 'bg-[#E88474] text-white shadow-[1px_1px_0px_#1A1A2E]'
              : 'text-[#1A1A2E] hover:bg-[#FFF5EB]'
          }`}
        >
          Sign In
        </button>
        <button
          type="button"
          onClick={() => {
            setTab('signup');
            resetAll();
          }}
          className={`flex-1 py-2 text-xs font-black rounded-lg transition-all ${
            tab === 'signup'
              ? 'bg-[#E88474] text-white shadow-[1px_1px_0px_#1A1A2E]'
              : 'text-[#1A1A2E] hover:bg-[#FFF5EB]'
          }`}
        >
          Sign Up
        </button>
      </div>

      {tab === 'signin' ? (
        /* ------------------------------------------------------------- */
        /* Passwordless Sign In (Microsoft Authenticator)                */
        /* ------------------------------------------------------------- */
        <form onSubmit={handleSignIn} className="space-y-4">
          {signInSuccessMsg && (
            <div className="bg-[#9AC89A]/30 border-2 border-[#1A1A2E] text-[#1E4620] text-xs font-bold p-3 rounded-xl shadow-[2px_2px_0px_#1A1A2E] flex items-start gap-2">
              <span className="text-sm">✓</span>
              <span>{signInSuccessMsg}</span>
            </div>
          )}

          {signInError && (
            <div className="bg-[#EF4444]/15 border-2 border-[#1A1A2E] text-[#991B1B] text-xs font-bold p-3 rounded-xl shadow-[2px_2px_0px_#1A1A2E] flex items-start gap-2">
              <span className="text-sm">⚠️</span>
              <span>{signInError}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A2E] mb-1.5">
              Email Address
            </label>
            <input
              type="email"
              required
              value={signInEmail}
              onChange={(e) => setSignInEmail(e.target.value)}
              placeholder="e.g. operator@applywizz.com"
              className="w-full px-3.5 py-2.5 bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl text-xs font-medium text-[#1A1A2E] focus:outline-none focus:bg-white shadow-[2px_2px_0px_#1A1A2E]"
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A2E]">
                Microsoft Authenticator Code
              </label>
              <span className="text-[10px] font-mono font-bold text-[#E88474]">6 digits</span>
            </div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={signInTotpCode}
              onChange={(e) => setSignInTotpCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="w-full text-center tracking-[0.5em] text-lg font-mono font-black px-3.5 py-2.5 bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl text-[#1A1A2E] focus:outline-none focus:bg-white shadow-[2px_2px_0px_#1A1A2E]"
            />
            <p className="text-[11px] font-mono text-[#64748B] mt-1.5">
              Enter the 6-digit code currently shown in your Microsoft Authenticator app.
            </p>
          </div>

          <button
            type="submit"
            disabled={signInLoading}
            className="w-full mt-2 py-3 bg-[#E88474] hover:bg-[#d67262] text-white font-black text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[3px_3px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {signInLoading ? 'Authenticating...' : 'Sign In with Authenticator →'}
          </button>
        </form>
      ) : (
        /* ------------------------------------------------------------- */
        /* Passwordless Sign Up (Email OTP -> Microsoft Authenticator)  */
        /* ------------------------------------------------------------- */
        <div className="space-y-4">
          {signUpError && (
            <div className="bg-[#EF4444]/15 border-2 border-[#1A1A2E] text-[#991B1B] text-xs font-bold p-3 rounded-xl shadow-[2px_2px_0px_#1A1A2E] flex items-start gap-2">
              <span className="text-sm">⚠️</span>
              <span>{signUpError}</span>
            </div>
          )}

          {signUpStep === 'email' ? (
            /* Step 1: Input Email to receive Azure OTP */
            <form onSubmit={handleSendSignUpOtp} className="space-y-4">
              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A2E] mb-1.5">
                  Sign Up Email Address
                </label>
                <input
                  type="email"
                  required
                  value={signUpEmail}
                  onChange={(e) => setSignUpEmail(e.target.value)}
                  placeholder="e.g. operator@applywizz.com"
                  className="w-full px-3.5 py-2.5 bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl text-xs font-medium text-[#1A1A2E] focus:outline-none focus:bg-white shadow-[2px_2px_0px_#1A1A2E]"
                />
                <p className="text-[11px] font-mono text-[#64748B] mt-1.5">
                  We'll send a 6-digit one-time verification code to this address via Azure Communication Services.
                </p>
              </div>

              <button
                type="submit"
                disabled={signUpLoading}
                className="w-full py-3 bg-[#1A1A2E] hover:bg-[#2A2A3E] text-white font-black text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[3px_3px_0px_#E88474] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {signUpLoading ? 'Sending Verification Code...' : 'Send Verification Code →'}
              </button>
            </form>
          ) : (
            /* Step 2: Enter Email OTP */
            <form onSubmit={handleVerifySignUpOtp} className="space-y-4">
              <div className="bg-[#FAF4EB] border-2 border-[#1A1A2E] p-3 rounded-xl shadow-[2px_2px_0px_#1A1A2E] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm">📧</span>
                  <div>
                    <span className="text-[10px] uppercase font-bold tracking-wider text-[#64748B] block">Code sent to:</span>
                    <span className="text-xs font-mono font-bold text-[#1A1A2E]">{signUpEmail}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSignUpStep('email');
                    setSignUpOtpCode('');
                    setSignUpError('');
                  }}
                  className="text-[11px] font-bold text-[#E88474] hover:underline"
                >
                  Change
                </button>
              </div>

              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A2E] mb-1.5">
                  Enter 6-Digit Email Code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoFocus
                  value={signUpOtpCode}
                  onChange={(e) => setSignUpOtpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="w-full text-center tracking-[0.5em] text-lg font-mono font-black px-3.5 py-2.5 bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl text-[#1A1A2E] focus:outline-none focus:bg-white shadow-[2px_2px_0px_#1A1A2E]"
                />
                <div className="flex justify-between items-center mt-2">
                  <span className="text-[11px] font-mono text-[#64748B]">Valid for 10 minutes</span>
                  <button
                    type="button"
                    disabled={resendCooldown > 0 || signUpLoading}
                    onClick={() => handleSendSignUpOtp()}
                    className="text-[11px] font-bold text-[#1A1A2E] hover:text-[#E88474] underline disabled:text-gray-400 disabled:no-underline cursor-pointer disabled:cursor-not-allowed"
                  >
                    {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend Code'}
                  </button>
                </div>
              </div>

              <p className="text-[11px] font-mono text-[#64748B]">
                Passwords have been replaced with Microsoft Authenticator for higher security.
              </p>

              <button
                type="submit"
                disabled={signUpLoading || signUpOtpCode.length !== 6}
                className="w-full py-3 bg-[#E88474] hover:bg-[#d67262] text-white font-black text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[3px_3px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {signUpLoading ? 'Verifying Code...' : 'Verify & Continue to Authenticator Setup →'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};
