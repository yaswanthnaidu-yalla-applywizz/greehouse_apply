-- Migration 020: Persist automatic submission retry state.
ALTER TABLE candidate_applications
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
