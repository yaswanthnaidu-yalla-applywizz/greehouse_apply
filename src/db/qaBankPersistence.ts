import { upsertAnswer } from './qaBank.js';
import { generateFingerprint } from '../resolver/fingerprint.js';
import { writeEmbedding } from '../resolver/semanticSearch.js';
import type { ResolvedField } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('QA Bank Persistence');

/**
 * Persists approved AI answers and operator manual edits into `gh_candidate_qa_bank`
 * and generates semantic embeddings so subsequent applications for this candidate
 * resolve via Tier 1 (exact match) or Tier 3 (semantic similarity) instead of Tier 5.
 */
export async function persistApprovedAiAnswersToQaBank(
  applywizzId: string,
  resolvedFields: ResolvedField[] | null | undefined
): Promise<void> {
  if (!applywizzId || !Array.isArray(resolvedFields) || resolvedFields.length === 0) {
    return;
  }

  const targets = resolvedFields.filter((f) => {
    if (!f || !f.value || typeof f.value !== 'string' || !f.value.trim()) return false;
    // Persist any AI-synthesized field or manually edited field
    return f.source === 'ai' || f.source === 'manual' || f.isEdited === true;
  });

  for (const field of targets) {
    const fingerprint = generateFingerprint(field.label, field.type);
    const trimmedValue = field.value.trim();

    try {
      await upsertAnswer({
        applywizz_id: applywizzId,
        question_fingerprint: fingerprint,
        question_label: field.label,
        field_type: field.type,
        value: trimmedValue,
        source: 'manual', // Stored as approved/authoritative answer
        confidence: 1.0,
      });

      // Best effort embedding generation for semantic search
      try {
        await writeEmbedding(applywizzId, fingerprint, field.label);
      } catch (embErr: any) {
        log.warn(`[QA Bank Persistence] writeEmbedding warning: ${embErr?.message || embErr}`);
      }
    } catch (err: any) {
      log.warn(
        `[QA Bank Persistence] Could not save answer to QA bank for ${applywizzId} ("${field.label}"): ${err?.message || err}`
      );
    }
  }
}
