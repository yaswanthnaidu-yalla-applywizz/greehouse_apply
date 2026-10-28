-- An Ashby success blocks this candidate from another application for one hour.
-- An Ashby success also blocks the same candidate and company for 48 hours.
-- Candidate advisory locks serialize claims across submitter workers.
UPDATE gh_candidate_applications
SET scheduled_not_before = NULL
WHERE ats = 'ashby' AND status = 'QUEUED' AND scheduled_not_before IS NOT NULL;

CREATE OR REPLACE FUNCTION ashby_company_identity(company_name text, job_url text)
RETURNS text AS $$
    SELECT CASE
        WHEN nullif(trim(company_name), '') IS NOT NULL AND lower(trim(company_name)) <> 'company'
            THEN lower(regexp_replace(company_name, '[^[:alnum:]]+', '', 'g'))
        WHEN lower(split_part(job_url, '/', 3)) = 'jobs.ashbyhq.com'
            THEN lower(split_part(job_url, '/', 4))
        ELSE lower(split_part(job_url, '/', 3))
    END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION get_next_queued_application()
RETURNS SETOF gh_candidate_applications AS $$
DECLARE
    candidate_row gh_candidate_applications%ROWTYPE;
    claimed_row gh_candidate_applications%ROWTYPE;
BEGIN
    FOR candidate_row IN
        WITH candidate_history AS (
            SELECT applywizz_id, COUNT(*) AS processed_count
            FROM gh_candidate_applications
            WHERE status IN ('APPLYING', 'APPLIED', 'FAILED', 'RETRY', 'EMAIL_PROOF_PENDING')
            GROUP BY applywizz_id
        ), queued_ranks AS (
            SELECT id, applywizz_id, submission_order,
                   ROW_NUMBER() OVER (
                       PARTITION BY applywizz_id
                       ORDER BY submission_order ASC NULLS LAST, created_at ASC
                   ) AS queued_position
            FROM gh_candidate_applications
            WHERE status = 'QUEUED'
        )
        SELECT ca.*
        FROM gh_candidate_applications ca
        JOIN queued_ranks qr ON qr.id = ca.id
        LEFT JOIN candidate_history ch ON ch.applywizz_id = ca.applywizz_id
        WHERE ca.status = 'QUEUED'
        ORDER BY COALESCE(ch.processed_count, 0) + qr.queued_position,
                 ca.submission_order ASC NULLS LAST, ca.created_at ASC
        FOR UPDATE OF ca SKIP LOCKED
    LOOP
        IF NOT pg_try_advisory_xact_lock(hashtextextended(candidate_row.applywizz_id, 0)) THEN
            CONTINUE;
        END IF;

        -- In-flight attempts must finish before another claim. Failed attempts
        -- impose no timed delay; only a persisted success starts the clock.
        IF EXISTS (
            SELECT 1 FROM gh_candidate_applications prior
            WHERE prior.applywizz_id = candidate_row.applywizz_id
              AND prior.status = 'APPLYING'
        ) OR (candidate_row.ats = 'ashby' AND EXISTS (
            SELECT 1 FROM gh_candidate_applications prior
            WHERE prior.applywizz_id = candidate_row.applywizz_id
              AND prior.status IN ('APPLIED', 'EMAIL_PROOF_PENDING')
              AND prior.submitted_at > now() - INTERVAL '1 hour'
        )) THEN
            CONTINUE;
        END IF;

        IF candidate_row.ats = 'ashby' THEN
            IF EXISTS (
                SELECT 1 FROM gh_candidate_applications prior
                WHERE prior.applywizz_id = candidate_row.applywizz_id
                  AND prior.ats = 'ashby'
                  AND prior.status IN ('APPLIED', 'EMAIL_PROOF_PENDING')
                  AND prior.submitted_at > now() - INTERVAL '48 hours'
                  AND (
                      ashby_company_identity(prior.company_name, prior.job_url) =
                          ashby_company_identity(candidate_row.company_name, candidate_row.job_url)
                      OR (
                          lower(split_part(prior.job_url, '/', 3)) = 'jobs.ashbyhq.com'
                          AND lower(split_part(candidate_row.job_url, '/', 3)) = 'jobs.ashbyhq.com'
                          AND lower(split_part(prior.job_url, '/', 4)) =
                              lower(split_part(candidate_row.job_url, '/', 4))
                      )
                  )
            ) THEN
                CONTINUE;
            END IF;
        END IF;

        UPDATE gh_candidate_applications
        SET status = 'APPLYING', updated_at = now()
        WHERE id = candidate_row.id AND status = 'QUEUED'
        RETURNING * INTO claimed_row;

        IF FOUND THEN
            RETURN NEXT claimed_row;
            RETURN;
        END IF;
    END LOOP;
    RETURN;
END;
$$ LANGUAGE plpgsql;
