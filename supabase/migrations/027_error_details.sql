-- 027_error_details.sql
ALTER TABLE gh_candidate_applications
  ADD COLUMN IF NOT EXISTS error_details jsonb DEFAULT NULL;

COMMENT ON COLUMN gh_candidate_applications.error_details IS
  'Structured failure info written at submission time. Fields: failingFields[], serverError, pageTitle, pageUrl, failureType, capturedAt';
