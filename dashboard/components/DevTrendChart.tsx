import React, { useState } from 'react';

export interface TrendPoint {
  bucketStart: string;
  successApplications: number;
  failedApplications: number;
  clients: number;
}

export type TrendMetric = 'successApplications' | 'failedApplications' | 'clients';
export type TrendBucket = 'day' | 'week' | 'month';

export interface DevTrendChartProps {
  trend: TrendPoint[];
  metric: TrendMetric;
  onMetricChange: (metric: TrendMetric) => void;
  bucket: TrendBucket;
  onBucketChange: (bucket: TrendBucket) => void;
  loading?: boolean;
}

export function DevTrendChart({
  trend,
  metric,
  onMetricChange,
  bucket,
  onBucketChange,
  loading = false,
}: DevTrendChartProps): React.JSX.Element {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const values = trend.map((point) => point[metric]);
  const maxValue = Math.max(...values, 5); // At least 5 scale ceiling
  const totalValue = values.reduce((sum, v) => sum + v, 0);

  const metricLabel =
    metric === 'successApplications'
      ? 'Successful Applications'
      : metric === 'failedApplications'
      ? 'Failed Applications'
      : 'Unique Clients (Successful)';

  const metricColor =
    metric === 'successApplications'
      ? '#30d158'
      : metric === 'failedApplications'
      ? '#ff453a'
      : '#0a84ff';

  // SVG coordinates
  const svgWidth = 700;
  const svgHeight = 200;
  const padLeft = 40;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 35;
  const chartWidth = svgWidth - padLeft - padRight;
  const chartHeight = svgHeight - padTop - padBottom;

  const points = trend.map((point, i) => {
    const x =
      trend.length === 1
        ? padLeft + chartWidth / 2
        : padLeft + (i / (trend.length - 1)) * chartWidth;
    const y = padTop + chartHeight - (point[metric] / maxValue) * chartHeight;
    return { x, y, point };
  });

  const pathD =
    points.length === 0
      ? ''
      : points.length === 1
      ? `M ${points[0].x} ${points[0].y}`
      : points.reduce(
          (acc, p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`),
          ''
        );

  const areaD =
    points.length <= 1
      ? ''
      : `${pathD} L ${points[points.length - 1].x} ${padTop + chartHeight} L ${
          points[0].x
        } ${padTop + chartHeight} Z`;

  return (
    <div className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5 mb-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-white">Application Trend</h2>
            {loading && <span className="text-[10px] font-mono text-[#8e8e93] animate-pulse">updating…</span>}
          </div>
          <p className="text-xs text-[#8e8e93] mt-0.5">
            Total for period: <span className="font-bold text-white font-mono">{totalValue}</span> {metricLabel.toLowerCase()}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Metric Selector */}
          <div className="flex bg-[#2c2c2e] p-0.5 rounded-lg border border-[#3a3a3c]">
            {(
              [
                { key: 'successApplications', label: 'Success' },
                { key: 'failedApplications', label: 'Failed' },
                { key: 'clients', label: 'Clients' },
              ] as const
            ).map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => onMetricChange(m.key)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                  metric === m.key
                    ? 'bg-white text-black font-bold'
                    : 'text-[#8e8e93] hover:text-white'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Granularity Selector */}
          <div className="flex bg-[#2c2c2e] p-0.5 rounded-lg border border-[#3a3a3c]">
            {(['day', 'week', 'month'] as const).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => onBucketChange(b)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md capitalize transition-colors ${
                  bucket === b
                    ? 'bg-[#0a84ff] text-white font-bold'
                    : 'text-[#8e8e93] hover:text-white'
                }`}
              >
                {b}
              </button>
            ))}
          </div>
        </div>
      </div>

      {trend.length === 0 ? (
        <div className="h-44 flex items-center justify-center text-xs font-mono text-[#8e8e93]">
          No data recorded in this period.
        </div>
      ) : (
        <div className="relative w-full overflow-x-auto">
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="w-full h-48 select-none"
            role="img"
            aria-label={`${metricLabel} trend chart`}
          >
            <defs>
              <linearGradient id={`gradient-${metric}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={metricColor} stopOpacity="0.25" />
                <stop offset="100%" stopColor={metricColor} stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Horizontal Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
              const y = padTop + chartHeight * (1 - ratio);
              const val = Math.round(maxValue * ratio);
              return (
                <g key={ratio}>
                  <line
                    x1={padLeft}
                    y1={y}
                    x2={padLeft + chartWidth}
                    y2={y}
                    stroke="#2c2c2e"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={padLeft - 6}
                    y={y + 3}
                    textAnchor="end"
                    className="text-[9px] fill-[#8e8e93] font-mono"
                  >
                    {val}
                  </text>
                </g>
              );
            })}

            {/* Area under curve */}
            {areaD && <path d={areaD} fill={`url(#gradient-${metric})`} />}

            {/* Trend line */}
            {pathD && (
              <path
                d={pathD}
                fill="none"
                stroke={metricColor}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Data points & hover interactive hit targets */}
            {points.map((p, idx) => {
              const isHovered = hoveredIndex === idx;
              return (
                <g key={p.point.bucketStart}>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={isHovered ? 5 : 3}
                    fill={metricColor}
                    stroke="#1c1c1e"
                    strokeWidth="2"
                    className="transition-all"
                  />
                  {/* Invisible wide hit target for hover */}
                  <rect
                    x={p.x - 12}
                    y={padTop}
                    width={24}
                    height={chartHeight + padBottom}
                    fill="transparent"
                    onMouseEnter={() => setHoveredIndex(idx)}
                    onMouseLeave={() => setHoveredIndex(null)}
                    className="cursor-pointer"
                  />
                </g>
              );
            })}

            {/* X-axis date labels (sparse display to prevent crowding) */}
            {points.map((p, idx) => {
              const step = Math.max(1, Math.floor(points.length / 8));
              if (idx % step !== 0 && idx !== points.length - 1) return null;
              // Format label: MM-DD for day/week, YYYY-MM for month
              const label =
                bucket === 'month'
                  ? p.point.bucketStart.slice(0, 7)
                  : p.point.bucketStart.slice(5);
              return (
                <text
                  key={p.point.bucketStart}
                  x={p.x}
                  y={svgHeight - 10}
                  textAnchor="middle"
                  className="text-[9px] fill-[#8e8e93] font-mono"
                >
                  {label}
                </text>
              );
            })}
          </svg>

          {/* Floating Hover Tooltip */}
          {hoveredIndex !== null && points[hoveredIndex] && (
            <div
              className="absolute pointer-events-none bg-[#2c2c2e] border border-[#3a3a3c] rounded-lg px-2.5 py-1.5 shadow-xl text-xs -translate-x-1/2 -translate-y-full"
              style={{
                left: `${(points[hoveredIndex].x / svgWidth) * 100}%`,
                top: `${(points[hoveredIndex].y / svgHeight) * 100 - 4}%`,
              }}
            >
              <p className="font-mono text-[10px] text-[#8e8e93]">{points[hoveredIndex].point.bucketStart}</p>
              <p className="font-bold text-white mt-0.5">
                <span style={{ color: metricColor }}>{points[hoveredIndex].point[metric]}</span> {metric === 'clients' ? 'clients' : 'apps'}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
