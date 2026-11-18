-- A unique daily claim coordinates the scheduler across server instances.
CREATE TABLE IF NOT EXISTS public.gh_executive_daily_report_sends (
  report_date date PRIMARY KEY,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gh_executive_daily_report_sends ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.gh_executive_daily_report_sends TO service_role;
