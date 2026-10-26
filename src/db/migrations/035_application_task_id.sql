-- Migration 035: Add task_id column to gh_candidate_applications
-- Enables treating distinct tasks as independent applications and upserting by task_id

ALTER TABLE gh_candidate_applications
  ADD COLUMN IF NOT EXISTS task_id TEXT;

ALTER TABLE gh_candidate_applications
  ADD COLUMN IF NOT EXISTS legacy_application_key TEXT GENERATED ALWAYS AS (
    CASE WHEN task_id IS NULL THEN applywizz_id || chr(31) || job_url END
  ) STORED;

-- Unique constraint on task_id (Postgres permits multiple NULLs by default)
ALTER TABLE gh_candidate_applications
  DROP CONSTRAINT IF EXISTS uq_candidate_applications_task_id;

ALTER TABLE gh_candidate_applications
  ADD CONSTRAINT uq_candidate_applications_task_id UNIQUE (task_id);

-- Drop the old candidate+job pair constraint so different tasks can exist for the same candidate + job URL
ALTER TABLE gh_candidate_applications
  DROP CONSTRAINT IF EXISTS uq_candidate_application_pair;

DROP INDEX IF EXISTS uq_candidate_application_legacy_pair;

ALTER TABLE gh_candidate_applications
  DROP CONSTRAINT IF EXISTS uq_candidate_applications_legacy_key;

ALTER TABLE gh_candidate_applications
  ADD CONSTRAINT uq_candidate_applications_legacy_key UNIQUE (legacy_application_key);

-- Index for fast lookup by task_id
CREATE INDEX IF NOT EXISTS idx_candidate_applications_task_id
  ON gh_candidate_applications (task_id);

COMMENT ON COLUMN gh_candidate_applications.task_id IS
  'External task UUID differentiating application runs for a candidate and job URL';
