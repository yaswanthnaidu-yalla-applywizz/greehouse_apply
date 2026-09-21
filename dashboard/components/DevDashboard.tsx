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

interface DevSubmissionGate {
  enabled: boolean;
  criteria?: {
    minScore: number;
    maxScore: number;
    maxFieldCountExclusive: number;
  };
}

interface DevHealthSnapshot {
  submittedMonth?: number;
  completedMonth?: number;
  submittedToday?: number;
  completedToday?: number;
  applied?: number;
  failed?: number;
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
  submissionGate?: DevSubmissionGate;
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
  managerEmail?: string;
  job_url: string;
  job_title?: string;
  company_name?: string;
  error_message?: string;
  proof_web_url?: string;
  proof_email_url?: string;
  proof_email_json?: Record<string, unknown>;
}

interface DevDebugTimelineEvent {
  id: string;
  from_status?: string;
  to_status: string;
  created_at: string;
}

interface DevDebugPayload {
  application?: DevDebugApplication;
  events?: DevDebugTimelineEvent[];
  warning?: string;
}

function lightClass(status?: string): string {
  if (status === 'ok') return 'bg-[#9AC89A]';
  if (status === 'degraded') return 'bg-[#F4D66B]';
  if (status === 'not_configured') return 'bg-[#E2E8F0]';
  return 'bg-[#FECACA]';
}

export const DevDashboard: React.FC = () => {
  const { token, loading: authLoading, isAuthorized, signOut } = useRequireRole(['dev']);

  const [tab, setTab] = useState<'system' | 'runs' | 'errors' | 'queue' | 'integrations' | 'debugger' | 'guide'>('system');
  const [date, setDate] = useState<string>(getTodayIST);
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
  const [submissionGate, setSubmissionGate] = useState<DevSubmissionGate | null>(null);
  const [gateSaving, setGateSaving] = useState<boolean>(false);

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
        const healthPayload = await loadJson<DevHealthSnapshot>(`/api/dev/health?date=${encodeURIComponent(date)}`);
        setHealth(healthPayload);
        setSubmissionGate(healthPayload.submissionGate || null);
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
  }, [tab, date, token, isAuthorized, runStatus, loadJson]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  const setSubmissionGateEnabled = async (enabled: boolean) => {
    setGateSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/dev/submission-gate', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const payload: unknown = await res.json();
      if (!res.ok) {
        const err = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : 'Failed to update submission gate';
        throw new Error(err);
      }
      const data = payload as { enabled: boolean; criteria?: DevSubmissionGate['criteria'] };
      setSubmissionGate({ enabled: data.enabled, criteria: data.criteria });
      if (health) {
        setHealth({ ...health, submissionGate: { enabled: data.enabled, criteria: data.criteria } });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gate update failed');
    } finally {
      setGateSaving(false);
    }
  };

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
    return <main className="min-h-screen p-8 text-xs font-mono font-bold bg-[#FFF5EB] text-[#1A1A2E]">Checking access…</main>;
  }

  if (!token || !isAuthorized) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-[#FFF5EB] text-[#1A1A2E]">
        <div className="max-w-md bg-white border-2 border-[#1A1A2E] rounded-lg p-6 shadow-[4px_4px_0_#1A1A2E]">
          <h1 className="text-xl font-black mb-2">Developer dashboard</h1>
          <a href="/" className="inline-block bg-[#E88474] border-2 border-[#1A1A2E] px-4 py-2 text-sm font-bold rounded">Sign in</a>
        </div>
      </main>
    );
  }

  const tabs: Array<'system' | 'runs' | 'errors' | 'queue' | 'integrations' | 'debugger' | 'guide'> =
    ['system', 'runs', 'errors', 'queue', 'integrations', 'debugger', 'guide'];
  const app = debug?.application;

  return (
    <main className="min-h-screen p-4 md:p-8 font-sans bg-[#FFF5EB] text-[#1A1A2E]">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col gap-4 md:flex-row md:justify-between md:items-end mb-6">
          <div className="flex items-center gap-3">
            <img src="/logo.webp" alt="ApplyWizz" className="w-10 h-10 rounded-lg border-2 border-[#1A1A2E] object-cover bg-black" />
            <div>
              <p className="text-xs font-mono font-bold uppercase tracking-widest text-[#64748B]">ApplyWizz / Internals</p>
              <h1 className="text-3xl font-black">Developer dashboard</h1>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <DevSwitcher current="/dev" />
            <label className="text-xs font-bold uppercase">Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="block mt-1 border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-sm font-mono bg-white" />
            </label>
            <button type="button" onClick={() => void refresh()} className="bg-[#E88474] border-2 border-[#1A1A2E] px-3 py-2 text-xs font-bold rounded">Refresh</button>
            <HeaderSignOut onSignOut={signOut} />
          </div>
        </header>
        <nav className="flex flex-wrap gap-2 mb-6">
          {tabs.map((id) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`px-3 py-1.5 text-xs font-bold border-2 border-[#1A1A2E] rounded capitalize ${tab === id ? 'bg-[#E88474] text-white' : 'bg-white'}`}>{id}</button>
          ))}
        </nav>
        {error && <div className="mb-4 bg-[#FECACA] border-2 border-[#991B1B] rounded p-3 text-sm font-bold">{error}</div>}
        {loading && <p className="text-xs font-mono font-bold mb-4">Loading…</p>}

        {tab === 'system' && health && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-1">
              <div className="bg-white border-2 border-[#1A1A2E] rounded p-4 shadow-[2px_2px_0_#1A1A2E] col-span-2 md:col-span-1">
                <p className="text-xs font-bold uppercase">Submitted This Month</p>
                <p className="text-2xl font-black mt-1">{health.submittedMonth ?? health.completedMonth ?? 0}</p>
                <p className="text-[10px] font-mono text-[#64748B] mt-1">{date}</p>
              </div>
              <div className="bg-[#F4D66B] border-2 border-[#1A1A2E] rounded p-4 shadow-[2px_2px_0_#1A1A2E] col-span-2 md:col-span-1">
                <p className="text-xs font-bold uppercase">Submitted Today</p>
                <p className="text-2xl font-black mt-1">{health.submittedToday ?? health.completedToday ?? 0}</p>
                <p className="text-[10px] font-mono text-[#64748B] mt-1">{date}</p>
              </div>
              <div className="bg-[#D1FAE5] border-2 border-[#1A1A2E] rounded p-4 shadow-[2px_2px_0_#1A1A2E]">
                <p className="text-xs font-bold uppercase">Applied</p>
                <p className="text-2xl font-black mt-1">{health.applied ?? 0}</p>
              </div>
              <div className="bg-[#FEE2E2] border-2 border-[#1A1A2E] rounded p-4 shadow-[2px_2px_0_#1A1A2E]">
                <p className="text-xs font-bold uppercase">Failed</p>
                <p className="text-2xl font-black mt-1">{health.failed ?? 0}</p>
              </div>
              <div className="bg-[#E2F0FB] border-2 border-[#1A1A2E] rounded p-4 shadow-[2px_2px_0_#1A1A2E]">
                <p className="text-xs font-bold uppercase">Queued</p>
                <p className="text-2xl font-black mt-1">{health.queued ?? 0}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(health.probes || []).map((probe) => (
                <div key={probe.name} className={`border-2 border-[#1A1A2E] rounded p-4 ${lightClass(probe.status)}`}>
                  <p className="text-xs font-bold uppercase">{probe.name}</p>
                  <p className="text-lg font-black uppercase">{probe.status}</p>
                  <p className="text-[11px] mt-1 break-words">{probe.detail}</p>
                  {probe.responseMs != null && <p className="text-[10px] font-mono mt-1">{probe.responseMs}ms</p>}
                </div>
              ))}
            </div>
            <div className="bg-white border-2 border-[#1A1A2E] rounded p-4 text-xs space-y-1">
              <p>Queued {health.queue.queued} · Applying {health.queue.applying} · Stuck {health.queue.stuck} · Applied {health.queue.applied}</p>
              <p>Workers running: {String(health.workers.running)} · in flight {health.workers.inFlightCount} · idle {health.workers.idleCount}</p>
              <p>Ingest: {health.ingest?.running ? 'running' : health.ingest?.error || health.ingest?.message || 'idle'}</p>
            </div>
            {submissionGate && (
              <div className="bg-white border-2 border-[#1A1A2E] rounded p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-black uppercase">Submission eligibility gate</p>
                    <p className="text-xs text-[#64748B] mt-1 max-w-xl">
                      When ON, only jobs with CSV score {submissionGate.criteria?.minScore}–{submissionGate.criteria?.maxScore} and fewer than {submissionGate.criteria?.maxFieldCountExclusive} questions can be queued or live-submitted (including operator Submit). Resets to env default on process restart.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={gateSaving}
                    onClick={() => void setSubmissionGateEnabled(!submissionGate.enabled)}
                    className={`px-4 py-2 text-xs font-black border-2 border-[#1A1A2E] rounded shadow-[2px_2px_0px_#1A1A2E] ${submissionGate.enabled ? 'bg-[#9AC89A]' : 'bg-[#FECACA]'}`}
                  >
                    {gateSaving ? 'Saving…' : submissionGate.enabled ? 'Gate ON — click to turn OFF' : 'Gate OFF — click to turn ON'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'runs' && (
          <div className="space-y-3">
            <input value={runStatus} onChange={(e) => setRunStatus(e.target.value)} placeholder="Status filter" className="border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-sm" />
            <div className="bg-white border-2 border-[#1A1A2E] rounded overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]">
                  <tr>{['ID', 'Job', 'Company', 'Operator', 'Status', 'Duration', 'Updated'].map((h) => <th key={h} className="p-3 font-black uppercase">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {runs.map((row) => (
                    <tr key={row.id} className="border-b border-[#1A1A2E]/20">
                      <td className="p-3"><button type="button" className="font-mono underline" onClick={() => void openDebugger(row.id)}>{row.id?.slice(0, 8)}</button></td>
                      <td className="p-3"><a className="underline break-all" href={row.jobUrl} target="_blank" rel="noopener noreferrer">{row.jobTitle || row.jobUrl}</a></td>
                      <td className="p-3">{row.companyName || '—'}</td>
                      <td className="p-3 font-mono">{row.operator || '—'}</td>
                      <td className="p-3 font-bold">{row.status}</td>
                      <td className="p-3 font-mono">{row.durationMs != null ? `${Math.round(row.durationMs / 1000)}s` : '—'}</td>
                      <td className="p-3 font-mono">{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'errors' && (
          <div className="bg-white border-2 border-[#1A1A2E] rounded overflow-x-auto">
            <table className="w-full min-w-[800px] text-left text-xs">
              <thead className="bg-[#FAF4EB] border-b-2 border-[#1A1A2E]">
                <tr>{['Type', 'Message', 'Count', 'First', 'Last', 'Apps'].map((h) => <th key={h} className="p-3 font-black uppercase">{h}</th>)}</tr>
              </thead>
              <tbody>
                {errors.map((row, i) => (
                  <tr key={i} className="border-b border-[#1A1A2E]/20 align-top">
                    <td className="p-3 font-bold">{row.errorType}</td>
                    <td className="p-3 max-w-md break-words">{row.message}</td>
                    <td className="p-3 font-mono">{row.count}</td>
                    <td className="p-3 font-mono">{new Date(row.first).toLocaleString()}</td>
                    <td className="p-3 font-mono">{new Date(row.last).toLocaleString()}</td>
                    <td className="p-3 font-mono">{(row.applicationIds || []).slice(0, 3).map((id) => (
                      <button key={id} type="button" className="underline mr-2" onClick={() => void openDebugger(id)}>{id.slice(0, 8)}</button>
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!errors.length && <p className="p-6 text-center text-[#64748B]">No failed applications for this date.</p>}
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
                <div key={label} className="bg-white border-2 border-[#1A1A2E] rounded p-4">
                  <p className="text-xs font-bold uppercase">{label}</p>
                  <p className="text-2xl font-black">{val ?? 0}</p>
                </div>
              ))}
            </div>
            <p className="text-xs font-mono">Workers running={String(queue.workers.running)} idle={queue.workers.idleCount} lanes={JSON.stringify(queue.workers.laneLengths)}</p>
            <div className="bg-white border-2 border-[#1A1A2E] rounded p-4 text-xs">
              <p className="font-black uppercase mb-2">Running</p>
              {(queue.running || []).map((row) => <p key={row.id} className="font-mono">{row.id} · {row.applywizzId} · {row.status}</p>)}
              <p className="font-black uppercase mt-4 mb-2">Pending</p>
              {(queue.pending || []).map((row) => <p key={row.id} className="font-mono">{row.id} · {row.applywizzId} · {row.status}</p>)}
            </div>
          </div>
        )}

        {tab === 'integrations' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {integrations.map((probe) => (
              <div key={probe.name} className={`border-2 border-[#1A1A2E] rounded p-4 ${lightClass(probe.status)}`}>
                <p className="text-xs font-bold uppercase">{probe.name}</p>
                <p className="text-lg font-black uppercase">{probe.status}</p>
                <p className="text-xs mt-2 break-words">{probe.detail}</p>
                {probe.responseMs != null && <p className="text-[10px] font-mono mt-1">{probe.responseMs}ms</p>}
                {probe.lastError && <p className="text-[11px] mt-1">{probe.lastError}</p>}
              </div>
            ))}
          </div>
        )}

        {tab === 'debugger' && (
          <div className="space-y-4">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void openDebugger(debugId); }}>
              <input value={debugId} onChange={(e) => setDebugId(e.target.value)} placeholder="Application ID" className="border-2 border-[#1A1A2E] rounded px-2 py-1.5 text-sm font-mono flex-1" />
              <button type="submit" className="bg-[#E88474] border-2 border-[#1A1A2E] px-3 py-1.5 text-xs font-bold rounded">Open</button>
            </form>
            {app && (
              <div className="bg-white border-2 border-[#1A1A2E] rounded p-4 text-xs space-y-2">
                <p><span className="font-black">ID</span> {app.id}</p>
                <p><span className="font-black">Status</span> {app.status}</p>
                <p><span className="font-black">Client</span> {app.applywizz_id}</p>
                <p><span className="font-black">Operator</span> {app.operatorName || app.assigned_ca_email || '—'}</p>
                <p><span className="font-black">Manager</span> {app.managerEmail || '—'}</p>
                <p><span className="font-black">Job</span> <a className="underline break-all" href={app.job_url} target="_blank" rel="noopener noreferrer">{app.job_title || app.job_url}</a></p>
                <p><span className="font-black">Company</span> {app.company_name || '—'}</p>
                {app.error_message && <p className="text-[#991B1B]"><span className="font-black">Error</span> {app.error_message}</p>}
                <p>
                  {app.proof_web_url ? <a className="underline font-bold mr-3" href={app.proof_web_url} target="_blank" rel="noopener noreferrer">Web proof</a> : <span className="text-[#64748B] mr-3">Web proof unavailable</span>}
                  {app.proof_email_url ? <a className="underline font-bold" href={app.proof_email_url} target="_blank" rel="noopener noreferrer">Email screenshot</a> : <span className="text-[#64748B]">Email screenshot unavailable</span>}
                </p>
                {app.proof_email_json && (
                  <pre className="bg-[#FAF4EB] border border-[#1A1A2E] p-3 overflow-auto max-h-48 whitespace-pre-wrap">{JSON.stringify(app.proof_email_json, null, 2)}</pre>
                )}
                <h3 className="font-black uppercase pt-2">Timeline</h3>
                {(!debug?.events || debug.events.length === 0) && <p className="text-[#64748B]">{debug?.warning || 'No application_events yet. Status changes will appear after migration 015.'}</p>}
                {(debug?.events || []).map((event) => (
                  <p key={event.id} className="font-mono">{event.from_status || '—'} → {event.to_status} · {new Date(event.created_at).toLocaleString()}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'guide' && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-2xl font-black text-[#1A1A2E]">Developer Guide</h2>
              <p className="text-xs text-[#64748B] font-mono mt-0.5">Internals, debugging, and cross-role dashboard access.</p>
            </div>

            <section className="bg-white border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <h3 className="text-sm font-black uppercase tracking-wide mb-2">Access</h3>
              <p className="text-sm text-[#1A1A2E] leading-relaxed">
                Use the header switcher to open <span className="font-bold">Dev</span>, <span className="font-bold">Admin</span>, <span className="font-bold">Manager</span>, or <span className="font-bold">Operator</span> UIs. Dev role bypasses manager/operator API scoping when using those dashboards.
              </p>
            </section>

            <section className="bg-[#FFF8D6] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <h3 className="text-sm font-black uppercase tracking-wide mb-3">Tabs</h3>
              <ul className="space-y-2 text-sm text-[#1A1A2E] leading-relaxed list-disc list-inside">
                <li><span className="font-bold">System</span> — health probes, queue and worker summary, ingest line.</li>
                <li><span className="font-bold">Runs</span> — applications for the header date; optional status filter; click ID to open Debugger.</li>
                <li><span className="font-bold">Errors</span> — grouped failures for the date; click app IDs to debug.</li>
                <li><span className="font-bold">Queue</span> — live queued/applying/stuck counts and running/pending ID lists.</li>
                <li><span className="font-bold">Integrations</span> — per-integration probe detail and last errors.</li>
                <li><span className="font-bold">Debugger</span> — paste an application UUID for status, proofs, raw error, and timeline.</li>
              </ul>
            </section>

            <section className="bg-[#E2F0FB] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
              <h3 className="text-sm font-black uppercase tracking-wide mb-3">Tips</h3>
              <ul className="space-y-2 text-sm text-[#1A1A2E] leading-relaxed list-disc list-inside">
                <li>Prefer Debugger over operator-facing messages when triaging production issues.</li>
                <li>Date affects Runs and Errors; Queue and Integrations are live snapshots.</li>
                <li>CSV ingest Start/Stop lives on the Admin dashboard, not here.</li>
                <li>Reproduce submit/dry-run flows on the Operator dashboard at <span className="font-mono">/</span>.</li>
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

export default DevDashboard;
