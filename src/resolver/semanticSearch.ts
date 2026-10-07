/**
 * @fileoverview Semantic vector search and embeddings for candidate QA bank.
 */

import axios from 'axios';
import { LRUCache } from 'lru-cache';
import config from '../config/env.js';
import { supabase } from '../db/client.js';
import type { ProfileRow } from '../db/profiles.js';
import { createLogger } from '../utils/logger.js';
import { matchChoiceOption } from '../utils/choiceOptions.js';
import { getProfileFacts, type ProfileFact } from './profileFacts.js';

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

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function bestSemanticProfileFact(
  questionEmbedding: number[],
  facts: ProfileFact[],
  factEmbeddings: Array<number[] | null>,
  threshold: number
): { fact: ProfileFact; confidence: number } | null {
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < factEmbeddings.length; index++) {
    const factEmbedding = factEmbeddings[index];
    if (!factEmbedding) continue;
    const score = cosineSimilarity(questionEmbedding, factEmbedding);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  return bestIndex >= 0 && bestScore >= threshold
    ? { fact: facts[bestIndex], confidence: bestScore }
    : null;
}

/**
 * Generates text embeddings using OpenRouter API (text-embedding-3-small) with in-memory caching.
 *
 * @param text - Input text to embed.
 * @returns 1536-dimensional embedding array, or null on error.
 */
export async function embedText(text: string): Promise<number[] | null> {
  return (await embedTexts([text]))[0] || null;
}

async function embedTexts(texts: string[]): Promise<Array<number[] | null>> {
  const cleanTexts = texts.map((text) => text?.trim() || '');
  const result: Array<number[] | null> = cleanTexts.map((text) =>
    text && embeddingCache.has(text) ? embeddingCache.get(text)! : null
  );
  const missingIndices = cleanTexts
    .map((text, index) => (text && !result[index] ? index : -1))
    .filter((index) => index >= 0);

  if (missingIndices.length === 0 || !isSemanticEnabled()) return result;

  const apiKey = config.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  for (let start = 0; start < missingIndices.length; start += 64) {
    const indices = missingIndices.slice(start, start + 64);
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/embeddings',
        {
          model: 'text-embedding-3-small',
          input: indices.map((index) => cleanTexts[index]),
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

      const embeddings = Array.isArray(response.data?.data)
        ? response.data.data
        : response.data?.embedding
          ? [{ index: 0, embedding: response.data.embedding }]
          : [];
      for (let position = 0; position < indices.length; position++) {
        const item = embeddings.find((candidate: { index?: number }) =>
          candidate.index === position
        ) || embeddings[position];
        const embedding = item?.embedding;
        if (Array.isArray(embedding) && embedding.length > 0) {
          const index = indices[position];
          result[index] = embedding;
          embeddingCache.set(cleanTexts[index], embedding);
        }
      }
    } catch {
      continue;
    }
  }
  return result;
}

/**
 * Finds a semantically similar previous answer from candidate_qa_bank via pgvector similarity.
 *
 * @param questionLabel - The question label to match.
 * @param applywizzId - Candidate identifier.
 * @param fieldType - Question input type.
 * @param options - Current scanned options for choice fields.
 * @param threshold - Minimum similarity threshold (default: 0.82).
 * @returns Matching answer with confidence score, or null if no match meets threshold.
 */
export async function findSemanticMatch(
  questionLabel: string,
  applywizzId: string,
  fieldType: string,
  options?: string[],
  threshold: number = 0.82,
  profile?: ProfileRow | null
): Promise<SemanticMatchResult | null> {
  lastSemanticScore = 0;
  const embedding = await embedText(questionLabel);
  if (!embedding) {
    return null;
  }

  const profileFacts = getProfileFacts(profile);
  if (profileFacts.length > 0) {
    const factEmbeddings = await embedTexts(profileFacts.map((fact) => fact.label));
    const bestFact = bestSemanticProfileFact(
      embedding,
      profileFacts,
      factEmbeddings,
      threshold
    );
    lastSemanticScore = Math.max(
      lastSemanticScore,
      factEmbeddings.reduce((max, factEmbedding) =>
        factEmbedding
          ? Math.max(max, cosineSimilarity(embedding, factEmbedding))
          : max, 0)
    );
    if (bestFact) {
      let value = bestFact.fact.value;
      if (options?.length && ['select', 'radio', 'checkbox'].includes(fieldType)) {
        const aligned = matchChoiceOption(value, options);
        if (aligned) {
          return { value: aligned, source: 'semantic', confidence: bestFact.confidence };
        }
      } else {
        return { value, source: 'semantic', confidence: bestFact.confidence };
      }
    }
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
      lastSemanticScore = Math.max(lastSemanticScore, similarity);
      if (similarity >= threshold) {
        if (
          options &&
          options.length > 0 &&
          ['select', 'radio', 'checkbox'].includes(fieldType)
        ) {
          const aligned = matchChoiceOption(String(top.value), options);
          if (!aligned) return null;
          return {
            value: aligned,
            source: 'semantic',
            confidence: similarity,
          };
        }
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
