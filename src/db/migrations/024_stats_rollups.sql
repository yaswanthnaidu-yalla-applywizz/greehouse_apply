CREATE TABLE IF NOT EXISTS gh_stats_rollups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_type TEXT NOT NULL CHECK (period_type IN ('day', 'week', 'month')),
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    total_applications INT NOT NULL DEFAULT 0,
    submitted_count INT NOT NULL DEFAULT 0,
    applied_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(period_type, period_start)
);

-- Index to optimize API range queries
CREATE INDEX idx_gh_stats_rollups_period ON gh_stats_rollups(period_type, period_start, period_end);
