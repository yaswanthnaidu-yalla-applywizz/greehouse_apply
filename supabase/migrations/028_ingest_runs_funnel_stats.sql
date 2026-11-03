-- 028_ingest_runs_funnel_stats.sql
ALTER TABLE ingest_runs
  ADD COLUMN IF NOT EXISTS funnel_stats jsonb DEFAULT NULL;

COMMENT ON COLUMN ingest_runs.funnel_stats IS
  'Structured drop-off funnel info: totalRows, tasksCreated, droppedRows, dropReasons, droppedDetails';
