/**
 * @fileoverview AuthView Component for Operator Sign In and Sign Up.
 *
 * Implements email authorization verification against ApplyWizz management API,
 * user account creation, and password sign in via Supabase Auth.
 */

import React, { useState } from 'react';

export interface AuthUser {
  id: string;
  email: string;
}

interface AuthViewProps {
  onAuthSuccess: (user: AuthUser) => void;
  apiBaseUrl?: string;
}

export const AuthView: React.FC<AuthViewProps> = ({ onAuthSuccess, apiBaseUrl = '' }) => {
  const [tab, setTab] = useState<'signin' | 'signup'>('signin');

  // Sign In state
  const [signInEmail, setSignInEmail] = useState('');
  const [signInPassword, setSignInPassword] = useState('');
  const [signInLoading, setSignInLoading] = useState(false);
  const [signInError, setSignInError] = useState('');
  const [signInSuccessMsg, setSignInSuccessMsg] = useState('');

  // Sign Up state
  const [signUpEmail, setSignUpEmail] = useState('');
  const [isEmailVerified, setIsEmailVerified] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [signUpError, setSignUpError] = useState('');
  const [signUpPassword, setSignUpPassword] = useState('');
  const [signUpConfirmPassword, setSignUpConfirmPassword] = useState('');
  const [registerLoading, setRegisterLoading] = useState(false);

  const handleVerifyEmail = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSignUpError('');
    const trimmed = signUpEmail.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setSignUpError('Please enter a valid email address.');
      return;
    }

    setVerifyLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSignUpError(data.error || 'Email authorization check failed.');
        return;
      }
      setIsEmailVerified(true);
    } catch (err: any) {
      setSignUpError('Network error checking email. Please try again.');
    } finally {
      setVerifyLoading(false);
    }
  };

  const handleRegister = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSignUpError('');
    if (!signUpPassword || signUpPassword.length < 6) {
      setSignUpError('Password must be at least 6 characters long.');
      return;
    }
    if (signUpPassword !== signUpConfirmPassword) {
      setSignUpError('Passwords do not match.');
      return;
    }

    setRegisterLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: signUpEmail.trim(),
          password: signUpPassword,
          confirmPassword: signUpConfirmPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSignUpError(data.error || 'Registration failed.');
        return;
      }

      // Transition to Sign In tab
      setSignInEmail(signUpEmail.trim());
      setSignInPassword('');
      setSignInError('');
      setSignInSuccessMsg('Account created successfully! Please sign in with your password.');
      setTab('signin');
      setIsEmailVerified(false);
      setSignUpPassword('');
      setSignUpConfirmPassword('');
    } catch (err: any) {
      setSignUpError('Network error during registration.');
    } finally {
      setRegisterLoading(false);
    }
  };

  const handleSignIn = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSignInError('');
    setSignInSuccessMsg('');
    const trimmedEmail = signInEmail.trim();
    if (!trimmedEmail || !signInPassword) {
      setSignInError('Please enter both email and password.');
      return;
    }

    setSignInLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmedEmail,
          password: signInPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSignInError(data.error || 'Invalid email or password.');
        return;
      }

      localStorage.setItem('applywizz_auth_token', data.token);
      localStorage.setItem('applywizz_auth_user', JSON.stringify(data.user));
      onAuthSuccess(data.user);
    } catch (err: any) {
      setSignInError('Network error during sign in.');
    } finally {
      setSignInLoading(false);
    }
  };

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
            setSignInError('');
            setSignUpError('');
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
            setSignInError('');
            setSignUpError('');
            setSignInSuccessMsg('');
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
            <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A2E] mb-1.5">
              Password
            </label>
            <input
              type="password"
              required
              value={signInPassword}
              onChange={(e) => setSignInPassword(e.target.value)}
              placeholder="Enter your password"
              className="w-full px-3.5 py-2.5 bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl text-xs font-medium text-[#1A1A2E] focus:outline-none focus:bg-white shadow-[2px_2px_0px_#1A1A2E]"
            />
          </div>

          <button
            type="submit"
            disabled={signInLoading}
            className="w-full mt-2 py-3 bg-[#E88474] hover:bg-[#d67262] text-white font-black text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[3px_3px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {signInLoading ? 'Signing In...' : 'Sign In →'}
          </button>
        </form>
      ) : (
        <div className="space-y-4">
          {signUpError && (
            <div className="bg-[#EF4444]/15 border-2 border-[#1A1A2E] text-[#991B1B] text-xs font-bold p-3 rounded-xl shadow-[2px_2px_0px_#1A1A2E] flex items-start gap-2">
              <span className="text-sm">⚠️</span>
              <span>{signUpError}</span>
            </div>
          )}

          {!isEmailVerified ? (
            <form onSubmit={handleVerifyEmail} className="space-y-4">
              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A2E] mb-1.5">
                  Verify Authorization Email
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
                  We check if your email is on the authorized team/client access list before signup.
                </p>
              </div>

              <button
                type="submit"
                disabled={verifyLoading}
                className="w-full py-3 bg-[#1A1A2E] hover:bg-[#2A2A3E] text-white font-black text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[3px_3px_0px_#E88474] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {verifyLoading ? 'Verifying Email...' : 'Confirm Email →'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4">
              <div className="bg-[#9AC89A]/30 border-2 border-[#1A1A2E] text-[#1E4620] p-3 rounded-xl shadow-[2px_2px_0px_#1A1A2E] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm">✓</span>
                  <div>
                    <span className="text-[10px] uppercase font-bold tracking-wider block">Authorized Email</span>
                    <span className="text-xs font-mono font-bold">{signUpEmail}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsEmailVerified(false);
                    setSignUpPassword('');
                    setSignUpConfirmPassword('');
                    setSignUpError('');
                  }}
                  className="text-[11px] font-bold underline hover:text-[#1A1A2E]"
                >
                  Change
                </button>
              </div>

              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A2E] mb-1.5">
                  Create Password
                </label>
                <input
                  type="password"
                  required
                  value={signUpPassword}
                  onChange={(e) => setSignUpPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className="w-full px-3.5 py-2.5 bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl text-xs font-medium text-[#1A1A2E] focus:outline-none focus:bg-white shadow-[2px_2px_0px_#1A1A2E]"
                />
              </div>

              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A2E] mb-1.5">
                  Confirm Password
                </label>
                <input
                  type="password"
                  required
                  value={signUpConfirmPassword}
                  onChange={(e) => setSignUpConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className="w-full px-3.5 py-2.5 bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl text-xs font-medium text-[#1A1A2E] focus:outline-none focus:bg-white shadow-[2px_2px_0px_#1A1A2E]"
                />
              </div>

              <button
                type="submit"
                disabled={registerLoading}
                className="w-full py-3 bg-[#E88474] hover:bg-[#d67262] text-white font-black text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[3px_3px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {registerLoading ? 'Creating Account...' : 'Complete Sign Up →'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};
