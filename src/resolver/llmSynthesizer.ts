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
export function isBinaryYesNoQuestion(field: ScannedField): boolean {
  const label = field.label || '';
  const combined = `${label} ${field.name || ''} ${field.fieldId || ''}`;

  if (field.options && field.options.length > 0) {
    const normOpts = field.options.map((o) => o.toLowerCase().trim());
    const hasYes = normOpts.some((o) => o === 'yes' || /^yes\b/i.test(o));
    const hasNo = normOpts.some((o) => o === 'no' || /^no\b/i.test(o));
    if (hasYes && hasNo) return true;
  }

  return (
    /^(are|is|do|does|did|will|would|can|could|have|has|had)\b/i.test(label.trim()) ||
    /(willing to|able to|authorized to|eligible to|in the same city)/i.test(combined)
  );
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
  return field.options ? alignToOption(coerced, field.options) : coerced;
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
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: this.apiKey,
          timeout: 8000,
          maxRetries: 1,
          defaultHeaders: {
            'HTTP-Referer': 'https://apply-wizz.me',
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
    jobContext: JobContext = { title: 'Software Engineer', company: 'Company' }
  ): Promise<ResolvedField> {
    const prompt = this.constructPrompt(field, profile, resumeText, jobContext);
    const isBinary = isBinaryYesNoQuestion(field);
    const systemMessage = isBinary
      ? 'You are an automated job application assistant. CRITICAL: This is a Yes/No question. You MUST reply with ONLY the word "Yes" or "No". Absolutely NO additional words, explanations, location names, or prose.'
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
                  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
                  'inclusionai/ling-3.0-flash-fin:free',
                  'nvidia/nemotron-3.5-lightning:free',
                  'poolside/laguna-s-2.1:free',
                  'google/gemma-4-26b-a4b-it:free',
                  'google/gemma-4-31b-it:free',
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
              : field.options
                ? alignToOption(rawAnswer, field.options)
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
              : field.options
                ? alignToOption(cleaned, field.options)
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
   * Constructs a structured prompt passing candidate background and question schema.
   *
   * @param field - Scanned question.
   * @param profile - Candidate profile.
   * @param resumeText - Resume text excerpt.
   * @param jobContext - Target position context.
   * @returns Structured prompt string for the LLM.
   */
  private constructPrompt(
    field: ScannedField,
    profile: ApplyWizzCandidateProfile,
    resumeText: string,
    jobContext: JobContext
  ): string {
    const optionsSection = field.options && field.options.length > 0
      ? `\nAvailable Options (Select EXACTLY ONE):\n${field.options.map((o, idx) => `  ${idx + 1}. "${o}"`).join('\n')}`
      : '';

    const binaryRule = isBinaryYesNoQuestion(field)
      ? `\nCRITICAL: This is a Yes/No question. You MUST reply with ONLY the word "Yes" or "No". Absolutely NO additional words, explanations, location names, or prose.`
      : '';

    const instructions = isBinaryYesNoQuestion(field)
      ? `Instructions:
1. Reply with ONLY "Yes" or "No" — pick the single best option from Available Options if provided.
2. Do NOT include the candidate's city, state, location, or any explanatory sentences.
3. Output ONLY the raw final answer text.`
      : `Instructions:
1. Provide a professional, concise, direct response written in first-person ("I am...", "My experience...").
2. If Available Options are provided above, your response MUST be EXACTLY ONE option string from that list (verbatim).
3. If this is an open-ended/textarea question, provide a 2 to 4 sentence tailored answer highlighting the candidate's strengths for ${jobContext.company}.
4. Output ONLY the raw final answer text. Absolutely NO thinking process, NO "Here is a thinking process", NO breakdown, and NO conversational filler.`;

    return `You are an automated assistant helping a job candidate apply for a position.

Candidate Information:
- Full Name: ${profile.clientName}
- Current Role: ${profile.demographics?.currentRole || 'Software Engineer'}
- Years of Experience: ${profile.demographics?.yearsOfExperience || '5+ years'}
- Education: ${profile.education?.map((e) => `${e.degree} in ${e.fieldOfStudy} from ${e.institution} (${e.graduationYear})`).join(', ') || 'Degree on file'}
- Location: ${profile.location}
- Work Authorization: ${profile.workAuthorization} (Requires Sponsorship: ${profile.requiresSponsorship ? 'Yes' : 'No'})

Resume Excerpt:
${resumeText ? resumeText.slice(0, 2000) : 'Standard software engineering profile with strong background in backend and frontend systems.'}

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
      const answer = coerceBinaryYesNo('', field);
      return field.options ? alignToOption(answer, field.options) : answer;
    }

    if (field.options && field.options.length > 0) {
      // Default to "Yes" or first option
      const yesOpt = field.options.find((o) => /^yes/i.test(o));
      if (yesOpt) return yesOpt;
      return field.options[0];
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
