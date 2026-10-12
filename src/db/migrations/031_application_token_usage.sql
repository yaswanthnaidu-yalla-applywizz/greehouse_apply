-- ============================================================================
-- Migration 031: Application Token Usage Tracking
-- Tracks per-application LLM token metrics and dollar cost across AWS Bedrock
-- models (Amazon Nova 2 Lite, Titan Embeddings V2, etc.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS gh_application_token_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applywizz_id TEXT NOT NULL,
  job_url TEXT NOT NULL,
  role TEXT NOT NULL,
  application_id UUID REFERENCES gh_candidate_applications(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  token_cost NUMERIC(12, 6) NOT NULL DEFAULT 0.000000,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_application_token_usage UNIQUE (applywizz_id, job_url, date)
);

CREATE INDEX IF NOT EXISTS idx_gh_token_usage_applywizz
  ON gh_application_token_usage (applywizz_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_gh_token_usage_date
  ON gh_application_token_usage (date DESC);

CREATE INDEX IF NOT EXISTS idx_gh_token_usage_application_id
  ON gh_application_token_usage (application_id);

ALTER TABLE gh_application_token_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service_role access to gh_application_token_usage" ON gh_application_token_usage;
CREATE POLICY "Allow service_role access to gh_application_token_usage" ON gh_application_token_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);
