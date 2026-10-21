import { useState, useEffect, useRef, useMemo } from 'react';
import type {
  CandidateDetail,
  CandidateSummary,
  DashboardStats,
} from '../types.js';
import type { AuthUser } from '../components/AuthView.js';
import { useSession, apiFetch, sessionRole, isOpsMode } from './useSession.js';
import type { NotificationItem } from '../components/Header/DashboardHeader.js';

const API_BASE_URL = typeof window !== 'undefined' ? window.location.origin : '';

export function getTodayIST(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  const yyyy = istDate.getUTCFullYear();
  const mm = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(istDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function useDashboardState() {
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

  const [selectedDate, setSelectedDate] = useState<string>(getTodayIST);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'stats'>('dashboard');
  const [candidates, setCandidates] = useState<CandidateSummary[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [candidateDetail, setCandidateDetail] = useState<CandidateDetail | null>(null);
  const [selectedJobUrl, setSelectedJobUrl] = useState<string | null>(null);
  const [application, setApplication] = useState<any | null>(null);
  const [mobileScreen, setMobileScreen] = useState<'candidates' | 'jobs' | 'application'>('candidates');

  const [isLoadingCandidates, setIsLoadingCandidates] = useState<boolean>(true);
  const [isAuthHydrating, setIsAuthHydrating] = useState<boolean>(false);
  const [isLoadingApplication, setIsLoadingApplication] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
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
  const [failureAlert, setFailureAlert] = useState<{
    companyName?: string;
    reason: string;
    timestamp: number;
  } | null>(null);

  return {
    opsMode,
    opsManagerEmail,
    currentUser,
    setCurrentUser,
    sessionSignOut,
    selectedDate,
    setSelectedDate,
    activeTab,
    setActiveTab,
    candidates,
    setCandidates,
    stats,
    setStats,
    selectedCandidateId,
    setSelectedCandidateId,
    candidateDetail,
    setCandidateDetail,
    selectedJobUrl,
    setSelectedJobUrl,
    application,
    setApplication,
    mobileScreen,
    setMobileScreen,
    isLoadingCandidates,
    setIsLoadingCandidates,
    isAuthHydrating,
    setIsAuthHydrating,
    isLoadingApplication,
    setIsLoadingApplication,
    isRefreshing,
    setIsRefreshing,
    notifications,
    setNotifications,
    readNotifIds,
    isNotifOpen,
    setIsNotifOpen,
    isClientInfoOpen,
    setIsClientInfoOpen,
    notifRef,
    selectedCandidateRef,
    unreadNotifsCount,
    markAllNotifsAsRead,
    clearNotification,
    clearAllNotifs,
    workHistoryUnreachable,
    setWorkHistoryUnreachable,
    workHistoryBannerDismissed,
    setWorkHistoryBannerDismissed,
    noCandidatesMessage,
    setNoCandidatesMessage,
    wsConnected,
    setWsConnected,
    failureAlert,
    setFailureAlert,
  };
}
