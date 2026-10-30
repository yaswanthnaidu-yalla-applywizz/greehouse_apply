import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alignResolvedChoice } from '../src/resolver/answerResolver.js';
import { getEffectiveFieldOptions } from '../src/resolver/llmSynthesizer.js';

describe('resolved choice metadata integrity', () => {
  it('does not persist inferred Yes/No when the scanner found no options', () => {
    const field = {
      fieldId: 'authorization',
      name: 'authorization',
      type: 'select' as const,
      label: 'Are you legally authorized to work in the United States?',
      isRequired: true,
    };
    const resolved = {
      ...field,
      value: 'Yes',
      source: 'ai' as const,
      resolvedByTier: 5 as const,
      confidence: 0.95,
    };

    assert.deepEqual(getEffectiveFieldOptions(field), ['Yes', 'No']);
    const aligned = alignResolvedChoice(field, resolved, getEffectiveFieldOptions(field));
    assert.equal(aligned.options, undefined);
    assert.equal(aligned.value, 'Yes');
  });

  it('retains options that were actually scanned', () => {
    const field = {
      fieldId: 'relocation',
      name: 'relocation',
      type: 'select' as const,
      label: 'Are you open to relocation?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const resolved = {
      ...field,
      value: 'Yes',
      source: 'supabase' as const,
      resolvedByTier: 1 as const,
      confidence: 1,
    };

    const aligned = alignResolvedChoice(field, resolved, getEffectiveFieldOptions(field));
    assert.deepEqual(aligned.options, ['Yes', 'No']);
  });
});
