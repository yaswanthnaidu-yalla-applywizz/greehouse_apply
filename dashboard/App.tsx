/**
 * @fileoverview Main Operator Dashboard Application Container.
 *
 * Coordinates split-screen state, real-time candidate selection, job tab switching,
 * and pre-populated form rendering for the Greenhouse Job Application Automation system.
 *
 * References:
 * - 04-ui-ux.md
 * - 05-backend-schema.md
 * - 06-implementation.md
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
} from './types.js';

const API_BASE_URL = window.location.origin;

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
  const [application, setApplication] = useState<CandidateJobApplication | null>(null);

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
        const appData: CandidateJobApplication = await res.json();
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
              Phase V1-5 Operator Dashboard · Dual-Branch Pipeline
            </p>
          </div>
        </div>

        {/* Live Metrics Pills */}
        {stats && (
          <div className="flex items-center gap-3">
            {/* Yellow Card: Candidates */}
            <div className="flex items-center gap-1.5 bg-[#F4D66B] border border-[#E5C350] px-3 py-1.5 rounded-lg text-xs font-mono font-semibold shadow-sm">
              <span className="text-[#5C4A0A]">Candidates:</span>
              <span className="text-[#5C4A0A] font-bold">{stats.totalCandidates}</span>
            </div>

            {/* Blue Card: Jobs */}
            <div className="flex items-center gap-1.5 bg-[#B8D4E8] border border-[#A2C5DD] px-3 py-1.5 rounded-lg text-xs font-mono font-semibold shadow-sm">
              <span className="text-[#2D5C8C]">Jobs:</span>
              <span className="text-[#2D5C8C] font-bold">{stats.totalApplications}</span>
            </div>

            {/* Green Card: supabase % */}
            <div className="flex items-center gap-1.5 bg-[#9AC89A] border border-[#84B784] px-3 py-1.5 rounded-lg text-xs font-mono font-semibold shadow-sm">
              <span className="text-[#2D5C2D] font-bold">🟢 supabase: {stats.supabasePercentage}%</span>
            </div>

            {/* Coral Card: ai % */}
            <div className="flex items-center gap-1.5 bg-[#E88474] border border-[#D87060] px-3 py-1.5 rounded-lg text-xs font-mono font-semibold shadow-sm">
              <span className="text-[#6B2C2C] font-bold">🟣 ai: {stats.aiPercentage}%</span>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={fetchInitialData}
          className="text-xs bg-[#FFFFFF] hover:bg-[#FAF6F0] text-[#1E293B] border border-[#D8C7B5] px-3 py-1.5 rounded-lg transition-colors font-medium shadow-sm"
        >
          ↻ Refresh
        </button>
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
                onFieldUpdate={handleFieldUpdate}
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
