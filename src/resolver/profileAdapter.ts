import type { ApplyWizzCandidateProfile } from '../types/index.js';
import type { ProfileRow } from '../db/profiles.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Profile Adapter');

export interface PayloadContext {
  personal: Record<string, unknown>;
  work_authorization: Record<string, unknown>;
  compensation: Record<string, unknown>;
  preferences: Record<string, unknown>;
  education: Record<string, unknown>;
  experience: Record<string, unknown>;
  background: Record<string, unknown>;
  eeoc: Record<string, unknown>;
  other: Record<string, unknown>;
}

type ProfileWithPayload = (ProfileRow | ApplyWizzCandidateProfile) & {
  raw_api_payload?: Record<string, any> | null;
};

export function buildPayloadContext(profile: ProfileWithPayload): PayloadContext {
  const payload = profile.raw_api_payload || {};
  const client = payload.client || {};
  const additional = payload.additional_information || {};
  const value = (stored: unknown, raw: unknown): unknown =>
    stored !== undefined && stored !== null && stored !== '' ? stored : raw;
  const rawValue = (raw: unknown, stored: unknown): unknown =>
    raw !== undefined && raw !== null && raw !== '' ? raw : stored;

  const payloadContext = {
    personal: {
      name: rawValue(client.full_name, 'client_name' in profile ? profile.client_name : profile.clientName),
      personal_email: rawValue(client.personal_email, profile.email),
      company_email: rawValue(client.company_email, 'company_email' in profile ? profile.company_email : undefined),
      phone: value('phone' in profile ? profile.phone : profile.phone, undefined),
      full_address: additional.full_address,
      date_of_birth: additional.date_of_birth,
      gender: additional.gender,
    },
    work_authorization: {
      eligible_to_work_in_us: additional.eligible_to_work_in_us,
      authorized_without_visa: additional.authorized_without_visa,
      require_future_sponsorship: additional.require_future_sponsorship,
      visa_type: rawValue(client.visa_type, 'work_authorization' in profile ? profile.work_authorization : undefined),
      work_auth_details: client.work_auth_details,
    },
    compensation: { salary_range: client.salary_range },
    preferences: {
      job_roles: client.job_role_preferences,
      location_preferences: client.location_preferences,
      desired_start_date: additional.desired_start_date,
      willing_to_relocate: additional.willing_to_relocate,
      can_work_3_days_in_office: additional.can_work_3_days_in_office,
    },
    education: {
      highest_education: additional.highest_education,
      university_name: additional.university_name,
      cumulative_gpa: additional.cumulative_gpa,
      graduation_year: additional.graduation_year,
      main_subject: additional.main_subject,
    },
    experience: {
      years: additional.experience,
      role: additional.role,
      alternate_job_roles: additional.alternate_job_roles,
    },
    background: {
      willing_background_check: additional.willing_background_check,
      willing_drug_screen: additional.willing_drug_screen,
      failed_or_refused_drug_test: additional.failed_or_refused_drug_test,
      convicted_of_felony: additional.convicted_of_felony,
      pending_investigation: additional.pending_investigation,
      uses_substances_affecting_duties: additional.uses_substances_affecting_duties,
      can_provide_legal_docs: additional.can_provide_legal_docs,
      discharged_for_policy_violation: additional.discharged_for_policy_violation,
      referred_by_agency: additional.referred_by_agency,
      worked_for_company_before: additional.worked_for_company_before,
    },
    eeoc: {
      gender: additional.gender,
      is_hispanic_latino: additional.is_hispanic_latino,
      race_ethnicity: additional.race_ethnicity,
      veteran_status: additional.veteran_status,
      disability_status: additional.disability_status,
    },
    other: {
      has_relatives_in_company: additional.has_relatives_in_company,
      can_perform_essential_functions: additional.can_perform_essential_functions,
      willing_to_relocate: additional.willing_to_relocate,
      github_url: additional.github_url,
      linked_in_url: additional.linked_in_url,
    },
  };

  if (profile.raw_api_payload) {
    log.debug(
      `[T5] payloadContext built: gender=${additional.gender} race=${additional.race_ethnicity} salary=${client.salary_range}`
    );
  }

  return payloadContext;
}
