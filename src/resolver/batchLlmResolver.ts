import { LLMSynthesizer, type BatchQuestion } from './llmSynthesizer.js';

export interface UnresolvedBatchField extends BatchQuestion {}

export interface UnresolvedFieldGroup {
  applywizzId: string;
  jobUrl: string;
  resumeText?: string;
  jobDescription?: string;
  fields: UnresolvedBatchField[];
}

export interface BatchResolvedField extends UnresolvedBatchField {
  value: string;
  source: 'ai';
  confidence: 0.85;
}

export interface BatchResolvedGroup {
  applywizzId: string;
  jobUrl: string;
  fields: BatchResolvedField[];
}

/**
 * Resolves each candidate/job group with exactly one LLM request.
 */
export async function resolveBatchLlmFields(
  groups: UnresolvedFieldGroup[],
  synthesizer: LLMSynthesizer = new LLMSynthesizer()
): Promise<BatchResolvedGroup[]> {
  return Promise.all(
    groups.map(async (group) => {
      const answers = await synthesizer.synthesizeBatchAnswers(
        group.fields,
        group.resumeText ?? '',
        group.jobDescription ?? ''
      );
      const fields = group.fields.map((field, index) => ({
        ...field,
        value: answers[index],
        source: 'ai' as const,
        confidence: 0.85 as const,
      }));

      console.log(
        `[LLM Batch] ${group.applywizzId} ${group.jobUrl}: ${fields.length} questions → 1 API call → ${fields.length} answers resolved.`
      );
      return { applywizzId: group.applywizzId, jobUrl: group.jobUrl, fields };
    })
  );
}

export default resolveBatchLlmFields;
