-- Migration 018: disable RLS on dashboard `users` (Express uses service_role; upserts on sign-in)
-- Apply in the Supabase SQL editor after confirming current state:
--
--   SELECT tablename, rowsecurity FROM pg_tables WHERE tablename IN ('gh_users', 'gh_audit_events');
--
-- `gh_audit_events` may remain rowsecurity=true (service_role policy only). This migration
-- only disables RLS on `users`.

DROP POLICY IF EXISTS "Allow service_role access to gh_users" ON gh_users;

ALTER TABLE gh_users DISABLE ROW LEVEL SECURITY;
