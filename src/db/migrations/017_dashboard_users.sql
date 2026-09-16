-- Migration 017: dashboard users (operator → manager mapping on sign-in)
-- Apply in the Supabase SQL editor. Writers log once and continue if missing.

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL,
  manager_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_manager_email ON users (manager_email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service_role access to users" ON users;
CREATE POLICY "Allow service_role access to users"
  ON users
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
