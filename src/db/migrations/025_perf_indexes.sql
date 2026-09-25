-- Migration 025: Add performance indexes for candidate application queries.
CREATE INDEX IF NOT EXISTS idx_applications_assigned_ca_created_at
  ON gh_candidate_applications (assigned_ca_email, created_at);

CREATE INDEX IF NOT EXISTS idx_applications_status_created_at
  ON gh_candidate_applications (status, created_at);

CREATE INDEX IF NOT EXISTS idx_applications_submitted_at
  ON gh_candidate_applications (submitted_at);

CREATE INDEX IF NOT EXISTS idx_applications_job_url
  ON gh_candidate_applications (job_url);
