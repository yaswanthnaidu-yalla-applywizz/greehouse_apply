import { upsertAnswer } from './qaBank.js';
import { generateFingerprint } from '../resolver/fingerprint.js';
import { writeEmbedding } from '../resolver/semanticSearch.js';
import { setInMemoryQaRow, isTestReviewStoreEnabled } from './aiAnswerReviews.js';
import type { ResolvedField } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('QA Bank Persistence');

/**
 * Persists manual operator edits into `gh_candidate_qa_bank` and generates semantic embeddings.
 *
 * NOTE: Raw unchanged `source === 'ai'` answers are NOT written to QA bank directly here.
 * AI answers are only promoted to QA bank via explicit submission promotion (`promoteSubmittedAiAnswers`)
 * or manager approval.
 */
export async function persistManualFieldEditsToQaBank(
  applywizzId: string,
  resolvedFields: ResolvedField[] | null | undefined
): Promise<void> {
  if (!applywizzId || !Array.isArray(resolvedFields) || resolvedFields.length === 0) {
    return;
  }

  // Preserve verified explicit manual edits only; ignore unchanged raw AI fields
  const targets = resolvedFields.filter((f) => {
    if (!f || !f.value || typeof f.value !== 'string' || !f.value.trim()) return false;
    return f.source === 'manual' || f.isEdited === true;
  });

  for (const field of targets) {
    const fingerprint = generateFingerprint(field.label, field.type);
    const trimmedValue = field.value.trim();

    try {
      if (isTestReviewStoreEnabled()) {
        setInMemoryQaRow({
          applywizz_id: applywizzId,
          question_fingerprint: fingerprint,
          question_label: field.label,
          field_type: field.type,
          value: trimmedValue,
          source: 'manual',
          confidence: 1.0,
          updated_at: new Date().toISOString(),
        });
      } else {
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
      }
    } catch (err: any) {
      log.warn(
        `[QA Bank Persistence] Could not save answer to QA bank for ${applywizzId} ("${field.label}"): ${err?.message || err}`
      );
    }
  }
}

/**
 * Backward compatibility alias: forwards to persistManualFieldEditsToQaBank.
 * Preserves manual edits as an authoritative learning path while disallowing raw unapproved AI promotions.
 */
export async function persistApprovedAiAnswersToQaBank(
  applywizzId: string,
  resolvedFields: ResolvedField[] | null | undefined
): Promise<void> {
  return persistManualFieldEditsToQaBank(applywizzId, resolvedFields);
}
