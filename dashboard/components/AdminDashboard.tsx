import React, { useState, useEffect, useCallback } from 'react';
import { useRequireRole, getTodayIST, apiFetch } from '../hooks/useSession.js';
import { DevSwitcher } from './DevSwitcher.js';
import { HeaderSignOut } from './HeaderSignOut.js';

interface EmailProofData {
  subject?: string;
  from?: string;
  received_at?: string;
  body_text?: string;
  [key: string]: unknown;
}

interface ApplicationProofData {
  id?: string;
  client?: string;
  client_name?: string;
  candidate_name?: string;
  jobTitle?: string;
  jobUrl: string;
  companyName?: string;
  operator?: string;
  assigned_ca_email?: string;
  status: string;
  createdAt?: string;
  proof_web_url?: string;
  proof_email_url?: string;
  proof_email_json?: Record<string, unknown>;
  error_message?: string;
  errorMessage?: string;
}

interface ManagerClientItem {
  id?: string;
  job_url: string;
  proof_web_url?: string;
  proof_email_url?: string;
  proof_email_json?: Record<string, unknown>;
  error_message?: string;
}

interface ManagerClientRow {
  client: string;
  applications: number;
  submitted?: number;
  completed: number;
  pending: number;
  failed: number;
  assignedTo?: string;
  submittedApplications?: ManagerClientItem[];
  completedApplications?: ManagerClientItem[];
  pendingApplications?: ManagerClientItem[];
  failedApplications?: ManagerClientItem[];
}

interface AdminOverview {
  operators: number;
  activeOperators: number;
  inactiveOperators: number;
  submitted?: number;
  completed: number;
  applied: number;
  running: number;
  queued: number;
  failed: number;
  supabasePercent: number;
  aiPercent: number;
  resumePercent: number;
  recentActivity?: Array<{ id: string; action: string; actor_email?: string; created_at: string }>;
}

interface AdminManager {
  name: string;
  email: string;
  assignedOperators?: number;
  assignedClients?: number;
  applications?: number;
  status?: string;
}

interface ManagerDashboardPayload {
  submitted?: number;
  completed?: number;
  totals?: { submitted?: number; applied?: number; pending?: number; failed?: number };
  rows?: ManagerClientRow[];
}

interface AdminOperator {
  name: string;
  email: string;
  status: string;
  workload?: number;
  lastSignInAt?: string;
  last_sign_in_at?: string;
}

interface AdminActivityEvent {
  id: string;
  action: string;
  actor_email: string;
  target_type: string;
  target_id: string;
  created_at: string;
}

interface AdminSystemStatus {
  lights?: Record<string, string>;
  queue?: { queued?: number; applying?: number; stuck?: number };
  workersRunning?: boolean;
}

interface IngestStatus {
  running?: boolean;
  startedAt?: string;
  finishedAt?: string;
  processedCount?: number;
  processedFile?: string;
  message?: string;
  error?: string;
  phase?: string;
  stopEnabled?: boolean;
}

interface CAFailureStat {
  ca_email: string;
  failure_count: number;
  application_ids: string[];
}

const EmailProofModal: React.FC<{ proof: EmailProofData | null; onClose: () => void }> = ({ proof, onClose }) => {
  if (!proof) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1A1A2E]/80" onClick={onClose}>
      <div className="w-full max-w-2xl bg-white border-2 border-[#1A1A2E] rounded-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 bg-[#EFF6FF] border-b-2 border-[#1A1A2E] flex justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase text-[#64748B]">Email proof</p>
            <h3 className="text-sm font-bold">{proof.subject || '(No subject)'}</h3>
          </div>
          <button type="button" onClick={onClose} className="font-black">✕</button>
        </header>
        <div className="px-5 py-4 bg-[#FAF4EB] max-h-[50vh] overflow-y-auto text-xs whitespace-pre-wrap">{(proof.body_text || '').slice(0, 4000)}</div>
      </div>
    </div>
  );
};

const ApplicationProofModal: React.FC<{
  application: ApplicationProofData | null;
  onClose: () => void;
  onEmailProof?: (proof: EmailProofData) => void;
}> = ({ application, onClose, onEmailProof }) => {
  if (!application) return null;

  const { jobTitle, companyName, operator, assigned_ca_email, status, 
          proof_web_url, proof_email_url, proof_email_json, error_message, errorMessage,
          candidate_name, client_name, client } = application;

  const displayOperator = (operator || assigned_ca_email || '').trim() || '—';
  const displayCandidateName = candidate_name || client_name || client || '—';
  const displayErrorMessage = error_message || errorMessage || '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1A1A2E]/80" onClick={onClose}>
      <div className="w-full max-w-2xl bg-white border-2 border-[#1A1A2E] rounded-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 bg-[#EFF6FF] border-b-2 border-[#1A1A2E] flex justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase text-[#64748B]">Application Details</p>
            <h3 className="text-sm font-bold">{jobTitle || 'Job Application'}</h3>
            <p className="text-xs font-mono mt-1">Candidate: {displayCandidateName}</p>
            <p className="text-xs font-mono">Operator: {displayOperator}</p>
            {companyName && companyName !== '—' && <p className="text-xs font-mono">Company: {companyName}</p>}
          </div>
          <button type="button" onClick={onClose} className="font-black">✕</button>
        </header>
        <div className="px-5 py-4 bg-[#FAF4EB] max-h-[50vh] overflow-y-auto">
          <div className="space-y-4">
            {proof_web_url && (
              <div className="text-center">
                <p className="text-xs font-bold text-[#64748B] mb-1">Web Proof Screenshot</p>
                <a href={proof_web_url} target="_blank" rel="noopener noreferrer" className="block max-w-xs rounded border border-[#1A1A2E] mx-auto py-1 px-3 bg-white hover:bg-[#FAF4EB] font-bold text-xs">
                  View Web Proof Image
                </a>
              </div>
            )}
            
            {(proof_email_url || proof_email_json) && (
              <div>
                <p className="text-xs font-bold text-[#64748B] mb-1">Email Proof</p>
                {proof_email_url ? (
                  <a href={proof_email_url} target="_blank" rel="noopener noreferrer" className="underline font-bold">View Email Screenshot</a>
                ) : (
                  <button
                    type="button"
                    className="underline font-bold text-xs"
                    onClick={() => onEmailProof && proof_email_json && onEmailProof(proof_email_json as EmailProofData)}
                  >
                    View Email Proof
                  </button>
                )}
              </div>
            )}
            
            {status === 'FAILED' && displayErrorMessage && (
              <div className="bg-[#FEE2E2] border border-[#991B1B] rounded p-3">
                <p className="text-xs font-bold text-[#991B1B] mb-1">Error Message</p>
                <p className="text-xs text-[#991B1B] whitespace-pre-wrap">{displayErrorMessage}</p>
              </div>
            )}
            
            {status === 'EMAIL_PROOF_PENDING' && (
              <div className="bg-[#FFF8D6] border border-[#1A1A2E] rounded p-3">
                <p className="text-xs font-bold text-[#64748B] mb-1">Email Proof Status</p>
                <p className="text-xs text-[#64748B]">Email proof pending</p>
              </div>
            )}

            {status === 'APPLIED' && !proof_web_url && !proof_email_url && !proof_email_json && (
              <div className="bg-white border border-[#1A1A2E]/20 rounded p-3 text-center">
                <p className="text-xs text-[#64748B]">Application marked APPLIED. Proof capture processing or unavailable.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const ClientTable: React.FC<{
  rows: ManagerClientRow[];
  loading: boolean;
  expanded: string | null;
  onToggle: (key: string) => void;
  onEmailProof: (proof: EmailProofData) => void;
}> = ({ rows, loading, expanded, onToggle, onEmailProof }) => {
  return (
    <div className="bg-white border-2 border-[#1A1A2E] rounded overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]">
          <tr>{['Client', 'Apps', 'Submitted', 'Pending', 'Failed', 'Assigned'].map((h) => <th key={h} className="p-3 font-black uppercase">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const openKey = expanded && expanded.startsWith(`${row.client}:`) ? expanded : null;
            const mode = openKey ? openKey.split(':')[1] : null;
            const items = (mode === 'submitted' || mode === 'completed') ? (row.submittedApplications || row.completedApplications) : mode === 'pending' ? row.pendingApplications : mode === 'failed' ? row.failedApplications : [];
            return (
              <React.Fragment key={row.client}>
                <tr className="border-b border-[#1A1A2E]/20">
                  <td className="p-3 font-black">{row.client}</td>
                  <td className="p-3 font-mono">{row.applications}</td>
                  <td className="p-3">{(row.submitted ?? row.completed) ? <button type="button" className="font-mono underline" onClick={() => onToggle(`${row.client}:submitted`)}>{row.submitted ?? row.completed}</button> : <span className="font-mono">0</span>}</td>
                  <td className="p-3">{row.pending ? <button type="button" className="font-mono underline" onClick={() => onToggle(`${row.client}:pending`)}>{row.pending}</button> : <span className="font-mono">0</span>}</td>
                  <td className="p-3">{row.failed ? <button type="button" className="font-mono underline" onClick={() => onToggle(`${row.client}:failed`)}>{row.failed}</button> : <span className="font-mono">0</span>}</td>
                  <td className="p-3 text-[#64748B]">{row.assignedTo || '—'}</td>
                </tr>
                {openKey && (
                  <tr><td colSpan={6} className="p-0">
                    <div className="bg-[#FFF5EB] border-t-2 border-[#1A1A2E] px-4 py-3 space-y-2">
                      {(items || []).map((item, i) => (
                        <div key={item.id || i} className="flex flex-col md:flex-row md:justify-between gap-1 text-xs">
                          <a href={item.job_url} target="_blank" rel="noopener noreferrer" className="font-bold underline break-all">{item.job_url}</a>
                          {(mode === 'submitted' || mode === 'completed') && (
                            <span className="flex gap-3">
                              {item.proof_web_url ? <a href={item.proof_web_url} target="_blank" rel="noopener noreferrer" className="underline font-bold">Web proof</a> : <span className="text-[#64748B]">Web proof unavailable</span>}
                              {item.proof_email_url ? <a href={item.proof_email_url} target="_blank" rel="noopener noreferrer" className="underline font-bold">Email screenshot</a> : item.proof_email_json ? <button type="button" className="underline font-bold" onClick={() => onEmailProof(item.proof_email_json as EmailProofData)}>View email proof</button> : <span className="text-[#64748B]">Email proof unavailable</span>}
                            </span>
                          )}
                          {mode === 'failed' && <span className="text-[#991B1B]">{item.error_message || 'Failure reason unavailable'}</span>}
                        </div>
                      ))}
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {!rows.length && !loading && <p className="p-6 text-center text-[#64748B]">No rows for this date.</p>}
    </div>
  );
};

export const AdminDashboard: React.FC = () => {
  const { token, loading: authLoading, isAuthorized, signOut } = useRequireRole(['admin']);

  const [tab, setTab] = useState<'overview' | 'managers' | 'operators' | 'applications' | 'activity' | 'system' | 'guide'>('overview');
  const [date, setDate] = useState<string>(getTodayIST);
  const [statsRange, setStatsRange] = useState<'day' | 'week' | 'month'>('day');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [managers, setManagers] = useState<AdminManager[]>([]);
  const [selectedManager, setSelectedManager] = useState<string | null>(null);
  const [managerDash, setManagerDash] = useState<ManagerDashboardPayload>({ rows: [], totals: {} });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [emailProof, setEmailProof] = useState<EmailProofData | null>(null);
  const [applicationProof, setApplicationProof] = useState<ApplicationProofData | null>(null);
  const [operators, setOperators] = useState<AdminOperator[]>([]);
  const [opSearch, setOpSearch] = useState<string>('');
  const [opStatus, setOpStatus] = useState<string>('all');
  const [opManager, setOpManager] = useState<string>('');
  const [applications, setApplications] = useState<ApplicationProofData[]>([]);
  const [appSearch, setAppSearch] = useState<string>('');
  const [appStatus, setAppStatus] = useState<string>('');
  const [activity, setActivity] = useState<AdminActivityEvent[]>([]);
  const [activityWarning, setActivityWarning] = useState<string>('');
  const [system, setSystem] = useState<AdminSystemStatus | null>(null);
  const [caFailureStats, setCaFailureStats] = useState<CAFailureStat[]>([]);
  const [ingestRun, setIngestRun] = useState<IngestStatus | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const loadJson = useCallback(async <T,>(url: string): Promise<T> => {
    const res = await apiFetch(url);
    const payload: unknown = await res.json();
    if (!res.ok) {
      const err = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : 'Request failed';
      throw new Error(err);
    }
    return payload as T;
  }, []);

  const refresh = useCallback(async () => {
    if (!token || !isAuthorized) return;
    setLoading(true);
    setError('');
    try {
      if (tab === 'overview') {
        const payload = await loadJson<AdminOverview>(`/api/admin/overview?range=${statsRange}`);
        setOverview(payload);
      }
      if (tab === 'managers') {
        const payload = await loadJson<{ managers?: AdminManager[] }>(`/api/admin/managers?date=${encodeURIComponent(date)}`);
        setManagers(payload.managers || []);
      }
      if (tab === 'operators') {
        const managerPayload = await loadJson<{ managers?: AdminManager[] }>(`/api/admin/managers?date=${encodeURIComponent(date)}`);
        setManagers(managerPayload.managers || []);
        const params = new URLSearchParams({ date, search: opSearch, status: opStatus });
        if (opManager) params.set('manager', opManager);
        const payload = await loadJson<{ operators?: AdminOperator[] }>(`/api/admin/operators?${params}`);
        setOperators(payload.operators || []);
      }
      if (tab === 'applications') {
        const params = new URLSearchParams({ date, search: appSearch, limit: '100' });
        if (appStatus) params.set('status', appStatus);
        const payload = await loadJson<{ applications?: ApplicationProofData[] }>(`/api/admin/applications?${params}`);
        setApplications(payload.applications || []);
      }
      if (tab === 'activity') {
        const payload = await loadJson<{ events?: AdminActivityEvent[]; warning?: string }>('/api/admin/activity?limit=100');
        setActivity(payload.events || []);
        setActivityWarning(payload.warning || '');
      }
      if (tab === 'system') {
        const payload = await loadJson<AdminSystemStatus>('/api/admin/system-status');
        setSystem(payload);
        setCaFailureStats(await loadJson<CAFailureStat[]>('/api/admin/ca-failure-stats'));
      }
      try {
        const status = await loadJson<IngestStatus>('/api/admin/ingest-status');
        setIngestRun(status);
      } catch {
        if (tab === 'system') setIngestRun(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [tab, date, statsRange, token, isAuthorized, opSearch, opStatus, opManager, appSearch, appStatus, loadJson]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  const openManager = async (managerEmail: string) => {
    setSelectedManager(managerEmail);
    setExpanded(null);
    try {
      const payload = await loadJson<ManagerDashboardPayload>(`/api/admin/managers/${encodeURIComponent(managerEmail)}/dashboard?date=${encodeURIComponent(date)}`);
      setManagerDash(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load manager dashboard');
    }
  };

  const handleStart = async () => {
    try {
      const res = await apiFetch('/api/admin/trigger-ingest-from-storage', { method: 'POST' });
      const payload: unknown = await res.json();
      if (!res.ok) {
        const err = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : 'Unable to start ingest';
        setError(err);
        return;
      }
      const data = payload as { startedAt?: string };
      setIngestRun({ running: true, startedAt: data.startedAt, stopEnabled: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to start ingest');
    }
  };

  const handleStop = async () => {
    try {
      const res = await apiFetch('/api/admin/stop-ingest', { method: 'POST' });
      const payload: unknown = await res.json();
      if (!res.ok) {
        const err = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : 'Unable to stop ingest';
        setError(err);
        return;
      }
      const data = payload as IngestStatus;
      setIngestRun((prev) => ({ ...(prev || {}), ...data, running: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to stop ingest');
    }
  };

  useEffect(() => {
    if (!token || !isAuthorized) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await loadJson<IngestStatus>('/api/admin/ingest-status');
        if (!cancelled) setIngestRun(status);
      } catch {
        /* ignore poll errors */
      }
    };
    void poll();
    const interval = setInterval(() => {
      void poll();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [token, isAuthorized, loadJson]);

  useEffect(() => {
    if (!ingestRun || ingestRun.running || (!ingestRun.error && !ingestRun.finishedAt)) return;
    const timeout = setTimeout(() => {
      setIngestRun((current) => current && !current.running ? null : current);
    }, 60000);
    return () => clearTimeout(timeout);
  }, [ingestRun?.running, ingestRun?.error, ingestRun?.finishedAt]);

  if (authLoading) {
    return <main className="min-h-screen p-8 text-xs font-mono font-bold bg-[#FFF5EB] text-[#1A1A2E]">Checking access…</main>;
  }

  if (!token || !isAuthorized) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-[#FFF5EB] text-[#1A1A2E]">
        <div className="max-w-md bg-white border-2 border-[#1A1A2E] rounded-lg p-6">
          <h1 className="text-xl font-black mb-2">Admin dashboard</h1>
          <a href="/" className="inline-block bg-[#E88474] border-2 border-[#1A1A2E] px-4 py-2 text-sm font-bold rounded">Sign in</a>
        </div>
      </main>
    );
  }

  const tabs: Array<'overview' | 'managers' | 'operators' | 'applications' | 'activity' | 'system' | 'guide'> =
    ['overview', 'managers', 'operators', 'applications', 'activity', 'system', 'guide'];

  const lightClass = (status?: string) =>
    status === 'ok' ? 'bg-[#9AC89A]' : status === 'degraded' ? 'bg-[#F4D66B]' : status === 'not_configured' ? 'bg-[#E2E8F0]' : 'bg-[#FECACA]';

  return (
    <main className="min-h-screen p-4 md:p-8 font-sans bg-[#FFF5EB] text-[#1A1A2E]">
      <EmailProofModal proof={emailProof} onClose={() => setEmailProof(null)} />
      <ApplicationProofModal application={applicationProof} onClose={() => setApplicationProof(null)} onEmailProof={setEmailProof} />
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col gap-4 md:flex-row md:justify-between md:items-end mb-6">
          <div className="flex items-center gap-3">
            <img src="/logo.webp" alt="ApplyWizz" className="w-10 h-10 rounded-lg border-2 border-[#1A1A2E] object-cover bg-black" />
            <div>
              <p className="text-xs font-mono font-bold uppercase tracking-widest text-[#64748B]">ApplyWizz / Org ops</p>
              <h1 className="text-3xl font-black">Admin dashboard</h1>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <DevSwitcher current="/admin" />
            <label className="text-xs font-bold uppercase">Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="block mt-1 border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-sm font-mono bg-white" />
            </label>
            <div className="text-xs font-bold uppercase">Stats
              <div className="mt-1 flex gap-1">
                {(['day', 'week', 'month'] as const).map((range) => (
                  <button key={range} type="button" onClick={() => setStatsRange(range)} className={`border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-xs ${statsRange === range ? 'bg-[#E88474] text-black' : 'bg-white'}`}>{range}</button>
                ))}
              </div>
            </div>
            <button type="button" onClick={() => void refresh()} className="bg-white border-2 border-[#1A1A2E] px-3 py-2 text-xs font-bold rounded">Refresh</button>
            <HeaderSignOut onSignOut={signOut} />
          </div>
        </header>
        <nav className="flex flex-wrap gap-2 mb-6">
          {tabs.map((id) => (
            <button key={id} type="button" onClick={() => { setTab(id); setSelectedManager(null); }} className={`px-3 py-1.5 text-xs font-bold border-2 border-[#1A1A2E] rounded capitalize ${tab === id ? 'bg-[#E88474] text-black' : 'bg-white'}`}>{id}</button>
          ))}
        </nav>
        {error && <div className="mb-4 bg-[#FECACA] border-2 border-[#991B1B] rounded p-3 text-sm font-bold">{error}</div>}
        {loading && <p className="text-xs font-mono font-bold mb-4">Loading…</p>}

        {tab === 'overview' && overview && (
          <>
            <div id="ingestStatusBar" className={`mb-6 border-2 border-[#1A1A2E] rounded p-3 text-xs font-bold flex flex-wrap items-center justify-between gap-3 ${
              ingestRun?.running
                ? 'bg-[#E2F0FB] text-[#1E3A5F] animate-pulse'
                : ingestRun?.error
                  ? 'bg-[#FECACA] text-[#991B1B]'
                  : ingestRun?.finishedAt
                    ? 'bg-[#D1FAE5] text-[#065F46]'
                    : 'bg-[#E2E8F0] text-[#475569]'
            }`}>
              <span id="ingestStatusText">
                {ingestRun?.running
                  ? `Pipeline running — ${ingestRun.phase ? `${ingestRun.phase}: ` : ''}${ingestRun.message || ingestRun.processedFile || 'processing CSV'}`
                  : ingestRun?.error
                    ? `Last run failed: ${ingestRun.error}`
                    : ingestRun?.finishedAt
                      ? `Last run completed at ${new Date(ingestRun.finishedAt).toLocaleString()} — ${ingestRun.processedCount ?? 0} files processed`
                      : 'Pipeline idle — awaiting CSV upload'}
              </span>
              <div className="flex gap-2">
                <button type="button" id="ingestStartBtn" onClick={() => void handleStart()} disabled={Boolean(ingestRun?.running)} className="bg-[#9AC89A] text-[#1A1A2E] border-2 border-[#1A1A2E] px-3 py-1.5 text-xs font-bold rounded disabled:opacity-60">
                  {ingestRun?.running ? 'Running…' : '▶ Start'}
                </button>
                {ingestRun?.running ? (
                  <button type="button" id="ingestStopBtn" onClick={() => void handleStop()} disabled={ingestRun?.stopEnabled === false} className="bg-[#FECACA] text-[#1A1A2E] border-2 border-[#1A1A2E] px-3 py-1.5 text-xs font-bold rounded disabled:opacity-50">⏹ Stop</button>
                ) : null}
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              {[
                ['Operators', overview.operators],
                ['Active operators', overview.activeOperators],
                ['Inactive operators', overview.inactiveOperators],
                ['Submitted', overview.submitted ?? overview.completed],
                ['Applied', overview.applied],
                ['Running', overview.running],
                ['Queued', overview.queued],
                ['Failed', overview.failed],
                ['Supabase %', overview.supabasePercent],
                ['AI %', overview.aiPercent],
                ['Resume %', overview.resumePercent],
              ].map(([label, val]) => (
                <div key={label} className="bg-white border-2 border-[#1A1A2E] rounded p-4">
                  <p className="text-xs font-bold uppercase">{label}</p>
                  <p className="text-2xl font-black mt-1">{val ?? 0}</p>
                </div>
              ))}
            </div>
            <div className="bg-white border-2 border-[#1A1A2E] rounded">
              <h2 className="p-3 font-black uppercase text-xs border-b-2 border-[#1A1A2E] bg-[#FAF4EB]">Recent activity</h2>
              <ul className="text-xs divide-y divide-[#1A1A2E]/20">
                {(overview.recentActivity || []).map((event) => (
                  <li key={event.id} className="p-3">
                    <span className="font-black">{event.action}</span> · {event.actor_email || 'system'} · {new Date(event.created_at).toLocaleString()}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {tab === 'managers' && !selectedManager && (
          <div className="bg-white border-2 border-[#1A1A2E] rounded overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]">
                <tr>{['Manager', 'Operators', 'Clients', 'Apps', 'Status'].map((h) => <th key={h} className="p-3 font-black uppercase">{h}</th>)}</tr>
              </thead>
              <tbody>
                {managers.map((manager) => (
                  <tr key={manager.email} className="border-b border-[#1A1A2E]/20">
                    <td className="p-3">
                      <button type="button" className="font-black underline" onClick={() => void openManager(manager.email)}>{manager.name}</button>
                      <p className="font-mono text-[#64748B]">{manager.email}</p>
                    </td>
                    <td className="p-3 font-mono">{manager.assignedOperators ?? 0}</td>
                    <td className="p-3 font-mono">{manager.assignedClients ?? 0}</td>
                    <td className="p-3 font-mono">{manager.applications ?? 0}</td>
                    <td className="p-3 uppercase font-bold">{manager.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'managers' && selectedManager && (
          <div className="space-y-4">
            <button type="button" className="text-xs font-bold underline" onClick={() => setSelectedManager(null)}>← All managers</button>
            <p className="text-sm font-black">{selectedManager}</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['Submitted', managerDash.submitted ?? managerDash.totals?.submitted],
                ['Applied', managerDash.totals?.applied],
                ['Pending', managerDash.totals?.pending],
                ['Failed', managerDash.totals?.failed],
              ].map(([label, val]) => (
                <div key={label} className="bg-white border-2 border-[#1A1A2E] rounded p-3">
                  <p className="text-[10px] font-bold uppercase">{label}</p>
                  <p className="text-xl font-black">{val ?? 0}</p>
                </div>
              ))}
            </div>
            <ClientTable
              rows={managerDash.rows || []}
              loading={loading}
              expanded={expanded}
              onToggle={(key) => setExpanded(expanded === key ? null : key)}
              onEmailProof={setEmailProof}
            />
          </div>
        )}

        {tab === 'operators' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <input value={opSearch} onChange={(e) => setOpSearch(e.target.value)} placeholder="Search operators" className="border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-sm" />
              <select value={opStatus} onChange={(e) => setOpStatus(e.target.value)} className="border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-sm">
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              <select value={opManager} onChange={(e) => setOpManager(e.target.value)} className="border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-sm">
                <option value="">Any manager</option>
                {managers.map((manager) => <option key={manager.email} value={manager.email}>{manager.name || manager.email}</option>)}
              </select>
            </div>
            <div className="bg-white border-2 border-[#1A1A2E] rounded overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]">
                  <tr>{['Operator', 'Status', 'Workload', 'Last sign-in'].map((h) => <th key={h} className="p-3 font-black uppercase">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {operators.map((op) => (
                    <tr key={op.email} className="border-b border-[#1A1A2E]/20">
                      <td className="p-3 font-black">{op.name}<p className="font-mono font-normal text-[#64748B]">{op.email}</p></td>
                      <td className="p-3 uppercase font-bold">{op.status}</td>
                      <td className="p-3 font-mono">{op.workload ?? 0}</td>
                      <td className="p-3 font-mono">{(op.lastSignInAt || op.last_sign_in_at) ? new Date(op.lastSignInAt || op.last_sign_in_at!).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'applications' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <input value={appSearch} onChange={(e) => setAppSearch(e.target.value)} placeholder="Search client / job / operator" className="border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-sm min-w-[16rem]" />
              <select value={appStatus} onChange={(e) => setAppStatus(e.target.value)} className="border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-sm">
                <option value="">All Statuses</option>
                <option value="READY_FOR_REVIEW">Ready for Review</option>
                <option value="APPROVED">Approved</option>
                <option value="QUEUED">Queued</option>
                <option value="APPLYING">Applying</option>
                <option value="APPLIED">Applied</option>
                <option value="FAILED">Failed</option>
                <option value="SKIPPED">Skipped</option>
                <option value="EXPIRED">Expired</option>
                <option value="OTP_REQUIRED">OTP Required</option>
                <option value="CAPTCHA_REQUIRED">CAPTCHA Required</option>
                <option value="EMAIL_PROOF_PENDING">Email Proof Pending</option>
                <option value="DRY_RUN_COMPLETE">Dry Run Complete</option>
              </select>
            </div>
            <div className="bg-white border-2 border-[#1A1A2E] rounded overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-xs">
                <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]">
                  <tr>{['Client', 'Job', 'Company', 'Operator', 'Status', 'Created'].map((h) => <th key={h} className="p-3 font-black uppercase">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {applications.map((row) => (
                    <tr key={row.id} className="border-b border-[#1A1A2E]/20">
                      <td className="p-3 font-black">{row.client}</td>
                      <td className="p-3"><a className="underline break-all" href={row.jobUrl} target="_blank" rel="noopener noreferrer">{row.jobTitle || row.jobUrl}</a></td>
                      <td className="p-3">{row.companyName || '—'}</td>
                      <td className="p-3 font-mono">{(row.operator || row.assigned_ca_email || '').trim() || '—'}</td>
                      <td className="p-3">
                        {row.status === 'APPLIED' && (
                          <button
                            type="button"
                            onClick={() => setApplicationProof(row)}
                            className="font-mono underline decoration-2 text-[#10B981] font-black"
                          >
                            {row.status}
                          </button>
                        )}
                        {row.status === 'FAILED' && (
                          <button
                            type="button"
                            onClick={() => setApplicationProof(row)}
                            className="font-mono underline decoration-2 text-[#EF4444] font-black"
                          >
                            {row.status}
                          </button>
                        )}
                        {row.status === 'EMAIL_PROOF_PENDING' && (
                          <button
                            type="button"
                            onClick={() => setApplicationProof(row)}
                            className="font-mono underline decoration-2 text-[#F59E0B] font-black"
                          >
                            {row.status}
                          </button>
                        )}
                        {row.status !== 'APPLIED' && row.status !== 'FAILED' && row.status !== 'EMAIL_PROOF_PENDING' && (
                          <span className="font-mono">{row.status}</span>
                        )}
                      </td>
                      <td className="p-3 font-mono">{row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'activity' && (
          <div className="bg-white border-2 border-[#1A1A2E] rounded">
            {activityWarning && <p className="p-3 text-xs font-bold bg-[#FEF3C7] border-b-2 border-[#1A1A2E]">{activityWarning}</p>}
            <ul className="text-xs divide-y divide-[#1A1A2E]/20">
              {activity.map((event) => (
                <li key={event.id} className="p-3">
                  <p className="font-black">{event.action}</p>
                  <p className="font-mono text-[#64748B]">{event.actor_email} · {event.target_type} {event.target_id} · {new Date(event.created_at).toLocaleString()}</p>
                </li>
              ))}
            </ul>
            {!activity.length && <p className="p-6 text-center text-[#64748B]">No audit events recorded yet.</p>}
          </div>
        )}

        {tab === 'system' && system && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(system.lights || {}).map(([name, stat]) => (
                <div key={name} className={`border-2 border-[#1A1A2E] rounded p-4 ${lightClass(stat)}`}>
                  <p className="text-xs font-bold uppercase">{name.replace('_', ' ')}</p>
                  <p className="text-lg font-black mt-1 uppercase">{stat}</p>
                </div>
              ))}
            </div>
            <div className="bg-white border-2 border-[#1A1A2E] rounded p-4 text-xs">
              <p>Queue: {system.queue?.queued ?? 0} queued · {system.queue?.applying ?? 0} applying · {system.queue?.stuck ?? 0} stuck</p>
              <p className="mt-1">Ingest: {ingestRun?.running ? 'running' : ingestRun?.error ? `failed — ${ingestRun.error}` : ingestRun?.message || 'idle'}</p>
              <p className="mt-1">Workers: {system.workersRunning ? 'running' : 'stopped'}</p>
            </div>
            <div className="bg-white border-2 border-[#1A1A2E] rounded overflow-x-auto">
              <div className="p-3 border-b-2 border-[#1A1A2E]">
                <p className="font-black">Required Field Failures by CA</p>
                <p className="text-[#64748B]">Click a row to filter failed applications.</p>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]">
                  <tr><th className="p-3 font-black uppercase">CA Email</th><th className="p-3 font-black uppercase">Failure Count</th></tr>
                </thead>
                <tbody>
                  {caFailureStats.map((row) => (
                    <tr
                      key={row.ca_email}
                      className="border-b border-[#1A1A2E]/20 hover:bg-[#FFF5EB] cursor-pointer"
                      onClick={() => { setAppSearch(row.ca_email); setAppStatus('FAILED'); setTab('applications'); }}
                    >
                      <td className="p-3 font-mono">{row.ca_email}</td>
                      <td className="p-3 font-mono font-black">{row.failure_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!caFailureStats.length && <p className="p-4 text-center text-[#64748B]">No required-field failures found.</p>}
            </div>
          </div>
        )}

        {tab === 'guide' && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-2xl font-black text-[#1A1A2E]">Admin Guide</h2>
              <p className="text-xs text-[#64748B] font-mono mt-0.5">Org-wide visibility, ingest control, and operational oversight.</p>
            </div>

            <section className="bg-white border-2 border-[#1A1A2E] rounded-xl p-5">
              <h3 className="text-sm font-black uppercase tracking-wide mb-2">What you can do</h3>
              <p className="text-sm text-[#1A1A2E] leading-relaxed">
                View <span className="font-bold">all</span> managers, operators, and applications. Start or stop CSV ingest from Storage. Inspect system health and audit activity. Application submission still happens on the <span className="font-bold">Operator</span> dashboard — not here.
              </p>
            </section>

            <section className="bg-[#FFF8D6] border-2 border-[#1A1A2E] rounded-xl p-5">
              <h3 className="text-sm font-black uppercase tracking-wide mb-3">Tabs</h3>
              <ul className="space-y-2 text-sm text-[#1A1A2E] leading-relaxed list-disc list-inside">
                <li><span className="font-bold">Overview</span> — org-wide counts and a recent activity snapshot.</li>
                <li><span className="font-bold">Managers</span> — click a manager name to open their client table for the header <span className="font-bold">Date</span>; use ← All managers to go back.</li>
                <li><span className="font-bold">Operators</span> — search; filter active/inactive or by manager.</li>
                <li><span className="font-bold">Applications</span> — search client, job, or operator; optional status filter for the selected date.</li>
                <li><span className="font-bold">Activity</span> — audit-style events (who did what, when).</li>
                <li><span className="font-bold">System</span> — status lights, queue, workers, and ingest state.</li>
              </ul>
            </section>

            <section className="bg-[#FEE2E2] border-2 border-[#991B1B] rounded-xl p-5">
              <h3 className="text-sm font-black text-[#991B1B] uppercase tracking-wide mb-2">Header: Date, Refresh, Start, Stop</h3>
              <ul className="space-y-2 text-sm text-[#1A1A2E] leading-relaxed list-disc list-inside">
                <li><span className="font-bold">Date</span> drives managers, operators, and applications views that use a calendar day.</li>
                <li><span className="font-bold">▶ Start</span> triggers ingest from Storage; watch progress on System.</li>
                <li><span className="font-bold">⏹ Stop</span> requests a graceful stop — use only when you mean to interrupt a run.</li>
              </ul>
            </section>

            <section className="bg-[#E2F0FB] border-2 border-[#1A1A2E] rounded-xl p-5">
              <h3 className="text-sm font-black uppercase tracking-wide mb-3">Important notes</h3>
              <ul className="space-y-2 text-sm text-[#1A1A2E] leading-relaxed list-disc list-inside">
                <li>Ingest or Storage failures often need env credentials — check System and the Dev dashboard if stuck.</li>
                <li>Operator–manager links are set when operators sign in; use Operators/Managers views to verify coverage.</li>
                <li>Empty Activity may mean audit events are not recorded yet (migration 015).</li>
              </ul>
            </section>

            <section className="bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl p-5 text-center">
              <h3 className="text-sm font-black uppercase tracking-wide mb-2">Need help?</h3>
              <p className="text-sm text-[#64748B] leading-relaxed">
                Contact{' '}
                <a href="mailto:yaswanthnaiduyalla@applywizz.ai" className="font-bold text-[#1A1A2E] underline hover:text-[#E88474]">yaswanthnaiduyalla@applywizz.ai</a>{' '}
                on Microsoft Teams.
              </p>
            </section>
          </div>
        )}
      </div>
    </main>
  );
};

export default AdminDashboard;
