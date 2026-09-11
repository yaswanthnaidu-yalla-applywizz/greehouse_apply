-- Enable Supabase Realtime for candidate_applications (status + proof columns)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'candidate_applications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE candidate_applications;
  END IF;
END $$;
