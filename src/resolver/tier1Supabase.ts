/**
 * @fileoverview Tier 1 Answer Resolution: Supabase Profiles & Exact QA Bank Lookup.
 * Source Tag: 'supabase', resolvedByTier: 1
 */

import Fuse from 'fuse.js';
import { getProfile, type ProfileRow, getCompanyEmail } from '../db/profiles.js';
import { getAnswer } from '../db/qaBank.js';
import { generateFingerprint, normalizeText } from './fingerprint.js';
import type { ResolvedField, ScannedField } from '../types/index.js';

/**
 * Matches target value to the closest matching option in dropdown or radio group.
 */
function matchBestOption(targetValue: string, options?: string[]): string {
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

  return options[0];
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
      const countryMatch = matchBestOption(targetCountry, field.options);
      if (countryMatch) return countryMatch;
      const codeMatch = matchBestOption(isYaswanth ? '+91' : (profile.country_code || (isAkshitha ? '+1' : '+91')), field.options);
      if (codeMatch) return codeMatch;
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
      const codeMatch = matchBestOption(targetCode, field.options);
      if (codeMatch) return codeMatch;
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
    return matchBestOption(targetCountry, field.options);
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

  // Work Authorization / Legal authorization
  if (/authorized to work|legally authorized|work authorization|legal right to work/i.test(combined)) {
    const rawVal = profile.work_authorization || 'Yes';
    return matchBestOption(rawVal, field.options);
  }

  // Visa Sponsorship (must precede location to prevent "United States" false match)
  if (/sponsorship|require.*visa|future.*sponsorship|visa status/i.test(combined)) {
    const rawVal = profile.requires_sponsorship ? 'Yes' : 'No';
    return matchBestOption(rawVal, field.options);
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
    return matchBestOption('No', field.options);
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
    return matchBestOption('No', field.options);
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
    return matchBestOption('Yes', field.options);
  }

  // Relocation / same-city willingness (binary Yes/No — must precede city/location heuristics)
  if (
    /(willing to relocate|open to relocate|relocate to|relocation|in the same city|same city as)/i.test(
      combined
    )
  ) {
    const addInfo = profile.raw_api_payload?.additional_information;
    const willing = addInfo?.willing_to_relocate !== false;
    return matchBestOption(willing ? 'Yes' : 'No', field.options);
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
    return matchBestOption(rawVal, field.options);
  }

  // Demographics / Salary / Experience from raw_api_payload if present
  if (profile.raw_api_payload?.demographics) {
    const demo = profile.raw_api_payload.demographics;
    if (/salary|compensation|expected pay/i.test(combined) && demo.salaryRange) {
      return matchBestOption(demo.salaryRange, field.options);
    }
    if (/transgender/i.test(combined)) {
      return matchBestOption('No', field.options);
    }
    if (/sexual orientation/i.test(combined)) {
      return matchBestOption("I don't wish to answer", field.options);
    }
    if (/hispanic|latino/i.test(combined)) {
      return matchBestOption(demo.isHispanicLatino || 'No', field.options);
    }
    if (/gender/i.test(combined) && !/transgender/i.test(combined) && demo.gender) {
      return matchBestOption(demo.gender, field.options);
    }
    if (/race|ethnicity/i.test(combined) && !/hispanic|latino/i.test(combined) && demo.raceEthnicity) {
      return matchBestOption(demo.raceEthnicity, field.options);
    }
    if (/veteran/i.test(combined) && demo.veteranStatus) {
      return matchBestOption(demo.veteranStatus, field.options);
    }
    if (/disability/i.test(combined) && demo.disabilityStatus) {
      return matchBestOption(demo.disabilityStatus, field.options);
    }
  }

  return null;
}

/**
 * Attempts Tier 1 answer resolution.
 * 1. Standard profile column matching & deterministic policy rules (ground truth)
 * 2. Exact lookup in `candidate_qa_bank` by (applywizzId, fingerprint)
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
  // 1. Profile Column & Deterministic Policy Match (Ground Truth)
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
      };
    }
  }

  // 2. Direct QA Bank Lookup
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
      };
    }
    return null;
  }

  try {
    const cachedQA = await getAnswer(applywizzId, fingerprint);
    if (cachedQA && cachedQA.value && cachedQA.value.trim().length > 0) {
      const rawVal = cachedQA.value.trim();

      // Reject non-URL values for URL fields
      if (isUrlField && !/^https?:\/\//i.test(rawVal)) {
        return null;
      }

      // Reject generic fallback sentences from QA bank
      if (rawVal.includes('I possess relevant professional') || rawVal.includes('Throughout my career as a')) {
        return null;
      }

      let finalValue = rawVal;
      if (field.options && field.options.length > 0) {
        finalValue = matchBestOption(finalValue, field.options);
      }

      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: finalValue,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: cachedQA.confidence ? Number(cachedQA.confidence) : 1.0,
      };
    }
  } catch (err: any) {
    console.warn(`[Tier 1] QA Bank lookup error for ${applywizzId}: ${err.message}`);
  }

  return null;
}

export default resolveTier1;
