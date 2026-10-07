import React, { useState, useEffect, useCallback } from 'react';
import { useRequireRole, getTodayIST, apiFetch, apiUploadWithProgress } from '../hooks/useSession.js';
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
  applications: number | null;
  submitted?: number | null;
  completed: number | null;
  pending: number;
  failed: number | null;
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
  totalApplications?: number | null;
  submitted?: number | null;
  completed: number;
  applied: number | null;
  running: number;
  queued: number;
  failed: number | null;
  statsAvailable?: boolean;
  statsPartial?: boolean;
  statsAvailableFrom?: string;
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
  applications?: number | null;
  statsAvailable?: boolean;
  statsAvailableFrom?: string | null;
  status?: string;
}

interface ManagerDashboardPayload {
  submitted?: number;
  completed?: number;
  totals?: { applications?: number | null; submitted?: number | null; applied?: number | null; pending?: number; failed?: number | null };
  statsAvailable?: boolean;
  statsPartial?: boolean;
  statsAvailableFrom?: string | null;
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
  status?: string;
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

const MAX_CSV_UPLOAD_BYTES = 25 * 1024 * 1024;

function detectCsvUploadFormat(csv: string): 'OLD' | 'NEW' | 'UNKNOWN' {
  const firstRecord = csv.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/, 1)[0] || '';
  const headers: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < firstRecord.length; i++) {
    const character = firstRecord[i];
    if (character === '"') {
      if (quoted && firstRecord[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      headers.push(field.trim().toLowerCase().replace(/\s+/g, '_'));
      field = '';
    } else {
      field += character;
    }
  }
  headers.push(field.trim().toLowerCase().replace(/\s+/g, '_'));
  const columns = new Set(headers);
  if (columns.has('company_job_url') && columns.has('applywizz_id') && columns.has('score') && columns.has('lead_name')) {
    return 'NEW';
  }
  if (
    columns.has('applywizz_id')
    && (columns.has('client_name') || columns.has('lead_name'))
    && (columns.has('url') || columns.has('company_job_url') || columns.has('job_url'))
    && columns.has('score')
  ) {
    return 'OLD';
  }
  return 'UNKNOWN';
}

const EmailProofModal: React.FC<{ proof: EmailProofData | null; onClose: () => void }> = ({ proof, onClose }) => {
  if (!proof) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-2xl bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-hidden shadow-2xl text-white" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 bg-[#1c1c1e] border-b border-[#2c2c2e] flex justify-between items-center">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#8e8e93]">Email proof</p>
            <h3 className="text-sm font-bold text-white">{proof.subject || '(No subject)'}</h3>
          </div>
          <button type="button" onClick={onClose} className="text-[#8e8e93] hover:text-white font-bold p-1">✕</button>
        </header>
        <div className="px-5 py-4 bg-[#141416] max-h-[50vh] overflow-y-auto text-xs whitespace-pre-wrap text-[#8e8e93] font-mono leading-relaxed">{(proof.body_text || '').slice(0, 4000)}</div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-2xl bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-hidden shadow-2xl text-white" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 bg-[#1c1c1e] border-b border-[#2c2c2e] flex justify-between items-start">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#8e8e93]">Application Details</p>
            <h3 className="text-sm font-bold text-white">{jobTitle || 'Job Application'}</h3>
            <p className="text-xs font-mono mt-1 text-[#8e8e93]">Candidate: <span className="text-white">{displayCandidateName}</span></p>
            <p className="text-xs font-mono text-[#8e8e93]">Operator: <span className="text-white">{displayOperator}</span></p>
            {companyName && companyName !== '—' && <p className="text-xs font-mono text-[#8e8e93]">Company: <span className="text-white">{companyName}</span></p>}
          </div>
          <button type="button" onClick={onClose} className="text-[#8e8e93] hover:text-white font-bold p-1">✕</button>
        </header>
        <div className="px-5 py-4 bg-[#141416] max-h-[50vh] overflow-y-auto">
          <div className="space-y-4">
            {proof_web_url && (
              <div className="text-center">
                <p className="text-xs font-bold text-[#8e8e93] mb-1">Web Proof Screenshot</p>
                <a href={proof_web_url} target="_blank" rel="noopener noreferrer" className="block max-w-xs rounded-lg border border-[#3a3a3c] mx-auto py-1.5 px-3 bg-[#2c2c2e] hover:bg-[#3a3a3c] font-bold text-xs text-white transition-colors">
                  View Web Proof Image
                </a>
              </div>
            )}
            
            {(proof_email_url || proof_email_json) && (
              <div>
                <p className="text-xs font-bold text-[#8e8e93] mb-1">Email Proof</p>
                {proof_email_url ? (
                  <a href={proof_email_url} target="_blank" rel="noopener noreferrer" className="underline font-bold text-[#0a84ff]">View Email Screenshot</a>
                ) : (
                  <button
                    type="button"
                    className="underline font-bold text-xs text-[#0a84ff]"
                    onClick={() => onEmailProof && proof_email_json && onEmailProof(proof_email_json as EmailProofData)}
                  >
                    View Email Proof
                  </button>
                )}
              </div>
            )}
            
            {status === 'FAILED' && displayErrorMessage && (
              <div className="bg-[#ff453a]/10 border border-[#ff453a]/30 rounded-lg p-3">
                <p className="text-xs font-bold text-[#ff453a] mb-1">Error Message</p>
                <p className="text-xs text-[#ff453a] whitespace-pre-wrap">{displayErrorMessage}</p>
              </div>
            )}
            
            {status === 'EMAIL_PROOF_PENDING' && (
              <div className="bg-[#ff9f0a]/10 border border-[#ff9f0a]/30 rounded-lg p-3">
                <p className="text-xs font-bold text-[#ff9f0a] mb-1">Email Proof Status</p>
                <p className="text-xs text-[#ff9f0a]">Email proof pending</p>
              </div>
            )}

            {status === 'APPLIED' && !proof_web_url && !proof_email_url && !proof_email_json && (
              <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-lg p-3 text-center">
                <p className="text-xs text-[#8e8e93]">Application marked APPLIED. Proof capture processing or unavailable.</p>
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
  statsAvailable?: boolean;
  expanded: string | null;
  onToggle: (key: string) => void;
  onEmailProof: (proof: EmailProofData) => void;
}> = ({ rows, loading, statsAvailable = true, expanded, onToggle, onEmailProof }) => {
  return (
    <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="bg-[#2c2c2e]/60 border-b border-[#2c2c2e] text-[#8e8e93]">
          <tr>{['Client', 'Apps', 'Submitted', 'Pending', 'Failed', 'Assigned'].map((h) => <th key={h} className="p-3 font-semibold uppercase tracking-wider">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-[#2c2c2e]/50">
          {rows.map((row) => {
            const openKey = expanded && expanded.startsWith(`${row.client}:`) ? expanded : null;
            const mode = openKey ? openKey.split(':')[1] : null;
            const items = (mode === 'submitted' || mode === 'completed') ? (row.submittedApplications || row.completedApplications) : mode === 'pending' ? row.pendingApplications : mode === 'failed' ? row.failedApplications : [];
            return (
              <React.Fragment key={row.client}>
                <tr className="hover:bg-[#2c2c2e]/30 transition-colors">
                  <td className="p-3 font-bold text-white">{row.client}</td>
                  <td className="p-3 font-mono text-white">{statsAvailable ? row.applications ?? 0 : '—'}</td>
                  <td className="p-3">{!statsAvailable ? <span className="font-mono text-[#8e8e93]">—</span> : (row.submitted ?? row.completed) ? <button type="button" className="font-mono text-[#30d158] font-bold underline hover:opacity-80" onClick={() => onToggle(`${row.client}:submitted`)}>{row.submitted ?? row.completed}</button> : <span className="font-mono text-[#8e8e93]">0</span>}</td>
                  <td className="p-3">{row.pending ? <button type="button" className="font-mono text-[#ff9f0a] font-bold underline hover:opacity-80" onClick={() => onToggle(`${row.client}:pending`)}>{row.pending}</button> : <span className="font-mono text-[#8e8e93]">0</span>}</td>
                  <td className="p-3">{!statsAvailable ? <span className="font-mono text-[#8e8e93]">—</span> : row.failed ? <button type="button" className="font-mono text-[#ff453a] font-bold underline hover:opacity-80" onClick={() => onToggle(`${row.client}:failed`)}>{row.failed}</button> : <span className="font-mono text-[#8e8e93]">0</span>}</td>
                  <td className="p-3 text-[#8e8e93]">{row.assignedTo || '—'}</td>
                </tr>
                {openKey && (
                  <tr><td colSpan={6} className="p-0">
                    <div className="bg-[#141416] border-t border-[#2c2c2e] px-4 py-3 space-y-2">
                      {(items || []).map((item, i) => (
                        <div key={item.id || i} className="flex flex-col md:flex-row md:justify-between gap-1 text-xs">
                          <a href={item.job_url} target="_blank" rel="noopener noreferrer" className="font-bold underline text-[#0a84ff] break-all">{item.job_url}</a>
                          {(mode === 'submitted' || mode === 'completed') && (
                            <span className="flex gap-3">
                              {item.proof_web_url ? <a href={item.proof_web_url} target="_blank" rel="noopener noreferrer" className="underline font-bold text-[#5ac8fa]">Web proof</a> : <span className="text-[#8e8e93]">Web proof unavailable</span>}
                              {item.proof_email_url ? <a href={item.proof_email_url} target="_blank" rel="noopener noreferrer" className="underline font-bold text-[#0a84ff]">Email screenshot</a> : item.proof_email_json ? <button type="button" className="underline font-bold text-[#0a84ff]" onClick={() => onEmailProof(item.proof_email_json as EmailProofData)}>View email proof</button> : <span className="text-[#8e8e93]">Email proof unavailable</span>}
                            </span>
                          )}
                          {mode === 'failed' && <span className="text-[#ff453a] font-mono">{item.error_message || 'Failure reason unavailable'}</span>}
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
      {!rows.length && !loading && <p className="p-6 text-center text-[#8e8e93]">No rows for this date.</p>}
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
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvValidationError, setCsvValidationError] = useState<string>('');
  const [csvFeedbackError, setCsvFeedbackError] = useState<string>('');
  const [csvUploadProgress, setCsvUploadProgress] = useState<number | null>(null);
  const [csvUploadBusy, setCsvUploadBusy] = useState<boolean>(false);
  const [csvUploadedObject, setCsvUploadedObject] = useState<{ objectPath: string; fileName: string } | null>(null);
  const [csvIngestBusy, setCsvIngestBusy] = useState<boolean>(false);
  const [csvDropActive, setCsvDropActive] = useState<boolean>(false);
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

  const selectCsvFile = async (file?: File) => {
    setCsvFile(file || null);
    setCsvUploadedObject(null);
    setCsvUploadProgress(null);
    setCsvValidationError('');
    setCsvFeedbackError('');
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setCsvValidationError('Choose a .csv file.');
      return;
    }
    if (file.size === 0) {
      setCsvValidationError('The selected CSV is empty.');
      return;
    }
    if (file.size > MAX_CSV_UPLOAD_BYTES) {
      setCsvValidationError('CSV file exceeds the 25 MiB upload limit.');
      return;
    }
    try {
      const format = detectCsvUploadFormat(await file.text());
      if (format === 'UNKNOWN') {
        setCsvValidationError('CSV headers do not match the supported OLD or NEW format.');
      }
    } catch {
      setCsvValidationError('Unable to read the selected CSV.');
    }
  };

  const uploadCsv = async () => {
    if (!csvFile || csvValidationError || csvUploadBusy) return;
    setCsvUploadBusy(true);
    setCsvUploadProgress(0);
    setCsvFeedbackError('');
    try {
      const url = `/api/admin/csv-upload?filename=${encodeURIComponent(csvFile.name)}`;
      const response = await apiUploadWithProgress(url, csvFile, setCsvUploadProgress);
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : 'Unable to upload CSV.';
        throw new Error(message);
      }
      if (!payload || typeof payload !== 'object' || !('objectPath' in payload) || !('fileName' in payload)
        || typeof payload.objectPath !== 'string' || typeof payload.fileName !== 'string') {
        throw new Error('Upload completed without a valid storage path.');
      }
      setCsvUploadedObject({ objectPath: payload.objectPath, fileName: payload.fileName });
      setCsvUploadProgress(100);
    } catch (e) {
      setCsvFeedbackError(e instanceof Error ? e.message : 'Unable to upload CSV.');
    } finally {
      setCsvUploadBusy(false);
    }
  };

  const confirmCsvIngest = async () => {
    if (!csvUploadedObject || csvIngestBusy || ingestRun?.running) return;
    setCsvIngestBusy(true);
    setCsvFeedbackError('');
    try {
      const response = await apiFetch('/api/admin/trigger-ingest-from-storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: csvUploadedObject.objectPath }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : 'Unable to start CSV ingestion.';
        throw new Error(message);
      }
      const data = payload as { startedAt?: string; runId?: string };
      setIngestRun({
        running: true,
        status: 'running',
        startedAt: data.startedAt,
        processedFile: csvUploadedObject.objectPath,
        message: `Starting ingestion for ${csvUploadedObject.fileName}`,
      });
    } catch (e) {
      setCsvFeedbackError(e instanceof Error ? e.message : 'Unable to start CSV ingestion.');
    } finally {
      setCsvIngestBusy(false);
    }
  };

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
    return <main className="min-h-screen p-8 text-xs font-mono font-bold bg-[#0a0a0a] text-[#8e8e93]">Checking access…</main>;
  }

  if (!token || !isAuthorized) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-[#0a0a0a] text-white">
        <div className="max-w-md bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-6 shadow-2xl">
          <h1 className="text-xl font-bold mb-2 text-white">Admin dashboard</h1>
          <p className="text-sm text-[#8e8e93] mb-4">You do not have access to org ops or need to sign in.</p>
          <a href="/" className="inline-block bg-[#0a84ff] text-white px-4 py-2 text-sm font-semibold rounded-lg hover:bg-[#0a84ff]/90 transition-colors">Sign in</a>
        </div>
      </main>
    );
  }

  const tabs: Array<'overview' | 'managers' | 'operators' | 'applications' | 'activity' | 'system' | 'guide'> =
    ['overview', 'managers', 'operators', 'applications', 'activity', 'system', 'guide'];

  const lightClass = (status?: string) =>
    status === 'ok'
      ? 'bg-[#30d158]/15 border-[#30d158]/40 text-[#30d158]'
      : status === 'degraded'
        ? 'bg-[#ff9f0a]/15 border-[#ff9f0a]/40 text-[#ff9f0a]'
        : status === 'not_configured'
          ? 'bg-[#2c2c2e] border-[#3a3a3c] text-[#8e8e93]'
          : 'bg-[#ff453a]/15 border-[#ff453a]/40 text-[#ff453a]';

  return (
    <main className="min-h-screen p-4 md:p-8 font-sans bg-[#0a0a0a] text-white">
      <EmailProofModal proof={emailProof} onClose={() => setEmailProof(null)} />
      <ApplicationProofModal application={applicationProof} onClose={() => setApplicationProof(null)} onEmailProof={setEmailProof} />
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col gap-4 md:flex-row md:justify-between md:items-end mb-6 pb-6 border-b border-[#2c2c2e]">
          <div className="flex items-center gap-3">
            <img src="/logo.webp" alt="ApplyWizz" className="w-10 h-10 rounded-xl border border-[#2c2c2e] object-cover bg-black" />
            <div>
              <p className="text-xs font-mono font-medium uppercase tracking-widest text-[#8e8e93]">ApplyWizz / Org ops</p>
              <h1 className="text-3xl font-bold tracking-tight text-white">Admin dashboard</h1>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <DevSwitcher current="/admin" />
            <label className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="block mt-1 border border-[#3a3a3c] rounded-lg px-2.5 py-1.5 text-sm font-mono bg-[#2c2c2e] text-white focus:outline-none focus:border-[#0a84ff]" />
            </label>
            <div className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Stats
              <div className="mt-1 flex gap-1 bg-[#1c1c1e] p-0.5 rounded-lg border border-[#2c2c2e]">
                {(['day', 'week', 'month'] as const).map((range) => (
                  <button key={range} type="button" onClick={() => setStatsRange(range)} className={`rounded-md px-2.5 py-1 text-xs capitalize transition-colors ${statsRange === range ? 'bg-[#2c2c2e] text-white font-bold' : 'text-[#8e8e93] hover:text-white'}`}>{range}</button>
                ))}
              </div>
            </div>
            <button type="button" onClick={() => void refresh()} className="bg-[#2c2c2e] border border-[#3a3a3c] px-3 py-1.5 text-xs font-semibold rounded-lg text-white hover:bg-[#3a3a3c] transition-colors">Refresh</button>
            <HeaderSignOut onSignOut={signOut} />
          </div>
        </header>
        <nav className="flex flex-wrap gap-2 mb-6">
          {tabs.map((id) => (
            <button key={id} type="button" onClick={() => { setTab(id); setSelectedManager(null); }} className={`px-3 py-1.5 text-xs font-semibold rounded-lg border capitalize transition-colors ${tab === id ? 'bg-white text-black font-bold border-white' : 'bg-[#1c1c1e] text-[#8e8e93] border-[#2c2c2e] hover:text-white hover:bg-[#2c2c2e]'}`}>{id}</button>
          ))}
        </nav>
        {error && <div className="mb-4 bg-[#ff453a]/15 border border-[#ff453a]/40 rounded-xl p-3 text-sm font-bold text-[#ff453a]">{error}</div>}
        {loading && <p className="text-xs font-mono font-medium text-[#8e8e93] mb-4">Loading…</p>}

        {tab === 'overview' && overview && (
          <>
            <div id="ingestStatusBar" className={`mb-6 border rounded-xl p-3 text-xs font-semibold flex flex-wrap items-center justify-between gap-3 ${
              ingestRun?.running
                ? 'bg-[#0a84ff]/15 border-[#0a84ff]/40 text-[#5ac8fa] animate-pulse'
                : ingestRun?.error
                  ? 'bg-[#ff453a]/15 border-[#ff453a]/40 text-[#ff453a]'
                  : ingestRun?.finishedAt
                    ? 'bg-[#30d158]/15 border-[#30d158]/40 text-[#30d158]'
                    : 'bg-[#1c1c1e] border-[#2c2c2e] text-[#8e8e93]'
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
                <button type="button" id="ingestStartBtn" onClick={() => void handleStart()} disabled={Boolean(ingestRun?.running)} className="bg-[#30d158] text-black px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50 hover:bg-[#30d158]/90 transition-colors">
                  {ingestRun?.running ? 'Running…' : '▶ Start'}
                </button>
                {ingestRun?.running ? (
                  <button type="button" id="ingestStopBtn" onClick={() => void handleStop()} disabled={ingestRun?.stopEnabled === false} className="bg-[#ff453a] text-white px-3 py-1.5 text-xs font-bold rounded-lg disabled:opacity-50 hover:bg-[#ff453a]/90 transition-colors">⏹ Stop</button>
                ) : null}
              </div>
            </div>
            <section className="mb-6 bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h2 className="font-bold uppercase tracking-wider text-xs text-white mb-1">Upload a CSV</h2>
              <p className="text-xs text-[#8e8e93] mb-4">Upload a supported CSV to storage, review it, then confirm to ingest that exact file.</p>
              <div
                onDragOver={(event) => { event.preventDefault(); setCsvDropActive(true); }}
                onDragLeave={() => setCsvDropActive(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setCsvDropActive(false);
                  void selectCsvFile(event.dataTransfer.files[0]);
                }}
                className={`border border-dashed rounded-xl p-6 text-center transition-colors ${csvDropActive ? 'bg-[#0a84ff]/10 border-[#0a84ff]' : 'bg-[#141416] border-[#3a3a3c]'}`}
              >
                <p className="text-sm font-semibold text-white mb-2">{csvFile ? csvFile.name : 'Drop a CSV file here'}</p>
                <label className="inline-block bg-[#2c2c2e] border border-[#3a3a3c] rounded-lg px-3 py-1.5 text-xs font-semibold text-white cursor-pointer hover:bg-[#3a3a3c] transition-colors">
                  Browse files
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="sr-only"
                    disabled={csvUploadBusy || csvIngestBusy || Boolean(ingestRun?.running)}
                    onChange={(event) => { void selectCsvFile(event.currentTarget.files?.[0]); }}
                  />
                </label>
                {csvFile && !csvValidationError && <p className="mt-2 text-xs text-[#30d158] font-medium">Required CSV headers detected.</p>}
                {csvValidationError && <p role="alert" className="mt-2 text-xs font-semibold text-[#ff453a]">{csvValidationError}</p>}
                {csvFeedbackError && <p role="alert" className="mt-2 text-xs font-semibold text-[#ff453a]">{csvFeedbackError}</p>}
                {csvUploadBusy && (
                  <div className="mt-3 max-w-md mx-auto">
                    <div className="h-2 border border-[#3a3a3c] rounded-full overflow-hidden bg-[#2c2c2e]">
                      <div className="h-full bg-[#30d158] transition-all" style={{ width: `${csvUploadProgress ?? 0}%` }} />
                    </div>
                    <p className="mt-1 text-xs font-mono text-[#8e8e93]">Uploading… {csvUploadProgress ?? 0}%</p>
                  </div>
                )}
                {!csvUploadedObject && (
                  <button
                    type="button"
                    onClick={() => void uploadCsv()}
                    disabled={!csvFile || Boolean(csvValidationError) || csvUploadBusy || csvIngestBusy || Boolean(ingestRun?.running)}
                    className="mt-3 bg-[#30d158] text-black rounded-lg px-3.5 py-1.5 text-xs font-bold disabled:opacity-50 hover:bg-[#30d158]/90 transition-colors"
                  >
                    {csvUploadBusy ? 'Uploading…' : 'Upload CSV'}
                  </button>
                )}
              </div>
              {csvUploadedObject && (
                <div className="mt-4 border border-[#2c2c2e] bg-[#141416] rounded-xl p-4 text-xs">
                  <p className="font-bold text-white">Uploaded: {csvUploadedObject.fileName}</p>
                  <p className="mt-1 text-[#8e8e93]">This CSV is stored and has not started ingesting.</p>
                  <button
                    type="button"
                    onClick={() => void confirmCsvIngest()}
                    disabled={csvIngestBusy || Boolean(ingestRun?.running)}
                    className="mt-3 bg-[#0a84ff] text-white rounded-lg px-4 py-2 font-bold disabled:opacity-50 hover:bg-[#0a84ff]/90 transition-colors"
                  >
                    {csvIngestBusy ? 'Starting…' : `Confirm & ingest ${csvUploadedObject.fileName}`}
                  </button>
                  {ingestRun?.processedFile === csvUploadedObject.objectPath && ingestRun.running && (
                    <p role="status" className="mt-2 font-bold text-[#5ac8fa]">
                      Ingest running — {ingestRun.phase ? `${ingestRun.phase}: ` : ''}{ingestRun.message || 'processing CSV'}
                    </p>
                  )}
                  {ingestRun?.processedFile === csvUploadedObject.objectPath && !ingestRun.running && ingestRun.finishedAt && (
                    <p role="status" className={`mt-2 font-bold ${ingestRun.error ? 'text-[#ff453a]' : 'text-[#30d158]'}`}>
                      {ingestRun.error ? `Ingest failed: ${ingestRun.error}` : `Ingest completed — ${ingestRun.message || csvUploadedObject.fileName}`}
                    </p>
                  )}
                </div>
              )}
            </section>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              {[
                ['Operators', overview.operators],
                ['Active operators', overview.activeOperators],
                ['Inactive operators', overview.inactiveOperators],
                ['Total Applications', overview.statsAvailable === false ? '—' : overview.totalApplications ?? 0],
                ['Submitted', overview.statsAvailable === false ? '—' : overview.submitted ?? overview.completed],
                ['Applied', overview.statsAvailable === false ? '—' : overview.applied],
                ['Running', overview.running],
                ['Queued', overview.queued],
                ['Failed', overview.statsAvailable === false ? '—' : overview.failed],
                ['Supabase %', overview.supabasePercent],
                ['AI %', overview.aiPercent],
                ['Resume %', overview.resumePercent],
              ].map(([label, val]) => (
                <div key={label} className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">{label}</p>
                  <p className="text-2xl font-black tracking-tight text-white mt-1">{val ?? 0}</p>
                </div>
              ))}
            </div>
            {overview.statsAvailable === false && (
              <p role="status" className="mb-6 text-sm text-[#8e8e93]">
                Application statistics are available from {overview.statsAvailableFrom || 'the cutover date'}; earlier ranges cannot be reconstructed.
              </p>
            )}
            {overview.statsAvailable !== false && overview.statsPartial && (
              <p role="status" className="mb-6 text-sm text-[#8e8e93]">
                Partial statistics: dates before {overview.statsAvailableFrom || 'the cutover date'} are excluded.
              </p>
            )}
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-hidden">
              <h2 className="p-3.5 font-semibold uppercase tracking-wider text-xs border-b border-[#2c2c2e] bg-[#2c2c2e]/40 text-[#8e8e93]">Recent activity</h2>
              <ul className="text-xs divide-y divide-[#2c2c2e]/60">
                {(overview.recentActivity || []).map((event) => (
                  <li key={event.id} className="p-3 text-[#8e8e93]">
                    <span className="font-bold text-white">{event.action}</span> · {event.actor_email || 'system'} · {new Date(event.created_at).toLocaleString()}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {tab === 'managers' && !selectedManager && (
          <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="bg-[#2c2c2e]/60 border-b border-[#2c2c2e] text-[#8e8e93]">
                <tr>{['Manager', 'Operators', 'Clients', 'Apps since cutover', 'Status'].map((h) => <th key={h} className="p-3 font-semibold uppercase tracking-wider">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-[#2c2c2e]/50">
                {managers.map((manager) => (
                  <tr key={manager.email} className="hover:bg-[#2c2c2e]/30 transition-colors">
                    <td className="p-3">
                      <button type="button" className="font-bold text-white underline hover:text-[#0a84ff]" onClick={() => void openManager(manager.email)}>{manager.name}</button>
                      <p className="font-mono text-[#8e8e93]">{manager.email}</p>
                    </td>
                    <td className="p-3 font-mono text-white">{manager.assignedOperators ?? 0}</td>
                    <td className="p-3 font-mono text-white">{manager.assignedClients ?? 0}</td>
                    <td className="p-3 font-mono text-white" title={manager.statsAvailableFrom ? `Available from ${manager.statsAvailableFrom}` : 'Stats cutover is not active'}>{manager.statsAvailable === false ? '—' : manager.applications ?? 0}</td>
                    <td className="p-3 uppercase font-semibold text-[#8e8e93]">{manager.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'managers' && selectedManager && (
          <div className="space-y-4">
            <button type="button" className="text-xs font-semibold text-[#0a84ff] hover:underline" onClick={() => setSelectedManager(null)}>← All managers</button>
            <p className="text-sm font-bold text-white">{selectedManager}</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['Total Applications', managerDash.totals?.applications],
                ['Submitted', managerDash.submitted ?? managerDash.totals?.submitted],
                ['Applied', managerDash.totals?.applied],
                ['Pending', managerDash.totals?.pending],
                ['Failed', managerDash.totals?.failed],
              ].map(([label, val]) => (
                <div key={label} className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-3.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8e8e93]">{label}</p>
                  <p className="text-xl font-black text-white mt-0.5">{managerDash.statsAvailable === false && label !== 'Pending' ? '—' : val ?? 0}</p>
                </div>
              ))}
            </div>
            {managerDash.statsAvailable === false && <p className="bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-xl p-3 text-xs font-semibold text-[#ff9f0a]">Application statistics before {managerDash.statsAvailableFrom || 'the cutover date'} are unavailable.</p>}
            {managerDash.statsAvailable !== false && managerDash.statsPartial && <p className="bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-xl p-3 text-xs font-semibold text-[#ff9f0a]">Partial statistics: dates before {managerDash.statsAvailableFrom} are excluded.</p>}
            <ClientTable
              rows={managerDash.rows || []}
              loading={loading}
              statsAvailable={managerDash.statsAvailable !== false}
              expanded={expanded}
              onToggle={(key) => setExpanded(expanded === key ? null : key)}
              onEmailProof={setEmailProof}
            />
            <p className="mt-2 text-[11px] text-[#8e8e93]">Metric counts use creation and status-transition dates; expandable job/proof details include retained live rows only and may be incomplete.</p>
          </div>
        )}

        {tab === 'operators' && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <input value={opSearch} onChange={(e) => setOpSearch(e.target.value)} placeholder="Search operators" className="border border-[#3a3a3c] bg-[#2c2c2e] text-white placeholder-[#8e8e93] rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#0a84ff]" />
              <select value={opStatus} onChange={(e) => setOpStatus(e.target.value)} className="border border-[#3a3a3c] bg-[#2c2c2e] text-white rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#0a84ff]">
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              <select value={opManager} onChange={(e) => setOpManager(e.target.value)} className="border border-[#3a3a3c] bg-[#2c2c2e] text-white rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#0a84ff]">
                <option value="">Any manager</option>
                {managers.map((manager) => <option key={manager.email} value={manager.email}>{manager.name || manager.email}</option>)}
              </select>
            </div>
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="bg-[#2c2c2e]/60 border-b border-[#2c2c2e] text-[#8e8e93]">
                  <tr>{['Operator', 'Status', 'Workload', 'Last sign-in'].map((h) => <th key={h} className="p-3 font-semibold uppercase tracking-wider">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-[#2c2c2e]/50">
                  {operators.map((op) => (
                    <tr key={op.email} className="hover:bg-[#2c2c2e]/30 transition-colors">
                      <td className="p-3 font-bold text-white">{op.name}<p className="font-mono font-normal text-[#8e8e93]">{op.email}</p></td>
                      <td className="p-3 uppercase font-semibold text-[#8e8e93]">{op.status}</td>
                      <td className="p-3 font-mono text-white">{op.workload ?? 0}</td>
                      <td className="p-3 font-mono text-[#8e8e93]">{(op.lastSignInAt || op.last_sign_in_at) ? new Date(op.lastSignInAt || op.last_sign_in_at!).toLocaleString() : '—'}</td>
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
              <input value={appSearch} onChange={(e) => setAppSearch(e.target.value)} placeholder="Search client / job / operator" className="border border-[#3a3a3c] bg-[#2c2c2e] text-white placeholder-[#8e8e93] rounded-lg px-2.5 py-1.5 text-sm min-w-[16rem] focus:outline-none focus:border-[#0a84ff]" />
              <select value={appStatus} onChange={(e) => setAppStatus(e.target.value)} className="border border-[#3a3a3c] bg-[#2c2c2e] text-white rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#0a84ff]">
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
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-xs">
                <thead className="bg-[#2c2c2e]/60 border-b border-[#2c2c2e] text-[#8e8e93]">
                  <tr>{['Client', 'Job', 'Company', 'Operator', 'Status', 'Created'].map((h) => <th key={h} className="p-3 font-semibold uppercase tracking-wider">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-[#2c2c2e]/50">
                  {applications.map((row) => (
                    <tr key={row.id} className="hover:bg-[#2c2c2e]/30 transition-colors">
                      <td className="p-3 font-bold text-white">{row.client}</td>
                      <td className="p-3"><a className="underline text-[#0a84ff] hover:text-[#5ac8fa] break-all font-medium" href={row.jobUrl} target="_blank" rel="noopener noreferrer">{row.jobTitle || row.jobUrl}</a></td>
                      <td className="p-3 text-white">{row.companyName || '—'}</td>
                      <td className="p-3 font-mono text-[#8e8e93]">{(row.operator || row.assigned_ca_email || '').trim() || '—'}</td>
                      <td className="p-3">
                        {row.status === 'APPLIED' && (
                          <button
                            type="button"
                            onClick={() => setApplicationProof(row)}
                            className="font-mono underline decoration-2 text-[#30d158] font-bold hover:opacity-80"
                          >
                            {row.status}
                          </button>
                        )}
                        {row.status === 'FAILED' && (
                          <button
                            type="button"
                            onClick={() => setApplicationProof(row)}
                            className="font-mono underline decoration-2 text-[#ff453a] font-bold hover:opacity-80"
                          >
                            {row.status}
                          </button>
                        )}
                        {row.status === 'EMAIL_PROOF_PENDING' && (
                          <button
                            type="button"
                            onClick={() => setApplicationProof(row)}
                            className="font-mono underline decoration-2 text-[#ff9f0a] font-bold hover:opacity-80"
                          >
                            {row.status}
                          </button>
                        )}
                        {row.status !== 'APPLIED' && row.status !== 'FAILED' && row.status !== 'EMAIL_PROOF_PENDING' && (
                          <span className="font-mono text-[#8e8e93]">{row.status}</span>
                        )}
                      </td>
                      <td className="p-3 font-mono text-[#8e8e93]">{row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'activity' && (
          <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-hidden">
            {activityWarning && <p className="p-3 text-xs font-semibold bg-[#ff9f0a]/15 border-b border-[#ff9f0a]/30 text-[#ff9f0a]">{activityWarning}</p>}
            <ul className="text-xs divide-y divide-[#2c2c2e]/60">
              {activity.map((event) => (
                <li key={event.id} className="p-3">
                  <p className="font-bold text-white">{event.action}</p>
                  <p className="font-mono text-[#8e8e93] mt-0.5">{event.actor_email} · {event.target_type} {event.target_id} · {new Date(event.created_at).toLocaleString()}</p>
                </li>
              ))}
            </ul>
            {!activity.length && <p className="p-6 text-center text-[#8e8e93]">No audit events recorded yet.</p>}
          </div>
        )}

        {tab === 'system' && system && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(system.lights || {}).map(([name, stat]) => (
                <div key={name} className={`border rounded-xl p-4 ${lightClass(stat)}`}>
                  <p className="text-xs font-semibold uppercase tracking-wider">{name.replace('_', ' ')}</p>
                  <p className="text-lg font-black mt-1 uppercase">{stat}</p>
                </div>
              ))}
            </div>
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 text-xs text-[#8e8e93] space-y-1">
              <p>Queue: <span className="font-semibold text-white">{system.queue?.queued ?? 0}</span> queued · <span className="font-semibold text-white">{system.queue?.applying ?? 0}</span> applying · <span className="font-semibold text-white">{system.queue?.stuck ?? 0}</span> stuck</p>
              <p>Ingest: <span className="font-semibold text-white">{ingestRun?.running ? 'running' : ingestRun?.error ? `failed — ${ingestRun.error}` : ingestRun?.message || 'idle'}</span></p>
              <p>Workers: <span className="font-semibold text-white">{system.workersRunning ? 'running' : 'stopped'}</span></p>
            </div>
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-x-auto">
              <div className="p-3.5 border-b border-[#2c2c2e] bg-[#2c2c2e]/40">
                <p className="font-bold text-white text-sm">Required Field Failures by CA</p>
                <p className="text-[#8e8e93] text-xs">Click a row to filter failed applications.</p>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="bg-[#2c2c2e]/60 border-b border-[#2c2c2e] text-[#8e8e93]">
                  <tr><th className="p-3 font-semibold uppercase tracking-wider">CA Email</th><th className="p-3 font-semibold uppercase tracking-wider">Failure Count</th></tr>
                </thead>
                <tbody className="divide-y divide-[#2c2c2e]/50">
                  {caFailureStats.map((row) => (
                    <tr
                      key={row.ca_email}
                      className="hover:bg-[#2c2c2e]/30 cursor-pointer transition-colors"
                      onClick={() => { setAppSearch(row.ca_email); setAppStatus('FAILED'); setTab('applications'); }}
                    >
                      <td className="p-3 font-mono text-white">{row.ca_email}</td>
                      <td className="p-3 font-mono font-bold text-[#ff453a]">{row.failure_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!caFailureStats.length && <p className="p-4 text-center text-[#8e8e93]">No required-field failures found.</p>}
            </div>
          </div>
        )}

        {tab === 'guide' && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-white">Admin Guide</h2>
              <p className="text-xs text-[#8e8e93] font-mono mt-0.5">Org-wide visibility, ingest control, and operational oversight.</p>
            </div>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-2">What you can do</h3>
              <p className="text-sm text-[#8e8e93] leading-relaxed">
                View <span className="font-semibold text-white">all</span> managers, operators, and applications. Start or stop CSV ingest from Storage. Inspect system health and audit activity. Application submission still happens on the <span className="font-semibold text-white">Operator</span> dashboard — not here.
              </p>
            </section>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-3">Tabs</h3>
              <ul className="space-y-2 text-sm text-[#8e8e93] leading-relaxed list-disc list-inside">
                <li><span className="font-semibold text-white">Overview</span> — org-wide counts and a recent activity snapshot.</li>
                <li><span className="font-semibold text-white">Managers</span> — click a manager name to open their client table for the header <span className="font-semibold text-white">Date</span>; use ← All managers to go back.</li>
                <li><span className="font-semibold text-white">Operators</span> — search; filter active/inactive or by manager.</li>
                <li><span className="font-semibold text-white">Applications</span> — search client, job, or operator; optional status filter for the selected date.</li>
                <li><span className="font-semibold text-white">Activity</span> — audit-style events (who did what, when).</li>
                <li><span className="font-semibold text-white">System</span> — status lights, queue, workers, and ingest state.</li>
              </ul>
            </section>

            <section className="bg-[#1c1c1e] border border-[#ff453a]/30 rounded-xl p-5">
              <h3 className="text-sm font-bold text-[#ff453a] uppercase tracking-wider mb-2">Header: Date, Refresh, Start, Stop</h3>
              <ul className="space-y-2 text-sm text-[#8e8e93] leading-relaxed list-disc list-inside">
                <li><span className="font-semibold text-white">Date</span> drives managers, operators, and applications views that use a calendar day.</li>
                <li><span className="font-semibold text-white">▶ Start</span> triggers ingest from Storage; watch progress on System.</li>
                <li><span className="font-semibold text-white">⏹ Stop</span> requests a graceful stop — use only when you mean to interrupt a run.</li>
              </ul>
            </section>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-3">Important notes</h3>
              <ul className="space-y-2 text-sm text-[#8e8e93] leading-relaxed list-disc list-inside">
                <li>Ingest or Storage failures often need env credentials — check System and the Dev dashboard if stuck.</li>
                <li>Operator–manager links are set when operators sign in; use Operators/Managers views to verify coverage.</li>
                <li>Empty Activity may mean audit events are not recorded yet (migration 015).</li>
              </ul>
            </section>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5 text-center">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-2">Need help?</h3>
              <p className="text-sm text-[#8e8e93] leading-relaxed">
                Contact{' '}
                <a href="mailto:yaswanthnaiduyalla@applywizz.ai" className="font-semibold text-[#0a84ff] underline hover:text-[#5ac8fa]">yaswanthnaiduyalla@applywizz.ai</a>{' '}
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
