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
import { config } from '../config/env.js';
import type {
  ApplyWizzCandidateProfile,
  ResolvedField,
  ScannedField,
} from '../types/index.js';

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
    if (/^no|false|not authorized|requires sponsorship/i.test(auth)) {
      return 'No';
    }
    if (auth.length > 0 && !/^yes$/i.test(auth)) {
      // e.g. H1B, OPT — authorized to work in US for most forms
      return 'Yes';
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
  if (!isBinaryYesNoQuestion(field) && !fieldHasChoiceOptions(field)) {
    return '';
  }

  const sponsorshipAnswer = profile.requiresSponsorship ? 'Yes' : 'No';
  const lines = [
    'Profile facts for Yes/No and choice questions (use these as ground truth):',
    `- requires_sponsorship (needs visa sponsorship now or in the future): ${sponsorshipAnswer}`,
    `- work_authorization: ${profile.workAuthorization || 'not specified'}`,
    `- For "legally authorized to work" style questions: if work_authorization indicates US work eligibility (e.g. Citizen, GC, H1B, OPT, EAD), answer Yes unless the profile explicitly says otherwise.`,
    `- For "require sponsorship" style questions: answer ${sponsorshipAnswer} based on requires_sponsorship above.`,
  ];

  const inferred = inferYesNoFromProfile(field, profile);
  if (inferred) {
    lines.push(`- Recommended answer for this question label from profile rules: ${inferred}`);
  }

  return `\n${lines.join('\n')}\n`;
}

function formatAvailableOptionsLine(options: string[]): string {
  const list = options.map((o) => `"${o}"`).join(', ');
  return `\nThe available options are: [${list}]. You MUST pick exactly one of these options verbatim — no free-text answer.\n`;
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
 * Matches synthesized text to the closest valid option from a select/radio options list.
 *
 * @param text - Raw output string from LLM.
 * @param options - Available options on the form control.
 * @returns Best matching option string.
 */
function alignToOption(text: string, options?: string[]): string {
  if (!options || options.length === 0) {
    return text.trim();
  }

  const cleanText = text.replace(/^["']|["']$/g, '').trim().toLowerCase();

  // 1. Exact match
  for (const opt of options) {
    if (opt.toLowerCase().trim() === cleanText) {
      return opt;
    }
  }

  // 2. Substring / contains match
  for (const opt of options) {
    const optLower = opt.toLowerCase().trim();
    if (optLower.includes(cleanText) || cleanText.includes(optLower)) {
      return opt;
    }
  }

  // 3. Boolean fallback
  if (cleanText.includes('yes') || cleanText === 'true') {
    const yesOpt = options.find((o) => /^yes/i.test(o.trim()) || o.trim() === '1');
    if (yesOpt) return yesOpt;
  }
  if (cleanText.includes('no') || cleanText === 'false') {
    const noOpt = options.find((o) => /^no/i.test(o.trim()) || o.trim() === '0');
    if (noOpt) return noOpt;
  }

  // 4. Default to first option
  return options[0];
}

/**
 * Applies strict Yes/No coercion and option alignment for binary questions.
 */
function finalizeBinaryAnswer(rawAnswer: string, field: ScannedField): string {
  const coerced = coerceBinaryYesNo(rawAnswer, field);
  const options = getEffectiveFieldOptions(field);
  return options ? alignToOption(coerced, options) : coerced;
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
      const aligned = choiceOptions ? alignToOption(profileYesNo, choiceOptions) : profileYesNo;
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: aligned,
        source: 'ai',
        resolvedByTier: 5,
        confidence: 0.95,
      };
    }

    const prompt = this.constructPrompt(field, profile, resumeText, jobContext, resumeFacts);
    const systemMessage = isBinary
      ? 'You are an automated job application assistant. CRITICAL: This is a Yes/No question. You MUST reply with ONLY the word "Yes" or "No" (or the exact Yes/No option string from the available options list). Absolutely NO additional words, explanations, location names, or prose.'
      : isChoiceField
        ? 'You are an automated job application assistant. The user message lists available options. You MUST reply with exactly one option string from that list, copied verbatim. No free-text answers, no reasoning, no preamble.'
        : 'You are an automated job application assistant. You must output ONLY the direct answer text. Absolutely NO reasoning, NO thinking process, NO prefixes like "Here is a thinking process", and NO preamble.';

    // If API key is configured or provider is ollama, execute real LLM call
    if (this.apiKey || this.provider === 'ollama') {
      try {
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

              const content = completion?.choices?.[0]?.message?.content?.trim();
              const cleaned = cleanLLMOutput(content || '');
              if (cleaned && cleaned.length > 0) {
                rawAnswer = cleaned;
                break;
              }

            } catch (modelErr: any) {
              console.warn(`[LLM Synthesizer] ⚠️ Model "${modelId}" error (${modelErr.status || modelErr.message}). Trying fallback...`);
            }
          }

          if (rawAnswer && rawAnswer.length > 0) {
            let finalAnswer = isBinary
              ? finalizeBinaryAnswer(rawAnswer, field)
              : choiceOptions
                ? alignToOption(rawAnswer, choiceOptions)
                : rawAnswer;
            if (/linkedin|website|portfolio|github|\burl\b|blog|personal site/i.test(`${field.label} ${field.name} ${field.fieldId}`)) {
              if (!/^https?:\/\//i.test(finalAnswer) && !/linkedin\.com|github\.com/i.test(finalAnswer)) {
                finalAnswer = this.generateFallbackAnswer(field, profile, jobContext);
              }
            }
            return {
              fieldId: field.fieldId,
              name: field.name,
              type: field.type,
              label: field.label,
              value: finalAnswer,
              source: 'ai',
              resolvedByTier: 5,
              confidence: 0.9,
            };
          }
        }

        if (this.provider === 'gemini' && this.geminiClient) {
          const model = this.geminiClient.getGenerativeModel({ model: this.modelName });
          const result = await model.generateContent(prompt);
          const content = result.response.text().trim();
          const cleaned = cleanLLMOutput(content);
          if (cleaned && cleaned.length > 0) {
            let finalAnswer = isBinary
              ? finalizeBinaryAnswer(cleaned, field)
              : choiceOptions
                ? alignToOption(cleaned, choiceOptions)
                : cleaned;
            if (/linkedin|website|portfolio|github|\burl\b|blog|personal site/i.test(`${field.label} ${field.name} ${field.fieldId}`)) {
              if (!/^https?:\/\//i.test(finalAnswer) && !/linkedin\.com|github\.com/i.test(finalAnswer)) {
                finalAnswer = this.generateFallbackAnswer(field, profile, jobContext);
              }
            }
            return {
              fieldId: field.fieldId,
              name: field.name,
              type: field.type,
              label: field.label,
              value: finalAnswer,
              source: 'ai',
              resolvedByTier: 5,
              confidence: 0.9,
            };
          }
        }
      } catch (err: any) {
        console.warn(`[LLM Synthesizer] ⚠️ LLM inference error for "${field.label}": ${err.message}. Falling back to heuristic answer.`);
      }
    }

    // Heuristic fallback for development when LLM key is absent or network fails
    const fallbackAnswer = this.generateFallbackAnswer(field, profile, jobContext);

    return {
      fieldId: field.fieldId,
      name: field.name,
      type: field.type,
      label: field.label,
      value: fallbackAnswer,
      source: 'ai',
      resolvedByTier: 5,
      confidence: 0.8,
    };
  }

  /**
   * Resolves multiple questions in one provider request for a candidate/job pair.
   */
  public async synthesizeBatchAnswers(
    questions: BatchQuestion[],
    resumeText: string,
    jobDescription: string
  ): Promise<string[]> {
    if (questions.length === 0) return [];

    const prompt = `Resolve every numbered job application question using only the candidate resume and job description.
Return ONLY a JSON array of strings in the same order as the questions. Do not include markdown or explanations.

Candidate resume:
${resumeText.slice(0, 12000)}

Job description:
${jobDescription.slice(0, 12000)}

Questions:
${questions.map((question, index) => `${index}. [${question.type}] ${question.label}${question.value ? ` (existing value: ${question.value})` : ''}`).join('\n')}`;
    const systemMessage =
      'You answer job application questions. Return only a valid JSON array of direct answer strings, one answer per question, in order.';

    if (!(this.apiKey || this.provider === 'ollama')) {
      throw new Error('No LLM provider credentials configured.');
    }

    let raw = '';
    if ((this.provider === 'openrouter' || this.provider === 'openai' || this.provider === 'ollama') && this.openaiClient) {
      const completion = await this.openaiClient.chat.completions.create({
        model: this.modelName,
        messages: [{ role: 'system', content: systemMessage }, { role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: Math.max(300, questions.length * 100),
      });
      raw = completion?.choices?.[0]?.message?.content || '';
    } else if (this.provider === 'gemini' && this.geminiClient) {
      const model = this.geminiClient.getGenerativeModel({ model: this.modelName });
      const result = await model.generateContent(`${systemMessage}\n\n${prompt}`);
      raw = result.response.text();
    } else {
      throw new Error(`LLM provider ${this.provider} is unavailable.`);
    }

    const parsed: unknown = JSON.parse(cleanLLMOutput(raw));
    if (!Array.isArray(parsed) || parsed.length !== questions.length || parsed.some((answer) => typeof answer !== 'string')) {
      throw new Error('Batch LLM response did not contain one string answer per question.');
    }
    return parsed.map((answer) => cleanLLMOutput(answer));
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

    const profileDecisionBlock = buildProfileDecisionContext(field, profile);

    const binaryRule = isBinaryYesNoQuestion(field)
      ? `\nCRITICAL: This is a Yes/No question. You MUST reply with ONLY the word "Yes" or "No" (or the exact matching option from the available options list). Absolutely NO additional words, explanations, location names, or prose.`
      : '';

    const instructions = isBinaryYesNoQuestion(field)
      ? `Instructions:
1. Use the Profile facts section and requires_sponsorship / work_authorization to decide Yes vs No.
2. Reply with ONLY "Yes" or "No" — pick the single best option from the available options list if provided.
3. Do NOT include the candidate's city, state, location, or any explanatory sentences.
4. Output ONLY the raw final answer text.`
      : choiceOptions && choiceOptions.length > 0
        ? `Strict Instructions:
1. The available options are listed above — your response MUST be EXACTLY ONE of those strings, copied verbatim.
2. Do NOT invent new options or write free-text sentences.
3. Base your choice on the candidate profile, resume facts, and question label.
4. Output ONLY the raw final answer text. No reasoning or preamble.`
        : `Strict Instructions:
1. Provide a professional, concise, direct response written in first-person ("I am...", "My experience...").
2. CRITICAL GROUNDING: You MUST base your answer strictly on the candidate's verified resume facts and experience.
3. NEVER use generic placeholder names like "xyz company", "[Company]", or "my previous employer". Always cite their ACTUAL past companies, verified project names, or specific tools (e.g., Jenkins, Docker, GitHub Actions, AWS, Python) found in their resume.
4. If the candidate's resume does not mention the exact requested tool/technology, write honestly: "While my hands-on experience has primarily focused on [adjacent skill/tool from resume], I have foundational knowledge and am rapid to ramp up."
5. For open-ended/textarea questions, provide a 2 to 3 sentence concise, tailored answer.
6. Output ONLY the raw final answer text. Absolutely NO thinking process, NO "Here is a thinking process", NO markdown fences, and NO conversational filler.`;

    const resumeFactsBlock = this.buildResumeFactsBlock(resumeFacts, resumeText);

    return `You are an automated assistant helping a job candidate apply for a position.

Candidate Information:
- Full Name: ${profile.clientName}
- Current Role: ${profile.demographics?.currentRole || 'Software Engineer'}
- Years of Experience: ${profile.demographics?.yearsOfExperience || '5+ years'}
- Education: ${profile.education?.map((e) => `${e.degree} in ${e.fieldOfStudy} from ${e.institution} (${e.graduationYear})`).join(', ') || 'Degree on file'}
- Location: ${profile.location}
- Work Authorization: ${profile.workAuthorization}
- Requires Sponsorship (requires_sponsorship): ${profile.requiresSponsorship ? 'Yes' : 'No'}
${profileDecisionBlock}
${resumeFactsBlock}

Target Job:
- Position: ${jobContext.title}
- Company: ${jobContext.company}

Question to Answer:
- Question Label: "${field.label}"
- Input Type: ${field.type}${optionsSection}${binaryRule}

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
    jobContext: JobContext
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
      const answer = fromProfile ?? coerceBinaryYesNo('', field);
      const options = getEffectiveFieldOptions(field);
      return options ? alignToOption(answer, options) : answer;
    }

    const choiceOptions = getEffectiveFieldOptions(field);
    if (choiceOptions && choiceOptions.length > 0) {
      const yesOpt = choiceOptions.find((o) => /^yes/i.test(o));
      if (yesOpt) return yesOpt;
      return choiceOptions[0];
    }

    const lowerLabel = (field.label || '').toLowerCase();

    if (lowerLabel.includes('hear about') || lowerLabel.includes('source') || lowerLabel.includes('referral')) {
      return 'LinkedIn';
    }

    if (lowerLabel.includes('why') || lowerLabel.includes('interest')) {
      return `I am excited to apply for the ${jobContext.title} position at ${jobContext.company}. My extensive experience in building scalable software systems aligns well with your team's mission.`;
    }

    if (lowerLabel.includes('describe') || lowerLabel.includes('experience') || lowerLabel.includes('project')) {
      return `Throughout my career as a ${profile.demographics?.currentRole || 'Software Engineer'}, I have led end-to-end development of high-impact applications, collaborating closely with cross-functional teams to deliver robust solutions.`;
    }

    if (lowerLabel.includes('start date') || lowerLabel.includes('availability')) {
      return 'Within 2 weeks of offer acceptance';
    }

    if (lowerLabel.includes('salary') || lowerLabel.includes('compensation')) {
      return profile.demographics?.salaryRange || 'Competitive / Open to negotiation';
    }

    if (lowerLabel.includes('unique') || lowerLabel.includes('stand out')) {
      return `My depth of experience as a ${profile.demographics?.currentRole || 'Software Engineer'}, combined with my passion for problem-solving and rapid learning, allows me to contribute meaningfully from day one.`;
    }

    if (/subsidiaries|worked for|affiliate|previous employee/i.test(lowerLabel)) {
      return 'No';
    }

    if (/if other|please specify|if chose/i.test(lowerLabel)) {
      return 'N/A';
    }

    return `I possess relevant professional expertise matching the requirements for ${jobContext.title} at ${jobContext.company}.`;
  }
}
