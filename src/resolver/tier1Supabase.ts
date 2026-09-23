/**
 * @fileoverview Tier 1 Answer Resolution: Supabase Profiles & Exact QA Bank Lookup.
 * Source Tag: 'supabase', resolvedByTier: 1
 */

import Fuse from 'fuse.js';
import { getProfile, type ProfileRow, getCompanyEmail } from '../db/profiles.js';
import { getAnswer } from '../db/qaBank.js';
import { generateFingerprint, normalizeText } from './fingerprint.js';
import type { ResolvedField, ScannedField } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
 
const log = createLogger('Tier 1 Supabase');

/**
 * Matches target value to the closest matching option in dropdown or radio group.
 */
function matchBestOption(targetValue: string, options?: string[], _label = targetValue): string | null {
  if (!options || options.length === 0) {
    return targetValue;
  }

  const normTarget = normalizeText(targetValue);

  // 1. Exact match
  for (const opt of options) {
    if (normalizeText(opt) === normTarget) {
      return opt;
    }
  }

  // 2. Special dial code match if target is +1 or +91
  if (/^\+?\d{1,3}$/.test(targetValue.trim())) {
    const cleanDigits = targetValue.replace(/\D/g, '');
    for (const opt of options) {
      if (new RegExp(`(\\+|\\b)${cleanDigits}\\b`).test(opt)) {
        return opt;
      }
    }
  }

  // 3. Substring match
  for (const opt of options) {
    const normOpt = normalizeText(opt);
    if (normOpt.includes(normTarget) || normTarget.includes(normOpt)) {
      return opt;
    }
  }

  // 4. Boolean heuristics (Yes/No / Agree)
  if (normTarget === 'yes' || normTarget === 'true' || normTarget === '1' || normTarget === 'agree') {
    const yesOpt = options.find((o) => /^(yes|agree|i agree|accept|i accept|true|i acknowledge)/i.test(o.trim()) || o.trim() === '1');
    if (yesOpt) return yesOpt;
  }
  if (normTarget === 'no' || normTarget === 'false' || normTarget === '0' || normTarget === 'disagree') {
    const noOpt = options.find((o) => /^(no|disagree|i disagree|decline|false|do not)/i.test(o.trim()) || o.trim() === '0');
    if (noOpt) return noOpt;
  }

  // 5. Fuzzy option match
  const fuse = new Fuse(options, { threshold: 0.6 });
  const results = fuse.search(targetValue);
  if (results.length > 0) {
    return results[0].item;
  }
  return null;
}

/**
 * Resolves standard profile attributes based on field name and label heuristics.
 */
function resolveStandardProfileAttribute(
  field: ScannedField,
  profile: ProfileRow
): string | null {
  const normLabel = normalizeText(field.label);
  const normName = normalizeText(field.name);
  const normId = normalizeText(field.fieldId);
  const combined = `${normLabel} ${normName} ${normId}`;
  const isYaswanth = (profile.applywizz_id || '').trim().toUpperCase() === 'AWL-YASWANTH';
  const isAkshitha = (profile.applywizz_id || '').trim().toUpperCase() === 'AWL-31428' || (profile.client_name || '').toLowerCase().includes('akshitha');

  // Cover Letter - NEVER fill or upload cover letters per policy
  if (/cover\s*letter|cover_letter/i.test(combined)) {
    return '';
  }

  // File upload: Resume only
  if ((field.type === 'file' || /resume|cv\b/i.test(combined)) && !/cover/i.test(combined)) {
    return profile.resume_storage_path || `resumes/${profile.applywizz_id}_resume.pdf`;
  }

  // Phone Country / Dialing Code (must precede standard phone matching)
  if (
    normId === 'phone_country' ||
    normName === 'phone_country' ||
    normId === 'phone_country_code' ||
    normName === 'phone_country_code' ||
    /phone.*country|country.*phone/i.test(combined)
  ) {
    const targetCountry = isYaswanth ? 'India' : (profile.country || (isAkshitha ? 'United States of America' : 'India'));
    if (field.options && field.options.length > 0) {
      const countryMatch = matchBestOption(targetCountry, field.options, field.label);
      if (countryMatch) return countryMatch;
      const codeMatch = matchBestOption(
        isYaswanth ? '+91' : (profile.country_code || (isAkshitha ? '+1' : '+91')),
        field.options,
        field.label
      );
      if (codeMatch) return codeMatch;
      return null;
    }
    return targetCountry;
  }

  // Calling Code / Dialing Code
  if (
    normId === 'country_code' ||
    normName === 'country_code' ||
    normId === 'dialing_code' ||
    normName === 'dialing_code' ||
    /calling.*code|dialing.*code/i.test(combined)
  ) {
    const targetCode = isYaswanth ? '+91' : (profile.country_code || (isAkshitha ? '+1' : '+91'));
    if (field.options && field.options.length > 0) {
      const codeMatch = matchBestOption(targetCode, field.options, field.label);
      if (codeMatch) return codeMatch;
      return null;
    }
    return targetCode;
  }

  // Country (direct check before generic text matching)
  if (
    normId === 'country' ||
    normName === 'country' ||
    /^(candidate|current)?\s*country(\s*of\s*residence)?$/i.test(normLabel)
  ) {
    const targetCountry = isYaswanth ? 'India' : (profile.country || (isAkshitha ? 'United States of America' : 'India'));
    return matchBestOption(targetCountry, field.options, field.label);
  }

  // First Name
  if (
    /(first|given|fore)\s*name/i.test(combined) ||
    normId === 'first name' ||
    normName === 'first name' ||
    normId === 'first_name' ||
    normName === 'first_name' ||
    combined.includes('first name') ||
    combined.includes('firstname')
  ) {
    if (profile.first_name && profile.first_name.trim().length > 0) {
      return profile.first_name.trim();
    }
    if (profile.client_name && !profile.client_name.startsWith('AWL-')) {
      const parts = profile.client_name.trim().split(/\s+/);
      return parts[0] || null;
    }
    return null;
  }

  // Last Name
  if (
    /(last|family|sur)\s*name/i.test(combined) ||
    normId === 'last name' ||
    normName === 'last name' ||
    normId === 'last_name' ||
    normName === 'last_name' ||
    combined.includes('last name') ||
    combined.includes('lastname')
  ) {
    if (profile.last_name && profile.last_name.trim().length > 0) {
      return profile.last_name.trim();
    }
    if (profile.client_name && !profile.client_name.startsWith('AWL-')) {
      const parts = profile.client_name.trim().split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
    }
    return null;
  }

  // Full Name
  if (/(full|client)\s*name/i.test(combined) || combined === 'name') {
    return profile.client_name || `${profile.first_name || ''} ${profile.last_name || ''}`.trim();
  }

  // Email — strictly company email, never personal
  if (/email/i.test(combined) || normId === 'email' || normName === 'email') {
    if (profile.company_email && profile.company_email.trim().length > 0) {
      return profile.company_email.trim();
    }
    return getCompanyEmail(profile);
  }

  // Phone (stripping +1 or +91 so Greenhouse country prefix is not duplicated)
  if (/phone|mobile|contact number/i.test(combined)) {
    if (profile.phone) {
      let clean = profile.phone.trim();
      clean = clean.replace(/^\+?91[\s.-]*/, '').replace(/^\+?1[\s.-]*/, '').replace(/^\+/, '').replace(/\s+/g, ' ').trim();
      if (clean.replace(/\D/g, '').length >= 7) {
        return clean;
      }
    }
    return null;
  }

  // LinkedIn
  if (/linkedin/i.test(combined)) {
    if (profile.linkedin_url && profile.linkedin_url.trim()) {
      const url = profile.linkedin_url.trim();
      return url.startsWith('http') ? url : `https://${url}`;
    }
    return null;
  }

  // Website / Portfolio
  if (/portfolio|website|personal site|github/i.test(combined)) {
    if (/github/i.test(combined) && profile.github_url && profile.github_url.trim()) {
      const url = profile.github_url.trim();
      return url.startsWith('http') ? url : `https://${url}`;
    }
    if (profile.website_url && profile.website_url.trim()) {
      const url = profile.website_url.trim();
      return url.startsWith('http') ? url : `https://${url}`;
    }
    if (profile.github_url && profile.github_url.trim()) {
      const url = profile.github_url.trim();
      return url.startsWith('http') ? url : `https://${url}`;
    }
    return null;
  }

  // Work Authorization / Legal authorization — policy: always answer Yes regardless of visa type string.
  // The question is a binary yes/no about eligibility; the visa type is irrelevant to the answer.
  // matchBestOption will map 'Yes' to the closest option (e.g. "Yes", "I am authorized", etc.).
  if (
    /authorized to work|authorization to work|legally authorized|work authorization|legal right to work|right to work|permission to work|can you work|do you have the right|are you permitted|work permit|employment eligibility|eligible to work|unlimited.*unrestricted.*authorization|unrestricted.*authorization/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') return 'true';
    return matchBestOption('Yes', field.options, field.label) ?? 'Yes';
  }

  // Visa Sponsorship (must precede location to prevent "United States" false match)
  if (/sponsorship|require.*visa|future.*sponsorship|visa status|immigration.*sponsor|sponsor.*immigration/i.test(combined)) {
    const rawVal = profile.requires_sponsorship ? 'Yes' : 'No';
    return matchBestOption(rawVal, field.options, field.label);
  }

  // Family / Personal Relationships / Referral by Employee (Always "No")
  if (
    /(family.*employ|relative.*employ|know anyone.*work|anyone.*work.*company|personal.*relationship.*employ|referred.*by.*employee|employee.*referr|do you have.*family|do you have.*relative|know.*current.*employee|personal.*familial)/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') return 'false';
    return matchBestOption('No', field.options, field.label);
  }

  // Prior Employment / Former Employee (Always "No")
  if (
    /(previously.*employed|worked for|worked at|former employee|previously worked|employed by.*company|ever been employed|past employment|worked here before|worked with us|worked under a different name|different name)/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') {
      return 'false';
    }
    return matchBestOption('No', field.options, field.label);
  }

  // Restrictive Covenants / Non-Compete / NDAs / Restrictive Agreements (Always "No")
  if (
    /(restrict.*employment|non-compete|non compete|nda\b|restrictive covenant|conflict of interest|disciplinary action|convicted of a felony|terminated.*employment)/i.test(
      combined
    )
  ) {
    if (field.type === 'checkbox') {
      return 'false';
    }
    return matchBestOption('No', field.options, field.label);
  }

  // Consent / Terms & Conditions / Privacy Policy / Declarations / Acknowledgment (Always "Yes")
  if (
    /(terms and conditions|terms & conditions|terms of service|terms of use|privacy policy|certify|acknowledge|declaration|accurate and true|attest|background check|disclaimer)/i.test(
      combined
    ) ||
    (/\bagree\b/i.test(combined) && !/disagree|restrict|non-compete|non compete/i.test(normLabel)) ||
    (/\bconsent\b/i.test(combined) && !/restrict/i.test(normLabel))
  ) {
    if (field.type === 'checkbox') {
      return 'true';
    }
    return matchBestOption('Yes', field.options, field.label);
  }

  // Relocation / same-city willingness (binary Yes/No — must precede city/location heuristics)
  if (
    /(willing to relocate|open to relocate|relocate to|relocation|in the same city|same city as)/i.test(
      combined
    )
  ) {
    const addInfo = profile.raw_api_payload?.additional_information;
    const willing = addInfo?.willing_to_relocate !== false;
    return matchBestOption(willing ? 'Yes' : 'No', field.options, field.label);
  }

  // Location (City, State, Residence) - must not match "United States" in visa questions
  if (
    /(candidate location|current location|\bcity\b|\bresidence\b|\baddress\b|\bpostal code\b|\bzip code\b)/i.test(combined) ||
    (/\bstate\b/i.test(combined) && !/united states|sponsorship|visa/i.test(combined))
  ) {
    return profile.location || null;
  }

  // Country
  if (/\bcountry\b|\bnationality\b/i.test(combined)) {
    const rawVal = isYaswanth ? 'India' : (profile.country || (isAkshitha ? 'United States of America' : 'United States'));
    return matchBestOption(rawVal, field.options, field.label);
  }

  // Demographics / Salary / Experience from raw_api_payload if present
  if (profile.raw_api_payload?.demographics) {
    const demo = profile.raw_api_payload.demographics;
    if (/salary|compensation|expected pay/i.test(combined) && demo.salaryRange) {
      return matchBestOption(demo.salaryRange, field.options, field.label);
    }
    if (/transgender/i.test(combined)) {
      return matchBestOption('No', field.options, field.label);
    }
    if (/sexual orientation/i.test(combined)) {
      return matchBestOption("I don't wish to answer", field.options, field.label);
    }
    if (/hispanic|latino/i.test(combined)) {
      return matchBestOption(demo.isHispanicLatino || 'No', field.options, field.label);
    }
    if (/gender/i.test(combined) && !/transgender/i.test(combined) && demo.gender) {
      return matchBestOption(demo.gender, field.options, field.label);
    }
    if (/race|ethnicity/i.test(combined) && !/hispanic|latino/i.test(combined) && demo.raceEthnicity) {
      return matchBestOption(demo.raceEthnicity, field.options, field.label);
    }
    if (/veteran/i.test(combined) && demo.veteranStatus) {
      return matchBestOption(demo.veteranStatus, field.options, field.label);
    }
    if (/disability/i.test(combined) && demo.disabilityStatus) {
      return matchBestOption(demo.disabilityStatus, field.options, field.label);
    }
  }

  return null;
}

interface ExtractedPayloadEntry {
  key: string;
  path: string;
  value: string;
  normalizedKey: string;
}

/**
 * Recursively extracts all primitive key-value pairs from raw_api_payload,
 * keeping track of their keys and paths.
 */
function extractKeyValuePairsFromPayload(
  obj: any,
  prefix = '',
  depth = 0
): ExtractedPayloadEntry[] {
  if (depth > 6 || !obj || typeof obj !== 'object') {
    return [];
  }

  const entries: ExtractedPayloadEntry[] = [];

  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;

    const fullPath = prefix ? `${prefix}.${k}` : k;
    const humanizedKey = k.replace(/[_-]+/g, ' ').trim();

    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const strVal = String(v).trim();
      if (strVal.length > 0 && strVal !== '[object Object]') {
        entries.push({
          key: humanizedKey,
          path: fullPath,
          value: strVal,
          normalizedKey: normalizeText(humanizedKey),
        });
      }
    } else if (Array.isArray(v)) {
      // Check array of strings/primitives
      if (v.length > 0 && typeof v[0] !== 'object') {
        const joined = v.map((item) => String(item).trim()).filter(Boolean).join(', ');
        if (joined) {
          entries.push({
            key: humanizedKey,
            path: fullPath,
            value: joined,
            normalizedKey: normalizeText(humanizedKey),
          });
        }
      } else {
        // Traverse elements
        for (let i = 0; i < Math.min(v.length, 10); i++) {
          entries.push(...extractKeyValuePairsFromPayload(v[i], `${fullPath}[${i}]`, depth + 1));
        }
      }
    } else if (typeof v === 'object') {
      entries.push(...extractKeyValuePairsFromPayload(v, fullPath, depth + 1));
    }
  }

  return entries;
}

/**
 * Mines raw_api_payload by fuzzy-matching extracted top-level and nested keys against the question label.
 */
function resolveFromRawApiPayload(
  field: ScannedField,
  rawPayload?: Record<string, any> | null
): string | null {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return null;
  }

  const entries = extractKeyValuePairsFromPayload(rawPayload);
  if (entries.length === 0) {
    return null;
  }

  const normLabel = normalizeText(field.label);

  // 1. Direct normalized key exact match
  const exact = entries.find((e) => e.normalizedKey === normLabel);
  if (exact) {
    const matched = matchBestOption(exact.value, field.options, field.label);
    if (matched) return matched;
  }

  // 2. Substring containment match (word boundary check or mutual inclusion)
  for (const entry of entries) {
    if (entry.normalizedKey.length >= 4 && normLabel.length >= 4) {
      if (normLabel.includes(entry.normalizedKey) || entry.normalizedKey.includes(normLabel)) {
        const matched = matchBestOption(entry.value, field.options, field.label);
        if (matched) return matched;
      }
    }
  }

  // 3. Fuzzy match against extracted keys using Fuse.js (threshold <= 0.3 for high precision)
  const fuse = new Fuse(entries, {
    keys: ['key', 'normalizedKey'],
    threshold: 0.3,
    ignoreLocation: true,
  });

  const results = fuse.search(field.label);
  if (results.length > 0 && results[0].item) {
    const matched = matchBestOption(results[0].item.value, field.options, field.label);
    if (matched) return matched;
  }

  return null;
}

function formatPayloadDate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) {
    const [month, day, year] = raw.split('/');
    return `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${year}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return `${String(parsed.getUTCMonth() + 1).padStart(2, '0')}/${String(parsed.getUTCDate()).padStart(2, '0')}/${parsed.getUTCFullYear()}`;
}

function formatPayloadValue(value: unknown, fieldType: string, formatDate = false): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (formatDate) return formatPayloadDate(value);
  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item).trim()).filter(Boolean).join(', ');
    return joined || null;
  }
  const result = String(value).trim();
  if (!result) return null;
  if (fieldType === 'checkbox' && (result === 'true' || result === 'false')) {
    return result === 'true' ? 'Yes' : 'No';
  }
  return result;
}

function formatPayloadBoolean(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return 'No';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const result = String(value).trim();
  if (/^true$/i.test(result)) return 'Yes';
  if (/^false$/i.test(result)) return 'No';
  return result || null;
}

/**
 * Resolves stable ApplyWizz payload fields before generic payload key extraction.
 */
export function resolveFromPayloadStructured(
  normalizedLabel: string,
  fieldType: string,
  rawPayload: unknown
): string | null {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  const payload = rawPayload as {
    client?: Record<string, unknown>;
    additional_information?: Record<string, unknown>;
  };
  const client = payload.client || {};
  const additional = payload.additional_information || {};
  const match = (pattern: RegExp, value: unknown, formatDate = false): string | null =>
    pattern.test(normalizedLabel) ? formatPayloadValue(value, fieldType, formatDate) : null;
  const matchBoolean = (pattern: RegExp, value: unknown): string | null =>
    pattern.test(normalizedLabel) ? formatPayloadBoolean(value) : null;

  return (
    match(/salary|compensation|ctc|pay rate|desired pay|expected pay|desired compensation/, client.salary_range) ??
    (match(/years of experience|total experience|how many years|experience level/, additional.experience) !== null
      ? `${formatPayloadValue(additional.experience, fieldType)} years`
      : null) ??
    match(/highest (level of )?education|highest degree|education level|degree (earned|obtained|completed)/, additional.highest_education) ??
    match(/university|college|institution|school name|where did you (attend|study)/, additional.university_name) ??
    match(/gpa|grade point|cumulative gpa/, additional.cumulative_gpa) ??
    match(/graduation year|year of graduation|when did you graduate|expected graduation/, additional.graduation_year) ??
    match(/field of study|major|degree (in|subject)|main subject/, additional.main_subject) ??
    match(/start date|available to start|when can you start|earliest start|desired start/, additional.desired_start_date, true) ??
    matchBoolean(/willing to relocate|open to relocation|relocate/, additional.willing_to_relocate) ??
    matchBoolean(/work (in|from) office|hybrid|in.?office days|3 days/, additional.can_work_3_days_in_office) ??
    matchBoolean(/background (check|screening|investigation consent)/, additional.willing_background_check) ??
    matchBoolean(/drug (screen|test|testing)/, additional.willing_drug_screen) ??
    matchBoolean(/failed.*drug|refused.*drug|positive.*drug/, additional.failed_or_refused_drug_test) ??
    matchBoolean(/convicted|felony|criminal (history|record|background)/, additional.convicted_of_felony) ??
    matchBoolean(/pending (investigation|charge|criminal)/, additional.pending_investigation) ??
    matchBoolean(/referred by.*(agency|staffing|recruiter)|staffing agency|recruiting agency/, additional.referred_by_agency) ??
    matchBoolean(/worked (here|for us|for this company|at this company) before|previously employed (here|by us)/, additional.worked_for_company_before) ??
    matchBoolean(/discharged|terminated for (cause|violation|policy)/, additional.discharged_for_policy_violation) ??
    matchBoolean(/relatives|family member.*(employ|work)|know (anyone|employees) (at|in)/, additional.has_relatives_in_company) ??
    matchBoolean(/legal (documents|authorization)|i-?9|prove.*eligibility|provide.*documentation/, additional.can_provide_legal_docs) ??
    matchBoolean(/substance|impair|affect.*duties|drug.*affect/, additional.uses_substances_affecting_duties) ??
    matchBoolean(/essential functions|perform.*functions|physical.*requirements/, additional.can_perform_essential_functions) ??
    match(/^gender$|gender identity|what is your gender/, additional.gender) ??
    match(/hispanic|latino/, additional.is_hispanic_latino) ??
    match(/^race$|^ethnicity$|race.*ethnicity|racial/, additional.race_ethnicity) ??
    match(/veteran|military status|protected veteran/, additional.veteran_status) ??
    match(/disability|disabled|ada|accommodation/, additional.disability_status) ??
    match(/address|street address|home address|mailing address/, additional.full_address) ??
    match(/state of residence|current state|which state/, additional.state_of_residence) ??
    match(/date of birth|dob|birth date/, additional.date_of_birth, true) ??
    match(/desired (role|position|job title)|job preference|what role/, Array.isArray(client.job_role_preferences) ? client.job_role_preferences[0] : client.job_role_preferences) ??
    match(/preferred (location|city)|where.*prefer to work|work location preference/, client.location_preferences) ??
    match(/visa type|type of visa|current visa/, client.visa_type) ??
    match(/linkedin/, additional.linked_in_url) ??
    match(/github/, additional.github_url)
  );
}

/**
 * Attempts Tier 1 answer resolution.
 * Checks in strict order:
 * 1. Profiles columns directly & deterministic policy rules (ground truth)
 * 2. Profiles.raw_api_payload JSONB for any matching key (fuzzy matched against question label)
 * 3. Candidate_qa_bank by fingerprint
 *
 * @returns ResolvedField with source: 'supabase', resolvedByTier: 1, or null if miss.
 */
export async function resolveTier1(
  applywizzId: string,
  field: ScannedField,
  profile?: ProfileRow | null
): Promise<ResolvedField | null> {
  const isYaswanth = applywizzId.trim().toUpperCase() === 'AWL-YASWANTH';
  const isAkshitha = applywizzId.trim().toUpperCase() === 'AWL-31428' || applywizzId.trim().toLowerCase().includes('akshitha');

  // 1. Check profiles columns directly & standard attributes
  const candidateProfile = profile || (await getProfile(applywizzId));
  if (candidateProfile && isYaswanth) {
    candidateProfile.country = 'India';
    candidateProfile.country_code = '+91';
    if (!candidateProfile.location) candidateProfile.location = 'Hyderabad, Telangana, India';
  } else if (candidateProfile && isAkshitha) {
    if (!candidateProfile.country) candidateProfile.country = 'United States of America';
    if (!candidateProfile.country_code) candidateProfile.country_code = '+1';
    if (!candidateProfile.phone) candidateProfile.phone = '940-222-8193';
    if (!candidateProfile.location) candidateProfile.location = 'Dallas, Texas, United States';
  }

  if (candidateProfile) {
    const matchedVal = resolveStandardProfileAttribute(field, candidateProfile);
    if (matchedVal !== null && matchedVal !== undefined && matchedVal.trim().length > 0) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: matchedVal,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
        isRequired: Boolean(field.isRequired),
      };
    }
  }

  // 2a. Check stable profiles.raw_api_payload paths
  if (candidateProfile?.raw_api_payload) {
    const payloadVal = resolveFromPayloadStructured(
      normalizeText(field.label),
      field.type,
      candidateProfile.raw_api_payload
    );
    if (payloadVal !== null && payloadVal.trim().length > 0) {
      log.info(`[Resolver] ✅ T1-STRUCT ${field.label} → "${payloadVal}"`);
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: payloadVal,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
        isRequired: Boolean(field.isRequired),
      };
    }
  }

  // 2b. Check profiles.raw_api_payload JSONB for any matching key
  if (candidateProfile?.raw_api_payload) {
    const payloadVal = resolveFromRawApiPayload(field, candidateProfile.raw_api_payload);
    if (payloadVal !== null && payloadVal !== undefined && payloadVal.trim().length > 0) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: payloadVal,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 0.95,
        isRequired: Boolean(field.isRequired),
      };
    }
  }

  // 3. candidate_qa_bank by fingerprint
  const fingerprint = generateFingerprint(field.label, field.type);
  const normLabel = normalizeText(field.label);
  const normName = normalizeText(field.name);
  const normId = normalizeText(field.fieldId);
  const isEmailField = /email/i.test(`${normLabel} ${normName} ${normId}`);
  const isUrlField = /linkedin|website|portfolio|github|url|blog/i.test(normLabel);

  // Email fields must always use company email — never QA bank personal email cache
  if (isEmailField && candidateProfile) {
    const compEmail = (candidateProfile.company_email && candidateProfile.company_email.trim().length > 0)
      ? candidateProfile.company_email.trim()
      : getCompanyEmail(candidateProfile);
    if (compEmail) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: compEmail,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
        isRequired: Boolean(field.isRequired),
      };
    }
    return null;
  }

  try {
    const cachedQA = await getAnswer(applywizzId, fingerprint);
    if (cachedQA && cachedQA.value && cachedQA.value.trim().length > 0) {
      let rawVal = cachedQA.value.trim();

      // Reject non-URL values for URL fields, or normalize domain-only URLs
      if (isUrlField && !/^https?:\/\//i.test(rawVal)) {
        if (/linkedin\.com|github\.com|portfolio/i.test(rawVal)) {
          rawVal = `https://${rawVal.replace(/^\/+/, '')}`;
        } else {
          return null;
        }
      }

      // Reject generic fallback sentences from QA bank
      if (rawVal.includes('I possess relevant professional') || rawVal.includes('Throughout my career as a')) {
        return null;
      }

      let finalValue: string | null = rawVal;
      if (field.options && field.options.length > 0) {
        finalValue = matchBestOption(finalValue, field.options, field.label);
      }
      if (finalValue === null) return null;

      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: finalValue,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: cachedQA.confidence ? Number(cachedQA.confidence) : 1.0,
        isRequired: Boolean(field.isRequired),
      };
    }
  } catch {
    // Ignore QA bank lookup error
  }

  return null;
}

export default resolveTier1;
