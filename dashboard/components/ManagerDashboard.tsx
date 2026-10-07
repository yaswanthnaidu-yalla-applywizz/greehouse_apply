import React, { useState, useEffect, useCallback } from 'react';
import { useRequireRole, getTodayIST, sessionRole, sessionUserEmail, apiFetch } from '../hooks/useSession.js';
import { DevSwitcher } from './DevSwitcher.js';
import { HeaderSignOut } from './HeaderSignOut.js';

interface EmailProofData {
  subject?: string;
  from?: string;
  received_at?: string;
  body_text?: string;
  [key: string]: unknown;
}

interface AppliedJobDetail {
  id?: string;
  job_url: string;
  job_title?: string;
  company_name?: string;
  proof_web_url?: string;
  proof_email_url?: string;
  proof_email_json?: Record<string, unknown>;
  status?: string;
  error_message?: string;
}

interface AppliedOperatorData {
  name: string;
  email: string;
  items: AppliedJobDetail[];
}

interface ManagerClientRow {
  client: string;
  applications: number | null;
  submitted?: number | null;
  completed?: number | null;
  applied?: number | null;
  pending: number;
  failed: number | null;
  assigned_ca?: string;
  assignedTo?: string;
  assignedToEmail?: string;
  submittedApplications?: AppliedJobDetail[];
  completedApplications?: AppliedJobDetail[];
  pendingApplications?: AppliedJobDetail[];
  failedApplications?: AppliedJobDetail[];
}

interface DropdownOption {
  value: string;
  label?: string;
  name?: string;
  email?: string;
}

interface ManagerOperatorItem {
  name: string;
  email: string;
  status: string;
  applications: number | null;
  submitted?: number | null;
  completed?: number | null;
  applied?: number | null;
  failed?: number | null;
  lastSignInAt?: string;
}

interface ManagerActivityItem {
  timestamp?: string;
  created_at?: string;
  applywizz_id?: string;
  candidate_name?: string;
  job_title?: string;
  company_name?: string;
  to_status?: string;
}

interface ReportBucket {
  date: string;
  applications: number;
  total?: number;
  submitted?: number;
  applied?: number;
  failed?: number;
}

interface ReportPerOperator {
  email: string;
  name: string;
  applications: number;
  apps?: number;
  submitted?: number;
  completed: number;
  applied?: number;
  failed?: number;
}

interface ReportsPayload {
  buckets: ReportBucket[];
  perOperator: ReportPerOperator[];
  start?: string;
  end?: string;
  statsAvailable?: boolean;
  statsPartial?: boolean;
  statsAvailableFrom?: string;
}

interface ManagerDashboardApiResponse {
  rows?: ManagerClientRow[];
  totals?: Record<string, number | null>;
  submitted?: number | null;
  completed?: number | null;
  applied?: number | null;
  failed?: number | null;
  totalApplications?: number | null;
  statsAvailable?: boolean;
  statsPartial?: boolean;
  statsAvailableFrom?: string;
  submitClicks?: number;
  submitted_today?: number;
  warning?: string;
  error?: string;
}

const AppliedModal: React.FC<{
  operator: AppliedOperatorData | null;
  onClose: () => void;
  onEmailProof: (proof: EmailProofData) => void;
}> = ({ operator, onClose, onEmailProof }) => {
  if (!operator) return null;
  const items = operator.items || [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-full max-w-2xl bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-hidden shadow-2xl text-white" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 bg-[#1c1c1e] border-b border-[#2c2c2e] flex justify-between items-start gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#8e8e93]">Applied jobs</p>
            <h3 className="text-sm font-bold text-white break-words">{operator.name}</h3>
            <p className="text-xs font-mono text-[#8e8e93] mt-1">{items.length} live proof detail(s) available</p>
          </div>
          <button type="button" onClick={onClose} className="text-[#8e8e93] hover:text-white font-bold p-1">✕</button>
        </header>
        <div className="px-5 py-4 bg-[#141416] max-h-[50vh] overflow-y-auto">
          <div className="space-y-2">
            {!items.length ? (
              <p className="text-xs text-[#8e8e93]">No applied applications for this operator in the selected report period.</p>
            ) : items.map((item, index) => (
              <div key={item.id || item.job_url || index} className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between text-xs py-1.5 border-b border-[#2c2c2e]/40 last:border-b-0">
                <span className="break-words">
                  <a href={item.job_url} target="_blank" rel="noopener noreferrer" className="font-bold text-[#0a84ff] hover:text-[#5ac8fa] underline break-all">{item.job_title || 'Job'}</a>
                  <span className="text-[#8e8e93]"> at {item.company_name || '—'}</span>
                </span>
                <span className="flex flex-wrap gap-3 shrink-0">
                  {item.proof_web_url ? <a href={item.proof_web_url} target="_blank" rel="noopener noreferrer" className="text-[#5ac8fa] underline font-bold">Web proof screenshot</a> : <span className="text-[#8e8e93]">Web proof unavailable</span>}
                  {item.proof_email_url ? (
                    <a href={item.proof_email_url} target="_blank" rel="noopener noreferrer" className="text-[#0a84ff] underline font-bold">Email screenshot</a>
                  ) : item.proof_email_json ? (
                    <button type="button" className="text-[#0a84ff] underline font-bold" onClick={() => onEmailProof(item.proof_email_json as EmailProofData)}>View email proof</button>
                  ) : (
                    <span className="text-[#8e8e93]">Email proof unavailable</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const EmailProofModal: React.FC<{ proof: EmailProofData | null; onClose: () => void }> = ({ proof, onClose }) => {
  if (!proof) return null;
  const received = proof.received_at ? new Date(proof.received_at).toLocaleString() : proof.received_at;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-full max-w-2xl bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-hidden shadow-2xl text-white" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 bg-[#1c1c1e] border-b border-[#2c2c2e] flex justify-between items-start gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#8e8e93]">Email proof</p>
            <h3 className="text-sm font-bold text-white break-words">{proof.subject || '(No subject)'}</h3>
            {proof.from && <p className="text-xs font-mono text-[#8e8e93] mt-1">From {proof.from}</p>}
            {received && <p className="text-xs font-mono text-[#8e8e93]">Received {received}</p>}
          </div>
          <button type="button" onClick={onClose} className="text-[#8e8e93] hover:text-white font-bold p-1">✕</button>
        </header>
        <div className="px-5 py-4 bg-[#141416] max-h-[50vh] overflow-y-auto text-xs whitespace-pre-wrap break-words font-mono text-[#8e8e93] leading-relaxed">{(proof.body_text || '').slice(0, 4000)}</div>
      </div>
    </div>
  );
};

const DetailList: React.FC<{
  items?: AppliedJobDetail[];
  mode: 'submitted' | 'completed' | 'pending' | 'failed';
  onEmailProof: (proof: EmailProofData) => void;
}> = ({ items, mode, onEmailProof }) => {
  return (
    <div className="bg-[#141416] border-t border-[#2c2c2e] px-4 py-3">
      <div className="space-y-2">
        {(!items || items.length === 0) ? (
          <p className="text-xs text-[#8e8e93]">No application details returned for this client.</p>
        ) : items.map((item, index) => (
          <div key={item.id || item.job_url || index} className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between text-xs py-1 border-b border-[#2c2c2e]/40 last:border-b-0">
            <a href={item.job_url} target="_blank" rel="noopener noreferrer" className="font-bold text-[#0a84ff] hover:text-[#5ac8fa] underline break-all">{item.job_url}</a>
            {(mode === 'submitted' || mode === 'completed') && (
              <span className="flex flex-wrap gap-3 shrink-0">
                {item.proof_web_url ? <a href={item.proof_web_url} target="_blank" rel="noopener noreferrer" className="text-[#5ac8fa] underline font-bold">Web proof screenshot</a> : <span className="text-[#8e8e93]">Web proof unavailable</span>}
                {item.proof_email_url ? (
                  <a href={item.proof_email_url} target="_blank" rel="noopener noreferrer" className="text-[#0a84ff] underline font-bold">Email screenshot</a>
                ) : item.proof_email_json ? (
                  <button type="button" className="text-[#0a84ff] underline font-bold" onClick={() => onEmailProof(item.proof_email_json as EmailProofData)}>View email proof</button>
                ) : (
                  <span className="text-[#8e8e93]">Email proof unavailable</span>
                )}
              </span>
            )}
            {mode === 'failed' && <span className="text-[#ff453a] font-mono md:max-w-sm">{item.error_message || 'Failure reason unavailable'}</span>}
          </div>
        ))}
      </div>
    </div>
  );
};

const CountButton: React.FC<{
  value?: number | null;
  onClick: () => void;
  active: boolean;
}> = ({ value, onClick, active }) => {
  if (value == null) return <span className="font-mono text-[#8e8e93]">—</span>;
  if (!value) return <span className="font-mono text-[#8e8e93]">0</span>;
  return (
    <button type="button" onClick={onClick} className={`font-mono underline decoration-2 ${active ? 'text-[#30d158] font-bold' : 'text-[#0a84ff] hover:opacity-80'}`}>{value}</button>
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
          <tr>{['Client', 'Apps', 'Submitted', 'Applied', 'Pending', 'Failed', 'Assigned'].map((h) => <th key={h} className="p-3 font-semibold uppercase tracking-wider">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-[#2c2c2e]/50">
          {rows.map((row) => {
            const submittedKey = `${row.client}:submitted`;
            const completedKey = `${row.client}:completed`;
            const pendingKey = `${row.client}:pending`;
            const failedKey = `${row.client}:failed`;
            const openKey = expanded && expanded.startsWith(`${row.client}:`) ? expanded : null;
            const mode = openKey ? (openKey.split(':')[1] as 'submitted' | 'completed' | 'pending' | 'failed') : null;
            const items = (mode === 'submitted' || mode === 'completed') ? (row.submittedApplications || row.completedApplications) : mode === 'pending' ? row.pendingApplications : mode === 'failed' ? row.failedApplications : [];
            return (
              <React.Fragment key={row.client}>
                <tr className="hover:bg-[#2c2c2e]/30 transition-colors">
                  <td className="p-3 font-bold text-white">{row.client}</td>
                  <td className="p-3 font-mono text-white">{statsAvailable ? row.applications ?? 0 : '—'}</td>
                  <td className="p-3"><CountButton value={statsAvailable ? row.submitted ?? row.completed : null} active={statsAvailable && (expanded === submittedKey || expanded === completedKey)} onClick={() => { if (statsAvailable) onToggle(submittedKey); }} /></td>
                  <td className="p-3 font-mono text-white">{statsAvailable ? row.applied ?? 0 : '—'}</td>
                  <td className="p-3"><CountButton value={row.pending} active={expanded === pendingKey} onClick={() => onToggle(pendingKey)} /></td>
                  <td className="p-3"><CountButton value={statsAvailable ? row.failed : null} active={statsAvailable && expanded === failedKey} onClick={() => { if (statsAvailable) onToggle(failedKey); }} /></td>
                  <td className="p-3 text-[#8e8e93]">{row.assigned_ca || row.assignedTo || '—'}</td>
                </tr>
                {openKey && mode && (
                  <tr>
                    <td colSpan={7} className="p-0">
                      <DetailList items={items} mode={mode} onEmailProof={onEmailProof} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {!rows.length && !loading && <p className="p-6 text-center text-[#8e8e93]">No clients matched this filter.</p>}
    </div>
  );
};

const SearchableDropdown: React.FC<{
  value: string;
  options: DropdownOption[];
  onChange: (val: string) => void;
  placeholder?: string;
}> = ({ value, options, onChange, placeholder = 'Search...' }) => {
  const [query, setQuery] = useState<string>('');
  const [open, setOpen] = useState<boolean>(false);

  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label || selected?.name || selected?.email || '';
  const filteredOptions = options.filter((option) => {
    const haystack = `${option.label || ''} ${option.name || ''} ${option.email || ''} ${option.value || ''}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  useEffect(() => {
    setQuery(selectedLabel);
  }, [selectedLabel]);

  return (
    <div
      className="relative mt-1 min-w-[12rem]"
      onBlur={() => setTimeout(() => setOpen(false), 150)}
    >
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        className="block w-full border border-[#3a3a3c] rounded-lg px-2.5 py-1.5 text-sm bg-[#2c2c2e] text-white placeholder-[#8e8e93] focus:outline-none focus:border-[#0a84ff]"
      />
      {open && (
        <div className="absolute z-30 mt-1 w-full max-h-56 overflow-y-auto bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl shadow-2xl">
          {filteredOptions.length > 0 ? filteredOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setQuery(option.label || option.name || option.email || '');
                setOpen(false);
              }}
              className="block w-full text-left px-3 py-2 text-xs text-white hover:bg-[#2c2c2e] transition-colors"
            >
              {option.label || option.name || option.email}
            </button>
          )) : (
            <p className="px-3 py-2 text-xs text-[#8e8e93]">No matches</p>
          )}
        </div>
      )}
    </div>
  );
};

export const ManagerDashboard: React.FC = () => {
  const { token, loading: authLoading, isAuthorized, signOut } = useRequireRole(['manager']);

  const [tab, setTab] = useState<'home' | 'operators' | 'activity' | 'reports' | 'guide'>('home');
  const [dateFilterMode, setDateFilterMode] = useState<'day' | 'week' | 'month' | 'custom'>('day');
  const [customFrom, setCustomFrom] = useState<string>(() => {
    const today = getTodayIST();
    const d = new Date(`${today}T00:00:00+05:30`);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState<string>(getTodayIST);

  const dateRangeLabel =
    dateFilterMode === 'custom' && customFrom && customTo
      ? (customFrom === customTo ? customFrom : `${customFrom} – ${customTo}`)
      : dateFilterMode === 'week' ? 'This Week' : dateFilterMode === 'month' ? 'This Month' : 'Today';
  const dateQuery =
    dateFilterMode === 'custom' && customFrom && customTo
      ? `from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`
      : `range=${dateFilterMode}`;

  const [ca, setCa] = useState<string>('all');
  const [rows, setRows] = useState<ManagerClientRow[]>([]);
  const [totals, setTotals] = useState<Record<string, number | null>>({});
  const [submitted, setSubmitted] = useState<number | null>(0);
  const [applied, setApplied] = useState<number | null>(0);
  const [statsAvailable, setStatsAvailable] = useState<boolean | null>(null);
  const [statsPartial, setStatsPartial] = useState<boolean>(false);
  const [statsAvailableFrom, setStatsAvailableFrom] = useState<string>('');
  const [careerAssociates, setCareerAssociates] = useState<DropdownOption[]>([]);
  const [warning, setWarning] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [emailProof, setEmailProof] = useState<EmailProofData | null>(null);
  const [appliedByOperator, setAppliedByOperator] = useState<Record<string, AppliedJobDetail[]>>({});
  const [appliedOperator, setAppliedOperator] = useState<AppliedOperatorData | null>(null);
  const [operators, setOperators] = useState<ManagerOperatorItem[]>([]);
  const [operatorError, setOperatorError] = useState<string>('');
  const [activity, setActivity] = useState<ManagerActivityItem[]>([]);
  const [activityWarning, setActivityWarning] = useState<string>('');
  const [reports, setReports] = useState<ReportsPayload>({ buckets: [], perOperator: [] });
  const [reportRange, setReportRange] = useState<'day' | 'week' | 'month'>('day');
  const [opsPickerOpen, setOpsPickerOpen] = useState<boolean>(false);
  const [opsManagers, setOpsManagers] = useState<Array<{ email: string; name?: string }>>([]);
  const [opsManagerPick, setOpsManagerPick] = useState<string>('');
  const [opsPickerLoading, setOpsPickerLoading] = useState<boolean>(false);
  const [opsPickerError, setOpsPickerError] = useState<string>('');

  const currentRole = sessionRole();
  const userEmail = sessionUserEmail();

  const load = useCallback(async () => {
    if (!token || !isAuthorized) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ ca });
      const res = await apiFetch(`/api/manager/dashboard?${params}&${dateQuery}`);
      const payload: unknown = await res.json();
      if (!res.ok) {
        const err = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : 'Unable to load manager dashboard.';
        throw new Error(err);
      }
      const data = payload as ManagerDashboardApiResponse;
      setRows(data.rows || []);
      setTotals(data.totals || {});
      setSubmitted(data.submitted ?? (data.statsAvailable === false ? null : 0));
      setApplied(data.applied ?? (data.statsAvailable === false ? null : 0));
      setStatsAvailable(data.statsAvailable !== false);
      setStatsPartial(data.statsPartial === true);
      setStatsAvailableFrom(data.statsAvailableFrom || '');
      setWarning(data.warning || '');

      const cas: DropdownOption[] = [];
      const seen = new Set<string>();
      for (const row of data.rows || []) {
        const label = row.assignedTo || row.assignedToEmail || row.assigned_ca;
        const value = row.assignedToEmail || row.assignedTo || row.assigned_ca;
        if (!value || seen.has(value)) continue;
        seen.add(value);
        cas.push({ label, value, name: label, email: value });
      }
      setCareerAssociates(cas);
      setExpanded(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [token, isAuthorized, ca, dateQuery, customFrom, customTo]);

  const loadOperators = useCallback(async () => {
    if (!token || !isAuthorized) return;
    const opParams = dateQuery || `from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`;
    const res = await apiFetch(`/api/manager/operators?${opParams}`);
    const payload: unknown = await res.json();
    if (res.ok) {
      const data = payload as {
        operators?: ManagerOperatorItem[];
        statsAvailable?: boolean;
        statsPartial?: boolean;
        statsAvailableFrom?: string;
      };
      setOperators(data.operators || []);
      setStatsAvailable(data.statsAvailable !== false);
      setStatsPartial(data.statsPartial === true);
      setStatsAvailableFrom(data.statsAvailableFrom || '');
      setOperatorError('');
    } else {
      setOperatorError(payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : 'Unable to load manager operators.');
    }
  }, [token, isAuthorized, dateQuery, customFrom, customTo]);

  const loadActivity = useCallback(async () => {
    if (!token || !isAuthorized) return;
    const range = dateQuery || `from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`;
    const res = await apiFetch(`/api/manager/activity?limit=100&${range}`);
    const payload: unknown = await res.json();
    if (res.ok) {
      const data = payload as { events?: ManagerActivityItem[]; warning?: string };
      setActivity(data.events || []);
      setActivityWarning(data.warning || '');
    }
  }, [token, isAuthorized, dateQuery, customFrom, customTo]);

  const loadReports = useCallback(async () => {
    if (!token || !isAuthorized) return;
    const res = await apiFetch(`/api/manager/reports?range=${encodeURIComponent(reportRange)}`);
    const payload: unknown = await res.json();
    const reportData = payload as ReportsPayload;
    if (res.ok) {
      setReports(reportData);
    }
    setAppliedOperator(null);
    if (!res.ok || reportData.statsAvailable === false) return;

    const start = reportData.start;
    const today = reportData.end;
    if (!start || !today) return;
    try {
      const appliedRes = await apiFetch(`/api/manager/dashboard?from=${encodeURIComponent(start)}&to=${encodeURIComponent(today)}`);
      const appliedPayload: unknown = await appliedRes.json();
      if (!appliedRes.ok) return;
      const data = appliedPayload as { rows?: ManagerClientRow[] };
      const grouped: Record<string, AppliedJobDetail[]> = {};
      for (const row of data.rows || []) {
        const email = String(row.assignedToEmail || row.assigned_ca || '').trim().toLowerCase();
        if (!email) continue;
        for (const detail of (row.submittedApplications || row.completedApplications || [])) {
          if (detail.status !== 'APPLIED' && detail.status !== 'EMAIL_PROOF_PENDING') continue;
          (grouped[email] = grouped[email] || []).push(detail);
        }
      }
      setAppliedByOperator(grouped);
    } catch {
      // Applied column falls back to 0 if the dashboard fetch fails.
    }
  }, [token, isAuthorized, reportRange]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (tab === 'operators') void loadOperators(); }, [tab, loadOperators]);
  useEffect(() => { if (tab === 'activity') void loadActivity(); }, [tab, loadActivity]);
  useEffect(() => { if (tab === 'reports') void loadReports(); }, [tab, loadReports]);

  useEffect(() => {
    const interval = setInterval(() => {
      void load();
      if (tab === 'operators') void loadOperators();
      if (tab === 'activity') void loadActivity();
    }, 30000);
    return () => clearInterval(interval);
  }, [load, loadOperators, loadActivity, tab]);

  useEffect(() => {
    if (!opsPickerOpen || currentRole !== 'dev') return;
    let cancelled = false;
    (async () => {
      setOpsPickerLoading(true);
      setOpsPickerError('');
      try {
        const dateStr = getTodayIST();
        const res = await apiFetch(`/api/admin/managers?date=${encodeURIComponent(dateStr)}`);
        const payload: unknown = await res.json();
        if (!res.ok) {
          const err = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
            ? payload.error
            : 'Unable to load managers.';
          throw new Error(err);
        }
        if (cancelled) return;
        const list = (payload as { managers?: Array<{ email: string; name?: string }> }).managers || [];
        setOpsManagers(list);
        setOpsManagerPick(list[0]?.email || '');
      } catch (e) {
        if (!cancelled) setOpsPickerError(e instanceof Error ? e.message : 'Load failed');
      } finally {
        if (!cancelled) setOpsPickerLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [opsPickerOpen, currentRole]);

  const enterOpsMode = () => {
    if (currentRole === 'manager') {
      if (!window.confirm(
        'Enter Ops mode? You will see your team\'s clients on the operator dashboard. Use "Back to manager mode" on that page to return here.'
      )) return;
      sessionStorage.setItem('applywizz_manager_view_as_operator', '1');
      sessionStorage.setItem('applywizz_view_as_manager_email', userEmail);
      window.location.href = '/';
      return;
    }
    if (currentRole === 'dev') setOpsPickerOpen(true);
  };

  const confirmDevOpsMode = () => {
    const email = String(opsManagerPick || '').trim().toLowerCase();
    if (!email) return;
    sessionStorage.setItem('applywizz_manager_view_as_operator', '1');
    sessionStorage.setItem('applywizz_view_as_manager_email', email);
    window.location.href = '/';
  };

  if (authLoading) {
    return <main className="min-h-screen p-8 text-xs font-mono font-bold bg-[#0a0a0a] text-[#8e8e93]">Checking access…</main>;
  }

  if (!token || !isAuthorized) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-[#0a0a0a] text-white">
        <div className="max-w-md bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-6 shadow-2xl">
          <h1 className="text-xl font-bold mb-2 text-white">Manager dashboard</h1>
          <p className="text-sm text-[#8e8e93] mb-4">Sign in to view your team&apos;s client table.</p>
          <a href="/" className="inline-block bg-[#0a84ff] text-white px-4 py-2 text-sm font-semibold rounded-lg hover:bg-[#0a84ff]/90 transition-colors">Sign in</a>
        </div>
      </main>
    );
  }

  const tabs: Array<{ id: 'home' | 'operators' | 'activity' | 'reports' | 'guide'; label: string }> = [
    { id: 'home', label: 'Home' },
    { id: 'operators', label: 'Operators' },
    { id: 'activity', label: 'Activity' },
    { id: 'reports', label: 'Reports' },
    { id: 'guide', label: 'Guide' },
  ];

  return (
    <main className="min-h-screen p-4 md:p-8 font-sans bg-[#0a0a0a] text-white">
      <AppliedModal operator={appliedOperator} onClose={() => setAppliedOperator(null)} onEmailProof={setEmailProof} />
      <EmailProofModal proof={emailProof} onClose={() => setEmailProof(null)} />
      {opsPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm">
          <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-6 max-w-md w-full shadow-2xl text-white">
            <h2 className="text-lg font-bold mb-1 text-white">Ops mode — choose manager</h2>
            <p className="text-xs text-[#8e8e93] mb-4">Operator dashboard will be scoped to that manager&apos;s team.</p>
            {opsPickerLoading && <p className="text-xs font-mono text-[#8e8e93] mb-2">Loading managers…</p>}
            {opsPickerError && <p className="text-xs font-semibold text-[#ff453a] mb-2">{opsPickerError}</p>}
            {!opsPickerLoading && !opsPickerError && (
              <label className="block text-xs font-semibold uppercase tracking-wider text-[#8e8e93] mb-4">
                Manager
                <SearchableDropdown
                  value={opsManagerPick}
                  onChange={setOpsManagerPick}
                  placeholder="Search manager..."
                  options={opsManagers.map((m) => ({
                    value: m.email,
                    name: m.name,
                    email: m.email,
                    label: m.name ? `${m.name} (${m.email})` : m.email,
                  }))}
                />
              </label>
            )}
            <div className="flex gap-2 justify-end pt-2">
              <button type="button" className="px-3.5 py-1.5 text-xs font-semibold border border-[#3a3a3c] bg-[#2c2c2e] text-white rounded-lg hover:bg-[#3a3a3c] transition-colors" onClick={() => setOpsPickerOpen(false)}>Cancel</button>
              <button
                type="button"
                disabled={opsPickerLoading || !!opsPickerError || !opsManagerPick}
                className="px-4 py-1.5 text-xs font-bold bg-[#0a84ff] text-white rounded-lg disabled:opacity-50 hover:bg-[#0a84ff]/90 transition-colors"
                onClick={confirmDevOpsMode}
              >
                Enter Ops mode
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col gap-4 md:flex-row md:justify-between md:items-end mb-6 pb-6 border-b border-[#2c2c2e]">
          <div className="flex items-center gap-3">
            <img src="/logo.webp" alt="ApplyWizz" className="w-10 h-10 rounded-xl border border-[#2c2c2e] object-cover bg-black" />
            <div>
              <p className="text-xs font-mono font-medium uppercase tracking-widest text-[#8e8e93]">ApplyWizz / Control room</p>
              <h1 className="text-3xl font-bold tracking-tight text-white">Manager dashboard</h1>
              {userEmail && <p className="text-xs font-mono text-[#8e8e93] mt-1">{userEmail}</p>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <DevSwitcher current="/manager" />
            <label className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Filter by Career Associate
              <SearchableDropdown
                value={ca}
                onChange={setCa}
                placeholder="Search operator..."
                options={[
                  { value: 'all', label: 'All', name: 'All', email: '' },
                  ...careerAssociates.map((item) => {
                    const email = item.value || '';
                    const localPart = email.split('@')[0] || email;
                    const label = item.label && item.label !== '—' ? item.label : localPart;
                    return { value: email, label, name: label, email };
                  }),
                ]}
              />
            </label>
            <div className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">
              Date range
              <div className="mt-1 flex flex-wrap items-center gap-2 font-mono normal-case">
                <span className="text-sm font-bold text-white">{dateRangeLabel}</span>
                {dateFilterMode !== 'custom' ? (
                  <>
                    {(['day', 'week', 'month'] as const).map((range) => (
                      <button key={range} type="button" className={`uppercase text-xs font-semibold ${dateFilterMode === range ? 'text-white underline font-bold' : 'text-[#8e8e93] hover:text-white'}`} onClick={() => setDateFilterMode(range)}>{range}</button>
                    ))}
                    <button type="button" className="text-xs text-[#8e8e93] hover:text-white underline" onClick={() => setDateFilterMode('custom')}>Custom</button>
                  </>
                ) : (
                  <>
                    <input type="date" value={customFrom} onChange={(e) => e.target.value && setCustomFrom(e.target.value)} className="border border-[#3a3a3c] rounded-lg px-2 py-1 text-xs bg-[#2c2c2e] text-white focus:outline-none focus:border-[#0a84ff]" />
                    <span>–</span>
                    <input type="date" value={customTo} onChange={(e) => e.target.value && setCustomTo(e.target.value)} className="border border-[#3a3a3c] rounded-lg px-2 py-1 text-xs bg-[#2c2c2e] text-white focus:outline-none focus:border-[#0a84ff]" />
                    <button type="button" className="text-xs text-[#8e8e93] hover:text-white underline" onClick={() => setDateFilterMode('day')}>Reset</button>
                  </>
                )}
              </div>
            </div>
            {(currentRole === 'manager' || currentRole === 'dev') && (
              <button
                type="button"
                onClick={enterOpsMode}
                className="bg-[#2c2c2e] text-white border border-[#3a3a3c] px-3 py-1.5 text-xs font-semibold rounded-lg hover:bg-[#3a3a3c] transition-colors"
              >
                Ops mode
              </button>
            )}
            <button type="button" onClick={() => void load()} className="bg-[#2c2c2e] border border-[#3a3a3c] px-3 py-1.5 text-xs font-semibold rounded-lg text-white hover:bg-[#3a3a3c] transition-colors">Refresh</button>
            <HeaderSignOut onSignOut={signOut} />
          </div>
        </header>
        <nav className="flex flex-wrap gap-2 mb-6">
          {tabs.map((item) => (
            <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg border capitalize transition-colors ${tab === item.id ? 'bg-white text-black font-bold border-white' : 'bg-[#1c1c1e] text-[#8e8e93] border-[#2c2c2e] hover:text-white hover:bg-[#2c2c2e]'}`}>{item.label}</button>
          ))}
        </nav>
        {error && <div className="mb-4 bg-[#ff453a]/15 border border-[#ff453a]/40 rounded-xl p-3 text-sm font-bold text-[#ff453a]">{error}</div>}
        {operatorError && tab === 'operators' && <div className="mb-4 bg-[#ff453a]/15 border border-[#ff453a]/40 rounded-xl p-3 text-sm font-bold text-[#ff453a]">{operatorError}</div>}
        {warning && <div className="mb-4 bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-xl p-3 text-xs font-semibold text-[#ff9f0a]">{warning}</div>}
        {statsAvailable === false && <div className="mb-4 bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-xl p-3 text-xs font-semibold text-[#ff9f0a]">Application statistics before {statsAvailableFrom || 'the cutover date'} are unavailable.</div>}
        {statsAvailable !== false && statsPartial && <div className="mb-4 bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-xl p-3 text-xs font-semibold text-[#ff9f0a]">Partial statistics: dates before {statsAvailableFrom} are excluded.</div>}
        {loading && <p className="text-xs font-mono font-medium text-[#8e8e93] mb-4">Loading…</p>}

        {tab === 'home' && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              {[
                ['Total Applications', totals.applications],
                ['Submitted (team)', submitted],
                ['Applied (team)', applied],
                ['Failed (team)', totals.failed],
              ].map(([label, val]) => (
                <div key={label} className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">{label}</p>
                  <p className="text-2xl font-black text-white mt-1">{statsAvailable === false ? '—' : val ?? 0}</p>
                </div>
              ))}
            </div>
            <ClientTable
              rows={rows}
              loading={loading}
              statsAvailable={statsAvailable !== false}
              expanded={expanded}
              onToggle={(key) => setExpanded(expanded === key ? null : key)}
              onEmailProof={setEmailProof}
            />
            <p className="mt-2 text-[11px] text-[#8e8e93]">Metric counts use creation and status-transition dates; expandable job/proof details include retained live rows only and may be incomplete.</p>
          </>
        )}

        {tab === 'operators' && (
          <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-x-auto">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 border-b border-[#2c2c2e] bg-[#2c2c2e]/40">
              {[
                ['Total Applications', totals.applications],
                ['Submitted (team)', submitted],
                ['Applied (team)', applied],
                ['Failed (team)', totals.failed],
              ].map(([label, val]) => (
                <div key={label}><p className="text-[10px] font-semibold uppercase tracking-wider text-[#8e8e93]">{label}</p><p className="text-xl font-black text-white mt-0.5">{statsAvailable === false ? '—' : val ?? 0}</p></div>
              ))}
            </div>
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-[#2c2c2e]/60 border-b border-[#2c2c2e] text-[#8e8e93]">
                <tr>{['Operator', 'Status', 'Assigned', 'Submitted', 'Applied', 'Failed', 'Last sign-in'].map((h) => <th key={h} className="p-3 font-semibold uppercase tracking-wider">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-[#2c2c2e]/50">
                {operators.map((op) => (
                  <tr key={op.email} className="hover:bg-[#2c2c2e]/30 transition-colors">
                    <td className="p-3">
                      <button type="button" className="font-bold text-white underline hover:text-[#0a84ff]" onClick={() => { setCa(op.email); setTab('home'); }}>{op.name}</button>
                      <p className="text-[#8e8e93] font-mono mt-0.5">{op.email}</p>
                    </td>
                    <td className="p-3 uppercase font-semibold text-[#8e8e93]">{op.status}</td>
                    <td className="p-3 font-mono text-white">{statsAvailable === false ? '—' : op.applications ?? 0}</td>
                    <td className="p-3 font-mono text-white">{statsAvailable === false ? '—' : op.submitted ?? op.completed ?? 0}</td>
                    <td className="p-3 font-mono text-[#30d158] font-bold">{statsAvailable === false ? '—' : op.applied ?? 0}</td>
                    <td className="p-3 font-mono text-[#ff453a]">{statsAvailable === false ? '—' : op.failed ?? 0}</td>
                    <td className="p-3 font-mono text-[#8e8e93]">{op.lastSignInAt ? new Date(op.lastSignInAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!operators.length && <p className="p-6 text-center text-[#8e8e93]">No operators on this date&apos;s applications.</p>}
          </div>
        )}

        {tab === 'activity' && (
          <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-hidden">
            {activityWarning && <p className="p-3 text-xs font-semibold bg-[#ff9f0a]/15 border-b border-[#ff9f0a]/30 text-[#ff9f0a]">{activityWarning}</p>}
            <ul className="divide-y divide-[#2c2c2e]/60 text-xs">
              {activity.map((event, index) => (
                <li key={`${event.timestamp}-${event.applywizz_id}-${event.to_status}-${index}`} className="p-3 hover:bg-[#2c2c2e]/30 transition-colors">
                  <p className="font-mono text-[#8e8e93]">
                    <span className="text-white">[{new Date(event.timestamp || event.created_at || '').toLocaleString()}]</span> {event.candidate_name || event.applywizz_id || '—'} applied to <span className="text-[#0a84ff]">{event.job_title || 'Job'}</span> at {event.company_name || '—'} → <span className="font-bold text-[#30d158]">{event.to_status || '—'}</span>
                  </p>
                </li>
              ))}
            </ul>
            {!activity.length && <p className="p-6 text-center text-[#8e8e93]">No team activity yet.</p>}
          </div>
        )}

        {tab === 'reports' && (
          <div className="space-y-4">
            {reports.statsAvailable === false && <p className="bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-xl p-3 text-xs font-semibold text-[#ff9f0a]">Application statistics before {reports.statsAvailableFrom || 'the cutover date'} are unavailable.</p>}
            {reports.statsAvailable !== false && reports.statsPartial && <p className="bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-xl p-3 text-xs font-semibold text-[#ff9f0a]">Partial statistics: dates before {reports.statsAvailableFrom} are excluded.</p>}
            <div className="flex gap-2">
              {(['day', 'week', 'month'] as const).map((range) => (
                <button key={range} type="button" onClick={() => setReportRange(range)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg border capitalize transition-colors ${reportRange === range ? 'bg-white text-black font-bold border-white' : 'bg-[#1c1c1e] text-[#8e8e93] border-[#2c2c2e] hover:text-white hover:bg-[#2c2c2e]'}`}>{range}</button>
              ))}
            </div>
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#2c2c2e]/60 border-b border-[#2c2c2e] text-[#8e8e93]"><tr>{['Period', 'Total', 'Submitted', 'Applied', 'Failed'].map((heading) => <th key={heading} className="p-3 font-semibold uppercase tracking-wider">{heading}</th>)}</tr></thead>
                <tbody className="divide-y divide-[#2c2c2e]/50">
                  {(reports.buckets || []).map((bucket) => (
                    <tr key={bucket.date} className="hover:bg-[#2c2c2e]/30 transition-colors"><td className="p-3 font-mono text-white">{bucket.date}</td><td className="p-3 font-mono text-white font-bold">{bucket.total ?? bucket.applications}</td><td className="p-3 font-mono text-white">{bucket.submitted ?? 0}</td><td className="p-3 font-mono text-[#30d158]">{bucket.applied ?? 0}</td><td className="p-3 font-mono text-[#ff453a]">{bucket.failed ?? 0}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#2c2c2e]/60 border-b border-[#2c2c2e] text-[#8e8e93]"><tr>{['Operator', 'Total', 'Submitted', 'Applied', 'Failed'].map((heading) => <th key={heading} className="p-3 font-semibold uppercase tracking-wider">{heading}</th>)}</tr></thead>
                <tbody className="divide-y divide-[#2c2c2e]/50">
                  {(reports.perOperator || []).map((row) => (
                    <tr key={row.email} className="hover:bg-[#2c2c2e]/30 transition-colors">
                      <td className="p-3 font-bold text-white">{row.name}</td>
                      <td className="p-3 font-mono text-white">{reports.statsAvailable === false ? '—' : row.applications}</td>
                      <td className="p-3 font-mono text-white">{reports.statsAvailable === false ? '—' : row.submitted ?? row.completed}</td>
                      <td className="p-3">
                        <CountButton
                          value={reports.statsAvailable === false ? null : row.applied ?? 0}
                          active={!!appliedOperator && appliedOperator.email === row.email}
                          onClick={() => setAppliedOperator(appliedOperator && appliedOperator.email === row.email ? null : { email: row.email, name: row.name, items: appliedByOperator[row.email] || [] })}
                        />
                      </td>
                      <td className="p-3 font-mono text-[#ff453a]">{reports.statsAvailable === false ? '—' : row.failed ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'guide' && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-white">Manager Guide</h2>
              <p className="text-xs text-[#8e8e93] font-mono mt-0.5">Oversee your team&apos;s applications — read-only monitoring, not submitting jobs.</p>
            </div>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-2">What you see</h3>
              <p className="text-sm text-[#8e8e93] leading-relaxed">
                This dashboard shows <span className="font-semibold text-white">only your team</span>: operators linked to you when they sign in. You do not see other managers&apos; operators or clients. To submit applications, operators use the main <span className="font-semibold text-white">Operator</span> dashboard at <span className="font-mono text-white">/</span>.
              </p>
            </section>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-3">Home</h3>
              <ul className="space-y-2 text-sm text-[#8e8e93] leading-relaxed list-disc list-inside">
                <li>Summary cards: Applications, Submitted (team), Applied (team) — scoped to your date range.</li>
                <li>Client table: click underlined <span className="font-semibold text-white">Submitted</span>, <span className="font-semibold text-white">Pending</span>, or <span className="font-semibold text-white">Failed</span> counts to expand job links, proofs, or failure reasons.</li>
                <li><span className="font-semibold text-white">Filter by Career Associate</span> narrows the table to one operator.</li>
                <li>Default date range is <span className="font-semibold text-white">Today &amp; Yesterday</span>; use Custom / Reset and Refresh in the header.</li>
              </ul>
            </section>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-3">Operators, Activity, Reports</h3>
              <ul className="space-y-2 text-sm text-[#8e8e93] leading-relaxed list-disc list-inside">
                <li><span className="font-semibold text-white">Operators</span> — roster with status, apps, workload, last sign-in. Click an operator name to open Home filtered to that CA.</li>
                <li><span className="font-semibold text-white">Activity</span> — recent application status changes for your team.</li>
                <li><span className="font-semibold text-white">Reports</span> — day, week, or month application totals by period and per operator.</li>
              </ul>
            </section>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-3">Important notes</h3>
              <ul className="space-y-2 text-sm text-[#8e8e93] leading-relaxed list-disc list-inside">
                <li>Yellow warnings may mean no operators are assigned yet or work history was temporarily unreachable.</li>
                <li>Submitted rows may show web or email proof links — use these for QA, not for re-submitting.</li>
                <li>Skipped jobs (35+ questions, Zoho not connected, expired postings, etc.) appear with plain-language reasons — same rules as the operator dashboard.</li>
                <li>Operator-to-manager assignment happens on operator sign-in; this UI does not reassign teams.</li>
                <li><span className="font-semibold text-white">Ops mode</span> (header) opens the operator dashboard at <span className="font-mono text-white">/</span> scoped to your team&apos;s clients (<span className="font-mono text-white">profiles.ca_email</span> for your operators). Submit and review there; use <span className="font-semibold text-white">Back to manager mode</span> on that page to return here.</li>
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

export default ManagerDashboard;
