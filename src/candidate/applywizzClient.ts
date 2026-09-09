/**
 * @fileoverview ApplyWizz API Client, Profile Parser, Local Caching, and Resume Downloader.
 *
 * Implements Branch 2 querying of candidate details from `https://www.apply-wizz.me/api/get-client-details`,
 * response normalization into `ApplyWizzCandidateProfile`, local caching in `./cache/profiles/`,
 * and master PDF resume binary downloads into `./resumes/`.
 *
 * References:
 * - 02-trd.md (Section 3.3)
 * - 03-workflow.md (Step 3)
 * - 05-backend-schema.md (Section 1.3)
 */

import fs from 'fs';
import path from 'path';
import axios, { type AxiosInstance } from 'axios';
import { config } from '../config/env.js';
import { isCompanyEmailDomain } from '../db/profiles.js';
import type {
  ApplyWizzCandidateProfile,
  CandidateEducation,
  CandidateWorkExperience,
  CandidateDemographics,
} from '../types/index.js';

/**
 * Options configuring the ApplyWizzClient instance.
 */
export interface ApplyWizzClientOptions {
  /**
   * Base URL for the ApplyWizz REST API.
   * @default config.APPLYWIZZ_API_URL ('https://www.apply-wizz.me/api')
   */
  baseUrl?: string;

  /**
   * Directory where downloaded candidate resumes are saved.
   * @default config.RESUMES_DIR ('./resumes')
   */
  resumesDir?: string;

  /**
   * Directory where cached candidate profile JSON files are stored.
   * @default './cache/profiles'
   */
  cacheDir?: string;

  /**
   * Network request timeout in milliseconds.
   * @default 15000
   */
  timeoutMs?: number;

  /**
   * Maximum retry attempts with exponential backoff on network/rate-limit failures.
   * @default 3
   */
  maxRetries?: number;
}

/**
 * Helper to sleep for a specified duration in milliseconds.
 *
 * @param ms - Delay duration in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Client for interacting with the ApplyWizz candidate API, caching profiles locally,
 * and downloading candidate master resumes.
 */
export class ApplyWizzClient {
  private readonly baseUrl: string;
  private readonly resumesDir: string;
  private readonly cacheDir: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly httpClient: AxiosInstance;

  /**
   * Initializes a new ApplyWizzClient with configurable options.
   *
   * @param options - Configuration overrides.
   */
  constructor(options: ApplyWizzClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? config.APPLYWIZZ_API_URL;
    this.resumesDir = path.resolve(process.cwd(), options.resumesDir ?? config.RESUMES_DIR);
    this.cacheDir = path.resolve(process.cwd(), options.cacheDir ?? './cache/profiles');
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 3;

    // Ensure output directories exist
    if (!fs.existsSync(this.resumesDir)) {
      fs.mkdirSync(this.resumesDir, { recursive: true });
    }
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    this.httpClient = axios.create({
      timeout: this.timeoutMs,
      headers: {
        'User-Agent': 'ApplyWizz-Greenhouse-Automation/1.0',
        Accept: 'application/json',
      },
    });
  }

  /**
   * Constructs the full API URL for fetching candidate details.
   * Handles formats such as:
   * - https://www.apply-wizz.me/api/get-client-details?applywizz_id=
   * - https://www.apply-wizz.me/api/get-client-details
   * - https://www.apply-wizz.me/api
   */
  public buildRequestUrl(applywizzId: string): string {
    const raw = (this.baseUrl || '').trim();
    if (raw.includes('applywizz_id=')) {
      return `${raw}${encodeURIComponent(applywizzId)}`;
    }
    if (raw.includes('/get-client-details')) {
      const separator = raw.includes('?') ? '&' : '?';
      return `${raw}${separator}applywizz_id=${encodeURIComponent(applywizzId)}`;
    }
    const cleanBase = raw.replace(/\/+$/, '');
    return `${cleanBase}/get-client-details?applywizz_id=${encodeURIComponent(applywizzId)}`;
  }

  /**
   * Fetches a candidate's profile by Applywizz ID.
   * Checks the local file cache first before issuing an HTTP request.
   *
   * @param applywizzId - Candidate identifier (e.g., 'AWL-36144').
   * @param forceRefresh - If true, bypasses local cache and re-queries the API.
   * @returns Parsed and strongly-typed ApplyWizzCandidateProfile.
   *
   * @throws Error if network query fails after maximum retries and no cached profile exists.
   */
  public async fetchCandidateProfile(
    applywizzId: string,
    forceRefresh = false
  ): Promise<ApplyWizzCandidateProfile> {
    const { profile } = await this.fetchCandidateProfileWithRaw(applywizzId, forceRefresh);
    return profile;
  }

  /**
   * Fetches candidate profile and raw API payload.
   * Used during new-candidate onboarding to persist full API response to Supabase.
   */
  public async fetchCandidateProfileWithRaw(
    applywizzId: string,
    forceRefresh = false
  ): Promise<{ profile: ApplyWizzCandidateProfile; raw: Record<string, any> }> {
    const cleanId = applywizzId.trim();
    const cachePath = path.join(this.cacheDir, `${cleanId}.json`);
    const isYaswanth = cleanId.toUpperCase() === 'AWL-YASWANTH';

    const enforceYaswanth = (p: ApplyWizzCandidateProfile) => {
      if (isYaswanth) {
        p.country = 'India';
        p.countryCode = '+91';
        if (!p.location) p.location = 'Hyderabad, Telangana, India';
      }
      return p;
    };

    if (!forceRefresh && fs.existsSync(cachePath)) {
      try {
        const cachedRaw = await fs.promises.readFile(cachePath, 'utf-8');
        const cached = JSON.parse(cachedRaw);
        if (cached?.profile && cached?.raw) {
          return { profile: enforceYaswanth(cached.profile), raw: cached.raw };
        }
        if (cached?.applywizzId) {
          return { profile: enforceYaswanth(cached as ApplyWizzCandidateProfile), raw: {} };
        }
      } catch (err: any) {
        console.warn(`[ApplyWizz Client] ⚠️ Corrupt cache for ${cleanId}, re-fetching: ${err.message}`);
      }
    }

    try {
      const { profile, raw } = await this.fetchFromApi(cleanId);
      await fs.promises.writeFile(cachePath, JSON.stringify({ profile, raw }, null, 2), 'utf-8');
      return { profile: enforceYaswanth(profile), raw };
    } catch (err) {
      if (fs.existsSync(cachePath)) {
        try {
          const cachedRaw = await fs.promises.readFile(cachePath, 'utf-8');
          const cached = JSON.parse(cachedRaw);
          if (cached?.profile) {
            return { profile: enforceYaswanth(cached.profile), raw: cached.raw || {} };
          }
          if (cached?.applywizzId) {
            return { profile: enforceYaswanth(cached as ApplyWizzCandidateProfile), raw: {} };
          }
        } catch {}
      }
      throw err;
    }
  }

  /**
   * Issues HTTP request to ApplyWizz API and parses response.
   * Only called during new-candidate onboarding — never during answer resolution.
   */
  private async fetchFromApi(
    cleanId: string
  ): Promise<{ profile: ApplyWizzCandidateProfile; raw: Record<string, any> }> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const targetUrl = this.buildRequestUrl(cleanId);
        const response = await this.httpClient.get(targetUrl);

        if (!response.data || typeof response.data !== 'object') {
          throw new Error(`Invalid response payload received for candidate: ${cleanId}`);
        }

        const raw = response.data as Record<string, any>;
        const profile = this.parseProfileResponse(cleanId, raw);
        return { profile, raw };
      } catch (err: any) {
        lastError = err;
        const isRateLimitOrServer =
          err.response?.status === 429 || (err.response?.status >= 500 && err.response?.status < 600);
        const isNetwork = !err.response;

        if (attempt < this.maxRetries && (isRateLimitOrServer || isNetwork)) {
          const delayMs = Math.floor(1000 * Math.pow(2, attempt) + Math.random() * 500);
          console.warn(
            `[ApplyWizz Client] ⏳ Attempt ${attempt}/${this.maxRetries} failed for ${cleanId} (${err.message}). Retrying in ${delayMs}ms...`
          );
          await sleep(delayMs);
        } else {
          break;
        }
      }
    }

    throw new Error(
      `Failed to fetch ApplyWizz candidate profile for "${cleanId}" after ${this.maxRetries} attempts: ${lastError?.message}`
    );
  }

  /**
   * Downloads the candidate's master resume PDF from the remote URL and saves it to `./resumes/${applywizzId}_resume.pdf`.
   * Skips download if the PDF already exists locally and is non-empty.
   *
   * @param applywizzId - Candidate identifier.
   * @param resumeUrl - Remote S3 / HTTPS URL to the master PDF resume.
   * @returns Absolute local filesystem path to the saved resume.
   */
  public async downloadResume(applywizzId: string, resumeUrl: string): Promise<string> {
    const cleanId = applywizzId.trim();
    const destinationPath = path.join(this.resumesDir, `${cleanId}_resume.pdf`);

    // Check if valid resume already exists locally
    if (fs.existsSync(destinationPath)) {
      try {
        const stats = fs.statSync(destinationPath);
        if (stats.size > 100) {
          return destinationPath;
        }
      } catch {}
    }

    if (!resumeUrl || typeof resumeUrl !== 'string' || resumeUrl.trim().length === 0) {
      return destinationPath;
    }

    let targetUrl = resumeUrl.trim();
    if (!targetUrl.startsWith('http')) {
      targetUrl = `https://applywizz-prod.s3.us-east-2.amazonaws.com/${encodeURI(targetUrl.replace(/^\/+/, ''))}`;
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await axios.get(targetUrl, {
          responseType: 'arraybuffer',
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });

        const buffer = Buffer.from(response.data);
        await fs.promises.writeFile(destinationPath, buffer);
        return destinationPath;
      } catch (err: any) {
        lastError = err;
        if (attempt < this.maxRetries) {
          const delayMs = 1000 * attempt;
          await sleep(delayMs);
        }
      }
    }

    console.warn(
      `[ApplyWizz Client] ⚠️ Failed to download resume for ${cleanId} from ${resumeUrl}: ${lastError?.message}`
    );
    return destinationPath;
  }

  /**
   * Parses and normalizes the raw ApplyWizz API JSON response into a strongly-typed ApplyWizzCandidateProfile.
   *
   * @param applywizzId - Candidate identifier.
   * @param raw - Raw API response containing `client` and `additional_information`.
   * @returns Normalized ApplyWizzCandidateProfile.
   */
  private parseProfileResponse(applywizzId: string, raw: any): ApplyWizzCandidateProfile {
    const client = raw.client || {};
    const addInfo = raw.additional_information || {};

    const fullName: string = client.full_name || addInfo.full_name || applywizzId;
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    // Strictly prioritize company email (@applywizard.ai / @applywizz.*)
    const rawCompanyEmail = (client.company_email || addInfo.company_email || '').trim();
    const isCompany = (e?: string) => e && isCompanyEmailDomain(e);
    const email = isCompany(rawCompanyEmail)
      ? rawCompanyEmail
      : (isCompany(client.personal_email)
          ? client.personal_email.trim()
          : (rawCompanyEmail || client.personal_email || addInfo.email || ''));

    let phone =
      addInfo.primary_phone ||
      client.callable_phone ||
      client.whatsapp_number ||
      '';
    if (phone && phone.replace(/\D/g, '').length < 7) {
      phone = '';
    }

    const location =
      addInfo.state_of_residence ||
      addInfo.full_address ||
      (Array.isArray(client.location_preferences) ? client.location_preferences[0] : '') ||
      '';

    const linkedinUrl = addInfo.linked_in_url || client.linkedin_url || '';
    const githubUrl = addInfo.github_url || client.github_url || undefined;
    const websiteUrl = addInfo.portfolio_url || addInfo.google_drive_resume_link || undefined;

    const workAuthorization = client.visa_type || client.work_auth_details || 'US Citizen';
    const requiresSponsorship = Boolean(
      client.sponsorship ?? addInfo.require_future_sponsorship ?? false
    );

    // Build Education history
    const education: CandidateEducation[] = [];
    if (addInfo.university_name || addInfo.highest_education || addInfo.main_subject) {
      education.push({
        institution: addInfo.university_name || 'University',
        degree: addInfo.highest_education || "Master's Degree",
        fieldOfStudy: addInfo.main_subject || 'Computer Science',
        graduationYear: String(addInfo.graduation_year || '2024'),
      });
    }

    // Build Work Experience history
    const workExperience: CandidateWorkExperience[] = [];
    if (addInfo.role || addInfo.experience) {
      workExperience.push({
        company: 'Professional Experience',
        title: addInfo.role || 'Software Engineer',
        startDate: '01/2020',
        endDate: 'Present',
        description: `Total years of professional experience: ${addInfo.experience || '5'}. Role: ${addInfo.role || 'Software Engineer'}`,
      });
    }

    let resumeUrl = (addInfo.resume_url || client.resume_url || '').trim();
    if (resumeUrl && !resumeUrl.startsWith('http')) {
      resumeUrl = `https://applywizz-prod.s3.us-east-2.amazonaws.com/${encodeURI(resumeUrl.replace(/^\/+/, ''))}`;
    }
    const localResumePath = path.join(this.resumesDir, `${applywizzId}_resume.pdf`);

    // Demographic and Survey Attributes
    const demographics: CandidateDemographics = {
      gender: addInfo.gender || undefined,
      isHispanicLatino: addInfo.is_hispanic_latino || undefined,
      raceEthnicity: addInfo.race_ethnicity || undefined,
      veteranStatus: addInfo.veteran_status || undefined,
      disabilityStatus: addInfo.disability_status || undefined,
      willingToRelocate: addInfo.willing_to_relocate !== undefined ? Boolean(addInfo.willing_to_relocate) : undefined,
      canWorkInOffice: addInfo.can_work_3_days_in_office !== undefined ? Boolean(addInfo.can_work_3_days_in_office) : undefined,
      salaryRange: client.salary_range || undefined,
      yearsOfExperience: addInfo.experience ? String(addInfo.experience) : undefined,
      currentRole: addInfo.role || undefined,
    };

    const isYaswanth = applywizzId.trim().toUpperCase() === 'AWL-YASWANTH';
    const country = isYaswanth ? 'India' : (addInfo.country || client.country || undefined);
    const countryCode = isYaswanth ? '+91' : (addInfo.country_code || client.country_code || undefined);

    return {
      applywizzId,
      clientName: fullName,
      firstName,
      lastName,
      email,
      phone,
      location: isYaswanth ? (location || 'Hyderabad, Telangana, India') : location,
      country,
      countryCode,
      linkedinUrl,
      websiteUrl,
      githubUrl,
      workAuthorization,
      requiresSponsorship,
      education,
      workExperience,
      resumeUrl,
      localResumePath,
      demographics,
    };
  }
}
