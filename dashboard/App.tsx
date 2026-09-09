/**
 * @fileoverview Main Operator Dashboard Application Container (Phase V2-UI).
 *
 * Coordinates split-screen workspace, candidate selection, job tab switching,
 * pre-populated form rendering, live submission/dry-run controls, and verification proof viewing.
 * Styled with the neo-brutalist / modern job board aesthetic matching the reference mockup.
 *
 * References:
 * - 04-ui-ux-v2-refined.md
 * - V2-implementation.md (Phase V2-5, V2-UI)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { CandidateList } from './CandidateList.js';
import { JobQueueView } from './JobQueueView.js';
import { FormRenderer } from './FormRenderer.js';
import { AuthView, type AuthUser } from './components/AuthView.js';
import type {
  CandidateDetail,
  CandidateSummary,
  DashboardStats,
  ResolvedField,
  ApplicationStatus,
} from './types.js';

const API_BASE_URL = typeof window !== 'undefined' ? window.location.origin : '';

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = localStorage.getItem('applywizz_auth_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [activeTab, setActiveTab] = useState<'find-jobs' | 'dashboard' | 'stats'>('dashboard');
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
        if (candidateData.length > 0 && (!selectedCandidateId || selectedCandidateId === 'AWL-YASWANTH')) {
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

  const handleSignOut = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('applywizz_auth_token');
      localStorage.removeItem('applywizz_auth_user');
    }
    setCurrentUser(null);
  };

  useEffect(() => {
    if (currentUser) {
      fetchInitialData();
    }
  }, [currentUser, fetchInitialData]);

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
      proof_web_url:
        updatedPayload?.proofWebUrl || updatedPayload?.proof_web_url || prev.proof_web_url,
      proof_captured_at:
        updatedPayload?.proofCapturedAt ||
        updatedPayload?.proof_captured_at ||
        prev.proof_captured_at,
      dry_run_screenshot_url:
        updatedPayload?.screenshotUrl ||
        updatedPayload?.dry_run_screenshot_url ||
        prev.dry_run_screenshot_url,
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

  if (!currentUser) {
    return (
      <div className="flex items-center justify-center min-h-screen w-screen bg-[#FFF5EB] p-4 select-none font-sans">
        <AuthView onAuthSuccess={(user) => setCurrentUser(user)} apiBaseUrl={API_BASE_URL} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-[#FFF5EB] text-[#1A1A2E] font-sans overflow-hidden select-none">
      {/* Top Navigation & Brand Header */}
      <header className="h-16 bg-[#FFF5EB] border-b-2 border-[#1A1A2E] flex items-center justify-between px-6 flex-shrink-0">
        {/* Left: Brand Logo & Navigation Links */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-[#1A1A2E] text-[#FFF5EB] flex items-center justify-center font-black text-sm border-2 border-[#1A1A2E] shadow-[2px_2px_0px_#E88474]">
              AW
            </div>
            <div>
              <span className="text-sm font-black tracking-tight text-[#1A1A2E] uppercase">
                ApplyWizz
              </span>
              <span className="text-[10px] block font-mono text-[#64748B] font-bold">
                Auto Apply V2
              </span>
            </div>
          </div>

          {/* Navigation Tabs (Find Jobs / Dashboard / Stats) */}
          <nav className="hidden md:flex items-center gap-2 bg-white border border-[#1A1A2E] rounded-md p-1 shadow-[2px_2px_0px_#1A1A2E]">
            <button
              type="button"
              onClick={() => setActiveTab('find-jobs')}
              className={`px-3 py-1 text-xs font-bold rounded transition-all ${
                activeTab === 'find-jobs'
                  ? 'bg-[#E88474] text-white'
                  : 'text-[#1A1A2E] hover:bg-[#FAF4EB]'
              }`}
            >
              Find Jobs
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('dashboard')}
              className={`px-3 py-1 text-xs font-bold rounded transition-all ${
                activeTab === 'dashboard'
                  ? 'bg-[#E88474] text-white'
                  : 'text-[#1A1A2E] hover:bg-[#FAF4EB]'
              }`}
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('stats')}
              className={`px-3 py-1 text-xs font-bold rounded transition-all ${
                activeTab === 'stats'
                  ? 'bg-[#E88474] text-white'
                  : 'text-[#1A1A2E] hover:bg-[#FAF4EB]'
              }`}
            >
              Stats
            </button>
          </nav>
        </div>

        {/* Right: Metrics Pills, Notifications & User Avatar */}
        <div className="flex items-center gap-3">
          {stats && (
            <div className="hidden lg:flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-[#F4D66B] border border-[#1A1A2E] px-2.5 py-1 rounded text-xs font-mono font-bold text-[#5C4A0A] shadow-[1px_1px_0px_#1A1A2E]">
                <span>Candidates:</span>
                <span>{stats.totalCandidates}</span>
              </div>

              <div className="flex items-center gap-1.5 bg-[#B8D4E8] border border-[#1A1A2E] px-2.5 py-1 rounded text-xs font-mono font-bold text-[#1E3A5F] shadow-[1px_1px_0px_#1A1A2E]">
                <span>Jobs:</span>
                <span>{stats.totalApplications}</span>
              </div>

              <div className="flex items-center gap-1.5 bg-[#9AC89A] border border-[#1A1A2E] px-2.5 py-1 rounded text-xs font-mono font-bold text-[#1E4620] shadow-[1px_1px_0px_#1A1A2E]">
                <span>🌿 supabase: {stats.supabasePercentage}%</span>
              </div>

              <div className="flex items-center gap-1.5 bg-[#EDE9FE] border border-[#1A1A2E] px-2.5 py-1 rounded text-xs font-mono font-bold text-[#5B21B6] shadow-[1px_1px_0px_#1A1A2E]">
                <span>🔮 ai: {stats.aiPercentage}%</span>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={fetchInitialData}
            title="Refresh Data"
            className="text-xs bg-white hover:bg-[#FAF4EB] text-[#1A1A2E] border border-[#1A1A2E] px-2.5 py-1 rounded shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] font-bold transition-all"
          >
            ↻
          </button>

          {/* Notification Bell */}
          <div className="relative p-1.5 bg-white border border-[#1A1A2E] rounded shadow-[2px_2px_0px_#1A1A2E] cursor-pointer">
            <span className="text-xs">🔔</span>
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-[#E88474] border border-[#1A1A2E] rounded-full"></span>
          </div>

          {/* User Profile Avatar & Sign Out */}
          <div className="flex items-center gap-2 bg-white border border-[#1A1A2E] px-2.5 py-1 rounded shadow-[2px_2px_0px_#1A1A2E]">
            <div className="w-5 h-5 rounded-full bg-[#E88474] border border-[#1A1A2E] flex items-center justify-center text-[10px] font-black text-white uppercase">
              {currentUser?.email ? currentUser.email.charAt(0) : 'U'}
            </div>
            <span className="text-xs font-bold text-[#1A1A2E] max-w-[130px] truncate hidden sm:inline" title={currentUser?.email}>
              {currentUser?.email || 'Operator'}
            </span>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            title="Sign Out"
            className="text-xs bg-[#FFF5EB] hover:bg-[#E88474] hover:text-white text-[#1A1A2E] border border-[#1A1A2E] px-2.5 py-1 rounded shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] font-bold transition-all"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Main Workspace (Split-screen Dashboard or Stats View) */}
      {activeTab === 'stats' ? (
        <div className="flex-1 overflow-y-auto p-8 max-w-5xl mx-auto w-full custom-scrollbar">
          <div className="mb-6">
            <h2 className="text-2xl font-black text-[#1A1A2E]">Application Pipeline Stats</h2>
            <p className="text-xs text-[#64748B] font-mono mt-0.5">
              Real-time throughput metrics, resolution tier breakdowns, and submission telemetry.
            </p>
          </div>

          {stats ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              <div className="bg-[#FFF8D6] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
                <span className="text-xs font-bold uppercase tracking-wider text-[#5C4A0A]">
                  Total Candidates
                </span>
                <div className="text-3xl font-black text-[#1A1A2E] mt-2">
                  {stats.totalCandidates}
                </div>
                <div className="text-[11px] font-mono text-[#5C4A0A] mt-1">
                  Ingested &amp; segregated
                </div>
              </div>

              <div className="bg-[#E2F0FB] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
                <span className="text-xs font-bold uppercase tracking-wider text-[#1E3A5F]">
                  Total Applications
                </span>
                <div className="text-3xl font-black text-[#1A1A2E] mt-2">
                  {stats.totalApplications}
                </div>
                <div className="text-[11px] font-mono text-[#1E3A5F] mt-1">
                  Active job assignments
                </div>
              </div>

              <div className="bg-[#E2F5E2] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
                <span className="text-xs font-bold uppercase tracking-wider text-[#1E4620]">
                  Supabase Cache
                </span>
                <div className="text-3xl font-black text-[#1A1A2E] mt-2">
                  {stats.supabasePercentage}%
                </div>
                <div className="text-[11px] font-mono text-[#1E4620] mt-1">
                  {stats.supabaseTaggedCount} fields (0 API calls)
                </div>
              </div>

              <div className="bg-[#FFEAE8] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
                <span className="text-xs font-bold uppercase tracking-wider text-[#6B2C2C]">
                  AI Synthesis
                </span>
                <div className="text-3xl font-black text-[#1A1A2E] mt-2">
                  {stats.aiPercentage}%
                </div>
                <div className="text-[11px] font-mono text-[#6B2C2C] mt-1">
                  {stats.aiTaggedCount} fields synthesized
                </div>
              </div>
            </div>
          ) : (
            <div className="p-8 text-center text-xs font-mono text-[#64748B]">Loading statistics...</div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Left Pane: Candidates Directory */}
          <CandidateList
            candidates={candidates}
            selectedId={selectedCandidateId}
            onSelectCandidate={(id) => setSelectedCandidateId(id)}
            isLoading={isLoadingCandidates}
          />

          {/* Right Pane: Candidate Jobs Queue & Form Renderer */}
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
                <div className="text-4xl mb-2">👤</div>
                <p className="text-sm font-bold text-[#1A1A2E]">No Candidate Selected</p>
                <p className="text-xs text-[#64748B] mt-1 font-medium">
                  Select a candidate from the left directory to view assigned applications.
                </p>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
};

export default App;
