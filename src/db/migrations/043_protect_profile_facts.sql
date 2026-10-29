-- Migration 043: Protect profile contact, demographic, and identity facts against accidental overwrites/wipes
-- Enforces field authority: once populated, protected fields cannot be overwritten by generic upserts.
-- Trusted updates / overrides must set app.profile_authoritative_override = 'on' in the transaction/session.

CREATE OR REPLACE FUNCTION protect_profile_facts()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  allow_override boolean := coalesce(
    current_setting('app.profile_authoritative_override', true),
    'off'
  ) = 'on';
  attempted jsonb := '{}'::jsonb;
  preserved jsonb := '{}'::jsonb;
BEGIN
  IF allow_override THEN
    INSERT INTO gh_audit_events(actor_role, action, target_type, target_id, metadata)
    VALUES (
      'system',
      'profile_override',
      'profile',
      OLD.applywizz_id,
      jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW))
    );
    RETURN NEW;
  END IF;

  -- 1. Identity
  IF nullif(btrim(OLD.first_name), '') IS NOT NULL AND NEW.first_name IS DISTINCT FROM OLD.first_name THEN
    attempted := attempted || jsonb_build_object('first_name', NEW.first_name);
    preserved := preserved || jsonb_build_object('first_name', OLD.first_name);
    NEW.first_name := OLD.first_name;
  END IF;
  IF nullif(btrim(OLD.last_name), '') IS NOT NULL AND NEW.last_name IS DISTINCT FROM OLD.last_name THEN
    attempted := attempted || jsonb_build_object('last_name', NEW.last_name);
    preserved := preserved || jsonb_build_object('last_name', OLD.last_name);
    NEW.last_name := OLD.last_name;
  END IF;

  -- 2. Contact & Demographic
  IF nullif(btrim(OLD.phone), '') IS NOT NULL AND NEW.phone IS DISTINCT FROM OLD.phone THEN
    attempted := attempted || jsonb_build_object('phone', NEW.phone);
    preserved := preserved || jsonb_build_object('phone', OLD.phone);
    NEW.phone := OLD.phone;
  END IF;
  IF nullif(btrim(OLD.country), '') IS NOT NULL AND NEW.country IS DISTINCT FROM OLD.country THEN
    attempted := attempted || jsonb_build_object('country', NEW.country);
    preserved := preserved || jsonb_build_object('country', OLD.country);
    NEW.country := OLD.country;
  END IF;
  IF nullif(btrim(OLD.country_code), '') IS NOT NULL AND NEW.country_code IS DISTINCT FROM OLD.country_code THEN
    attempted := attempted || jsonb_build_object('country_code', NEW.country_code);
    preserved := preserved || jsonb_build_object('country_code', OLD.country_code);
    NEW.country_code := OLD.country_code;
  END IF;
  IF nullif(btrim(OLD.location), '') IS NOT NULL AND NEW.location IS DISTINCT FROM OLD.location THEN
    attempted := attempted || jsonb_build_object('location', NEW.location);
    preserved := preserved || jsonb_build_object('location', OLD.location);
    NEW.location := OLD.location;
  END IF;
  IF nullif(btrim(OLD.linkedin_url), '') IS NOT NULL AND NEW.linkedin_url IS DISTINCT FROM OLD.linkedin_url THEN
    attempted := attempted || jsonb_build_object('linkedin_url', NEW.linkedin_url);
    preserved := preserved || jsonb_build_object('linkedin_url', OLD.linkedin_url);
    NEW.linkedin_url := OLD.linkedin_url;
  END IF;
  IF nullif(btrim(OLD.website_url), '') IS NOT NULL AND NEW.website_url IS DISTINCT FROM OLD.website_url THEN
    attempted := attempted || jsonb_build_object('website_url', NEW.website_url);
    preserved := preserved || jsonb_build_object('website_url', OLD.website_url);
    NEW.website_url := OLD.website_url;
  END IF;
  IF nullif(btrim(OLD.github_url), '') IS NOT NULL AND NEW.github_url IS DISTINCT FROM OLD.github_url THEN
    attempted := attempted || jsonb_build_object('github_url', NEW.github_url);
    preserved := preserved || jsonb_build_object('github_url', OLD.github_url);
    NEW.github_url := OLD.github_url;
  END IF;

  -- 3. Professional Facts
  IF nullif(btrim(OLD.work_authorization), '') IS NOT NULL AND NEW.work_authorization IS DISTINCT FROM OLD.work_authorization THEN
    attempted := attempted || jsonb_build_object('work_authorization', NEW.work_authorization);
    preserved := preserved || jsonb_build_object('work_authorization', OLD.work_authorization);
    NEW.work_authorization := OLD.work_authorization;
  END IF;
  IF OLD.requires_sponsorship IS NOT NULL AND NEW.requires_sponsorship IS DISTINCT FROM OLD.requires_sponsorship THEN
    attempted := attempted || jsonb_build_object('requires_sponsorship', NEW.requires_sponsorship);
    preserved := preserved || jsonb_build_object('requires_sponsorship', OLD.requires_sponsorship);
    NEW.requires_sponsorship := OLD.requires_sponsorship;
  END IF;
  IF OLD.education IS NOT NULL AND OLD.education <> '[]'::jsonb AND NEW.education IS DISTINCT FROM OLD.education THEN
    attempted := attempted || jsonb_build_object('education', NEW.education);
    preserved := preserved || jsonb_build_object('education', OLD.education);
    NEW.education := OLD.education;
  END IF;
  IF OLD.work_experience IS NOT NULL AND OLD.work_experience <> '[]'::jsonb AND NEW.work_experience IS DISTINCT FROM OLD.work_experience THEN
    attempted := attempted || jsonb_build_object('work_experience', NEW.work_experience);
    preserved := preserved || jsonb_build_object('work_experience', OLD.work_experience);
    NEW.work_experience := OLD.work_experience;
  END IF;

  IF attempted <> '{}'::jsonb THEN
    INSERT INTO gh_audit_events(actor_role, action, target_type, target_id, metadata)
    VALUES (
      'system',
      'profile_overwrite_blocked',
      'profile',
      OLD.applywizz_id,
      jsonb_build_object('attempted', attempted, 'preserved', preserved)
    );
  END IF;

  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS trg_protect_profile_facts ON profiles;
CREATE TRIGGER trg_protect_profile_facts
BEFORE UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION protect_profile_facts();
