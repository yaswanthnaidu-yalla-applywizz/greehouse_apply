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
  /** Active LLM provider ('openrouter' | 'gemini' | 'openai') */
  provider?: 'openrouter' | 'gemini' | 'openai';
  /** LLM API Key override */
  apiKey?: string;
  /** Model name override */
  modelName?: string;
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
 * Tier 2 Answer Synthesizer invoking OpenRouter, Google Gemini, or OpenAI.
 */
export class LLMSynthesizer {
  private readonly provider: 'openrouter' | 'gemini' | 'openai';
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

    if (this.provider === 'openrouter') {
      this.modelName = options.modelName ?? config.OPENROUTER_MODEL;
      if (this.apiKey) {
        this.openaiClient = new OpenAI({
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: this.apiKey,
          defaultHeaders: {
            'HTTP-Referer': 'https://apply-wizz.me',
            'X-Title': 'Greenhouse Automation Operator',
          },
        });
      }
    } else if (this.provider === 'openai') {
      this.modelName = options.modelName ?? 'gpt-4o-mini';
      if (this.apiKey) {
        this.openaiClient = new OpenAI({ apiKey: this.apiKey });
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

    // If API key is configured, execute real LLM call
    if (this.apiKey) {
      try {
        if ((this.provider === 'openrouter' || this.provider === 'openai') && this.openaiClient) {
          const completion = await this.openaiClient.chat.completions.create({
            model: this.modelName,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 300,
          });

          const rawAnswer = completion?.choices?.[0]?.message?.content?.trim() || '';
          const finalAnswer = field.options ? alignToOption(rawAnswer, field.options) : rawAnswer;

          return {
            fieldId: field.fieldId,
            name: field.name,
            type: field.type,
            label: field.label,
            value: finalAnswer,
            source: 'ai',
            confidence: 0.9,
          };
        }

        if (this.provider === 'gemini' && this.geminiClient) {
          const model = this.geminiClient.getGenerativeModel({ model: this.modelName });
          const result = await model.generateContent(prompt);
          const rawAnswer = result.response.text().trim();
          const finalAnswer = field.options ? alignToOption(rawAnswer, field.options) : rawAnswer;

          return {
            fieldId: field.fieldId,
            name: field.name,
            type: field.type,
            label: field.label,
            value: finalAnswer,
            source: 'ai',
            confidence: 0.9,
          };
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
- Input Type: ${field.type}${optionsSection}

Instructions:
1. Provide a professional, concise, direct response written in first-person ("I am...", "My experience...").
2. If Available Options are provided above, your response MUST be EXACTLY ONE option string from that list (verbatim).
3. If this is an open-ended/textarea question, provide a 2 to 4 sentence tailored answer highlighting the candidate's strengths for ${jobContext.company}.
4. Output ONLY the raw answer text with no explanation, conversational filler, or formatting.`;
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
    if (field.options && field.options.length > 0) {
      // Default to "Yes" or first option
      const yesOpt = field.options.find((o) => /^yes/i.test(o));
      if (yesOpt) return yesOpt;
      return field.options[0];
    }

    const lowerLabel = (field.label || '').toLowerCase();

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

    return `I possess relevant professional expertise matching the requirements for ${jobContext.title} at ${jobContext.company}.`;
  }
}
