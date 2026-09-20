-- Enable Supabase Realtime for gh_candidate_applications (status + proof columns)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'gh_candidate_applications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE gh_candidate_applications;
  END IF;
END $$;
