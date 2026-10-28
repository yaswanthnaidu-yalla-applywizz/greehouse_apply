-- Migration 040: Add first_attempted_at marker and trigger to gh_candidate_applications
-- Tracks the first time an application transitions into an attempted state.
-- Attempted statuses: NOT IN ('READY_FOR_REVIEW', 'SKIPPED', 'FILTERED_OUT')

ALTER TABLE gh_candidate_applications
ADD COLUMN IF NOT EXISTS first_attempted_at TIMESTAMPTZ;

-- Function & Trigger: Idempotent first-attempt marker
CREATE OR REPLACE FUNCTION set_gh_candidate_application_first_attempt()
RETURNS TRIGGER AS $$
BEGIN
    -- Idempotent first-attempt marker: once set, never clear
    IF NEW.first_attempted_at IS NULL THEN
        IF NEW.status NOT IN ('READY_FOR_REVIEW', 'SKIPPED', 'FILTERED_OUT') THEN
            NEW.first_attempted_at := COALESCE(NEW.submitted_at, now());
        ELSIF OLD IS NOT NULL AND OLD.first_attempted_at IS NOT NULL THEN
            NEW.first_attempted_at := OLD.first_attempted_at;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gh_candidate_application_first_attempt ON gh_candidate_applications;
CREATE TRIGGER trg_gh_candidate_application_first_attempt
BEFORE INSERT OR UPDATE ON gh_candidate_applications
FOR EACH ROW
EXECUTE FUNCTION set_gh_candidate_application_first_attempt();

-- Backfill from current attempted status
UPDATE gh_candidate_applications
SET first_attempted_at = COALESCE(submitted_at, updated_at, created_at)
WHERE first_attempted_at IS NULL
  AND status NOT IN ('READY_FOR_REVIEW', 'SKIPPED', 'FILTERED_OUT');

-- Backfill from facts for applications that were attempted but later moved to an unattempted status
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gh_application_stats_daily') THEN
        UPDATE gh_candidate_applications ca
        SET first_attempted_at = COALESCE(ca.submitted_at, ca.updated_at, ca.created_at)
        WHERE ca.first_attempted_at IS NULL
          AND EXISTS (
              SELECT 1 FROM gh_application_stats_daily s
              WHERE s.application_id = ca.id::text
                AND s.metric IN ('submitted', 'applied', 'failed')
          );
    END IF;
END $$;

-- Indexes for cohort date range and role-scoped queries
CREATE INDEX IF NOT EXISTS idx_candidate_applications_created_status
ON gh_candidate_applications (created_at DESC, status);

CREATE INDEX IF NOT EXISTS idx_candidate_applications_ca_created
ON gh_candidate_applications (assigned_ca_email, created_at DESC)
WHERE assigned_ca_email IS NOT NULL;
