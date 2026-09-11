/**
 * @fileoverview Main Operator Dashboard Application Container (Phase V2-UI).
 *
 * Coordinates split-screen workspace, candidate selection, job tab switching,
 * pre-populated form rendering, live submission/dry-run controls, and verification proof viewing.
 * Styled with the neo-brutalist / modern job board aesthetic matching the reference mockup.
 *
 * References:
 * - 04-ui-ux-v2-refined.md
 * - V2-implementation.md (Phase V2-5, V2-UI)
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CandidateList } from './CandidateList.js';
import { JobQueueView } from './JobQueueView.js';
import { FormRenderer } from './FormRenderer.js';
import { AuthView, type AuthUser } from './components/AuthView.js';
import type {
  CandidateDetail,
  CandidateSummary,
  DashboardStats,
  ResolvedField,
  ApplicationStatus,
} from './types.js';
import { useCandidateApplicationsRealtime } from './hooks/useCandidateApplicationsRealtime.js';
import {
  mergeApplicationFromRealtimeRow,
  patchJobInCandidateDetail,
} from '../src/dashboard/applicationRealtimeMerge.js';

const API_BASE_URL = typeof window !== 'undefined' ? window.location.origin : '';

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = localStorage.getItem('applywizz_auth_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const getTodayIST = (): string => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffset);
    const yyyy = istDate.getUTCFullYear();
    const mm = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(istDate.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const [selectedDate, setSelectedDate] = useState<string>(getTodayIST);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'stats'>('dashboard');
  const [candidates, setCandidates] = useState<CandidateSummary[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [candidateDetail, setCandidateDetail] = useState<CandidateDetail | null>(null);
  const [selectedJobUrl, setSelectedJobUrl] = useState<string | null>(null);
  const [application, setApplication] = useState<any | null>(null);

  const [isLoadingCandidates, setIsLoadingCandidates] = useState<boolean>(true);
  const [isAuthHydrating, setIsAuthHydrating] = useState<boolean>(false);
  const [isLoadingApplication, setIsLoadingApplication] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const [notifications, setNotifications] = useState<any[]>([]);
  const [readNotifIds, setReadNotifIds] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const saved = localStorage.getItem('greenhouse_read_notif_ids');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [isNotifOpen, setIsNotifOpen] = useState<boolean>(false);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setIsNotifOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const unreadNotifsCount = useMemo(() => {
    return notifications.filter((n) => !readNotifIds.has(n.id)).length;
  }, [notifications, readNotifIds]);

  const markAllNotifsAsRead = () => {
    const allIds = new Set(notifications.map((n) => n.id));
    setReadNotifIds(allIds);
    try {
      localStorage.setItem('greenhouse_read_notif_ids', JSON.stringify(Array.from(allIds)));
    } catch {}
  };

  const clearNotification = async (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    try {
      await fetch(`${API_BASE_URL}/api/notifications/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
    } catch (err) {
      console.error(`Failed to delete notification ${id}:`, err);
    }
  };

  const clearAllNotifs = async () => {
    setNotifications([]);
    try {
      await fetch(`${API_BASE_URL}/api/notifications/all`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
    } catch (err) {
      console.error('Failed to clear notifications:', err);
    }
  };

  const [workHistoryUnreachable, setWorkHistoryUnreachable] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem('applywizz_wh_unreachable') === 'true';
    } catch {
      return false;
    }
  });
  const [workHistoryBannerDismissed, setWorkHistoryBannerDismissed] = useState<boolean>(false);
  const [noCandidatesMessage, setNoCandidatesMessage] = useState<string | null>(null);

  // Real-time failure toast/banner alert received via WebSocket
  const [failureAlert, setFailureAlert] = useState<{
    appId: string;
    reason: string;
    timestamp: string;
    companyName?: string;
    jobTitle?: string;
  } | null>(null);

  const getAuthHeaders = (): HeadersInit => {
    if (typeof window === 'undefined') return {};
    const token = localStorage.getItem('applywizz_auth_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const isAdminSession = (): boolean => {
    if (typeof window === 'undefined') return false;
    if (localStorage.getItem('applywizz_is_admin') === 'true') return true;
    const email = (currentUser?.email || '').trim().toLowerCase();
    return (
      ['yaswanthnaiduyalla@applywizz.ai', 'yaswanhnaiduyalla@applywizz.ai'].includes(email) ||
      email.startsWith('yaswanth') ||
      email.startsWith('admin@')
    );
  };

  const ensureAdminHydrated = useCallback(async (dateStr: string): Promise<void> => {
    if (!isAdminSession()) return;
    const token = localStorage.getItem('applywizz_auth_token');
    if (!token) return;
    setIsAuthHydrating(true);
    try {
      await fetch(`${API_BASE_URL}/api/auth/hydrate-admin`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ date: dateStr }),
      });
    } catch (err) {
      console.warn('Admin hydration request failed:', err);
    } finally {
      setIsAuthHydrating(false);
    }
  }, [currentUser]);

  const handleSignOut = () => {
    localStorage.removeItem('applywizz_auth_token');
    localStorage.removeItem('applywizz_auth_user');
    localStorage.removeItem('applywizz_wh_unreachable');
    localStorage.removeItem('applywizz_is_admin');
    setWorkHistoryUnreachable(false);
    setWorkHistoryBannerDismissed(false);
    setNoCandidatesMessage(null);
    setCurrentUser(null);
  };

  const fetchInitialData = useCallback(async (isPolling = false, dateStr = selectedDate) => {
    if (!isPolling) setIsLoadingCandidates(true);
    try {
      const headers = getAuthHeaders();
      const [candidatesRes, statsRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/candidates?date=${encodeURIComponent(dateStr)}`, { headers }),
        fetch(`${API_BASE_URL}/api/stats?date=${encodeURIComponent(dateStr)}`, { headers }),
      ]);

      if (candidatesRes.ok) {
        const raw = await candidatesRes.json();
        const candidateData = Array.isArray(raw) ? raw : (raw.candidates || []);
        const unreachable = !Array.isArray(raw)
          ? Boolean(raw.workHistoryUnreachable)
          : candidatesRes.headers.get('x-work-history-unreachable') === 'true';
        const emptyMsg = !Array.isArray(raw) ? (raw.message || null) : null;

        setCandidates(candidateData);
        if (unreachable) setWorkHistoryUnreachable(true);
        setNoCandidatesMessage(emptyMsg);

        setSelectedCandidateId((prev) => {
          if (prev && candidateData.some((c: CandidateSummary) => c.applywizzId === prev)) return prev;
          return candidateData.length > 0 ? candidateData[0].applywizzId : null;
        });
      }

      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    } finally {
      if (!isPolling) setIsLoadingCandidates(false);
    }
  }, [selectedDate]);

  const fetchNotifications = useCallback(async (dateStr = selectedDate) => {
    try {
      const headers = getAuthHeaders();
      const res = await fetch(`${API_BASE_URL}/api/notifications?date=${encodeURIComponent(dateStr)}`, { headers });
      if (res.ok) {
        const serverNotifs = await res.json();
        if (Array.isArray(serverNotifs)) {
          setNotifications(serverNotifs);
        }
      }
    } catch (err) {
      console.warn('Failed to fetch notifications:', err);
    }
  }, [selectedDate]);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const userEmail = (currentUser?.email || '').trim().toLowerCase();
      const isAdminUser = Boolean(
        ['yaswanthnaiduyalla@applywizz.ai', 'yaswanhnaiduyalla@applywizz.ai'].includes(userEmail) ||
        userEmail.startsWith('yaswanth') ||
        userEmail.startsWith('admin@') ||
        (typeof localStorage !== 'undefined' && localStorage.getItem('applywizz_is_admin') === 'true')
      );
      if (isAdminUser) {
        try {
          await fetch(`${API_BASE_URL}/api/admin/refresh-artifacts`, {
            method: 'POST',
            headers: getAuthHeaders(),
          });
        } catch (e) {
          console.warn('Artifacts reload error:', e);
        }
      }
      await fetchInitialData(false, selectedDate);
      if (selectedCandidateId) {
        await fetchCandidateDetail(selectedCandidateId);
      }
      if (selectedCandidateId && selectedJobUrl) {
        await fetchJobApplication(selectedCandidateId, selectedJobUrl);
      }
      await fetchNotifications(selectedDate);
    } catch (err) {
      console.error('Refresh error:', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    (async () => {
      await ensureAdminHydrated(selectedDate);
      if (cancelled) return;
      fetchInitialData(false, selectedDate);
      fetchNotifications(selectedDate);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser, selectedDate, ensureAdminHydrated, fetchInitialData, fetchNotifications]);

  useEffect(() => {
    if (!currentUser) return;
    const pollInterval = setInterval(() => {
      fetchInitialData(true, selectedDate);
      fetchNotifications(selectedDate);
    }, 3000);
    return () => clearInterval(pollInterval);
  }, [currentUser, selectedDate, fetchInitialData, fetchNotifications]);

  // Connect to WebSocket /ws for real-time application failure toasts
  useEffect(() => {
    if (!currentUser || typeof window === 'undefined') return;
    let ws: WebSocket | null = null;
    let reconnectTimeout: any = null;
    let isDisposed = false;

    const connectWs = () => {
      if (isDisposed) return;
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        ws = new WebSocket(wsUrl);

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'APPLICATION_FAILED') {
              console.log('[Dashboard WS] ⚠️ Received APPLICATION_FAILED:', data);
              setFailureAlert({
                appId: data.appId,
                reason: data.reason || 'Submission failed.',
                timestamp: data.timestamp || new Date().toISOString(),
                companyName: data.companyName,
                jobTitle: data.jobTitle,
              });

              // Auto-dismiss alert after 10 seconds
              setTimeout(() => {
                setFailureAlert((curr) => (curr?.appId === data.appId ? null : curr));
              }, 10000);

              // Instantly refresh data & notifications
              fetchInitialData(true, selectedDate);
              fetchNotifications(selectedDate);
              if (selectedCandidateId) {
                fetchCandidateDetail(selectedCandidateId);
              }
              if (selectedCandidateId && selectedJobUrl) {
                fetchJobApplication(selectedCandidateId, selectedJobUrl);
              }
            }
          } catch (e) {
            console.warn('[Dashboard WS] Message parse error:', e);
          }
        };

        ws.onclose = () => {
          if (!isDisposed) {
            reconnectTimeout = setTimeout(connectWs, 5000);
          }
        };

        ws.onerror = () => {
          if (ws) ws.close();
        };
      } catch (err) {
        console.warn('[Dashboard WS] Connection error:', err);
        if (!isDisposed) {
          reconnectTimeout = setTimeout(connectWs, 5000);
        }
      }
    };

    connectWs();

    return () => {
      isDisposed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [currentUser, selectedDate, selectedCandidateId, selectedJobUrl, fetchInitialData, fetchNotifications, fetchCandidateDetail, fetchJobApplication]);

  // 2. Fetch Selected Candidate Details & Jobs Queue
  const fetchCandidateDetail = useCallback(async (applywizzId: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/candidates/${applywizzId}`, {
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        const detail: CandidateDetail = await res.json();
        setCandidateDetail(detail);

        // Auto-select first job if available
        if (detail.jobs && detail.jobs.length > 0) {
          const firstJobUrl = detail.jobs[0].canonicalUrl || detail.jobs[0].rawUrl;
          setSelectedJobUrl(firstJobUrl);
        } else {
          setSelectedJobUrl(null);
          setApplication(null);
        }
      }
    } catch (err: any) {
      console.error(`Failed to fetch candidate ${applywizzId}:`, err);
    }
  }, []);

  useEffect(() => {
    if (selectedCandidateId) {
      fetchCandidateDetail(selectedCandidateId);
    }
  }, [selectedCandidateId, fetchCandidateDetail]);

  // 3. Fetch Resolved Form Answers for Active Job
  const fetchJobApplication = useCallback(async (applywizzId: string, jobUrl: string) => {
    setIsLoadingApplication(true);
    try {
      const encodedUrl = encodeURIComponent(jobUrl);
      const res = await fetch(`${API_BASE_URL}/api/candidates/${applywizzId}/jobs/${encodedUrl}`, {
        headers: getAuthHeaders(),
      });

      if (res.ok) {
        const appData = await res.json();
        setApplication(appData);
      } else {
        setApplication(null);
      }
    } catch (err: any) {
      console.error(`Failed to fetch application for ${applywizzId} / ${jobUrl}:`, err);
      setApplication(null);
    } finally {
      setIsLoadingApplication(false);
    }
  }, []);

  useEffect(() => {
    if (selectedCandidateId && selectedJobUrl) {
      fetchJobApplication(selectedCandidateId, selectedJobUrl);
    }
  }, [selectedCandidateId, selectedJobUrl, fetchJobApplication]);

  const handleRealtimeApplicationRow = useCallback(
    (row: Record<string, unknown>) => {
      setApplication((prev: any) => mergeApplicationFromRealtimeRow(prev, row));
      setCandidateDetail((prev) => (prev ? patchJobInCandidateDetail(prev, row) : prev));
    },
    []
  );

  useCandidateApplicationsRealtime({
    apiBaseUrl: API_BASE_URL,
    getAuthHeaders: () => getAuthHeaders() as Record<string, string>,
    applywizzId: selectedCandidateId,
    enabled: Boolean(currentUser && selectedCandidateId),
    onRowChange: handleRealtimeApplicationRow,
  });

  // Field Edit Handler
  const handleFieldUpdate = (updatedField: ResolvedField) => {
    if (!application) return;

    const fields = application.resolvedFields || application.resolved_fields || [];
    const newResolvedFields = fields.map((f: ResolvedField) =>
      f.fieldId === updatedField.fieldId || f.name === updatedField.fieldId ? updatedField : f
    );

    setApplication({
      ...application,
      resolvedFields: newResolvedFields,
      resolved_fields: newResolvedFields,
    });
  };

  // Status Change Handler (from Submissions, Dry Run, or Polling)
  const handleStatusChange = async (newStatus: ApplicationStatus, updatedPayload?: any) => {
    if (!application) return;

    setApplication((prev: any) => ({
      ...prev,
      status: newStatus,
      error_message:
        updatedPayload?.error_message ||
        updatedPayload?.errorMessage ||
        updatedPayload?.error ||
        prev.error_message,
      errorMessage:
        updatedPayload?.error_message ||
        updatedPayload?.errorMessage ||
        updatedPayload?.error ||
        prev.errorMessage,
      proof_web_url:
        updatedPayload?.proofWebUrl || updatedPayload?.proof_web_url || prev.proof_web_url,
      proof_captured_at:
        updatedPayload?.proofCapturedAt ||
        updatedPayload?.proof_captured_at ||
        prev.proof_captured_at,
      proof_email_url:
        updatedPayload?.proofEmailUrl || updatedPayload?.proof_email_url || prev.proof_email_url,
      proofEmailUrl:
        updatedPayload?.proofEmailUrl || updatedPayload?.proof_email_url || prev.proofEmailUrl,
      proof_email_captured_at:
        updatedPayload?.proofEmailCapturedAt ||
        updatedPayload?.proof_email_captured_at ||
        prev.proof_email_captured_at,
      email_proof_status:
        updatedPayload?.emailProofStatus ||
        updatedPayload?.email_proof_status ||
        prev.email_proof_status,
      emailProofStatus:
        updatedPayload?.emailProofStatus ||
        updatedPayload?.email_proof_status ||
        prev.emailProofStatus,
      proof_email_json:
        updatedPayload?.proofEmailJson || updatedPayload?.proof_email_json || prev.proof_email_json,
      proofEmailJson:
        updatedPayload?.proofEmailJson || updatedPayload?.proof_email_json || prev.proofEmailJson,
      proof_failed_url:
        updatedPayload?.proofFailedUrl || updatedPayload?.proof_failed_url || prev.proof_failed_url,
      proofFailedUrl:
        updatedPayload?.proofFailedUrl || updatedPayload?.proof_failed_url || prev.proofFailedUrl,
      proof_failed_captured_at:
        updatedPayload?.proofFailedCapturedAt ||
        updatedPayload?.proof_failed_captured_at ||
        prev.proof_failed_captured_at,
      dry_run_screenshot_url:
        updatedPayload?.screenshotUrl ||
        updatedPayload?.dry_run_screenshot_url ||
        prev.dry_run_screenshot_url,
    }));

    if (candidateDetail && selectedJobUrl) {
      const updatedJobs = candidateDetail.jobs.map((j) => {
        if (j.canonicalUrl === selectedJobUrl || j.rawUrl === selectedJobUrl) {
          const err =
            updatedPayload?.error_message ||
            updatedPayload?.errorMessage ||
            updatedPayload?.error;
          return { ...j, status: newStatus, error_message: err ?? j.error_message };
        }
        return j;
      });
      setCandidateDetail({ ...candidateDetail, jobs: updatedJobs });
    }

    // Persist status change to Supabase immediately
    const appId = application.id || application.applywizzId || application.applywizz_id;
    const targetJobUrl = application.jobUrl || application.job_url || selectedJobUrl;
    try {
      await fetch(`${API_BASE_URL}/api/applications/${encodeURIComponent(appId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          status: newStatus,
          jobUrl: targetJobUrl,
          proof_web_url: updatedPayload?.proofWebUrl || updatedPayload?.proof_web_url,
          proof_captured_at: updatedPayload?.proofCapturedAt || updatedPayload?.proof_captured_at,
          proof_email_url: updatedPayload?.proofEmailUrl || updatedPayload?.proof_email_url,
          proof_email_captured_at:
            updatedPayload?.proofEmailCapturedAt || updatedPayload?.proof_email_captured_at,
          email_proof_status: updatedPayload?.emailProofStatus || updatedPayload?.email_proof_status,
          proof_email_json: updatedPayload?.proofEmailJson || updatedPayload?.proof_email_json,
          proof_failed_url: updatedPayload?.proofFailedUrl || updatedPayload?.proof_failed_url,
          proof_failed_captured_at:
            updatedPayload?.proofFailedCapturedAt || updatedPayload?.proof_failed_captured_at,
          dry_run_screenshot_url: updatedPayload?.screenshotUrl || updatedPayload?.dry_run_screenshot_url,
          error_message: updatedPayload?.error || updatedPayload?.errorMessage || updatedPayload?.error_message,
        }),
      });
    } catch (err) {
      console.warn(`[App] Failed to persist status change ${newStatus} to backend:`, err);
    }

    if (newStatus === 'APPLIED' || newStatus === 'FAILED' || newStatus === 'APPLYING') {
      fetchNotifications();
    }
  };

  if (!currentUser) {
    return (
      <div className="flex items-center justify-center min-h-screen w-screen bg-[#FFF5EB] p-4 select-none font-sans">
        <AuthView onAuthSuccess={(user) => setCurrentUser(user)} apiBaseUrl={API_BASE_URL} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-[#FFF5EB] text-[#1A1A2E] font-sans overflow-hidden select-none">
      {/* Top Navigation & Brand Header */}
      <header className="h-16 bg-[#FFF5EB] border-b-2 border-[#1A1A2E] flex items-center justify-between px-6 flex-shrink-0">
        {/* Left: Brand Logo & Navigation Links */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-[#1A1A2E] text-[#FFF5EB] flex items-center justify-center font-black text-sm border-2 border-[#1A1A2E] shadow-[2px_2px_0px_#E88474]">
              AW
            </div>
            <div>
              <span className="text-sm font-black tracking-tight text-[#1A1A2E] uppercase">
                ApplyWizz
              </span>
              <span className="text-[10px] block font-mono text-[#64748B] font-bold">
                Auto Apply V2
              </span>
            </div>
          </div>

          {/* Navigation Tabs (Dashboard / Stats) */}
          <nav className="hidden md:flex items-center gap-2 bg-white border border-[#1A1A2E] rounded-md p-1 shadow-[2px_2px_0px_#1A1A2E]">
            <button
              type="button"
              onClick={() => setActiveTab('dashboard')}
              className={`px-3 py-1 text-xs font-bold rounded transition-all ${
                activeTab === 'dashboard'
                  ? 'bg-[#E88474] text-white'
                  : 'text-[#1A1A2E] hover:bg-[#FAF4EB]'
              }`}
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('stats')}
              className={`px-3 py-1 text-xs font-bold rounded transition-all ${
                activeTab === 'stats'
                  ? 'bg-[#E88474] text-white'
                  : 'text-[#1A1A2E] hover:bg-[#FAF4EB]'
              }`}
            >
              Stats
            </button>
          </nav>
        </div>

        {/* Right: Metrics Pills, Notifications & User Avatar */}
        <div className="flex items-center gap-3">
          {/* Date Scope Filter (IST) */}
          <div className="flex items-center gap-1.5 bg-white border border-[#1A1A2E] px-2.5 py-1 rounded shadow-[2px_2px_0px_#1A1A2E]">
            <span className="text-xs font-mono font-bold text-[#64748B]">📅 IST:</span>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                if (e.target.value) {
                  setSelectedDate(e.target.value);
                }
              }}
              title="Filter dashboard by assignments on this IST date"
              className="text-xs font-mono font-bold text-[#1A1A2E] bg-transparent border-none outline-none cursor-pointer"
            />
          </div>

          {stats && (
            <div className="hidden lg:flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-[#F4D66B] border border-[#1A1A2E] px-2.5 py-1 rounded text-xs font-mono font-bold text-[#5C4A0A] shadow-[1px_1px_0px_#1A1A2E]">
                <span>Candidates:</span>
                <span>{stats.totalCandidates}</span>
              </div>

              <div className="flex items-center gap-1.5 bg-[#B8D4E8] border border-[#1A1A2E] px-2.5 py-1 rounded text-xs font-mono font-bold text-[#1E3A5F] shadow-[1px_1px_0px_#1A1A2E]">
                <span>Jobs:</span>
                <span>{stats.totalApplications}</span>
              </div>

              <div className="flex items-center gap-1.5 bg-[#9AC89A] border border-[#1A1A2E] px-2.5 py-1 rounded text-xs font-mono font-bold text-[#1E4620] shadow-[1px_1px_0px_#1A1A2E]">
                <span>🌿 supabase: {stats.supabasePercentage}%</span>
              </div>

              <div className="flex items-center gap-1.5 bg-[#EDE9FE] border border-[#1A1A2E] px-2.5 py-1 rounded text-xs font-mono font-bold text-[#5B21B6] shadow-[1px_1px_0px_#1A1A2E]">
                <span>🔮 ai: {stats.aiPercentage}%</span>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Refresh Data"
            className="text-xs bg-white hover:bg-[#FAF4EB] text-[#1A1A2E] border border-[#1A1A2E] px-2.5 py-1 rounded shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] font-bold transition-all disabled:opacity-60"
          >
            <span className={isRefreshing ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
          </button>

          {/* Interactive Notification Bell & Dropdown */}
          <div className="relative" ref={notifRef}>
            <button
              type="button"
              onClick={() => setIsNotifOpen((prev) => !prev)}
              title="Notifications"
              className="relative p-1.5 bg-white border border-[#1A1A2E] rounded shadow-[2px_2px_0px_#1A1A2E] cursor-pointer hover:bg-[#FAF4EB] transition-colors"
            >
              <span className="text-xs">🔔</span>
              {unreadNotifsCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 bg-[#EF4444] text-white text-[10px] font-black rounded-full flex items-center justify-center border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E]">
                  {unreadNotifsCount > 9 ? '9+' : unreadNotifsCount}
                </span>
              )}
            </button>

            {isNotifOpen && (
              <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-white border-2 border-[#1A1A2E] rounded-xl shadow-[6px_6px_0px_#1A1A2E] z-50 overflow-hidden animate-fadeIn">
                <div className="flex items-center justify-between px-3.5 py-2.5 bg-[#FFF5EB] border-b-2 border-[#1A1A2E]">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">🔔</span>
                    <span className="text-xs font-bold uppercase tracking-wider text-[#1A1A2E]">
                      Notifications {unreadNotifsCount > 0 && `(${unreadNotifsCount} new)`}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {notifications.length > 0 && (
                      <button
                        type="button"
                        onClick={markAllNotifsAsRead}
                        className="text-[10px] font-bold text-[#64748B] hover:text-[#1A1A2E] bg-white border border-[#1A1A2E] px-1.5 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E]"
                      >
                        Mark all read
                      </button>
                    )}
                    {notifications.length > 0 && (
                      <button
                        type="button"
                        onClick={clearAllNotifs}
                        className="text-[10px] font-bold text-[#EF4444] hover:text-[#B91C1C] bg-white border border-[#1A1A2E] px-1.5 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E]"
                      >
                        Clear
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setIsNotifOpen(false)}
                      className="text-[#64748B] hover:text-[#1A1A2E] text-xs font-bold px-1"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className="max-h-80 overflow-y-auto p-2.5 space-y-2 custom-scrollbar">
                  {notifications.length === 0 ? (
                    <div className="p-6 text-center text-xs text-[#64748B]">
                      No notifications yet. Alerts for succeeded and failed applications will appear here.
                    </div>
                  ) : (
                    notifications.map((notif: any) => {
                      const isApplying = notif.status === 'APPLYING';
                      const isSuccess = notif.status === 'APPLIED' || notif.type === 'SUCCESS';
                      const isUnread = !readNotifIds.has(notif.id);
                      return (
                        <div
                          key={notif.id}
                          onClick={() => {
                            if (notif.applywizzId) setSelectedCandidateId(notif.applywizzId);
                            if (notif.jobUrl) setSelectedJobUrl(notif.jobUrl);
                            setIsNotifOpen(false);
                          }}
                          className={`p-2.5 rounded-lg border cursor-pointer transition-all ${
                            isApplying
                              ? 'bg-[#EFF6FF] border-[#BFDBFE] hover:border-[#3B82F6]'
                              : isSuccess
                              ? 'bg-[#F0FDF4] border-[#86EFAC] hover:border-[#10B981]'
                              : 'bg-[#FEF2F2] border-[#FECACA] hover:border-[#EF4444]'
                          } ${isUnread ? 'shadow-[2px_2px_0px_#1A1A2E]' : 'opacity-85'}`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span
                              className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                isApplying
                                  ? 'bg-[#DBEAFE] text-[#1D4ED8] border border-[#93C5FD]'
                                  : isSuccess
                                  ? 'bg-[#DCFCE7] text-[#166534] border border-[#86EFAC]'
                                  : 'bg-[#FEE2E2] text-[#991B1B] border border-[#FECACA]'
                              }`}
                            >
                              {isApplying ? '⏳ Applying' : isSuccess ? '✅ Succeeded' : '❌ Failed'}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-[#64748B] font-mono">
                                {notif.timestamp ? new Date(notif.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  clearNotification(notif.id);
                                }}
                                title="Dismiss notification"
                                className="text-[10px] text-[#94A3B8] hover:text-[#EF4444] px-1 py-0.5 rounded hover:bg-white/80 font-bold transition-colors"
                              >
                                ✕
                              </button>
                            </div>
                          </div>

                          <div className="text-xs font-bold text-[#1A1A2E]">
                            {notif.candidateName || notif.applywizzId}{' '}
                            <span className="font-mono text-[10px] text-[#64748B] font-normal">
                              ({notif.applywizzId})
                            </span>
                          </div>

                          <div className="text-[11px] text-[#475569] font-medium truncate mt-0.5">
                            🏢 {notif.companyName} — {notif.jobTitle}
                          </div>

                          {isApplying && (
                            <div className="mt-1 text-[10px] text-[#1D4ED8] font-mono flex items-center gap-1">
                              <span className="inline-block animate-spin">⏳</span> Application submission in progress...
                            </div>
                          )}

                          {!isSuccess && !isApplying && (
                            <div className="mt-1.5 p-1.5 bg-white border border-[#EF4444]/40 rounded text-[11px] text-[#991B1B] font-mono break-words leading-tight">
                              <span className="font-bold">Reason: </span>
                              {notif.reason || 'Submission failed or was rejected.'}
                            </div>
                          )}

                          {isSuccess && notif.proofWebUrl && (
                            <div className="mt-1.5 flex justify-end">
                              <a
                                href={notif.proofWebUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[10px] font-bold text-[#166534] underline hover:text-[#14532D]"
                              >
                                View Proof Screenshot ↗
                              </a>
                            </div>
                          )}

                          {!isSuccess && !isApplying && notif.proofFailedUrl && (
                            <div className="mt-1.5 flex justify-end">
                              <a
                                href={notif.proofFailedUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[10px] font-bold text-[#991B1B] underline hover:text-[#7F1D1D]"
                              >
                                View Failure Screenshot ↗
                              </a>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* User Profile Avatar & Sign Out */}
          <div className="flex items-center gap-2 bg-white border border-[#1A1A2E] px-2.5 py-1 rounded shadow-[2px_2px_0px_#1A1A2E]">
            <div className="w-5 h-5 rounded-full bg-[#E88474] border border-[#1A1A2E] flex items-center justify-center text-[10px] font-black text-white uppercase">
              {currentUser?.email ? currentUser.email.charAt(0) : 'U'}
            </div>
            <span className="text-xs font-bold text-[#1A1A2E] max-w-[130px] truncate hidden sm:inline" title={currentUser?.email}>
              {currentUser?.email || 'Operator'}
            </span>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            title="Sign Out"
            className="text-xs bg-[#FFF5EB] hover:bg-[#E88474] hover:text-white text-[#1A1A2E] border border-[#1A1A2E] px-2.5 py-1 rounded shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] font-bold transition-all"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Work-History Unreachable Top Banner */}
      {workHistoryUnreachable && !workHistoryBannerDismissed && (
        <div className="bg-[#FEF3C7] border-b-2 border-[#1A1A2E] px-6 py-2 text-xs font-bold text-[#92400E] flex items-center justify-between shadow-sm flex-shrink-0">
          <div className="flex items-center gap-2">
            <span>⚠️</span>
            <span>Work-history API unreachable — showing last known assigned candidates.</span>
          </div>
          <button
            type="button"
            onClick={() => setWorkHistoryBannerDismissed(true)}
            className="text-[#92400E] hover:text-[#1A1A2E] text-sm font-black transition-opacity"
            title="Dismiss warning"
          >
            ✕
          </button>
        </div>
      )}

      {/* Real-time Worker Failure Banner / Toast */}
      {failureAlert && (
        <div className="bg-[#FEE2E2] border-b-2 border-[#EF4444] px-6 py-3 text-xs font-bold text-[#991B1B] flex items-center justify-between shadow-md flex-shrink-0 animate-fadeIn">
          <div className="flex items-center gap-2.5">
            <span className="text-base">🚨</span>
            <div>
              <span className="font-black uppercase tracking-wider text-[#7F1D1D]">Submission Failed: </span>
              <span>
                {failureAlert.companyName ? `${failureAlert.companyName} — ` : ''}
                {failureAlert.reason}
              </span>
              <span className="ml-2 font-mono font-normal text-[11px] text-[#B91C1C]">
                ({new Date(failureAlert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })})
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setFailureAlert(null)}
            className="text-[#991B1B] hover:text-[#7F1D1D] text-sm font-black px-1.5 py-0.5 rounded hover:bg-white/50 transition-colors"
            title="Dismiss alert"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Workspace (Split-screen Dashboard or Stats View) */}
      <div className={`flex-1 overflow-y-auto p-8 max-w-5xl mx-auto w-full custom-scrollbar ${activeTab === 'stats' ? '' : 'hidden'}`}>
        <div className="mb-6">
          <h2 className="text-2xl font-black text-[#1A1A2E]">Application Pipeline Stats</h2>
          <p className="text-xs text-[#64748B] font-mono mt-0.5">
            Real-time throughput metrics, resolution tier breakdowns, and submission telemetry.
          </p>
        </div>

        {stats ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            <div className="bg-[#FFF8D6] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <span className="text-xs font-bold uppercase tracking-wider text-[#5C4A0A]">
                Total Candidates
              </span>
              <div className="text-3xl font-black text-[#1A1A2E] mt-2">
                {stats.totalCandidates}
              </div>
              <div className="text-[11px] font-mono text-[#5C4A0A] mt-1">
                Ingested &amp; segregated
              </div>
            </div>

            <div className="bg-[#E2F0FB] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <span className="text-xs font-bold uppercase tracking-wider text-[#1E3A5F]">
                Total Applications
              </span>
              <div className="text-3xl font-black text-[#1A1A2E] mt-2">
                {stats.totalApplications}
              </div>
              <div className="text-[11px] font-mono text-[#1E3A5F] mt-1">
                Active job assignments
              </div>
            </div>

            <div className="bg-[#D1FAE5] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <span className="text-xs font-bold uppercase tracking-wider text-[#065F46]">
                Successful Applications
              </span>
              <div className="text-3xl font-black text-[#1A1A2E] mt-2">
                {stats.successfulApplications}
              </div>
              <div className="text-[11px] font-mono text-[#065F46] mt-1">
                Submitted with APPLIED status
              </div>
            </div>

            <div className="bg-[#FEE2E2] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <span className="text-xs font-bold uppercase tracking-wider text-[#991B1B]">
                Failed Applications
              </span>
              <div className="text-3xl font-black text-[#1A1A2E] mt-2">
                {stats.failedApplications}
              </div>
              <div className="text-[11px] font-mono text-[#991B1B] mt-1">
                Terminal FAILED submissions
              </div>
            </div>

            <div className="bg-[#E2F5E2] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <span className="text-xs font-bold uppercase tracking-wider text-[#1E4620]">
                Supabase Cache
              </span>
              <div className="text-3xl font-black text-[#1A1A2E] mt-2">
                {stats.supabasePercentage}%
              </div>
              <div className="text-[11px] font-mono text-[#1E4620] mt-1">
                {stats.supabaseTaggedCount} fields (0 API calls)
              </div>
            </div>

            <div className="bg-[#FFEAE8] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <span className="text-xs font-bold uppercase tracking-wider text-[#6B2C2C]">
                AI Synthesis
              </span>
              <div className="text-3xl font-black text-[#1A1A2E] mt-2">
                {stats.aiPercentage}%
              </div>
              <div className="text-[11px] font-mono text-[#6B2C2C] mt-1">
                {stats.aiTaggedCount} fields synthesized
              </div>
            </div>
          </div>
        ) : (
          <div className="p-8 text-center text-xs font-mono text-[#64748B]">Loading statistics...</div>
        )}
      </div>

      <div className={`flex flex-1 overflow-hidden ${activeTab === 'dashboard' ? '' : 'hidden'}`}>
          {/* Left Pane: Candidates Directory */}
          <CandidateList
            candidates={candidates}
            selectedId={selectedCandidateId}
            onSelectCandidate={(id) => setSelectedCandidateId(id)}
            isLoading={isLoadingCandidates || isAuthHydrating}
            emptyMessage={noCandidatesMessage}
            selectedDate={selectedDate}
          />

          {/* Right Pane: Candidate Jobs Queue & Form Renderer */}
          <main className="flex-1 flex flex-col bg-[#FFF5EB] overflow-hidden">
            {candidateDetail ? (
              <>
                {/* Right Top: Job Queue Tabs */}
                <JobQueueView
                  candidate={candidateDetail}
                  selectedJobUrl={selectedJobUrl}
                  onSelectJob={(url) => setSelectedJobUrl(url)}
                />

                {/* Right Main: Form Renderer */}
                <FormRenderer
                  application={application}
                  isLoading={isLoadingApplication}
                  candidateName={candidateDetail.clientName}
                  apiBaseUrl={API_BASE_URL}
                  onFieldUpdate={handleFieldUpdate}
                  onStatusChange={handleStatusChange}
                />
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-[#64748B]">
                <div className="text-4xl mb-2">👤</div>
                <p className="text-sm font-bold text-[#1A1A2E]">No Candidate Selected</p>
                <p className="text-xs text-[#64748B] mt-1 font-medium">
                  Select a candidate from the left directory to view assigned applications.
                </p>
              </div>
            )}
          </main>
        </div>
    </div>
  );
};

export default App;
