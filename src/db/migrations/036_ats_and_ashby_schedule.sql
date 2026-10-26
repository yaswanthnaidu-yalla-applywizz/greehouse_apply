-- ============================================================================
-- Migration 036: Add ATS column and Ashby rate limit scheduling
-- File: src/db/migrations/036_ats_and_ashby_schedule.sql
-- ============================================================================

ALTER TABLE gh_scanned_job_templates
  ADD COLUMN IF NOT EXISTS ats TEXT NOT NULL DEFAULT 'greenhouse';

ALTER TABLE gh_candidate_applications
  ADD COLUMN IF NOT EXISTS ats TEXT NOT NULL DEFAULT 'greenhouse',
  ADD COLUMN IF NOT EXISTS scheduled_not_before TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_applications_ashby_schedule
  ON gh_candidate_applications(applywizz_id, scheduled_not_before)
  WHERE ats = 'ashby' AND status = 'QUEUED';
