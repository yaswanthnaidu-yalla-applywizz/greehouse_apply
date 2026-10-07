CREATE TABLE IF NOT EXISTS gh_stats_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO gh_stats_config (key, value)
VALUES (
  'available_from',
  to_char((timezone('Asia/Kolkata', now())::date + 1), 'YYYY-MM-DD')
)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS gh_application_stats_daily (
  event_date DATE NOT NULL,
  application_id UUID NOT NULL,
  applywizz_id TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('total', 'submitted', 'applied', 'failed')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'manager', 'ca', 'manager_ca')),
  scope_key TEXT NOT NULL,
  manager_email TEXT,
  ca_email TEXT,
  PRIMARY KEY (event_date, application_id, metric, scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_gh_application_stats_daily_scope
  ON gh_application_stats_daily (scope_type, scope_key, metric, event_date);
CREATE INDEX IF NOT EXISTS idx_gh_application_stats_daily_candidate
  ON gh_application_stats_daily (applywizz_id, event_date);
CREATE INDEX IF NOT EXISTS idx_gh_application_stats_daily_manager_total
  ON gh_application_stats_daily (scope_key, event_date)
  WHERE scope_type = 'manager' AND metric = 'total';
CREATE INDEX IF NOT EXISTS idx_gh_application_stats_daily_manager_ca_owner
  ON gh_application_stats_daily (manager_email, event_date)
  WHERE scope_type = 'manager_ca';
ALTER TABLE gh_stats_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE gh_application_stats_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service_role access to gh_stats_config" ON gh_stats_config;
CREATE POLICY "Allow service_role access to gh_stats_config" ON gh_stats_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service_role access to gh_application_stats_daily" ON gh_application_stats_daily;
CREATE POLICY "Allow service_role access to gh_application_stats_daily" ON gh_application_stats_daily
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.record_gh_application_stat(
  p_event_date DATE,
  p_application_id UUID,
  p_applywizz_id TEXT,
  p_metric TEXT,
  p_manager_email TEXT,
  p_ca_email TEXT
)
RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO gh_application_stats_daily (
    event_date,
    application_id,
    applywizz_id,
    metric,
    scope_type,
    scope_key,
    manager_email,
    ca_email
  )
  SELECT
    p_event_date,
    p_application_id,
    p_applywizz_id,
    p_metric,
    scopes.scope_type,
    scopes.scope_key,
    NULLIF(p_manager_email, ''),
    NULLIF(p_ca_email, '')
  FROM (
    VALUES
      ('global'::TEXT, ''::TEXT),
      ('manager'::TEXT, NULLIF(p_manager_email, '')),
      ('ca'::TEXT, NULLIF(p_ca_email, '')),
      ('manager_ca'::TEXT, CASE
        WHEN NULLIF(p_manager_email, '') IS NOT NULL AND NULLIF(p_ca_email, '') IS NOT NULL
          THEN p_manager_email || '|' || p_ca_email
        ELSE NULL
      END)
  ) AS scopes(scope_type, scope_key)
  WHERE scopes.scope_key IS NOT NULL
  ON CONFLICT (event_date, application_id, metric, scope_type, scope_key) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.record_gh_application_stat(DATE, UUID, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;

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
  IF NEW.status NOT IN ('READY_FOR_REVIEW', 'SKIPPED') THEN
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

DROP TRIGGER IF EXISTS trg_capture_gh_application_stats ON gh_candidate_applications;
CREATE TRIGGER trg_capture_gh_application_stats
AFTER INSERT OR UPDATE OF status ON gh_candidate_applications
FOR EACH ROW
EXECUTE FUNCTION public.capture_gh_application_stats();
