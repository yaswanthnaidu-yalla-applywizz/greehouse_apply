-- Migration 017: dashboard users (operator → manager mapping on sign-in)
-- Apply in the Supabase SQL editor. Writers log once and continue if missing.

CREATE TABLE IF NOT EXISTS gh_users (
  email TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL,
  manager_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gh_users_manager_email ON gh_users (manager_email);
CREATE INDEX IF NOT EXISTS idx_gh_users_role ON gh_users (role);

ALTER TABLE gh_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service_role access to gh_users" ON gh_users;
CREATE POLICY "Allow service_role access to gh_users"
  ON gh_users
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
