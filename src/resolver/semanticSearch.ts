/**
 * @fileoverview Semantic vector search and embeddings for candidate QA bank.
 */

import axios from 'axios';
import config from '../config/env.js';
import { supabase } from '../db/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Semantic');

const embeddingCache = new Map<string, number[]>();

let semanticWarnLogged = false;

/**
 * Checks whether semantic search is configured via OPENROUTER_API_KEY.
 * Emits a single startup warning when key is absent.
 */
export function isSemanticEnabled(): boolean {
  const apiKey = config.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    if (!semanticWarnLogged) {
      semanticWarnLogged = true;
      log.warn('[Semantic] OPENROUTER_API_KEY not set — semantic search disabled');
    }
    return false;
  }
  return true;
}

export interface SemanticMatchResult {
  value: string;
  source: 'semantic';
  confidence: number;
}

/**
 * Generates text embeddings using OpenRouter API (text-embedding-3-small) with in-memory caching.
 *
 * @param text - Input text to embed.
 * @returns 1536-dimensional embedding array, or null on error.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const clean = text?.trim();
  if (!clean) return null;

  if (embeddingCache.has(clean)) {
    return embeddingCache.get(clean)!;
  }

  if (!isSemanticEnabled()) {
    return null;
  }

  const apiKey = config.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  const preview = clean.length > 50 ? clean.slice(0, 50) + '...' : clean;
  log.info(`[Semantic] Embedding text: ${preview}`);

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/embeddings',
      {
        model: 'text-embedding-3-small',
        input: clean,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.OPENROUTER_HTTP_REFERER || 'https://apply-wizz.me',
          'X-Title': 'Greenhouse Automation Operator',
        },
        timeout: 10000,
      }
    );

    const embedding =
      response.data?.data?.[0]?.embedding || response.data?.embedding || null;

    if (Array.isArray(embedding) && embedding.length > 0) {
      embeddingCache.set(clean, embedding);
      return embedding;
    }

    log.warn(`[Semantic] OpenRouter embeddings returned unexpected payload structure for: ${preview}`);
    return null;
  } catch (err: any) {
    log.warn(
      `[Semantic] OpenRouter embedding error for "${preview}": ${
        err?.response?.data?.error?.message || err.message
      }`
    );
    return null;
  }
}

/**
 * Finds a semantically similar previous answer from candidate_qa_bank via pgvector similarity.
 *
 * @param questionLabel - The question label to match.
 * @param applywizzId - Candidate identifier.
 * @param fieldType - Question input type.
 * @param threshold - Minimum similarity threshold (default: 0.88).
 * @returns Matching answer with confidence score, or null if no match meets threshold.
 */
export async function findSemanticMatch(
  questionLabel: string,
  applywizzId: string,
  _fieldType: string,
  threshold: number = 0.88
): Promise<SemanticMatchResult | null> {
  const embedding = await embedText(questionLabel);
  if (!embedding) {
    return null;
  }

  try {
    const { data, error } = await supabase.rpc('match_candidate_qa', {
      query_vector: embedding,
      match_applywizz_id: applywizzId,
      match_threshold: threshold,
      match_count: 1,
    });

    if (error) {
      log.warn(
        `[Semantic] Supabase RPC match_candidate_qa error for label="${questionLabel}": ${error.message}`
      );
      return null;
    }

    const rows = Array.isArray(data) ? data : data ? [data] : [];
    if (rows.length > 0 && rows[0]?.value) {
      const top = rows[0];
      const similarity = Number(top.similarity ?? threshold);
      log.info(`[Semantic] Match found: similarity=${similarity} for label=${questionLabel}`);
      return {
        value: top.value,
        source: 'semantic',
        confidence: similarity,
      };
    }

    log.info(`[Semantic] No semantic match for label=${questionLabel}`);
    return null;
  } catch (err: any) {
    log.warn(`[Semantic] Error finding semantic match for label="${questionLabel}": ${err.message}`);
    return null;
  }
}

/**
 * Generates and stores the vector embedding for a question in candidate_qa_bank.
 *
 * @param applywizzId - Candidate identifier.
 * @param questionFingerprint - Unique 16-char question fingerprint.
 * @param questionLabel - Question label to embed.
 */
export async function writeEmbedding(
  applywizzId: string,
  questionFingerprint: string,
  questionLabel: string
): Promise<void> {
  const embedding = await embedText(questionLabel);
  if (!embedding) {
    return;
  }

  try {
    const { error } = await supabase
      .from('candidate_qa_bank')
      .update({ embedding })
      .eq('applywizz_id', applywizzId)
      .eq('question_fingerprint', questionFingerprint);

    if (error) {
      log.warn(
        `[Semantic] Failed to write embedding for fingerprint=${questionFingerprint}: ${error.message}`
      );
      return;
    }

    log.info(`[Semantic] Wrote embedding for fingerprint=${questionFingerprint}`);
  } catch (err: any) {
    log.warn(
      `[Semantic] Error writing embedding for fingerprint=${questionFingerprint}: ${err.message}`
    );
  }
}
