-- Run once in Supabase SQL Editor (idempotent)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS company_email TEXT;
CREATE INDEX IF NOT EXISTS idx_profiles_company_email ON profiles(company_email);
