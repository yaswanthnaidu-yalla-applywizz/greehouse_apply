/**
 * @fileoverview Tier 3 Answer Resolution: Fuzzy Matching against candidate_qa_bank.
 * Source Tag: 'fuzzy_match', resolvedByTier: 3
 */

import Fuse from 'fuse.js';
import { findAnswersByCandidate, type QABankRow } from '../db/qaBank.js';
import { normalizeText } from './fingerprint.js';
import type { ResolvedField, ScannedField } from '../types/index.js';

/**
 * Matches target value to the closest matching option in dropdown or radio group.
 */
function matchBestOption(targetValue: string, options?: string[]): string {
  if (!options || options.length === 0) {
    return targetValue;
  }

  const normTarget = normalizeText(targetValue);

  for (const opt of options) {
    if (normalizeText(opt) === normTarget) return opt;
  }
  for (const opt of options) {
    const normOpt = normalizeText(opt);
    if (normOpt.includes(normTarget) || normTarget.includes(normOpt)) return opt;
  }

  const fuse = new Fuse(options, { threshold: 0.6 });
  const results = fuse.search(targetValue);
  return results.length > 0 ? results[0].item : options[0];
}

/**
 * Attempts Tier 3 resolution using Fuse.js fuzzy string matching
 * against the candidate's historical questions in `candidate_qa_bank`.
 *
 * Threshold: similarity >= 0.85 (Fuse distance <= 0.15).
 *
 * @returns ResolvedField with source: 'fuzzy_match', resolvedByTier: 3, or null if miss.
 */
export async function resolveTier3(
  applywizzId: string,
  field: ScannedField,
  qaEntriesCache?: QABankRow[]
): Promise<ResolvedField | null> {
  try {
    const entries = qaEntriesCache || (await findAnswersByCandidate(applywizzId));
    if (!entries || entries.length === 0) {
      return null;
    }

    // Index existing questions by normalized label
    const searchableEntries = entries.map((e) => ({
      ...e,
      normalized_label: normalizeText(e.question_label),
    }));

    // 1. Direct normalized substring check
    const query = normalizeText(field.label);
    for (const entry of searchableEntries) {
      if (
        entry.normalized_label &&
        query &&
        (entry.normalized_label.includes(query) || query.includes(entry.normalized_label))
      ) {
        let finalValue = entry.value;
        if (field.options && field.options.length > 0) {
          finalValue = matchBestOption(finalValue, field.options);
        }
        return {
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          label: field.label,
          value: finalValue,
          source: 'fuzzy_match',
          resolvedByTier: 3,
          confidence: 0.95,
        };
      }
    }

    // 2. Fuse.js Fuzzy match
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
      const distance = bestMatch.score ?? 0;
      const confidence = Math.max(0.85, Number((1 - distance).toFixed(2)));

      let finalValue = bestMatch.item.value;
      if (field.options && field.options.length > 0) {
        finalValue = matchBestOption(finalValue, field.options);
      }

      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: finalValue,
        source: 'fuzzy_match',
        resolvedByTier: 3,
        confidence,
      };
    }
  } catch (err: any) {
    console.warn(`[Tier 3] Fuzzy match error for ${applywizzId}: ${err.message}`);
  }

  return null;
}

export default resolveTier3;
