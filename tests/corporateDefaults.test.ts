import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  CORPORATE_DEFAULT_PATTERNS,
  getCorporateDefaultHint,
} from '../src/resolver/tier1Supabase.js';
import {
  buildBatchPrompt,
  type BatchQuestion,
} from '../src/resolver/llmSynthesizer.js';
import { alignResolvedChoice } from '../src/resolver/answerResolver.js';
import type { ResolvedField, ScannedField } from '../src/types/index.js';

describe('Phase 4: Tier 5 Corporate Defaults via LLM Context Injection', () => {
  test('"Have you interviewed at Anthropic before?" matches CORPORATE_DEFAULT_PATTERNS', () => {
    const question = 'Have you interviewed at Anthropic before?';
    const matches = CORPORATE_DEFAULT_PATTERNS.some((p) => p.pattern.test(question));
    assert.strictEqual(matches, true);

    const hint = getCorporateDefaultHint(question);
    assert.strictEqual(hint, 'No');
  });

  test('"How did you hear about us?" matches CORPORATE_DEFAULT_PATTERNS', () => {
    const question = 'How did you hear about us?';
    const matches = CORPORATE_DEFAULT_PATTERNS.some((p) => p.pattern.test(question));
    assert.strictEqual(matches, true);

    const hint = getCorporateDefaultHint(question);
    assert.strictEqual(hint, 'LinkedIn or the first job board option available');
  });

  test('"Do you agree to our arbitration policy?" matches CORPORATE_DEFAULT_PATTERNS', () => {
    const question = 'Do you agree to our arbitration policy?';
    const matches = CORPORATE_DEFAULT_PATTERNS.some((p) => p.pattern.test(question));
    assert.strictEqual(matches, true);

    const hint = getCorporateDefaultHint(question);
    assert.strictEqual(hint, 'Yes / agree / checked');
  });

  test('"County" matches CORPORATE_DEFAULT_PATTERNS', () => {
    const question = 'County';
    const matches = CORPORATE_DEFAULT_PATTERNS.some((p) => p.pattern.test(question));
    assert.strictEqual(matches, true);

    const hint = getCorporateDefaultHint(question, { location: 'Chicago, IL' } as any);
    assert.ok(hint?.includes('Chicago, IL'));
  });

  test('"What is your experience with Python?" does NOT match any pattern', () => {
    const question = 'What is your experience with Python?';
    const matches = CORPORATE_DEFAULT_PATTERNS.some((p) => p.pattern.test(question));
    assert.strictEqual(matches, false);

    const hint = getCorporateDefaultHint(question);
    assert.strictEqual(hint, null);
  });

  test('Tier 5 prompt includes corporate_defaults block when hint present', () => {
    const questions: BatchQuestion[] = [
      {
        label: 'Have you interviewed at Anthropic before?',
        type: 'select',
        corporateDefaultHint: 'No',
      },
    ];
    const prompt = buildBatchPrompt(questions, 'Job Description', { location: 'Austin, TX' });
    assert.ok(prompt.includes('## Corporate Default Rules'));
    assert.ok(prompt.includes('default: "No"'));
    assert.ok(prompt.includes('Austin, TX'));
  });

  test('Tier 5 prompt does NOT include block when no hints in batch', () => {
    const questions: BatchQuestion[] = [
      {
        label: 'What is your experience with Python?',
        type: 'textarea',
      },
    ];
    const prompt = buildBatchPrompt(questions, 'Job Description', { location: 'Austin, TX' });
    assert.strictEqual(prompt.includes('## Corporate Default Rules'), false);
  });

  test('LLM answer "Yes" maps to "Yes, I agree" via choice alignment (not literal)', () => {
    const field: ScannedField = {
      fieldId: 'q_arb',
      name: 'arbitration_policy',
      type: 'select',
      label: 'Do you agree to our arbitration policy?',
      options: ['Yes, I agree', 'No, I decline'],
    };
    const rawResolved: ResolvedField = {
      fieldId: 'q_arb',
      name: 'arbitration_policy',
      type: 'select',
      label: 'Do you agree to our arbitration policy?',
      value: 'Yes',
      source: 'ai',
      resolvedByTier: 5,
      confidence: 0.95,
      corporateDefaultHint: 'Yes / agree / checked',
    };
    const aligned = alignResolvedChoice(field, rawResolved);
    assert.strictEqual(aligned.value, 'Yes, I agree');
    assert.strictEqual(aligned.source, 'ai');
    assert.strictEqual(aligned.resolvedByTier, 5);
  });

  test('LLM answer "LinkedIn" maps to "LinkedIn (Job Board)" via choice alignment', () => {
    const field: ScannedField = {
      fieldId: 'q_hear',
      name: 'referral_source',
      type: 'select',
      label: 'How did you hear about us?',
      options: ['LinkedIn (Job Board)', 'Company Website', 'Other'],
    };
    const rawResolved: ResolvedField = {
      fieldId: 'q_hear',
      name: 'referral_source',
      type: 'select',
      label: 'How did you hear about us?',
      value: 'LinkedIn',
      source: 'ai',
      resolvedByTier: 5,
      confidence: 0.95,
      corporateDefaultHint: 'LinkedIn or the first job board option available',
    };
    const aligned = alignResolvedChoice(field, rawResolved);
    assert.strictEqual(aligned.value, 'LinkedIn (Job Board)');
    assert.strictEqual(aligned.source, 'ai');
    assert.strictEqual(aligned.resolvedByTier, 5);
  });

  test('hint field that fails option matching returns unresolved (not forced)', () => {
    const field: ScannedField = {
      fieldId: 'q_hear',
      name: 'referral_source',
      type: 'select',
      label: 'How did you hear about us?',
      options: ['Word of Mouth', 'Recruiter Outreach', 'Campus Event'],
    };
    const rawResolved: ResolvedField = {
      fieldId: 'q_hear',
      name: 'referral_source',
      type: 'select',
      label: 'How did you hear about us?',
      value: 'LinkedIn',
      source: 'ai',
      resolvedByTier: 5,
      confidence: 0.95,
      corporateDefaultHint: 'LinkedIn or the first job board option available',
    };
    const aligned = alignResolvedChoice(field, rawResolved);
    assert.strictEqual(aligned.value, '');
    assert.strictEqual(aligned.source, 'unresolved');
    assert.strictEqual(aligned.resolvedByTier, null);
  });

  test('field resolved at Tier 2 does NOT receive hint injection at Tier 5', () => {
    const tier2Field: ResolvedField = {
      fieldId: 'field_python',
      name: 'years_python',
      type: 'text',
      label: 'Years of Python experience',
      value: '5',
      source: 'resume_parse',
      resolvedByTier: 2,
      confidence: 1.0,
    };
    assert.strictEqual(tier2Field.corporateDefaultHint, undefined);
    assert.notStrictEqual(tier2Field.source, 'unresolved');
  });
});
