-- Migration 015: audit_events + application_events for role dashboards
-- Apply in the Supabase SQL editor. Writers fail closed (log + continue) if
-- these tables are not present yet.

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_email TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events (action);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_email ON audit_events (actor_email);

CREATE TABLE IF NOT EXISTS application_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL,
  applywizz_id TEXT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_email TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_application_events_application_id ON application_events (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_application_events_created_at ON application_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_application_events_applywizz_id ON application_events (applywizz_id);

-- RLS: Express uses service_role (bypasses RLS). No anon/authenticated policies,
-- so a leaked publishable key cannot read audit or status timelines.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service_role access to audit_events" ON audit_events;
CREATE POLICY "Allow service_role access to audit_events" ON audit_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service_role access to application_events" ON application_events;
CREATE POLICY "Allow service_role access to application_events" ON application_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
