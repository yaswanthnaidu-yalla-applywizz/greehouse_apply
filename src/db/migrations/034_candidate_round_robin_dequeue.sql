-- ============================================================================
-- Migration 034: Candidate-Level Round-Robin Queue Dequeueing
-- File: src/db/migrations/034_candidate_round_robin_dequeue.sql
-- ============================================================================

-- 1. Create composite index for partitioned round-robin queue lookups
CREATE INDEX IF NOT EXISTS idx_applications_round_robin_queue
  ON gh_candidate_applications(applywizz_id, submission_order ASC)
  WHERE status = 'QUEUED';

-- 2. Update atomic stored procedure with candidate round-robin fairness
-- Calculates candidate_rank: how many applications this candidate has already had
-- dequeued/processed (status != 'QUEUED') PLUS their 1-based order in the queued set.
-- Dequeues by candidate_rank ASC (Round 1 for all candidates first, then Round 2, etc.),
-- tie-broken by candidate baseline queued time and submission_order ASC.
CREATE OR REPLACE FUNCTION get_next_queued_application()
RETURNS SETOF gh_candidate_applications AS $$
DECLARE
    selected_row gh_candidate_applications%ROWTYPE;
BEGIN
    WITH candidate_history AS (
        -- Count how many applications each candidate has already had processed/in-flight
        SELECT applywizz_id, COUNT(*) AS processed_count
        FROM gh_candidate_applications
        WHERE status IN ('APPLYING', 'APPLIED', 'FAILED', 'RETRY', 'EMAIL_PROOF_PENDING')
        GROUP BY applywizz_id
    ),
    queued_ranks AS (
        -- Rank candidate's queued applications
        SELECT id,
               applywizz_id,
               submission_order,
               ROW_NUMBER() OVER (
                   PARTITION BY applywizz_id 
                   ORDER BY submission_order ASC NULLS LAST, created_at ASC
               ) AS queued_position
        FROM gh_candidate_applications
        WHERE status = 'QUEUED'
    ),
    ranked_candidates AS (
        SELECT qr.id,
               COALESCE(ch.processed_count, 0) + qr.queued_position AS candidate_rank,
               qr.submission_order
        FROM queued_ranks qr
        LEFT JOIN candidate_history ch ON qr.applywizz_id = ch.applywizz_id
    )
    SELECT ca.* INTO selected_row
    FROM gh_candidate_applications ca
    JOIN ranked_candidates rc ON ca.id = rc.id
    WHERE ca.status = 'QUEUED'
    ORDER BY rc.candidate_rank ASC, rc.submission_order ASC NULLS LAST
    LIMIT 1
    FOR UPDATE OF ca SKIP LOCKED;

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
