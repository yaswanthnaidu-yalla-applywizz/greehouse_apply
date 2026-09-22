/**
 * @fileoverview Semantic vector search and embeddings for candidate QA bank.
 */

import axios from 'axios';
import { LRUCache } from 'lru-cache';
import config from '../config/env.js';
import { supabase } from '../db/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Semantic');

const embeddingCache = new LRUCache<string, number[]>({ max: 5000 });

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

let lastSemanticScore = 0;

export function getLastSemanticScore(): number {
  return lastSemanticScore;
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

    return null;
  } catch {
    return null;
  }
}

/**
 * Finds a semantically similar previous answer from candidate_qa_bank via pgvector similarity.
 *
 * @param questionLabel - The question label to match.
 * @param applywizzId - Candidate identifier.
 * @param fieldType - Question input type.
 * @param threshold - Minimum similarity threshold (default: 0.82).
 * @returns Matching answer with confidence score, or null if no match meets threshold.
 */
export async function findSemanticMatch(
  questionLabel: string,
  applywizzId: string,
  _fieldType: string,
  threshold: number = 0.82
): Promise<SemanticMatchResult | null> {
  lastSemanticScore = 0;
  const embedding = await embedText(questionLabel);
  if (!embedding) {
    return null;
  }

  try {
    const { data, error } = await supabase.rpc('match_candidate_qa', {
      query_vector: embedding,
      match_applywizz_id: applywizzId,
      match_threshold: 0.0,
      match_count: 1,
    });

    if (error) {
      return null;
    }

    const rows = Array.isArray(data) ? data : data ? [data] : [];
    if (rows.length > 0 && rows[0]?.value) {
      const top = rows[0];
      const similarity = Number(top.similarity ?? 0);
      lastSemanticScore = similarity;
      if (similarity >= threshold) {
        return {
          value: top.value,
          source: 'semantic',
          confidence: similarity,
        };
      }
    }

    return null;
  } catch {
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
    await supabase
      .from('gh_candidate_qa_bank')
      .update({ embedding })
      .eq('applywizz_id', applywizzId)
      .eq('question_fingerprint', questionFingerprint);
  } catch {
    // Ignore write-back embedding errors
  }
}
