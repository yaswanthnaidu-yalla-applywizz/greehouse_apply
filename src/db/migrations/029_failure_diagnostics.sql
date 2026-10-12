-- ============================================================================
-- Migration 029: Failure Diagnostics Store
-- Adds restricted service-role store for structured failure diagnostics across
-- SCAN, SYNC, RESOLVE, and SUBMIT phases, with run correlation and RLS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS gh_failure_diagnostics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phase TEXT NOT NULL CHECK (phase IN ('SCAN', 'SYNC', 'RESOLVE', 'SUBMIT')),
  stage TEXT NOT NULL CHECK (char_length(stage) <= 80),
  category TEXT NOT NULL CHECK (char_length(category) <= 80),
  reason TEXT NOT NULL CHECK (char_length(reason) <= 500),
  error_name TEXT CHECK (error_name IS NULL OR char_length(error_name) <= 80),
  error_code TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 100),
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  is_retryable BOOLEAN NOT NULL DEFAULT false,
  applywizz_id TEXT,
  application_id UUID REFERENCES gh_candidate_applications(id) ON DELETE SET NULL,
  run_id UUID,
  job_url_ref TEXT CHECK (job_url_ref IS NULL OR char_length(job_url_ref) <= 300),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 2048),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gh_failure_diagnostics_created_at
  ON gh_failure_diagnostics (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gh_failure_diagnostics_application_id
  ON gh_failure_diagnostics (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gh_failure_diagnostics_applywizz_id
  ON gh_failure_diagnostics (applywizz_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gh_failure_diagnostics_run_id
  ON gh_failure_diagnostics (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gh_failure_diagnostics_phase_category
  ON gh_failure_diagnostics (phase, category, created_at DESC);

ALTER TABLE gh_failure_diagnostics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service_role access to gh_failure_diagnostics" ON gh_failure_diagnostics;
CREATE POLICY "Allow service_role access to gh_failure_diagnostics" ON gh_failure_diagnostics
  FOR ALL TO service_role USING (true) WITH CHECK (true);
