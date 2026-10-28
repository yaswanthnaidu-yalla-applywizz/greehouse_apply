-- Migration 041: Private stats invalidation broadcast trigger
-- Emits 'stats_changed' event with no row payload when application cohort data changes.
-- Does not emit on no-op updates (e.g. proof updates, updated_at changes without status/scope change).

CREATE OR REPLACE FUNCTION notify_application_stats_changed()
RETURNS TRIGGER AS $$
DECLARE
    should_notify BOOLEAN := false;
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' THEN
        should_notify := true;
    ELSIF TG_OP = 'UPDATE' THEN
        IF (OLD.status IS DISTINCT FROM NEW.status) OR
           (OLD.created_at IS DISTINCT FROM NEW.created_at) OR
           (OLD.applywizz_id IS DISTINCT FROM NEW.applywizz_id) OR
           (OLD.assigned_ca_email IS DISTINCT FROM NEW.assigned_ca_email) OR
           (OLD.first_attempted_at IS DISTINCT FROM NEW.first_attempted_at) THEN
            should_notify := true;
        END IF;
    END IF;

    IF should_notify THEN
        -- Broadcast through Supabase Realtime if extension is installed
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_proc p
                JOIN pg_namespace n ON p.pronamespace = n.oid
                WHERE n.nspname = 'realtime' AND p.proname = 'send'
            ) THEN
                PERFORM realtime.send(
                    jsonb_build_object('event', 'stats_changed'),
                    'stats_changed',
                    'stats_invalidation',
                    true
                );
            END IF;
        EXCEPTION WHEN OTHERS THEN
            -- Safe fallback if realtime schema is not active
        END;

        -- Local postgres notification
        PERFORM pg_notify('stats_changed', json_build_object('event', 'stats_changed')::text);
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gh_candidate_application_stats_changed ON gh_candidate_applications;
CREATE TRIGGER trg_gh_candidate_application_stats_changed
AFTER INSERT OR UPDATE OR DELETE ON gh_candidate_applications
FOR EACH ROW
EXECUTE FUNCTION notify_application_stats_changed();
