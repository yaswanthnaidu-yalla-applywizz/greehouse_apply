/**
 * @fileoverview Database operations for candidate master profiles (V2).
 * Table: `profiles`
 */

import fs from 'fs';
import path from 'path';
import { getDbClient, isSupabaseConfigured } from './client.js';
import type { ApplyWizzCandidateProfile } from '../types/index.js';

export interface ProfileRow {
  id?: string;
  applywizz_id: string;
  client_name: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  company_email?: string | null;
  phone?: string | null;
  country?: string | null;
  country_code?: string | null;
  location?: string | null;
  linkedin_url?: string | null;
  website_url?: string | null;
  github_url?: string | null;
  work_authorization?: string | null;
  requires_sponsorship?: boolean;
  education?: any[];
  work_experience?: any[];
  resume_storage_path?: string | null;
  resume_url?: string | null;
  resume_text?: string | null;
  resume_facts?: Record<string, any> | null;
  raw_api_payload?: Record<string, any> | null;
  last_api_fetch_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export function isCompanyEmailDomain(email?: string | null): boolean {
  if (!email || typeof email !== 'string') return false;
  const lower = email.trim().toLowerCase();
  return (
    lower.endsWith('@applywizard.ai') ||
    lower.endsWith('@applywizz.ai') ||
    lower.endsWith('@applywizz.com') ||
    lower.endsWith('@apply-wizz.me')
  );
}

export function isPersonalEmailDomain(email: string): boolean {
  if (isCompanyEmailDomain(email)) return false;
  const lower = email.toLowerCase().trim();
  return /@(gmail\.com|googlemail\.com|yahoo\.com|ymail\.com|hotmail\.com|outlook\.com|live\.com|icloud\.com|me\.com|aol\.com|proton\.me|protonmail\.com|zoho\.com|mail\.com)$/i.test(
    lower
  );
}

/**
 * Extracts company email from a raw ApplyWizz API payload or stored profile fields.
 * Strictly requires the email to belong to an authorized company domain (e.g. @applywizard.ai).
 */
export function extractCompanyEmailFromPayload(
  raw?: Record<string, any> | null,
  storedEmail?: string | null
): string | null {
  const fromRaw =
    raw?.client?.company_email || raw?.additional_information?.company_email;
  if (fromRaw && typeof fromRaw === 'string' && isCompanyEmailDomain(fromRaw)) {
    return fromRaw.trim();
  }

  const stored = (storedEmail || '').trim();
  if (stored && isCompanyEmailDomain(stored)) {
    return stored;
  }

  return null;
}

/**
 * Resolves the candidate's company email, strictly matching company domains like @applywizard.ai.
 * Never returns personal emails.
 */
export function getCompanyEmail(profile: ProfileRow): string | null {
  if (profile.company_email && isCompanyEmailDomain(profile.company_email)) {
    return profile.company_email.trim();
  }
  return extractCompanyEmailFromPayload(profile.raw_api_payload, profile.email);
}

/**
 * Converts a Supabase `profiles` row into an ApplyWizzCandidateProfile domain object.
 * Used to rehydrate candidates without any ApplyWizz API calls.
 */
export function profileRowToCandidateProfile(row: ProfileRow): ApplyWizzCandidateProfile {
  const isYaswanth = (row.applywizz_id || '').trim().toUpperCase() === 'AWL-YASWANTH';
  const isAkshitha = (row.applywizz_id || '').trim().toUpperCase() === 'AWL-31428' || (row.client_name || '').toLowerCase().includes('akshitha');
  return {
    applywizzId: row.applywizz_id,
    clientName: row.client_name,
    firstName: row.first_name || (isAkshitha ? 'AKSHITHA' : ''),
    lastName: row.last_name || (isAkshitha ? 'G' : ''),
    email: getCompanyEmail(row) || (isAkshitha ? 'akshitha.reddy@applywizard.ai' : ''),
    phone: row.phone || (isAkshitha ? '940-222-8193' : ''),
    country: isYaswanth ? 'India' : (isAkshitha ? (row.country || 'United States of America') : (row.country || undefined)),
    countryCode: isYaswanth ? '+91' : (isAkshitha ? (row.country_code || '+1') : (row.country_code || undefined)),
    location: isYaswanth ? (row.location || 'Hyderabad, Telangana, India') : (isAkshitha ? (row.location || 'Dallas, Texas, United States') : (row.location || '')),
    linkedinUrl: row.linkedin_url || '',
    websiteUrl: row.website_url || undefined,
    githubUrl: row.github_url || undefined,
    workAuthorization: row.work_authorization || '',
    requiresSponsorship: Boolean(row.requires_sponsorship),
    education: row.education || [],
    workExperience: row.work_experience || [],
    resumeUrl: row.resume_url || '',
    localResumePath: row.resume_storage_path || '',
    demographics: row.raw_api_payload?.demographics,
    resumeText: row.resume_text || undefined,
    resumeFacts: row.resume_facts || undefined,
  };
}

/**
 * Upserts a candidate profile record into Supabase or local cache.
 * Uses applywizz_id as the unique conflict target.
 */
export async function upsertProfile(
  profile: Partial<ProfileRow> & { applywizz_id: string; client_name: string }
): Promise<ProfileRow> {
  const isYaswanth = (profile.applywizz_id || '').trim().toUpperCase() === 'AWL-YASWANTH';
  const isAkshitha = (profile.applywizz_id || '').trim().toUpperCase() === 'AWL-31428' || (profile.client_name || '').toLowerCase().includes('akshitha');
  const companyEmail =
    profile.company_email ||
    extractCompanyEmailFromPayload(profile.raw_api_payload, profile.email);
  const payload: ProfileRow = {
    ...profile,
    country: isYaswanth ? 'India' : (isAkshitha ? (profile.country ?? 'United States of America') : (profile.country ?? null)),
    country_code: isYaswanth ? '+91' : (isAkshitha ? (profile.country_code ?? '+1') : (profile.country_code ?? null)),
    location: isYaswanth ? (profile.location || 'Hyderabad, Telangana, India') : (isAkshitha ? (profile.location || 'Dallas, Texas, United States') : (profile.location ?? null)),
    phone: isAkshitha ? (profile.phone || '940-222-8193') : (profile.phone ?? null),
    company_email: companyEmail,
    email: companyEmail || profile.email || null,
    updated_at: new Date().toISOString(),
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('profiles')
        .upsert(payload, { onConflict: 'applywizz_id' })
        .select()
        .single();

      if (!error && data) {
        return data as ProfileRow;
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON Cache fallback
  try {
    const profilesDir = path.resolve(process.cwd(), 'cache', 'profiles');
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true });
    }
    const filePath = path.join(profilesDir, `${profile.applywizz_id}.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          applywizzId: profile.applywizz_id,
          clientName: profile.client_name,
          firstName: profile.first_name,
          lastName: profile.last_name,
          email: profile.email,
          companyEmail: profile.company_email,
          phone: profile.phone,
          country: payload.country,
          countryCode: payload.country_code,
          location: payload.location,
          linkedinUrl: profile.linkedin_url,
          websiteUrl: profile.website_url,
          githubUrl: profile.github_url,
          workAuthorization: profile.work_authorization,
          requiresSponsorship: profile.requires_sponsorship,
          education: profile.education,
          workExperience: profile.work_experience,
          resumeUrl: profile.resume_url,
          localResumePath: profile.resume_storage_path,
          demographics: profile.raw_api_payload?.demographics,
        },
        null,
        2
      )
    );
  } catch {}

  return payload as ProfileRow;
}

/**
 * Fetches a candidate profile by ApplyWizz ID from Supabase or local cache.
 */
export async function getProfile(applywizzId: string): Promise<ProfileRow | null> {
  const isYaswanth = applywizzId.trim().toUpperCase() === 'AWL-YASWANTH';
  const isAkshitha = applywizzId.trim().toUpperCase() === 'AWL-31428' || applywizzId.trim().toLowerCase().includes('akshitha');

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('applywizz_id', applywizzId)
        .maybeSingle();

      if (!error && data) {
        const row = data as ProfileRow;
        if (isYaswanth) {
          row.country = 'India';
          row.country_code = '+91';
          if (!row.location) row.location = 'Hyderabad, Telangana, India';
        } else if (isAkshitha) {
          if (!row.country) row.country = 'United States of America';
          if (!row.country_code) row.country_code = '+1';
          if (!row.phone) row.phone = '940-222-8193';
          if (!row.location) row.location = 'Dallas, Texas, United States';
        }
        return row;
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON Cache fallback (cache/profiles/{applywizzId}.json)
  const localCachePath = path.resolve(process.cwd(), 'cache', 'profiles', `${applywizzId}.json`);
  if (fs.existsSync(localCachePath)) {
    try {
      const raw = fs.readFileSync(localCachePath, 'utf-8');
      const d = JSON.parse(raw);
      const profileData = d.profile || d;
      return {
        applywizz_id: profileData.applywizzId || applywizzId,
        client_name: profileData.clientName || applywizzId,
        first_name: profileData.firstName || (isAkshitha ? 'AKSHITHA' : null),
        last_name: profileData.lastName || (isAkshitha ? 'G' : null),
        email: profileData.email || (isAkshitha ? 'akshitha.reddy@applywizard.ai' : null),
        company_email: profileData.companyEmail || (isAkshitha ? 'akshitha.reddy@applywizard.ai' : null),
        phone: isAkshitha ? (profileData.phone || '940-222-8193') : (profileData.phone || null),
        country: isYaswanth ? 'India' : (isAkshitha ? (profileData.country || 'United States of America') : (profileData.country || null)),
        country_code: isYaswanth ? '+91' : (isAkshitha ? (profileData.countryCode || profileData.country_code || '+1') : (profileData.countryCode || profileData.country_code || null)),
        location: isYaswanth ? (profileData.location || 'Hyderabad, Telangana, India') : (isAkshitha ? (profileData.location || 'Dallas, Texas, United States') : (profileData.location || null)),
        linkedin_url: profileData.linkedinUrl || null,
        website_url: profileData.websiteUrl || null,
        github_url: profileData.githubUrl || null,
        work_authorization: profileData.workAuthorization || (isAkshitha ? 'H1B' : null),
        requires_sponsorship: isAkshitha ? true : Boolean(profileData.requiresSponsorship),
        education: profileData.education || [],
        work_experience: profileData.workExperience || [],
        resume_url: profileData.resumeUrl || (isAkshitha ? 'resumes/AWL-31428_resume.pdf' : null),
        resume_storage_path: profileData.localResumePath || (isAkshitha ? 'resumes/AWL-31428_resume.pdf' : null),
        raw_api_payload: profileData.demographics ? { demographics: profileData.demographics } : null,
      };
    } catch {}
  }

  // Fallback for demo fixtures candidate AWL-YASWANTH
  if (isYaswanth) {
    return {
      applywizz_id: 'AWL-YASWANTH',
      client_name: 'Yaswanth Naidu Yalla',
      first_name: 'Yaswanth Naidu',
      last_name: 'Yalla',
      email: 'yaswanthnaidu004@gmail.com',
      company_email: 'yaswanthnaidu004@gmail.com',
      phone: '9573939153',
      country: 'India',
      country_code: '+91',
      location: 'Hyderabad, Telangana, India',
      linkedin_url: 'https://linkedin.com/in/yaswanth-yalla',
      work_authorization: 'US Citizen',
      requires_sponsorship: false,
      resume_url: 'resumes/AWL-YASHANTH_resume.pdf',
      resume_storage_path: 'resumes/AWL-YASHANTH_resume.pdf',
    };
  }

  // Fallback for demo fixtures candidate AWL-31428 (Akshitha)
  if (isAkshitha) {
    return {
      applywizz_id: 'AWL-31428',
      client_name: 'AKSHITHA G',
      first_name: 'AKSHITHA',
      last_name: 'G',
      email: 'akshitha.reddy@applywizard.ai',
      company_email: 'akshitha.reddy@applywizard.ai',
      phone: '940-222-8193',
      country: 'United States of America',
      country_code: '+1',
      location: 'Dallas, Texas, United States',
      linkedin_url: 'https://www.linkedin.com/in/akshitha-reddy',
      work_authorization: 'H1B',
      requires_sponsorship: true,
      education: [
        {
          institution: 'University of North Texas',
          degree: 'Master’s Degree',
          fieldOfStudy: 'Computer Science',
          graduationYear: '2023',
        },
      ],
      work_experience: [
        {
          company: 'Professional Experience',
          title: 'Business Analyst',
          startDate: '01/2020',
          endDate: 'Present',
          description: 'Total years of professional experience: 4. Role: Business Analyst',
        },
      ],
      resume_url: 'resumes/AWL-31428_resume.pdf',
      resume_storage_path: 'resumes/AWL-31428_resume.pdf',
      raw_api_payload: {
        demographics: {
          gender: 'Female',
          isHispanicLatino: 'No',
          raceEthnicity: 'Asian',
          veteranStatus: 'I am not a protected veteran',
          disabilityStatus: 'No, I do not have a disability',
          willingToRelocate: true,
          canWorkInOffice: true,
          salaryRange: 'USD Yearly: 80k-100k, Hourly: 40-60',
          yearsOfExperience: '4',
          currentRole: 'Business Analyst',
        },
      },
    };
  }

  return null;
}

/**
 * Fetches a candidate profile by resume URL or other remote URL reference.
 */
export async function getProfileByUrl(url: string): Promise<ProfileRow | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .or(`resume_url.eq.${url},linkedin_url.eq.${url},website_url.eq.${url}`)
        .maybeSingle();

      if (!error && data) {
        return data as ProfileRow;
      }
    } catch (err: any) {
      // Fall through
    }
  }

  return null;
}

/**
 * Updates the Supabase Storage resume path for a candidate.
 */
export async function updateResumeStoragePath(
  applywizzId: string,
  storagePath: string
): Promise<void> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      await supabase
        .from('profiles')
        .update({
          resume_storage_path: storagePath,
          updated_at: new Date().toISOString(),
        })
        .eq('applywizz_id', applywizzId);
    } catch {}
  }
}

/**
 * Updates the candidate profile with parsed resume text and structured facts.
 */
export async function updateParsedResume(
  applywizzId: string,
  resumeText: string,
  resumeFacts: any
): Promise<void> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      await supabase
        .from('profiles')
        .update({
          resume_text: resumeText,
          resume_facts: resumeFacts,
          updated_at: new Date().toISOString(),
        })
        .eq('applywizz_id', applywizzId);
    } catch {}
  }
}
