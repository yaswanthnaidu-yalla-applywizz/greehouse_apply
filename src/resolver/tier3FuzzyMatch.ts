/**
 * @fileoverview Tier 4 Answer Resolution: Fuzzy Matching against candidate facts and QA bank.
 * Source Tag: 'supabase' for profile facts, 'fuzzy_match' for QA-bank matches.
 */

import Fuse from 'fuse.js';
import { findAnswersByCandidate, type QABankRow } from '../db/qaBank.js';
import type { ProfileRow } from '../db/profiles.js';
import { normalizeText } from './fingerprint.js';
import { getProfileFacts } from './profileFacts.js';
import { classifyFieldIntent, isEvidenceCompatible } from './fieldIntent.js';
import type { FieldIntent, ResolvedField, ScannedField } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { matchChoiceOption } from '../utils/choiceOptions.js';

const log = createLogger('Tier4 Fuzzy Match');

let fuzzyMatchingEnabled = true;

export function setFuzzyMatchingEnabled(enabled: boolean): void {
  fuzzyMatchingEnabled = enabled;
}

export function isFuzzyMatchingEnabled(): boolean {
  return fuzzyMatchingEnabled;
}

function isAllowedUrlAnswer(field: ScannedField, value: string): boolean {
  return !/^https?:\/\//i.test(value.trim()) || /linkedin|github|portfolio|website|url/i.test(field.label);
}

/**
 * Matches target value to the closest matching option in dropdown or radio group.
 */
function matchBestOption(targetValue: string, options?: string[]): string | null {
  if (!options || options.length === 0) {
    return targetValue;
  }
  return matchChoiceOption(targetValue, options);
}

/**
 * Attempts Tier 4 resolution using Fuse.js fuzzy matching against profile facts,
 * then the candidate's historical questions in `candidate_qa_bank`.
 *
 * Fuse.js match threshold: 0.4.
 *
 * @returns ResolvedField with resolvedByTier: 4, or null if miss.
 */
export async function resolveTier3(
  applywizzId: string,
  field: ScannedField,
  qaEntriesCache?: QABankRow[],
  profile?: ProfileRow | null,
  intent?: FieldIntent
): Promise<ResolvedField | null> {
  try {
    const fieldIntent = intent || field.intent || classifyFieldIntent(field);
    if (fieldIntent.family === 'creative') {
      return null;
    }

    const profileFacts = getProfileFacts(profile);
    const query = normalizeText(field.label);
    const compatibleFacts = profileFacts.filter((fact) =>
      isEvidenceCompatible(fieldIntent, {
        kind: 'profile_fact',
        key: fact.label,
        value: fact.value,
      })
    );
    const normalizedFacts = compatibleFacts.map((fact) => ({
      ...fact,
      normalized_label: normalizeText(fact.label),
    }));

    for (const fact of normalizedFacts) {
      if (
        fact.normalized_label.length >= 4 &&
        query.length >= 4 &&
        (fact.normalized_label.includes(query) || query.includes(fact.normalized_label))
      ) {
        let finalValue: string | null = fact.value;
        if (field.options?.length) {
          finalValue = matchBestOption(finalValue, field.options);
          if (!finalValue) continue;
        }
        if (!isAllowedUrlAnswer(field, finalValue)) return null;
        return {
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          label: field.label,
          value: finalValue,
          source: 'supabase',
          resolvedByTier: 4,
          confidence: 0.95,
          provenance: {
            family: fieldIntent.family,
            evidenceKind: 'profile_fact',
            evidenceKey: fact.label,
            confidence: 0.95,
          },
        };
      }
    }

    if (fuzzyMatchingEnabled && normalizedFacts.length > 0 && query) {
      const factSearch = new Fuse(normalizedFacts, {
        keys: ['normalized_label', 'label'],
        includeScore: true,
        threshold: 0.25,
        ignoreLocation: true,
        minMatchCharLength: 3,
      }).search(query);
      if (factSearch.length > 0) {
        const bestMatch = factSearch[0];
        const distance = bestMatch.score ?? 1;
        const similarity = 1 - distance;
        const secondDistance = factSearch.length > 1 ? (factSearch[1].score ?? 1) : 1;
        const secondSimilarity = 1 - secondDistance;
        const uniqueness = similarity - secondSimilarity;

        if (similarity >= 0.88 && (factSearch.length === 1 || uniqueness >= 0.08)) {
          let finalValue: string | null = bestMatch.item.value;
          if (field.options?.length) {
            finalValue = matchBestOption(finalValue, field.options);
          }
          if (finalValue && isAllowedUrlAnswer(field, finalValue)) {
            return {
              fieldId: field.fieldId,
              name: field.name,
              type: field.type,
              label: field.label,
              value: finalValue,
              source: 'supabase',
              resolvedByTier: 4,
              confidence: Math.max(0.85, Number(similarity.toFixed(2))),
              provenance: {
                family: fieldIntent.family,
                evidenceKind: 'profile_fact',
                evidenceKey: bestMatch.item.label,
                confidence: Number(similarity.toFixed(2)),
              },
            };
          }
        }
      }
    }

    const entries = qaEntriesCache || (await findAnswersByCandidate(applywizzId));
    if (!entries || entries.length === 0) {
      return null;
    }

    const compatibleEntries = entries.filter((entry) =>
      isEvidenceCompatible(fieldIntent, {
        kind: 'qa_bank',
        key: entry.question_label,
        value: entry.value,
      })
    );

    const searchableEntries = compatibleEntries.map((e) => ({
      ...e,
      normalized_label: normalizeText(e.question_label),
    }));

    // 1. Direct normalized substring check
    for (const entry of searchableEntries) {
      if (
        entry.normalized_label &&
        query &&
        (entry.normalized_label.includes(query) || query.includes(entry.normalized_label))
      ) {
        let finalValue: string | null = entry.value;
        if (field.options && field.options.length > 0) {
          finalValue = matchBestOption(finalValue, field.options);
          if (!finalValue) continue;
        }
        if (!isAllowedUrlAnswer(field, finalValue)) return null;
        return {
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          label: field.label,
          value: finalValue,
          source: 'fuzzy_match',
          resolvedByTier: 4,
          confidence: 0.95,
          provenance: {
            family: fieldIntent.family,
            evidenceKind: 'qa_bank',
            evidenceKey: entry.question_fingerprint,
            confidence: 0.95,
          },
        };
      }
    }

    // 2. Fuse.js Fuzzy match (gated by fuzzyMatchingEnabled)
    if (fuzzyMatchingEnabled && searchableEntries.length > 0) {
      const fuse = new Fuse(searchableEntries, {
        keys: ['normalized_label', 'question_label'],
        includeScore: true,
        threshold: 0.4,
        ignoreLocation: true,
        minMatchCharLength: 3,
      });

      const searchResults = fuse.search(query);

      if (searchResults.length > 0) {
        const bestMatch = searchResults[0];
        const distance = bestMatch.score ?? 1;
        const similarity = 1 - distance;
        const secondDistance = searchResults.length > 1 ? (searchResults[1].score ?? 1) : 1;
        const secondSimilarity = 1 - secondDistance;
        const uniqueness = similarity - secondSimilarity;

        // Reject weak scores or tied candidates (calibrated: similarity >= 0.88, uniqueness >= 0.08)
        if (similarity < 0.88 || (searchResults.length > 1 && uniqueness < 0.08)) {
          return null;
        }

        let finalValue: string | null = bestMatch.item.value;
        if (field.options && field.options.length > 0) {
          finalValue = matchBestOption(finalValue, field.options);
          if (!finalValue) return null;
        }
        if (!isAllowedUrlAnswer(field, finalValue)) return null;

        return {
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          label: field.label,
          value: finalValue,
          source: 'fuzzy_match',
          resolvedByTier: 4,
          confidence: Math.max(0.85, Number(similarity.toFixed(2))),
          provenance: {
            family: fieldIntent.family,
            evidenceKind: 'qa_bank',
            evidenceKey: bestMatch.item.question_fingerprint,
            confidence: Number(similarity.toFixed(2)),
          },
        };
      }
    }
  } catch (err: any) {
    log.warn(`[Tier 4] Fuzzy match error for ${applywizzId}: ${err.message}`);
  }

  return null;
}

export default resolveTier3;
