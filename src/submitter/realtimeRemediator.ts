/**
 * @fileoverview Real-Time In-Browser Agentic Form Remediation Engine.
 *
 * Catches uncommitted required fields or validation errors right before submission,
 * inspects the live DOM for rendered choices, resolves truthful candidate answers
 * using candidate profile and parsed resume facts in real time, and produces a
 * validated RemediationDecision for Playwright DOM commitment.
 */

import { matchChoiceOption } from '../utils/choiceOptions.js';
import { createLogger } from '../utils/logger.js';
import type { ProfileRow } from '../db/profiles.js';
import type { ResolvedField } from '../types/index.js';
import { callGemini } from '../resolver/geminiProvider.js';

const log = createLogger('Realtime Remediator');

export const MIN_REMEDIATION_CONFIDENCE = 0.70;

export interface RemediationField {
  fieldId: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'combobox';
  options?: string[];
  currentValue?: string;
  errorHint?: string;
}

export interface RemediationCandidateContext {
  profile: ProfileRow;
  resumeFacts?: Record<string, any>;
  alreadyResolvedFields: ResolvedField[];
  jobTitle: string;
  companyName: string;
}

export interface RemediationDecision {
  fieldId: string;
  value: string;
  chosenOptionLabel?: string;
  confidence: number;
  reasoning: string;
  source: 'ai_realtime_remediated';
}

export interface LlmCallPayload {
  answer: string;
  confidence: number;
  reasoning: string;
}

export interface RemediationOptions {
  llmCallFn?: (prompt: string, systemPrompt: string) => Promise<LlmCallPayload>;
  minConfidence?: number;
}

/**
 * Builds a compact summary of candidate facts relevant to form resolution.
 */
function buildCandidateEvidenceSummary(context: RemediationCandidateContext): string {
  const p = context.profile;
  const facts: string[] = [];

  // 1. Identity & Location
  const fullName = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.client_name || '';
  if (fullName) {
    facts.push(`Candidate Name: ${fullName}`);
  }
  if (p.location || p.country) {
    facts.push(`Location: ${[p.location, p.country].filter(Boolean).join(', ')}`);
  }

  // 2. Work Authorization & Sponsorship
  if (p.work_authorization) {
    facts.push(`Work Authorization: ${p.work_authorization}`);
  }
  if (p.requires_sponsorship !== undefined && p.requires_sponsorship !== null) {
    facts.push(`Requires Visa Sponsorship: ${p.requires_sponsorship ? 'Yes' : 'No'}`);
  }

  // 3. Additional Profile Details (from ApplyWizz API payload)
  const additionalInfo = p.raw_api_payload?.additional_information;
  if (additionalInfo && typeof additionalInfo === 'object') {
    for (const [k, v] of Object.entries(additionalInfo)) {
      if (v !== undefined && v !== null && typeof v !== 'object') {
        facts.push(`${k.replace(/_/g, ' ')}: ${String(v)}`);
      }
    }
  }

  // 4. Resume facts (education, skills)
  if (context.resumeFacts) {
    if (Array.isArray(context.resumeFacts.degrees) && context.resumeFacts.degrees.length > 0) {
      facts.push(`Education Degrees: ${context.resumeFacts.degrees.join('; ')}`);
    }
    if (Array.isArray(context.resumeFacts.skills) && context.resumeFacts.skills.length > 0) {
      facts.push(`Key Skills: ${context.resumeFacts.skills.slice(0, 15).join(', ')}`);
    }
  }

  // 5. Existing committed answers on this form
  if (context.alreadyResolvedFields.length > 0) {
    const committed = context.alreadyResolvedFields
      .filter((f) => f.value && typeof f.value === 'string' && f.value.length < 100)
      .map((f) => `${f.label || f.fieldId}: ${f.value}`);
    if (committed.length > 0) {
      facts.push(`Already answered on this application:\n  - ${committed.slice(0, 10).join('\n  - ')}`);
    }
  }

  return facts.join('\n');
}

/**
 * Executes default real-time LLM inference using configured provider.
 */
async function defaultLlmCall(prompt: string, systemPrompt: string): Promise<LlmCallPayload> {
  const res = await callGemini({
    prompt,
    systemMessage: systemPrompt,
    maxTokens: 512,
    temperature: 0.0,
    responseMimeType: 'application/json',
  });

  try {
    const parsed = JSON.parse(res.text.trim());
    return {
      answer: String(parsed.answer || ''),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.0,
      reasoning: String(parsed.reasoning || ''),
    };
  } catch {
    return {
      answer: '',
      confidence: 0.0,
      reasoning: 'Failed to parse JSON response from LLM provider.',
    };
  }
}

/**
 * Resolves an uncommitted form field in real time using candidate background context.
 */
export async function resolveRemediationAnswer(
  field: RemediationField,
  context: RemediationCandidateContext,
  options: RemediationOptions = {}
): Promise<RemediationDecision | null> {
  const minConfidence = options.minConfidence ?? MIN_REMEDIATION_CONFIDENCE;
  const llmCall = options.llmCallFn ?? defaultLlmCall;

  const candidateEvidence = buildCandidateEvidenceSummary(context);
  const hasOptions = Array.isArray(field.options) && field.options.length > 0;

  const systemPrompt = `You are an automated real-time job application form remediation assistant.
You are given the exact question/label from a job application form, available options (if select/radio), and the verified candidate profile facts.
Your goal is to provide a truthful, accurate answer for this candidate.

Rules:
1. If options are provided, you MUST select an answer that best represents the candidate from those options.
2. If the candidate facts genuinely do NOT provide enough information to answer truthfully, return an empty string for "answer" and confidence < 0.5.
3. For Yes/No questions on work authorization:
   - If candidate is US Citizen/Permanent Resident, they do NOT require sponsorship (Sponsorship = "No", Authorized = "Yes").
4. Return ONLY valid JSON in this exact shape:
{
  "answer": "chosen answer text or exact choice",
  "confidence": 0.95,
  "reasoning": "brief explanation"
}`;

  const prompt = `Job Details:
- Company: ${context.companyName}
- Job Title: ${context.jobTitle}

Form Question to Resolve:
- Label: "${field.label}"
- Input Type: ${field.type}
${hasOptions ? `- Available Options:\n  * ${field.options!.join('\n  * ')}` : '- Free-form input'}
${field.errorHint ? `- Error message shown on page: "${field.errorHint}"` : ''}

Candidate Evidence:
${candidateEvidence}

Select or synthesize the truthful answer for this candidate.`;

  try {
    const response = await llmCall(prompt, systemPrompt);

    if (!response || typeof response.answer !== 'string' || !response.answer.trim()) {
      log.warn(`[Realtime Remediator] Empty answer returned for field "${field.label}".`);
      return null;
    }

    if (response.confidence < minConfidence) {
      log.warn(
        `[Realtime Remediator] Low confidence (${response.confidence.toFixed(2)} < ${minConfidence}) for field "${field.label}". Failing closed.`
      );
      return null;
    }

    let finalValue = response.answer.trim();
    let chosenOptionLabel: string | undefined = undefined;

    // If field has choices (select/radio), align strictly to available options
    if (hasOptions) {
      const matched = matchChoiceOption(finalValue, field.options!);
      if (!matched) {
        log.warn(
          `[Realtime Remediator] LLM answer "${finalValue}" did not match any available options for "${field.label}": [${field.options!.join(', ')}]. Failing closed.`
        );
        return null;
      }
      finalValue = matched;
      chosenOptionLabel = matched;
    }

    log.info(
      `[Realtime Remediator] ✅ Resolved "${field.label}" -> "${finalValue}" (conf: ${response.confidence.toFixed(2)})`
    );

    return {
      fieldId: field.fieldId,
      value: finalValue,
      chosenOptionLabel,
      confidence: response.confidence,
      reasoning: response.reasoning,
      source: 'ai_realtime_remediated',
    };
  } catch (error: any) {
    log.error(`[Realtime Remediator] Resolution failed for "${field.label}": ${error.message}`);
    return null;
  }
}
