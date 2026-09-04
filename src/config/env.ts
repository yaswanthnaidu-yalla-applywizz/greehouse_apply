/**
 * @fileoverview Environment configuration loader and validator for Greenhouse Job Application Automation (V1).
 *
 * Loads environment variables from `.env` using dotenv and validates types and defaults
 * using Zod. Throws an explicit error if required configurations are invalid.
 */

import dotenv from 'dotenv';
import { z } from 'zod';

// Load variables from .env file into process.env
dotenv.config();

/**
 * Zod schema defining required and optional environment variables with strict validation rules.
 */
const envSchema = z.object({
  /** HTTP server port for Express REST API */
  PORT: z.coerce.number().int().positive().default(3000),

  /** Runtime environment */
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** Base URL for ApplyWizz candidate details API */
  APPLYWIZZ_API_URL: z.string().url().default('https://www.apply-wizz.me/api'),

  /** Selected LLM provider for synthesis */
  LLM_PROVIDER: z.enum(['openrouter', 'gemini', 'openai']).default('openrouter'),

  /** OpenRouter API key */
  OPENROUTER_API_KEY: z.string().optional(),

  /** OpenRouter Model ID */
  OPENROUTER_MODEL: z.string().default('nvidia/nemotron-3-ultra-550b-a55b:free'),

  /** Generic LLM API key fallback */
  LLM_API_KEY: z.string().optional(),

  /** Google Gemini API key */
  GEMINI_API_KEY: z.string().optional(),

  /** OpenAI API key */
  OPENAI_API_KEY: z.string().optional(),

  /** Navigation and interaction timeout in milliseconds for Playwright */
  PLAYWRIGHT_TIMEOUT: z.coerce.number().int().positive().default(30000),

  /** Maximum parallel Playwright browser instances / pages */
  WORKER_POOL_SIZE: z.coerce.number().int().min(1).max(10).default(4),

  /** Minimum jitter delay in milliseconds between consecutive browser requests */
  SCANNER_JITTER_MIN_MS: z.coerce.number().int().nonnegative().default(3000),

  /** Maximum jitter delay in milliseconds between consecutive browser requests */
  SCANNER_JITTER_MAX_MS: z.coerce.number().int().nonnegative().default(6000),

  /** Filesystem path to the input jobs CSV */
  INPUT_CSV_PATH: z.string().default('./greenhouse_only_applywizz_prod(in).csv'),

  /** Output directory for intermediate JSON and CSV artifacts */
  OUTPUT_DIR: z.string().default('./output'),

  /** Local directory for cached candidate master PDF resumes */
  RESUMES_DIR: z.string().default('./resumes'),
});

/**
 * Parses and validates environment variables.
 */
const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
  const errorDetails = JSON.stringify(parseResult.error.format(), null, 2);
  console.error('❌ Environment configuration validation failed:\n', errorDetails);
  throw new Error(`Invalid environment configuration: ${errorDetails}`);
}

const rawEnv = parseResult.data;

/**
 * Resolves the active LLM API key based on the configured LLM_PROVIDER and available keys.
 *
 * @param env - Parsed environment data
 * @returns The active LLM API key string, or empty string if not configured
 */
function resolveLlmApiKey(env: typeof rawEnv): string {
  if (env.LLM_API_KEY && env.LLM_API_KEY.trim().length > 0) {
    return env.LLM_API_KEY.trim();
  }
  if (env.LLM_PROVIDER === 'openrouter' && env.OPENROUTER_API_KEY) {
    return env.OPENROUTER_API_KEY.trim();
  }
  if (env.LLM_PROVIDER === 'gemini' && env.GEMINI_API_KEY) {
    return env.GEMINI_API_KEY.trim();
  }
  if (env.LLM_PROVIDER === 'openai' && env.OPENAI_API_KEY) {
    return env.OPENAI_API_KEY.trim();
  }
  // Auto-fallback: check if any key exists
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY.trim();
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY.trim();
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY.trim();
  return '';
}

/**
 * Strongly-typed application configuration object.
 */
export const config = {
  ...rawEnv,
  /** Active LLM API key resolved from LLM_API_KEY or provider-specific keys */
  ACTIVE_LLM_API_KEY: resolveLlmApiKey(rawEnv),
} as const;

/**
 * TypeScript type representing the validated application configuration.
 */
export type AppConfig = typeof config;

export default config;
