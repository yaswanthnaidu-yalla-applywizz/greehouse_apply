/**
 * @fileoverview Database operations and cost calculation for application token usage.
 * Table: `gh_application_token_usage`
 */

import { getDbClient, isSupabaseConfigured } from './client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Token Usage');

export interface ApplicationTokenUsageInput {
  applywizzId: string;
  jobUrl: string;
  role: string;
  applicationId?: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost?: number; // Direct reported cost from provider (e.g. OpenRouter usage.cost)
  metadata?: Record<string, any>;
  date?: string; // YYYY-MM-DD (defaults to current date)
}

/**
 * Calculates dollar cost for Amazon Nova 2 Lite Standard Tier as fallback.
 * Pricing (per 1,000,000 tokens):
 * - Regular Input: $0.06 ($0.00000006 per token)
 * - Cache Read: $0.015 ($0.000000015 per token)
 * - Cache Write: $0.06 ($0.00000006 per token)
 * - Completion (Output): $0.24 ($0.00000024 per token)
 */
export function calculateNovaLiteCost(usage: {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  const regularInput = Math.max(0, usage.promptTokens - usage.cacheReadTokens);
  const cost =
    (regularInput * 0.06) / 1_000_000 +
    (usage.cacheReadTokens * 0.015) / 1_000_000 +
    (usage.cacheWriteTokens * 0.06) / 1_000_000 +
    (usage.completionTokens * 0.24) / 1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Records or updates token usage for an application in `gh_application_token_usage`.
 * Uses idempotent upsert on `(applywizz_id, job_url, date)`.
 */
export async function recordApplicationTokenUsage(
  input: ApplicationTokenUsageInput
): Promise<void> {
  const today = input.date || new Date().toISOString().split('T')[0];
  const totalTokens = input.promptTokens + input.completionTokens;
  const cost =
    input.cost !== undefined
      ? input.cost
      : calculateNovaLiteCost({
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          cacheReadTokens: input.cacheReadTokens,
          cacheWriteTokens: input.cacheWriteTokens,
        });

  const record = {
    applywizz_id: input.applywizzId,
    job_url: input.jobUrl,
    role: input.role || 'Unknown',
    application_id: input.applicationId || null,
    model: input.model,
    prompt_tokens: input.promptTokens,
    completion_tokens: input.completionTokens,
    cache_read_tokens: input.cacheReadTokens,
    cache_write_tokens: input.cacheWriteTokens,
    total_tokens: totalTokens,
    token_cost: cost,
    date: today,
    metadata: input.metadata || {},
    updated_at: new Date().toISOString(),
  };

  try {
    if (!isSupabaseConfigured() && process.env.SANDBOX !== 'true') {
      log.debug(
        `[Token Usage] DB unconfigured — logged in memory: candidate=${input.applywizzId} ` +
          `role="${input.role}" total_tokens=${totalTokens} cost=$${cost.toFixed(6)}`
      );
      return;
    }

    const supabase = getDbClient();

    // Check if a record already exists for this (applywizz_id, job_url, date)
    const { data: existing, error: selectErr } = await supabase
      .from('gh_application_token_usage')
      .select('id, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, total_tokens, token_cost, metadata')
      .eq('applywizz_id', input.applywizzId)
      .eq('job_url', input.jobUrl)
      .eq('date', today)
      .maybeSingle();

    if (selectErr && !selectErr.message.includes('relation "gh_application_token_usage" does not exist')) {
      log.warn(`⚠️ Error reading token usage record: ${selectErr.message}`);
    }

    if (existing) {
      // Accumulate tokens and recalculate cost
      const newPromptTokens = (existing.prompt_tokens || 0) + input.promptTokens;
      const newCompletionTokens = (existing.completion_tokens || 0) + input.completionTokens;
      const newCacheRead = (existing.cache_read_tokens || 0) + input.cacheReadTokens;
      const newCacheWrite = (existing.cache_write_tokens || 0) + input.cacheWriteTokens;
      const newTotal = newPromptTokens + newCompletionTokens;
      const newCost =
        input.cost !== undefined
          ? (existing.token_cost || 0) + input.cost
          : calculateNovaLiteCost({
              promptTokens: newPromptTokens,
              completionTokens: newCompletionTokens,
              cacheReadTokens: newCacheRead,
              cacheWriteTokens: newCacheWrite,
            });

      const { error: updateErr } = await supabase
        .from('gh_application_token_usage')
        .update({
          prompt_tokens: newPromptTokens,
          completion_tokens: newCompletionTokens,
          cache_read_tokens: newCacheRead,
          cache_write_tokens: newCacheWrite,
          total_tokens: newTotal,
          token_cost: newCost,
          model: input.model,
          metadata: { ...existing.metadata, ...input.metadata },
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);

      if (updateErr) {
        log.warn(`⚠️ Failed to update token usage: ${updateErr.message}`);
      } else {
        log.info(
          `[Token Usage] 📊 Updated ${input.applywizzId} "${input.role}": +${totalTokens} tokens ` +
            `(${input.cacheReadTokens} cached) → total_tokens=${newTotal} total_cost=$${newCost.toFixed(6)}`
        );
      }
    } else {
      // Insert new record
      const { error: insertErr } = await supabase
        .from('gh_application_token_usage')
        .insert([record]);

      if (insertErr) {
        // Fallback gracefully if table not yet migrated
        if (insertErr.message.includes('relation "gh_application_token_usage" does not exist')) {
          log.warn('⚠️ Table gh_application_token_usage does not exist yet. Run migration 031.');
        } else {
          log.warn(`⚠️ Failed to insert token usage: ${insertErr.message}`);
        }
      } else {
        log.info(
          `[Token Usage] 📊 Recorded ${input.applywizzId} "${input.role}": tokens=${totalTokens} ` +
            `(${input.cacheReadTokens} cached) cost=$${cost.toFixed(6)}`
        );
      }
    }
  } catch (err: any) {
    log.warn(`⚠️ Exception in recordApplicationTokenUsage: ${err.message}`);
  }
}
