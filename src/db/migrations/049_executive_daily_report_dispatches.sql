CREATE TABLE IF NOT EXISTS public.gh_executive_daily_report_dispatches (
  scheduled_date DATE NOT NULL,
  recipient_group TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scheduled_date, recipient_group)
);

ALTER TABLE public.gh_executive_daily_report_dispatches ENABLE ROW LEVEL SECURITY;
GRANT INSERT ON public.gh_executive_daily_report_dispatches TO service_role;
