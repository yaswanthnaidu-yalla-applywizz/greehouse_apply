-- Migration 023: Backfill the canonical submission timestamp for legacy rows.

UPDATE gh_candidate_applications
SET submitted_at = updated_at
WHERE submitted_at IS NULL
  AND updated_at IS NOT NULL;
