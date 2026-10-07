WITH first_recorded_event AS (
  SELECT MIN(event_date) AS event_date
  FROM gh_application_stats_daily
  WHERE scope_type = 'global'
)
UPDATE gh_stats_config AS config
SET value = to_char(
  LEAST(
    config.value::date,
    COALESCE(first_recorded_event.event_date, timezone('Asia/Kolkata', now())::date)
  ),
  'YYYY-MM-DD'
)
FROM first_recorded_event
WHERE config.key = 'available_from'
  AND (
    first_recorded_event.event_date < config.value::date
    OR (
      first_recorded_event.event_date IS NULL
      AND config.value::date > timezone('Asia/Kolkata', now())::date
    )
  );
