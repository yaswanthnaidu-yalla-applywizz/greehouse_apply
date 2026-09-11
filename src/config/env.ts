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

  /** Base URL or full endpoint for ApplyWizz candidate details API */
  APPLYWIZZ_API_URL: z.string().default('https://www.apply-wizz.me/api/get-client-details?applywizz_id='),

  /** Selected LLM provider for synthesis */
  LLM_PROVIDER: z.enum(['openrouter', 'gemini', 'openai', 'ollama']).default('ollama'),

  /** Ollama Base URL */
  OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434/v1'),

  /** Ollama Model ID */
  OLLAMA_MODEL: z.string().default('llama3.1:latest'),

  /** OpenRouter API key */
  OPENROUTER_API_KEY: z.string().optional(),

  /** OpenRouter Model ID */
  OPENROUTER_MODEL: z.string().default('google/gemma-4-26b-a4b-it:free'),

  /** Generic LLM API key fallback */
  LLM_API_KEY: z.string().optional(),

  /** Google Gemini API key */
  GEMINI_API_KEY: z.string().optional(),

  /** OpenAI API key */
  OPENAI_API_KEY: z.string().optional(),

  /** Navigation and interaction timeout in milliseconds for Playwright */
  PLAYWRIGHT_TIMEOUT: z.coerce.number().int().positive().default(30000),

  /** Maximum parallel Playwright browser instances / pages */
  WORKER_POOL_SIZE: z.coerce.number().int().min(1).max(10).default(3),

  /** Flag indicating deployment on Railway free-tier (caps memory, disables headful) */
  RAILWAY_ENV: z.coerce.boolean().default(false),

  /** JWT Secret for backend session verification */
  JWT_SECRET: z.string().default('greenhouse-automation-jwt-secret-key'),

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

  /** Maximum question/field count allowed for active candidate queue insertion (default: 23, i.e., < 23 questions) */
  MAX_JOB_QUESTIONS: z.coerce.number().int().positive().default(23),

  /** Supabase Project URL */
  SUPABASE_URL: z.string().optional(),

  /** Supabase Service Role Secret Key */
  SUPABASE_SERVICE_KEY: z.string().optional(),

  /** Supabase anon key (browser Realtime only; safe to expose to authenticated dashboard clients) */
  SUPABASE_ANON_KEY: z.string().optional(),

  /** Supabase Storage bucket for candidate resumes */
  SUPABASE_STORAGE_BUCKET_RESUMES: z.string().default('resumes'),

  /** Supabase Storage bucket for application confirmation proof screenshots */
  SUPABASE_STORAGE_BUCKET_PROOFS: z.string().default('proofs_web'),

  /** Zoho Mail Reader Connector URL */
  ZOHO_CONNECTOR_URL: z.string().default('https://zoho-mail-reader.onrender.com/'),

  /** Zoho Mail Reader Login Username / Email */
  ZOHO_CONNECTOR_USER: z.string().optional(),

  /** Zoho Mail Reader Login Password */
  ZOHO_CONNECTOR_PASS: z.string().optional(),

  /** Zoho Mail Reader timeout in milliseconds (default: 120000) */
  ZOHO_CONNECTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),

  /** Zoho Mail Reader polling interval in milliseconds (default: 5000) */
  ZOHO_CONNECTOR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  /** Azure Communication / Microsoft 365 Client ID */
  AZURE_CLIENT_ID: z.string().optional(),

  /** Azure Communication / Microsoft 365 Client Secret */
  AZURE_CLIENT_SECRET: z.string().optional(),

  /** Azure Communication / Microsoft 365 Tenant ID */
  AZURE_TENANT_ID: z.string().optional(),

  /** Microsoft 365 Tenant ID alias */
  MS365_TENANT_ID: z.string().optional(),

  /** Azure / M365 Verified Sender Email */
  AZURE_SENDER_EMAIL: z.string().optional(),

  /** Azure Communication Services Endpoint (Optional) */
  AZURE_COMMUNICATION_ENDPOINT: z.string().optional(),

  /** ApplyWizz CA Management authorized emails API endpoint */
  AUTHORIZED_EMAILS_API: z.string().default('https://applywizz-ca-management.vercel.app/api/ca/emails'),

  /** ApplyWizz CA Management work-history API endpoint (must include /api/ca/work-history) */
  WORK_HISTORY_API_URL: z
    .string()
    .default('https://applywizz-ca-management.vercel.app/api/ca/work-history'),

  /** Additional comma-separated list of emails permitted to sign up */
  ALLOWED_SIGNUP_EMAILS: z.string().default('yaswanthnaiduyalla@applywizz.ai'),

  /** ApplyWizz S3 Bucket Base URL for master resumes */
  APPLYWIZZ_S3_BASE_URL: z.string().default('https://applywizz-prod.s3.us-east-2.amazonaws.com'),

  /** OpenRouter API Base URL */
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),

  /** OpenRouter HTTP-Referer header for app attribution */
  OPENROUTER_HTTP_REFERER: z.string().default('https://apply-wizz.me'),

  /** Microsoft Entra ID Login Base URL */
  MS_LOGIN_BASE_URL: z.string().default('https://login.microsoftonline.com'),

  /** Microsoft Graph API Base URL */
  MS_GRAPH_BASE_URL: z.string().default('https://graph.microsoft.com'),
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
  if (env.LLM_PROVIDER === 'ollama') {
    return 'ollama';
  }
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
  /** Active Azure / Microsoft 365 Tenant ID */
  ACTIVE_AZURE_TENANT_ID: (rawEnv.AZURE_TENANT_ID || rawEnv.MS365_TENANT_ID || '').trim(),
} as const;

/**
 * TypeScript type representing the validated application configuration.
 */
export type AppConfig = typeof config;

export default config;
