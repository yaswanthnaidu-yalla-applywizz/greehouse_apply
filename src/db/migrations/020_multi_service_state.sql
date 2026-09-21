-- Migration 020: Multi-service shared state foundation
-- Tables: ingest_runs, system_worker_heartbeats, system_config
-- Backfill: Assign newly resolved applications to their candidate's CA email from profiles
-- Apply via Supabase SQL Editor.

-- 1. ingest_runs
CREATE TABLE IF NOT EXISTS ingest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'aborted')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  processed_count INTEGER DEFAULT 0,
  processed_file TEXT,
  phase TEXT,
  message TEXT,
  error TEXT,
  triggered_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_started_at ON ingest_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_status ON ingest_runs (status);

-- 2. system_worker_heartbeats
CREATE TABLE IF NOT EXISTS system_worker_heartbeats (
  service_name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  worker_count INTEGER NOT NULL DEFAULT 0,
  idle_count INTEGER NOT NULL DEFAULT 0,
  in_flight_count INTEGER NOT NULL DEFAULT 0,
  in_flight_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  lane_lengths JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_worker_heartbeats_updated_at ON system_worker_heartbeats (updated_at DESC);

-- 3. system_config
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed submission_eligibility_gate_enabled = true
INSERT INTO system_config (key, value, updated_at)
VALUES ('submission_eligibility_gate_enabled', 'true'::jsonb, now())
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = now();

-- Enable RLS and grant service_role full access
ALTER TABLE ingest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service_role full access to ingest_runs" ON ingest_runs;
CREATE POLICY "Allow service_role full access to ingest_runs" ON ingest_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service_role full access to system_worker_heartbeats" ON system_worker_heartbeats;
CREATE POLICY "Allow service_role full access to system_worker_heartbeats" ON system_worker_heartbeats
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service_role full access to system_config" ON system_config;
CREATE POLICY "Allow service_role full access to system_config" ON system_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Allow authenticated users read access for dashboards
DROP POLICY IF EXISTS "Allow authenticated read ingest_runs" ON ingest_runs;
CREATE POLICY "Allow authenticated read ingest_runs" ON ingest_runs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow authenticated read system_worker_heartbeats" ON system_worker_heartbeats;
CREATE POLICY "Allow authenticated read system_worker_heartbeats" ON system_worker_heartbeats
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow authenticated read system_config" ON system_config;
CREATE POLICY "Allow authenticated read system_config" ON system_config
  FOR SELECT TO authenticated USING (true);

-- 4. Backfill assigned_ca_email on gh_candidate_applications from profiles
UPDATE gh_candidate_applications AS ca
SET assigned_ca_email = p.ca_email
FROM profiles AS p
WHERE ca.applywizz_id = p.applywizz_id
  AND ca.assigned_ca_email IS NULL
  AND p.ca_email IS NOT NULL;
