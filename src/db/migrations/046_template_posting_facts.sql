-- Migration 046: Persist job posting location and structured facts on scanned templates.
ALTER TABLE gh_scanned_job_templates
  ADD COLUMN IF NOT EXISTS job_posting_location TEXT,
  ADD COLUMN IF NOT EXISTS job_posting_facts JSONB;
