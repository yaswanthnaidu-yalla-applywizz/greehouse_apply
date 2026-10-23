-- ============================================================================
-- Migration 038: Atomic Multi-Replica Email Proof Application Dequeueing RPC
-- File: src/db/migrations/038_claim_email_proof_application_rpc.sql
-- ============================================================================

-- 1. Create index for pending email proofs to optimize dequeue lookups
CREATE INDEX IF NOT EXISTS idx_applications_email_proof_pending
  ON gh_candidate_applications(submitted_at ASC NULLS LAST, created_at ASC)
  WHERE status = 'EMAIL_PROOF_PENDING';

-- 2. Atomic stored procedure with FOR UPDATE SKIP LOCKED
-- Selects next EMAIL_PROOF_PENDING row that is not currently being fetched,
-- marks it as 'fetching' and updates email_proof_attempted_at atomically.
CREATE OR REPLACE FUNCTION claim_next_email_proof_application()
RETURNS SETOF gh_candidate_applications AS $$
DECLARE
    selected_row gh_candidate_applications%ROWTYPE;
BEGIN
    SELECT ca.* INTO selected_row
    FROM gh_candidate_applications ca
    WHERE ca.status = 'EMAIL_PROOF_PENDING'
      AND (
        ca.email_proof_status IS NULL
        OR ca.email_proof_status IN ('pending', 'manual_review_needed', 'timed_out', 'queued_retry')
      )
    ORDER BY ca.submitted_at ASC NULLS LAST, ca.created_at ASC
    LIMIT 1
    FOR UPDATE OF ca SKIP LOCKED;

    IF FOUND THEN
        UPDATE gh_candidate_applications
        SET email_proof_status = 'fetching',
            email_proof_attempted_at = now(),
            updated_at = now()
        WHERE id = selected_row.id;

        selected_row.email_proof_status := 'fetching';
        selected_row.email_proof_attempted_at := now();
        selected_row.updated_at := now();
        RETURN NEXT selected_row;
    END IF;
    RETURN;
END;
$$ LANGUAGE plpgsql;
