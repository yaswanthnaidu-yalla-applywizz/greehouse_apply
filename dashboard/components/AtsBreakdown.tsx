import React from 'react';

export type AtsBreakdownCounts = Record<'greenhouse' | 'ashby', {
  total: number | null;
  submitted: number | null;
  applied: number | null;
  failed: number | null;
}>;

export const AtsBreakdown: React.FC<{
  counts?: AtsBreakdownCounts;
  metric: 'total' | 'submitted' | 'applied' | 'failed';
  available?: boolean;
}> = ({ counts, metric, available = true }) => {
  if (!counts || !available) return null;
  return <p className="text-[11px] font-mono text-[#8e8e93] mt-1">GH {counts.greenhouse[metric] ?? 0} · Ashby {counts.ashby[metric] ?? 0}</p>;
};
