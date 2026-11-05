import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { getTodayIST, apiFetch } from '../hooks/useSession.js';

export interface AnalysisSummary {
  total: number;
  applied: number;
  failed: number;
  clients: number;
  successRate: number;
  failureRate: number;
  retryableFailed: number;
}

export interface AnalysisTimelinePoint {
  date: string;
  total: number;
  applied: number;
  failed: number;
  clients: number;
}

export interface FailureApplicationItem {
  id: string;
  applywizzId: string;
  jobUrl: string;
  companyName: string;
  jobTitle?: string;
  ats: 'greenhouse' | 'ashby';
  errorMessage: string;
  createdAt: string;
}

export interface FailureReasonGroup {
  reason: string;
  category: string;
  isRetryable: boolean;
  count: number;
  percentage: number;
  applications: FailureApplicationItem[];
}

export interface AnalysisResponse {
  mode: 'date' | 'period';
  range: {
    fromDate: string;
    toDate: string;
    label: string;
  };
  ats: 'all' | 'greenhouse' | 'ashby';
  summary: AnalysisSummary;
  timeline: AnalysisTimelinePoint[];
  failures: FailureReasonGroup[];
}

export interface AnalysisViewProps {
  loadJson: <T>(url: string) => Promise<T>;
  apiEndpoint?: string; // defaults to '/api/dev/analysis'
}

type MetricKey = 'total' | 'applied' | 'failed' | 'clients';

const METRIC_CONFIG: Record<
  MetricKey,
  { label: string; color: string; bgLight: string; border: string; desc: string }
> = {
  total: {
    label: 'Total',
    color: '#e2e8f0',
    bgLight: 'rgba(226, 232, 240, 0.1)',
    border: 'rgba(226, 232, 240, 0.3)',
    desc: 'All applications processed',
  },
  applied: {
    label: 'Applied (Success)',
    color: '#30d158',
    bgLight: 'rgba(48, 209, 88, 0.12)',
    border: 'rgba(48, 209, 88, 0.35)',
    desc: 'Applied + Email proof pending',
  },
  failed: {
    label: 'Failed',
    color: '#ff453a',
    bgLight: 'rgba(255, 69, 58, 0.12)',
    border: 'rgba(255, 69, 58, 0.35)',
    desc: 'Terminal and retryable failures',
  },
  clients: {
    label: 'Client Count',
    color: '#0a84ff',
    bgLight: 'rgba(10, 132, 255, 0.12)',
    border: 'rgba(10, 132, 255, 0.35)',
    desc: 'Distinct active candidates',
  },
};

export const AnalysisView: React.FC<AnalysisViewProps> = ({
  loadJson,
  apiEndpoint = '/api/dev/analysis',
}) => {
  const [ats, setAts] = useState<'all' | 'greenhouse' | 'ashby'>('all');
  const [mode, setMode] = useState<'period' | 'date'>('period');
  const [periodPreset, setPeriodPreset] = useState<'7d' | '14d' | '30d' | 'custom'>('7d');
  const [customFrom, setCustomFrom] = useState<string>(getTodayIST);
  const [customTo, setCustomTo] = useState<string>(getTodayIST);
  const [singleDate, setSingleDate] = useState<string>(getTodayIST);

  const [selectedMetrics, setSelectedMetrics] = useState<Record<MetricKey, boolean>>({
    total: true,
    applied: true,
    failed: true,
    clients: true,
  });

  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [expandedReason, setExpandedReason] = useState<string | null>(null);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);
  const [requeuing, setRequeuing] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const toggleMetric = (key: MetricKey) => {
    setSelectedMetrics((prev) => {
      const activeCount = Object.values(prev).filter(Boolean).length;
      if (prev[key] && activeCount <= 1) {
        // Keep at least one metric selected
        return prev;
      }
      return { ...prev, [key]: !prev[key] };
    });
  };

  const fetchAnalysis = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('mode', mode);
      params.set('ats', ats);

      if (mode === 'date') {
        params.set('date', singleDate);
      } else {
        params.set('preset', periodPreset);
        if (periodPreset === 'custom') {
          params.set('from', customFrom);
          params.set('to', customTo);
        }
      }

      const res = await loadJson<AnalysisResponse>(`${apiEndpoint}?${params.toString()}`);
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Failed to load analysis metrics');
    } finally {
      setLoading(false);
    }
  }, [apiEndpoint, mode, ats, singleDate, periodPreset, customFrom, customTo, loadJson]);

  useEffect(() => {
    fetchAnalysis();
  }, [fetchAnalysis]);

  const handleRequeue = async (reason?: string) => {
    const countToRequeue = reason
      ? data?.failures.find((f) => f.reason === reason)?.count || 0
      : data?.summary.retryableFailed || 0;

    if (countToRequeue === 0) return;

    const targetLabel = reason
      ? `"${reason}" (${countToRequeue} applications)`
      : `all ${countToRequeue} retryable failed applications`;

    if (!window.confirm(`Requeue ${targetLabel}? This will reset their status to QUEUED and clear their retry count.`)) {
      return;
    }

    setRequeuing(true);
    setActionMessage(null);
    try {
      const res = await apiFetch(`${apiEndpoint}/requeue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          ats,
          date: singleDate,
          preset: periodPreset,
          from: customFrom,
          to: customTo,
          reason,
        }),
      });
      const result = await res.json();
      if (!res.ok || result.error) {
        throw new Error(result.error || 'Failed to requeue applications');
      }
      setActionMessage({
        text: result.message || `Successfully requeued ${result.requeuedCount} applications.`,
        type: 'success',
      });
      fetchAnalysis();
    } catch (err: any) {
      setActionMessage({
        text: err.message || 'Failed to requeue applications.',
        type: 'error',
      });
    } finally {
      setRequeuing(false);
    }
  };

  const activeMetricKeys = useMemo(
    () => (Object.keys(selectedMetrics) as MetricKey[]).filter((k) => selectedMetrics[k]),
    [selectedMetrics]
  );

  // Single Day Bar Graph Calculations
  const singleDayPoint = data?.timeline[0] || null;
  const singleDayMax = useMemo(() => {
    if (!singleDayPoint) return 10;
    const values = activeMetricKeys.map((k) => singleDayPoint[k]);
    return Math.max(...values, 5);
  }, [singleDayPoint, activeMetricKeys]);

  // Multi-day SVG calculations
  const timeline = data?.timeline || [];
  const svgWidth = 840;
  const svgHeight = 240;
  const padLeft = 45;
  const padRight = 20;
  const padTop = 25;
  const padBottom = 35;
  const chartWidth = svgWidth - padLeft - padRight;
  const chartHeight = svgHeight - padTop - padBottom;

  const timelineMax = useMemo(() => {
    if (timeline.length === 0) return 10;
    let max = 0;
    for (const pt of timeline) {
      for (const k of activeMetricKeys) {
        if (pt[k] > max) max = pt[k];
      }
    }
    return Math.max(max, 5);
  }, [timeline, activeMetricKeys]);

  return (
    <div className="space-y-6 text-white">
      {/* Top Controls Header */}
      <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 sm:p-5 shadow-sm space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold tracking-tight text-white flex items-center gap-2">
                Observability & Application Analysis
              </h2>
              {loading && <span className="text-xs font-mono text-[#8e8e93] animate-pulse">updating…</span>}
            </div>
            <p className="text-xs text-[#8e8e93] mt-0.5">
              Multi-dimensional telemetry for submission throughput, success, and failure root-cause analysis.
            </p>
          </div>

          {/* ATS Selector */}
          <div className="flex items-center gap-2 bg-[#2c2c2e]/60 p-1 rounded-lg border border-[#3a3a3c] self-start lg:self-auto">
            <span className="text-[11px] font-semibold text-[#8e8e93] px-2 uppercase tracking-wider">ATS</span>
            {(['all', 'greenhouse', 'ashby'] as const).map((platform) => (
              <button
                key={platform}
                type="button"
                onClick={() => setAts(platform)}
                className={`px-3 py-1 text-xs font-semibold rounded-md capitalize transition-colors ${
                  ats === platform
                    ? 'bg-white text-black font-bold shadow-sm'
                    : 'text-[#8e8e93] hover:text-white hover:bg-[#3a3a3c]'
                }`}
              >
                {platform === 'all' ? 'Both' : platform}
              </button>
            ))}
          </div>
        </div>

        {/* Filters and Date Mode Row */}
        <div className="pt-3 border-t border-[#2c2c2e] flex flex-col md:flex-row md:items-center justify-between gap-4">
          {/* Mode Switcher & Presets */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-lg bg-[#2c2c2e]/70 p-0.5 border border-[#3a3a3c]">
              <button
                type="button"
                onClick={() => setMode('period')}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                  mode === 'period'
                    ? 'bg-[#0a84ff] text-white shadow-sm font-bold'
                    : 'text-[#8e8e93] hover:text-white'
                }`}
              >
                Period Trend
              </button>
              <button
                type="button"
                onClick={() => setMode('date')}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                  mode === 'date'
                    ? 'bg-[#0a84ff] text-white shadow-sm font-bold'
                    : 'text-[#8e8e93] hover:text-white'
                }`}
              >
                Single Date
              </button>
            </div>

            {mode === 'period' ? (
              <div className="flex flex-wrap items-center gap-2">
                {(['7d', '14d', '30d', 'custom'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPeriodPreset(p)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${
                      periodPreset === p
                        ? 'bg-white text-black font-bold border-white'
                        : 'bg-[#141416] text-[#8e8e93] border-[#2c2c2e] hover:text-white hover:border-[#3a3a3c]'
                    }`}
                  >
                    {p === '7d' ? '7 Days' : p === '14d' ? '14 Days' : p === '30d' ? '30 Days' : 'Custom'}
                  </button>
                ))}

                {periodPreset === 'custom' && (
                  <div className="flex items-center gap-2 ml-1 text-xs">
                    <input
                      type="date"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="bg-[#141416] border border-[#3a3a3c] rounded-lg px-2.5 py-1 text-white text-xs font-mono focus:outline-none focus:border-[#0a84ff]"
                    />
                    <span className="text-[#8e8e93]">to</span>
                    <input
                      type="date"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="bg-[#141416] border border-[#3a3a3c] rounded-lg px-2.5 py-1 text-white text-xs font-mono focus:outline-none focus:border-[#0a84ff]"
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8e8e93]">Select Day (IST):</span>
                <input
                  type="date"
                  value={singleDate}
                  onChange={(e) => setSingleDate(e.target.value)}
                  className="bg-[#141416] border border-[#3a3a3c] rounded-lg px-3 py-1 text-white text-xs font-mono focus:outline-none focus:border-[#0a84ff]"
                />
              </div>
            )}
          </div>

          {/* Metric Selector Checkboxes / Toggles */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold text-[#8e8e93] uppercase tracking-wider mr-1">
              Metrics:
            </span>
            {(['total', 'applied', 'failed', 'clients'] as MetricKey[]).map((metricKey) => {
              const active = selectedMetrics[metricKey];
              const conf = METRIC_CONFIG[metricKey];
              return (
                <button
                  key={metricKey}
                  type="button"
                  onClick={() => toggleMetric(metricKey)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
                    active
                      ? 'border-transparent font-semibold shadow-sm'
                      : 'bg-[#141416] text-[#636366] border-[#2c2c2e] hover:text-[#8e8e93]'
                  }`}
                  style={{
                    backgroundColor: active ? conf.bgLight : undefined,
                    color: active ? conf.color : undefined,
                    borderColor: active ? conf.border : undefined,
                  }}
                  title={conf.desc}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: active ? conf.color : '#48484a' }}
                  />
                  {conf.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-[#ff453a]/15 border border-[#ff453a]/40 rounded-xl p-3 text-sm font-semibold text-[#ff453a]">
          {error}
        </div>
      )}

      {actionMessage && (
        <div
          className={`p-3 rounded-xl text-xs font-medium border ${
            actionMessage.type === 'success'
              ? 'bg-[#30d158]/15 text-[#30d158] border-[#30d158]/40'
              : 'bg-[#ff453a]/15 text-[#ff453a] border-[#ff453a]/40'
          }`}
        >
          {actionMessage.text}
        </div>
      )}

      {/* KPI Stat Cards */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#8e8e93]">Total Processed</div>
            <div className="text-2xl sm:text-3xl font-extrabold font-mono mt-1 text-white">
              {data.summary.total.toLocaleString()}
            </div>
            <div className="text-[11px] text-[#8e8e93] mt-1">Applications in window</div>
          </div>

          <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#30d158]">Applied (Success)</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#30d158]/15 text-[#30d158] font-bold">
                {data.summary.successRate}%
              </span>
            </div>
            <div className="text-2xl sm:text-3xl font-extrabold font-mono mt-1 text-[#30d158]">
              {data.summary.applied.toLocaleString()}
            </div>
            <div className="text-[11px] text-[#8e8e93] mt-1">Applied & Proof Pending</div>
          </div>

          <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#ff453a]">Failed</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#ff453a]/15 text-[#ff453a] font-bold">
                {data.summary.failureRate}%
              </span>
            </div>
            <div className="text-2xl sm:text-3xl font-extrabold font-mono mt-1 text-[#ff453a]">
              {data.summary.failed.toLocaleString()}
            </div>
            <div className="text-[11px] text-[#8e8e93] mt-1">Submission / flow aborts</div>
          </div>

          <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#0a84ff]">Active Clients</div>
            <div className="text-2xl sm:text-3xl font-extrabold font-mono mt-1 text-[#0a84ff]">
              {data.summary.clients.toLocaleString()}
            </div>
            <div className="text-[11px] text-[#8e8e93] mt-1">Candidates with runs</div>
          </div>
        </div>
      )}

      {/* Main Chart Card */}
      <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 sm:p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-white">
              {mode === 'date' ? `Daily Comparison: ${singleDate}` : `Daily Throughput Trend: ${data?.range.label || ''}`}
            </h3>
            <p className="text-xs text-[#8e8e93] mt-0.5">
              {mode === 'date'
                ? 'Side-by-side metric comparison for the selected 24-hour IST date.'
                : 'Day-by-day telemetry across selected metrics.'}
            </p>
          </div>

          {/* Active Series Legend */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {activeMetricKeys.map((key) => {
              const conf = METRIC_CONFIG[key];
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: conf.color }} />
                  <span className="text-[#8e8e93] text-xs font-medium">{conf.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart View Content */}
        {loading && !data ? (
          <div className="h-60 flex items-center justify-center text-xs font-mono text-[#8e8e93]">
            Loading telemetry metrics…
          </div>
        ) : mode === 'date' ? (
          /* Single Day Bar Graph */
          <div className="py-6 px-2 sm:px-6">
            {!singleDayPoint || activeMetricKeys.length === 0 ? (
              <div className="text-center py-12 text-xs text-[#8e8e93]">
                No metrics selected or no data available for {singleDate}.
              </div>
            ) : (
              <div className="space-y-6 max-w-2xl mx-auto">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                  {activeMetricKeys.map((k) => {
                    const conf = METRIC_CONFIG[k];
                    const val = singleDayPoint[k];
                    const heightPercent = singleDayMax > 0 ? Math.max((val / singleDayMax) * 100, 6) : 6;
                    return (
                      <div
                        key={k}
                        className="bg-[#141416] border border-[#2c2c2e] rounded-xl p-4 flex flex-col items-center justify-between h-48 relative overflow-hidden"
                      >
                        <div className="w-full flex justify-between items-center z-10">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-[#8e8e93]">
                            {conf.label}
                          </span>
                        </div>

                        {/* Bar Pillar */}
                        <div className="w-full h-24 flex items-end justify-center relative my-2">
                          <div
                            className="w-16 rounded-t-lg transition-all duration-500 relative"
                            style={{
                              height: `${heightPercent}%`,
                              backgroundColor: conf.color,
                              opacity: 0.9,
                            }}
                          >
                            <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs font-mono font-bold text-white bg-[#2c2c2e] px-1.5 py-0.5 rounded shadow">
                              {val}
                            </div>
                          </div>
                        </div>

                        <div className="text-[11px] text-[#8e8e93] text-center z-10 font-mono">
                          {conf.desc}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Period Multi-Day Time-Series SVG Chart */
          <div className="overflow-x-auto">
            {timeline.length === 0 || activeMetricKeys.length === 0 ? (
              <div className="text-center py-16 text-xs text-[#8e8e93]">
                No data points found for this date range and ATS filter.
              </div>
            ) : (
              <div className="min-w-[650px] relative">
                <svg
                  viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                  className="w-full h-auto overflow-visible select-none"
                >
                  {/* Grid Lines */}
                  {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                    const y = padTop + chartHeight * (1 - ratio);
                    const val = Math.round(timelineMax * ratio);
                    return (
                      <g key={ratio}>
                        <line
                          x1={padLeft}
                          y1={y}
                          x2={padLeft + chartWidth}
                          y2={y}
                          stroke="#2c2c2e"
                          strokeDasharray="3 3"
                        />
                        <text
                          x={padLeft - 8}
                          y={y + 4}
                          textAnchor="end"
                          className="text-[10px] font-mono fill-[#636366]"
                        >
                          {val}
                        </text>
                      </g>
                    );
                  })}

                  {/* Render Lines for each active metric */}
                  {activeMetricKeys.map((key) => {
                    const conf = METRIC_CONFIG[key];
                    const pts = timeline.map((pt, i) => {
                      const x =
                        timeline.length === 1
                          ? padLeft + chartWidth / 2
                          : padLeft + (i / (timeline.length - 1)) * chartWidth;
                      const y = padTop + chartHeight - (pt[key] / timelineMax) * chartHeight;
                      return { x, y, val: pt[key], date: pt.date };
                    });

                    const pathD = pts.reduce(
                      (acc, p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`),
                      ''
                    );

                    return (
                      <g key={key}>
                        <path
                          d={pathD}
                          fill="none"
                          stroke={conf.color}
                          strokeWidth={2.5}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        {pts.map((p, i) => (
                          <circle
                            key={i}
                            cx={p.x}
                            cy={p.y}
                            r={hoveredPointIndex === i ? 5 : 3}
                            fill={hoveredPointIndex === i ? '#ffffff' : conf.color}
                            stroke="#1c1c1e"
                            strokeWidth={1.5}
                            className="transition-all"
                          />
                        ))}
                      </g>
                    );
                  })}

                  {/* X-Axis Dates & Hover Columns */}
                  {timeline.map((pt, i) => {
                    const x =
                      timeline.length === 1
                        ? padLeft + chartWidth / 2
                        : padLeft + (i / (timeline.length - 1)) * chartWidth;
                    const showLabel =
                      timeline.length <= 14 ||
                      i === 0 ||
                      i === timeline.length - 1 ||
                      i % Math.ceil(timeline.length / 8) === 0;

                    return (
                      <g key={pt.date}>
                        {showLabel && (
                          <text
                            x={x}
                            y={padTop + chartHeight + 18}
                            textAnchor="middle"
                            className="text-[10px] font-mono fill-[#8e8e93]"
                          >
                            {pt.date.slice(5)}
                          </text>
                        )}
                        {/* Hover Hit Box */}
                        <rect
                          x={x - (chartWidth / Math.max(timeline.length, 1)) / 2}
                          y={padTop}
                          width={chartWidth / Math.max(timeline.length, 1)}
                          height={chartHeight}
                          fill="transparent"
                          onMouseEnter={() => setHoveredPointIndex(i)}
                          onMouseLeave={() => setHoveredPointIndex(null)}
                          className="cursor-pointer"
                        />
                      </g>
                    );
                  })}
                </svg>

                {/* Tooltip Overlay */}
                {hoveredPointIndex !== null && timeline[hoveredPointIndex] && (
                  <div
                    className="absolute top-4 pointer-events-none bg-[#141416]/95 border border-[#3a3a3c] rounded-lg p-2.5 shadow-xl text-xs space-y-1.5 z-20 font-mono"
                    style={{
                      left: `${Math.min(
                        Math.max(
                          padLeft +
                            (hoveredPointIndex / Math.max(timeline.length - 1, 1)) * chartWidth -
                            75,
                          10
                        ),
                        svgWidth - 170
                      )}px`,
                    }}
                  >
                    <div className="font-bold text-white border-b border-[#2c2c2e] pb-1">
                      {timeline[hoveredPointIndex].date}
                    </div>
                    {activeMetricKeys.map((k) => (
                      <div key={k} className="flex items-center justify-between gap-4">
                        <span style={{ color: METRIC_CONFIG[k].color }}>{METRIC_CONFIG[k].label}:</span>
                        <span className="font-bold text-white">
                          {timeline[hoveredPointIndex][k].toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Failure Analysis Section */}
      <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-4 sm:p-5 shadow-sm space-y-4">
        {actionMessage && (
          <div
            className={`p-3 rounded-xl text-xs font-semibold flex items-center justify-between ${
              actionMessage.type === 'success'
                ? 'bg-[#30d158]/15 border border-[#30d158]/40 text-[#30d158]'
                : 'bg-[#ff453a]/15 border border-[#ff453a]/40 text-[#ff453a]'
            }`}
          >
            <span>{actionMessage.text}</span>
            <button
              type="button"
              onClick={() => setActionMessage(null)}
              className="text-[#8e8e93] hover:text-white font-mono ml-4"
            >
              ✕
            </button>
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#2c2c2e] pb-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white">
                Failure Root-Cause Breakdown
              </h3>
              {data && (
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-[#ff453a]/20 text-[#ff453a] border border-[#ff453a]/30">
                  {data.summary.failed} Total Failures
                </span>
              )}
            </div>
            <p className="text-xs text-[#8e8e93] mt-0.5">
              Categorized error patterns with impact percentages and affected application diagnostics.
            </p>
          </div>

          {/* Requeue All Retryable Button */}
          {data && data.summary.retryableFailed > 0 && (
            <button
              type="button"
              disabled={requeuing}
              onClick={() => handleRequeue()}
              className="px-3.5 py-1.5 bg-[#0a84ff] hover:bg-[#0071e3] text-white text-xs font-bold rounded-lg transition-all shadow-sm disabled:opacity-50 flex items-center gap-2 self-start sm:self-auto shrink-0"
            >
              <span className={requeuing ? 'animate-spin' : ''}>⟳</span>
              <span>
                {requeuing ? 'Requeueing…' : `Requeue All Retryable (${data.summary.retryableFailed})`}
              </span>
            </button>
          )}
        </div>

        {/* Failures List & Visual Distribution Bars */}
        {!data || data.failures.length === 0 ? (
          <div className="text-center py-10 bg-[#141416] rounded-xl border border-[#2c2c2e]">
            <div className="text-sm font-bold text-white">No Failures Detected 🎉</div>
            <p className="text-xs text-[#8e8e93] mt-1">
              Zero failed applications recorded for this selected timeframe and ATS filter.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {data.failures.map((fGroup) => {
              const isExpanded = expandedReason === fGroup.reason;
              return (
                <div
                  key={fGroup.reason}
                  className="bg-[#141416] border border-[#2c2c2e] hover:border-[#3a3a3c] rounded-xl overflow-hidden transition-all"
                >
                  {/* Card Header Row */}
                  <div
                    onClick={() => setExpandedReason(isExpanded ? null : fGroup.reason)}
                    className="p-4 cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3 select-none"
                  >
                    <div className="space-y-1.5 flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-[#2c2c2e] text-[#8e8e93]">
                          {fGroup.category}
                        </span>
                        <span
                          className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                            fGroup.isRetryable
                              ? 'bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30'
                              : 'bg-[#2c2c2e] text-[#8e8e93]'
                          }`}
                        >
                          {fGroup.isRetryable ? 'Retryable' : 'Terminal'}
                        </span>
                        <h4 className="text-xs sm:text-sm font-bold text-white truncate">
                          {fGroup.reason}
                        </h4>
                      </div>

                      {/* Visual Horizontal Proportional Distribution Bar */}
                      <div className="w-full bg-[#2c2c2e] h-2 rounded-full overflow-hidden mt-1 max-w-xl">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${Math.max(fGroup.percentage, 2)}%`,
                            backgroundColor:
                              fGroup.percentage > 40
                                ? '#ff453a'
                                : fGroup.percentage > 15
                                ? '#ff9f0a'
                                : '#0a84ff',
                          }}
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-3 self-end sm:self-auto shrink-0">
                      {fGroup.isRetryable && (
                        <button
                          type="button"
                          disabled={requeuing}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRequeue(fGroup.reason);
                          }}
                          className="px-2.5 py-1 text-[11px] font-bold bg-[#2c2c2e] hover:bg-[#3a3a3c] text-[#30d158] border border-[#30d158]/30 rounded-lg transition-colors disabled:opacity-40"
                          title="Requeue failed applications in this specific category"
                        >
                          Requeue ({fGroup.count})
                        </button>
                      )}

                      <div className="text-right">
                        <div className="text-sm font-extrabold font-mono text-white">
                          {fGroup.count} <span className="text-xs text-[#8e8e93] font-normal">failed</span>
                        </div>
                        <div className="text-[11px] font-mono text-[#ff9f0a] font-bold">
                          {fGroup.percentage}% of failures
                        </div>
                      </div>

                      <button
                        type="button"
                        className="p-1.5 text-[#8e8e93] hover:text-white rounded-lg hover:bg-[#2c2c2e] transition-colors"
                        title={isExpanded ? 'Collapse' : 'Inspect affected applications'}
                      >
                        <svg
                          className={`w-4 h-4 transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Expanded Diagnostics Drawer */}
                  {isExpanded && (
                    <div className="p-4 bg-[#1c1c1e] border-t border-[#2c2c2e] space-y-3">
                      <div className="flex items-center justify-between text-xs text-[#8e8e93]">
                        <span className="font-semibold text-white">
                          Recent Affected Applications ({fGroup.applications.length} shown)
                        </span>
                        <span className="font-mono text-[11px]">Latest {fGroup.applications.length} samples</span>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-[#2c2c2e]/60 text-[#8e8e93] border-b border-[#2c2c2e]">
                            <tr>
                              <th className="py-2 px-3">Candidate</th>
                              <th className="py-2 px-3">Job / Company</th>
                              <th className="py-2 px-3">ATS</th>
                              <th className="py-2 px-3">Error Snippet</th>
                              <th className="py-2 px-3">Time (IST)</th>
                              <th className="py-2 px-3">Link</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#2c2c2e]/50 font-mono text-[11px]">
                            {fGroup.applications.map((app) => (
                              <tr key={app.id || app.jobUrl} className="hover:bg-[#2c2c2e]/30">
                                <td className="py-2 px-3 text-white font-bold">{app.applywizzId}</td>
                                <td className="py-2 px-3 text-[#e2e8f0]">
                                  <div className="truncate max-w-[200px]" title={app.companyName}>
                                    {app.companyName}
                                  </div>
                                  <div className="text-[10px] text-[#8e8e93] truncate max-w-[200px]">
                                    {app.jobTitle}
                                  </div>
                                </td>
                                <td className="py-2 px-3">
                                  <span
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                                      app.ats === 'ashby'
                                        ? 'bg-[#bf5af2]/15 text-[#bf5af2]'
                                        : 'bg-[#30d158]/15 text-[#30d158]'
                                    }`}
                                  >
                                    {app.ats}
                                  </span>
                                </td>
                                <td className="py-2 px-3 text-[#ff453a] max-w-xs truncate" title={app.errorMessage}>
                                  {app.errorMessage}
                                </td>
                                <td className="py-2 px-3 text-[#8e8e93]">
                                  {app.createdAt ? app.createdAt.slice(0, 19).replace('T', ' ') : '—'}
                                </td>
                                <td className="py-2 px-3">
                                  {app.jobUrl ? (
                                    <a
                                      href={app.jobUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-[#0a84ff] hover:underline"
                                    >
                                      Job ↗
                                    </a>
                                  ) : (
                                    '—'
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
