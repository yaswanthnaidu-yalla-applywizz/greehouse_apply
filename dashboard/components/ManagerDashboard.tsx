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
  applications: number;
  completed: number;
  applied?: number;
  pending: number;
  failed: number;
  assigned_ca?: string;
  assignedTo?: string;
  assignedToEmail?: string;
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
  applications: number;
  completed?: number;
  applied?: number;
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
}

interface ReportPerOperator {
  email: string;
  name: string;
  applications: number;
  apps?: number;
  completed: number;
  applied?: number;
}

interface ReportsPayload {
  buckets: ReportBucket[];
  perOperator: ReportPerOperator[];
}

interface ManagerDashboardApiResponse {
  rows?: ManagerClientRow[];
  totals?: Record<string, number>;
  completed?: number;
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1A1A2E]/80" onClick={onClose}>
      <div className="relative w-full max-w-2xl bg-white border-2 border-[#1A1A2E] rounded-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 bg-[#EFF6FF] border-b-2 border-[#1A1A2E] flex justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">Applied jobs</p>
            <h3 className="text-sm font-bold break-words">{operator.name}</h3>
            <p className="text-xs font-mono mt-1">{items.length} applied application(s)</p>
          </div>
          <button type="button" onClick={onClose} className="font-black px-2">✕</button>
        </header>
        <div className="px-5 py-4 bg-[#FAF4EB] max-h-[50vh] overflow-y-auto">
          <div className="space-y-2">
            {!items.length ? (
              <p className="text-xs text-[#64748B]">No applied applications for this operator in the selected report period.</p>
            ) : items.map((item, index) => (
              <div key={item.id || item.job_url || index} className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between text-xs">
                <span className="break-words">
                  <a href={item.job_url} target="_blank" rel="noopener noreferrer" className="font-bold text-[#1E3A5F] underline break-all">{item.job_title || 'Job'}</a>
                  <span className="text-[#64748B]"> at {item.company_name || '—'}</span>
                </span>
                <span className="flex flex-wrap gap-3 shrink-0">
                  {item.proof_web_url ? <a href={item.proof_web_url} target="_blank" rel="noopener noreferrer" className="text-[#1E4620] underline font-bold">Web proof screenshot</a> : <span className="text-[#64748B]">Web proof unavailable</span>}
                  {item.proof_email_url ? (
                    <a href={item.proof_email_url} target="_blank" rel="noopener noreferrer" className="text-[#1E4620] underline font-bold">Email screenshot</a>
                  ) : item.proof_email_json ? (
                    <button type="button" className="text-[#1E4620] underline font-bold" onClick={() => onEmailProof(item.proof_email_json as EmailProofData)}>View email proof</button>
                  ) : (
                    <span className="text-[#64748B]">Email proof unavailable</span>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1A1A2E]/80" onClick={onClose}>
      <div className="relative w-full max-w-2xl bg-white border-2 border-[#1A1A2E] rounded-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 bg-[#EFF6FF] border-b-2 border-[#1A1A2E] flex justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#64748B]">Email proof</p>
            <h3 className="text-sm font-bold break-words">{proof.subject || '(No subject)'}</h3>
            {proof.from && <p className="text-xs font-mono mt-1">From {proof.from}</p>}
            {received && <p className="text-xs font-mono">Received {received}</p>}
          </div>
          <button type="button" onClick={onClose} className="font-black px-2">✕</button>
        </header>
        <div className="px-5 py-4 bg-[#FAF4EB] max-h-[50vh] overflow-y-auto text-xs whitespace-pre-wrap break-words">{(proof.body_text || '').slice(0, 4000)}</div>
      </div>
    </div>
  );
};

const DetailList: React.FC<{
  items?: AppliedJobDetail[];
  mode: 'completed' | 'pending' | 'failed';
  onEmailProof: (proof: EmailProofData) => void;
}> = ({ items, mode, onEmailProof }) => {
  return (
    <div className="bg-[#FFF5EB] border-t-2 border-[#1A1A2E] px-4 py-3">
      <div className="space-y-2">
        {(!items || items.length === 0) ? (
          <p className="text-xs text-[#64748B]">No application details returned for this client.</p>
        ) : items.map((item, index) => (
          <div key={item.id || item.job_url || index} className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between text-xs">
            <a href={item.job_url} target="_blank" rel="noopener noreferrer" className="font-bold text-[#1E3A5F] underline break-all">{item.job_url}</a>
            {mode === 'completed' && (
              <span className="flex flex-wrap gap-3 shrink-0">
                {item.proof_web_url ? <a href={item.proof_web_url} target="_blank" rel="noopener noreferrer" className="text-[#1E4620] underline font-bold">Web proof screenshot</a> : <span className="text-[#64748B]">Web proof unavailable</span>}
                {item.proof_email_url ? (
                  <a href={item.proof_email_url} target="_blank" rel="noopener noreferrer" className="text-[#1E4620] underline font-bold">Email screenshot</a>
                ) : item.proof_email_json ? (
                  <button type="button" className="text-[#1E4620] underline font-bold" onClick={() => onEmailProof(item.proof_email_json as EmailProofData)}>View email proof</button>
                ) : (
                  <span className="text-[#64748B]">Email proof unavailable</span>
                )}
              </span>
            )}
            {mode === 'failed' && <span className="text-[#991B1B] md:max-w-sm">{item.error_message || 'Failure reason unavailable'}</span>}
          </div>
        ))}
      </div>
    </div>
  );
};

const CountButton: React.FC<{
  value?: number;
  onClick: () => void;
  active: boolean;
}> = ({ value, onClick, active }) => {
  if (!value) return <span className="font-mono">{value ?? 0}</span>;
  return (
    <button type="button" onClick={onClick} className={`font-mono underline decoration-2 ${active ? 'text-[#E88474] font-black' : 'text-[#1E3A5F]'}`}>{value}</button>
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
          <tr>{['Client', 'Apps', 'Completed', 'Applied', 'Pending', 'Failed', 'Assigned'].map((h) => <th key={h} className="p-3 font-black uppercase">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const completedKey = `${row.client}:completed`;
            const pendingKey = `${row.client}:pending`;
            const failedKey = `${row.client}:failed`;
            const openKey = expanded && expanded.startsWith(`${row.client}:`) ? expanded : null;
            const mode = openKey ? (openKey.split(':')[1] as 'completed' | 'pending' | 'failed') : null;
            const items = mode === 'completed' ? row.completedApplications : mode === 'pending' ? row.pendingApplications : mode === 'failed' ? row.failedApplications : [];
            return (
              <React.Fragment key={row.client}>
                <tr className="border-b border-[#1A1A2E]/20">
                  <td className="p-3 font-black">{row.client}</td>
                  <td className="p-3 font-mono">{row.applications}</td>
                  <td className="p-3"><CountButton value={row.completed} active={expanded === completedKey} onClick={() => onToggle(completedKey)} /></td>
                  <td className="p-3 font-mono">{row.applied ?? 0}</td>
                  <td className="p-3"><CountButton value={row.pending} active={expanded === pendingKey} onClick={() => onToggle(pendingKey)} /></td>
                  <td className="p-3"><CountButton value={row.failed} active={expanded === failedKey} onClick={() => onToggle(failedKey)} /></td>
                  <td className="p-3 text-[#64748B]">{row.assigned_ca || row.assignedTo || '—'}</td>
                </tr>
                {openKey && mode && (
                  <tr className="border-b border-[#1A1A2E]/20">
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
      {!rows.length && !loading && <p className="p-6 text-center text-[#64748B]">No rows for this date.</p>}
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
        className="block w-full border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-sm bg-white"
      />
      {open && (
        <div className="absolute z-30 mt-1 w-full max-h-56 overflow-y-auto bg-white border-2 border-[#1A1A2E] rounded shadow-[2px_2px_0px_#1A1A2E]">
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
              className="block w-full text-left px-2 py-1.5 text-sm hover:bg-[#FAF4EB]"
            >
              {option.label || option.name || option.email}
            </button>
          )) : (
            <p className="px-2 py-1.5 text-xs text-[#64748B]">No matches</p>
          )}
        </div>
      )}
    </div>
  );
};

export const ManagerDashboard: React.FC = () => {
  const { token, loading: authLoading, isAuthorized, signOut } = useRequireRole(['manager']);

  const [tab, setTab] = useState<'home' | 'operators' | 'activity' | 'reports' | 'guide'>('home');
  const [dateFilterMode, setDateFilterMode] = useState<'default' | 'custom'>('default');
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
      : 'Today & Yesterday';
  const dateQuery =
    dateFilterMode === 'custom' && customFrom && customTo
      ? `from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`
      : '';

  const [ca, setCa] = useState<string>('all');
  const [rows, setRows] = useState<ManagerClientRow[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [completed, setCompleted] = useState<number>(0);
  const [careerAssociates, setCareerAssociates] = useState<DropdownOption[]>([]);
  const [warning, setWarning] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [emailProof, setEmailProof] = useState<EmailProofData | null>(null);
  const [appliedByOperator, setAppliedByOperator] = useState<Record<string, AppliedJobDetail[]>>({});
  const [appliedOperator, setAppliedOperator] = useState<AppliedOperatorData | null>(null);
  const [operators, setOperators] = useState<ManagerOperatorItem[]>([]);
  const [operatorTotals, setOperatorTotals] = useState<{ assigned?: number; completed?: number }>({});
  const [activity, setActivity] = useState<ManagerActivityItem[]>([]);
  const [activityWarning, setActivityWarning] = useState<string>('');
  const [reports, setReports] = useState<ReportsPayload>({ buckets: [], perOperator: [] });
  const [reportRange, setReportRange] = useState<'daily' | 'weekly' | 'monthly'>('daily');
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
      if (dateQuery) {
        params.set('from', customFrom);
        params.set('to', customTo);
      }
      const res = await apiFetch(`/api/manager/dashboard?${params}`);
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
      setCompleted(data.completed ?? 0);
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
    const opParams = dateQuery ? `?${dateQuery}` : '';
    const res = await apiFetch(`/api/manager/operators${opParams}`);
    const payload: unknown = await res.json();
    if (res.ok) {
      const data = payload as { operators?: ManagerOperatorItem[]; totals?: { assigned?: number; completed?: number } };
      setOperators(data.operators || []);
      setOperatorTotals(data.totals || {});
    }
  }, [token, isAuthorized, dateQuery]);

  const loadActivity = useCallback(async () => {
    if (!token || !isAuthorized) return;
    const res = await apiFetch('/api/manager/activity?limit=100');
    const payload: unknown = await res.json();
    if (res.ok) {
      const data = payload as { events?: ManagerActivityItem[]; warning?: string };
      setActivity(data.events || []);
      setActivityWarning(data.warning || '');
    }
  }, [token, isAuthorized]);

  const loadReports = useCallback(async () => {
    if (!token || !isAuthorized) return;
    const res = await apiFetch(`/api/manager/reports?range=${encodeURIComponent(reportRange)}`);
    const payload: unknown = await res.json();
    if (res.ok) {
      setReports(payload as ReportsPayload);
    }
    setAppliedOperator(null);

    const dayCount = reportRange === 'monthly' ? 180 : reportRange === 'weekly' ? 56 : 14;
    const today = getTodayIST();
    const start = (() => {
      const d = new Date(`${today}T00:00:00+05:30`);
      d.setDate(d.getDate() - (dayCount - 1));
      return d.toISOString().slice(0, 10);
    })();
    try {
      const appliedRes = await apiFetch(`/api/manager/dashboard?from=${encodeURIComponent(start)}&to=${encodeURIComponent(today)}`);
      const appliedPayload: unknown = await appliedRes.json();
      if (!appliedRes.ok) return;
      const data = appliedPayload as { rows?: ManagerClientRow[] };
      const grouped: Record<string, AppliedJobDetail[]> = {};
      for (const row of data.rows || []) {
        const email = String(row.assignedToEmail || row.assigned_ca || '').trim().toLowerCase();
        if (!email) continue;
        for (const detail of row.completedApplications || []) {
          if (detail.status !== 'APPLIED') continue;
          (grouped[email] = grouped[email] || []).push(detail);
        }
      }
      setAppliedByOperator(grouped);
      setReports((prev) => ({
        ...prev,
        perOperator: (prev.perOperator || []).map((row) => ({ ...row, applied: (grouped[row.email] || []).length })),
      }));
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
    return <main className="min-h-screen p-8 text-xs font-mono font-bold bg-[#FFF5EB] text-[#1A1A2E]">Checking access…</main>;
  }

  if (!token || !isAuthorized) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-[#FFF5EB] text-[#1A1A2E]">
        <div className="max-w-md bg-white border-2 border-[#1A1A2E] rounded-lg p-6 shadow-[4px_4px_0_#1A1A2E]">
          <h1 className="text-xl font-black mb-2">Manager dashboard</h1>
          <p className="text-sm mb-4">Sign in to view your team&apos;s client table.</p>
          <a href="/" className="inline-block bg-[#E88474] border-2 border-[#1A1A2E] px-4 py-2 text-sm font-bold rounded shadow-[2px_2px_0_#1A1A2E]">Sign in</a>
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
    <main className="min-h-screen p-4 md:p-8 font-sans bg-[#FFF5EB] text-[#1A1A2E]">
      <AppliedModal operator={appliedOperator} onClose={() => setAppliedOperator(null)} onEmailProof={setEmailProof} />
      <EmailProofModal proof={emailProof} onClose={() => setEmailProof(null)} />
      {opsPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white border-2 border-[#1A1A2E] rounded-lg p-5 max-w-md w-full shadow-[4px_4px_0_#1A1A2E]">
            <h2 className="text-lg font-black mb-2">Ops mode — choose manager</h2>
            <p className="text-xs text-[#64748B] mb-3">Operator dashboard will be scoped to that manager&apos;s team.</p>
            {opsPickerLoading && <p className="text-xs font-mono mb-2">Loading managers…</p>}
            {opsPickerError && <p className="text-xs font-bold text-[#991B1B] mb-2">{opsPickerError}</p>}
            {!opsPickerLoading && !opsPickerError && (
              <label className="block text-xs font-bold uppercase mb-3">
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
            <div className="flex gap-2 justify-end">
              <button type="button" className="px-3 py-2 text-xs font-bold border-2 border-[#1A1A2E] rounded" onClick={() => setOpsPickerOpen(false)}>Cancel</button>
              <button
                type="button"
                disabled={opsPickerLoading || !!opsPickerError || !opsManagerPick}
                className="px-3 py-2 text-xs font-bold bg-[#1E3A5F] text-white border-2 border-[#1A1A2E] rounded disabled:opacity-50"
                onClick={confirmDevOpsMode}
              >
                Enter Ops mode
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col gap-4 md:flex-row md:justify-between md:items-end mb-6">
          <div className="flex items-center gap-3">
            <img src="/logo.webp" alt="ApplyWizz" className="w-10 h-10 rounded-lg border-2 border-[#1A1A2E] shadow-[2px_2px_0px_#E88474] object-cover bg-black" />
            <div>
              <p className="text-xs font-mono font-bold uppercase tracking-widest text-[#64748B]">ApplyWizz / Control room</p>
              <h1 className="text-3xl font-black">Manager dashboard</h1>
              {userEmail && <p className="text-xs font-mono text-[#64748B] mt-1">{userEmail}</p>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <DevSwitcher current="/manager" />
            <label className="text-xs font-bold uppercase">Filter by Career Associate
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
            <div className="text-xs font-bold uppercase">
              Date range
              <div className="mt-1 flex flex-wrap items-center gap-2 font-mono normal-case">
                <span className="text-sm font-black">{dateRangeLabel}</span>
                {dateFilterMode !== 'custom' ? (
                  <button type="button" className="underline text-[#64748B]" onClick={() => setDateFilterMode('custom')}>Custom</button>
                ) : (
                  <>
                    <input type="date" value={customFrom} onChange={(e) => e.target.value && setCustomFrom(e.target.value)} className="border-2 border-[#1A1A2E] rounded px-2 py-1 text-sm bg-white" />
                    <span>–</span>
                    <input type="date" value={customTo} onChange={(e) => e.target.value && setCustomTo(e.target.value)} className="border-2 border-[#1A1A2E] rounded px-2 py-1 text-sm bg-white" />
                    <button type="button" className="underline text-[#64748B]" onClick={() => setDateFilterMode('default')}>Reset</button>
                  </>
                )}
              </div>
            </div>
            {(currentRole === 'manager' || currentRole === 'dev') && (
              <button
                type="button"
                onClick={enterOpsMode}
                className="bg-[#1E3A5F] text-white border-2 border-[#1A1A2E] px-3 py-2 text-xs font-bold rounded shadow-[2px_2px_0_#1A1A2E]"
              >
                Ops mode
              </button>
            )}
            <button type="button" onClick={() => void load()} className="bg-[#E88474] border-2 border-[#1A1A2E] px-3 py-2 text-xs font-bold rounded">Refresh</button>
            <HeaderSignOut onSignOut={signOut} />
          </div>
        </header>
        <nav className="flex flex-wrap gap-2 mb-6">
          {tabs.map((item) => (
            <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`px-3 py-1.5 text-xs font-bold border-2 border-[#1A1A2E] rounded ${tab === item.id ? 'bg-[#E88474] text-white' : 'bg-white'}`}>{item.label}</button>
          ))}
        </nav>
        {error && <div className="mb-4 bg-[#FECACA] border-2 border-[#991B1B] rounded p-3 text-sm font-bold">{error}</div>}
        {warning && <div className="mb-4 bg-[#FEF3C7] border-2 border-[#1A1A2E] rounded p-3 text-xs font-bold">{warning}</div>}
        {loading && <p className="text-xs font-mono font-bold mb-4">Loading…</p>}

        {tab === 'home' && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
              {[
                ['Total Applications', totals.applications],
                ['Completed (team)', completed],
                ['Applied (team)', totals.applied],
              ].map(([label, val]) => (
                <div key={label} className="bg-white border-2 border-[#1A1A2E] rounded p-4 shadow-[2px_2px_0_#1A1A2E]">
                  <p className="text-xs font-bold uppercase">{label}</p>
                  <p className="text-2xl font-black mt-1">{val ?? 0}</p>
                </div>
              ))}
            </div>
            <ClientTable
              rows={rows}
              loading={loading}
              expanded={expanded}
              onToggle={(key) => setExpanded(expanded === key ? null : key)}
              onEmailProof={setEmailProof}
            />
          </>
        )}

        {tab === 'operators' && (
          <div className="bg-white border-2 border-[#1A1A2E] rounded overflow-x-auto">
            <div className="grid grid-cols-3 gap-3 p-4 border-b-2 border-[#1A1A2E]">
              {[
                ['Assigned', operatorTotals.assigned],
                ['Completed', operatorTotals.completed],
              ].map(([label, val]) => (
                <div key={label}><p className="text-[10px] font-bold uppercase text-[#64748B]">{label}</p><p className="text-xl font-black">{val ?? 0}</p></div>
              ))}
            </div>
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]">
                <tr>{['Operator', 'Status', 'Assigned', 'Completed', 'Applied', 'Last sign-in'].map((h) => <th key={h} className="p-3 font-black uppercase">{h}</th>)}</tr>
              </thead>
              <tbody>
                {operators.map((op) => (
                  <tr key={op.email} className="border-b border-[#1A1A2E]/20">
                    <td className="p-3">
                      <button type="button" className="font-black underline" onClick={() => { setCa(op.email); setTab('home'); }}>{op.name}</button>
                      <p className="text-[#64748B] font-mono">{op.email}</p>
                    </td>
                    <td className="p-3 uppercase font-bold">{op.status}</td>
                    <td className="p-3 font-mono">{op.applications}</td>
                    <td className="p-3 font-mono">{op.completed ?? 0}</td>
                    <td className="p-3 font-mono">{op.applied ?? 0}</td>
                    <td className="p-3 font-mono">{op.lastSignInAt ? new Date(op.lastSignInAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!operators.length && <p className="p-6 text-center text-[#64748B]">No operators on this date&apos;s applications.</p>}
          </div>
        )}

        {tab === 'activity' && (
          <div className="bg-white border-2 border-[#1A1A2E] rounded">
            {activityWarning && <p className="p-3 text-xs font-bold bg-[#FEF3C7] border-b-2 border-[#1A1A2E]">{activityWarning}</p>}
            <ul className="divide-y divide-[#1A1A2E]/20 text-xs">
              {activity.map((event, index) => (
                <li key={`${event.timestamp}-${event.applywizz_id}-${event.to_status}-${index}`} className="p-3">
                  <p className="font-mono text-[#1A1A2E]">
                    [{new Date(event.timestamp || event.created_at || '').toLocaleString()}] {event.candidate_name || event.applywizz_id || '—'} applied to {event.job_title || 'Job'} at {event.company_name || '—'} → {event.to_status || '—'}
                  </p>
                </li>
              ))}
            </ul>
            {!activity.length && <p className="p-6 text-center text-[#64748B]">No team activity yet.</p>}
          </div>
        )}

        {tab === 'reports' && (
          <div className="space-y-4">
            <div className="flex gap-2">
              {(['daily', 'weekly', 'monthly'] as const).map((range) => (
                <button key={range} type="button" onClick={() => setReportRange(range)} className={`px-3 py-1.5 text-xs font-bold border-2 border-[#1A1A2E] rounded capitalize ${reportRange === range ? 'bg-[#E88474] text-white' : 'bg-white'}`}>{range}</button>
              ))}
            </div>
            <div className="bg-white border-2 border-[#1A1A2E] rounded overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]"><tr><th className="p-3 font-black uppercase">Period</th><th className="p-3 font-black uppercase">Applications</th></tr></thead>
                <tbody>
                  {(reports.buckets || []).map((bucket) => (
                    <tr key={bucket.date} className="border-b border-[#1A1A2E]/20"><td className="p-3 font-mono">{bucket.date}</td><td className="p-3 font-mono">{bucket.applications}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-white border-2 border-[#1A1A2E] rounded overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]"><tr><th className="p-3 font-black uppercase">Operator</th><th className="p-3 font-black uppercase">Applications</th><th className="p-3 font-black uppercase">Assigned</th><th className="p-3 font-black uppercase">Completed</th><th className="p-3 font-black uppercase">Applied</th></tr></thead>
                <tbody>
                  {(reports.perOperator || []).map((row) => (
                    <tr key={row.email} className="border-b border-[#1A1A2E]/20">
                      <td className="p-3 font-black">{row.name}</td>
                      <td className="p-3 font-mono">{row.applications}</td>
                      <td className="p-3 font-mono">{row.apps ?? 0}</td>
                      <td className="p-3 font-mono">{row.completed}</td>
                      <td className="p-3">
                        <CountButton
                          value={row.applied ?? 0}
                          active={!!appliedOperator && appliedOperator.email === row.email}
                          onClick={() => setAppliedOperator(appliedOperator && appliedOperator.email === row.email ? null : { email: row.email, name: row.name, items: appliedByOperator[row.email] || [] })}
                        />
                      </td>
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
              <h2 className="text-2xl font-black text-[#1A1A2E]">Manager Guide</h2>
              <p className="text-xs text-[#64748B] font-mono mt-0.5">Oversee your team&apos;s applications — read-only monitoring, not submitting jobs.</p>
            </div>

            <section className="bg-white border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <h3 className="text-sm font-black uppercase tracking-wide mb-2">What you see</h3>
              <p className="text-sm text-[#1A1A2E] leading-relaxed">
                This dashboard shows <span className="font-bold">only your team</span>: operators linked to you when they sign in. You do not see other managers&apos; operators or clients. To submit applications, operators use the main <span className="font-bold">Operator</span> dashboard at <span className="font-mono">/</span>.
              </p>
            </section>

            <section className="bg-[#FFF8D6] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <h3 className="text-sm font-black uppercase tracking-wide mb-3">Home</h3>
              <ul className="space-y-2 text-sm text-[#1A1A2E] leading-relaxed list-disc list-inside">
                <li>Summary cards: Applications, Completed (team), Applied (team) — scoped to your date range.</li>
                <li>Client table: click underlined <span className="font-bold">Completed</span>, <span className="font-bold">Pending</span>, or <span className="font-bold">Failed</span> counts to expand job links, proofs, or failure reasons.</li>
                <li><span className="font-bold">Filter by Career Associate</span> narrows the table to one operator.</li>
                <li>Default date range is <span className="font-bold">Today &amp; Yesterday</span>; use Custom / Reset and Refresh in the header.</li>
              </ul>
            </section>

            <section className="bg-white border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <h3 className="text-sm font-black uppercase tracking-wide mb-3">Operators, Activity, Reports</h3>
              <ul className="space-y-2 text-sm text-[#1A1A2E] leading-relaxed list-disc list-inside">
                <li><span className="font-bold">Operators</span> — roster with status, apps, workload, last sign-in. Click an operator name to open Home filtered to that CA.</li>
                <li><span className="font-bold">Activity</span> — recent application status changes for your team.</li>
                <li><span className="font-bold">Reports</span> — daily, weekly, or monthly application totals by period and per operator.</li>
              </ul>
            </section>

            <section className="bg-[#E2F0FB] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <h3 className="text-sm font-black uppercase tracking-wide mb-3">Important notes</h3>
              <ul className="space-y-2 text-sm text-[#1A1A2E] leading-relaxed list-disc list-inside">
                <li>Yellow warnings may mean no operators are assigned yet or work history was temporarily unreachable.</li>
                <li>Completed rows may show web or email proof links — use these for QA, not for re-submitting.</li>
                <li>Skipped jobs (35+ questions, Zoho not connected, expired postings, etc.) appear with plain-language reasons — same rules as the operator dashboard.</li>
                <li>Operator-to-manager assignment happens on operator sign-in; this UI does not reassign teams.</li>
                <li><span className="font-bold">Ops mode</span> (header) opens the operator dashboard at <span className="font-mono">/</span> scoped to your team&apos;s clients (<span className="font-mono">profiles.ca_email</span> for your operators). Submit and review there; use <span className="font-bold">Back to manager mode</span> on that page to return here.</li>
              </ul>
            </section>

            <section className="bg-[#FAF4EB] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E] text-center">
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

export default ManagerDashboard;
