/**
 * @fileoverview LLM Answer Synthesizer for Tier 2 Dynamic Q&A (Source Tag: 'ai').
 *
 * Implements Google Gemini and OpenAI SDK integrations to synthesize answers for behavioral,
 * experience-based, and open-ended questions using candidate profile summaries and job context.
 *
 * References:
 * - 02-trd.md (Section 3.4)
 * - 03-workflow.md (Step 4)
 * - 05-backend-schema.md (Section 1.4)
 */

import { config } from '../config/env.js';
import type {
  ApplyWizzCandidateProfile,
  ResolvedField,
  ScannedField,
} from '../types/index.js';
import { haltWithDevAlert, createLogger } from '../utils/logger.js';
import { matchChoiceOption } from '../utils/choiceOptions.js';
import { emitFailureDiagnostic } from '../utils/failureDiagnostics.js';
import { buildQuestionRelevantEvidence } from './candidateEvidence.js';
import { isBehavioralOrMotivationalQuestion } from './starClassifier.js';
import { CORPORATE_POLICY_PROMPT_GUIDELINES } from './corporatePolicies.js';
import { isPipelineAbortRequested } from '../orchestrator/pipelineAbort.js';
import { callGemini } from './geminiProvider.js';
import { callOllama } from './ollamaProvider.js';
import {
  AnthropicHttpBatchProvider,
  executeAnthropicBatchWithRetry,
  JsonBatchRunStateStore,
  type AnthropicBatchProvider,
  type AnthropicBatchRequest,
  type AnthropicBatchStatus,
  type BatchRunStateStore,
} from './anthropicMessageBatch.js';

const log = createLogger('LLM Synthesizer');

let firstProviderCallChecked = false;

export interface LlmProviderErrorDiagnostics {
  errorName?: string;
  statusCode?: number;
  errorCode?: string;
  errorType?: string;
  requestId?: string;
  parameter?: string;
  retryAfter?: string;
  message: string;
}

function safeDiagnosticString(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-(?:or-v1-|proj-|live-)?|AIza)[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_KEY]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/https?:\/\/\S+/gi, '[REDACTED_URL]')
    .slice(0, maxLength);
}

function readErrorHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const candidate = headers as { get?: (headerName: string) => unknown } & Record<string, unknown>;
  const value =
    typeof candidate.get === 'function'
      ? candidate.get(name)
      : candidate[name] ?? candidate[name.toLowerCase()];
  return safeDiagnosticString(value, 80);
}

export function getLlmProviderErrorDiagnostics(err: unknown): LlmProviderErrorDiagnostics {
  const error =
    err && typeof err === 'object'
      ? (err as {
          name?: unknown;
          message?: unknown;
          status?: unknown;
          statusCode?: unknown;
          code?: unknown;
          type?: unknown;
          param?: unknown;
          request_id?: unknown;
          requestId?: unknown;
          headers?: unknown;
          response?: { status?: unknown; headers?: unknown };
          error?: Record<string, unknown>;
        })
      : {};
  const nested = error.error && typeof error.error === 'object' ? error.error : {};
  const rawStatus = error.status ?? error.statusCode ?? error.response?.status;
  const statusCode =
    typeof rawStatus === 'number'
      ? rawStatus
      : typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus)
        ? Number(rawStatus)
        : undefined;
  const headers = error.headers ?? error.response?.headers;
  return {
    errorName: safeDiagnosticString(error.name, 80),
    statusCode,
    errorCode: safeDiagnosticString(error.code ?? nested.code, 100),
    errorType: safeDiagnosticString(error.type ?? nested.type, 100),
    requestId: safeDiagnosticString(error.request_id ?? error.requestId ?? nested.request_id, 100),
    parameter: safeDiagnosticString(error.param ?? nested.param, 100),
    retryAfter:
      readErrorHeader(headers, 'retry-after-ms') ??
      readErrorHeader(headers, 'retry-after'),
    message: safeDiagnosticString(error.message ?? (err instanceof Error ? err.message : String(err))) || 'Provider request failed without an error message.',
  };
}

function formatProviderErrorDiagnostics(diagnostics: LlmProviderErrorDiagnostics): string {
  return [
    diagnostics.statusCode !== undefined ? `http_status=${diagnostics.statusCode}` : undefined,
    diagnostics.errorName ? `error_name=${diagnostics.errorName}` : undefined,
    diagnostics.errorCode ? `error_code=${diagnostics.errorCode}` : undefined,
    diagnostics.errorType ? `error_type=${diagnostics.errorType}` : undefined,
    diagnostics.parameter ? `parameter=${diagnostics.parameter}` : undefined,
    diagnostics.requestId ? `request_id=${diagnostics.requestId}` : undefined,
    diagnostics.retryAfter ? `retry_after=${diagnostics.retryAfter}` : undefined,
    `message="${diagnostics.message}"`,
  ]
    .filter(Boolean)
    .join(' ');
}

function haltIfFirstProviderCallFailed(reachedProvider: boolean): void {
  if (firstProviderCallChecked) return;
  firstProviderCallChecked = true;
  if (!reachedProvider) {
    haltWithDevAlert(
      'LLM',
      'LLM provider unreachable — all configured providers fail on first call'
    );
  }
}

/**
 * Job context metadata passed into LLM prompt synthesis.
 */
export interface JobContext {
  /** Target job title */
  title: string;
  /** Hiring company name */
  company: string;
}

export interface BatchQuestion {
  label: string;
  type: string;
  value?: string;
  /** When set, batch prompt instructs the model to pick one option verbatim. */
  options?: string[];
  optionsComplete?: boolean;
  candidateEvidence?: string;
  corporateDefaultHint?: string;
}

export interface BatchSynthesizeResult {
  answers: string[];
  confidences?: number[];
  supportQuotes?: string[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    cost?: number;
    model: string;
  };
}

const answerSupportQuotes = new WeakMap<ResolvedField, string>();

export function getAnswerSupportQuote(answer: ResolvedField | null | undefined): string | undefined {
  return answer ? answerSupportQuotes.get(answer) : undefined;
}

/**
 * Options configuring the LLMSynthesizer.
 */
export interface LLMSynthesizerOptions {
  /** Active LLM provider ('anthropic', 'gemini', or 'ollama') */
  provider?: 'anthropic' | 'gemini' | 'ollama';
  /** Gemini API key override */
  geminiApiKey?: string;
  /** Gemini model override */
  geminiModel?: string;
  /** Ollama endpoint override */
  ollamaEndpoint?: string;
  /** Ollama model override */
  ollamaModel?: string;
  /** Ollama Sonnet review model override */
  ollamaSonnetModel?: string;
  /** Anthropic workspace ID override */
  workspaceId?: string;
  /** LLM API Key override */
  apiKey?: string;
  /** Model name override */
  modelName?: string;
  /** OpenRouter key override for isolated escalation tests or dedicated clients. */
  openRouterApiKey?: string;
  /** DeepSeek model override; production configuration defaults to R1 0528. */
  deepSeekModel?: string;
  /** Provider and state-store seams for offline Message Batch protocol tests. */
  batchProvider?: AnthropicBatchProvider;
  batchStateStore?: BatchRunStateStore;
  batchPollIntervalMs?: number;
  batchPollSleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Detects binary Yes/No form questions that must never receive prose or location strings.
 */
/** Field types that must answer from a fixed option list when options are known. */
const CHOICE_FIELD_TYPES = new Set<ScannedField['type']>(['select', 'radio', 'checkbox']);

export function fieldHasChoiceOptions(field: ScannedField): boolean {
  const opts = getEffectiveFieldOptions(field);
  return opts !== undefined && opts.length > 0;
}

export function isRichEeocIdentityQuestion(field: ScannedField): boolean {
  return /gender identity|sexual orientation|\bethnicity\b|\bpronouns?\b/i.test(field.label);
}

/**
 * Options for prompt + alignment — uses scanned options, or defaults Yes/No for binary radio/select.
 */
export function getEffectiveFieldOptions(field: ScannedField): string[] | undefined {
  if (field.optionsComplete === false) return undefined;
  if (field.options && field.options.length > 0) {
    return field.options;
  }
  if (
    (field.type === 'radio' || field.type === 'select') &&
    !isRichEeocIdentityQuestion(field) &&
    isBinaryYesNoQuestion(field)
  ) {
    return ['Yes', 'No'];
  }
  return undefined;
}

/** Options safe to persist into ResolvedField metadata: only options observed by the scanner. */
export function getPersistedFieldOptions(field: ScannedField): string[] | undefined {
  return field.options && field.options.length > 0 ? field.options : undefined;
}

export function isBinaryYesNoQuestion(field: ScannedField): boolean {
  const label = field.label || '';
  const combined = `${label} ${field.name || ''} ${field.fieldId || ''}`;
  const opts = field.options && field.options.length > 0 ? field.options : undefined;

  // Questions explicitly asking to select a location, country, or dropdown option are NOT binary Yes/No
  if (
    /\b(?:select (?:the|a) (?:location|country|state|city|option)|which (?:location|country|state|city)|using the drop down list below|choose (?:the|a) (?:location|country|state|city))\b/i.test(
      combined
    )
  ) {
    return false;
  }

  if (opts && opts.length > 0) {
    const normOpts = opts.map((o) => o.toLowerCase().trim());
    const hasYes = normOpts.some((o) => o === 'yes' || /^yes\b/i.test(o));
    const hasNo = normOpts.some((o) => o === 'no' || /^no\b/i.test(o));
    if (hasYes && hasNo) return true;
  }

  if (field.type === 'radio' || field.type === 'select' || field.type === 'checkbox') {
    if (
      /^(are|is|do|does|did|will|would|can|could|have|has|had)\b/i.test(label.trim()) ||
      /(willing to|able to|authorized to|eligible to|in the same city|sponsorship|require.*visa)/i.test(
        combined
      )
    ) {
      return true;
    }
  }

  // Text / textarea fields that are behavioral/motivational are open-ended STAR questions, not binary Yes/No
  if (isBehavioralOrMotivationalQuestion(field)) {
    return false;
  }

  return (
    /^(are|is|do|does|did|will|would|can|could|have|has|had)\b/i.test(label.trim()) ||
    /(willing to|able to|authorized to|eligible to|in the same city)/i.test(combined)
  );
}

/**
 * Infer strict Yes/No from profile for common authorization / sponsorship questions.
 */
export function inferYesNoFromProfile(
  field: ScannedField,
  profile: ApplyWizzCandidateProfile
): 'Yes' | 'No' | null {
  const combined = `${field.label || ''} ${field.name || ''} ${field.fieldId || ''}`.toLowerCase();

  if (/authorized to work|legally authorized|work authorization|legal right to work|eligible to work/i.test(combined)) {
    const auth = (profile.workAuthorization || '').trim();
    if (!auth) return null;
    if (/^(no|false)$/i.test(auth) || /not authorized|unauthorized/i.test(auth)) {
      return 'No';
    }
    return 'Yes';
  }

  if (/sponsorship|require.*visa|future.*sponsorship|visa status/i.test(combined)) {
    return profile.requiresSponsorship ? 'Yes' : 'No';
  }

  if (
    /(previously.*employed|worked for|worked at|former employee|interviewed.*before|interviewed.*previously|internal employee|relative.*employ|family.*employ|non-compete|non compete|restrict.*employment|felony|terminated)/i.test(
      combined
    )
  ) {
    return 'No';
  }

  if (/(terms and conditions|privacy policy|privacy notice|certify|acknowledge|background check|arbitrat|agreement to arbitrate)/i.test(combined)) {
    return 'Yes';
  }

  if (/(willing to relocate|open to relocate|relocation|in the same city|same city as|in-person|in one of our offices|hybrid)/i.test(combined)) {
    const willing = profile.demographics?.willingToRelocate !== false;
    return willing ? 'Yes' : 'No';
  }

  return null;
}

function buildProfileDecisionContext(field: ScannedField, profile: ApplyWizzCandidateProfile): string {
  const sponsorshipRaw = profile.requiresSponsorship === true ? 'true' : 'false';
  const sponsorshipYesNo = profile.requiresSponsorship ? 'Yes' : 'No';
  const authRaw = (profile.workAuthorization || '').trim() || '(not provided)';

  const lines = [
    'Yes/No mapping from candidate profile — use these exact values, do not guess:',
    `- requires_sponsorship: ${sponsorshipRaw} (exact profile value). For sponsorship / visa-sponsorship questions, map true → Yes, false → No. Mapped answer: ${sponsorshipYesNo}.`,
    `- work_authorization: ${authRaw} (exact profile value). For work-authorization / legally-authorized-to-work questions, decide Yes or No from this value only. If it is not provided, do not invent an answer.`,
  ];

  const inferred = inferYesNoFromProfile(field, profile);
  if (inferred) {
    lines.push(`- Mapped answer for this question from the profile fields above: ${inferred}`);
  }

  return `\n${lines.join('\n')}\n`;
}

export const LLM_MIN_CONFIDENCE = 0.65;

export type Tier5QuestionKind = 'factual' | 'creative' | 'experience';

export interface Tier5AnswerDecision {
  kind: Tier5QuestionKind;
  evidence: string;
  supportQuote: string;
  stage: 'haiku' | 'sonnet' | 'deepseek-flash' | 'deepseek-r1';
  answer: string;
  confidence: number | null;
  accepted: boolean;
  reason: 'supported' | 'missing_evidence' | 'irrelevant_evidence' | 'unsupported_evidence' | 'contradictory_evidence' | 'low_confidence' | 'empty_answer' | 'review_required';
}

const GROUNDING_STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'do', 'does', 'for', 'from', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'the', 'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your', 'worked', 'work', 'experience']);

function groundingTokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((token) => token.length > 2 && !GROUNDING_STOP_WORDS.has(token));
}

function hasQuestionRelevantEvidence(field: ScannedField, key: string): boolean {
  const questionTokens = new Set(groundingTokens(`${field.label} ${field.name} ${field.fieldId}`));
  const keyText = key.toLowerCase().replace(/[_-]+/g, ' ');
  const question = `${field.label} ${field.name} ${field.fieldId}`.toLowerCase();
  if (/authorized to work|work authorization|legal right to work|eligible to work/.test(question) && /work authorization|work eligibility|visa status/.test(keyText)) return true;
  if (/veteran|military/.test(question) && /veteran|military/.test(keyText)) return true;
  if (/sponsorship|require.{0,20}visa/.test(question) && /requires sponsorship|sponsorship required/.test(keyText)) return true;
  if (/\b(?:college|university|associate|bachelor|master|doctorate|ph\.?d|degree)\b/.test(question) &&
      /(?:^|[\s.])(?:profile[.\s]+)?(?:education|resume[.\s]+facts[.\s]+education)(?=[\s\[.]|$)/i.test(keyText)) return true;
  return groundingTokens(keyText).some((token) => questionTokens.has(token));
}

type EvidencePolarity = 'affirmative' | 'negative' | 'uncertain';

function workAuthorizationPolarity(text: string, answer = false): EvidencePolarity {
  const normalized = text.toLowerCase().replace(/\b(u\.s\.|us)\b/g, 'united states');
  if (answer && /^\s*(?:yes|y|true)\b/i.test(normalized)) return 'affirmative';
  if (answer && /^\s*(?:no|n|false)\b/i.test(normalized)) return 'negative';
  const concept = String.raw`(?:(?:authorized|eligible|permitted|have the legal right)\s+to\s+work|work\s+authorization|authorized|eligible|permitted)`;
  // Keep negation attached to its clause so sponsorship negation cannot flip authorization.
  const clauses = normalized.split(/[.!?;,:]|\b(?:but|however|although|whereas)\b/).map((clause) => clause.trim()).filter(Boolean);
  const polarities = clauses.map((clause): EvidencePolarity | null => {
    const hasAuthorization = new RegExp(String.raw`\b(?:${concept}|u\.s\.?\s+citizen|united states citizen)\b`, 'i').test(clause);
    if (!hasAuthorization) return null;
    // Do not infer polarity through a double negative or unresolved status.
    if (/\b(?:not|never|no)\b.{0,32}\b(?:without|lack(?:s|ed)?|absence)\b|\b(?:without|lack(?:s|ed)?|absence)\b.{0,32}\b(?:not|never|no)\b|\b(?:pending|uncertain|unknown|unclear|undetermined|not sure|unsure|do not know|don't know)\b/i.test(clause)) return 'uncertain';
    if (new RegExp(String.raw`\bno\s+(?:(?:current|valid|existing)\s+){0,2}(?:${concept})\b`, 'i').test(clause) ||
        new RegExp(String.raw`\b(?:lack(?:s|ed)?\s+(?:of\s+)?|absence\s+of\s+)(?:(?:current|valid|existing)\s+){0,2}(?:${concept})\b`, 'i').test(clause) ||
        new RegExp(String.raw`\b(?:without|does not|do not|doesn't|don't)\s+(?:(?:currently|current|valid|existing)\s+){0,2}(?:have\s+)?(?:${concept})\b`, 'i').test(clause) ||
        new RegExp(String.raw`\b(?:not|never|cannot|can't|unable|ineligible)\b(?:\s+\w+){0,3}\s+(?:${concept})`, 'i').test(clause) ||
        new RegExp(String.raw`\b(?:not|never|cannot|can't|unable|ineligible)\b.{0,28}\b(?:authorized|eligible|permitted|right to work)\b`, 'i').test(clause)) return 'negative';
    if (/\b(?:u\.s\.?\s+citizen|united states citizen)\b/i.test(clause) || new RegExp(String.raw`\b(?:${concept})\b`, 'i').test(clause)) return 'affirmative';
    return 'uncertain';
  });
  const authorizationPolarities = polarities.filter((polarity): polarity is EvidencePolarity => polarity !== null);
  const known = new Set(authorizationPolarities.filter((polarity) => polarity !== 'uncertain'));
  if (!authorizationPolarities.length || known.size > 1 || authorizationPolarities.includes('uncertain')) return 'uncertain';
  return known.values().next().value || 'uncertain';
}

function yesNoPolarity(text: string, answer = false): EvidencePolarity {
  if (/^\s*(?:yes|y|true|1)\s*$/i.test(text)) return 'affirmative';
  if (/^\s*(?:no|n|false|0)\s*$/i.test(text)) return 'negative';
  const clauses = text.toLowerCase().split(/[.!?;,:]|\b(?:but|however|although|whereas)\b/).map((part) => part.trim()).filter(Boolean);
  const polarities = clauses.map((clause): EvidencePolarity | null => {
    if (/\b(?:veteran|military service|served in (?:the )?(?:military|armed forces))\b/.test(clause)) {
      if (/\b(?:not|never|no|non)\b.{0,18}\b(?:veteran|military service|served)\b|\bnon[- ]veteran\b/.test(clause)) return 'negative';
      if (/\b(?:unknown|uncertain|unclear|pending|not sure)\b/.test(clause)) return 'uncertain';
      return 'affirmative';
    }
    return null;
  });
  const known = new Set(polarities.filter((value): value is EvidencePolarity => value !== null && value !== 'uncertain'));
  if (answer && !polarities.some((value) => value !== null)) return 'uncertain';
  if (!polarities.some((value) => value !== null) || known.size > 1 || polarities.includes('uncertain')) return 'uncertain';
  return known.values().next().value || 'uncertain';
}

function sponsorshipPolarity(text: string, answer = false): EvidencePolarity {
  const direct = yesNoPolarity(text, answer);
  if (direct !== 'uncertain' || answer) return direct;
  const clauses = text.toLowerCase().split(/[.!?;,:]|\b(?:but|however|although|whereas)\b/).map((part) => part.trim()).filter(Boolean);
  const polarities = clauses.flatMap((clause): EvidencePolarity[] => {
    if (!/\b(?:sponsorship|visa)\b/.test(clause)) return [];
    if (/\b(?:not|never|no|without|cannot|can't|don't|doesn't|didn't|isn't|aren't)\b.{0,32}\b(?:require|need|sponsorship|visa)\b|\bno\s+(?:visa\s+)?sponsorship\b/.test(clause)) return ['negative'];
    if (/\b(?:require|requires|requiring|need|needs|will need|must obtain)\b.{0,32}\b(?:sponsorship|visa)\b|\b(?:sponsorship|visa)\b.{0,24}\b(?:required|needed)\b/.test(clause)) return ['affirmative'];
    return ['uncertain'];
  });
  const known = new Set(polarities.filter((polarity) => polarity !== 'uncertain'));
  if (!polarities.length || known.size > 1 || polarities.includes('uncertain')) return 'uncertain';
  return known.values().next().value || 'uncertain';
}

function genericYesNoPolarity(field: ScannedField, text: string, answer = false): EvidencePolarity {
  const question = `${field.label} ${field.name}`.toLowerCase();
  if (/\b(?:not|never|without|cannot|can't|ineligible|unable)\b/.test(question)) return 'uncertain';
  const direct = yesNoPolarity(text, answer);
  if (direct !== 'uncertain' || answer) return direct;
  const concepts = groundingTokens(question).filter((token) => !['yes', 'yeah', 'true', 'no', 'false', 'eligible', 'legally'].includes(token));
  if (!concepts.length) return 'uncertain';
  const clauses = text.toLowerCase().split(/[.!?;,:]|\b(?:but|however|although|whereas)\b/).map((part) => part.trim()).filter(Boolean);
  const polarities = clauses.flatMap((clause): EvidencePolarity[] => {
    const clauseTokens = new Set(groundingTokens(clause));
    const matched = concepts.filter((concept) => clauseTokens.has(concept));
    if (!matched.length) return [];
    if (/\b(?:unknown|uncertain|unclear|pending|not sure|unsure|undetermined)\b/.test(clause)) return ['uncertain'];
    const pattern = matched.join('|');
    if (new RegExp(String.raw`\b(?:not|never|no|without|cannot|can't|don't|doesn't|didn't|isn't|aren't)\b.{0,24}\b(?:${pattern})\b`, 'i').test(clause)) return ['negative'];
    return ['affirmative'];
  });
  const known = new Set(polarities.filter((polarity) => polarity !== 'uncertain'));
  if (!polarities.length || known.size > 1 || polarities.includes('uncertain')) return 'uncertain';
  return known.values().next().value || 'uncertain';
}

function questionEvidencePolarity(field: ScannedField, evidenceKey: string, value: string, answer = false): EvidencePolarity | null {
  const question = `${field.label} ${field.name} ${field.fieldId}`.toLowerCase();
  const key = evidenceKey.toLowerCase().replace(/[_-]+/g, ' ');
  if (/authorized to work|work authorization|legal right to work|eligible to work/.test(question) || /work authorization|work eligibility/.test(key)) {
    return workAuthorizationPolarity(value, answer);
  }
  if (/veteran|military/.test(question) && /veteran|military/.test(key)) return yesNoPolarity(value, answer);
  if (/sponsorship|require.{0,20}visa/.test(question) && /(?:requires sponsorship|sponsorship required|visa sponsorship|sponsorship)/.test(key)) {
    return sponsorshipPolarity(value, answer);
  }
  const degreeQuestion = /\b(?:college|university|associate|bachelor|master|doctorate|ph\.?d|degree)\b/.test(question);
  const structuredEducation = /(?:^|[\s.])(?:profile[.\s]+)?(?:education|resume[.\s]+facts[.\s]+education)(?=[\s\[.]|$)/i.test(key);
  const structuredDegree = /(?:^|[\s.])(?:profile[.\s]+)?degree(?=[\s\[.]|$)/i.test(key);
  if (degreeQuestion && (structuredEducation || structuredDegree)) {
    if (answer && /^\s*(?:yes|y|true|1)\s*$/i.test(value)) return 'affirmative';
    if (answer && /^\s*(?:no|n|false|0)\s*$/i.test(value)) return 'negative';
    if (/\b(?:currently|still|actively)\s+(?:pursuing|working toward|studying)|\b(?:in progress|expected to graduate|candidate for)\b/i.test(value)) return 'uncertain';
    if (/\b(?:no|never earned|never completed|without)\s+(?:a\s+|any\s+)?(?:college\s+|university\s+)?degree\b/i.test(value)) return 'negative';
    if (/\b(?:associate|bachelor|master|doctorate|doctor of philosophy|ph\.?d|b\.?s\.?|m\.?s\.?|a\.?a\.?|a\.?s\.?)\b/i.test(value)) return 'affirmative';
    return 'uncertain';
  }
  if (field.options?.some((option) => /^(?:yes|no|true|false)$/i.test(option.trim()))) {
    return genericYesNoPolarity(field, value, answer);
  }
  return null;
}

function explicitExperiencePolarity(field: ScannedField, value: string, evidenceKey = ''): EvidencePolarity | null {
  if (classifyTier5Question(field) !== 'experience') return null;
  const topics = groundingTokens(`${field.label} ${field.name} ${field.fieldId}`)
    .filter((token) => !['describe', 'tell', 'example', 'experience', 'experienced', 'worked', 'using', 'used', 'have', 'time'].includes(token));
  const clauses = value.toLowerCase().split(/[.!?;,:]|\b(?:but|however|although|whereas)\b/).map((part) => part.trim()).filter(Boolean);
  const polarities = clauses.flatMap((clause): EvidencePolarity[] => {
    const topic = topics.find((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i').test(clause));
    if (!topic) return [];
    const escapedTopic = topic.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
    if (/\b(?:may|might|possibly|perhaps|unclear|unknown|uncertain|not sure|somewhat)\b/i.test(clause)) return ['uncertain'];
    if (new RegExp(String.raw`\b(?:no|not|never|without|lack(?:s|ed)?)\b.{0,32}\b(?:experience|experienced|exposure|familiarity|knowledge|worked|used)\b.{0,32}\b${escapedTopic}\b|\b(?:no|not|never|without|lack(?:s|ed)?)\b.{0,20}\b${escapedTopic}\b.{0,20}\b(?:experience|experienced|exposure|familiarity|knowledge|worked|used)\b`, 'i').test(clause)) return ['negative'];
    if (/\b(?:experience|experienced|exposure|familiarity|knowledge|worked|used|proficient|hands[- ]on)\b/i.test(clause)) return ['affirmative'];
    const normalizedKey = evidenceKey.toLowerCase().replace(/[_-]+/g, ' ');
    if (/(?:^|[\s.])(?:profile[.\s]+)?(?:work experience|experience|resume[.\s]+facts[.\s]+experience)(?=[\s\[.]|$)/i.test(normalizedKey)) return ['affirmative'];
    return [];
  });
  const known = new Set(polarities);
  return known.size === 1 ? known.values().next().value || null : null;
}

function evidenceSupport(field: ScannedField, answer: string, evidence: string, supportQuote: string): 'supported' | 'missing_evidence' | 'irrelevant_evidence' | 'unsupported_evidence' | 'contradictory_evidence' {
  const lines = evidence.split(/\r?\n/).map((line) => {
    const separator = line.indexOf(':');
    return separator < 0 ? { key: '', value: line.trim() } : { key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
  }).filter((line) => line.value);
  if (!lines.length) return 'missing_evidence';
  const relevant = lines.filter((line) => hasQuestionRelevantEvidence(field, `${line.key} ${line.value}`));
  if (!relevant.length) return 'irrelevant_evidence';

  if (classifyTier5Question(field) === 'experience') {
    const polarities = relevant.map((line) => explicitExperiencePolarity(field, line.value, line.key)).filter((value): value is EvidencePolarity => value !== null);
    if (new Set(polarities).size > 1) return 'contradictory_evidence';
    if (polarities.includes('uncertain')) return 'unsupported_evidence';
    const answerPolarity = explicitExperiencePolarity(field, answer);
    if (answerPolarity === 'uncertain') return 'unsupported_evidence';
    if (answerPolarity && polarities.some((polarity) => polarity !== answerPolarity)) return 'contradictory_evidence';
    if (answerPolarity === 'affirmative' && !polarities.includes('affirmative')) return 'unsupported_evidence';
  }

  const quote = supportQuote.trim();
  if (!quote) return 'missing_evidence';
  const normalizeQuote = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const citedLine = relevant.find((line) => normalizeQuote(line.value).includes(normalizeQuote(quote)));
  if (!citedLine) return 'unsupported_evidence';

  // A cited source can support the answer while another relevant source directly
  // contradicts it. Aggregate explicit polarity across each question's relevant
  // evidence family before accepting any one citation.
  const explicitPolarities = relevant
    .map((line) => questionEvidencePolarity(field, line.key, line.value))
    .filter((value): value is EvidencePolarity => value === 'affirmative' || value === 'negative');
  if (new Set(explicitPolarities).size > 1) return 'contradictory_evidence';

  const polarity = questionEvidencePolarity(field, citedLine.key, citedLine.value);
  if (polarity) {
    const evidencePolarity = polarity === 'uncertain' && /^\s*(?:true|false|yes|no|1|0)\s*$/i.test(citedLine.value)
      ? yesNoPolarity(citedLine.value)
      : polarity;
    const answerPolarity = questionEvidencePolarity(field, citedLine.key, answer, true) || yesNoPolarity(answer, true);
    if (evidencePolarity === 'uncertain' || answerPolarity === 'uncertain') return 'unsupported_evidence';
    if (evidencePolarity !== answerPolarity) return 'contradictory_evidence';
    const veteranOptionMapping = /veteran|military/.test(`${field.label} ${field.name} ${field.fieldId}`.toLowerCase()) &&
      /veteran|military/.test(citedLine.key.toLowerCase()) &&
      field.options?.some((option) => option.trim().toLowerCase() === answer.trim().toLowerCase()) &&
      /\b(?:veteran|military)\b/i.test(answer);
    if (veteranOptionMapping) return 'supported';
  }

  // Require every substantive answer term to be grounded in the cited fact. A quote
  // establishes provenance; this conservative lexical check cannot prove semantics.
  const claimTokens = groundingTokens(answer).filter((token) => !['yes', 'yeah', 'true', 'no', 'false'].includes(token)).map((token) => ({
    token: token === 'five' ? '5' : token,
  })).map(({ token }) => token);
  const evidenceTokens = new Set(groundingTokens(citedLine.value).map((token) => token === 'five' ? '5' : token));
  const paraphraseAliases: Record<string, string[]> = {
    eligible: ['authorized'],
    legally: ['authorized'],
    authorized: ['eligible'],
  };
  if (claimTokens.some((token) => !evidenceTokens.has(token) && !(paraphraseAliases[token] || []).some((alias) => evidenceTokens.has(alias)))) {
    return 'unsupported_evidence';
  }

  const normalizedAnswer = answer.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const escapedAnswer = normalizedAnswer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const answerPattern = new RegExp(`\\b${escapedAnswer}\\b`, 'i');
  const directlyContradicted = relevant.some((line) => {
    const matchIndex = line.value.toLowerCase().search(answerPattern);
    if (matchIndex < 0) return false;
    const prefix = line.value.slice(Math.max(0, matchIndex - 32), matchIndex);
    return /(?:\bnot|\bnever|\bno|\bwithout|\bcannot|\bcan't|\bdoesn't|\bdidn't)\s+(?:\w+\s+){0,2}$/i.test(prefix);
  });
  if (directlyContradicted) return 'contradictory_evidence';
  return 'supported';
}

// This is deliberately independent of isBehavioralOrMotivationalQuestion: the
// STAR classifier labels both past examples and hypothetical prompts as behavioral.
const PAST_EXPERIENCE_PATTERNS = [
  /\b(?:tell|describe|give) (?:us |me )?(?:about )?(?:a time|an example|one example)\b/i,
  /\b(?:describe|tell (?:us |me )?about) (?:a|the) .{0,80}\byou (?:faced|experienced|encountered|handled|resolved|navigated|overcame|built|led|improved|delivered)\b/i,
  /\b(?:how|what) have you\b/i,
  /\bhave you (?:ever )?(?:worked|used|built|led|managed|handled|resolved|navigated|overcome|improved|delivered|created|implemented|experienced|encountered|faced)\b/i,
  /\b(?:how|when) did you\b/i,
  /\btell (?:us |me )?how you (?:handled|resolved|navigated|overcame|managed|addressed|responded to|dealt with|improved|built|led|delivered)\b/i,
  /\bexample of (?:a time|when you|how you|your)\b/i,
  /\btime when you\b/i,
  /\bproject (?:where|in which) you\b/i,
  /\bproject you (?:led|built|delivered|worked on|improved)\b/i,
  /\b(?:what|which) (?:relevant )?experience do you have\b/i,
  /\bdescribe (?:your|the candidate's) experience\b/i,
  /\btell (?:us|me) about your experience\b/i,
  /\bexperience (?:with|in|using)\b/i,
  /\b(?:situation|challenge|conflict|project) (?:that|where|in which) you\b/i,
];

const MOTIVATION_PATTERNS = [
  /\bwhy (?:do you want to work|do you want to join|choose|join|are you interested in)\b/i,
  /\bwhy (?:this role|our company|applywizz|us|this team)\b/i,
  /\bwhat (?:excites|interests|attracts|draws) you\b/i,
  /\bwhat makes you a good fit\b/i,
  /\bwhy should we hire you\b/i,
];

const HYPOTHETICAL_PATTERNS = [
  /\bhow would you\b/i,
  /\bwhat would you do\b/i,
  /\bwhat would you\b/i,
  /\bif you (?:were|had|encountered|faced)\b/i,
  /\bimagine (?:that|you)\b/i,
  /\bsuppose (?:that|you)\b/i,
];

export function classifyTier5Question(field: ScannedField): Tier5QuestionKind {
  if (['select', 'radio', 'checkbox'].includes(field.type) && field.options?.length) return 'factual';
  const label = field.label || '';
  if (PAST_EXPERIENCE_PATTERNS.some((pattern) => pattern.test(label))) return 'experience';
  if (MOTIVATION_PATTERNS.some((pattern) => pattern.test(label)) || HYPOTHETICAL_PATTERNS.some((pattern) => pattern.test(label))) return 'creative';
  return 'factual';
}

function hasUnsupportedCreativePastClaim(answer: string, evidence: string): boolean {
  const actions = 'built|created|designed|developed|delivered|deployed|drove|implemented|improved|launched|led|managed|migrated|owned|shipped|used|worked';
  const actionVariants: Record<string, string> = {
    built: 'build|built', created: 'create|created', designed: 'design|designed',
    developed: 'develop|developed', delivered: 'deliver|delivered', deployed: 'deploy|deployed',
    drove: 'drive|drove', implemented: 'implement|implemented', improved: 'improve|improved',
    launched: 'launch|launched', led: 'lead|led', managed: 'manage|managed',
    migrated: 'migrate|migrated', owned: 'own|owned', shipped: 'ship|shipped',
    used: 'use|used', worked: 'work|worked',
  };
  const claims = [...answer.matchAll(new RegExp(String.raw`\bI\s+(?:have\s+)?(${actions})\b([^.!?;]*)`, 'gi'))];
  if (!claims.length) return false;
  const genericClaimWords = new Set(['company', 'experience', 'project', 'result', 'role', 'team', 'work']);
  return claims.some((claim) => {
    const action = claim[1].toLowerCase();
    const objectTokens = groundingTokens(claim[2]).filter((token) => !genericClaimWords.has(token));
    const actionPattern = actionVariants[action] || action;
    // Allow scoped negation with common modifiers ("did not personally lead").
    const negatedAction = new RegExp(String.raw`\b(?:did\s+not|didn't|have\s+not|has\s+not|never|not|no,?\s+i\s+(?:did\s+not|didn't))\s+(?:(?:personally|directly|actually|ever)\s+){0,3}(?:have\s+)?(?:${actionPattern})\b`, 'i');
    const evidenceClauses = evidence.split(/[.!?;\n]+/);
    const matchingEvidence = evidenceClauses.filter((clause) => {
      const clauseTokens = new Set(groundingTokens(clause));
      const matching = objectTokens.filter((token) => clauseTokens.has(token)).length;
      return objectTokens.length > 0 && matching / objectTokens.length >= 0.75;
    });
    if (matchingEvidence.some((clause) => negatedAction.test(clause))) return true;
    // Matching the project/tool is not enough: the evidence must support the
    // action being claimed, so "worked on" cannot substantiate "led".
    const supportedAction = new RegExp(String.raw`\b(?:I\s+)?(?:have\s+)?(?:${actionPattern})\b`, 'i');
    return !matchingEvidence.some((clause) => supportedAction.test(clause));
  });
}

export function decideTier5Answer(input: {
  field: ScannedField;
  answer: string;
  evidence: string;
  supportQuote?: string | null;
  confidence: number | null | undefined;
  stage: Tier5AnswerDecision['stage'];
  reviewed?: boolean;
}): Tier5AnswerDecision {
  const kind = classifyTier5Question(input.field);
  const answer = input.answer.trim();
  let reason: Tier5AnswerDecision['reason'] = 'supported';
  let accepted = Boolean(answer);
  if (!answer) { accepted = false; reason = 'empty_answer'; }
  else if (kind === 'creative') {
    if (hasUnsupportedCreativePastClaim(answer, input.evidence)) { accepted = false; reason = 'unsupported_evidence'; }
    if (input.field.isRequired && !input.reviewed) { accepted = false; reason = 'review_required'; }
  } else {
    const support = evidenceSupport(input.field, answer, input.evidence, input.supportQuote || '');
    if (support !== 'supported') { accepted = false; reason = support; }
    else if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0.70) {
      accepted = false; reason = 'low_confidence';
    }
  }
  return { kind, evidence: input.evidence, supportQuote: input.supportQuote || '', stage: input.stage, answer, confidence: input.confidence ?? null, accepted, reason };
}

export interface BatchAnswerItem {
  answer: string;
  confidence?: number | null;
  supportQuote?: string | null;
}

export interface CalibrationContext {
  field: ScannedField;
  profile: ApplyWizzCandidateProfile;
  jobContext: JobContext;
  matchedOption?: string | null;
  effectiveOptions?: string[];
  rawAnswer: string;
  modelConfidence?: number | null;
}

/**
 * Determines whether a candidate is considered a "U.S. Person" under Export Administration
 * Regulations (EAR) and 8 U.S.C. 1324b(a)(3).
 * Citizens and Permanent Residents (Green Card holders) are U.S. Persons.
 * Temporary non-immigrant visa holders (F-1, H-1B, OPT, CPT, L-1, TN, etc.) and candidates
 * requiring sponsorship are NOT U.S. Persons.
 */
export function isUsPersonUnderExportControl(profile: ApplyWizzCandidateProfile): boolean {
  if (!profile) return false;
  const auth = `${profile.workAuthorization || ''} ${(profile as any).work_authorization || ''}`.toLowerCase();
  if (profile.requiresSponsorship === true || (profile as any).requires_sponsorship === true) return false;
  if (/f-?1|h-?1b|opt|cpt|l-?1|tn|j-?1|o-?1|visa/i.test(auth)) return false;
  if (/citizen|permanent resident|green card/i.test(auth)) return true;
  return false;
}

/**
 * Calibrates the final confidence score based on model self-assessment,
 * structured profile grounding, legal compliance, and option match quality.
 */
export function calculateCalibratedConfidence(context: CalibrationContext): number {
  const { field, profile, rawAnswer, modelConfidence, matchedOption, effectiveOptions } = context;
  const label = (field.label || '').toLowerCase();
  const answer = (matchedOption || rawAnswer || '').trim().toLowerCase();

  // 1. Check for disqualified or banned patterns -> 0.0 (unresolved)
  if (!answer || answer === 'none' || answer === 'null') {
    return 0.0;
  }
  if (
    /(current|most recent|last)\s*(company|employer)/i.test(label) &&
    /^(professional experience|work experience|none|n\/a|richardson,\s*texas|software engineer|current company|developer|engineer)$/i.test(answer)
  ) {
    return 0.0;
  }
  const options = effectiveOptions || field.options;
  if (
    (field.type === 'select' || field.type === 'radio') &&
    (!options || options.length === 0) &&
    /\b(?:location|city|country|where)\b/i.test(label) &&
    /^(yes|no)$/i.test(answer)
  ) {
    return 0.0;
  }

  // 2. High-certainty deterministic grounding from profile facts
  // A. Export control (EAR)
  if (/(export administration regulations|ear|u\.s\.\s*person)/i.test(label)) {
    const isUsPerson = isUsPersonUnderExportControl(profile);
    const answersUsPerson = /i am a u\.s\.\s*person/i.test(answer);
    const answersNotUsPerson = /i am not a u\.s\.\s*person/i.test(answer);
    if ((isUsPerson && answersUsPerson) || (!isUsPerson && answersNotUsPerson)) {
      return 0.98;
    }
    // Legal contradiction!
    return 0.0;
  }

  // B. Work Authorization & Sponsorship matching profile
  if (/(authorized to work|work authorization|legal right to work|eligible to work)/i.test(label)) {
    const auth = (profile.workAuthorization || '').toLowerCase();
    const isAuth = auth && !/^(no|false|unauthorized)$/i.test(auth);
    if (isAuth && (/^yes/i.test(answer) || /authorized/i.test(answer))) {
      return 0.98;
    }
  }

  if (/(sponsorship|require.*visa|future.*sponsorship)/i.test(label)) {
    const reqSponsorship = profile.requiresSponsorship === true;
    if ((reqSponsorship && /^yes/i.test(answer)) || (!reqSponsorship && /^no/i.test(answer))) {
      return 0.98;
    }
  }

  // C. Current company matching structured work experience
  if (/(current|most recent|last)\s*(company|employer)/i.test(label)) {
    const experiences = profile.workExperience || (profile as any).work_experience;
    const currentCompany = experiences?.[0]?.company?.trim();
    if (currentCompany && answer.toLowerCase() === currentCompany.toLowerCase()) {
      return 0.98;
    }
  }

  // D. Corporate policy matches (agreements, former employee = No, SMS = No, LinkedIn)
  if (
    /(terms and conditions|privacy policy|arbitration agreement|ai policy|read the arbitration|consent to receive text|previous employee|worked for us)/i.test(
      label
    )
  ) {
    return 0.95;
  }

  // 3. Model Confidence Calibration
  if (typeof modelConfidence === 'number' && !isNaN(modelConfidence)) {
    // If choice option matched exactly, preserve model confidence
    if (matchedOption && effectiveOptions?.includes(matchedOption)) {
      return Math.min(0.95, Math.max(0.1, modelConfidence));
    }
    return Math.min(1.0, Math.max(0.0, modelConfidence));
  }

  // 4. Default baseline when model confidence was absent:
  // If exact choice option matched: 0.85
  // If behavioral STAR essay: 0.85
  // Otherwise: 0.70 (fail-closed if uncertain)
  if (matchedOption && effectiveOptions?.includes(matchedOption)) {
    return 0.85;
  }
  if (isBehavioralOrMotivationalQuestion(field)) {
    return 0.85;
  }

  return 0.70;
}

function formatAvailableOptionsLine(options: string[]): string {
  const list = options.join(', ');
  return `\nYou MUST respond with exactly one of these options, no other text: [${list}]\n`;
}

function unresolvedField(field: ScannedField): ResolvedField {
  return {
    fieldId: field.fieldId,
    name: field.name,
    type: field.type,
    label: field.label,
    value: '',
    source: 'unresolved',
    resolvedByTier: null,
    confidence: 0,
  };
}

function aiField(field: ScannedField, value: string, confidence: number): ResolvedField {
  return {
    fieldId: field.fieldId,
    name: field.name,
    type: field.type,
    label: field.label,
    value,
    source: 'ai',
    resolvedByTier: 5,
    confidence,
  };
}

export function parseLlmResponse(raw: string): { answer: string; confidence: number | null; supportQuote: string | null } {
  const cleaned = cleanLLMOutput(raw);
  try {
    const parsed = (extractJsonValue(cleaned) || JSON.parse(cleaned)) as {
      answer?: unknown;
      value?: unknown;
      confidence?: unknown;
      supportQuote?: unknown;
    };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const answer = String(parsed.answer ?? parsed.value ?? '').trim();
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : null;
      return { answer, confidence, supportQuote: typeof parsed.supportQuote === 'string' ? parsed.supportQuote : null };
    }
  } catch {
    // plain-text answer
  }
  return { answer: cleaned, confidence: null, supportQuote: null };
}

function extractJsonValue(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    // Model responses sometimes wrap an otherwise valid JSON value in prose.
  }

  for (let start = 0; start < text.length; start++) {
    const opener = text[start];
    if (opener !== '[' && opener !== '{') continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '[' || char === '{') {
        stack.push(char === '[' ? ']' : '}');
      } else if (char === ']' || char === '}') {
        if (stack.pop() !== char) break;
        if (stack.length === 0) {
          try {
            return JSON.parse(text.slice(start, end + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export function parseBatchAnswerItems(raw: string, expectedCount: number): BatchAnswerItem[] | null {
  let parsed = extractJsonValue(cleanLLMOutput(raw));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'answers' in parsed) {
    parsed = (parsed as { answers: unknown }).answers;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.every(([key]) => /^\d+$/.test(key))) {
      entries.sort(([left], [right]) => Number(left) - Number(right));
    }
    parsed = entries.map(([, value]) => value);
  }
  if (!Array.isArray(parsed)) return null;

  const items: BatchAnswerItem[] = parsed.map((item) => {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      return { answer: cleanLLMOutput(String(item)), confidence: null, supportQuote: null };
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const ans = cleanLLMOutput(String(obj.answer ?? obj.value ?? ''));
      const conf = typeof obj.confidence === 'number' ? obj.confidence : null;
      const supportQuote = typeof obj.supportQuote === 'string' ? cleanLLMOutput(obj.supportQuote) : null;
      return { answer: ans, confidence: conf, supportQuote };
    }
    return { answer: '', confidence: null, supportQuote: null };
  });

  return Array.from({ length: expectedCount }, (_, index) => items[index] || { answer: '', confidence: null, supportQuote: null });
}

export function parseBatchAnswerResponse(raw: string, expectedCount: number): string[] | null {
  const items = parseBatchAnswerItems(raw, expectedCount);
  if (!items) return null;
  return items.map((i) => i.answer);
}

/**
 * Coerces LLM or heuristic output to strict "Yes" or "No" for binary questions.
 */
export function coerceBinaryYesNo(output: string, field?: ScannedField): 'Yes' | 'No' {
  const text = output.trim();
  if (/^yes$/i.test(text)) return 'Yes';
  if (/^no$/i.test(text)) return 'No';

  const combined = `${field?.label || ''} ${field?.name || ''}`.toLowerCase();
  const isNegativeClause =
    /(non-compete|non compete|restrict|subsidiaries|worked for|affiliate|previous employee|felony|terminated|disciplinary)/i.test(
      combined
    );

  if (/^(no|false|disagree|unable|cannot|not willing)\b/i.test(text) || /\bno\b/i.test(text)) {
    return 'No';
  }
  if (/^(yes|true|agree|willing|confirm)\b/i.test(text) || /\byes\b/i.test(text)) {
    return 'Yes';
  }

  return isNegativeClause ? 'No' : 'Yes';
}

/**
 * Sanitizes LLM output text, stripping thinking processes, reasoning tokens, and tags.
 */
export function cleanLLMOutput(raw: string): string {
  if (!raw) return '';
  let text = raw.trim();

  // 1. Strip <think>...</think> or <thought>...</thought> tags
  text = text.replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, '').trim();

  // 2. Strip unclosed <think> or <thought> tags (due to token limits)
  text = text.replace(/<(?:think|thought)>[\s\S]*$/gi, '').trim();

  // 3. Strip "Here's a thinking process:" or similar reasoning blocks
  if (/^(?:here['']?s a thinking process|thinking process|thought process):/i.test(text)) {
    const parts = text.split(/\n\s*\n/);
    const nonThinking = parts.filter(
      (p) => !/^\s*(?:[0-9]+\.|\*|-|here['']?s|analyz|drafting|identify|research|determine|step\s*\d)/i.test(p.trim())
    );
    if (nonThinking.length > 0) {
      text = nonThinking[nonThinking.length - 1].trim();
    } else {
      return '';
    }
  }

  // 4. Strip markdown code fences
  text = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/ig, '$1').trim();

  // 5. Strip surrounding quotes
  text = text.replace(/^["']|["']$/g, '').trim();

  return text;
}

/**
 * Exact option match only (trim + case-insensitive). Returns null instead of guessing.
 */
export function matchExactOption(text: string, options?: string[]): string | null {
  if (!options || options.length === 0) return null;
  const cleanText = text.replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (!cleanText) return null;
  for (const opt of options) {
    if (opt.toLowerCase().trim() === cleanText) {
      return opt;
    }
  }
  return null;
}

/**
 * Safe option match fallback when exact match fails:
 * 1. Semantic aliases (yes/no and known demographic values)
 * 2. Normalized comparison (strip punctuation, lowercase, trim)
 * 3. Unique prefix matching
 */
export function matchFuzzyOption(text: string, options?: string[]): string | null {
  return matchChoiceOption(text, options);
}

/**
 * Tier 5 Answer Synthesizer invoking Anthropic Claude API.
 */
export class LLMSynthesizer {
  private readonly provider: 'anthropic' | 'gemini' | 'ollama';
  private readonly workspaceId?: string;
  private readonly apiKey: string;
  private readonly geminiApiKey: string;
  private readonly modelName: string;
  private readonly geminiModel: string;
  private readonly ollamaEndpoint: string;
  private readonly ollamaModel: string;
  private readonly ollamaSonnetModel: string;
  private readonly deepSeekModel: string;
  private readonly openRouterApiKey: string;
  private readonly batchProvider?: AnthropicBatchProvider;
  private readonly batchStateStore: BatchRunStateStore;
  private readonly batchPollIntervalMs?: number;
  private readonly batchPollSleep?: (milliseconds: number) => Promise<void>;

  /**
   * Initializes the LLMSynthesizer with Anthropic, Gemini, or Ollama configuration.
   *
   * @param options - Configuration overrides.
   */
  constructor(options: LLMSynthesizerOptions = {}) {
    this.geminiApiKey = (
      options.geminiApiKey !== undefined
        ? options.geminiApiKey
        : (config.GEMINI_API_KEY ?? '')
    ).trim();
    this.geminiModel = (options.geminiModel ?? config.GEMINI_MODEL ?? 'gemini-3.5-flash-lite').trim();
    this.ollamaEndpoint = (options.ollamaEndpoint ?? config.OLLAMA_ENDPOINT ?? 'http://localhost:11434').trim();
    this.ollamaModel = (options.ollamaModel ?? config.OLLAMA_MODEL ?? 'llama3.1:latest').trim();
    this.ollamaSonnetModel = (options.ollamaSonnetModel ?? config.OLLAMA_SONNET_MODEL ?? 'qwen3:latest').trim();
    this.provider = options.provider ?? (config.LLM_PROVIDER as 'anthropic' | 'gemini' | 'ollama') ?? 'anthropic';

    this.apiKey = (
      options.apiKey !== undefined
        ? options.apiKey
        : (config.CLAUDE_API_KEY ?? config.ACTIVE_LLM_API_KEY ?? '')
    ).trim();
    this.workspaceId = (options.workspaceId ?? config.ANTHROPIC_WORKSPACE_ID ?? '').trim() || undefined;
    this.modelName = (options.modelName ?? config.CLAUDE_MODEL ?? 'claude-haiku-5-5').trim();
    this.deepSeekModel = (options.deepSeekModel ?? config.DEEPSEEK_R1_MODEL).trim();
    this.openRouterApiKey = (options.openRouterApiKey ?? config.OPENROUTER_API_KEY ?? '').trim();
    this.batchProvider = options.batchProvider ?? (this.apiKey
      ? new AnthropicHttpBatchProvider(this.apiKey, this.workspaceId)
      : undefined);
    this.batchStateStore = options.batchStateStore ?? new JsonBatchRunStateStore(
      '.ai/anthropic-message-batch-runs.json'
    );
    this.batchPollIntervalMs = options.batchPollIntervalMs;
    this.batchPollSleep = options.batchPollSleep;

    const isSandbox = process.env.SANDBOX === 'true' || process.env.SANDBOX === '1';
    if (isSandbox && !this.apiKey && !this.geminiApiKey && this.provider !== 'ollama') {
      log.warn('⚠️ Sandbox mode: No API key configured for LLM synthesis.');
    }
  }

  public getProviderDiagnostics(): { provider: string; model: string } {
    return {
      provider: this.provider,
      model:
        this.provider === 'ollama'
          ? this.ollamaModel
          : this.provider === 'gemini'
          ? this.geminiModel
          : this.modelName,
    };
  }

  public getPrimaryModelName(): string {
    return this.modelName;
  }

  public getDeepSeekModelName(): string {
    return this.deepSeekModel;
  }

  /** Creates or resumes a real Message Batch, retrying item-level provider errors once. */
  public async runAnthropicMessageBatch(
    runKey: string,
    requests: AnthropicBatchRequest[],
  ) {
    if (!this.batchProvider) throw new Error('No Anthropic credentials configured for Message Batches.');
    const result = await executeAnthropicBatchWithRetry(
      runKey,
      requests,
      this.batchProvider,
      this.batchStateStore,
      (event) => log.info(
        `[LLM Provider] event=message_batch_${event.event} batch_id=${event.batchId} elapsed_ms=${event.elapsedMs}` +
        (event.usage ? ` input_tokens=${event.usage.inputTokens} output_tokens=${event.usage.outputTokens}` : '')
      ),
      { waitForCompletion: true, intervalMs: this.batchPollIntervalMs, sleep: this.batchPollSleep, shouldAbort: isPipelineAbortRequested },
    );
    return result;
  }

  public async runGeminiPromptBatch(
    runKey: string,
    prompts: readonly { customId: string; prompt: string; system: string }[],
    model = this.geminiModel
  ): Promise<{
    status: AnthropicBatchStatus;
    batchIds: string[];
    responses: Map<string, string>;
    failedIds: Set<string>;
    usage?: { promptTokens: number; completionTokens: number };
  }> {
    const responses = new Map<string, string>();
    const failedIds = new Set<string>();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    if (prompts.length === 1) {
      const { customId, prompt, system } = prompts[0];
      try {
        const res = await callGemini({
          prompt,
          systemMessage: system,
          maxTokens: 1200,
          modelName: model,
          apiKey: this.geminiApiKey,
        });
        if (res.text?.trim()) {
          responses.set(customId, res.text);
        } else {
          failedIds.add(customId);
        }
        if (res.usage) {
          totalPromptTokens += res.usage.promptTokens;
          totalCompletionTokens += res.usage.completionTokens;
        }
      } catch (err: any) {
        log.warn(`[Gemini Prompt Batch] Error processing ${customId}: ${err.message}`);
        failedIds.add(customId);
      }
      return {
        status: 'ended' as const,
        batchIds: [`gemini-batch-${runKey}`],
        responses,
        failedIds,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
      };
    }

    const BUNDLE_SIZE = 15;
    const MIN_INTERVAL_MS = 4300; // ~14 RPM safe pacing for Free Tier

    for (let i = 0; i < prompts.length; i += BUNDLE_SIZE) {
      const bundleStartTime = Date.now();
      const chunk = prompts.slice(i, i + BUNDLE_SIZE);

      const bundledPrompt = `You are resolving multiple job application questions. For each task below, answer using ONLY its candidate evidence and job context.
Return ONLY a valid JSON object mapping each task customId to its answers object:
{
  "tasks": {
    "<customId>": {
      "answers": [
        {
          "answer": "resolved answer text or exact choice",
          "confidence": 0.95,
          "supportQuote": "exact quote from candidate evidence"
        }
      ]
    }
  }
}

Tasks to resolve:
${chunk.map((item, idx) => `=== Task ${idx + 1} [ID: ${item.customId}] ===\n${item.prompt}`).join('\n\n')}`;

      const bundledSystem = `You are an automated job application assistant resolving multiple independent questions. For each task ID, answer using only the provided candidate evidence and context for that task. Return a JSON object with a 'tasks' mapping of customId to answers array. Return an empty answer with 0.0 confidence when unsupported.`;

      try {
        const res = await callGemini({
          prompt: bundledPrompt,
          systemMessage: bundledSystem,
          maxTokens: 4096,
          modelName: model,
          apiKey: this.geminiApiKey,
        });

        if (res.usage) {
          totalPromptTokens += res.usage.promptTokens;
          totalCompletionTokens += res.usage.completionTokens;
        }

        let tasksMap: Record<string, any> = {};
        try {
          const parsed = extractJsonValue(cleanLLMOutput(res.text));
          if (parsed && typeof parsed === 'object') {
            tasksMap = (parsed as any).tasks || parsed;
          }
        } catch (parseErr: any) {
          log.warn(`[Gemini Prompt Batch] Failed to parse JSON response for bundle: ${parseErr.message}`);
        }

        for (const item of chunk) {
          const taskData = tasksMap[item.customId];
          if (taskData) {
            responses.set(item.customId, JSON.stringify(taskData));
          } else {
            const matchedKey = Object.keys(tasksMap).find((k) => k.toLowerCase() === item.customId.toLowerCase());
            if (matchedKey && tasksMap[matchedKey]) {
              responses.set(item.customId, JSON.stringify(tasksMap[matchedKey]));
            } else {
              failedIds.add(item.customId);
            }
          }
        }

        log.info(
          `[Gemini Prompt Batch] Processed ${Math.min(i + BUNDLE_SIZE, prompts.length)}/${prompts.length} questions ` +
            `(bundle ${Math.floor(i / BUNDLE_SIZE) + 1}/${Math.ceil(prompts.length / BUNDLE_SIZE)})`
        );
      } catch (err: any) {
        log.warn(`[Gemini Prompt Batch] Error processing bundle at index ${i}: ${err.message}`);
        for (const item of chunk) failedIds.add(item.customId);
      }

      const elapsed = Date.now() - bundleStartTime;
      if (i + BUNDLE_SIZE < prompts.length && elapsed < MIN_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
      }
    }

    return {
      status: 'ended' as const,
      batchIds: [`gemini-batch-${runKey}`],
      responses,
      failedIds,
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
    };
  }

  public async runOllamaPromptBatch(
    runKey: string,
    prompts: readonly { customId: string; prompt: string; system: string }[],
    model = this.ollamaModel
  ): Promise<{
    status: AnthropicBatchStatus;
    batchIds: string[];
    responses: Map<string, string>;
    failedIds: Set<string>;
    usage?: { promptTokens: number; completionTokens: number };
  }> {
    const responses = new Map<string, string>();
    const failedIds = new Set<string>();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    const CHUNK_SIZE = 2;
    for (let i = 0; i < prompts.length; i += CHUNK_SIZE) {
      const chunk = prompts.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async ({ customId, prompt, system }) => {
          try {
            const res = await callOllama({
              prompt,
              systemMessage: system,
              modelName: model,
              endpoint: this.ollamaEndpoint,
            });
            if (res.text?.trim()) {
              responses.set(customId, res.text);
            } else {
              failedIds.add(customId);
            }
            if (res.usage) {
              totalPromptTokens += res.usage.promptTokens;
              totalCompletionTokens += res.usage.completionTokens;
            }
          } catch (err: any) {
            log.warn(`[Ollama Prompt Batch] Error processing ${customId}: ${err.message}`);
            failedIds.add(customId);
          }
        })
      );
    }

    return {
      status: 'ended' as const,
      batchIds: [`ollama-batch-${runKey}`],
      responses,
      failedIds,
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
    };
  }

  public async runAnthropicPromptBatch(
    runKey: string,
    prompts: readonly { customId: string; prompt: string; system: string }[],
    model = this.modelName,
  ): Promise<{ status: AnthropicBatchStatus; batchIds: string[]; responses: Map<string, string>; failedIds: Set<string>; usage?: { promptTokens: number; completionTokens: number } }> {
    if (this.provider === 'ollama') {
      return this.runOllamaPromptBatch(runKey, prompts, model.includes('sonnet') ? this.ollamaSonnetModel : this.ollamaModel);
    }
    if (this.provider === 'gemini' || (!this.apiKey && this.geminiApiKey)) {
      return this.runGeminiPromptBatch(runKey, prompts, model.includes('sonnet') ? config.GEMINI_DEEP_MODEL : this.geminiModel);
    }

    try {
      const result = await this.runAnthropicMessageBatch(runKey, prompts.map(({ customId, prompt, system }) => ({
        custom_id: customId,
        params: {
          model,
          max_tokens: 1200,
          system,
          messages: [{ role: 'user', content: prompt }],
        },
      })));
      const responses = new Map<string, string>();
      const failedIds = new Set<string>();
      for (const [id, item] of result.results || []) {
        if (item.result.type !== 'succeeded') { failedIds.add(id); continue; }
        const text = item.result.message?.content?.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
        if (text?.trim()) responses.set(id, text);
      }
      return { status: result.status, batchIds: result.batchIds, responses, failedIds,
        ...(result.usage ? { usage: { promptTokens: result.usage.inputTokens, completionTokens: result.usage.outputTokens } } : {}) };
    } catch (err: any) {
      if (this.geminiApiKey && (String(err).includes('usage limits') || String(err).includes('workspace') || String(err).includes('400'))) {
        log.warn(`[LLM Provider] Anthropic batch failed with usage limits. Automatically failing over to Gemini prompt batch.`);
        return this.runGeminiPromptBatch(runKey, prompts, model.includes('sonnet') ? config.GEMINI_DEEP_MODEL : this.geminiModel);
      }
      throw err;
    }
  }

  /** Runs the one allowed Tier 5 escalation through OpenRouter JSON mode. */
  public async synthesizeDeepSeekAnswer(
    field: ScannedField,
    profile: ApplyWizzCandidateProfile,
    resumeText = '',
    jobContext: JobContext = { title: 'Software Engineer', company: 'Company' },
    resumeFacts?: any,
    model = this.deepSeekModel,
    reviewDraft?: string,
  ): Promise<{ result: ResolvedField; supportQuote?: string; usage?: BatchSynthesizeResult['usage'] }> {
    const apiKey = this.openRouterApiKey;
    if (!apiKey) throw new Error('No OpenRouter credentials configured for DeepSeek escalation.');
    const options = getEffectiveFieldOptions(field);
    const isChoice = Boolean(options?.length && CHOICE_FIELD_TYPES.has(field.type));
    const systemMessage = `${isChoice
      ? 'You are a factual job application assistant. Return JSON only with answer, confidence, and supportQuote. The answer must exactly match one provided option.'
      : 'You are a factual job application assistant. Return JSON only as {"answer":"...","confidence":0.0,"supportQuote":"exact quote from candidate evidence"}. Use candidate evidence only; if unsupported, return NONE with low confidence and an empty supportQuote.'}\nFor factual answers, supportQuote must be copied verbatim from this question’s candidate evidence. It establishes provenance but does not by itself prove entailment.\n\n${CORPORATE_POLICY_PROMPT_GUIDELINES}`;
    const prompt = this.constructPrompt(field, profile, resumeText, jobContext, resumeFacts) + (reviewDraft
      ? `\n\nRequired answer draft for review:\n${reviewDraft}\nReview the draft against the evidence and question. Correct unsupported or inaccurate claims. Return an empty answer if it cannot be made truthful.`
      : '');
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': config.OPENROUTER_BASE_URL,
        'X-Title': 'ApplyWizz Tier 5 escalation',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS || 30000),
    });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`OpenRouter DeepSeek returned HTTP ${response.status}: ${detail}`);
      (error as any).status = response.status;
      (error as any).statusCode = response.status;
      throw error;
    }
    const data = await response.json() as any;
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) {
      return { result: unresolvedField(field) };
    }
    const parsed = parseLlmResponse(raw);
    const isCreative = classifyTier5Question(field) === 'creative';
    if (
      !parsed.answer ||
      (!isCreative && (parsed.confidence == null || !Number.isFinite(parsed.confidence) || parsed.confidence < 0.65))
    ) {
      return { result: unresolvedField(field) };
    }
    const result = this.finalizeRawAnswer(raw, field, profile, jobContext, {
      defaultConfidenceIfMissing: parsed.confidence ?? undefined,
      allowLowConfidenceCreative: isCreative,
    });
    const usage = data?.usage;
    const promptTokens = Number(usage?.prompt_tokens) || 0;
    const completionTokens = Number(usage?.completion_tokens) || 0;
    const cost = typeof usage?.cost === 'number' ? usage.cost : undefined;
    return {
      result,
      supportQuote: parsed.supportQuote || undefined,
      usage: {
        promptTokens,
        completionTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: promptTokens + completionTokens,
        cost,
      model,
      },
    };
  }

  private async callAnthropic(
    prompt: string,
    systemMessage: string,
    maxTokens: number,
    structuredBatch = false
  ): Promise<{
    text: string;
    stopReason?: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      cost?: number;
      model: string;
    };
  }> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
    if (this.workspaceId) {
      headers['anthropic-workspace-id'] = this.workspaceId;
    }

    const requestBody: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: maxTokens,
      system: systemMessage,
      messages: [{ role: 'user', content: prompt }],
    };
    if (structuredBatch) {
      requestBody.output_config = {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { answers: { type: 'array', items: { type: 'string' } } },
            required: ['answers'],
            additionalProperties: false,
          },
        },
      };
    }
    if (!this.modelName.includes('5-5') && !this.modelName.includes('5.5')) {
      requestBody.temperature = 0.2;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS || 30000),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      let parsedError: any = {};
      try {
        parsedError = JSON.parse(errorBody);
      } catch {
        parsedError = { raw: errorBody };
      }
      const message = parsedError?.error?.message || errorBody;
      const error = new Error(`Anthropic API returned HTTP ${res.status}: ${message}`);
      (error as any).status = res.status;
      (error as any).statusCode = res.status;
      (error as any).type = parsedError?.error?.type;
      (error as any).errorType = parsedError?.error?.type;
      (error as any).error = parsedError?.error;
      throw error;
    }

    const data = (await res.json()) as any;
    const rawText = Array.isArray(data?.content)
      ? data.content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('')
      : '';
    const usageData = data?.usage;
    let usage;
    if (usageData) {
      const inputTokens = usageData.input_tokens || 0;
      const outputTokens = usageData.output_tokens || 0;
      const cacheReadTokens = usageData.cache_read_input_tokens || 0;
      const cacheWriteTokens = usageData.cache_creation_input_tokens || 0;
      usage = {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens,
        cost: (inputTokens * 0.10 + outputTokens * 0.30) / 1_000_000,
        model: this.modelName,
      };
    }

    return { text: rawText, stopReason: typeof data?.stop_reason === 'string' ? data.stop_reason : undefined, usage };
  }


  /**
   * Synthesizes an answer for an open-ended or custom question using LLM inference.
   *
   * @param field - Scanned Greenhouse form question.
   * @param profile - Candidate profile from ApplyWizz.
   * @param resumeText - Extracted text from master resume (optional).
   * @param jobContext - Job title and company name context.
   * @returns ResolvedField tagged with `source: 'ai'`.
   */
  public async synthesizeAnswer(
    field: ScannedField,
    profile: ApplyWizzCandidateProfile,
    resumeText: string = '',
    jobContext: JobContext = { title: 'Software Engineer', company: 'Company' },
    resumeFacts?: any
  ): Promise<ResolvedField> {
    const choiceOptions = getEffectiveFieldOptions(field);
    const isChoiceField = choiceOptions && choiceOptions.length > 0 && CHOICE_FIELD_TYPES.has(field.type);
    const isBinary = isBinaryYesNoQuestion(field);

    const profileYesNo = isBinary ? inferYesNoFromProfile(field, profile) : null;
    if (profileYesNo) {
      if (choiceOptions && choiceOptions.length > 0) {
        const exact = matchExactOption(profileYesNo, choiceOptions);
        if (!exact) {
          return unresolvedField(field);
        }
        return aiField(field, exact, 0.95);
      }
      return aiField(field, profileYesNo, 0.95);
    }

    const prompt = this.constructPrompt(field, profile, resumeText, jobContext, resumeFacts);
    const incompleteChoice = field.type === 'select' && field.optionsComplete === false;
    const baseSystemMessage = incompleteChoice
      ? 'You are an automated job application assistant. Return only one concise, exact choice label supported by candidate data. The scanned choice list is incomplete; do not invent a value. If candidate data does not support an answer, return NONE.'
      : isChoiceField
      ? 'You are an automated job application assistant. You MUST return exactly one of the provided options. Choose the closest true answer based on candidate data. If none fit, return NONE.'
      : 'You are an automated job application assistant. Be concise and factual. Base your answer only on the candidate profile data provided. Do not invent or assume information not present in the profile. Reply as JSON only: {"answer":"<text>","confidence":<0.0-1.0>}. NEVER return markdown or explanatory text.';
    const systemMessage = `${baseSystemMessage}\nFor factual answers, include supportQuote as an exact, concise quote copied from the question's candidate evidence. If the evidence does not support the answer, set answer to NONE and supportQuote to an empty string. A quote identifies its source but does not by itself prove the answer follows from it. Return JSON with answer, confidence, and supportQuote.\n\n${CORPORATE_POLICY_PROMPT_GUIDELINES}`;

    const canUseGemini = Boolean(this.geminiApiKey);
    const preferGemini = this.provider === 'gemini' || (!this.apiKey && canUseGemini);

    if (this.provider === 'ollama') {
      try {
        const startedAt = Date.now();
        const { text: outputText } = await callOllama({
          prompt,
          systemMessage,
          modelName: this.ollamaModel,
          endpoint: this.ollamaEndpoint,
        });
        haltIfFirstProviderCallFailed(true);
        const cleaned = cleanLLMOutput(outputText);
        log.debug(
          `[LLM Provider] event=request_completed operation=single provider=ollama ` +
            `model=${this.ollamaModel} elapsed_ms=${Date.now() - startedAt} content_chars=${cleaned.length}`
        );
        if (cleaned && cleaned.length > 0) {
          const result = this.finalizeLlmAnswer(cleaned, field, profile, jobContext, choiceOptions);
          const supportQuote = parseLlmResponse(cleaned).supportQuote;
          if (supportQuote) answerSupportQuotes.set(result, supportQuote);
          return result;
        }
      } catch (err: any) {
        log.warn(`[LLM Provider] event=request_failed operation=single provider=ollama error=${err.message}`);
      }
    } else if (preferGemini) {
      if (!this.geminiApiKey) {
        throw new Error('No Gemini provider credentials configured.');
      }
      try {
        const startedAt = Date.now();
        const { text: outputText } = await callGemini({
          prompt,
          systemMessage,
          maxTokens: 350,
          modelName: this.geminiModel,
          apiKey: this.geminiApiKey,
        });
        haltIfFirstProviderCallFailed(true);
        const cleaned = cleanLLMOutput(outputText);
        log.debug(
          `[LLM Provider] event=request_completed operation=single provider=gemini ` +
            `model=${this.geminiModel} elapsed_ms=${Date.now() - startedAt} content_chars=${cleaned.length}`
        );
        if (cleaned && cleaned.length > 0) {
          const result = this.finalizeLlmAnswer(cleaned, field, profile, jobContext, choiceOptions);
          const supportQuote = parseLlmResponse(cleaned).supportQuote;
          if (supportQuote) answerSupportQuotes.set(result, supportQuote);
          return result;
        }
      } catch (err: any) {
        log.warn(`[LLM Provider] event=request_failed operation=single provider=gemini error=${err.message}`);
      }
    } else if (this.apiKey) {
      let failureDiagnosticEmitted = false;
      try {
        const startedAt = Date.now();
        const { text: outputText } = await this.callAnthropic(prompt, systemMessage, 350);
        haltIfFirstProviderCallFailed(true);

        const cleaned = cleanLLMOutput(outputText);
        log.debug(
          `[LLM Provider] event=request_completed operation=single provider=anthropic ` +
            `model=${this.modelName} elapsed_ms=${Date.now() - startedAt} content_chars=${cleaned.length}`
        );

        if (cleaned && cleaned.length > 0) {
          try {
            const result = this.finalizeLlmAnswer(cleaned, field, profile, jobContext, choiceOptions);
            const supportQuote = parseLlmResponse(cleaned).supportQuote;
            if (supportQuote) answerSupportQuotes.set(result, supportQuote);
            return result;
          } catch (error) {
            await emitFailureDiagnostic({
              category: 'RESOLVE_TIER5_PARSE',
              stage: 'single_response_parse',
              reason: 'Tier 5 Anthropic returned a response that could not be parsed into a valid answer.',
              error,
              isTerminal: false,
              isRetryable: true,
            });
            failureDiagnosticEmitted = true;
            throw error;
          }
        }
      } catch (err: any) {
        if (
          canUseGemini &&
          (String(err).includes('usage limits') ||
            String(err).includes('workspace') ||
            String(err).includes('400'))
        ) {
          log.warn(
            `[LLM Provider] Anthropic hit workspace limit. Automatically failing over to Gemini provider.`
          );
          try {
            const { text: outputText } = await callGemini({
              prompt,
              systemMessage,
              maxTokens: 350,
              modelName: this.geminiModel,
              apiKey: this.geminiApiKey,
            });
            haltIfFirstProviderCallFailed(true);
            const cleaned = cleanLLMOutput(outputText);
            if (cleaned && cleaned.length > 0) {
              const result = this.finalizeLlmAnswer(cleaned, field, profile, jobContext, choiceOptions);
              const supportQuote = parseLlmResponse(cleaned).supportQuote;
              if (supportQuote) answerSupportQuotes.set(result, supportQuote);
              return result;
            }
          } catch (geminiErr: any) {
            log.warn(`[LLM Provider] Failover to Gemini failed: ${geminiErr.message}`);
          }
        }
        if (!failureDiagnosticEmitted) {
          await emitFailureDiagnostic({
            category: 'RESOLVE_TIER5_PROVIDER_FAILURE',
            stage: 'single_provider_request',
            reason: 'Tier 5 Anthropic language-model request failed.',
            error: err,
            isTerminal: false,
            isRetryable: true,
          });
        }
        log.warn(
          `[LLM Provider] event=request_failed operation=single provider=anthropic ` +
            `model=${this.modelName} ${formatProviderErrorDiagnostics(getLlmProviderErrorDiagnostics(err))}`
        );
        haltIfFirstProviderCallFailed(false);
      }
    }

    const fallbackAnswer = this.generateFallbackAnswer(field, profile, jobContext);
    if (!fallbackAnswer) {
      return unresolvedField(field);
    }
    return aiField(field, fallbackAnswer, 0.9);
  }

  /**
   * Accepts an exact option or a free-text JSON answer. Non-matching options and
   * confidence below LLM_MIN_CONFIDENCE become unresolved — never guessed.
   */
  /**
   * Validates raw LLM text the same way as single-field synthesis (options fail-closed, min confidence).
   */
  public finalizeRawAnswer(
    raw: string,
    field: ScannedField,
    profile: ApplyWizzCandidateProfile,
    jobContext: JobContext,
    opts?: { defaultConfidenceIfMissing?: number; allowLowConfidenceCreative?: boolean }
  ): ResolvedField {
    return this.finalizeLlmAnswer(
      raw,
      field,
      profile,
      jobContext,
      getEffectiveFieldOptions(field),
      opts
    );
  }

  private finalizeLlmAnswer(
    raw: string,
    field: ScannedField,
    profile: ApplyWizzCandidateProfile,
    jobContext: JobContext,
    choiceOptions: string[] | undefined,
    opts?: { defaultConfidenceIfMissing?: number; allowLowConfidenceCreative?: boolean }
  ): ResolvedField {
    const parsed = parseLlmResponse(raw);
    let answer = parsed.answer;
    let confidence = parsed.confidence;

    if (
      field.type === 'select' &&
      field.optionsComplete === false &&
      /^none$/i.test(answer.trim())
    ) {
      return unresolvedField(field);
    }

    if (/does not contain|no information|cannot determine|not (found|available|mentioned|provided|specified)|unable to (find|determine)|resume does not|i do not have (specific|direct|relevant|detailed)|i cannot provide|i don't have (specific|direct)|no specific (experience|information|detail)|not (explicitly|directly) mentioned|not specified in/i.test(answer)) {
      return unresolvedField(field);
    }

    if (/linkedin|website|portfolio|github|\burl\b|blog|personal site/i.test(`${field.label} ${field.name} ${field.fieldId}`)) {
      if (!/^https?:\/\//i.test(answer) && !/linkedin\.com|github\.com/i.test(answer)) {
        answer = this.generateFallbackAnswer(field, profile, jobContext);
        confidence = answer ? 0.95 : null;
      }
    }

    // 1. Export Control & EAR Legal Guard
    const labelCombined = `${field.label || ''} ${field.name || ''} ${field.fieldId || ''}`.toLowerCase();
    if (/(export administration regulations|ear|u\.s\.\s*person)/i.test(labelCombined)) {
      const isUsPerson = isUsPersonUnderExportControl(profile);
      if (choiceOptions && choiceOptions.length > 0) {
        if (!isUsPerson) {
          const nonUsOpt = choiceOptions.find((opt) =>
            /i am not a u\.s\.\s*person/i.test(opt)
          );
          if (nonUsOpt) {
            answer = nonUsOpt;
            confidence = 0.98;
          }
        } else {
          const usOpt = choiceOptions.find((opt) =>
            /i am a u\.s\.\s*person/i.test(opt)
          );
          if (usOpt) {
            answer = usOpt;
            confidence = 0.98;
          }
        }
      }
    }

    // 2. Current Employer / Company Guard
    if (/(?:current|most recent|last)\s*(?:company|employer)\b/i.test(field.label)) {
      const isBannedAnswer =
        !answer ||
        /^(?:professional experience|work experience|none|n\/a|richardson,\s*texas|software engineer|current company|developer|engineer)$/i.test(
          answer.trim()
        );
      if (isBannedAnswer) {
        const experiences = profile.workExperience || (profile as any).work_experience;
        const structuredCompany = experiences?.[0]?.company?.trim();
        if (structuredCompany) {
          answer = structuredCompany;
          confidence = 0.98;
        } else {
          return unresolvedField(field);
        }
      }
    }

    // 3. Choice Options Alignment & Select Option Guards
    let matched: string | null = null;
    if (choiceOptions && choiceOptions.length > 0) {
      if (/gender|race|ethnicity|hispanic|latino|veteran|disability|eeoc/i.test(field.label)) {
        log.debug(
          `[T5 EEOC] label="${field.label}" options=${JSON.stringify(choiceOptions)}`
        );
      }
      matched = matchChoiceOption(answer, choiceOptions);

      if (!matched) {
        return unresolvedField(field);
      }
      answer = matched;
    } else if (
      (field.type === 'select' || field.type === 'radio') &&
      (!choiceOptions || choiceOptions.length === 0)
    ) {
      // If a select/radio field had NO options scanned and asks for a location/choice,
      // answering generic "Yes"/"No" is invalid. Fail closed.
      if (/(?:location|city|country|state|where)/i.test(field.label) && /^(?:yes|no)$/i.test(answer.trim())) {
        return unresolvedField(field);
      }
    }

    if (!answer) {
      return unresolvedField(field);
    }

    // 4. Calibrated Confidence Calculation
    const calibratedConfidence = calculateCalibratedConfidence({
      field,
      profile,
      jobContext,
      matchedOption: matched,
      effectiveOptions: choiceOptions,
      rawAnswer: answer,
      modelConfidence: confidence ?? opts?.defaultConfidenceIfMissing ?? null,
    });

    if (calibratedConfidence < LLM_MIN_CONFIDENCE && !(opts?.allowLowConfidenceCreative && classifyTier5Question(field) === 'creative')) {
      return unresolvedField(field);
    }

    return aiField(field, answer, calibratedConfidence);
  }

  /**
   * Resolves multiple questions in one provider request for a candidate/job pair.
   */
  /**
   * Resolves multiple questions in one provider request for a candidate/job pair.
   */
  public async synthesizeBatchAnswers(
    questions: BatchQuestion[],
    _resumeText: string,
    jobDescription: string,
    _profile?: ApplyWizzCandidateProfile
  ): Promise<BatchSynthesizeResult> {
    if (questions.length === 0) return { answers: [] };

    const prompt = buildBatchPrompt(questions, jobDescription, _profile);
    const systemMessage = `You answer job application questions. Return a JSON object with an answers array where each element has "answer", "confidence", and "supportQuote". supportQuote must be an exact concise quote copied from that question's candidate evidence; use an empty string if no evidence supports the answer. A quote establishes provenance but does not by itself prove entailment. Example: {"answers":[{"answer":"Yes","confidence":0.95,"supportQuote":"Authorized to work in the United States"},{"answer":"NONE","confidence":0.10,"supportQuote":""}]}. NEVER return markdown or explanatory text.

EXPORT CONTROL & EAR RULE: If asked about U.S. Export Administration Regulations (EAR), ITAR, or confirming whether the candidate is a "U.S. person" under 8 U.S.C. 1324b(a)(3):
- Only US Citizens and Permanent Residents (Green Card holders) are "U.S. persons".
- Candidates on temporary non-immigrant visas (F-1, H-1B, OPT, CPT, L-1, TN) or candidates who require sponsorship are NOT "U.S. persons".
- For non-immigrant visa holders or candidates requiring sponsorship, choose the option stating "I am not a U.S. person..." (and confirm not a citizen of Cuba, Iran, North Korea, Syria). NEVER select "I am a U.S. person" for a visa holder.

CURRENT EMPLOYER RULE: When asked for current company or most recent employer, provide the candidate's actual employer company name from their work experience. NEVER return resume section headers like "Professional Experience" or "Work Experience", job titles, city names, or "NONE" when work experience is present.

DROPDOWN & SELECT RULE: For dropdown, select, and radio questions, you MUST select an appropriate option from the choices. Do not answer "Yes" to location, organization, or multi-option questions. If choice options are missing or incomplete and candidate data does not specify the answer, return NONE.

ONSITE & RELOCATION RULE: For questions asking if the candidate is willing or excited to work in-person, onsite, hybrid, or relocate to an office location, answer Yes or select the affirmative/relocation option unless the candidate profile explicitly forbids it.

PROFILE DATA RULE: The Candidate Profile section below contains factual data about the candidate. For any question whose answer exists in the profile (gender, race, ethnicity, veteran status, disability status, salary, education, experience, location, authorization), use the EXACT value from the profile. Never answer "No" or "N/A" for demographic fields — the candidate has already provided these values.

EEOC RULE: For gender, race/ethnicity, veteran status, and disability status fields: find the value in the Candidate Profile and return it. These are always present. Do not guess or default to "No". If the candidate's gender, race/ethnicity, veteran status, or disability status is NOT present in the Candidate Profile section, return exactly: "Decline to self-identify" for that field. Never return "No" for an EEOC demographic field.

CREATIVE RULE: For open-ended motivation or general fit questions, write naturally in first person. Follow explicit word-count/length instructions; otherwise keep it concise. Use supported candidate experience when available. If specific experience is unavailable, answer in general terms without claiming a past event, employer, project, tool, or result. Questions asking for a real past example (such as "Tell us about a time" or "Give an example") are factual: answer only from evidence, otherwise return NONE.

OPTION RULE: For select/radio/checkbox fields with complete options provided, return exactly one provided option. For a select marked with incomplete options, do not constrain the answer to the partial sample; return a concise exact choice supported by candidate data, or NONE if unsupported.

US LOCATION RULE: If asked whether the candidate is currently located in the US, and the profile shows state_of_residence or zip_or_country containing a US state or "United States", answer Yes.

${CORPORATE_POLICY_PROMPT_GUIDELINES}`;

    const canUseGemini = Boolean(this.geminiApiKey);
    const preferGemini = this.provider === 'gemini' || (!this.apiKey && canUseGemini);

    let raw = '';
    let stopReason = '';
    let batchUsage: BatchSynthesizeResult['usage'] = undefined;
    const requestStartedAt = Date.now();

    if (this.provider === 'ollama') {
      try {
        const result = await callOllama({
          prompt,
          systemMessage,
          modelName: this.ollamaModel,
          endpoint: this.ollamaEndpoint,
        });
        haltIfFirstProviderCallFailed(true);
        raw = result.text;
        stopReason = result.stopReason || '';
        batchUsage = result.usage;
        log.info(
          `[LLM Provider] event=request_completed operation=batch provider=ollama ` +
            `model=${result.usage?.model || this.ollamaModel} batch_size=${questions.length} ` +
            `elapsed_ms=${Date.now() - requestStartedAt} prompt_tokens=${batchUsage?.promptTokens ?? 0} ` +
            `completion_tokens=${batchUsage?.completionTokens ?? 0}`
        );
      } catch (ollamaErr: unknown) {
        await emitFailureDiagnostic({
          category: 'RESOLVE_TIER5_PROVIDER_FAILURE',
          stage: 'batch_provider_request',
          reason: 'Tier 5 batch Ollama language-model request failed.',
          error: ollamaErr,
          isTerminal: false,
          isRetryable: true,
          metadata: { matchCount: questions.length },
        });
        log.warn(
          `[LLM Provider] event=request_failed operation=batch provider=ollama ` +
            `model=${this.ollamaModel} batch_size=${questions.length} elapsed_ms=${Date.now() - requestStartedAt} ` +
            `${ollamaErr}`
        );
        haltIfFirstProviderCallFailed(false);
        throw ollamaErr;
      }
    } else if (preferGemini) {
      if (!this.geminiApiKey) {
        throw new Error('No Gemini provider credentials configured.');
      }
      try {
        const result = await callGemini({
          prompt,
          systemMessage,
          maxTokens: Math.max(1024, questions.length * 250),
          modelName: this.geminiModel,
          apiKey: this.geminiApiKey,
        });
        haltIfFirstProviderCallFailed(true);
        raw = result.text;
        stopReason = result.stopReason || '';
        batchUsage = result.usage;
        log.info(
          `[LLM Provider] event=request_completed operation=batch provider=gemini ` +
            `model=${result.usage?.model || this.geminiModel} batch_size=${questions.length} ` +
            `elapsed_ms=${Date.now() - requestStartedAt} prompt_tokens=${batchUsage?.promptTokens ?? 0} ` +
            `completion_tokens=${batchUsage?.completionTokens ?? 0}`
        );
      } catch (geminiErr: unknown) {
        await emitFailureDiagnostic({
          category: 'RESOLVE_TIER5_PROVIDER_FAILURE',
          stage: 'batch_provider_request',
          reason: 'Tier 5 batch Gemini language-model request failed.',
          error: geminiErr,
          isTerminal: false,
          isRetryable: true,
          metadata: { matchCount: questions.length },
        });
        log.warn(
          `[LLM Provider] event=request_failed operation=batch provider=gemini ` +
            `model=${this.geminiModel} batch_size=${questions.length} elapsed_ms=${Date.now() - requestStartedAt} ` +
            `${geminiErr}`
        );
        haltIfFirstProviderCallFailed(false);
        throw geminiErr;
      }
    } else {
      if (!this.apiKey) {
        throw new Error('No LLM provider credentials configured.');
      }
      try {
        const result = await this.callAnthropic(
          prompt,
          systemMessage,
          Math.max(1024, questions.length * 250),
          true
        );
        haltIfFirstProviderCallFailed(true);
        raw = result.text;
        stopReason = result.stopReason || '';
        batchUsage = result.usage;
        log.debug(
          `[LLM Provider] event=request_completed operation=batch provider=anthropic ` +
            `model=${this.modelName} batch_size=${questions.length} elapsed_ms=${Date.now() - requestStartedAt} ` +
            `content_chars=${raw.length} prompt_tokens=${batchUsage?.promptTokens ?? 0} ` +
            `completion_tokens=${batchUsage?.completionTokens ?? 0}`
        );
      } catch (err: unknown) {
        if (
          canUseGemini &&
          (String(err).includes('usage limits') ||
            String(err).includes('workspace') ||
            String(err).includes('400'))
        ) {
          log.warn(
            `[LLM Provider] Anthropic hit workspace limit. Automatically failing over to Gemini provider.`
          );
          const geminiResult = await callGemini({
            prompt,
            systemMessage,
            maxTokens: Math.max(1024, questions.length * 250),
            modelName: this.geminiModel,
            apiKey: this.geminiApiKey,
          });
          haltIfFirstProviderCallFailed(true);
          raw = geminiResult.text;
          stopReason = geminiResult.stopReason || '';
          batchUsage = geminiResult.usage;
        } else {
          await emitFailureDiagnostic({
            category: 'RESOLVE_TIER5_PROVIDER_FAILURE',
            stage: 'batch_provider_request',
            reason: 'Tier 5 batch Anthropic language-model request failed.',
            error: err,
            isTerminal: false,
            isRetryable: true,
            metadata: { matchCount: questions.length },
          });
          log.warn(
            `[LLM Provider] event=request_failed operation=batch provider=anthropic ` +
              `model=${this.modelName} batch_size=${questions.length} elapsed_ms=${Date.now() - requestStartedAt} ` +
              `${formatProviderErrorDiagnostics(getLlmProviderErrorDiagnostics(err))}`
          );
          haltIfFirstProviderCallFailed(false);
          throw err;
        }
      }
    }

    const items = parseBatchAnswerItems(raw, questions.length);
    if (!items) {
      await emitFailureDiagnostic({
        category: 'RESOLVE_TIER5_PARSE',
        stage: 'batch_response_parse',
        reason: 'Tier 5 returned a batch response with an invalid answer structure.',
        isTerminal: false,
        isRetryable: true,
        metadata: { contentChars: raw.length, matchCount: questions.length },
      });
      log.error(
        `[Resolver] event=t5_batch_parse_failure provider=${this.provider} model=${this.modelName} ` +
          `batch_size=${questions.length} response_chars=${raw.length} stop_reason=${stopReason || 'unknown'} elapsed_ms=${Date.now() - requestStartedAt} ` +
          'expected_shape=json_array answers=0'
      );
      return { answers: questions.map(() => ''), confidences: questions.map(() => 0), supportQuotes: questions.map(() => ''), usage: batchUsage };
    }
    return {
      answers: items.map((i) => i.answer),
      confidences: items.map((i) => i.confidence ?? 0),
      supportQuotes: items.map((i) => i.supportQuote || ''),
      usage: batchUsage,
    };
  }

  /**
   * Constructs a structured prompt passing candidate background and question schema.
   */
  private constructPrompt(
    field: ScannedField,
    profile: ApplyWizzCandidateProfile,
    resumeText: string,
    jobContext: JobContext,
    resumeFacts?: any
  ): string {
    return buildSinglePrompt(field, profile, resumeText, jobContext, resumeFacts);
  }

  /**
   * Generates a context-aware heuristic answer when LLM API keys are not provided.
   *
   * @param field - Scanned question.
   * @param profile - Candidate profile.
   * @param jobContext - Job context.
   * @returns Formatted fallback answer string.
   */
  private generateFallbackAnswer(
    field: ScannedField,
    profile: ApplyWizzCandidateProfile,
    _jobContext: JobContext
  ): string {
    const combined = `${field.label || ''} ${field.name || ''} ${field.fieldId || ''}`.toLowerCase();

    // URLs must NEVER return prose paragraphs
    if (/linkedin|website|portfolio|github|\burl\b|blog|personal site/i.test(combined)) {
      if (/linkedin/i.test(combined)) {
        if (profile.linkedinUrl) return profile.linkedinUrl;
        const cleanName = (profile.clientName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanName ? `https://www.linkedin.com/in/${cleanName}` : '';
      }
      if (/github/i.test(combined)) {
        return profile.githubUrl || '';
      }
      if (/portfolio|website|blog|personal site/i.test(combined)) {
        return profile.websiteUrl || '';
      }
      return '';
    }

    if (isBinaryYesNoQuestion(field)) {
      const fromProfile = inferYesNoFromProfile(field, profile);
      if (!fromProfile) return '';
      const options = getEffectiveFieldOptions(field);
      if (options && options.length > 0) {
        return matchExactOption(fromProfile, options) || '';
      }
      return fromProfile;
    }

    const choiceOptions = getEffectiveFieldOptions(field);
    if (choiceOptions && choiceOptions.length > 0) {
      return '';
    }

    const lowerLabel = (field.label || '').toLowerCase();

    if (lowerLabel.includes('hear about') || lowerLabel.includes('source') || lowerLabel.includes('referral')) {
      return '';
    }

    if (lowerLabel.includes('why') || lowerLabel.includes('interest')) {
      return '';
    }

    if (lowerLabel.includes('describe') || lowerLabel.includes('experience') || lowerLabel.includes('project')) {
      return '';
    }

    if (lowerLabel.includes('start date') || lowerLabel.includes('availability')) {
      return '';
    }

    if (lowerLabel.includes('salary') || lowerLabel.includes('compensation')) {
      return profile.demographics?.salaryRange || '';
    }

    if (lowerLabel.includes('unique') || lowerLabel.includes('stand out')) {
      return '';
    }

    if (/subsidiaries|worked for|affiliate|previous employee/i.test(lowerLabel)) {
      return 'No';
    }

    if (/if other|please specify|if chose/i.test(lowerLabel)) {
      return 'N/A';
    }

    return '';
  }
}

export function buildBatchPrompt(
  questions: BatchQuestion[],
  jobDescription: string,
  profile?: ApplyWizzCandidateProfile | any | null
): string {
  const hasCorporateDefaults = questions.some((q) => Boolean(q.corporateDefaultHint));

  let corporateDefaultsBlock = '';
  if (hasCorporateDefaults) {
    let locationStr = '{city}, {state}';
    if (profile) {
      locationStr =
        (profile as any).location ||
        ((profile as any).city ? `${(profile as any).city || ''}, ${(profile as any).state || ''}`.trim() : '') ||
        '{city}, {state}';
    }

    corporateDefaultsBlock = `
## Corporate Default Rules
When a question matches these patterns and no resume evidence exists, use the default answer below.
Map the default to the closest available option in the form — do NOT answer literally if the form
has no matching option (return null instead).

- "Have you interviewed here before?" → default: "No"
- "How did you hear about us?" → default: LinkedIn or first job board option
  Priority: linkedin > job board > online > website > indeed > glassdoor > other
  Pick the first option that contains a keyword from this list. If none match, pick the first non-empty option.
- Arbitration / policy agreements → default: agree / yes / checked
- "County" → derive from candidate city/state: "${locationStr}"
`;
  }

  let candidateHeaderBlock = '';
  if (profile) {
    const candidateData = {
      applywizzId: profile.applywizzId || 'N/A',
      clientName: profile.clientName || '',
      email: profile.email || '',
      phone: profile.phone || '',
      location: profile.location || '',
      workAuthorization: profile.workAuthorization || '',
      requiresSponsorship: profile.requiresSponsorship === true ? 'true' : 'false',
      demographics: profile.demographics || {},
    };
    candidateHeaderBlock = `## Candidate Profile Context
- Candidate ApplyWizz ID: ${candidateData.applywizzId}
- Candidate Name: ${candidateData.clientName}
- Work Authorization: ${candidateData.workAuthorization}
- Requires Sponsorship: ${candidateData.requiresSponsorship}
- Location: ${candidateData.location}
- Demographics: ${JSON.stringify(candidateData.demographics)}

`;
  }

  const prompt = `${candidateHeaderBlock}Resolve every numbered job application question using only the candidate evidence and job description.
Return ONLY a JSON object with an "answers" array in the same order as the questions. Each item must be {"answer":"...","confidence":0.0,"supportQuote":"exact quote from this question's candidate evidence"}. Use an empty supportQuote if evidence does not support the answer. A quote identifies provenance but does not by itself prove entailment. Do not include markdown or explanations.

For any question with a complete Options list provided, your answer MUST be one of the exact option strings listed. Do not rephrase or abbreviate. If a choice list is marked incomplete, do not treat the captured options as exhaustive; return a concise exact choice supported by candidate data or NONE.
${corporateDefaultsBlock}
Job description:
${jobDescription.slice(0, 12000)}

Questions:
${questions
    .map((question, index) => {
      const opts =
        question.options && question.options.length > 0
          ? ` ${question.optionsComplete === false ? 'Captured options (incomplete)' : 'Options'}: ${question.options.join(' | ')}`
          : '';
      const completenessHint = question.optionsComplete === false ? ' [choice options incomplete]' : '';
      const starHint = classifyTier5Question({ label: question.label, type: question.type, options: question.options } as ScannedField) === 'creative'
        ? ' [Natural first person; follow explicit length instructions; do not invent candidate facts; generalize truthfully when specific evidence is unavailable.]'
        : '';
      const hintLine = question.corporateDefaultHint
        ? `\nCorporate default hint: ${question.corporateDefaultHint}`
        : '';
      return `${index}. [${question.type}] ${question.label}${completenessHint}${starHint}${opts}${question.value ? ` (existing value: ${question.value})` : ''}${hintLine}\nCandidate evidence:\n${question.candidateEvidence || '(No directly relevant candidate evidence found.)'}`;
    })
    .join('\n')}`;

  return prompt;
}

export function buildSinglePrompt(
  field: ScannedField,
  profile: ApplyWizzCandidateProfile,
  resumeText: string,
  jobContext: JobContext,
  resumeFacts?: any
): string {
  const choiceOptions = getEffectiveFieldOptions(field);
  const promptOptions = choiceOptions || (field.optionsComplete === false ? field.options : undefined);
  const optionsSection =
    promptOptions && promptOptions.length > 0
      ? `${formatAvailableOptionsLine(promptOptions)}${field.optionsComplete === false ? ' (incomplete list; not exhaustive)' : ''}`
      : '';

  const profileDecisionBlock = isBinaryYesNoQuestion(field)
    ? buildProfileDecisionContext(field, profile)
    : '';

  const corporateDefaultHint = (field as any).corporateDefaultHint;
  let corporateDefaultsBlock = '';
  if (corporateDefaultHint) {
    const locationStr =
      (profile as any).location ||
      ((profile as any).city ? `${(profile as any).city || ''}, ${(profile as any).state || ''}`.trim() : '') ||
      '{city}, {state}';
    corporateDefaultsBlock = `
## Corporate Default Rules
When a question matches these patterns and no resume evidence exists, use the default answer below.
Map the default to the closest available option in the form — do NOT answer literally if the form
has no matching option (return null instead).

- "Have you interviewed here before?" → default: "No"
- "How did you hear about us?" → default: LinkedIn or first job board option
  Priority: linkedin > job board > online > website > indeed > glassdoor > other
  Pick the first option that contains a keyword from this list. If none match, pick the first non-empty option.
- Arbitration / policy agreements → default: agree / yes / checked
- "County" → derive from candidate city/state: "${locationStr}"
Corporate default hint for this question: ${corporateDefaultHint}
`;
  }

  const incompleteChoice = field.type === 'select' && field.optionsComplete === false;
  const instructions = incompleteChoice
    ? `Instructions:
1. This is a dropdown with an incomplete scanned option list; the full option list is not provided.
2. Return only one concise exact choice label supported by candidate information, in the format expected by the dropdown (for example, a full school name).
3. Do not invent or assume candidate information. If no supported answer is available, return NONE.`
    : isBinaryYesNoQuestion(field)
    ? `Instructions:
1. Use the exact requires_sponsorship and work_authorization values from the profile. Do not guess.
2. You MUST respond with exactly one of the provided options, no other text.`
    : choiceOptions && choiceOptions.length > 0
      ? `Instructions:
1. You MUST respond with exactly one of these options, no other text.
2. Base the choice only on the candidate profile data provided. Do not invent or assume information not present in the profile.
3. For Export Administration Regulations (EAR) / U.S. person questions: non-immigrant visa holders (F-1, H-1B, OPT) and candidates requiring sponsorship are NOT U.S. persons. Select "I am not a U.S. person...".
4. Respond as JSON only: {"answer":"<selected exact option>","confidence":<0.0-1.0>}.`
      : classifyTier5Question(field) === 'creative'
      ? `Creative response instructions:
1. Write a natural, professional first-person response. Follow any explicit length instruction; otherwise be concise.
2. Use supported experience when available. If details are unavailable, answer in general terms without claiming a past event, employer, project, tool, or result.
3. For motivation questions, connect only evidenced candidate background with the ${jobContext.title} role at ${jobContext.company}; do not invent company facts.
4. Return JSON only: {"answer":"<your answer>","confidence":<0.0-1.0>}. Confidence does not determine whether a creative answer is usable.`
      : `Strict Instructions:
1. Be concise and factual. Base your answer only on the candidate profile data provided. Do not invent or assume information not present in the profile.
2. Provide a professional, concise, direct response written in first-person ("I am...", "My experience...").
3. NEVER use generic placeholder names like "xyz company", "[Company]", or "my previous employer", resume section headings (like "Professional Experience"), or city names for employer questions. Always cite their ACTUAL past companies, verified project names, or specific tools found in their resume.
4. If the candidate's resume does not mention the exact requested tool/technology, write honestly: "While my hands-on experience has primarily focused on [adjacent skill/tool from resume], I have foundational knowledge and am rapid to ramp up."
5. For open-ended/textarea questions, provide a 2 to 3 sentence concise, tailored answer.
6. Respond as JSON only: {"answer":"<your answer>","confidence":<0.0-1.0>}. If you are not at least 0.65 confident, set confidence below 0.65.`;

  const candidateEvidence = buildQuestionRelevantEvidence(
    field,
    profile,
    resumeText,
    resumeFacts
  );

  return `You are an automated assistant helping a job candidate apply for a position.
${corporateDefaultsBlock}
Candidate Information:
- Full Name: ${profile.clientName}
- Candidate evidence selected for this question:
${candidateEvidence || '(No directly relevant candidate evidence found.)'}
- Work Authorization (work_authorization, exact): ${profile.workAuthorization || '(not provided)'}
- Requires Sponsorship (requires_sponsorship, exact): ${profile.requiresSponsorship === true ? 'true' : 'false'}
${profileDecisionBlock}

Target Job:
- Position: ${jobContext.title}
- Company: ${jobContext.company}

Question to Answer:
- Question Label: "${field.label}"
- Input Type: ${field.type}${optionsSection}

${instructions}`;
}
