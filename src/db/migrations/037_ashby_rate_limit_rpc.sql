-- ============================================================================
-- Migration 037: Ashby Rate-Limiting Guards in get_next_queued_application()
-- File: src/db/migrations/037_ashby_rate_limit_rpc.sql
-- ============================================================================

CREATE OR REPLACE FUNCTION get_next_queued_application()
RETURNS SETOF gh_candidate_applications AS $$
DECLARE
    selected_row gh_candidate_applications%ROWTYPE;
BEGIN
    WITH candidate_history AS (
        SELECT applywizz_id, COUNT(*) AS processed_count
        FROM gh_candidate_applications
        WHERE status IN ('APPLYING', 'APPLIED', 'FAILED', 'RETRY', 'EMAIL_PROOF_PENDING')
        GROUP BY applywizz_id
    ),
    queued_ranks AS (
        SELECT id,
               applywizz_id,
               submission_order,
               ats,
               scheduled_not_before,
               template_id,
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
               qr.submission_order,
               qr.ats,
               qr.scheduled_not_before,
               qr.applywizz_id,
               qr.template_id
        FROM queued_ranks qr
        LEFT JOIN candidate_history ch ON qr.applywizz_id = ch.applywizz_id
    ),
    company_last_submitted AS (
        -- Last Ashby submission time per company (for inter-company 20-min gate)
        SELECT t.company_name, MAX(ca.updated_at) AS last_submitted_at
        FROM gh_candidate_applications ca
        JOIN gh_scanned_job_templates t ON ca.template_id = t.id::text
        WHERE ca.ats = 'ashby'
          AND ca.status IN ('APPLIED', 'EMAIL_PROOF_PENDING', 'APPLYING')
        GROUP BY t.company_name
    ),
    candidate_company_last AS (
        -- Last Ashby submission per (candidate, company) — for 48-hr same-company block
        SELECT ca.applywizz_id, t.company_name, MAX(ca.updated_at) AS last_submitted_at
        FROM gh_candidate_applications ca
        JOIN gh_scanned_job_templates t ON ca.template_id = t.id::text
        WHERE ca.ats = 'ashby'
          AND ca.status IN ('APPLIED', 'EMAIL_PROOF_PENDING', 'APPLYING')
        GROUP BY ca.applywizz_id, t.company_name
    )
    SELECT ca.* INTO selected_row
    FROM gh_candidate_applications ca
    JOIN ranked_candidates rc ON ca.id = rc.id
    LEFT JOIN gh_scanned_job_templates t ON ca.template_id = t.id::text
    LEFT JOIN company_last_submitted cls ON t.company_name = cls.company_name
    LEFT JOIN candidate_company_last ccl
      ON rc.applywizz_id = ccl.applywizz_id AND t.company_name = ccl.company_name
    WHERE ca.status = 'QUEUED'
      -- Ashby-only rate limiting guards (Greenhouse rows always pass)
      AND (
        ca.ats != 'ashby'
        OR (
          -- Guard 1: per-client random wait (scheduled_not_before)
          (ca.scheduled_not_before IS NULL OR ca.scheduled_not_before <= now())
          -- Guard 2: 48-hr same-company-per-client block
          AND (ccl.last_submitted_at IS NULL OR ccl.last_submitted_at < now() - INTERVAL '48 hours')
          -- Guard 3: 20-min inter-company gate
          AND (cls.last_submitted_at IS NULL OR cls.last_submitted_at < now() - INTERVAL '20 minutes')
        )
      )
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
