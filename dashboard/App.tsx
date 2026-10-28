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
import { CandidateSidebar } from './components/Queue/CandidateSidebar.js';
import { DashboardHeader } from './components/Header/DashboardHeader.js';
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
import { ClientInfoDrawer } from './components/ClientInfoDrawer.js';

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
  const [mobileScreen, setMobileScreen] = useState<'candidates' | 'jobs' | 'application'>(
    'candidates'
  );

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
  const [isClientInfoOpen, setIsClientInfoOpen] = useState<boolean>(false);
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
    ensureAdminHydrated(selectedDate);
    fetchInitialData(false, selectedDate);
    fetchNotifications(selectedDate);
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
      const [res, jobsRes] = await Promise.all([
        apiFetch(`${API_BASE_URL}/api/candidates/${encodeURIComponent(applywizzId)}`),
        apiFetch(`${API_BASE_URL}/api/candidates/${encodeURIComponent(applywizzId)}/jobs?date=${encodeURIComponent(selectedDate)}`),
      ]);

      if (!isSameApplywizzId(selectedCandidateRef.current, requestedId)) {
        return;
      }

      if (res.status === 403) {
        console.warn(`[Dashboard] 403 Access Denied: candidate ${applywizzId} not accessible`);
        setCandidateDetail(null);
        setSelectedJobUrl(null);
        setApplication(null);
        return;
      }

      if (!res.ok) {
        return;
      }

      const detail: CandidateDetail = await res.json();
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
    } catch (err: any) {
      console.error(`Failed to fetch candidate ${applywizzId}:`, err);
    }
  }, [selectedDate]);

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
        const token = localStorage.getItem('applywizz_auth_token');
        const wsUrl = `${protocol}//${window.location.host}/ws${token ? '?token=' + encodeURIComponent(token) : ''}`;
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

  const realtimeDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    onGlobalUpdate((_row, eventType) => {
      console.log(`[Realtime] Global update detected (${eventType}) - debouncing candidates list refresh`);
      if (realtimeDebounceTimerRef.current) {
        clearTimeout(realtimeDebounceTimerRef.current);
      }
      realtimeDebounceTimerRef.current = setTimeout(() => {
        refreshCandidatesList();
      }, 1500);
    });
    return () => {
      if (realtimeDebounceTimerRef.current) {
        clearTimeout(realtimeDebounceTimerRef.current);
      }
    };
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
      {/* Top Navigation & Brand Header (2-Tier Layout via DashboardHeader) */}
      <DashboardHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedDate={selectedDate}
        setSelectedDate={setSelectedDate}
        stats={stats}
        isRefreshing={isRefreshing}
        onRefresh={handleRefresh}
        onSignOut={handleSignOut}
        notifications={notifications}
        unreadNotifsCount={unreadNotifsCount}
        readNotifIds={readNotifIds}
        isNotifOpen={isNotifOpen}
        setIsNotifOpen={setIsNotifOpen}
        notifRef={notifRef}
        markAllNotifsAsRead={markAllNotifsAsRead}
        clearAllNotifs={clearAllNotifs}
        clearNotification={clearNotification}
        onSelectNotification={(notif) => {
          if (notif.applywizzId) {
            if (notif.applywizzId !== selectedCandidateId) {
              setCandidateDetail(null);
              setSelectedJobUrl(null);
              setApplication(null);
              setIsLoadingApplication(false);
            }
            setSelectedCandidateId(notif.applywizzId);
          }
          if (notif.jobUrl) setSelectedJobUrl(notif.jobUrl);
          setMobileScreen(notif.jobUrl ? 'application' : 'jobs');
          setIsNotifOpen(false);
        }}
      />

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

      <div
        className={`mobile-operator-workspace flex flex-1 overflow-hidden ${activeTab === 'dashboard' ? '' : 'hidden'}`}
        data-mobile-screen={mobileScreen}
      >
        {/* Left Pane: Candidates Directory via CandidateSidebar */}
        <CandidateSidebar
          candidates={candidates}
          selectedId={selectedCandidateId}
          onSelectCandidate={(id) => {
            const isMobile =
              typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
            if (isMobile && selectedCandidateId !== id) {
              setCandidateDetail(null);
              setSelectedJobUrl(null);
              setApplication(null);
            }
            setSelectedCandidateId((prev) => (isMobile ? id : prev === id ? null : id));
            if (isMobile) setMobileScreen('jobs');
          }}
          isLoading={isLoadingCandidates || isAuthHydrating}
          emptyMessage={noCandidatesMessage}
          selectedDate={selectedDate}
        />

        {/* Right Pane: Candidate Jobs Queue & Form Renderer */}
        <main className="mobile-operator-detail flex-1 flex flex-col bg-[#0a0a0a] overflow-hidden">
          {candidateDetail ? (
            <>
              {/* Right Top: Job Queue Tabs */}
              <div className="mobile-stage mobile-stage-jobs">
                <JobQueueView
                  candidate={candidateDetail}
                  selectedApplywizzId={selectedCandidateId}
                  selectedJobUrl={selectedJobUrl}
                  onBack={() => setMobileScreen('candidates')}
                  onOpenClientInfo={() => setIsClientInfoOpen(true)}
                  onSelectJob={(url) => {
                    setSelectedJobUrl(url);
                    setMobileScreen(url ? 'application' : 'jobs');
                    if (!url) {
                      setApplication(null);
                      setIsLoadingApplication(false);
                    }
                  }}
                />
              </div>

              {/* Right Main: Form Renderer */}
              <div className="mobile-stage mobile-stage-application">
                <FormRenderer
                  key={selectedJobUrl || 'no-job'}
                  application={application}
                  isLoading={isLoadingApplication}
                  candidateName={candidateDetail.clientName}
                  apiBaseUrl={API_BASE_URL}
                  onBack={() => setMobileScreen('jobs')}
                  onFieldUpdate={handleFieldUpdate}
                  onStatusChange={handleStatusChange}
                />
              </div>

              {/* Candidate Client Info Slide-Over Drawer */}
              <ClientInfoDrawer
                isOpen={isClientInfoOpen}
                onClose={() => setIsClientInfoOpen(false)}
                candidate={candidateDetail}
              />
            </>
          ) : (
            <div className="mobile-detail-empty flex-1 flex flex-col items-center justify-center text-[#8e8e93]">
              <div className={`mobile-no-candidate-placeholder ${selectedCandidateId ? 'has-selection' : ''}`}>
                <div className="text-4xl mb-2">👤</div>
                <p className="text-sm font-semibold text-[#ffffff]">No Candidate Selected</p>
                <p className="text-xs text-[#8e8e93] mt-1 font-medium">
                  Select a candidate from the left directory to view assigned applications.
                </p>
              </div>
              {selectedCandidateId && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setMobileScreen(mobileScreen === 'application' ? 'jobs' : 'candidates')
                    }
                    className="mobile-screen-back"
                  >
                    <span aria-hidden="true">←</span>{' '}
                    {mobileScreen === 'application' ? 'Applications' : 'Candidates'}
                  </button>
                  <p className="mobile-candidate-loading">Loading applications for candidate…</p>
                </>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
