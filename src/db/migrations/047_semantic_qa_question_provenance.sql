SET search_path TO extensions, public;

DROP FUNCTION IF EXISTS public.match_candidate_qa(vector, text, double precision, integer);

CREATE FUNCTION public.match_candidate_qa(
  query_vector vector(1536),
  match_applywizz_id text,
  match_threshold double precision,
  match_count integer
)
RETURNS TABLE (question_label text, value text, similarity double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public
AS $$
BEGIN
  RETURN QUERY
  SELECT q.question_label, q.value,
    (1 - (q.embedding <=> query_vector))::double precision
  FROM public.gh_candidate_qa_bank q
  WHERE q.applywizz_id = match_applywizz_id
    AND q.embedding IS NOT NULL
    AND (1 - (q.embedding <=> query_vector)) >= match_threshold
  ORDER BY q.embedding <=> query_vector
  LIMIT LEAST(GREATEST(match_count, 0), 10);
END;
$$;

GRANT EXECUTE ON FUNCTION public.match_candidate_qa(vector, text, double precision, integer) TO service_role;
