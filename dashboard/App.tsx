/**
 * @fileoverview Main Operator Dashboard Application Container (Phase V2-5).
 *
 * Coordinates split-screen state, candidate selection, job tab switching,
 * pre-populated form rendering, live submission/dry-run controls, and verification proof viewing.
 *
 * References:
 * - 04-ui-ux.md
 * - 05-backend-schema.md
 * - V2-implementation.md (Phase V2-5)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { CandidateList } from './CandidateList.js';
import { JobQueueView } from './JobQueueView.js';
import { FormRenderer } from './FormRenderer.js';
import type {
  CandidateDetail,
  CandidateJobApplication,
  CandidateSummary,
  DashboardStats,
  ResolvedField,
  ApplicationStatus,
} from './types.js';

const API_BASE_URL = typeof window !== 'undefined' ? window.location.origin : '';

/**
 * Main Split-Screen Dashboard Component.
 *
 * @returns React application component.
 */
export const App: React.FC = () => {
  const [candidates, setCandidates] = useState<CandidateSummary[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [candidateDetail, setCandidateDetail] = useState<CandidateDetail | null>(null);
  const [selectedJobUrl, setSelectedJobUrl] = useState<string | null>(null);
  const [application, setApplication] = useState<any | null>(null);

  const [isLoadingCandidates, setIsLoadingCandidates] = useState<boolean>(true);
  const [isLoadingApplication, setIsLoadingApplication] = useState<boolean>(false);

  // 1. Fetch Candidates and Stats on Mount
  const fetchInitialData = useCallback(async () => {
    setIsLoadingCandidates(true);
    try {
      const [candidatesRes, statsRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/candidates`),
        fetch(`${API_BASE_URL}/api/stats`),
      ]);

      if (candidatesRes.ok) {
        const candidateData: CandidateSummary[] = await candidatesRes.json();
        setCandidates(candidateData);
        if (candidateData.length > 0 && !selectedCandidateId) {
          setSelectedCandidateId(candidateData[0].applywizzId);
        }
      }

      if (statsRes.ok) {
        const statsData: DashboardStats = await statsRes.json();
        setStats(statsData);
      }
    } catch (err: any) {
      console.error('Failed to load initial data:', err);
    } finally {
      setIsLoadingCandidates(false);
    }
  }, [selectedCandidateId]);

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  // 2. Fetch Selected Candidate Details & Jobs Queue
  const fetchCandidateDetail = useCallback(async (applywizzId: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/candidates/${applywizzId}`);
      if (res.ok) {
        const detail: CandidateDetail = await res.json();
        setCandidateDetail(detail);

        // Auto-select first job if available
        if (detail.jobs && detail.jobs.length > 0) {
          const firstJobUrl = detail.jobs[0].canonicalUrl || detail.jobs[0].rawUrl;
          setSelectedJobUrl(firstJobUrl);
        } else {
          setSelectedJobUrl(null);
          setApplication(null);
        }
      }
    } catch (err: any) {
      console.error(`Failed to fetch candidate ${applywizzId}:`, err);
    }
  }, []);

  useEffect(() => {
    if (selectedCandidateId) {
      fetchCandidateDetail(selectedCandidateId);
    }
  }, [selectedCandidateId, fetchCandidateDetail]);

  // 3. Fetch Resolved Form Answers for Active Job
  const fetchJobApplication = useCallback(async (applywizzId: string, jobUrl: string) => {
    setIsLoadingApplication(true);
    try {
      const encodedUrl = encodeURIComponent(jobUrl);
      const res = await fetch(`${API_BASE_URL}/api/candidates/${applywizzId}/jobs/${encodedUrl}`);

      if (res.ok) {
        const appData = await res.json();
        setApplication(appData);
      } else {
        setApplication(null);
      }
    } catch (err: any) {
      console.error(`Failed to fetch application for ${applywizzId} / ${jobUrl}:`, err);
      setApplication(null);
    } finally {
      setIsLoadingApplication(false);
    }
  }, []);

  useEffect(() => {
    if (selectedCandidateId && selectedJobUrl) {
      fetchJobApplication(selectedCandidateId, selectedJobUrl);
    }
  }, [selectedCandidateId, selectedJobUrl, fetchJobApplication]);

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
  const handleStatusChange = (newStatus: ApplicationStatus, updatedPayload?: any) => {
    if (!application) return;

    setApplication((prev: any) => ({
      ...prev,
      status: newStatus,
      proof_web_url: updatedPayload?.proofWebUrl || updatedPayload?.proof_web_url || prev.proof_web_url,
      proof_captured_at: updatedPayload?.proofCapturedAt || updatedPayload?.proof_captured_at || prev.proof_captured_at,
      dry_run_screenshot_url: updatedPayload?.screenshotUrl || updatedPayload?.dry_run_screenshot_url || prev.dry_run_screenshot_url,
    }));

    if (candidateDetail && selectedJobUrl) {
      const updatedJobs = candidateDetail.jobs.map((j) => {
        if (j.canonicalUrl === selectedJobUrl || j.rawUrl === selectedJobUrl) {
          return { ...j, status: newStatus };
        }
        return j;
      });
      setCandidateDetail({ ...candidateDetail, jobs: updatedJobs });
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#FFF5EB] text-[#1E293B] font-sans overflow-hidden select-none">
      {/* Top Navigation & Metrics Bar */}
      <header className="h-16 bg-[#FFFFFF] border-b border-[#E8DCCF] flex items-center justify-between px-6 flex-shrink-0 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🟢</span>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-[#1A1A2E]">
              Greenhouse Automation Platform
            </h1>
            <p className="text-[10px] text-[#64748B] font-mono">
              Phase V2 Operator Dashboard · Verification Proofs &amp; Status Lifecycle
            </p>
          </div>
        </div>

        {/* Live Metrics Pills */}
        {stats && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 bg-[#F4D66B] border border-[#E5C350] px-3 py-1.5 rounded-lg text-xs font-mono font-semibold shadow-sm">
              <span className="text-[#5C4A0A]">Candidates:</span>
              <span className="text-[#5C4A0A] font-bold">{stats.totalCandidates}</span>
            </div>

            <div className="flex items-center gap-1.5 bg-[#B8D4E8] border border-[#A2C5DD] px-3 py-1.5 rounded-lg text-xs font-mono font-semibold shadow-sm">
              <span className="text-[#2D5C8C]">Jobs:</span>
              <span className="text-[#2D5C8C] font-bold">{stats.totalApplications}</span>
            </div>

            <div className="flex items-center gap-1.5 bg-[#9AC89A] border border-[#84B784] px-3 py-1.5 rounded-lg text-xs font-mono font-semibold shadow-sm">
              <span className="text-[#2D5C2D] font-bold">🟢 supabase: {stats.supabasePercentage}%</span>
            </div>

            <div className="flex items-center gap-1.5 bg-[#E88474] border border-[#D87060] px-3 py-1.5 rounded-lg text-xs font-mono font-semibold shadow-sm">
              <span className="text-[#6B2C2C] font-bold">🟣 ai: {stats.aiPercentage}%</span>
            </div>

            <button
              type="button"
              onClick={fetchInitialData}
              className="text-xs bg-[#FFFFFF] hover:bg-[#FAF6F0] text-[#1E293B] border border-[#D8C7B5] px-3 py-1.5 rounded-lg transition-colors font-medium shadow-sm"
            >
              ↻ Refresh
            </button>
          </div>
        )}
      </header>

      {/* Main Split-Screen Workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Pane: Candidates Directory */}
        <CandidateList
          candidates={candidates}
          selectedId={selectedCandidateId}
          onSelectCandidate={(id) => setSelectedCandidateId(id)}
          isLoading={isLoadingCandidates}
        />

        {/* Right Pane: Candidate Jobs & Form Viewer */}
        <main className="flex-1 flex flex-col bg-[#FFF5EB] overflow-hidden">
          {candidateDetail ? (
            <>
              {/* Right Top: Job Queue Tabs */}
              <JobQueueView
                candidate={candidateDetail}
                selectedJobUrl={selectedJobUrl}
                onSelectJob={(url) => setSelectedJobUrl(url)}
              />

              {/* Right Main: Form Renderer */}
              <FormRenderer
                application={application}
                isLoading={isLoadingApplication}
                candidateName={candidateDetail.clientName}
                apiBaseUrl={API_BASE_URL}
                onFieldUpdate={handleFieldUpdate}
                onStatusChange={handleStatusChange}
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-[#64748B]">
              <p className="text-sm">Select a candidate to view assigned applications.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
