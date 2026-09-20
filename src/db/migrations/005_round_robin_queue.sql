-- ============================================================================
-- Migration 005: Round-Robin Queue Scheduling & Submission Daemon (Phase V2-4c)
-- File: src/db/migrations/005_round_robin_queue.sql
-- ============================================================================

-- 1. Add submission_order and assigned_ca_email to gh_candidate_applications
ALTER TABLE gh_candidate_applications
  ADD COLUMN IF NOT EXISTS submission_order INTEGER,
  ADD COLUMN IF NOT EXISTS assigned_ca_email TEXT;

-- 2. Update status CHECK constraint to include 'QUEUED'
ALTER TABLE gh_candidate_applications
  DROP CONSTRAINT IF EXISTS gh_candidate_applications_status_check;

ALTER TABLE gh_candidate_applications
  ADD CONSTRAINT gh_candidate_applications_status_check
  CHECK (status IN (
    'READY_FOR_REVIEW',
    'DRY_RUN_COMPLETE',
    'QUEUED',
    'APPLYING',
    'APPLIED',
    'FAILED',
    'EXPIRED',
    'OTP_REQUIRED',
    'CAPTCHA_TIMEOUT'
  ));

-- 3. Create index for fast FIFO queue lookups
CREATE INDEX IF NOT EXISTS idx_applications_submission_order
  ON gh_candidate_applications(submission_order ASC)
  WHERE status = 'QUEUED';

-- 4. Create atomic stored procedure with FOR UPDATE SKIP LOCKED
CREATE OR REPLACE FUNCTION get_next_queued_application()
RETURNS SETOF gh_candidate_applications AS $$
DECLARE
    selected_row gh_candidate_applications%ROWTYPE;
BEGIN
    SELECT * INTO selected_row
    FROM gh_candidate_applications
    WHERE status = 'QUEUED'
    ORDER BY submission_order ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF FOUND THEN
        UPDATE gh_candidate_applications
        SET status = 'APPLYING', updated_at = now()
        WHERE id = selected_row.id;

        selected_row.status := 'APPLYING';
        RETURN NEXT selected_row;
    END IF;
    RETURN;
END;
$$ LANGUAGE plpgsql;
