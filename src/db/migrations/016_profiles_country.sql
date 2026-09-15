-- Run once in Supabase SQL Editor (idempotent).
-- upsertProfile / ensureSupabaseProfile write country + country_code; the live
-- profiles table never received these columns, so new-row creates fail with
-- "Could not find the 'country' column of 'profiles' in the schema cache".
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS country_code TEXT;
