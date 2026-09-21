-- ============================================================================
-- Migration 021: pgvector semantic search for gh_candidate_qa_bank
-- Enables Tier 3 semantic resolution via match_candidate_qa RPC.
-- ============================================================================

-- 1. Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Add embedding column to qa_bank (idempotent)
ALTER TABLE gh_candidate_qa_bank
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- 3. HNSW index for fast cosine similarity search
--    (only on rows that have an embedding; partial index keeps it lean)
CREATE INDEX IF NOT EXISTS idx_qa_bank_embedding
  ON gh_candidate_qa_bank
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- 4. Drop old version of the function if it exists (safe re-run)
DROP FUNCTION IF EXISTS match_candidate_qa(vector, text, float, int);

-- 5. Create the RPC function called by semanticSearch.ts
--    Parameters must match supabase.rpc('match_candidate_qa', { query_vector, match_applywizz_id, match_threshold, match_count })
CREATE OR REPLACE FUNCTION match_candidate_qa(
  query_vector     vector(1536),
  match_applywizz_id text,
  match_threshold  float,
  match_count      int
)
RETURNS TABLE (
  value       text,
  similarity  float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    q.value,
    (1 - (q.embedding <=> query_vector))::float AS similarity
  FROM gh_candidate_qa_bank q
  WHERE
    q.applywizz_id = match_applywizz_id
    AND q.embedding IS NOT NULL
    AND (1 - (q.embedding <=> query_vector)) >= match_threshold
  ORDER BY q.embedding <=> query_vector
  LIMIT match_count;
END;
$$;

-- 6. Grant execute to service_role (used by the Node.js server)
GRANT EXECUTE ON FUNCTION match_candidate_qa(vector, text, float, int) TO service_role;
