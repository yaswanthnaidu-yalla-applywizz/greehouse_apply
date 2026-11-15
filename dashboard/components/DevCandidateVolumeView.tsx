import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ProofViewer } from './ProofViewer.js';
import { EmailProofModal } from './EmailProofModal.js';
import { ApplicationStatusBadge } from './ApplicationStatusBadge.js';
import type { ApplicationStatus } from '../../src/db/applications.js';

export interface CandidateVolumeItem {
  applywizzId: string;
  candidateName: string;
  email?: string;
  appliedCount: number;
  emailProofPendingCount: number;
  totalSubmittedCount: number;
}

export interface CandidateJobProofItem {
  id: string;
  applywizzId: string;
  jobUrl: string;
  companyName: string;
  jobTitle?: string;
  ats: string;
  status: string;
  submittedAt?: string | null;
  createdAt?: string | null;
  proofWebUrl?: string | null;
  proofEmailUrl?: string | null;
}

export interface CandidateVolumeResponse {
  dateRange: {
    preset: string;
    from: string | null;
    to: string | null;
    label: string;
  };
  totals: {
    candidateCount: number;
    applied: number;
    emailProofPending: number;
    totalSubmitted: number;
  };
  candidates: CandidateVolumeItem[];
}

export interface DevCandidateVolumeViewProps {
  date: string;
  statsRange: 'day' | 'week' | 'month' | 'lifetime' | 'custom';
  customFrom: string;
  customTo: string;
  loadJson: <T>(url: string) => Promise<T>;
}

const PAGE_SIZE = 50;

function formatIst(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return `${new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} IST`;
  } catch {
    return iso;
  }
}

export const DevCandidateVolumeView: React.FC<DevCandidateVolumeViewProps> = ({
  date,
  statsRange,
  customFrom,
  customTo,
  loadJson,
}) => {
  const [data, setData] = useState<CandidateVolumeResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<'total' | 'applied' | 'pending' | 'id'>('total');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [page, setPage] = useState<number>(1);

  // Expanded candidates and their jobs
  const [expandedCids, setExpandedCids] = useState<Set<string>>(new Set());
  const [candidateJobs, setCandidateJobs] = useState<Record<string, CandidateJobProofItem[]>>({});
  const [loadingJobs, setLoadingJobs] = useState<Record<string, boolean>>({});
  const [jobsError, setJobsError] = useState<Record<string, string>>({});

  // Proof Modals state
  const [webProofModal, setWebProofModal] = useState<{
    isOpen: boolean;
    url?: string | null;
    applicationId?: string;
    companyName?: string;
    jobTitle?: string;
    candidateName?: string;
  }>({ isOpen: false });

  const [emailProofModal, setEmailProofModal] = useState<{
    isOpen: boolean;
    proof: any | null;
    companyName?: string;
    metadata?: { candidateName?: string; applywizzId?: string; jobTitle?: string };
  }>({ isOpen: false, proof: null });

  const rangeQueryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set('range', statsRange);
    params.set('date', date);
    if (statsRange === 'custom') {
      params.set('from', customFrom);
      params.set('to', customTo);
    }
    return params.toString();
  }, [statsRange, date, customFrom, customTo]);

  const fetchVolume = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await loadJson<CandidateVolumeResponse>(`/api/dev/candidate-volume?${rangeQueryParams}`);
      setData(res);
      setPage(1);
    } catch (err: any) {
      setError(err.message || 'Failed to load candidate volume data');
    } finally {
      setLoading(false);
    }
  }, [loadJson, rangeQueryParams]);

  useEffect(() => {
    void fetchVolume();
  }, [fetchVolume]);

  const toggleExpand = async (cid: string) => {
    const next = new Set(expandedCids);
    if (next.has(cid)) {
      next.delete(cid);
      setExpandedCids(next);
      return;
    }

    next.add(cid);
    setExpandedCids(next);

    // Fetch jobs if not already loaded
    if (!candidateJobs[cid] && !loadingJobs[cid]) {
      setLoadingJobs((prev) => ({ ...prev, [cid]: true }));
      setJobsError((prev) => ({ ...prev, [cid]: '' }));
      try {
        const res = await loadJson<{ applications: CandidateJobProofItem[] }>(
          `/api/dev/candidate-volume/${encodeURIComponent(cid)}/applications?${rangeQueryParams}`
        );
        setCandidateJobs((prev) => ({ ...prev, [cid]: res.applications || [] }));
      } catch (err: any) {
        setJobsError((prev) => ({ ...prev, [cid]: err.message || 'Failed to load jobs' }));
      } finally {
        setLoadingJobs((prev) => ({ ...prev, [cid]: false }));
      }
    }
  };

  const filteredCandidates = useMemo(() => {
    if (!data?.candidates) return [];
    const q = searchQuery.trim().toLowerCase();

    const filtered = data.candidates.filter((c) => {
      if (!q) return true;
      return (
        c.applywizzId.toLowerCase().includes(q) ||
        c.candidateName.toLowerCase().includes(q) ||
        (c.email && c.email.toLowerCase().includes(q))
      );
    });

    return filtered.sort((a, b) => {
      let diff = 0;
      if (sortBy === 'total') diff = b.totalSubmittedCount - a.totalSubmittedCount;
      else if (sortBy === 'applied') diff = b.appliedCount - a.appliedCount;
      else if (sortBy === 'pending') diff = b.emailProofPendingCount - a.emailProofPendingCount;
      else if (sortBy === 'id') diff = a.applywizzId.localeCompare(b.applywizzId);

      return sortAsc ? -diff : diff;
    });
  }, [data?.candidates, searchQuery, sortBy, sortAsc]);

  const totalPages = Math.max(1, Math.ceil(filteredCandidates.length / PAGE_SIZE));
  const currentPageItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredCandidates.slice(start, start + PAGE_SIZE);
  }, [filteredCandidates, page]);

  const openWebProof = (job: CandidateJobProofItem, candidateName: string) => {
    if (!job.proofWebUrl) return;
    setWebProofModal({
      isOpen: true,
      url: job.proofWebUrl,
      applicationId: job.id,
      companyName: job.companyName,
      jobTitle: job.jobTitle,
      candidateName,
    });
  };

  const openEmailProof = (job: CandidateJobProofItem, candidateName: string) => {
    setEmailProofModal({
      isOpen: true,
      proof: {
        applicationId: job.id,
        status: job.status as any,
        receivedAt: job.submittedAt || job.createdAt || new Date().toISOString(),
        rawUrl: job.proofEmailUrl || undefined,
      },
      companyName: job.companyName,
      metadata: {
        candidateName,
        applywizzId: job.applywizzId,
        jobTitle: job.jobTitle,
      },
    });
  };

  return (
    <div className="space-y-6">
      {/* 4 Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Active Candidates</p>
          <p className="text-2xl font-bold tracking-tight text-white mt-1">
            {data?.totals.candidateCount?.toLocaleString() ?? 0}
          </p>
          <p className="text-xs text-[#8e8e93] mt-2">Candidates with submitted apps in cohort</p>
        </div>

        <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Total Submitted</p>
          <p className="text-2xl font-bold tracking-tight text-[#0a84ff] mt-1">
            {data?.totals.totalSubmitted?.toLocaleString() ?? 0}
          </p>
          <p className="text-xs text-[#8e8e93] mt-2">APPLIED + EMAIL_PROOF_PENDING</p>
        </div>

        <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Fully Applied</p>
          <p className="text-2xl font-bold tracking-tight text-[#30d158] mt-1">
            {data?.totals.applied?.toLocaleString() ?? 0}
          </p>
          <p className="text-xs text-[#8e8e93] mt-2">With confirmed web/email proof</p>
        </div>

        <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">Email Proof Pending</p>
          <p className="text-2xl font-bold tracking-tight text-[#ff9f0a] mt-1">
            {data?.totals.emailProofPending?.toLocaleString() ?? 0}
          </p>
          <p className="text-xs text-[#8e8e93] mt-2">Submitted, awaiting Zoho confirmation email</p>
        </div>
      </div>

      {error && (
        <div className="bg-[#ff453a]/15 border border-[#ff453a]/40 rounded-xl p-3 text-sm font-bold text-[#ff453a]">
          {error}
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex-1 max-w-md">
          <input
            type="text"
            placeholder="Search AWL ID, candidate name, or email…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            className="w-full bg-[#2c2c2e] border border-[#3a3a3c] rounded-lg px-3 py-1.5 text-xs text-white placeholder-[#8e8e93] focus:outline-none focus:border-[#0a84ff]"
          />
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-[#8e8e93] font-semibold uppercase tracking-wider">Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-[#2c2c2e] border border-[#3a3a3c] rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none"
          >
            <option value="total">Total Submitted</option>
            <option value="applied">Applied (Confirmed)</option>
            <option value="pending">Proof Pending</option>
            <option value="id">AWL ID</option>
          </select>
          <button
            type="button"
            onClick={() => setSortAsc(!sortAsc)}
            className="bg-[#2c2c2e] border border-[#3a3a3c] rounded-lg px-2.5 py-1 text-xs text-white hover:bg-[#3a3a3c]"
          >
            {sortAsc ? '↑ Asc' : '↓ Desc'}
          </button>
        </div>
      </div>

      {/* Main Candidate Table */}
      <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#2c2c2e]/60 text-[#8e8e93] border-b border-[#2c2c2e] font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4 w-12 text-center">#</th>
                <th className="py-3 px-4">AWL ID</th>
                <th className="py-3 px-4">Candidate</th>
                <th className="py-3 px-4 text-right">Applied</th>
                <th className="py-3 px-4 text-right">Proof Pending</th>
                <th className="py-3 px-4 text-right">Total Submitted</th>
                <th className="py-3 px-4 text-center w-24">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2c2c2e] text-[#e5e5ea]">
              {loading && !data ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#8e8e93]">
                    <div className="w-6 h-6 border-2 border-[#0a84ff] border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                    Loading candidate application volume…
                  </td>
                </tr>
              ) : currentPageItems.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#8e8e93]">
                    No candidates found for the selected date cohort.
                  </td>
                </tr>
              ) : (
                currentPageItems.map((c, idx) => {
                  const isExpanded = expandedCids.has(c.applywizzId);
                  const jobs = candidateJobs[c.applywizzId] || [];
                  const isJobLoading = loadingJobs[c.applywizzId];
                  const jobErr = jobsError[c.applywizzId];

                  return (
                    <React.Fragment key={c.applywizzId}>
                      <tr
                        onClick={() => void toggleExpand(c.applywizzId)}
                        className={`hover:bg-[#2c2c2e]/40 transition-colors cursor-pointer ${
                          isExpanded ? 'bg-[#2c2c2e]/30' : ''
                        }`}
                      >
                        <td className="py-3 px-4 text-center font-mono text-[#8e8e93]">
                          {(page - 1) * PAGE_SIZE + idx + 1}
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-white">
                          {c.applywizzId}
                        </td>
                        <td className="py-3 px-4">
                          <p className="font-semibold text-white">{c.candidateName}</p>
                          {c.email && <p className="text-[11px] text-[#8e8e93] font-mono">{c.email}</p>}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-[#30d158]">
                          {c.appliedCount.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-[#ff9f0a]">
                          {c.emailProofPendingCount.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-black text-white text-sm">
                          {c.totalSubmittedCount.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void toggleExpand(c.applywizzId);
                            }}
                            className="px-2.5 py-1 bg-[#2c2c2e] hover:bg-[#3a3a3c] rounded text-[11px] font-semibold text-white border border-[#3a3a3c] transition-colors"
                          >
                            {isExpanded ? 'Hide' : 'View Jobs'}
                          </button>
                        </td>
                      </tr>

                      {/* Expanded Sub-table */}
                      {isExpanded && (
                        <tr className="bg-black/40">
                          <td colSpan={7} className="p-4 border-t border-b border-[#2c2c2e]">
                            <div className="space-y-3 pl-6 border-l-2 border-[#0a84ff]">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-bold uppercase tracking-wider text-white">
                                  Submitted Applications for {c.candidateName} ({c.applywizzId})
                                </span>
                                <span className="text-xs font-mono text-[#8e8e93]">
                                  {jobs.length} jobs in cohort
                                </span>
                              </div>

                              {isJobLoading ? (
                                <p className="text-xs text-[#8e8e93] py-4">Loading candidate jobs…</p>
                              ) : jobErr ? (
                                <p className="text-xs text-[#ff453a] py-2">{jobErr}</p>
                              ) : jobs.length === 0 ? (
                                <p className="text-xs text-[#8e8e93] py-2">No applications found in this range.</p>
                              ) : (
                                <div className="overflow-x-auto rounded-lg border border-[#2c2c2e]">
                                  <table className="w-full text-left text-xs bg-[#1c1c1e]">
                                    <thead className="bg-[#2c2c2e]/40 text-[#8e8e93] uppercase font-semibold">
                                      <tr>
                                        <th className="py-2 px-3">Company & Role</th>
                                        <th className="py-2 px-3">ATS</th>
                                        <th className="py-2 px-3">Status</th>
                                        <th className="py-2 px-3">Submitted At</th>
                                        <th className="py-2 px-3 text-right">Proofs</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#2c2c2e]">
                                      {jobs.map((job) => (
                                        <tr key={job.id} className="hover:bg-[#2c2c2e]/30">
                                          <td className="py-2 px-3">
                                            <a
                                              href={job.jobUrl}
                                              target="_blank"
                                              rel="noreferrer"
                                              className="font-semibold text-white hover:text-[#0a84ff] transition-colors"
                                            >
                                              {job.companyName}
                                            </a>
                                            <p className="text-[11px] text-[#8e8e93]">{job.jobTitle || 'Role'}</p>
                                          </td>
                                          <td className="py-2 px-3 font-mono uppercase text-[#8e8e93] text-[11px]">
                                            {job.ats}
                                          </td>
                                          <td className="py-2 px-3">
                                            <ApplicationStatusBadge status={job.status as ApplicationStatus} />
                                          </td>
                                          <td className="py-2 px-3 text-[11px] font-mono text-[#8e8e93]">
                                            {formatIst(job.submittedAt || job.createdAt)}
                                          </td>
                                          <td className="py-2 px-3 text-right space-x-2">
                                            {job.proofWebUrl ? (
                                              <button
                                                type="button"
                                                onClick={() => openWebProof(job, c.candidateName)}
                                                className="px-2 py-0.5 rounded bg-[#0a84ff]/20 text-[#0a84ff] border border-[#0a84ff]/30 text-[11px] font-semibold hover:bg-[#0a84ff]/30"
                                              >
                                                Web Proof
                                              </button>
                                            ) : (
                                              <span className="text-[11px] text-[#8e8e93]">—</span>
                                            )}
                                            <button
                                              type="button"
                                              onClick={() => openEmailProof(job, c.candidateName)}
                                              className="px-2 py-0.5 rounded bg-[#30d158]/20 text-[#30d158] border border-[#30d158]/30 text-[11px] font-semibold hover:bg-[#30d158]/30"
                                            >
                                              Email Proof
                                            </button>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        {totalPages > 1 && (
          <div className="p-3 bg-[#2c2c2e]/40 border-t border-[#2c2c2e] flex items-center justify-between text-xs text-[#8e8e93]">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredCandidates.length)} of{' '}
              {filteredCandidates.length} candidates
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 bg-[#1c1c1e] hover:bg-[#2c2c2e] disabled:opacity-30 rounded border border-[#3a3a3c] text-white"
              >
                Previous
              </button>
              <span className="px-2 font-mono">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-2.5 py-1 bg-[#1c1c1e] hover:bg-[#2c2c2e] disabled:opacity-30 rounded border border-[#3a3a3c] text-white"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Proof Modals */}
      {webProofModal.isOpen && (
        <ProofViewer
          isOpen={webProofModal.isOpen}
          onClose={() => setWebProofModal({ isOpen: false })}
          screenshotUrl={webProofModal.url}
          applicationId={webProofModal.applicationId}
          kind="web"
          metadata={{
            candidateName: webProofModal.candidateName,
            companyName: webProofModal.companyName,
            jobTitle: webProofModal.jobTitle,
          }}
        />
      )}

      {emailProofModal.isOpen && (
        <EmailProofModal
          isOpen={emailProofModal.isOpen}
          onClose={() => setEmailProofModal({ isOpen: false, proof: null })}
          proof={emailProofModal.proof}
          companyName={emailProofModal.companyName}
          metadata={emailProofModal.metadata}
        />
      )}
    </div>
  );
};
