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

import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config/env.js';
import { getBedrockClient } from '../services/bedrockClient.js';
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

/**
 * Options configuring the LLMSynthesizer.
 */
export interface LLMSynthesizerOptions {
  /** Active LLM provider ('openrouter' | 'gemini' | 'openai' | 'ollama' | 'bedrock') */
  provider?: 'openrouter' | 'gemini' | 'openai' | 'ollama' | 'bedrock';
  /** LLM API Key override */
  apiKey?: string;
  /** Model name override */
  modelName?: string;
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

export function isBinaryYesNoQuestion(field: ScannedField): boolean {
  const label = field.label || '';
  const combined = `${label} ${field.name || ''} ${field.fieldId || ''}`;
  const opts = field.options && field.options.length > 0 ? field.options : undefined;

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

function parseLlmResponse(raw: string): { answer: string; confidence: number | null } {
  const cleaned = cleanLLMOutput(raw);
  try {
    const parsed = JSON.parse(cleaned) as { answer?: unknown; value?: unknown; confidence?: unknown };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const answer = String(parsed.answer ?? parsed.value ?? '').trim();
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : null;
      return { answer, confidence };
    }
  } catch {
    // plain-text answer
  }
  return { answer: cleaned, confidence: null };
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

export function parseBatchAnswerResponse(raw: string, expectedCount: number): string[] | null {
  let parsed = extractJsonValue(cleanLLMOutput(raw));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.every(([key]) => /^\d+$/.test(key))) {
      entries.sort(([left], [right]) => Number(left) - Number(right));
    }
    parsed = entries.map(([, value]) => value);
  }
  if (!Array.isArray(parsed)) return null;

  const answers = parsed.map((item) =>
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      ? cleanLLMOutput(String(item))
      : ''
  );
  return Array.from({ length: expectedCount }, (_, index) => answers[index] || '');
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
 * Tier 2 Answer Synthesizer invoking OpenRouter, Google Gemini, or OpenAI.
 */
export class LLMSynthesizer {
  private readonly provider: 'openrouter' | 'gemini' | 'openai' | 'ollama' | 'bedrock';
  private readonly apiKey: string;
  private readonly modelName: string;
  private geminiClient: GoogleGenerativeAI | null = null;
  private openaiClient: OpenAI | null = null;

  /**
   * Initializes the LLMSynthesizer with provider selection and API key validation.
   *
   * @param options - Configuration overrides.
   */
  constructor(options: LLMSynthesizerOptions = {}) {
    const isSandbox = process.env.SANDBOX === 'true' || process.env.SANDBOX === '1';
    const chosenProvider = options.provider ?? config.LLM_PROVIDER;
    // In sandbox, prefer openrouter unless bedrock is explicitly requested/configured
    this.provider = (isSandbox && chosenProvider !== 'bedrock') ? 'openrouter' : chosenProvider;
    this.apiKey = options.apiKey ?? config.ACTIVE_LLM_API_KEY;

    if (isSandbox && !this.apiKey && this.provider !== 'bedrock') {
      log.error('❌ Sandbox mode requires OPENROUTER_API_KEY. Ollama fallback is completely disabled.');
    }

    if (this.provider === 'bedrock') {
      this.modelName = options.modelName ?? config.BEDROCK_MODEL_ID ?? 'us.amazon.nova-2-lite-v1:0';
    } else if (this.provider === 'ollama') {
      this.modelName = options.modelName ?? config.OLLAMA_MODEL ?? 'llama3.1:latest';
      this.openaiClient = new OpenAI({
        baseURL: config.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
        apiKey: 'ollama',
        timeout: 45000,
        maxRetries: 1,
      });
    } else if (this.provider === 'openrouter') {
      this.modelName = options.modelName ?? config.OPENROUTER_MODEL;
      if (this.apiKey) {
        this.openaiClient = new OpenAI({
          baseURL: config.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
          apiKey: this.apiKey,
          timeout: config.LLM_TIMEOUT_MS,
          maxRetries: 1,
          defaultHeaders: {
            'HTTP-Referer': config.OPENROUTER_HTTP_REFERER || 'https://apply-wizz.me',
            'X-Title': 'Greenhouse Automation Operator',
            'X-OpenRouter-Cache': 'true',
          },
        });
      }
    } else if (this.provider === 'openai') {
      this.modelName = options.modelName ?? 'gpt-4o-mini';
      if (this.apiKey) {
        this.openaiClient = new OpenAI({ apiKey: this.apiKey, timeout: config.LLM_TIMEOUT_MS, maxRetries: 1 });
      }
    } else {
      this.modelName = options.modelName ?? 'gemini-2.5-flash';
      if (this.apiKey) {
        this.geminiClient = new GoogleGenerativeAI(this.apiKey);
      }
    }
  }

  public getProviderDiagnostics(): { provider: string; model: string } {
    return { provider: this.provider, model: this.modelName };
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
    const systemMessage = incompleteChoice
      ? 'You are an automated job application assistant. Return only one concise, exact choice label supported by candidate data. The scanned choice list is incomplete; do not invent a value. If candidate data does not support an answer, return NONE.'
      : isChoiceField
      ? 'You are an automated job application assistant. You MUST return exactly one of the provided options. Choose the closest true answer based on candidate data. If none fit, return NONE.'
      : 'You are an automated job application assistant. Be concise and factual. Base your answer only on the candidate profile data provided. Do not invent or assume information not present in the profile. Reply as JSON only: {"answer":"<text>","confidence":<0.0-1.0>}. NEVER return markdown or explanatory text.';

    // If API key is configured or provider is bedrock or ollama, execute real LLM call
    if (this.apiKey || this.provider === 'ollama' || this.provider === 'bedrock') {
      let failureDiagnosticEmitted = false;
      try {
        let providerReached = false;

        if (this.provider === 'bedrock') {
          const client = getBedrockClient();
          const command = new ConverseCommand({
            modelId: this.modelName,
            system: [{ text: systemMessage }],
            messages: [
              {
                role: 'user',
                content: [{ text: prompt }],
              },
            ],
            inferenceConfig: {
              maxTokens: 300,
              temperature: 0.2,
            },
          });

          const startedAt = Date.now();
          const response = await client.send(command);
          providerReached = true;
          haltIfFirstProviderCallFailed(true);

          const outputText = response.output?.message?.content?.[0]?.text?.trim() || '';
          const cleaned = cleanLLMOutput(outputText);
          log.debug(
            `[LLM Provider] event=request_completed operation=single provider=bedrock ` +
              `model=${this.modelName} elapsed_ms=${Date.now() - startedAt} content_chars=${cleaned.length}`
          );

          if (cleaned && cleaned.length > 0) {
            try {
              return this.finalizeLlmAnswer(cleaned, field, profile, jobContext, choiceOptions);
            } catch (error) {
              await emitFailureDiagnostic({
                category: 'RESOLVE_TIER5_PARSE',
                stage: 'single_response_parse',
                reason: 'Tier 5 Bedrock returned a response that could not be parsed into a valid answer.',
                error,
                isTerminal: false,
                isRetryable: true,
              });
              failureDiagnosticEmitted = true;
              throw error;
            }
          }
        }

        if ((this.provider === 'openrouter' || this.provider === 'openai' || this.provider === 'ollama') && this.openaiClient) {
          let rawAnswer = '';
          const candidateModels =
            this.provider === 'openrouter'
              ? [
                  this.modelName,
                  'google/gemini-2.5-flash',
                  'meta-llama/llama-3.3-70b-instruct',
                ]
              : [this.modelName];

          const uniqueModels = Array.from(new Set(candidateModels));

          for (const modelId of uniqueModels) {
            const modelStartedAt = Date.now();
            try {
              const completion = await this.openaiClient.chat.completions.create({
                model: modelId,
                messages: [
                  {
                    role: 'system',
                    content: systemMessage,
                  },
                  { role: 'user', content: prompt },
                ],
                temperature: 0.2,
                max_tokens: 300,
              });
              providerReached = true;

              const content = completion?.choices?.[0]?.message?.content?.trim();
              const cleaned = cleanLLMOutput(content || '');
              log.debug(
                `[LLM Provider] event=request_completed operation=single provider=${this.provider} ` +
                  `model=${modelId} elapsed_ms=${Date.now() - modelStartedAt} ` +
                  `content_chars=${cleaned.length} finish_reason=${completion?.choices?.[0]?.finish_reason || 'none'}`
              );
              if (cleaned && cleaned.length > 0) {
                rawAnswer = cleaned;
                break;
              }

            } catch (modelErr: unknown) {
              await emitFailureDiagnostic({
                category: 'RESOLVE_TIER5_PROVIDER_FAILURE',
                stage: 'single_model_request',
                reason: 'A configured Tier 5 language-model request failed.',
                error: modelErr,
                isTerminal: false,
                isRetryable: true,
              });
              failureDiagnosticEmitted = true;
              const diagnostics = getLlmProviderErrorDiagnostics(modelErr);
              log.warn(
                `[LLM Provider] event=request_failed operation=single provider=${this.provider} ` +
                  `model=${modelId} elapsed_ms=${Date.now() - modelStartedAt} ` +
                  `${formatProviderErrorDiagnostics(diagnostics)} fallback=next_model`
              );
            }
          }

          haltIfFirstProviderCallFailed(providerReached);

          if (rawAnswer && rawAnswer.length > 0) {
            try {
              return this.finalizeLlmAnswer(rawAnswer, field, profile, jobContext, choiceOptions);
            } catch (error) {
              await emitFailureDiagnostic({
                category: 'RESOLVE_TIER5_PARSE',
                stage: 'single_response_parse',
                reason: 'Tier 5 returned a response that could not be parsed into a valid answer.',
                error,
                isTerminal: false,
                isRetryable: true,
              });
              failureDiagnosticEmitted = true;
              throw error;
            }
          }
        }

        if (this.provider === 'gemini' && this.geminiClient) {
          const model = this.geminiClient.getGenerativeModel({ model: this.modelName });
          const result = await model.generateContent(prompt);
          providerReached = true;
          haltIfFirstProviderCallFailed(true);
          const content = result.response.text().trim();
          const cleaned = cleanLLMOutput(content);
          if (cleaned && cleaned.length > 0) {
            try {
              return this.finalizeLlmAnswer(cleaned, field, profile, jobContext, choiceOptions);
            } catch (error) {
              await emitFailureDiagnostic({
                category: 'RESOLVE_TIER5_PARSE',
                stage: 'single_response_parse',
                reason: 'Tier 5 returned a response that could not be parsed into a valid answer.',
                error,
                isTerminal: false,
                isRetryable: true,
              });
              failureDiagnosticEmitted = true;
              throw error;
            }
          }
        }

        if (this.provider === 'gemini') {
          haltIfFirstProviderCallFailed(providerReached);
        }
      } catch (err: any) {
        if (!failureDiagnosticEmitted) {
          await emitFailureDiagnostic({
            category: 'RESOLVE_TIER5_PROVIDER_FAILURE',
            stage: 'single_provider_request',
            reason: 'Tier 5 language-model request failed.',
            error: err,
            isTerminal: false,
            isRetryable: true,
          });
        }
        log.warn(
          `[LLM Provider] event=request_failed operation=single provider=${this.provider} ` +
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
    opts?: { defaultConfidenceIfMissing?: number }
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
    opts?: { defaultConfidenceIfMissing?: number }
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
        confidence = answer ? 0.9 : null;
      }
    }

    if (choiceOptions && choiceOptions.length > 0) {
      if (/gender|race|ethnicity|hispanic|latino|veteran|disability|eeoc/i.test(field.label)) {
        log.debug(
          `[T5 EEOC] label="${field.label}" options=${JSON.stringify(choiceOptions)}`
        );
      }
      const matched = matchChoiceOption(answer, choiceOptions);

      if (!matched) {
        log.warn(
          `[Resolver] ❌ T5 no option match label="${field.label}" options=${JSON.stringify(choiceOptions)}`
        );
        return unresolvedField(field);
      }
      answer = matched;
      if (confidence == null) confidence = 0.9;
    }

    if (!answer) {
      return unresolvedField(field);
    }
    if (confidence == null && opts?.defaultConfidenceIfMissing != null) {
      confidence = opts.defaultConfidenceIfMissing;
    }
    if (confidence == null || confidence < LLM_MIN_CONFIDENCE) {
      return unresolvedField(field);
    }

    return aiField(field, answer, confidence);
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
    const systemMessage = `You answer job application questions. Return only a valid JSON array of direct answer strings, one answer per question, in order. Example: ["answer 1", "answer 2"]. NEVER return markdown or explanatory text.

PROFILE DATA RULE: The Candidate Profile section below contains factual data about the candidate. For any question whose answer exists in the profile (gender, race, ethnicity, veteran status, disability status, salary, education, experience, location, authorization), use the EXACT value from the profile. Never answer "No" or "N/A" for demographic fields — the candidate has already provided these values.

EEOC RULE: For gender, race/ethnicity, veteran status, and disability status fields: find the value in the Candidate Profile and return it. These are always present. Do not guess or default to "No". If the candidate's gender, race/ethnicity, veteran status, or disability status is NOT present in the Candidate Profile section, return exactly: "Decline to self-identify" for that field. Never return "No" for an EEOC demographic field.

CREATIVE RULE: For open-ended behavioral/experience questions ("Have you worked with...", "Tell us about a time...", "Describe a project...") or company motivation questions ("Why choose our company...", "Why are you interested in this role?"): write a concise single paragraph (approximately 50 to 80 words) following the STAR methodology (Situation, Task, Action, and Result) without explicit section headings or bullet labels. Write in a confident, professional first-person voice ("I led...", "In my role at..."). Ground every detail strictly in the candidate's actual work experience, verified project names, and tools from their profile/resume. Do not say the resume does not contain information — synthesize a truthful answer.

OPTION RULE: For select/radio/checkbox fields with complete options provided, return exactly one provided option. For a select marked with incomplete options, do not constrain the answer to the partial sample; return a concise exact choice supported by candidate data, or NONE if unsupported.

US LOCATION RULE: If asked whether the candidate is currently located in the US, and the profile shows state_of_residence or zip_or_country containing a US state or "United States", answer Yes.`;

    if (!(this.apiKey || this.provider === 'ollama' || this.provider === 'bedrock')) {
      throw new Error('No LLM provider credentials configured.');
    }

    let raw = '';
    let batchUsage: BatchSynthesizeResult['usage'] = undefined;
    const requestStartedAt = Date.now();
    try {
      if (this.provider === 'bedrock') {
        const client = getBedrockClient();
        const enablePromptCaching = config.BEDROCK_ENABLE_PROMPT_CACHING !== false;

        // Structured system blocks with candidate profile and prompt cache checkpoint
        const candidateProfileSummary = _profile ? JSON.stringify({
          clientName: _profile.clientName,
          email: _profile.email,
          phone: _profile.phone,
          location: _profile.location || '',
          workAuthorization: _profile.workAuthorization,
          requiresSponsorship: _profile.requiresSponsorship,
          demographics: _profile.demographics,
        }) : '';

        const systemBlocks: any[] = [{ text: systemMessage }];
        if (candidateProfileSummary) {
          systemBlocks.push({ text: `Candidate Profile:\n${candidateProfileSummary}` });
        }
        if (enablePromptCaching) {
          systemBlocks.push({ cachePoint: { type: 'default' } });
        }

        const command = new ConverseCommand({
          modelId: this.modelName,
          system: systemBlocks,
          messages: [
            {
              role: 'user',
              content: [{ text: prompt }],
            },
          ],
          inferenceConfig: {
            maxTokens: Math.max(500, questions.length * 150),
            temperature: 0.2,
          },
        });

        const response = await client.send(command);
        haltIfFirstProviderCallFailed(true);
        raw = response.output?.message?.content?.[0]?.text || '';

        const usageData = response.usage as any;
        if (usageData) {
          batchUsage = {
            promptTokens: usageData.inputTokens || 0,
            completionTokens: usageData.outputTokens || 0,
            cacheReadTokens: usageData.cacheReadInputTokenCount || 0,
            cacheWriteTokens: usageData.cacheWriteInputTokenCount || 0,
            totalTokens: usageData.totalTokens || ((usageData.inputTokens || 0) + (usageData.outputTokens || 0)),
            model: this.modelName,
          };
        }

        log.debug(
          `[LLM Provider] event=request_completed operation=batch provider=bedrock ` +
            `model=${this.modelName} batch_size=${questions.length} elapsed_ms=${Date.now() - requestStartedAt} ` +
            `content_chars=${raw.length} prompt_tokens=${batchUsage?.promptTokens ?? 0} ` +
            `cached_tokens=${batchUsage?.cacheReadTokens ?? 0} completion_tokens=${batchUsage?.completionTokens ?? 0}`
        );
      } else if ((this.provider === 'openrouter' || this.provider === 'openai' || this.provider === 'ollama') && this.openaiClient) {
        const completion = await this.openaiClient.chat.completions.create({
          model: this.modelName,
          messages: [{ role: 'system', content: systemMessage }, { role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: Math.max(300, questions.length * 100),
        });
        haltIfFirstProviderCallFailed(true);
        raw = completion?.choices?.[0]?.message?.content || '';
        const usageData = completion?.usage as any;
        if (usageData) {
          const cachedTokens = usageData.prompt_tokens_details?.cached_tokens || 0;
          const directCost = typeof usageData.cost === 'number' ? usageData.cost : undefined;
          batchUsage = {
            promptTokens: usageData.prompt_tokens || 0,
            completionTokens: usageData.completion_tokens || 0,
            cacheReadTokens: cachedTokens,
            cacheWriteTokens: usageData.prompt_tokens_details?.cache_write_tokens || 0,
            totalTokens: usageData.total_tokens || ((usageData.prompt_tokens || 0) + (usageData.completion_tokens || 0)),
            cost: directCost,
            model: this.modelName,
          };
        }
        log.debug(
          `[LLM Provider] event=request_completed operation=batch provider=${this.provider} ` +
            `model=${this.modelName} batch_size=${questions.length} elapsed_ms=${Date.now() - requestStartedAt} ` +
            `content_chars=${raw.length} prompt_tokens=${batchUsage?.promptTokens ?? 0} ` +
            `cached_tokens=${batchUsage?.cacheReadTokens ?? 0} cost=${batchUsage?.cost !== undefined ? `$${batchUsage.cost.toFixed(6)}` : 'n/a'} ` +
            `finish_reason=${completion?.choices?.[0]?.finish_reason || 'none'}`
        );
      } else if (this.provider === 'gemini' && this.geminiClient) {
        const model = this.geminiClient.getGenerativeModel({ model: this.modelName });
        const result = await model.generateContent(`${systemMessage}\n\n${prompt}`);
        haltIfFirstProviderCallFailed(true);
        raw = result.response.text();
        const usageMetadata = result.response.usageMetadata;
        if (usageMetadata) {
          batchUsage = {
            promptTokens: usageMetadata.promptTokenCount || 0,
            completionTokens: usageMetadata.candidatesTokenCount || 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: usageMetadata.totalTokenCount || 0,
            model: this.modelName,
          };
        }
        log.debug(
          `[LLM Provider] event=request_completed operation=batch provider=${this.provider} ` +
            `model=${this.modelName} batch_size=${questions.length} elapsed_ms=${Date.now() - requestStartedAt} ` +
            `content_chars=${raw.length}`
        );
      } else {
        haltIfFirstProviderCallFailed(false);
        throw new Error(`LLM provider ${this.provider} is unavailable.`);
      }
    } catch (err: unknown) {
      await emitFailureDiagnostic({
        category: 'RESOLVE_TIER5_PROVIDER_FAILURE',
        stage: 'batch_provider_request',
        reason: 'Tier 5 batch language-model request failed.',
        error: err,
        isTerminal: false,
        isRetryable: true,
        metadata: { matchCount: questions.length },
      });
      log.warn(
        `[LLM Provider] event=request_failed operation=batch provider=${this.provider} ` +
          `model=${this.modelName} batch_size=${questions.length} elapsed_ms=${Date.now() - requestStartedAt} ` +
          `${formatProviderErrorDiagnostics(getLlmProviderErrorDiagnostics(err))}`
      );
      haltIfFirstProviderCallFailed(false);
      throw err;
    }

    const answers = parseBatchAnswerResponse(raw, questions.length);
    if (!answers) {
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
          `batch_size=${questions.length} response_chars=${raw.length} elapsed_ms=${Date.now() - requestStartedAt} ` +
          'expected_shape=json_array answers=0'
      );
      return { answers: questions.map(() => ''), usage: batchUsage };
    }
    return { answers, usage: batchUsage };
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
Return ONLY a JSON array of strings in the same order as the questions. Do not include markdown or explanations.

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
      const starHint = isBehavioralOrMotivationalQuestion({ label: question.label, type: question.type, options: question.options })
        ? ' [STAR format 50-80 words, Situation-Task-Action-Result in first-person, strictly grounded in candidate history]'
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
2. Base the choice only on the candidate profile data provided. Do not invent or assume information not present in the profile.`
      : isBehavioralOrMotivationalQuestion(field)
      ? `Strict Instructions (STAR Methodology):
1. Format answer as a concise single paragraph (approximately 50 to 80 words) following the STAR methodology (Situation, Task, Action, and Result) without explicit headings or bullet labels.
2. Provide a professional, confident direct response written in first-person ("I led...", "In my role at...").
3. Ground every detail strictly in the candidate's actual work experience, verified project names, and tools from their resume or profile. NEVER invent companies, degrees, or tools.
4. For questions asking why you want to work at this company ("${jobContext.company}"), tie the candidate's specific background and aspirations directly to ${jobContext.company} and the ${jobContext.title} position.
5. If the candidate's resume does not mention the exact requested tool/technology, write honestly using adjacent skills: "While my hands-on experience has primarily focused on [adjacent skill/tool from resume], I have foundational knowledge and am rapid to ramp up."
6. Respond as JSON only: {"answer":"<your answer>","confidence":<0.0-1.0>}. If you are not at least 0.65 confident, set confidence below 0.65.`
      : `Strict Instructions:
1. Be concise and factual. Base your answer only on the candidate profile data provided. Do not invent or assume information not present in the profile.
2. Provide a professional, concise, direct response written in first-person ("I am...", "My experience...").
3. NEVER use generic placeholder names like "xyz company", "[Company]", or "my previous employer". Always cite their ACTUAL past companies, verified project names, or specific tools found in their resume.
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
