/**
 * @fileoverview Native Local Ollama Tier 5 Synthesis Provider.
 * Connects directly to local Ollama daemon (http://localhost:11434).
 * - Haiku role: llama3.1:latest
 * - Sonnet role: qwen3:latest
 * Zero API costs, zero rate limits.
 */

import { config } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Ollama Provider');

export interface OllamaCallResult {
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

export interface OllamaCallOptions {
  prompt: string;
  systemMessage: string;
  modelName?: string;
  endpoint?: string;
  temperature?: number;
  timeoutMs?: number;
  format?: 'json';
}

export async function callOllama(options: OllamaCallOptions): Promise<OllamaCallResult> {
  const endpoint = (options.endpoint || process.env.OLLAMA_ENDPOINT || 'http://localhost:11434').replace(/\/$/, '');
  const model = options.modelName || process.env.OLLAMA_MODEL || 'llama3.1:latest';
  const timeoutMs = options.timeoutMs ?? (config.LLM_TIMEOUT_MS ? Math.max(config.LLM_TIMEOUT_MS, 60000) : 60000);

  const requestBody = {
    model,
    system: options.systemMessage,
    prompt: options.prompt,
    format: options.format ?? 'json',
    stream: false,
    options: {
      temperature: options.temperature ?? 0.2,
    },
  };

  try {
    const res = await fetch(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama returned HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data: any = await res.json();
    const text = data.response || '';
    const promptTokens = data.prompt_eval_count || 0;
    const completionTokens = data.eval_count || 0;

    return {
      text,
      stopReason: 'stop',
      usage: {
        promptTokens,
        completionTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: promptTokens + completionTokens,
        cost: 0,
        model,
      },
    };
  } catch (err: any) {
    log.warn(`[Ollama Provider] Request to ${model} failed: ${err.message}`);
    throw err;
  }
}
