import { describe, it, expect, vi, beforeEach } from 'vitest';
import { persistApprovedAiAnswersToQaBank } from '../src/db/qaBankPersistence.js';
import * as qaBankModule from '../src/db/qaBank.js';
import * as semanticSearchModule from '../src/resolver/semanticSearch.js';
import type { ResolvedField } from '../src/types/index.js';

describe('QA Bank Gate Enforcement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('persists AI answers and manual edits when approved with confidence 1.0 and source manual', async () => {
    const upsertSpy = vi.spyOn(qaBankModule, 'upsertAnswer').mockResolvedValue(undefined as any);
    const embeddingSpy = vi.spyOn(semanticSearchModule, 'writeEmbedding').mockResolvedValue(undefined as any);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'f1',
        name: 'why_us',
        type: 'textarea',
        label: 'Why do you want to work here?',
        value: 'Excited about the mission and tech stack.',
        source: 'ai',
        resolvedByTier: 5,
        confidence: 0.88,
        isRequired: true,
      },
      {
        fieldId: 'f2',
        name: 'salary_req',
        type: 'input_text',
        label: 'Salary expectation',
        value: '$120,000',
        source: 'manual',
        isEdited: true,
        resolvedByTier: 5,
        confidence: 1.0,
        isRequired: false,
      },
      {
        fieldId: 'f3',
        name: 'first_name',
        type: 'input_text',
        label: 'First Name',
        value: 'Alice',
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
        isRequired: true,
      },
    ];

    await persistApprovedAiAnswersToQaBank('AWL-101', resolvedFields);

    // Only f1 (source: ai) and f2 (source: manual, isEdited: true) should be persisted.
    // f3 (source: supabase) must be skipped.
    expect(upsertSpy).toHaveBeenCalledTimes(2);

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        applywizz_id: 'AWL-101',
        question_label: 'Why do you want to work here?',
        value: 'Excited about the mission and tech stack.',
        source: 'manual',
        confidence: 1.0,
      })
    );

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        applywizz_id: 'AWL-101',
        question_label: 'Salary expectation',
        value: '$120,000',
        source: 'manual',
        confidence: 1.0,
      })
    );

    expect(embeddingSpy).toHaveBeenCalledTimes(2);
  });

  it('does not persist empty or whitespace-only answers', async () => {
    const upsertSpy = vi.spyOn(qaBankModule, 'upsertAnswer').mockResolvedValue(undefined as any);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'f1',
        name: 'blank',
        type: 'input_text',
        label: 'Blank Field',
        value: '   ',
        source: 'ai',
        resolvedByTier: 5,
        confidence: 0.8,
        isRequired: false,
      },
    ];

    await persistApprovedAiAnswersToQaBank('AWL-102', resolvedFields);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
