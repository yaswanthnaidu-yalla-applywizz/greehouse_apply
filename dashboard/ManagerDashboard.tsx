import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthView, type AuthUser } from './components/AuthView.js';

type RecordValue = Record<string, unknown>;

interface ManagerDashboardProps {
  apiBaseUrl?: string;
}

interface ApplicationItem {
  id: string;
  jobUrl: string;
  failureReason?: string;
  webProofUrl?: string;
  emailProofUrl?: string;
}

interface ClientRow {
  client: string;
  applications: number;
  completed: number;
  pending: number;
  failed: number;
  waitingForEmail: number;
  assignedTo: string;
  completedItems: ApplicationItem[];
  pendingItems: ApplicationItem[];
  failedItems: ApplicationItem[];
}

interface DashboardData {
  rows: ClientRow[];
  totals: Record<string, number>;
  careerAssociates: string[];
}

const colors = {
  ink: '#1A1A2E',
  page: '#FFF5EB',
  coral: '#E88474',
  green: '#9AC89A',
  blue: '#B8D4E8',
  yellow: '#F4D66B',
};

const asRecord = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const number = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const first = (row: RecordValue, keys: string[]): unknown => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
};

const arrayValue = (row: RecordValue, keys: string[]): unknown[] => {
  const value = first(row, keys);
  return Array.isArray(value) ? value : [];
};

function getTodayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}

function getAuthHeaders(): HeadersInit {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('applywizz_auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function applicationItem(value: unknown, index: number): ApplicationItem {
  const row = asRecord(value);
  return {
    id: text(first(row, ['id', 'applicationId']), `application-${index}`),
    jobUrl: text(first(row, ['jobUrl', 'job_url', 'url']), 'Job URL unavailable'),
    failureReason: text(first(row, ['failureReason', 'failure_reason', 'errorMessage', 'error_message'])) || undefined,
    webProofUrl: text(first(row, ['webProofUrl', 'proofWebUrl', 'proof_web_url'])) || undefined,
    emailProofUrl: text(first(row, ['emailProofUrl', 'proofEmailUrl', 'proof_email_url'])) || undefined,
  };
}

function normalize(payload: unknown): DashboardData {
  const root = asRecord(payload);
  const source = asRecord(root.data);
  const response = Object.keys(source).length ? source : root;
  const rawRows = arrayValue(response, ['clients', 'clientRows', 'rows']);
  const rawApplications = arrayValue(response, ['applications']);
  const grouped = new Map<string, ClientRow>();

  const ensure = (name: string): ClientRow => {
    const existing = grouped.get(name);
    if (existing) return existing;
    const row: ClientRow = {
      client: name,
      applications: 0,
      completed: 0,
      pending: 0,
      failed: 0,
      waitingForEmail: 0,
      assignedTo: '—',
      completedItems: [],
      pendingItems: [],
      failedItems: [],
    };
    grouped.set(name, row);
    return row;
  };

  rawRows.forEach((value, index) => {
    const raw = asRecord(value);
    const name = text(first(raw, ['client', 'clientName', 'client_name', 'name']), `Client ${index + 1}`);
    const row = ensure(name);
    row.applications = number(first(raw, ['applications', 'totalApplications', 'application_count']));
    row.completed = number(first(raw, ['completed', 'applied', 'successfulApplications']));
    row.pending = number(first(raw, ['pending', 'queued']));
    row.failed = number(first(raw, ['failed', 'failedApplications']));
    row.waitingForEmail = number(first(raw, ['waitingForEmail', 'waiting_for_email', 'otpRequired', 'emailProofPending']));
    row.assignedTo = text(first(raw, ['assignedTo', 'assigned_to', 'assignedCaEmail', 'assigned_ca_email']), '—');
    row.completedItems = arrayValue(raw, ['completedApplications', 'completedItems', 'appliedApplications']).map(applicationItem);
    row.pendingItems = arrayValue(raw, ['pendingApplications', 'pendingItems']).map(applicationItem);
    row.failedItems = arrayValue(raw, ['failedApplications', 'failedItems']).map(applicationItem);
  });

  rawApplications.forEach((value, index) => {
    const raw = asRecord(value);
    const name = text(first(raw, ['client', 'clientName', 'client_name', 'applywizzId', 'applywizz_id']), `Client ${index + 1}`);
    const row = ensure(name);
    const status = text(raw.status).toUpperCase();
    const item = applicationItem(raw, index);
    if (status === 'APPLIED' || status === 'COMPLETED') row.completedItems.push(item);
    else if (status === 'FAILED' || status === 'CAPTCHA_TIMEOUT') row.failedItems.push(item);
    else row.pendingItems.push(item);
    row.applications += 1;
    row.completed = row.completedItems.length;
    row.failed = row.failedItems.length;
    row.pending = row.pendingItems.length;
    if (status === 'OTP_REQUIRED' || status === 'EMAIL_PROOF_PENDING') row.waitingForEmail += 1;
    row.assignedTo = text(first(raw, ['assignedTo', 'assigned_to', 'assignedCaEmail', 'assigned_ca_email']), row.assignedTo);
  });

  const totalsRaw = asRecord(first(response, ['totals', 'metrics', 'summary']));
  const rows = Array.from(grouped.values());
  const totals = {
    applications: number(first(totalsRaw, ['applications', 'totalApplications'])) || rows.reduce((sum, row) => sum + row.applications, 0),
    applied: number(first(totalsRaw, ['applied', 'completed', 'successfulApplications'])) || rows.reduce((sum, row) => sum + row.completed, 0),
    failed: number(first(totalsRaw, ['failed', 'failedApplications'])) || rows.reduce((sum, row) => sum + row.failed, 0),
    pending: number(first(totalsRaw, ['pending', 'queued'])) || rows.reduce((sum, row) => sum + row.pending, 0),
    waitingForEmail: number(first(totalsRaw, ['waitingForEmail', 'waiting_for_email', 'otpRequired', 'emailProofPending'])) || rows.reduce((sum, row) => sum + row.waitingForEmail, 0),
  };
  const listedCareerAssociates = arrayValue(response, ['assignedTo', 'assigned_to', 'careerAssociates', 'career_associates']).map((value) =>
    typeof value === 'string' ? value : text(first(asRecord(value), ['assignedTo', 'assigned_to', 'name']))
  ).filter(Boolean);
  return {
    rows,
    totals,
    careerAssociates: Array.from(new Set([...listedCareerAssociates, ...rows.map((row) => row.assignedTo).filter((value) => value !== '—')])),
  };
}

function DetailList({ items, mode }: { items: ApplicationItem[]; mode: 'completed' | 'pending' | 'failed' }): React.ReactElement {
  return (
    <div className="bg-[#FFF5EB] border-t-2 border-[#1A1A2E] px-4 py-3">
      <div className="space-y-2">
        {items.length === 0 ? <p className="text-xs text-[#64748B]">No application details returned for this client.</p> : items.map((item) => (
          <div key={item.id} className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between text-xs">
            <a href={item.jobUrl} target="_blank" rel="noopener noreferrer" className="font-bold text-[#1E3A5F] underline break-all">{item.jobUrl}</a>
            {mode === 'completed' && (
              <span className="flex gap-3 shrink-0">
                {item.webProofUrl ? <a href={item.webProofUrl} target="_blank" rel="noopener noreferrer" className="text-[#1E4620] underline font-bold">Web proof screenshot</a> : <span className="text-[#64748B]">Web proof unavailable</span>}
                {item.emailProofUrl ? <a href={item.emailProofUrl} target="_blank" rel="noopener noreferrer" className="text-[#1E4620] underline font-bold">Email screenshot</a> : <span className="text-[#64748B]">Email proof unavailable</span>}
              </span>
            )}
            {mode === 'failed' && <span className="text-[#991B1B] md:max-w-sm">{item.failureReason || 'Failure reason unavailable'}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export const ManagerDashboard: React.FC<ManagerDashboardProps> = ({ apiBaseUrl = '' }) => {
  const [user, setUser] = useState<AuthUser | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = localStorage.getItem('applywizz_auth_user');
      return saved ? JSON.parse(saved) as AuthUser : null;
    } catch {
      return null;
    }
  });
  const [date, setDate] = useState(getTodayIST);
  const [careerAssociate, setCareerAssociate] = useState('all');
  const [dashboard, setDashboard] = useState<DashboardData>({ rows: [], totals: { applications: 0, applied: 0, failed: 0, pending: 0, waitingForEmail: 0 }, careerAssociates: [] });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ date, ca: careerAssociate });
      const response = await fetch(`${apiBaseUrl}/api/manager/dashboard?${params}`, { headers: getAuthHeaders() });
      const payload: unknown = await response.json();
      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('applywizz_auth_token');
        localStorage.removeItem('applywizz_auth_user');
        setUser(null);
        return;
      }
      if (!response.ok) throw new Error(text(asRecord(payload).error, 'Unable to load manager dashboard.'));
      setDashboard(normalize(payload));
      setExpanded(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load manager dashboard.');
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, careerAssociate, date, user]);

  useEffect(() => { void load(); }, [load]);

  const visibleRows = useMemo(() => careerAssociate === 'all' ? dashboard.rows : dashboard.rows.filter((row) => row.assignedTo === careerAssociate), [careerAssociate, dashboard.rows]);
  const toggle = (clientName: string, status: 'completed' | 'pending' | 'failed') => setExpanded(expanded === `${clientName}:${status}` ? null : `${clientName}:${status}`);
  const signOut = () => {
    localStorage.removeItem('applywizz_auth_token');
    localStorage.removeItem('applywizz_auth_user');
    setUser(null);
  };

  if (!user) return <AuthView onAuthSuccess={setUser} apiBaseUrl={apiBaseUrl} />;

  const stats = [
    ['Total Applications', dashboard.totals.applications, colors.blue],
    ['Applied', dashboard.totals.applied, colors.green],
    ['Failed', dashboard.totals.failed, colors.coral],
    ['Pending', dashboard.totals.pending, colors.yellow],
    ['Waiting for Email', dashboard.totals.waitingForEmail, '#D8C4E8'],
  ];

  return (
    <main className="min-h-screen bg-[#FFF5EB] text-[#1A1A2E] p-4 md:p-8 font-sans">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col gap-4 md:flex-row md:justify-between md:items-end mb-7">
          <div><p className="text-xs font-mono font-bold uppercase tracking-[0.2em] text-[#64748B]">ApplyWizz / Control room</p><h1 className="text-3xl md:text-4xl font-black">Manager dashboard</h1></div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-bold uppercase tracking-wider">Filter by Career Associate<select value={careerAssociate} onChange={(event) => setCareerAssociate(event.target.value)} className="block mt-1 min-w-48 bg-white border-2 border-[#1A1A2E] rounded px-2.5 py-2 text-sm shadow-[2px_2px_0px_#1A1A2E]"><option value="all">All</option>{dashboard.careerAssociates.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            <label className="text-xs font-bold uppercase tracking-wider">Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="block mt-1 bg-white border-2 border-[#1A1A2E] rounded px-2.5 py-2 text-sm font-mono shadow-[2px_2px_0px_#1A1A2E]" /></label>
            <button type="button" onClick={() => void load()} className="bg-[#E88474] border-2 border-[#1A1A2E] rounded px-3 py-2 text-xs font-bold shadow-[2px_2px_0px_#1A1A2E]">Refresh</button>
            <button type="button" onClick={signOut} className="bg-white border-2 border-[#1A1A2E] rounded px-3 py-2 text-xs font-bold shadow-[2px_2px_0px_#1A1A2E]">Sign out</button>
          </div>
        </header>
        {error && <div role="alert" className="mb-5 bg-[#FECACA] border-2 border-[#991B1B] rounded p-3 text-sm font-bold text-[#7F1D1D]">{error}</div>}
        {loading && <div className="mb-5 bg-[#F4D66B] border-2 border-[#1A1A2E] rounded p-3 text-xs font-mono font-bold">Loading dashboard…</div>}

        <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          {stats.map(([label, value, background]) => <div key={String(label)} style={{ backgroundColor: String(background) }} className="border-2 border-[#1A1A2E] rounded-lg p-4 shadow-[3px_3px_0px_#1A1A2E]"><p className="text-xs font-bold uppercase tracking-wider">{label}</p><p className="text-3xl font-black mt-2">{String(value)}</p></div>)}
        </section>

        <section className="bg-white border-2 border-[#1A1A2E] rounded-lg shadow-[3px_3px_0px_#1A1A2E] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]"><tr>{['Client', '# Applications', 'Completed', 'Pending', 'Failed', 'Assigned To'].map((heading) => <th key={heading} className="p-4 font-black uppercase tracking-wider">{heading}</th>)}</tr></thead>
              <tbody>
                {visibleRows.map((row) => {
                  const expansion = expanded?.startsWith(`${row.client}:`) ? expanded.split(':')[1] as 'completed' | 'pending' | 'failed' : null;
                  return <React.Fragment key={row.client}>
                    <tr className="border-b border-[#1A1A2E]/20 hover:bg-[#FFFDF9]">
                      <td className="p-4 font-black">{row.client}</td><td className="p-4 font-mono">{row.applications}</td>
                      {(['completed', 'pending', 'failed'] as const).map((status) => <td key={status} className="p-4"><button type="button" onClick={() => toggle(row.client, status)} className="font-black underline decoration-2 underline-offset-2">{row[status]}</button></td>)}
                      <td className="p-4 text-[#64748B]">{row.assignedTo}</td>
                    </tr>
                    {expansion && <tr><td colSpan={6}><DetailList items={row[`${expansion}Items`]} mode={expansion} /></td></tr>}
                  </React.Fragment>;
                })}
              </tbody>
            </table>
          </div>
          {!visibleRows.length && <p className="p-8 text-center text-sm text-[#64748B]">No client applications found for this filter.</p>}
        </section>
      </div>
    </main>
  );
};

export default ManagerDashboard;
