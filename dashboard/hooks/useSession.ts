/**
 * @fileoverview Session management and authenticated fetch hook for ApplyWizz Dashboard.
 *
 * Mirrors core session lifetime, JWT expiry tracking, refresh deduplication, 7-day cap,
 * and ops-mode header injection from roleAccess.js.
 */

import { useState, useEffect } from 'react';
import type { AuthUser } from '../components/AuthView.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_SKEW_MS = 5 * 60 * 1000; // 5 minutes before expiry
const AUTH_SKIP = /\/api\/auth\/(login|refresh|send-signup-otp|verify-signup-otp|register|verify-email)(?:\?|$)/;

export const TOKEN_KEY = 'applywizz_auth_token';
export const REFRESH_TOKEN_KEY = 'applywizz_refresh_token';
export const EXPIRES_AT_KEY = 'applywizz_session_expires_at';
export const USER_KEY = 'applywizz_auth_user';
export const ROLE_KEY = 'applywizz_role';
export const IS_ADMIN_KEY = 'applywizz_is_admin';
export const WH_UNREACHABLE_KEY = 'applywizz_wh_unreachable';
export const MANAGER_VIEW_AS_OPERATOR_KEY = 'applywizz_manager_view_as_operator';
export const VIEW_AS_MANAGER_EMAIL_KEY = 'applywizz_view_as_manager_email';

const ROLE_BY_EMAIL: Record<string, string> = {
  'yaswanthnaiduyalla@applywizz.ai': 'dev',
  'ramakrishna@applywizz.ai': 'admin',
  'anushabandreddy@applywizz.ai': 'admin',
  'balaji@applywizz.ai': 'manager',
  'ramakrishnaa.tejavath@applywizz.ai': 'manager',
};

let refreshInFlight: Promise<string | null> | null = null;

export function sessionUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function sessionUserEmail(): string {
  const user = sessionUser();
  return user?.email ? user.email.trim().toLowerCase() : '';
}

export function resolveRoleFromEmail(email: string): string {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return '';
  return ROLE_BY_EMAIL[normalized] || 'operator';
}

export function persistRole(role: string): string {
  if (typeof window === 'undefined') return role || 'operator';
  let normalized = String(role || 'operator').trim().toLowerCase();
  if (normalized !== 'dev' && normalized !== 'admin' && normalized !== 'manager' && normalized !== 'operator') {
    normalized = 'operator';
  }
  localStorage.setItem(ROLE_KEY, normalized);
  if (normalized === 'admin' || normalized === 'dev') {
    localStorage.setItem(IS_ADMIN_KEY, 'true');
  } else {
    localStorage.removeItem(IS_ADMIN_KEY);
  }
  return normalized;
}

export function sessionRole(): string {
  if (typeof window === 'undefined') return 'operator';
  const fromEmail = resolveRoleFromEmail(sessionUserEmail());
  if (fromEmail) {
    persistRole(fromEmail);
    return fromEmail;
  }
  const stored = (localStorage.getItem(ROLE_KEY) || '').trim().toLowerCase();
  if (stored === 'dev' || stored === 'admin' || stored === 'manager' || stored === 'operator') return stored;
  const user = sessionUser();
  const role = user?.role ? String(user.role).trim().toLowerCase() : '';
  if (role === 'dev' || role === 'admin' || role === 'manager' || role === 'operator') return persistRole(role);
  return 'operator';
}

export function homePathForRole(role: string): string {
  if (role === 'dev') return '/dev';
  if (role === 'admin') return '/admin';
  if (role === 'manager') return '/manager';
  return '/';
}

export function getTodayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}

export function sessionCapExpired(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = localStorage.getItem(EXPIRES_AT_KEY);
  if (!raw) return false;
  const expires = Number(raw);
  return Number.isFinite(expires) && Date.now() > expires;
}

export function tokenExpiryMs(token: string): number {
  if (!token) return 0;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return 0;
    let base = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base.length % 4) base += '=';
    const jsonStr = typeof atob !== 'undefined' ? atob(base) : Buffer.from(base, 'base64').toString('utf-8');
    const payload = JSON.parse(jsonStr);
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function needsRefresh(token?: string): boolean {
  if (typeof window === 'undefined') return false;
  if (sessionCapExpired()) return false;
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) return false;
  const currentToken = token || localStorage.getItem(TOKEN_KEY) || '';
  if (!currentToken) return true;
  const exp = tokenExpiryMs(currentToken);
  if (!exp) return true;
  return Date.now() >= exp - REFRESH_SKEW_MS;
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(WH_UNREACHABLE_KEY);
  localStorage.removeItem(IS_ADMIN_KEY);
  localStorage.removeItem(ROLE_KEY);
  try {
    sessionStorage.removeItem(MANAGER_VIEW_AS_OPERATOR_KEY);
    sessionStorage.removeItem(VIEW_AS_MANAGER_EMAIL_KEY);
  } catch {}
}

export function persistSession(data: any, renewExpiry = false): string {
  if (typeof window === 'undefined' || !data) return sessionRole();
  if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
  const refresh = data.refreshToken || data.refresh_token;
  if (refresh) localStorage.setItem(REFRESH_TOKEN_KEY, refresh);
  if (data.user) localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  if (renewExpiry) {
    const ttlMs = Number(data.sessionTtlSeconds) > 0 ? Number(data.sessionTtlSeconds) * 1000 : WEEK_MS;
    localStorage.setItem(EXPIRES_AT_KEY, String(Date.now() + ttlMs));
  }
  const email = (data.user && data.user.email) || data.email || sessionUserEmail();
  if (data.role) {
    const serverRole = persistRole(data.role);
    if (data.user) {
      try {
        const merged = {
          ...data.user,
          role: serverRole,
          email: String(email || data.user.email || '').trim().toLowerCase(),
        };
        localStorage.setItem(USER_KEY, JSON.stringify(merged));
      } catch {}
    }
    return serverRole;
  }
  const fromEmail = resolveRoleFromEmail(email);
  if (fromEmail) return persistRole(fromEmail);
  return sessionRole();
}

export async function refreshSession(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  if (refreshInFlight) return refreshInFlight;
  if (sessionCapExpired()) {
    clearSession();
    return null;
  }
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) return null;

  refreshInFlight = (async () => {
    try {
      const apiBaseUrl = typeof window !== 'undefined' ? window.location.origin : '';
      const res = await fetch(`${apiBaseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) {
        clearSession();
        return null;
      }
      persistSession(data, false);
      return (data.token as string) || null;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function ensureSession(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  if (sessionCapExpired()) {
    clearSession();
    return null;
  }
  const currentToken = localStorage.getItem(TOKEN_KEY);
  if (!currentToken && !localStorage.getItem(REFRESH_TOKEN_KEY)) {
    return null;
  }
  if (needsRefresh(currentToken || undefined)) {
    return await refreshSession();
  }
  return currentToken;
}

export function isOpsMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const role = sessionRole();
    if (role !== 'manager' && role !== 'dev') return false;
    const val = sessionStorage.getItem(MANAGER_VIEW_AS_OPERATOR_KEY);
    return val === '1' || val === 'true';
  } catch {
    return false;
  }
}

export function getOpsModeManagerEmail(): string {
  if (typeof window === 'undefined') return '';
  try {
    return String(sessionStorage.getItem(VIEW_AS_MANAGER_EMAIL_KEY) || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

export function getAuthHeaders(token?: string | null): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const authToken = token ?? localStorage.getItem(TOKEN_KEY);
  if (!authToken) return {};
  const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
  if (isOpsMode()) {
    headers['X-View-As'] = 'operator';
    const role = sessionRole();
    if (role === 'dev') {
      const mgrEmail = getOpsModeManagerEmail();
      if (mgrEmail) headers['X-View-As-Manager-Email'] = mgrEmail;
    }
  }
  return headers;
}

export async function signOut(): Promise<void> {
  if (typeof window === 'undefined') return;
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    try {
      const apiBaseUrl = typeof window !== 'undefined' ? window.location.origin : '';
      await fetch(`${apiBaseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  }
  clearSession();
  window.location.replace('/');
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const isAuthEndpoint = AUTH_SKIP.test(urlStr);

  if (isAuthEndpoint) {
    return fetch(input, init);
  }

  const token = await ensureSession();
  const authHeaders = getAuthHeaders(token);

  const customHeaders = new Headers(init?.headers);
  for (const [key, value] of Object.entries(authHeaders)) {
    if (!customHeaders.has(key)) {
      customHeaders.set(key, value);
    }
  }

  if (typeof window !== 'undefined') {
    if (sessionStorage.getItem('applywizz_manager_view_as_operator') === 'true') {
      customHeaders.set('X-View-As', 'operator');
    }
    const viewAsManagerEmail = sessionStorage.getItem('applywizz_view_as_manager_email');
    if (viewAsManagerEmail) {
      customHeaders.set('X-View-As-Manager-Email', viewAsManagerEmail);
    }
  }

  const reqInit: RequestInit = {
    ...init,
    headers: customHeaders,
  };

  let response = await fetch(input, reqInit);

  if (response.status === 401 && typeof window !== 'undefined' && localStorage.getItem(REFRESH_TOKEN_KEY)) {
    const newToken = await refreshSession();
    if (newToken) {
      const retryHeaders = new Headers(init?.headers);
      const newAuthHeaders = getAuthHeaders(newToken);
      for (const [key, value] of Object.entries(newAuthHeaders)) {
        retryHeaders.set(key, value);
      }
      if (sessionStorage.getItem('applywizz_manager_view_as_operator') === 'true') {
        retryHeaders.set('X-View-As', 'operator');
      }
      const viewAsManagerEmail = sessionStorage.getItem('applywizz_view_as_manager_email');
      if (viewAsManagerEmail) {
        retryHeaders.set('X-View-As-Manager-Email', viewAsManagerEmail);
      }
      response = await fetch(input, {
        ...init,
        headers: retryHeaders,
      });
    }
  }

  return response;
}

export interface UseSessionOptions {
  opsMode?: boolean;
  opsManagerEmail?: string;
}

export interface UseSessionResult {
  token: string | null;
  user: AuthUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

export function useSession(_options?: UseSessionOptions): UseSessionResult {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(TOKEN_KEY);
  });
  const [user, setUser] = useState<AuthUser | null>(() => {
    return sessionUser();
  });
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      const validToken = await ensureSession();
      if (!isMounted) return;
      setToken(validToken);
      setUser(sessionUser());
      setLoading(false);
    };

    void init();

    const interval = setInterval(async () => {
      if (needsRefresh()) {
        const refreshed = await refreshSession();
        if (!isMounted) return;
        setToken(refreshed);
        setUser(sessionUser());
      }
    }, 60 * 1000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  return {
    token,
    user,
    loading,
    signOut,
  };
}

export interface UseRequireRoleResult {
  token: string | null;
  user: AuthUser | null;
  role: string;
  loading: boolean;
  isAuthorized: boolean;
  signOut: () => Promise<void>;
}

export function useRequireRole(allowedRoles: string[]): UseRequireRoleResult {
  const { token, user, loading, signOut } = useSession();
  const [role, setRole] = useState<string>(() => sessionRole());
  const [isAuthorized, setIsAuthorized] = useState<boolean>(false);

  useEffect(() => {
    if (loading) return;
    if (!token) {
      setIsAuthorized(false);
      return;
    }
    const currentRole = sessionRole();
    setRole(currentRole);
    if (currentRole === 'dev' || allowedRoles.includes(currentRole)) {
      setIsAuthorized(true);
      return;
    }
    // Unauthorized role: redirect to user's assigned role home
    const home = homePathForRole(currentRole);
    if (typeof window !== 'undefined' && window.location.pathname !== home) {
      window.location.replace(home);
    }
  }, [loading, token, allowedRoles]);

  return { token, user, role, loading, isAuthorized, signOut };
}

export default useSession;
