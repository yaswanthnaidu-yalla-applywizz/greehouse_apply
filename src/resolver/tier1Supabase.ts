/**
 * @fileoverview Tier 1 Answer Resolution: Supabase Profiles & Exact QA Bank Lookup.
 * Source Tag: 'supabase', resolvedByTier: 1
 */

import Fuse from 'fuse.js';
import { getProfile, type ProfileRow } from '../db/profiles.js';
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

  // 2. Substring match
  for (const opt of options) {
    const normOpt = normalizeText(opt);
    if (normOpt.includes(normTarget) || normTarget.includes(normOpt)) {
      return opt;
    }
  }

  // 3. Boolean heuristics (Yes/No)
  if (normTarget === 'yes' || normTarget === 'true' || normTarget === '1') {
    const yesOpt = options.find((o) => /^yes/i.test(o.trim()) || o.trim() === '1');
    if (yesOpt) return yesOpt;
  }
  if (normTarget === 'no' || normTarget === 'false' || normTarget === '0') {
    const noOpt = options.find((o) => /^no/i.test(o.trim()) || o.trim() === '0');
    if (noOpt) return noOpt;
  }

  // 4. Fuzzy option match
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

  // File upload: Resume
  if (field.type === 'file' || /resume|cv\b/i.test(combined)) {
    return profile.resume_storage_path || `resumes/${profile.applywizz_id}_resume.pdf`;
  }

  // First Name
  if (/(first|given)\s*name/i.test(combined) || normId === 'first name' || normName === 'first name') {
    return profile.first_name || (profile.client_name ? profile.client_name.split(' ')[0] : null);
  }

  // Last Name
  if (/(last|family|sur)\s*name/i.test(combined) || normId === 'last name' || normName === 'last name') {
    if (profile.last_name) return profile.last_name;
    if (profile.client_name) {
      const parts = profile.client_name.trim().split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
    }
    return null;
  }

  // Full Name
  if (/(full|client)\s*name/i.test(combined) || combined === 'name') {
    return profile.client_name || `${profile.first_name || ''} ${profile.last_name || ''}`.trim();
  }

  // Email
  if (/email/i.test(combined)) {
    return profile.email || null;
  }

  // Phone
  if (/phone|mobile|contact number/i.test(combined)) {
    return profile.phone || null;
  }

  // LinkedIn
  if (/linkedin/i.test(combined)) {
    return profile.linkedin_url || null;
  }

  // Website / Portfolio
  if (/portfolio|website|personal site|github/i.test(combined)) {
    if (/github/i.test(combined) && profile.github_url) return profile.github_url;
    if (profile.website_url) return profile.website_url;
    if (profile.github_url) return profile.github_url;
    return null;
  }

  // Location
  if (/candidate location|current location|city|state|residence|address/i.test(combined)) {
    return profile.location || null;
  }

  // Work Authorization / Legal authorization
  if (/authorized to work|legally authorized|work authorization|legal right to work/i.test(combined)) {
    const rawVal = profile.work_authorization || 'Yes';
    return matchBestOption(rawVal, field.options);
  }

  // Visa Sponsorship
  if (/sponsorship|require.*visa|future.*sponsorship|visa status/i.test(combined)) {
    const rawVal = profile.requires_sponsorship ? 'Yes' : 'No';
    return matchBestOption(rawVal, field.options);
  }

  // Demographics / Salary / Experience from raw_api_payload if present
  if (profile.raw_api_payload?.demographics) {
    const demo = profile.raw_api_payload.demographics;
    if (/salary|compensation|expected pay/i.test(combined) && demo.salaryRange) {
      return matchBestOption(demo.salaryRange, field.options);
    }
    if (/gender/i.test(combined) && demo.gender) {
      return matchBestOption(demo.gender, field.options);
    }
    if (/race|ethnicity/i.test(combined) && demo.raceEthnicity) {
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
 * 1. Exact lookup in `candidate_qa_bank` by (applywizzId, fingerprint)
 * 2. Standard profile column matching from `profiles`
 *
 * @returns ResolvedField with source: 'supabase', resolvedByTier: 1, or null if miss.
 */
export async function resolveTier1(
  applywizzId: string,
  field: ScannedField,
  profile?: ProfileRow | null
): Promise<ResolvedField | null> {
  const fingerprint = generateFingerprint(field.label, field.type);

  // 1. Direct QA Bank Lookup
  try {
    const cachedQA = await getAnswer(applywizzId, fingerprint);
    if (cachedQA && cachedQA.value) {
      let finalValue = cachedQA.value;
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

  // 2. Profile Column Match
  const candidateProfile = profile || (await getProfile(applywizzId));
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

  return null;
}

export default resolveTier1;
