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
  /** Active LLM provider (strictly 'anthropic') */
  provider?: 'anthropic';
  /** Anthropic workspace ID override */
  workspaceId?: string;
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

/** Options safe to persist into ResolvedField metadata: only options observed by the scanner. */
export function getPersistedFieldOptions(field: ScannedField): string[] | undefined {
  return field.options && field.options.length > 0 ? field.options : undefined;
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
 * Tier 5 Answer Synthesizer invoking Anthropic Claude API.
 */
export class LLMSynthesizer {
  private readonly provider = 'anthropic' as const;
  private readonly workspaceId?: string;
  private readonly apiKey: string;
  private readonly modelName: string;

  /**
   * Initializes the LLMSynthesizer strictly with Anthropic Claude configuration.
   *
   * @param options - Configuration overrides.
   */
  constructor(options: LLMSynthesizerOptions = {}) {
    this.apiKey = (
      options.apiKey !== undefined
        ? options.apiKey
        : (config.CLAUDE_API_KEY ?? config.ACTIVE_LLM_API_KEY ?? '')
    ).trim();
    this.workspaceId = (options.workspaceId ?? config.ANTHROPIC_WORKSPACE_ID ?? '').trim() || undefined;
    this.modelName = (options.modelName ?? config.CLAUDE_MODEL ?? 'claude-haiku-5-5').trim();

    const isSandbox = process.env.SANDBOX === 'true' || process.env.SANDBOX === '1';
    if (isSandbox && !this.apiKey) {
      log.warn('⚠️ Sandbox mode: CLAUDE_API_KEY is not configured for LLM synthesis.');
    }
  }

  public getProviderDiagnostics(): { provider: string; model: string } {
    return { provider: this.provider, model: this.modelName };
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
    const systemMessage = `${baseSystemMessage}\n\n${CORPORATE_POLICY_PROMPT_GUIDELINES}`;

    // If Anthropic Claude API key is configured, execute LLM call
    if (this.apiKey) {
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
            return this.finalizeLlmAnswer(cleaned, field, profile, jobContext, choiceOptions);
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
    const systemMessage = `You answer job application questions. Return a JSON object with an answers array of direct answer strings, one answer per question, in order. Example: {"answers":["answer 1","answer 2"]}. NEVER return markdown or explanatory text.

PROFILE DATA RULE: The Candidate Profile section below contains factual data about the candidate. For any question whose answer exists in the profile (gender, race, ethnicity, veteran status, disability status, salary, education, experience, location, authorization), use the EXACT value from the profile. Never answer "No" or "N/A" for demographic fields — the candidate has already provided these values.

EEOC RULE: For gender, race/ethnicity, veteran status, and disability status fields: find the value in the Candidate Profile and return it. These are always present. Do not guess or default to "No". If the candidate's gender, race/ethnicity, veteran status, or disability status is NOT present in the Candidate Profile section, return exactly: "Decline to self-identify" for that field. Never return "No" for an EEOC demographic field.

CREATIVE RULE: For open-ended behavioral/experience questions ("Have you worked with...", "Tell us about a time...", "Describe a project...") or company motivation questions ("Why choose our company...", "Why are you interested in this role?"): write a concise single paragraph (approximately 50 to 80 words) following the STAR methodology (Situation, Task, Action, and Result) without explicit section headings or bullet labels. Write in a confident, professional first-person voice ("I led...", "In my role at..."). Ground every detail strictly in the candidate's actual work experience, verified project names, and tools from their profile/resume. Do not say the resume does not contain information — synthesize a truthful answer.

OPTION RULE: For select/radio/checkbox fields with complete options provided, return exactly one provided option. For a select marked with incomplete options, do not constrain the answer to the partial sample; return a concise exact choice supported by candidate data, or NONE if unsupported.

US LOCATION RULE: If asked whether the candidate is currently located in the US, and the profile shows state_of_residence or zip_or_country containing a US state or "United States", answer Yes.

${CORPORATE_POLICY_PROMPT_GUIDELINES}`;

    if (!this.apiKey) {
      throw new Error('No LLM provider credentials configured.');
    }

    let raw = '';
    let stopReason = '';
    let batchUsage: BatchSynthesizeResult['usage'] = undefined;
    const requestStartedAt = Date.now();
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
          `batch_size=${questions.length} response_chars=${raw.length} stop_reason=${stopReason || 'unknown'} elapsed_ms=${Date.now() - requestStartedAt} ` +
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
Return ONLY a JSON object with an "answers" array of strings in the same order as the questions. Do not include markdown or explanations.

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
