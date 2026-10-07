import React, { useState, useEffect, useCallback } from 'react';
import { useRequireRole, getTodayIST, apiFetch } from '../hooks/useSession.js';
import { DevSwitcher } from './DevSwitcher.js';
import { HeaderSignOut } from './HeaderSignOut.js';

interface DevHealthProbe {
  name: string;
  status: string;
  detail?: string;
  responseMs?: number;
}

interface DevHealthSnapshot {
  totalApplications?: number | null;
  submitted?: number | null;
  submittedCount?: number | null;
  dateRange?: { label?: string };
  submittedMonth?: number;
  completedMonth?: number;
  submittedToday?: number;
  completedToday?: number;
  applied?: number | null;
  failed?: number | null;
  statsAvailable?: boolean;
  statsPartial?: boolean;
  statsAvailableFrom?: string;
  queued?: number;
  probes?: DevHealthProbe[];
  queue: {
    queued: number;
    applying: number;
    stuck: number;
    applied: number;
  };
  workers: {
    running: boolean;
    inFlightCount: number;
    idleCount: number;
  };
  ingest?: {
    running?: boolean;
    error?: string;
    message?: string;
  };
}

interface DevRunItem {
  id: string;
  jobUrl: string;
  jobTitle?: string;
  companyName?: string;
  operator?: string;
  status: string;
  durationMs?: number;
  updatedAt?: string;
}

interface DevErrorItem {
  errorType: string;
  message: string;
  count: number;
  first: string;
  last: string;
  applicationIds?: string[];
}

interface DevQueueData {
  queue: {
    queued: number;
    applying: number;
    stuck: number;
  };
  workers: {
    running: boolean;
    idleCount: number;
    laneLengths?: Record<string, number>;
  };
  running?: Array<{ id: string; applywizzId: string; status: string }>;
  pending?: Array<{ id: string; applywizzId: string; status: string }>;
}

interface DevIntegrationProbe {
  name: string;
  status: string;
  detail?: string;
  responseMs?: number;
  lastError?: string;
}

interface DevDebugApplication {
  id: string;
  status: string;
  applywizz_id: string;
  operatorName?: string;
  assigned_ca_email?: string;
  manager_email?: string;
  managerEmail?: string;
  job_url: string;
  job_title?: string;
  company_name?: string;
  error_message?: string;
  proof_web_url?: string;
  proof_failed_url?: string;
  proof_email_url?: string;
  proof_email_json?: Record<string, unknown>;
}

interface DevDebugTimelineRow {
  previous_status: string | null;
  new_status: string;
  actor_email: string | null;
  created_at: string;
}

interface DevDebugTimelineEvent {
  id: string;
  from_status?: string;
  to_status: string;
  actor_email?: string | null;
  created_at: string;
}

interface DevDebugPayload {
  application?: DevDebugApplication;
  timeline?: DevDebugTimelineRow[];
  events?: DevDebugTimelineEvent[];
  warning?: string;
}

function formatIst(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return `${new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} IST`;
  } catch {
    return iso;
  }
}

function lightClass(status?: string): string {
  if (status === 'ok') return 'bg-[#30d158]/15 border-[#30d158]/40 text-[#30d158]';
  if (status === 'degraded') return 'bg-[#ff9f0a]/15 border-[#ff9f0a]/40 text-[#ff9f0a]';
  if (status === 'not_configured') return 'bg-[#2c2c2e] border-[#3a3a3c] text-[#8e8e93]';
  return 'bg-[#ff453a]/15 border-[#ff453a]/40 text-[#ff453a]';
}

export const DevDashboard: React.FC = () => {
  const { token, loading: authLoading, isAuthorized, signOut } = useRequireRole(['dev']);

  const [tab, setTab] = useState<'system' | 'runs' | 'errors' | 'queue' | 'integrations' | 'debugger' | 'guide'>('system');
  const [date, setDate] = useState<string>(getTodayIST);
  const [statsRange, setStatsRange] = useState<'day' | 'week' | 'month'>('day');
  const [health, setHealth] = useState<DevHealthSnapshot | null>(null);
  const [runs, setRuns] = useState<DevRunItem[]>([]);
  const [runStatus, setRunStatus] = useState<string>('');
  const [errors, setErrors] = useState<DevErrorItem[]>([]);
  const [queue, setQueue] = useState<DevQueueData | null>(null);
  const [integrations, setIntegrations] = useState<DevIntegrationProbe[]>([]);
  const [debugId, setDebugId] = useState<string>('');
  const [debug, setDebug] = useState<DevDebugPayload | null>(null);
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
      if (tab === 'system') {
        const healthPayload = await loadJson<DevHealthSnapshot>(`/api/dev/health?range=${statsRange}`);
        setHealth(healthPayload);
      }
      if (tab === 'runs') {
        const params = new URLSearchParams({ date, limit: '100' });
        if (runStatus) params.set('status', runStatus);
        const payload = await loadJson<{ runs?: DevRunItem[] }>(`/api/dev/runs?${params}`);
        setRuns(payload.runs || []);
      }
      if (tab === 'errors') {
        const payload = await loadJson<{ errors?: DevErrorItem[] }>(`/api/dev/errors?date=${encodeURIComponent(date)}`);
        setErrors(payload.errors || []);
      }
      if (tab === 'queue') {
        const payload = await loadJson<DevQueueData>('/api/dev/queue');
        setQueue(payload);
      }
      if (tab === 'integrations') {
        const payload = await loadJson<{ integrations?: DevIntegrationProbe[] }>('/api/dev/integrations');
        setIntegrations(payload.integrations || []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [tab, date, statsRange, token, isAuthorized, runStatus, loadJson]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  const openDebugger = async (id?: string) => {
    const target = (id || debugId).trim();
    if (!target) return;
    setTab('debugger');
    setDebugId(target);
    setLoading(true);
    try {
      const payload = await loadJson<DevDebugPayload>(`/api/dev/applications/${encodeURIComponent(target)}`);
      setDebug(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Debugger load failed');
      setDebug(null);
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) {
    return <main className="min-h-screen p-8 text-xs font-mono font-bold bg-[#0a0a0a] text-[#8e8e93]">Checking access…</main>;
  }

  if (!token || !isAuthorized) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-[#0a0a0a] text-white">
        <div className="max-w-md bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-6 shadow-2xl">
          <h1 className="text-xl font-bold mb-2 text-white">Developer dashboard</h1>
          <p className="text-sm text-[#8e8e93] mb-4">You do not have developer access or need to sign in.</p>
          <a href="/" className="inline-block bg-[#0a84ff] text-white px-4 py-2 text-sm font-semibold rounded-lg hover:bg-[#0a84ff]/90 transition-colors">Sign in</a>
        </div>
      </main>
    );
  }

  const tabs: Array<'system' | 'runs' | 'errors' | 'queue' | 'integrations' | 'debugger' | 'guide'> =
    ['system', 'runs', 'errors', 'queue', 'integrations', 'debugger', 'guide'];
  const app = debug?.application;
  const timeline = (debug?.timeline && debug.timeline.length > 0)
    ? debug.timeline
    : (debug?.events || []).map((e) => ({
        previous_status: e.from_status ?? null,
        new_status: e.to_status,
        actor_email: e.actor_email ?? null,
        created_at: e.created_at,
      }));

  return (
    <main className="min-h-screen p-4 md:p-8 font-sans bg-[#0a0a0a] text-white">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col gap-4 md:flex-row md:justify-between md:items-end mb-6 pb-6 border-b border-[#2c2c2e]">
          <div className="flex items-center gap-3">
            <img src="/logo.webp" alt="ApplyWizz" className="w-10 h-10 rounded-xl border border-[#2c2c2e] object-cover bg-black" />
            <div>
              <p className="text-xs font-mono font-medium uppercase tracking-widest text-[#8e8e93]">ApplyWizz / Internals</p>
              <h1 className="text-3xl font-bold tracking-tight text-white">Developer dashboard</h1>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <DevSwitcher current="/dev" />
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
            <button key={id} type="button" onClick={() => setTab(id)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg border capitalize transition-colors ${tab === id ? 'bg-white text-black font-bold border-white' : 'bg-[#1c1c1e] text-[#8e8e93] border-[#2c2c2e] hover:text-white hover:bg-[#2c2c2e]'}`}>{id}</button>
          ))}
        </nav>
        {error && <div className="mb-4 bg-[#ff453a]/15 border border-[#ff453a]/40 rounded-xl p-3 text-sm font-bold text-[#ff453a]">{error}</div>}
        {tab === 'system' && health?.statsAvailable === false && <div className="mb-4 bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-xl p-3 text-xs font-semibold text-[#ff9f0a]">Application statistics before {health.statsAvailableFrom || 'the cutover date'} are unavailable.</div>}
        {tab === 'system' && health?.statsAvailable !== false && health?.statsPartial && <div className="mb-4 bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-xl p-3 text-xs font-semibold text-[#ff9f0a]">Partial statistics: dates before {health.statsAvailableFrom} are excluded.</div>}
        {loading && <p className="text-xs font-mono font-medium text-[#8e8e93] mb-4">Loading…</p>}

        {tab === 'system' && health && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-1">
              <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Total Applications</p>
                <p className="text-2xl font-black text-white mt-1">{health.statsAvailable === false ? '—' : health.totalApplications ?? 0}</p>
              </div>
              <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 col-span-2 md:col-span-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Submitted</p>
                <p className="text-2xl font-black text-white mt-1">{health.statsAvailable === false ? '—' : health.submitted ?? health.submittedCount ?? 0}</p>
                <p className="text-[10px] font-mono text-[#8e8e93] mt-1">{date}</p>
              </div>
              <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 col-span-2 md:col-span-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Selected period</p>
                <p className="text-2xl font-black text-white mt-1">{health.dateRange?.label || 'Today'}</p>
                <p className="text-[10px] font-mono text-[#8e8e93] mt-1">{date}</p>
              </div>
              <div className="bg-[#1c1c1e] border border-[#30d158]/30 rounded-xl p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#30d158]">Applied</p>
                <p className="text-2xl font-black text-[#30d158] mt-1">{health.statsAvailable === false ? '—' : health.applied ?? 0}</p>
              </div>
              <div className="bg-[#1c1c1e] border border-[#ff453a]/30 rounded-xl p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#ff453a]">Failed</p>
                <p className="text-2xl font-black text-[#ff453a] mt-1">{health.statsAvailable === false ? '—' : health.failed ?? 0}</p>
              </div>
              <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Queued</p>
                <p className="text-2xl font-black text-white mt-1">{health.queued ?? 0}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(health.probes || []).map((probe) => (
                <div key={probe.name} className={`border rounded-xl p-4 ${lightClass(probe.status)}`}>
                  <p className="text-xs font-semibold uppercase tracking-wider">{probe.name}</p>
                  <p className="text-lg font-black uppercase mt-1">{probe.status}</p>
                  <p className="text-[11px] mt-1 break-words opacity-90">{probe.detail}</p>
                  {probe.responseMs != null && <p className="text-[10px] font-mono mt-1 opacity-80">{probe.responseMs}ms</p>}
                </div>
              ))}
            </div>
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 text-xs text-[#8e8e93] space-y-1">
              <p className="font-bold uppercase tracking-wider text-white text-xs mb-1">Live operational health</p>
              <p>Queued <span className="font-semibold text-white">{health.queue.queued}</span> · Applying <span className="font-semibold text-white">{health.queue.applying}</span> · Stuck <span className="font-semibold text-white">{health.queue.stuck}</span> · Applied <span className="font-semibold text-white">{health.queue.applied}</span></p>
              <p>Workers running: <span className="font-semibold text-white">{String(health.workers.running)}</span> · in flight <span className="font-semibold text-white">{health.workers.inFlightCount}</span> · idle <span className="font-semibold text-white">{health.workers.idleCount}</span></p>
              <p>Ingest: <span className="font-semibold text-white">{health.ingest?.running ? 'running' : health.ingest?.error || health.ingest?.message || 'idle'}</span></p>
            </div>
          </div>
        )}

        {tab === 'runs' && (
          <div className="space-y-3">
            <input value={runStatus} onChange={(e) => setRunStatus(e.target.value)} placeholder="Status filter" className="border border-[#3a3a3c] bg-[#2c2c2e] text-white placeholder-[#8e8e93] rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#0a84ff]" />
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead className="bg-[#2c2c2e]/60 border-b border-[#2c2c2e] text-[#8e8e93]">
                  <tr>{['ID', 'Job', 'Company', 'Operator', 'Status', 'Duration', 'Updated'].map((h) => <th key={h} className="p-3 font-semibold uppercase tracking-wider">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-[#2c2c2e]/50">
                  {runs.map((row) => (
                    <tr key={row.id} className="hover:bg-[#2c2c2e]/30 transition-colors">
                      <td className="p-3"><button type="button" className="font-mono underline text-[#0a84ff] hover:text-[#5ac8fa]" onClick={() => void openDebugger(row.id)}>{row.id?.slice(0, 8)}</button></td>
                      <td className="p-3"><a className="underline text-[#0a84ff] hover:text-[#5ac8fa] break-all font-medium" href={row.jobUrl} target="_blank" rel="noopener noreferrer">{row.jobTitle || row.jobUrl}</a></td>
                      <td className="p-3 text-white">{row.companyName || '—'}</td>
                      <td className="p-3 font-mono text-[#8e8e93]">{row.operator || '—'}</td>
                      <td className="p-3 font-bold text-white">{row.status}</td>
                      <td className="p-3 font-mono text-[#8e8e93]">{row.durationMs != null ? `${Math.round(row.durationMs / 1000)}s` : '—'}</td>
                      <td className="p-3 font-mono text-[#8e8e93]">{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'errors' && (
          <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-x-auto">
            <table className="w-full min-w-[800px] text-left text-xs">
              <thead className="bg-[#2c2c2e]/60 border-b border-[#2c2c2e] text-[#8e8e93]">
                <tr>{['Type', 'Message', 'Count', 'First', 'Last', 'Apps'].map((h) => <th key={h} className="p-3 font-semibold uppercase tracking-wider">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-[#2c2c2e]/50">
                {errors.map((row, i) => (
                  <tr key={i} className="hover:bg-[#2c2c2e]/30 transition-colors align-top">
                    <td className="p-3 font-bold text-[#ff453a]">{row.errorType}</td>
                    <td className="p-3 max-w-md break-words text-white">{row.message}</td>
                    <td className="p-3 font-mono text-white">{row.count}</td>
                    <td className="p-3 font-mono text-[#8e8e93]">{new Date(row.first).toLocaleString()}</td>
                    <td className="p-3 font-mono text-[#8e8e93]">{new Date(row.last).toLocaleString()}</td>
                    <td className="p-3 font-mono">{(row.applicationIds || []).slice(0, 3).map((id) => (
                      <button key={id} type="button" className="underline text-[#0a84ff] hover:text-[#5ac8fa] mr-2" onClick={() => void openDebugger(id)}>{id.slice(0, 8)}</button>
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!errors.length && <p className="p-6 text-center text-[#8e8e93]">No failed applications for this date.</p>}
          </div>
        )}

        {tab === 'queue' && queue && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['Queued', queue.queue.queued],
                ['Applying', queue.queue.applying],
                ['Stuck', queue.queue.stuck],
                ['In flight', queue.workers.idleCount],
              ].map(([label, val]) => (
                <div key={label} className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">{label}</p>
                  <p className="text-2xl font-black text-white mt-1">{val ?? 0}</p>
                </div>
              ))}
            </div>
            <p className="text-xs font-mono text-[#8e8e93]">Workers running={String(queue.workers.running)} idle={queue.workers.idleCount} lanes={JSON.stringify(queue.workers.laneLengths)}</p>
            <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5 text-xs">
              <p className="font-bold uppercase tracking-wider text-white text-xs mb-2">Running</p>
              {(queue.running || []).map((row) => <p key={row.id} className="font-mono text-[#8e8e93] py-0.5"><span className="text-white font-semibold">{row.id}</span> · {row.applywizzId} · <span className="text-[#30d158] font-bold">{row.status}</span></p>)}
              {!(queue.running || []).length && <p className="text-[#8e8e93] italic">No running jobs</p>}
              <p className="font-bold uppercase tracking-wider text-white text-xs mt-4 mb-2">Pending</p>
              {(queue.pending || []).map((row) => <p key={row.id} className="font-mono text-[#8e8e93] py-0.5"><span className="text-white font-semibold">{row.id}</span> · {row.applywizzId} · {row.status}</p>)}
              {!(queue.pending || []).length && <p className="text-[#8e8e93] italic">No pending jobs</p>}
            </div>
          </div>
        )}

        {tab === 'integrations' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {integrations.map((probe) => (
              <div key={probe.name} className={`border rounded-xl p-4 ${lightClass(probe.status)}`}>
                <p className="text-xs font-semibold uppercase tracking-wider">{probe.name}</p>
                <p className="text-lg font-black uppercase mt-1">{probe.status}</p>
                <p className="text-xs mt-2 break-words opacity-90">{probe.detail}</p>
                {probe.responseMs != null && <p className="text-[10px] font-mono mt-1 opacity-80">{probe.responseMs}ms</p>}
                {probe.lastError && <p className="text-[11px] mt-1 text-[#ff453a] font-mono">{probe.lastError}</p>}
              </div>
            ))}
          </div>
        )}

        {tab === 'debugger' && (
          <div className="space-y-4">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void openDebugger(debugId); }}>
              <input value={debugId} onChange={(e) => setDebugId(e.target.value)} placeholder="Application ID" className="border border-[#3a3a3c] bg-[#2c2c2e] text-white placeholder-[#8e8e93] rounded-lg px-3 py-1.5 text-sm font-mono flex-1 focus:outline-none focus:border-[#0a84ff]" />
              <button type="submit" className="bg-[#0a84ff] text-white px-4 py-1.5 text-xs font-bold rounded-lg hover:bg-[#0a84ff]/90 transition-colors">Open</button>
            </form>
            {app && (
              <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5 text-xs space-y-2 text-[#8e8e93]">
                <p><span className="font-bold text-white uppercase tracking-wider text-[10px]">ID</span> <span className="font-mono text-white ml-2">{app.id}</span></p>
                <p><span className="font-bold text-white uppercase tracking-wider text-[10px]">Status</span> <span className="font-semibold text-white ml-2">{app.status}</span></p>
                <p><span className="font-bold text-white uppercase tracking-wider text-[10px]">Client</span> <span className="text-white ml-2">{app.applywizz_id}</span></p>
                <p><span className="font-bold text-white uppercase tracking-wider text-[10px]">Operator</span> <span className="text-white ml-2">{app.operatorName || app.assigned_ca_email || '—'}</span></p>
                <p><span className="font-bold text-white uppercase tracking-wider text-[10px]">Manager</span> <span className="text-white ml-2">{app.manager_email || app.managerEmail || '—'}</span></p>
                <p><span className="font-bold text-white uppercase tracking-wider text-[10px]">Job</span> <a className="underline text-[#0a84ff] hover:text-[#5ac8fa] break-all ml-2" href={app.job_url} target="_blank" rel="noopener noreferrer">{app.job_title || app.job_url}</a></p>
                <p><span className="font-bold text-white uppercase tracking-wider text-[10px]">Company</span> <span className="text-white ml-2">{app.company_name || '—'}</span></p>
                {app.error_message && <p className="text-[#ff453a]"><span className="font-bold uppercase tracking-wider text-[10px]">Error</span> <span className="ml-2 font-mono">{app.error_message}</span></p>}
                <p className="pt-2">
                  {app.proof_web_url ? <a className="underline font-bold text-[#5ac8fa] mr-3" href={app.proof_web_url} target="_blank" rel="noopener noreferrer">Web proof</a> : <span className="text-[#8e8e93] mr-3">Web proof unavailable</span>}
                  {app.proof_email_url ? <a className="underline font-bold text-[#0a84ff] mr-3" href={app.proof_email_url} target="_blank" rel="noopener noreferrer">Email screenshot</a> : <span className="text-[#8e8e93] mr-3">Email screenshot unavailable</span>}
                  {app.proof_failed_url && (
                    <span>Failed screenshot: <a className="underline font-bold text-[#ff453a] ml-1" href={app.proof_failed_url} target="_blank" rel="noopener noreferrer">View</a></span>
                  )}
                </p>
                {app.proof_email_json && (
                  <pre className="bg-[#141416] border border-[#2c2c2e] p-3 rounded-lg overflow-auto max-h-48 whitespace-pre-wrap font-mono text-[#8e8e93]">{JSON.stringify(app.proof_email_json, null, 2)}</pre>
                )}
                <h3 className="font-bold uppercase tracking-wider text-white text-xs pt-3">Timeline</h3>
                {timeline.length === 0 && <p className="text-[#8e8e93]">{debug?.warning || 'No status changes recorded for this application yet.'}</p>}
                {timeline.map((row, idx) => (
                  <p key={idx} className="font-mono text-[#8e8e93] text-[11px]">{formatIst(row.created_at)} — <span className="text-white">{row.previous_status || '—'}</span> → <span className="text-[#30d158] font-bold">{row.new_status}</span> (by {row.actor_email || 'system'})</p>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'guide' && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-white">Developer Guide</h2>
              <p className="text-xs text-[#8e8e93] font-mono mt-0.5">Internals, debugging, and cross-role dashboard access.</p>
            </div>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-2">Access</h3>
              <p className="text-sm text-[#8e8e93] leading-relaxed">
                Use the header switcher to open <span className="font-semibold text-white">Dev</span>, <span className="font-semibold text-white">Admin</span>, <span className="font-semibold text-white">Manager</span>, or <span className="font-semibold text-white">Operator</span> UIs. Dev role bypasses manager/operator API scoping when using those dashboards.
              </p>
            </section>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-3">Tabs</h3>
              <ul className="space-y-2 text-sm text-[#8e8e93] leading-relaxed list-disc list-inside">
                <li><span className="font-semibold text-white">System</span> — health probes, queue and worker summary, ingest line.</li>
                <li><span className="font-semibold text-white">Runs</span> — applications for the header date; optional status filter; click ID to open Debugger.</li>
                <li><span className="font-semibold text-white">Errors</span> — grouped failures for the date; click app IDs to debug.</li>
                <li><span className="font-semibold text-white">Queue</span> — live queued/applying/stuck counts and running/pending ID lists.</li>
                <li><span className="font-semibold text-white">Integrations</span> — per-integration probe detail and last errors.</li>
                <li><span className="font-semibold text-white">Debugger</span> — paste an application UUID for status, proofs, raw error, and timeline.</li>
              </ul>
            </section>

            <section className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-3">Tips</h3>
              <ul className="space-y-2 text-sm text-[#8e8e93] leading-relaxed list-disc list-inside">
                <li>Prefer Debugger over operator-facing messages when triaging production issues.</li>
                <li>Date affects Runs and Errors; Queue and Integrations are live snapshots.</li>
                <li>CSV ingest Start/Stop lives on the Admin dashboard, not here.</li>
                <li>Reproduce submit/dry-run flows on the Operator dashboard at <span className="font-mono text-white">/</span>.</li>
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

export default DevDashboard;
