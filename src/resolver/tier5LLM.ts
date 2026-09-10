/**
 * @fileoverview Tier 5 Answer Resolution: LLM Synthesis & QA Bank Writeback.
 * Source Tag: 'ai', resolvedByTier: 5
 */

import { LLMSynthesizer, type JobContext } from './llmSynthesizer.js';
import { upsertAnswer } from '../db/qaBank.js';
import { generateFingerprint } from './fingerprint.js';
import { profileRowToCandidateProfile, getCompanyEmail, type ProfileRow } from '../db/profiles.js';
import type { ResolvedField, ScannedField } from '../types/index.js';

let synthesizerInstance: LLMSynthesizer | null = null;

function getSynthesizer(): LLMSynthesizer {
  if (!synthesizerInstance) {
    synthesizerInstance = new LLMSynthesizer();
  }
  return synthesizerInstance;
}

/**
 * Transforms ProfileRow into ApplyWizzCandidateProfile for LLMSynthesizer compatibility.
 */
function toCandidateProfile(profile: ProfileRow) {
  return profileRowToCandidateProfile(profile);
}

/**
 * Attempts Tier 5 resolution using LLM synthesis (Gemini/OpenRouter/OpenAI).
 * Automatically writes the synthesized answer to `candidate_qa_bank` with source: 'ai'.
 *
 * @returns ResolvedField with source: 'ai', resolvedByTier: 5, or null if synthesis fails.
 */
export async function resolveTier5(
  applywizzId: string,
  field: ScannedField,
  candidateProfile: ProfileRow,
  jobContext: { companyName: string; jobTitle: string },
  resumeText: string = ''
): Promise<ResolvedField | null> {
  const synthesizer = getSynthesizer();
  const context: JobContext = {
    title: jobContext.jobTitle || 'Position',
    company: jobContext.companyName || 'Company',
  };

  const adaptedProfile = toCandidateProfile(candidateProfile);
  const fingerprint = generateFingerprint(field.label, field.type);
  const combined = `${field.label || ''} ${field.name || ''} ${field.fieldId || ''}`;

  // Email fields must never be LLM-synthesized — use company email only
  if (/email/i.test(combined)) {
    const compEmail = getCompanyEmail(candidateProfile);
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
    const resumeFacts =
      (candidateProfile as any).resume_facts ||
      (candidateProfile.work_experience || candidateProfile.education
        ? { experience: candidateProfile.work_experience, education: candidateProfile.education }
        : undefined);

    const rawResult = await synthesizer.synthesizeAnswer(
      field,
      adaptedProfile,
      resumeText,
      context,
      resumeFacts
    );

    if (rawResult && rawResult.value && rawResult.value.trim().length > 0) {
      const resolvedField: ResolvedField = {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: rawResult.value.trim(),
        source: 'ai',
        resolvedByTier: 5,
        confidence: rawResult.confidence || 0.85,
      };

      // Write-back to persistent candidate QA bank
      try {
        await upsertAnswer({
          applywizz_id: applywizzId,
          question_fingerprint: fingerprint,
          question_label: field.label,
          field_type: field.type,
          value: resolvedField.value,
          source: 'ai',
          confidence: resolvedField.confidence,
        });
      } catch (writeErr: any) {
        console.warn(
          `[Tier 5] ⚠️ QA bank writeback failed for ${applywizzId} [fp: ${fingerprint}]: ${writeErr.message}`
        );
      }

      return resolvedField;
    }
  } catch (err: any) {
    console.warn(`[Tier 5] LLM synthesis error for ${applywizzId} [${field.label}]: ${err.message}`);
  }

  return null;
}

export default resolveTier5;
