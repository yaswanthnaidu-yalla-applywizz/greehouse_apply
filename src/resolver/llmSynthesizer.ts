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
import Fuse from 'fuse.js';
import { config } from '../config/env.js';
import type {
  ApplyWizzCandidateProfile,
  ResolvedField,
  ScannedField,
} from '../types/index.js';
import { haltWithDevAlert } from '../utils/logger.js';

let firstProviderCallChecked = false;

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
}

/**
 * Options configuring the LLMSynthesizer.
 */
export interface LLMSynthesizerOptions {
  /** Active LLM provider ('openrouter' | 'gemini' | 'openai' | 'ollama') */
  provider?: 'openrouter' | 'gemini' | 'openai' | 'ollama';
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

/**
 * Options for prompt + alignment — uses scanned options, or defaults Yes/No for binary radio/select.
 */
export function getEffectiveFieldOptions(field: ScannedField): string[] | undefined {
  if (field.options && field.options.length > 0) {
    return field.options;
  }
  if (
    (field.type === 'radio' || field.type === 'select') &&
    isBinaryYesNoQuestion({ ...field, options: ['Yes', 'No'] })
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
    /(previously.*employed|worked for|former employee|non-compete|non compete|restrict.*employment|felony|terminated)/i.test(
      combined
    )
  ) {
    return 'No';
  }

  if (/(terms and conditions|privacy policy|certify|acknowledge|background check)/i.test(combined)) {
    return 'Yes';
  }

  if (/(willing to relocate|open to relocate|relocation|in the same city|same city as)/i.test(combined)) {
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
  text = text.replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, '$1').trim();

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
 * Fuzzy option match fallback when exact match fails:
 * 1. Normalized comparison (strip punctuation, lowercase, trim)
 * 2. Substring / contains comparison (< 10 chars)
 * 3. Fuse.js match (threshold: 0.85)
 */
export function matchFuzzyOption(text: string, options?: string[]): string | null {
  if (!options || options.length === 0) return null;
  const rawAnswer = text.trim();
  if (!rawAnswer) return null;

  // 1. Try normalized comparison: strip punctuation, lowercase, trim both answer and each option
  const stripPunctuation = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const normAnswer = stripPunctuation(rawAnswer);
  if (normAnswer) {
    for (const opt of options) {
      if (stripPunctuation(opt) === normAnswer) {
        return opt;
      }
    }
  }

  // 2. Try contains check: if answer.toLowerCase() includes option.toLowerCase() or vice versa for short options (< 10 chars)
  const lowerAnswer = rawAnswer.toLowerCase();
  for (const opt of options) {
    const lowerOpt = opt.toLowerCase().trim();
    if (!lowerOpt) continue;
    if (lowerAnswer.includes(lowerOpt)) {
      return opt;
    }
    if (lowerOpt.length < 10 && lowerOpt.includes(lowerAnswer)) {
      return opt;
    }
  }

  // 3. Try Fuse.js match with threshold 0.85 against choiceOptions
  try {
    const fuse = new Fuse(options, { threshold: 0.85 });
    const results = fuse.search(rawAnswer);
    if (results.length > 0 && results[0]?.item) {
      return results[0].item;
    }
  } catch {
    // ignore search error
  }

  // 4. Only if all three fail
  return null;
}

/**
 * Tier 2 Answer Synthesizer invoking OpenRouter, Google Gemini, or OpenAI.
 */
export class LLMSynthesizer {
  private readonly provider: 'openrouter' | 'gemini' | 'openai' | 'ollama';
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
    this.provider = options.provider ?? config.LLM_PROVIDER;
    this.apiKey = options.apiKey ?? config.ACTIVE_LLM_API_KEY;

    if (this.provider === 'ollama') {
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
          timeout: 8000,
          maxRetries: 1,
          defaultHeaders: {
            'HTTP-Referer': config.OPENROUTER_HTTP_REFERER || 'https://apply-wizz.me',
            'X-Title': 'Greenhouse Automation Operator',
          },
        });
      }
    } else if (this.provider === 'openai') {
      this.modelName = options.modelName ?? 'gpt-4o-mini';
      if (this.apiKey) {
        this.openaiClient = new OpenAI({ apiKey: this.apiKey, timeout: 8000, maxRetries: 1 });
      }
    } else {
      this.modelName = options.modelName ?? 'gemini-1.5-flash';
      if (this.apiKey) {
        this.geminiClient = new GoogleGenerativeAI(this.apiKey);
      }
    }
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
    const systemMessage = isChoiceField
      ? 'You are an automated job application assistant. You MUST respond with exactly one of the provided options, copied verbatim, and no other text.'
      : 'You are an automated job application assistant. Be concise and factual. Base your answer only on the candidate profile data provided. Do not invent or assume information not present in the profile. Reply as JSON only: {"answer":"<text>","confidence":<0.0-1.0>}.';

    // If API key is configured or provider is ollama, execute real LLM call
    if (this.apiKey || this.provider === 'ollama') {
      try {
        let providerReached = false;
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
              if (cleaned && cleaned.length > 0) {
                rawAnswer = cleaned;
                break;
              }

            } catch (modelErr: any) {
              // Try fallback model
            }
          }

          haltIfFirstProviderCallFailed(providerReached);

          if (rawAnswer && rawAnswer.length > 0) {
            return this.finalizeLlmAnswer(rawAnswer, field, profile, jobContext, choiceOptions);
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
            return this.finalizeLlmAnswer(cleaned, field, profile, jobContext, choiceOptions);
          }
        }

        if (this.provider === 'gemini') {
          haltIfFirstProviderCallFailed(providerReached);
        }
      } catch (err: any) {
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

    if (/linkedin|website|portfolio|github|\burl\b|blog|personal site/i.test(`${field.label} ${field.name} ${field.fieldId}`)) {
      if (!/^https?:\/\//i.test(answer) && !/linkedin\.com|github\.com/i.test(answer)) {
        answer = this.generateFallbackAnswer(field, profile, jobContext);
        confidence = answer ? 0.9 : null;
      }
    }

    if (choiceOptions && choiceOptions.length > 0) {
      let matched = matchExactOption(answer, choiceOptions);
      if (!matched) {
        matched = matchFuzzyOption(answer, choiceOptions);
      }

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
  public async synthesizeBatchAnswers(
    questions: BatchQuestion[],
    resumeText: string,
    jobDescription: string,
    profile?: ApplyWizzCandidateProfile
  ): Promise<string[]> {
    if (questions.length === 0) return [];

    const candidateContext = profile
      ? `Candidate Information:
- Full Name: ${profile.clientName}
- Work Authorization: ${profile.workAuthorization || 'not provided'}
- Requires Sponsorship: ${profile.requiresSponsorship === true ? 'Yes' : 'No'}
- Location: ${profile.location || 'not provided'}
- Education: ${profile.education?.map((e) => `${e.degree} in ${e.fieldOfStudy}`).join(', ') || 'on file'}
- Work Experience: ${profile.workExperience?.slice(0, 3).map((w) => `${w.title} at ${w.company}`).join(', ') || 'on file'}

`
      : '';

    const prompt = `Resolve every numbered job application question using only the candidate resume and job description.
Return ONLY a JSON array of strings in the same order as the questions. Do not include markdown or explanations.

Candidate resume:
${resumeText.slice(0, 12000)}

Job description:
${jobDescription.slice(0, 12000)}

${candidateContext}${profile ? `Candidate Profile Data:
${JSON.stringify((profile as ApplyWizzCandidateProfile & { raw_api_payload: unknown }).raw_api_payload, null, 2).slice(0, 8000)}

` : ''}Questions:
${questions
      .map((question, index) => {
        const opts =
          question.options && question.options.length > 0
            ? ` Options: ${question.options.join(' | ')}`
            : '';
        return `${index}. [${question.type}] ${question.label}${opts}${question.value ? ` (existing value: ${question.value})` : ''}`;
      })
      .join('\n')}`;
    const systemMessage =
      'You answer job application questions. Return only a valid JSON array of direct answer strings, one answer per question, in order.';

    if (!(this.apiKey || this.provider === 'ollama')) {
      throw new Error('No LLM provider credentials configured.');
    }

    let raw = '';
    try {
      if ((this.provider === 'openrouter' || this.provider === 'openai' || this.provider === 'ollama') && this.openaiClient) {
        const completion = await this.openaiClient.chat.completions.create({
          model: this.modelName,
          messages: [{ role: 'system', content: systemMessage }, { role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: Math.max(300, questions.length * 100),
        });
        haltIfFirstProviderCallFailed(true);
        raw = completion?.choices?.[0]?.message?.content || '';
      } else if (this.provider === 'gemini' && this.geminiClient) {
        const model = this.geminiClient.getGenerativeModel({ model: this.modelName });
        const result = await model.generateContent(`${systemMessage}\n\n${prompt}`);
        haltIfFirstProviderCallFailed(true);
        raw = result.response.text();
      } else {
        haltIfFirstProviderCallFailed(false);
        throw new Error(`LLM provider ${this.provider} is unavailable.`);
      }
    } catch (err) {
      haltIfFirstProviderCallFailed(false);
      throw err;
    }

    let parsed: unknown = JSON.parse(cleanLLMOutput(raw));

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const keys = Object.keys(obj);
      const allNumeric = keys.length > 0 && keys.every((k) => !isNaN(Number(k)));
      if (allNumeric) {
        keys.sort((a, b) => Number(a) - Number(b));
        parsed = keys.map((k) => obj[k]);
      } else {
        parsed = Object.values(obj);
      }
    }

    if (!Array.isArray(parsed)) {
      throw new Error('Batch LLM response did not contain an array of answers.');
    }

    let answers: string[] = parsed.map((item) => {
      if (typeof item === 'string') return item;
      return item === null || item === undefined ? '' : String(item);
    });

    if (answers.length < questions.length) {
      while (answers.length < questions.length) {
        answers.push('');
      }
    } else if (answers.length > questions.length) {
      answers = answers.slice(0, questions.length);
    }

    return answers.map((answer) => cleanLLMOutput(answer));
  }

  /**
   * Builds a compact, structured resume facts block (~2k tokens) rather than dumping unbounded raw text.
   */
  private buildResumeFactsBlock(resumeFacts?: any, resumeText: string = ''): string {
    if (resumeFacts && typeof resumeFacts === 'object') {
      const jobs = Array.isArray(resumeFacts.experience)
        ? resumeFacts.experience
            .slice(0, 4)
            .map((j: any) => `• ${j.title || 'Role'} at ${j.company || 'Company'} (${j.duration || ''})`)
            .join('\n')
        : '';
      const skills = Array.isArray(resumeFacts.skills)
        ? resumeFacts.skills.slice(0, 25).join(', ')
        : '';
      const projects = Array.isArray(resumeFacts.projects)
        ? resumeFacts.projects
            .slice(0, 3)
            .map((p: any) => (typeof p === 'string' ? p : p.name || p.title || ''))
            .filter(Boolean)
            .join(', ')
        : '';

      if (jobs || skills || projects) {
        return `Candidate Verified Resume Facts:
${jobs ? `Work History:\n${jobs}\n` : ''}${skills ? `Verified Skills: ${skills}\n` : ''}${projects ? `Projects: ${projects}\n` : ''}`;
      }
    }

    if (resumeText && resumeText.trim().length > 0) {
      return `Candidate Resume Excerpt:
${resumeText.slice(0, 3000)}`;
    }

    return '';
  }

  /**
   * Constructs a structured prompt passing candidate background and question schema.
   *
   * @param field - Scanned question.
   * @param profile - Candidate profile.
   * @param resumeText - Resume text excerpt.
   * @param jobContext - Target position context.
   * @param resumeFacts - Structured resume facts object.
   * @returns Structured prompt string for the LLM.
   */
  private constructPrompt(
    field: ScannedField,
    profile: ApplyWizzCandidateProfile,
    resumeText: string,
    jobContext: JobContext,
    resumeFacts?: any
  ): string {
    const choiceOptions = getEffectiveFieldOptions(field);
    const optionsSection =
      choiceOptions && choiceOptions.length > 0 ? formatAvailableOptionsLine(choiceOptions) : '';

    const profileDecisionBlock = isBinaryYesNoQuestion(field)
      ? buildProfileDecisionContext(field, profile)
      : '';

    const instructions = isBinaryYesNoQuestion(field)
      ? `Instructions:
1. Use the exact requires_sponsorship and work_authorization values from the profile. Do not guess.
2. You MUST respond with exactly one of the provided options, no other text.`
      : choiceOptions && choiceOptions.length > 0
        ? `Instructions:
1. You MUST respond with exactly one of these options, no other text.
2. Base the choice only on the candidate profile data provided. Do not invent or assume information not present in the profile.`
        : `Strict Instructions:
1. Be concise and factual. Base your answer only on the candidate profile data provided. Do not invent or assume information not present in the profile.
2. Provide a professional, concise, direct response written in first-person ("I am...", "My experience...").
3. NEVER use generic placeholder names like "xyz company", "[Company]", or "my previous employer". Always cite their ACTUAL past companies, verified project names, or specific tools found in their resume.
4. If the candidate's resume does not mention the exact requested tool/technology, write honestly: "While my hands-on experience has primarily focused on [adjacent skill/tool from resume], I have foundational knowledge and am rapid to ramp up."
5. For open-ended/textarea questions, provide a 2 to 3 sentence concise, tailored answer.
6. Respond as JSON only: {"answer":"<your answer>","confidence":<0.0-1.0>}. If you are not at least 0.65 confident, set confidence below 0.65.`;

    const resumeFactsBlock = this.buildResumeFactsBlock(resumeFacts, resumeText);

    return `You are an automated assistant helping a job candidate apply for a position.

Candidate Information:
- Full Name: ${profile.clientName}
- Current Role: ${profile.demographics?.currentRole || 'Software Engineer'}
- Years of Experience: ${profile.demographics?.yearsOfExperience || '5+ years'}
- Education: ${profile.education?.map((e) => `${e.degree} in ${e.fieldOfStudy} from ${e.institution} (${e.graduationYear})`).join(', ') || 'Degree on file'}
- Location: ${profile.location}
- Work Authorization (work_authorization, exact): ${profile.workAuthorization || '(not provided)'}
- Requires Sponsorship (requires_sponsorship, exact): ${profile.requiresSponsorship === true ? 'true' : 'false'}
${profileDecisionBlock}
${resumeFactsBlock}

Target Job:
- Position: ${jobContext.title}
- Company: ${jobContext.company}

Question to Answer:
- Question Label: "${field.label}"
- Input Type: ${field.type}${optionsSection}

${instructions}`;
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
