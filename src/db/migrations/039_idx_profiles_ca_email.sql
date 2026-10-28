-- Migration 039: Index profiles(ca_email) for fast database-driven operator scoping
CREATE INDEX IF NOT EXISTS idx_profiles_ca_email ON profiles(ca_email);
