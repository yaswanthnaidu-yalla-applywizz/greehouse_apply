-- Migration 019: CSV job score + scanned field count for submission eligibility gate
-- Apply in Supabase SQL editor. Writers continue if columns missing until applied.

ALTER TABLE gh_candidate_applications
  ADD COLUMN IF NOT EXISTS csv_job_score DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS field_count INTEGER;
