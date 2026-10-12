-- ============================================================================
-- Migration 032: FILTERED_OUT application status & stats trigger exclusion
-- ============================================================================

-- 1. Update application status check constraint to include FILTERED_OUT
ALTER TABLE gh_candidate_applications
  DROP CONSTRAINT IF EXISTS candidate_applications_status_check;

ALTER TABLE gh_candidate_applications
  DROP CONSTRAINT IF EXISTS gh_candidate_applications_status_check;

ALTER TABLE gh_candidate_applications
  ADD CONSTRAINT candidate_applications_status_check
  CHECK (status IN (
    'READY_FOR_REVIEW',
    'APPROVED',
    'DRY_RUN_COMPLETE',
    'QUEUED',
    'APPLYING',
    'APPLIED',
    'FAILED',
    'RETRY',
    'EXPIRED',
    'OTP_REQUIRED',
    'EMAIL_PROOF_PENDING',
    'SKIPPED',
    'FILTERED_OUT'
  ));

-- 2. Update stats capture function to completely ignore FILTERED_OUT applications
CREATE OR REPLACE FUNCTION public.capture_gh_application_stats()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ca_email TEXT;
  v_manager_email TEXT;
  v_event_date DATE;
BEGIN
  -- Guard: Ignore FILTERED_OUT applications completely on insert and status transitions
  IF NEW.status = 'FILTERED_OUT' THEN
    RETURN NEW;
  END IF;

  SELECT lower(trim(COALESCE(NULLIF(NEW.assigned_ca_email, ''), p.ca_email, '')))
  INTO v_ca_email
  FROM (SELECT 1) AS seed
  LEFT JOIN profiles p ON p.applywizz_id = NEW.applywizz_id;

  SELECT lower(trim(COALESCE(u.manager_email, '')))
  INTO v_manager_email
  FROM gh_users u
  WHERE lower(trim(u.email)) = v_ca_email
    AND lower(trim(u.role)) = 'operator'
  LIMIT 1;

  IF TG_OP = 'INSERT' THEN
    v_event_date := timezone('Asia/Kolkata', COALESCE(NEW.created_at, statement_timestamp()))::date;
    PERFORM public.record_gh_application_stat(
      v_event_date, NEW.id, NEW.applywizz_id, 'total', v_manager_email, v_ca_email
    );
    RETURN NEW;
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  v_event_date := timezone('Asia/Kolkata', statement_timestamp())::date;
  IF NEW.status NOT IN ('READY_FOR_REVIEW', 'SKIPPED', 'FILTERED_OUT') THEN
    PERFORM public.record_gh_application_stat(
      v_event_date, NEW.id, NEW.applywizz_id, 'submitted', v_manager_email, v_ca_email
    );
  END IF;
  IF NEW.status IN ('APPLIED', 'EMAIL_PROOF_PENDING') THEN
    PERFORM public.record_gh_application_stat(
      v_event_date, NEW.id, NEW.applywizz_id, 'applied', v_manager_email, v_ca_email
    );
  END IF;
  IF NEW.status = 'FAILED' THEN
    PERFORM public.record_gh_application_stat(
      v_event_date, NEW.id, NEW.applywizz_id, 'failed', v_manager_email, v_ca_email
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_gh_application_stats()
  FROM PUBLIC, anon, authenticated;

-- 3. Recreate trigger with conditional guard
DROP TRIGGER IF EXISTS trg_capture_gh_application_stats ON gh_candidate_applications;
CREATE TRIGGER trg_capture_gh_application_stats
AFTER INSERT OR UPDATE OF status ON gh_candidate_applications
FOR EACH ROW
WHEN (NEW.status IS DISTINCT FROM 'FILTERED_OUT')
EXECUTE FUNCTION public.capture_gh_application_stats();
