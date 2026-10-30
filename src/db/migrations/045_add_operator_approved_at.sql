-- Migration 045: Separate explicit operator approval from reviewed/edited metadata.
ALTER TABLE gh_candidate_applications
  ADD COLUMN IF NOT EXISTS operator_approved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_applications_operator_approved_at
  ON gh_candidate_applications(operator_approved_at);
