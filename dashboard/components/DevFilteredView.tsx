import React, { useState, useEffect, useMemo } from 'react';

export interface SlimFieldDiagnostic {
  label: string;
  type: string;
  source: string;
  confidence?: number;
  valueSnippet?: string;
  isRequired: boolean;
}

export interface FilteredStatsResponse {
  hasIngestData: boolean;
  dateRange: {
    preset: string;
    from: string | null;
    to: string | null;
    label: string;
  };
  topFunnel: {
    totalCsvRows: number;
    tasksCreated: number;
    droppedRows: number;
    dropReasons: Record<string, number>;
  };
  bottomFunnel: {
    totalTasks: number;
    autoApplied: number;
    readyForReview: number;
    filteredOut: number;
    reviewTriggers: {
      has_ai_fields: number;
      has_unresolved_fields: number;
      low_confidence: number;
      mandatory_cover_letter: number;
      compensation_negative: number;
      [key: string]: number;
    };
    filterTriggers: {
      exceeded_required_unresolved: number;
      exceeded_required_ai: number;
      [key: string]: number;
    };
  };
  items: Array<{
    id?: string;
    applywizzId: string;
    companyName: string;
    jobUrl: string;
    jobTitle?: string;
    stage: 'pre_creation' | 'post_creation';
    status: string;
    reason: string;
    unresolvedFields?: SlimFieldDiagnostic[];
    aiFields?: SlimFieldDiagnostic[];
    totalUnresolvedCount?: number;
    totalAiCount?: number;
  }>;
}

export interface DevFilteredViewProps {
  date: string;
  statsRange: 'day' | 'week' | 'month' | 'lifetime' | 'custom';
  customFrom: string;
  customTo: string;
  loadJson: <T>(url: string) => Promise<T>;
  apiEndpoint?: string;
}

const PAGE_SIZE = 50;

export const DevFilteredView: React.FC<DevFilteredViewProps> = ({
  date,
  statsRange,
  customFrom,
  customTo,
  loadJson,
  apiEndpoint = '/api/dev/filtered-stats',
}) => {
  const [data, setData] = useState<FilteredStatsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [stageFilter, setStageFilter] = useState<'ALL' | 'pre_creation' | 'post_creation'>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [page, setPage] = useState<number>(1);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (rowKey: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  };

  useEffect(() => {
    setExpandedIds(new Set());
  }, [searchQuery, stageFilter, statusFilter, date, statsRange, customFrom, customTo]);

  useEffect(() => {
    let cancelled = false;
    async function fetchStats() {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (statsRange === 'custom') {
          params.set('range', 'custom');
          params.set('from', customFrom);
          params.set('to', customTo);
        } else {
          params.set('range', statsRange);
          params.set('date', date);
        }

        const res = await loadJson<FilteredStatsResponse>(`${apiEndpoint}?${params.toString()}`);
        if (!cancelled) {
          setData(res);
          setPage(1);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to load filtered statistics');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchStats();
    return () => {
      cancelled = true;
    };
  }, [date, statsRange, customFrom, customTo, loadJson]);

  // Derived filtered items for the table
  const filteredItems = useMemo(() => {
    if (!data?.items) return [];
    const query = searchQuery.trim().toLowerCase();

    return data.items.filter((item) => {
      if (stageFilter !== 'ALL' && item.stage !== stageFilter) return false;
      if (statusFilter !== 'ALL' && item.status.toUpperCase() !== statusFilter.toUpperCase()) return false;
      if (!query) return true;

      return (
        item.applywizzId.toLowerCase().includes(query) ||
        item.companyName.toLowerCase().includes(query) ||
        item.jobUrl.toLowerCase().includes(query) ||
        item.reason.toLowerCase().includes(query)
      );
    });
  }, [data?.items, searchQuery, stageFilter, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const currentPageItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredItems.slice(start, start + PAGE_SIZE);
  }, [filteredItems, page]);

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center p-16 text-[#8e8e93]">
        <div className="w-8 h-8 border-2 border-[#0a84ff] border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm">Loading conversion and funnel metrics...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 bg-[#ff453a]/15 border border-[#ff453a]/40 rounded-xl text-[#ff453a] text-sm">
        <p className="font-bold mb-1">Failed to load filtered metrics</p>
        <p>{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { topFunnel, bottomFunnel } = data;

  const csvConversionPct = topFunnel.totalCsvRows > 0
    ? ((topFunnel.tasksCreated / topFunnel.totalCsvRows) * 100).toFixed(1)
    : '0.0';

  const autoApplyPct = bottomFunnel.totalTasks > 0
    ? ((bottomFunnel.autoApplied / bottomFunnel.totalTasks) * 100).toFixed(1)
    : '0.0';

  const reviewPct = bottomFunnel.totalTasks > 0
    ? ((bottomFunnel.readyForReview / bottomFunnel.totalTasks) * 100).toFixed(1)
    : '0.0';

  const filterPct = bottomFunnel.totalTasks > 0
    ? ((bottomFunnel.filteredOut / bottomFunnel.totalTasks) * 100).toFixed(1)
    : '0.0';

  // Human-readable labels for top funnel drop reasons
  const topDropLabels: Record<string, string> = {
    zoho_disconnected: 'Candidate Zoho Not Connected',
    job_expired: 'Job Posting Expired / Closed',
    no_scan_template: 'No Scan Template / Unscannable',
    already_applied: 'Already Applied / Duplicate',
    exclusions_or_other: 'Exclusions & Other Rules',
    other: 'Exclusions & Other Rules',
  };

  const topDroppedTotal = Math.max(1, topFunnel.droppedRows);

  return (
    <div className="space-y-6">
      {/* Informational banner if no ingest data recorded */}
      {!data.hasIngestData && (
        <div className="bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-xl p-3 text-xs text-[#ff9f0a]">
          No CSV ingestion run record found for this cohort range. Showing post-creation application metrics.
        </div>
      )}

      {/* 4 Top KPI Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Ingest Conversion */}
        <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs font-semibold text-[#8e8e93] uppercase tracking-wider mb-2">
              <span>CSV Ingest Conversion</span>
              <span className="text-[#0a84ff] font-bold">{csvConversionPct}%</span>
            </div>
            <div className="text-2xl font-bold tracking-tight text-white">
              {topFunnel.tasksCreated.toLocaleString()}{' '}
              <span className="text-xs font-normal text-[#8e8e93]">
                / {topFunnel.totalCsvRows.toLocaleString()} rows
              </span>
            </div>
          </div>
          <div className="text-xs text-[#8e8e93] mt-3 pt-3 border-t border-[#2c2c2e]">
            <span className="text-[#ff453a] font-semibold">{topFunnel.droppedRows.toLocaleString()}</span> rows dropped pre-creation
          </div>
        </div>

        {/* Card 2: Auto-Queued Rate */}
        <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs font-semibold text-[#8e8e93] uppercase tracking-wider mb-2">
              <span>Auto-Queued Rate</span>
              <span className="text-[#30d158] font-bold">{autoApplyPct}%</span>
            </div>
            <div className="text-2xl font-bold tracking-tight text-white">
              {bottomFunnel.autoApplied.toLocaleString()}{' '}
              <span className="text-xs font-normal text-[#8e8e93]">
                / {bottomFunnel.totalTasks.toLocaleString()} tasks
              </span>
            </div>
          </div>
          <div className="text-xs text-[#8e8e93] mt-3 pt-3 border-t border-[#2c2c2e]">
            Auto-queued without operator review
          </div>
        </div>

        {/* Card 3: Operator Review Rate */}
        <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs font-semibold text-[#8e8e93] uppercase tracking-wider mb-2">
              <span>Ready for Review</span>
              <span className="text-[#ff9f0a] font-bold">{reviewPct}%</span>
            </div>
            <div className="text-2xl font-bold tracking-tight text-white">
              {bottomFunnel.readyForReview.toLocaleString()}{' '}
              <span className="text-xs font-normal text-[#8e8e93]">
                / {bottomFunnel.totalTasks.toLocaleString()} tasks
              </span>
            </div>
          </div>
          <div className="text-xs text-[#8e8e93] mt-3 pt-3 border-t border-[#2c2c2e]">
            Held for operator check (AI / unresolved)
          </div>
        </div>

        {/* Card 4: Filtered Out Rate */}
        <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs font-semibold text-[#8e8e93] uppercase tracking-wider mb-2">
              <span>Filtered Out Rate</span>
              <span className="text-[#ff453a] font-bold">{filterPct}%</span>
            </div>
            <div className="text-2xl font-bold tracking-tight text-white">
              {bottomFunnel.filteredOut.toLocaleString()}{' '}
              <span className="text-xs font-normal text-[#8e8e93]">
                / {bottomFunnel.totalTasks.toLocaleString()} tasks
              </span>
            </div>
          </div>
          <div className="text-xs text-[#8e8e93] mt-3 pt-3 border-t border-[#2c2c2e]">
            Exceeded required unresolved / AI threshold
          </div>
        </div>
      </div>

      {/* Funnel Breakdown Panels (Top Funnel & Bottom Funnel) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Panel 1: Top Funnel Drop-offs */}
        <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-[#2c2c2e]">
            <h3 className="text-sm font-bold uppercase tracking-wider text-white">
              Top Funnel Drop-Offs (Pre-Creation)
            </h3>
            <span className="text-xs font-mono text-[#8e8e93]">
              {topFunnel.droppedRows.toLocaleString()} dropped
            </span>
          </div>

          {topFunnel.droppedRows === 0 ? (
            <p className="text-xs text-[#8e8e93] py-4 text-center">No pre-creation drop-offs recorded for this date range.</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(topFunnel.dropReasons || {})
                .filter(([_, count]) => count > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([reasonKey, count]) => {
                  const pct = ((count / topDroppedTotal) * 100).toFixed(1);
                  const label = topDropLabels[reasonKey] || reasonKey.replace(/_/g, ' ');
                  return (
                    <div key={reasonKey} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-white font-medium">{label}</span>
                        <span className="text-[#8e8e93] font-mono">
                          {count.toLocaleString()} <span className="text-white/60">({pct}%)</span>
                        </span>
                      </div>
                      <div className="w-full bg-[#2c2c2e] h-2 rounded-full overflow-hidden">
                        <div
                          className="bg-[#0a84ff] h-full rounded-full transition-all duration-300"
                          style={{ width: `${Math.min(100, Math.max(3, Number(pct)))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* Panel 2: Bottom Funnel Triggers */}
        <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-[#2c2c2e]">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white">
                Bottom Funnel Triggers (Post-Creation)
              </h3>
              <span className="text-xs font-mono text-[#8e8e93]">
                {bottomFunnel.totalTasks.toLocaleString()} created
              </span>
            </div>

            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-[#ff9f0a] mb-2 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#ff9f0a]" />
                  Review Triggers ({bottomFunnel.readyForReview})
                </h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-[#2c2c2e] p-2.5 rounded-lg border border-[#3a3a3c]">
                    <div className="text-[#8e8e93]">Required AI Fields</div>
                    <div className="text-base font-bold text-white font-mono mt-0.5">
                      {bottomFunnel.reviewTriggers?.has_ai_fields || 0}
                    </div>
                  </div>
                  <div className="bg-[#2c2c2e] p-2.5 rounded-lg border border-[#3a3a3c]">
                    <div className="text-[#8e8e93]">Unresolved Required Fields</div>
                    <div className="text-base font-bold text-white font-mono mt-0.5">
                      {bottomFunnel.reviewTriggers?.has_unresolved_fields || 0}
                    </div>
                  </div>
                  <div className="bg-[#2c2c2e] p-2.5 rounded-lg border border-[#3a3a3c]">
                    <div className="text-[#8e8e93]">Mandatory Cover Letter</div>
                    <div className="text-base font-bold text-white font-mono mt-0.5">
                      {bottomFunnel.reviewTriggers?.mandatory_cover_letter || 0}
                    </div>
                  </div>
                  <div className="bg-[#2c2c2e] p-2.5 rounded-lg border border-[#3a3a3c]">
                    <div className="text-[#8e8e93]">Negative Compensation</div>
                    <div className="text-base font-bold text-white font-mono mt-0.5">
                      {bottomFunnel.reviewTriggers?.compensation_negative || 0}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-[#ff453a] mb-2 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#ff453a]" />
                  Filter Triggers ({bottomFunnel.filteredOut})
                </h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-[#2c2c2e] p-2.5 rounded-lg border border-[#3a3a3c]">
                    <div className="text-[#8e8e93]">Exceeded Unresolved (&gt;3)</div>
                    <div className="text-base font-bold text-white font-mono mt-0.5">
                      {bottomFunnel.filterTriggers?.exceeded_required_unresolved || 0}
                    </div>
                  </div>
                  <div className="bg-[#2c2c2e] p-2.5 rounded-lg border border-[#3a3a3c]">
                    <div className="text-[#8e8e93]">Exceeded AI Fields (&gt;3)</div>
                    <div className="text-base font-bold text-white font-mono mt-0.5">
                      {bottomFunnel.filterTriggers?.exceeded_required_ai || 0}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Itemized Drill-Down Table */}
      <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4 pb-4 border-b border-[#2c2c2e]">
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-white">Itemized Drill-down</h3>
            <p className="text-xs text-[#8e8e93] mt-0.5">
              Showing {filteredItems.length.toLocaleString()} matching records (CSV drops and held/filtered tasks)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Search Input */}
            <input
              type="text"
              placeholder="Search candidate ID, company, URL, or reason..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              className="bg-[#2c2c2e] border border-[#3a3a3c] rounded-lg px-3 py-1.5 text-xs text-white placeholder-[#8e8e93] focus:outline-none focus:border-[#0a84ff] min-w-[240px]"
            />

            {/* Stage Filter */}
            <select
              value={stageFilter}
              onChange={(e) => {
                setStageFilter(e.target.value as any);
                setPage(1);
              }}
              className="bg-[#2c2c2e] border border-[#3a3a3c] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#0a84ff]"
            >
              <option value="ALL">All Stages</option>
              <option value="pre_creation">Pre-Creation (CSV Drop)</option>
              <option value="post_creation">Post-Creation (Review / Filter)</option>
            </select>

            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="bg-[#2c2c2e] border border-[#3a3a3c] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#0a84ff]"
            >
              <option value="ALL">All Statuses</option>
              <option value="DROPPED">DROPPED</option>
              <option value="READY_FOR_REVIEW">READY_FOR_REVIEW</option>
              <option value="FILTERED_OUT">FILTERED_OUT</option>
              <option value="SKIPPED">SKIPPED</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[850px]">
            <thead className="bg-[#2c2c2e] text-[#8e8e93] uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-2.5 px-3 w-8"></th>
                <th className="py-2.5 px-3">Candidate ID</th>
                <th className="py-2.5 px-3">Company</th>
                <th className="py-2.5 px-3">Stage</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3">Reason / Trigger</th>
                <th className="py-2.5 px-3">Job Link</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2c2c2e]">
              {currentPageItems.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-[#8e8e93]">
                    No records match the active search and filter criteria.
                  </td>
                </tr>
              ) : (
                currentPageItems.map((item, idx) => {
                  const isPre = item.stage === 'pre_creation';
                  const rowKey = item.id || `${item.applywizzId}_${item.jobUrl || idx}`;
                  const isExpanded = expandedIds.has(rowKey);
                  const hasDiagnostics = Boolean(
                    (item.unresolvedFields && item.unresolvedFields.length > 0) ||
                    (item.aiFields && item.aiFields.length > 0)
                  );

                  const statusUpper = item.status.toUpperCase();
                  let statusBadgeClass = 'bg-[#2c2c2e] text-[#8e8e93] border-[#3a3a3c]';
                  if (statusUpper === 'DROPPED') {
                    statusBadgeClass = 'bg-[#ff453a]/15 text-[#ff453a] border-[#ff453a]/40';
                  } else if (statusUpper === 'READY_FOR_REVIEW') {
                    statusBadgeClass = 'bg-[#ff9f0a]/15 text-[#ff9f0a] border-[#ff9f0a]/40';
                  } else if (statusUpper === 'FILTERED_OUT' || statusUpper === 'SKIPPED') {
                    statusBadgeClass = 'bg-[#ff453a]/15 text-[#ff453a] border-[#ff453a]/40';
                  }

                  return (
                    <React.Fragment key={rowKey}>
                      <tr className="hover:bg-[#2c2c2e]/40 transition-colors">
                        <td className="py-2.5 px-2 text-center">
                          {!isPre ? (
                            <button
                              type="button"
                              onClick={() => toggleExpand(rowKey)}
                              title={isExpanded ? 'Collapse fields' : 'Inspect unresolved & AI fields'}
                              className="p-1 text-[#8e8e93] hover:text-white rounded transition-transform"
                            >
                              <span className={`inline-block transform transition-transform text-[10px] ${isExpanded ? 'rotate-90 text-[#0a84ff]' : ''}`}>
                                ▶
                              </span>
                            </button>
                          ) : (
                            <span className="inline-block w-4" />
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-medium text-white">
                          {item.applywizzId}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-white max-w-[160px] truncate" title={item.companyName}>
                          {item.companyName}
                        </td>
                        <td className="py-2.5 px-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${
                            isPre ? 'bg-[#0a84ff]/15 text-[#0a84ff] border-[#0a84ff]/30' : 'bg-[#bf5af2]/15 text-[#bf5af2] border-[#bf5af2]/30'
                          }`}>
                            {isPre ? 'Pre-Creation' : 'Post-Creation'}
                          </span>
                        </td>
                        <td className="py-2.5 px-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${statusBadgeClass}`}>
                            {item.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-[#8e8e93] max-w-[320px] truncate" title={item.reason}>
                          {item.reason}
                        </td>
                        <td className="py-2.5 px-3">
                          {item.jobUrl ? (
                            <a
                              href={item.jobUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#0a84ff] hover:underline inline-flex items-center gap-1 font-mono text-[11px]"
                            >
                              Open ↗
                            </a>
                          ) : (
                            <span className="text-[#8e8e93]">—</span>
                          )}
                        </td>
                      </tr>

                      {/* Expandable Diagnostic Drawer */}
                      {isExpanded && !isPre && (
                        <tr className="bg-[#141416]/90 border-b border-[#2c2c2e]">
                          <td colSpan={7} className="p-4 bg-[#18181a] border-l-4 border-[#0a84ff]">
                            <div className="space-y-4">
                              <div className="flex items-center justify-between pb-2 border-b border-[#2c2c2e]">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-white text-xs">Diagnostic Field Details</span>
                                  {item.jobTitle && <span className="text-[#8e8e93] text-xs">({item.jobTitle})</span>}
                                </div>
                                <span className="text-[11px] font-mono text-[#8e8e93]">ID: {item.id || 'N/A'}</span>
                              </div>

                              {!hasDiagnostics ? (
                                <p className="text-xs text-[#8e8e93] italic py-2">
                                  No individual unresolved or Tier-5 AI fields were identified for this application (likely triggered by mandatory cover letter policy or compensation rules).
                                </p>
                              ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                  {/* Unresolved Fields */}
                                  <div className="bg-[#1c1c1e] p-3 rounded-lg border border-[#2c2c2e]">
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="text-xs font-bold text-[#ff453a] flex items-center gap-1.5">
                                        <span className="w-2 h-2 rounded-full bg-[#ff453a]" />
                                        Unresolved Fields ({item.unresolvedFields?.length || 0}
                                        {item.totalUnresolvedCount && item.totalUnresolvedCount > (item.unresolvedFields?.length || 0)
                                          ? ` of ${item.totalUnresolvedCount}`
                                          : ''})
                                      </span>
                                    </div>
                                    {!item.unresolvedFields || item.unresolvedFields.length === 0 ? (
                                      <p className="text-[11px] text-[#8e8e93]">No unresolved fields.</p>
                                    ) : (
                                      <div className="space-y-2">
                                        {item.unresolvedFields.map((f, fIdx) => (
                                          <div key={fIdx} className="bg-[#141416] p-2 rounded border border-[#2c2c2e] text-xs">
                                            <div className="flex items-center justify-between">
                                              <span className="font-medium text-white">{f.label}</span>
                                              {f.isRequired && (
                                                <span className="text-[10px] bg-[#ff453a]/20 text-[#ff453a] px-1.5 py-0.5 rounded font-bold uppercase">
                                                  Required
                                                </span>
                                              )}
                                            </div>
                                            <div className="flex items-center gap-2 mt-1 text-[11px] text-[#8e8e93] font-mono">
                                              <span>Type: {f.type}</span>
                                              <span>•</span>
                                              <span>Source: {f.source}</span>
                                            </div>
                                          </div>
                                        ))}
                                        {item.totalUnresolvedCount && item.totalUnresolvedCount > item.unresolvedFields.length && (
                                          <p className="text-[10px] text-[#8e8e93] italic text-center pt-1">
                                            + {item.totalUnresolvedCount - item.unresolvedFields.length} more unresolved field(s)
                                          </p>
                                        )}
                                      </div>
                                    )}
                                  </div>

                                  {/* Tier-5 AI / Low Confidence Fields */}
                                  <div className="bg-[#1c1c1e] p-3 rounded-lg border border-[#2c2c2e]">
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="text-xs font-bold text-[#ff9f0a] flex items-center gap-1.5">
                                        <span className="w-2 h-2 rounded-full bg-[#ff9f0a]" />
                                        Tier-5 AI / Low Confidence ({item.aiFields?.length || 0}
                                        {item.totalAiCount && item.totalAiCount > (item.aiFields?.length || 0)
                                          ? ` of ${item.totalAiCount}`
                                          : ''})
                                      </span>
                                    </div>
                                    {!item.aiFields || item.aiFields.length === 0 ? (
                                      <p className="text-[11px] text-[#8e8e93]">No Tier-5 AI or low-confidence fields.</p>
                                    ) : (
                                      <div className="space-y-2">
                                        {item.aiFields.map((f, fIdx) => (
                                          <div key={fIdx} className="bg-[#141416] p-2 rounded border border-[#2c2c2e] text-xs">
                                            <div className="flex items-center justify-between">
                                              <span className="font-medium text-white">{f.label}</span>
                                              {f.confidence != null && (
                                                <span className="text-[10px] bg-[#ff9f0a]/20 text-[#ff9f0a] px-1.5 py-0.5 rounded font-mono font-bold">
                                                  {Math.round(f.confidence * 100)}% conf
                                                </span>
                                              )}
                                            </div>
                                            {f.valueSnippet && (
                                              <p className="text-[11px] text-[#d1d1d6] mt-1 bg-[#2c2c2e]/40 p-1.5 rounded font-mono break-all">
                                                Answer: {f.valueSnippet}
                                              </p>
                                            )}
                                            <div className="flex items-center gap-2 mt-1 text-[11px] text-[#8e8e93] font-mono">
                                              <span>Type: {f.type}</span>
                                              <span>•</span>
                                              <span>Source: {f.source}</span>
                                            </div>
                                          </div>
                                        ))}
                                        {item.totalAiCount && item.totalAiCount > item.aiFields.length && (
                                          <p className="text-[10px] text-[#8e8e93] italic text-center pt-1">
                                            + {item.totalAiCount - item.aiFields.length} more AI field(s)
                                          </p>
                                        )}
                                      </div>
                                    )}
                                  </div>
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

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-[#2c2c2e] text-xs text-[#8e8e93]">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1 bg-[#2c2c2e] text-white rounded border border-[#3a3a3c] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#3a3a3c]"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-3 py-1 bg-[#2c2c2e] text-white rounded border border-[#3a3a3c] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#3a3a3c]"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
