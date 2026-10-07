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
import {
  filterJobsForCandidate,
  filterOperatorApplicationJobs,
  isSameApplywizzId,
  normalizeApplywizzId,
} from '../src/dashboard/candidateQueueFilter.js';
import {
  useSession,
  apiFetch,
  getAuthHeaders,
  sessionRole,
  isOpsMode,
} from './hooks/useSession.js';
import { DevSwitcher } from './components/DevSwitcher.js';
import { HeaderSignOut } from './components/HeaderSignOut.js';

const API_BASE_URL = typeof window !== 'undefined' ? window.location.origin : '';

export const App: React.FC = () => {
  const [opsMode, setOpsMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return (
      sessionStorage.getItem('applywizz_manager_view_as_operator') === 'true' ||
      sessionStorage.getItem('applywizz_manager_view_as_operator') === '1'
    );
  });
  const [opsManagerEmail, setOpsManagerEmail] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return sessionStorage.getItem('applywizz_view_as_manager_email') ?? '';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isOps =
      sessionStorage.getItem('applywizz_manager_view_as_operator') === 'true' ||
      sessionStorage.getItem('applywizz_manager_view_as_operator') === '1';
    const mgrEmail = sessionStorage.getItem('applywizz_view_as_manager_email') ?? '';
    setOpsMode(isOps);
    setOpsManagerEmail(mgrEmail);
  }, []);

  const { user: sessionUser, signOut: sessionSignOut } = (useSession as any)({
    opsMode,
    opsManagerEmail,
  });
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => sessionUser);

  useEffect(() => {
    if (sessionUser) {
      setCurrentUser(sessionUser);
    }
  }, [sessionUser]);

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
  const selectedCandidateRef = useRef<string | null>(null);

  useEffect(() => {
    selectedCandidateRef.current = selectedCandidateId;
  }, [selectedCandidateId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!localStorage.getItem('applywizz_auth_token')) return;
    const role = sessionRole();
    if (role === 'dev') {
      if (sessionStorage.getItem('applywizz_dev_operator_view') === 'true') {
        return;
      }
      window.location.replace('/dev');
    } else if (role === 'manager' && !isOpsMode()) {
      window.location.replace('/manager');
    } else if (role === 'admin') {
      window.location.replace('/admin');
    }
  }, []);

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
      await apiFetch(`${API_BASE_URL}/api/notifications/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      console.error(`Failed to delete notification ${id}:`, err);
    }
  };

  const clearAllNotifs = async () => {
    setNotifications([]);
    try {
      await apiFetch(`${API_BASE_URL}/api/notifications/all`, {
        method: 'DELETE',
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
  const [wsConnected, setWsConnected] = useState<boolean>(true);

  // Real-time failure toast/banner alert received via WebSocket
  const [failureAlert, setFailureAlert] = useState<{
    appId: string;
    reason: string;
    timestamp: string;
    companyName?: string;
    jobTitle?: string;
  } | null>(null);

  const isAdminSession = (): boolean => {
    const role = sessionRole();
    return role === 'dev' || role === 'admin';
  };

  const ensureAdminHydrated = useCallback(async (dateStr: string): Promise<void> => {
    if (!isAdminSession()) return;
    const token = localStorage.getItem('applywizz_auth_token');
    if (!token) return;
    setIsAuthHydrating(true);
    try {
      await apiFetch(`${API_BASE_URL}/api/auth/hydrate-admin`, {
        method: 'POST',
        headers: {
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

  const handleSignOut = async () => {
    setWorkHistoryUnreachable(false);
    setWorkHistoryBannerDismissed(false);
    setNoCandidatesMessage(null);
    setCurrentUser(null);
    try {
      sessionStorage.removeItem('applywizz_dev_operator_view');
    } catch {}
    await sessionSignOut();
  };

  const fetchInitialData = useCallback(async (isPolling = false, dateStr = selectedDate) => {
    if (!isPolling) setIsLoadingCandidates(true);
    try {
      const [candidatesRes, statsRes] = await Promise.all([
        apiFetch(`${API_BASE_URL}/api/candidates?date=${encodeURIComponent(dateStr)}`),
        apiFetch(`${API_BASE_URL}/api/stats?date=${encodeURIComponent(dateStr)}`),
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
          if (isPolling) return prev;
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
      const res = await apiFetch(`${API_BASE_URL}/api/notifications?date=${encodeURIComponent(dateStr)}`);
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
      const isAdminUser = isAdminSession();
      if (isAdminUser) {
        try {
          await apiFetch(`${API_BASE_URL}/api/admin/refresh-artifacts`, {
            method: 'POST',
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
    const intervalMs = wsConnected ? 30000 : 3000;
    const pollInterval = setInterval(() => {
      fetchInitialData(true, selectedDate);
      fetchNotifications(selectedDate);
    }, intervalMs);
    return () => clearInterval(pollInterval);
  }, [currentUser, selectedDate, wsConnected, fetchInitialData, fetchNotifications]);

  // 2. Fetch Selected Candidate Details & Jobs Queue
  const fetchCandidateDetail = useCallback(async (applywizzId: string) => {
    const requestedId = normalizeApplywizzId(applywizzId);
    console.log(`[Dashboard] Selected ${requestedId} → fetching jobs assigned to this candidate only`);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/candidates/${encodeURIComponent(applywizzId)}`);
      if (res.ok) {
        const detail: CandidateDetail = await res.json();
        if (!isSameApplywizzId(selectedCandidateRef.current, requestedId)) {
          return;
        }

        const jobsRes = await apiFetch(`${API_BASE_URL}/api/candidates/${encodeURIComponent(applywizzId)}/jobs?date=${encodeURIComponent(selectedDate)}`);

        if (!isSameApplywizzId(selectedCandidateRef.current, requestedId)) {
          return;
        }

        if (jobsRes.status === 403) {
          console.warn(`[Dashboard] 403 Access Denied: candidate ${applywizzId} is not assigned to current CA`);
          setCandidateDetail({
            ...detail,
            applywizzId: requestedId,
            jobs: [],
          });
          setSelectedJobUrl(null);
          setApplication(null);
          return;
        }

        const jobsPayload = jobsRes.ok ? await jobsRes.json() : null;
        const returnedApplywizzId = jobsPayload?.applywizzId || jobsPayload?.applywizz_id;
        console.log(
          `[API] GET /api/candidates/${applywizzId}/jobs → filtering by applywizz_id=${applywizzId}`
        );
        if (returnedApplywizzId && !isSameApplywizzId(returnedApplywizzId, requestedId)) {
          console.error(
            `[Dashboard] Candidate mismatch: viewing ${requestedId}, jobs returned for ${returnedApplywizzId}`
          );
        }

        const rawJobs: CandidateDetail['jobs'] = Array.isArray(jobsPayload?.jobs)
          ? jobsPayload.jobs
          : [];
        const candidateJobs = filterOperatorApplicationJobs(
          filterJobsForCandidate(rawJobs, requestedId)
        );
        setCandidateDetail({
          ...detail,
          applywizzId: requestedId,
          jobs: candidateJobs,
        });

        setSelectedJobUrl(null);
        setApplication(null);
      } else if (res.status === 403) {
        console.warn(`[Dashboard] 403 Access Denied: candidate ${applywizzId} not accessible`);
        setCandidateDetail(null);
        setSelectedJobUrl(null);
        setApplication(null);
      }
    } catch (err: any) {
      console.error(`Failed to fetch candidate ${applywizzId}:`, err);
    }
  }, []);

  useEffect(() => {
    if (!selectedCandidateId) {
      setCandidateDetail(null);
      setSelectedJobUrl(null);
      setApplication(null);
      return;
    }
    setCandidateDetail(null);
    setSelectedJobUrl(null);
    setApplication(null);
    fetchCandidateDetail(selectedCandidateId);
  }, [selectedCandidateId, fetchCandidateDetail]);

  // 3. Fetch Resolved Form Answers for Active Job
  const fetchJobApplication = useCallback(async (applywizzId: string, jobUrl: string) => {
    const requestedId = normalizeApplywizzId(applywizzId);
    setIsLoadingApplication(true);
    try {
      const encodedUrl = encodeURIComponent(jobUrl);
      const res = await apiFetch(`${API_BASE_URL}/api/candidates/${encodeURIComponent(applywizzId)}/jobs/${encodedUrl}`);

      if (!isSameApplywizzId(selectedCandidateRef.current, requestedId)) {
        return;
      }

      if (res.ok) {
        const appData = await res.json();
        const appOwner = appData.applywizzId || appData.applywizz_id;
        if (appOwner && !isSameApplywizzId(appOwner, requestedId)) {
          console.warn(
            `[Dashboard] Ignoring application for ${appOwner}; selected candidate is ${requestedId}`
          );
          setApplication(null);
          return;
        }
        setApplication(appData);
      } else {
        setApplication(null);
      }
    } catch (err: any) {
      console.error(`Failed to fetch application for ${applywizzId} / ${jobUrl}:`, err);
      setApplication(null);
    } finally {
      if (isSameApplywizzId(selectedCandidateRef.current, requestedId)) {
        setIsLoadingApplication(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedCandidateId || !selectedJobUrl) {
      setApplication(null);
      setIsLoadingApplication(false);
      return;
    }
    fetchJobApplication(selectedCandidateId, selectedJobUrl);
  }, [selectedCandidateId, selectedJobUrl, fetchJobApplication]);

  // Connect to WebSocket /ws for real-time application failure toasts.
  // Declared after the fetch callbacks it lists as dependencies — the dependency
  // array is evaluated during render, so an earlier position throws on first mount.
  useEffect(() => {
    if (!currentUser || typeof window === 'undefined') return;
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let isDisposed = false;

    const connectWs = () => {
      if (isDisposed) return;
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setWsConnected(true);
        };

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
          setWsConnected(false);
          if (!isDisposed) {
            reconnectTimeout = setTimeout(connectWs, 5000);
          }
        };

        ws.onerror = () => {
          setWsConnected(false);
          if (ws) ws.close();
        };
      } catch (err) {
        console.warn('[Dashboard WS] Connection error:', err);
        setWsConnected(false);
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
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
    };
  }, [currentUser, selectedDate, selectedCandidateId, selectedJobUrl, fetchInitialData, fetchNotifications, fetchCandidateDetail, fetchJobApplication]);

  const handleRealtimeApplicationRow = useCallback(
    (row: Record<string, unknown>) => {
      const selectedId = selectedCandidateRef.current;
      const rowApplywizz = typeof row.applywizz_id === 'string' ? row.applywizz_id : '';
      if (selectedId && rowApplywizz && !isSameApplywizzId(rowApplywizz, selectedId)) {
        return;
      }
      setApplication((prev: any) => mergeApplicationFromRealtimeRow(prev, row, selectedId));
      setCandidateDetail((prev) => (prev ? patchJobInCandidateDetail(prev, row) : prev));
    },
    []
  );

  const refreshCandidatesList = useCallback(async () => {
    await fetchInitialData(true, selectedDate);
  }, [fetchInitialData, selectedDate]);

  const { onGlobalUpdate } = useCandidateApplicationsRealtime({
    apiBaseUrl: API_BASE_URL,
    getAuthHeaders: () => getAuthHeaders() as Record<string, string>,
    applywizzId: selectedCandidateId,
    enabled: Boolean(currentUser),
    onRowChange: handleRealtimeApplicationRow,
  });

  useEffect(() => {
    onGlobalUpdate((_row, eventType) => {
      console.log(`[Realtime] Global update detected (${eventType}) - refreshing candidates list`);
      refreshCandidatesList();
    });
  }, [onGlobalUpdate, refreshCandidatesList]);

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
  const handleStatusChange = async (
    newStatus: ApplicationStatus,
    updatedPayload?: any,
    options: { persist?: boolean } = {}
  ) => {
    if (!application) return;

    // Poll-originated updates only refresh the display — echoing a polled status
    // back would requeue a submission a worker is still running.
    const persist = options.persist !== false;

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
    if (persist) {
      const appId = application.id || application.applywizzId || application.applywizz_id;
      const targetJobUrl = application.jobUrl || application.job_url || selectedJobUrl;
      try {
        await apiFetch(`${API_BASE_URL}/api/applications/${encodeURIComponent(appId)}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
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
    }

    if (newStatus === 'APPLIED' || newStatus === 'FAILED' || newStatus === 'APPLYING') {
      fetchNotifications();
    }
  };

  if (!currentUser) {
    return (
      <div className="flex items-center justify-center min-h-screen w-screen bg-[#0a0a0a] p-4 select-none font-sans">
        <AuthView onAuthSuccess={(user) => setCurrentUser(user)} apiBaseUrl={API_BASE_URL} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0a0a0a] text-[#ffffff] font-sans overflow-hidden select-none">
      {opsMode && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-[#1c1c1e] border-b border-[#2c2c2e] text-xs font-semibold shrink-0 text-[#0a84ff]">
          <span>
            {opsManagerEmail
              ? `👤 Viewing as Operator — Manager mode active (${opsManagerEmail})`
              : '👤 Viewing as Operator — Manager mode active'}
          </span>
          <button
            type="button"
            className="underline text-[#0a84ff] hover:text-[#ffffff] cursor-pointer font-semibold"
            onClick={() => {
              sessionStorage.removeItem('applywizz_manager_view_as_operator');
              sessionStorage.removeItem('applywizz_view_as_manager_email');
              setOpsMode(false);
              setOpsManagerEmail('');
              window.location.replace('/manager');
            }}
          >
            Exit Ops Mode
          </button>
        </div>
      )}
      {/* Top Navigation & Brand Header */}
      <header className="h-16 bg-[#0a0a0a] border-b border-[#2c2c2e] flex items-center justify-between px-6 flex-shrink-0">
        {/* Left: Brand Logo & Navigation Links */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2.5">
            <img
              src="/logo.webp"
              alt="ApplyWizz"
              className="w-8 h-8 rounded-lg border border-[#2c2c2e] object-cover bg-black"
            />
            <div>
              <span className="text-sm font-bold tracking-tight text-[#ffffff] uppercase">
                ApplyWizz
              </span>
              <span className="text-[10px] block font-mono text-[#8e8e93] font-medium">
                Auto Apply V2
              </span>
            </div>
          </div>

          {/* Navigation Tabs (Dashboard / Stats) */}
          <nav className="hidden md:flex items-center gap-1 bg-[#1c1c1e] border border-[#2c2c2e] rounded-lg p-1">
            <button
              type="button"
              onClick={() => setActiveTab('dashboard')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                activeTab === 'dashboard'
                  ? 'bg-[#2c2c2e] text-[#ffffff] border border-[#3a3a3c]'
                  : 'text-[#8e8e93] hover:text-[#ffffff] hover:bg-[#2c2c2e]/60'
              }`}
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('stats')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                activeTab === 'stats'
                  ? 'bg-[#2c2c2e] text-[#ffffff] border border-[#3a3a3c]'
                  : 'text-[#8e8e93] hover:text-[#ffffff] hover:bg-[#2c2c2e]/60'
              }`}
            >
              Stats
            </button>
          </nav>
          <DevSwitcher current="/" />
        </div>

        {/* Right: Metrics Pills, Notifications & User Avatar */}
        <div className="flex items-center gap-3">
          {/* Date Scope Filter (IST) */}
          <div className="flex items-center gap-1.5 bg-[#1c1c1e] border border-[#2c2c2e] px-2.5 py-1 rounded-md">
            <span className="text-xs font-mono font-medium text-[#8e8e93]">📅 IST:</span>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                if (e.target.value) {
                  setSelectedDate(e.target.value);
                }
              }}
              title="Filter dashboard by assignments on this IST date"
              className="text-xs font-mono font-medium text-[#ffffff] bg-transparent border-none outline-none cursor-pointer"
            />
          </div>

          {stats && (
            <div className="hidden lg:flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-[#2c2c2e] border border-[#3a3a3c] px-2.5 py-1 rounded-md text-xs font-mono font-medium text-[#8e8e93]">
                <span>Candidates:</span>
                <span className="text-[#ffffff] font-semibold">{stats.totalCandidates}</span>
              </div>

              <div className="flex items-center gap-1.5 bg-[#2c2c2e] border border-[#3a3a3c] px-2.5 py-1 rounded-md text-xs font-mono font-medium text-[#8e8e93]">
                <span>Jobs:</span>
                <span className="text-[#ffffff] font-semibold">{stats.totalApplications}</span>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Refresh Data"
            className="text-xs bg-[#1c1c1e] hover:bg-[#2c2c2e] text-[#8e8e93] hover:text-[#ffffff] border border-[#2c2c2e] px-2.5 py-1 rounded-md active:translate-x-[1px] active:translate-y-[1px] font-semibold transition-all disabled:opacity-60"
          >
            <span className={isRefreshing ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
          </button>

          {/* Interactive Notification Bell & Dropdown */}
          <div className="relative" ref={notifRef}>
            <button
              type="button"
              onClick={() => setIsNotifOpen((prev) => !prev)}
              title="Notifications"
              className="relative p-1.5 bg-[#1c1c1e] border border-[#2c2c2e] rounded-md cursor-pointer hover:bg-[#2c2c2e] transition-colors"
            >
              <span className="text-xs">🔔</span>
              {unreadNotifsCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 bg-[#ff453a] text-white text-[10px] font-black rounded-full flex items-center justify-center border border-[#1c1c1e]">
                  {unreadNotifsCount > 9 ? '9+' : unreadNotifsCount}
                </span>
              )}
            </button>

            {isNotifOpen && (
              <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl z-50 overflow-hidden animate-fadeIn shadow-2xl">
                <div className="flex items-center justify-between px-3.5 py-2.5 bg-[#141416] border-b border-[#2c2c2e]">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">🔔</span>
                    <span className="text-xs font-semibold uppercase tracking-wider text-[#ffffff]">
                      Notifications {unreadNotifsCount > 0 && `(${unreadNotifsCount} new)`}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {notifications.length > 0 && (
                      <button
                        type="button"
                        onClick={markAllNotifsAsRead}
                        className="text-[10px] font-semibold text-[#8e8e93] hover:text-[#ffffff] bg-[#2c2c2e] border border-[#3a3a3c] px-2 py-0.5 rounded-md"
                      >
                        Mark all read
                      </button>
                    )}
                    {notifications.length > 0 && (
                      <button
                        type="button"
                        onClick={clearAllNotifs}
                        className="text-[10px] font-semibold text-[#ff453a] hover:text-[#ffffff] bg-[#ff453a]/15 border border-[#ff453a]/30 px-2 py-0.5 rounded-md"
                      >
                        Clear
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setIsNotifOpen(false)}
                      className="text-[#8e8e93] hover:text-[#ffffff] text-xs font-bold px-1"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className="max-h-80 overflow-y-auto p-2.5 space-y-2 custom-scrollbar">
                  {notifications.length === 0 ? (
                    <div className="p-6 text-center text-xs text-[#8e8e93]">
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
                              ? 'bg-[#2c2c2e] border-[#0a84ff]/40 hover:border-[#0a84ff]'
                              : isSuccess
                              ? 'bg-[#2c2c2e] border-[#30d158]/40 hover:border-[#30d158]'
                              : 'bg-[#2c2c2e] border-[#ff453a]/40 hover:border-[#ff453a]'
                          } ${isUnread ? 'border-l-4 border-l-[#0a84ff]' : 'opacity-85'}`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span
                              className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                isApplying
                                  ? 'bg-[#0a84ff]/15 text-[#0a84ff] border border-[#0a84ff]/30'
                                  : isSuccess
                                  ? 'bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30'
                                  : 'bg-[#ff453a]/15 text-[#ff453a] border border-[#ff453a]/30'
                              }`}
                            >
                              {isApplying ? '⏳ Applying' : isSuccess ? '✅ Succeeded' : '❌ Failed'}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-[#8e8e93] font-mono">
                                {notif.timestamp ? new Date(notif.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  clearNotification(notif.id);
                                }}
                                title="Dismiss notification"
                                className="text-[10px] text-[#8e8e93] hover:text-[#ff453a] px-1 py-0.5 rounded hover:bg-[#3a3a3c] font-bold transition-colors"
                              >
                                ✕
                              </button>
                            </div>
                          </div>

                          <div className="text-xs font-semibold text-[#ffffff]">
                            {notif.candidateName || notif.applywizzId}{' '}
                            <span className="font-mono text-[10px] text-[#8e8e93] font-normal">
                              ({notif.applywizzId})
                            </span>
                          </div>

                          <div className="text-[11px] text-[#8e8e93] font-medium truncate mt-0.5">
                            🏢 {notif.companyName} — {notif.jobTitle}
                          </div>

                          {isApplying && (
                            <div className="mt-1 text-[10px] text-[#0a84ff] font-mono flex items-center gap-1">
                              <span className="inline-block animate-spin">⏳</span> Application submission in progress...
                            </div>
                          )}

                          {!isSuccess && !isApplying && (
                            <div className="mt-1.5 p-1.5 bg-[#1c1c1e] border border-[#ff453a]/30 rounded text-[11px] text-[#ff453a] font-mono break-words leading-tight">
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
                                className="text-[10px] font-semibold text-[#30d158] underline hover:text-[#28b84d]"
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
                                className="text-[10px] font-semibold text-[#ff453a] underline hover:text-[#ff453a]/80"
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
          <HeaderSignOut onSignOut={handleSignOut} />
        </div>
      </header>

      {/* Work-History Unreachable Top Banner */}
      {workHistoryUnreachable && !workHistoryBannerDismissed && (
        <div className="bg-[#ff9f0a]/10 border-b border-[#ff9f0a]/30 px-6 py-2 text-xs font-bold text-[#ff9f0a] flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <span>⚠️</span>
            <span>Work-history API unreachable — showing last known assigned candidates.</span>
          </div>
          <button
            type="button"
            onClick={() => setWorkHistoryBannerDismissed(true)}
            className="text-[#ff9f0a] hover:text-white text-sm font-bold transition-colors"
            title="Dismiss warning"
          >
            ✕
          </button>
        </div>
      )}

      {/* Real-time Worker Failure Banner / Toast */}
      {failureAlert && (
        <div className="bg-[#ff453a]/10 border-b border-[#ff453a]/30 px-6 py-3 text-xs font-bold text-[#ff453a] flex items-center justify-between flex-shrink-0 animate-fadeIn">
          <div className="flex items-center gap-2.5">
            <span className="text-base">🚨</span>
            <div>
              <span className="font-bold uppercase tracking-wider text-[#ff453a]">Submission Failed: </span>
              <span className="text-white">
                {failureAlert.companyName ? `${failureAlert.companyName} — ` : ''}
                {failureAlert.reason}
              </span>
              <span className="ml-2 font-mono font-normal text-[11px] text-[#8e8e93]">
                ({new Date(failureAlert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })})
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setFailureAlert(null)}
            className="text-[#ff453a] hover:text-white text-sm font-bold px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
            title="Dismiss alert"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Workspace (Split-screen Dashboard or Stats View) */}
      <div className={`flex-1 overflow-y-auto p-8 max-w-5xl mx-auto w-full custom-scrollbar ${activeTab === 'stats' ? '' : 'hidden'}`}>
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-[#ffffff]">Application Pipeline Stats</h2>
          <p className="text-xs text-[#8e8e93] font-mono mt-0.5">
            Real-time throughput metrics, resolution tier breakdowns, and submission telemetry.
          </p>
        </div>
        {stats?.statsAvailable === false && (
          <p className="mb-4 rounded-xl border border-[#ff9f0a]/40 bg-[#ff9f0a]/15 p-3 text-xs font-semibold text-[#ff9f0a]">
            Application statistics before {stats.statsAvailableFrom || 'the cutover date'} are unavailable.
          </p>
        )}
        {stats?.statsAvailable !== false && stats?.statsPartial && (
          <p className="mb-4 rounded-xl border border-[#ff9f0a]/40 bg-[#ff9f0a]/15 p-3 text-xs font-semibold text-[#ff9f0a]">
            Partial statistics: dates before {stats.statsAvailableFrom} are excluded.
          </p>
        )}

        {stats ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">
                Total Candidates
              </span>
              <div className="text-3xl font-bold text-[#ffffff] mt-2">
                {stats.totalCandidates}
              </div>
              <div className="text-[11px] font-mono text-[#8e8e93] mt-1">
                Ingested &amp; segregated
              </div>
            </div>

            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">
                Total Applications
              </span>
              <div className="text-3xl font-bold text-[#ffffff] mt-2">
                {stats.statsAvailable === false ? '—' : stats.totalApplications}
              </div>
              <div className="text-[11px] font-mono text-[#8e8e93] mt-1">
                Active job assignments
              </div>
            </div>

            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#30d158]">
                Successful Applications
              </span>
              <div className="text-3xl font-bold text-[#ffffff] mt-2">
                {stats.statsAvailable === false ? '—' : stats.successfulApplications ?? 0}
              </div>
              <div className="text-[11px] font-mono text-[#30d158] mt-1">
                APPLIED or EMAIL_PROOF_PENDING
              </div>
            </div>

            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#ff453a]">
                Failed Applications
              </span>
              <div className="text-3xl font-bold text-[#ffffff] mt-2">
                {stats.statsAvailable === false ? '—' : stats.failedApplications ?? 0}
              </div>
              <div className="text-[11px] font-mono text-[#ff453a] mt-1">
                Terminal FAILED submissions
              </div>
            </div>
          </div>
        ) : (
          <div className="p-8 text-center text-xs font-mono text-[#8e8e93]">Loading statistics...</div>
        )}
      </div>

      <div className={`flex flex-1 overflow-hidden ${activeTab === 'dashboard' ? '' : 'hidden'}`}>
        {/* Left Pane: Candidates Directory */}
        <CandidateList
          candidates={candidates}
          selectedId={selectedCandidateId}
          onSelectCandidate={(id) => setSelectedCandidateId((prev) => (prev === id ? null : id))}
          isLoading={isLoadingCandidates || isAuthHydrating}
          emptyMessage={noCandidatesMessage}
          selectedDate={selectedDate}
        />

        {/* Right Pane: Candidate Jobs Queue & Form Renderer */}
        <main className="flex-1 flex flex-col bg-[#0a0a0a] overflow-hidden">
          {candidateDetail ? (
            <>
              {/* Right Top: Job Queue Tabs */}
              <JobQueueView
                candidate={candidateDetail}
                selectedApplywizzId={selectedCandidateId}
                selectedJobUrl={selectedJobUrl}
                onSelectJob={(url) => {
                  setSelectedJobUrl(url);
                  if (!url) {
                    setApplication(null);
                    setIsLoadingApplication(false);
                  }
                }}
              />

              {/* Right Main: Form Renderer */}
              <FormRenderer
                key={selectedJobUrl || 'no-job'}
                application={application}
                isLoading={isLoadingApplication}
                candidateName={candidateDetail.clientName}
                apiBaseUrl={API_BASE_URL}
                onFieldUpdate={handleFieldUpdate}
                onStatusChange={handleStatusChange}
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-[#8e8e93]">
              <div className="text-4xl mb-2">👤</div>
              <p className="text-sm font-semibold text-[#ffffff]">No Candidate Selected</p>
              <p className="text-xs text-[#8e8e93] mt-1 font-medium">
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
