/**
 * @fileoverview Real-Time In-Browser Agentic Form Remediation Engine.
 *
 * Catches uncommitted required fields or validation errors right before submission,
 * inspects the live DOM for rendered choices, resolves truthful candidate answers
 * using candidate profile and parsed resume facts in real time, and produces a
 * validated RemediationDecision for Playwright DOM commitment.
 */

import type { Page } from 'playwright';
import { matchChoiceOption } from '../utils/choiceOptions.js';
import { createLogger } from '../utils/logger.js';
import { getProfile, type ProfileRow } from '../db/profiles.js';
import { getOrParseResume, type ResumeParsedRow } from '../resolver/tier2ResumeParse.js';
import { appendResolvedFields, type ApplicationRow } from '../db/applications.js';
import type { ResolvedField } from '../types/index.js';
import { config } from '../config/env.js';
import { cleanLLMOutput } from '../resolver/llmSynthesizer.js';
import { scrapeLiveFieldFromDom, commitRemediatedValue } from './realtimeDomAction.js';

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
  issueFaced: string;
  issueFixed: string;
  source: 'ai_realtime_remediated';
}

export interface LlmCallPayload {
  answer: string;
  confidence: number;
  reasoning: string;
  issueFaced?: string;
  issueFixed?: string;
}

export interface SessionRemediationItem {
  fieldId: string;
  label: string;
  controlType: string;
  status: 'resolved' | 'failed_closed';
  issueFaced: string;
  issueFixed: string;
  value: string | null;
  liveOptions?: string[];
  failureReason?: string;
  attemptedAt: string;
}

export interface SessionRemediationReport {
  timestamp: string;
  attemptedCount: number;
  resolvedCount: number;
  failedCount: number;
  items: SessionRemediationItem[];
}

export interface RemediationOptions {
  llmCallFn?: (prompt: string, systemPrompt: string) => Promise<LlmCallPayload>;
  minConfidence?: number;
}

export interface RemediationRunResult {
  attemptedCount: number;
  remediatedCount: number;
  remediatedFields: ResolvedField[];
  allResolved: boolean;
  errors: string[];
  sessionReport?: SessionRemediationReport;
}

export interface RemediationOrchestratorOptions extends RemediationOptions {
  timeoutMs?: number;
  maxFields?: number;
  getProfileFn?: (applywizzId: string) => Promise<ProfileRow | null>;
  getResumeFn?: (applywizzId: string) => Promise<ResumeParsedRow | null>;
  persistToDb?: boolean;
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

  // 4. Resume facts & Background Evidence
  if (context.resumeFacts) {
    const eduList = Array.isArray(context.resumeFacts.education)
      ? context.resumeFacts.education.map((e: any) => `${e.degree || ''} at ${e.institution || ''} (${e.year || ''})`.trim()).filter(Boolean)
      : (Array.isArray(context.resumeFacts.degrees) ? context.resumeFacts.degrees : []);
    if (eduList.length > 0) {
      facts.push(`Education Degrees: ${eduList.join('; ')}`);
    }
    if (Array.isArray(context.resumeFacts.skills) && context.resumeFacts.skills.length > 0) {
      facts.push(`Key Skills: ${context.resumeFacts.skills.slice(0, 20).join(', ')}`);
    }
    if (Array.isArray(context.resumeFacts.experience) && context.resumeFacts.experience.length > 0) {
      const expSummary = context.resumeFacts.experience.slice(0, 3).map((exp: any) => `${exp.title || ''} at ${exp.company || ''} (${exp.duration || ''})`.trim()).filter(Boolean);
      if (expSummary.length > 0) {
        facts.push(`Work Experience: ${expSummary.join('; ')}`);
      }
    }
  }
  if (p.resume_text && typeof p.resume_text === 'string' && p.resume_text.length > 20) {
    facts.push(`Resume Summary Excerpt:
${p.resume_text.slice(0, 1000).trim()}`);
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
 * Executes default real-time LLM inference using Claude Haiku 5.5.
 */
async function defaultLlmCall(prompt: string, systemPrompt: string): Promise<LlmCallPayload> {
  const apiKey = (config.ANTHROPIC_API_KEY || config.CLAUDE_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('No ANTHROPIC_API_KEY or CLAUDE_API_KEY configured for Claude provider.');
  }

  const modelName = config.CLAUDE_MODEL || 'claude-haiku-5-5';
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  const workspaceId = (config.ANTHROPIC_WORKSPACE_ID || config.CLAUDE_WORKSPACE_ID || '').trim();
  if (workspaceId) {
    headers['anthropic-workspace-id'] = workspaceId;
  }

  const requestBody: Record<string, unknown> = {
    model: modelName,
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  };

  if (!modelName.includes('5-5') && !modelName.includes('5.5')) {
    requestBody.temperature = 0.0;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS || 30000),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    let message = errorBody;
    try {
      const parsed = JSON.parse(errorBody);
      message = parsed?.error?.message || errorBody;
    } catch {
      // ignore
    }
    throw new Error(`Claude API returned HTTP ${res.status}: ${message}`);
  }

  const data = (await res.json()) as any;
  const rawText = Array.isArray(data?.content)
    ? data.content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('')
    : '';

  try {
    const cleaned = cleanLLMOutput(rawText);
    const parsed = JSON.parse(cleaned);
    return {
      answer: String(parsed.answer || ''),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.0,
      reasoning: String(parsed.reasoning || ''),
      issueFaced: typeof parsed.issueFaced === 'string' ? parsed.issueFaced : undefined,
      issueFixed: typeof parsed.issueFixed === 'string' ? parsed.issueFixed : undefined,
    };
  } catch {
    return {
      answer: '',
      confidence: 0.0,
      reasoning: 'Failed to parse JSON response from Claude provider.',
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
  const hasOptions = Array.isArray(field.options) && field.options.length > 0;

  // Deterministic Policy: SMS / Text message communication consent
  const isSmsConsent =
    /communicationConsent/i.test(field.fieldId) ||
    /\b(?:sms|text message|communication)\b/i.test(field.label) ||
    (hasOptions && field.options!.some((opt) => /\b(?:text messages?|sms|consent to receiv)\b/i.test(opt)));

  if (isSmsConsent && hasOptions) {
    const negativeOpt = field.options!.find((opt) => /\b(?:no\b|do not consent|decline)\b/i.test(opt));
    const affirmativeOpt = field.options!.find((opt) => /\b(?:yes\b|i consent|agree)\b/i.test(opt));
    const chosen = negativeOpt || affirmativeOpt;
    if (chosen) {
      log.info(`[Realtime Remediator] Applied deterministic SMS communication consent policy: "${chosen}"`);
      return {
        fieldId: field.fieldId,
        value: chosen,
        chosenOptionLabel: chosen,
        confidence: 1.0,
        reasoning: 'Applied deterministic candidate communication consent policy.',
        issueFaced: `Automation left required communication consent question "${field.label}" uncommitted on the live page.`,
        issueFixed: `Selected "${chosen}" per candidate communication policy.`,
        source: 'ai_realtime_remediated',
      };
    }
  }

  const candidateEvidence = buildCandidateEvidenceSummary(context);

  const systemPrompt = `You are an automated real-time job application form remediation assistant.
You are given the exact question/label from a job application form, available options (if select/radio), and verified candidate profile facts.
Your goal is to provide a truthful, accurate answer for this candidate, and report what issue the automation faced and how it is fixed.

Rules:
1. If options are provided, you MUST select an answer that best represents the candidate from those options.
2. For demographic, EEOC, diversity, sexual orientation, or gender identity questions:
   - If "Decline to state", "I choose not to disclose", "Prefer not to say", or similar option exists, select it.
   - For free-form text on sexual orientation or identity, provide "Decline to state" (or "Heterosexual" if candidate evidence supports it).
   - For transgender status questions: provide "No" (or "Decline to state" if options exist).
   - For protected veteran questions: map truthfully from candidate facts (e.g. "I am not a protected veteran" -> "No").
3. For onsite / office attendance / hybrid willingness questions: provide "Yes" (candidate is willing and flexible).
4. For Yes/No questions on work authorization:
   - If candidate is US Citizen/Permanent Resident, they do NOT require sponsorship (Sponsorship = "No", Authorized = "Yes").
4. In "issueFaced", concisely explain what issue the automation encountered on the live form (e.g., "Automation left required radio unselected on page; options required specific phrasing").
5. In "issueFixed", concisely explain how the answer resolves this using candidate facts (e.g., "Selected 'No' because candidate is a US Citizen requiring no sponsorship").
6. Return ONLY valid JSON in this exact shape:
{
  "answer": "chosen answer text or exact choice",
  "confidence": 0.95,
  "issueFaced": "concise description of issue faced by automation on live form",
  "issueFixed": "concise explanation of how this answer fixes it",
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

Select or synthesize the truthful answer for this candidate, reporting the issue faced and fix.`;

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

    const issueFaced =
      response.issueFaced?.trim() ||
      `Automation left required ${field.type} question "${field.label}" uncommitted on the live page.`;
    const issueFixed =
      response.issueFixed?.trim() ||
      `Resolved and committed "${finalValue}" using candidate profile facts and verified background context.`;

    log.info(
      `[Realtime Remediator] ✅ Resolved "${field.label}" -> "${finalValue}" (conf: ${response.confidence.toFixed(2)})`
    );

    return {
      fieldId: field.fieldId,
      value: finalValue,
      chosenOptionLabel,
      confidence: response.confidence,
      reasoning: response.reasoning,
      issueFaced,
      issueFixed,
      source: 'ai_realtime_remediated',
    };
  } catch (error: any) {
    log.error(`[Realtime Remediator] Resolution failed for "${field.label}": ${error.message}`);
    return null;
  }
}

/**
 * Orchestrates real-time remediation across multiple uncommitted fields on a live Playwright page.
 */
export async function remediateUncommittedFields(
  page: Page,
  unfilledLabels: string[],
  application: ApplicationRow,
  options: RemediationOrchestratorOptions = {}
): Promise<RemediationRunResult> {
  const timeoutMs = options.timeoutMs ?? 20000;
  const deadline = Date.now() + timeoutMs;
  const maxFields = options.maxFields ?? 3;

  const result: RemediationRunResult = {
    attemptedCount: 0,
    remediatedCount: 0,
    remediatedFields: [],
    allResolved: false,
    errors: [],
  };

  const labelsToProcess = unfilledLabels.slice(0, maxFields);
  if (labelsToProcess.length === 0) {
    result.allResolved = true;
    return result;
  }

  log.info(
    `[Realtime Remediator] Starting remediation for ${labelsToProcess.length} field(s) on ${application.job_url || 'application'}`
  );

  // 1. Fetch candidate context
  const getProfileFn = options.getProfileFn ?? getProfile;
  const getResumeFn = options.getResumeFn ?? getOrParseResume;

  let profile: ProfileRow | null = null;
  let resumeFacts: Record<string, any> | undefined = undefined;

  try {
    if (Date.now() > deadline) {
      result.errors.push('Remediation aborted: timeout before profile fetch.');
      return result;
    }
    profile = await getProfileFn(application.applywizz_id);
    if (!profile) {
      result.errors.push(`Candidate profile not found for "${application.applywizz_id}".`);
      return result;
    }

    const resumeRow = await getResumeFn(application.applywizz_id).catch(() => null);
    resumeFacts = resumeRow?.structured && typeof resumeRow.structured === 'object' ? resumeRow.structured : undefined;
  } catch (ctxErr: any) {
    result.errors.push(`Error loading candidate context: ${ctxErr.message}`);
    return result;
  }

  const alreadyResolved: ResolvedField[] = Array.isArray(application.resolved_fields)
    ? (application.resolved_fields as ResolvedField[])
    : [];

  const context: RemediationCandidateContext = {
    profile,
    resumeFacts,
    alreadyResolvedFields: [...alreadyResolved],
    jobTitle: application.job_title || 'Software Professional',
    companyName: application.company_name || 'Hiring Organization',
  };

  // 2. Iterate each uncommitted field
  const sessionItems: SessionRemediationItem[] = [];

  for (const label of labelsToProcess) {
    if (Date.now() > deadline) {
      result.errors.push(`Remediation aborted: timeout exceeded (${timeoutMs}ms limit).`);
      break;
    }

    result.attemptedCount++;
    log.info(`[Realtime Remediator] [${result.attemptedCount}/${labelsToProcess.length}] Remediating "${label}"...`);

    try {
      // Step A: Scrape live DOM
      const scraped = await scrapeLiveFieldFromDom(page, label);
      if (!scraped) {
        const errorMsg = `Field "${label}" could not be located in live DOM.`;
        result.errors.push(errorMsg);
        sessionItems.push({
          fieldId: label.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'unlocated_field',
          label,
          controlType: 'unknown',
          status: 'failed_closed',
          issueFaced: `Automation left required field "${label}" uncommitted; field locator could not find it in DOM.`,
          issueFixed: 'Could not remediate: control not accessible in live DOM.',
          value: null,
          failureReason: errorMsg,
          attemptedAt: new Date().toISOString(),
        });
        continue;
      }

      // Step B: Resolve answer
      const remediationField: RemediationField = {
        fieldId: scraped.locatorSelector.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'remediated_field',
        label: scraped.label,
        type: scraped.type,
        options: scraped.options,
      };

      const decision = await resolveRemediationAnswer(remediationField, context, options);
      if (!decision) {
        const errorMsg = `Could not resolve truthful answer for "${label}".`;
        result.errors.push(errorMsg);
        sessionItems.push({
          fieldId: remediationField.fieldId,
          label: scraped.label,
          controlType: scraped.type,
          status: 'failed_closed',
          issueFaced: `Automation left required ${scraped.type} "${scraped.label}" unselected on live page.`,
          issueFixed: 'Could not resolve: candidate profile and resume facts do not contain verified information; failed closed to prevent hallucination.',
          value: null,
          liveOptions: scraped.options,
          failureReason: errorMsg,
          attemptedAt: new Date().toISOString(),
        });
        continue;
      }

      // Step C: Commit value into DOM
      const commitRes = await commitRemediatedValue(page, scraped, decision);
      if (!commitRes.success) {
        const errorMsg = `Failed to commit "${decision.value}" to DOM for "${label}": ${commitRes.error || 'unknown error'}`;
        result.errors.push(errorMsg);
        sessionItems.push({
          fieldId: decision.fieldId,
          label: scraped.label,
          controlType: scraped.type,
          status: 'failed_closed',
          issueFaced: decision.issueFaced,
          issueFixed: `Attempted to commit "${decision.value}" to ${scraped.type}, but DOM action failed: ${commitRes.error || 'unknown error'}.`,
          value: decision.value,
          liveOptions: scraped.options,
          failureReason: commitRes.error || 'DOM commit error',
          attemptedAt: new Date().toISOString(),
        });
        continue;
      }

      // Step D: Construct ResolvedField with remediation report
      const nowIso = new Date().toISOString();
      const committedVal = commitRes.committedValue || decision.value;
      const remediationReportItem: SessionRemediationItem = {
        fieldId: decision.fieldId,
        label: scraped.label,
        controlType: scraped.type,
        status: 'resolved',
        issueFaced: decision.issueFaced,
        issueFixed: decision.issueFixed,
        value: committedVal,
        liveOptions: scraped.options,
        attemptedAt: nowIso,
      };
      sessionItems.push(remediationReportItem);

      const resolvedField: ResolvedField = {
        fieldId: decision.fieldId,
        name: decision.fieldId,
        type: scraped.type,
        label: scraped.label,
        value: committedVal,
        options: scraped.options,
        source: 'ai' as any,
        resolvedByTier: 5,
        confidence: decision.confidence,
        remediation: {
          issueFaced: decision.issueFaced,
          issueFixed: decision.issueFixed,
          status: 'resolved',
          attemptedAt: nowIso,
          controlType: scraped.type,
          liveOptions: scraped.options,
        },
      };

      result.remediatedFields.push(resolvedField);
      result.remediatedCount++;
      context.alreadyResolvedFields.push(resolvedField);
      log.info(`[Realtime Remediator] ✅ Successfully committed and verified "${label}" -> "${resolvedField.value}"`);
    } catch (fieldErr: any) {
      result.errors.push(`Error during remediation of "${label}": ${fieldErr.message}`);
    }
  }

  // Build aggregated session report
  const sessionReport: SessionRemediationReport = {
    timestamp: new Date().toISOString(),
    attemptedCount: result.attemptedCount,
    resolvedCount: result.remediatedCount,
    failedCount: result.attemptedCount - result.remediatedCount,
    items: sessionItems,
  };
  result.sessionReport = sessionReport;

  // Attach session report to application in-memory error_details
  application.error_details = {
    ...(application.error_details || {}),
    remediationReport: sessionReport,
  };

  // 3. Persist remediated fields and session report to DB
  if (options.persistToDb !== false) {
    try {
      const appId = application.id || application.applywizz_id;
      if (appId) {
        await appendResolvedFields(appId, result.remediatedFields, {
          job_url: application.job_url,
          applywizz_id: application.applywizz_id,
          existingFields: application.resolved_fields,
          remediationReport: sessionReport,
        });
        application.resolved_fields = [...alreadyResolved, ...result.remediatedFields];
      }
    } catch (dbErr: any) {
      log.warn(`[Realtime Remediator] Failed to persist remediated fields to DB: ${dbErr.message}`);
    }
  }

  result.allResolved = result.remediatedCount === labelsToProcess.length && result.errors.length === 0;
  return result;
}
