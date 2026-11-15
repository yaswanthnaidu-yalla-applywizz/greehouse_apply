/**
 * @fileoverview Native Google Gemini Tier 5 Synthesis Provider.
 * Direct Google Generative Language API integration using GEMINI_API_KEY.
 * Primary model: gemini-3.5-flash-lite (fast, concise Haiku equivalent)
 * Escalation model: gemini-3-flash-preview (deep reasoning Sonnet equivalent)
 * Fallback model: gemini-3.5-flash (on 503 high demand)
 */

import { config } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Gemini Provider');

export interface GeminiCallResult {
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
}

export interface GeminiCallOptions {
  prompt: string;
  systemMessage: string;
  maxTokens?: number;
  modelName?: string;
  apiKey?: string;
  temperature?: number;
  timeoutMs?: number;
  responseMimeType?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes a call to Google Generative Language API with automatic 503/429 fallback and retry.
 */
export async function callGemini(options: GeminiCallOptions): Promise<GeminiCallResult> {
  const apiKey = (options.apiKey || config.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('No GEMINI_API_KEY configured for Gemini provider.');
  }

  const primaryModel = options.modelName || config.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const fallbackModel = config.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest';
  const maxTokens = options.maxTokens ?? 2048;
  const timeoutMs = options.timeoutMs ?? (config.LLM_TIMEOUT_MS || 30000);

  const modelsToAttempt = [primaryModel];
  if (primaryModel !== fallbackModel) {
    modelsToAttempt.push(fallbackModel);
  }

  let lastError: Error | null = null;

  for (let modelIdx = 0; modelIdx < modelsToAttempt.length; modelIdx++) {
    const currentModel = modelsToAttempt[modelIdx];
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          currentModel
        )}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const requestBody = {
          contents: [
            {
              role: 'user',
              parts: [{ text: options.prompt }],
            },
          ],
          systemInstruction: {
            parts: [{ text: options.systemMessage }],
          },
          generationConfig: {
            temperature: options.temperature ?? 0.2,
            maxOutputTokens: maxTokens,
            responseMimeType: options.responseMimeType ?? 'application/json',
          },
        };

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          const data: any = await res.json();
          const candidate = data.candidates?.[0];
          const text = candidate?.content?.parts?.[0]?.text || '';
          const stopReason = candidate?.finishReason || 'STOP';
          const usageMeta = data.usageMetadata;
          const promptTokens = usageMeta?.promptTokenCount || 0;
          const completionTokens = usageMeta?.candidatesTokenCount || 0;
          const totalTokens = usageMeta?.totalTokenCount || promptTokens + completionTokens;

          return {
            text,
            stopReason,
            usage: {
              promptTokens,
              completionTokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens,
              cost: 0,
              model: currentModel,
            },
          };
        }

        const statusCode = res.status;
        const errText = await res.text();

        // 503 High Demand / Unavailable -> Retry with backoff, then switch to fallback
        if (statusCode === 503) {
          if (attempt < maxRetries) {
            const delay = (attempt + 1) * 2000;
            log.warn(
              `[Gemini Provider] Model ${currentModel} returned 503 high demand. Retrying in ${delay}ms...`
            );
            await sleep(delay);
            continue;
          }
          log.warn(
            `[Gemini Provider] Model ${currentModel} returned 503 high demand after retries. Switching to fallback.`
          );
          break;
        }

        // 429 Rate Limit -> Backoff and retry
        if (statusCode === 429 && attempt < maxRetries) {
          const delay = (attempt + 1) * 3000;
          log.warn(`[Gemini Provider] Rate limited (429). Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        throw new Error(`Gemini API returned HTTP ${statusCode}: ${errText.slice(0, 300)}`);
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          log.warn(`[Gemini Provider] Timeout on ${currentModel} after ${timeoutMs}ms.`);
          break;
        }
        if (attempt === maxRetries) {
          log.warn(`[Gemini Provider] Exhausted retries for ${currentModel}: ${err.message}`);
        }
      }
    }
  }

  throw lastError || new Error('Gemini API invocation failed across all configured models.');
}
