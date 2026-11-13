import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerResolver, isResolvedApplicationSuccessful } from '../src/resolver/answerResolver.js';
import { applicationShouldBeFilteredOut } from '../src/resolver/needsReview.js';
import { fillSingleField } from '../src/submitter/formFiller.js';
import type { CandidateJobApplication, ResolvedField } from '../src/types/index.js';
import type { Page } from 'playwright';

function resolvedField(overrides: Partial<ResolvedField>): ResolvedField {
  return {
    fieldId: 'question',
    name: 'question',
    type: 'text',
    label: 'Question',
    value: '',
    source: 'unresolved',
    resolvedByTier: null,
    confidence: 0,
    ...overrides,
  };
}

function application(status: CandidateJobApplication['status'], resolvedFields: ResolvedField[]): CandidateJobApplication {
  return {
    applywizzId: 'AWL-TEST',
    candidateName: 'Test Candidate',
    jobUrl: 'https://example.com/job',
    companyName: 'Example',
    jobTitle: 'Engineer',
    status,
    resolvedFields,
  };
}

test('completion ignores unresolved optional blanks', () => {
  assert.equal(
    isResolvedApplicationSuccessful(application('READY_FOR_REVIEW', [resolvedField({ isRequired: false })])),
    true
  );
});

test('completion fails for an unresolved required field', () => {
  assert.equal(
    isResolvedApplicationSuccessful(application('READY_FOR_REVIEW', [resolvedField({ isRequired: true })])),
    false
  );
});

test('completion preserves resume attachment obligations', () => {
  assert.equal(
    isResolvedApplicationSuccessful(application('READY_FOR_REVIEW', [
      resolvedField({ fieldId: 'resume', name: 'resume', type: 'file', label: 'Resume', isRequired: false }),
    ])),
    false
  );
});

test('expired applications never count as complete', () => {
  assert.equal(isResolvedApplicationSuccessful(application('EXPIRED', [])), false);
});

test('optional questions remain blank and do not enter answer resolution or filtering', async () => {
  const field = {
    fieldId: 'optional_question',
    name: 'optional_question',
    label: 'Tell us more',
    type: 'textarea' as const,
    isRequired: false,
  };
  const result = await new AnswerResolver().resolveField('AWL-UNAVAILABLE', field);
  assert.equal(result.value, '');
  assert.equal(result.isRequired, false);
  assert.equal(result.source, 'unresolved');
  assert.equal(applicationShouldBeFilteredOut(Array.from({ length: 5 }, () => result)), false);
});

test('optional blank fields are not filled by submission defaults', async () => {
  const result = await fillSingleField({} as Page, {
    fieldId: 'referral',
    name: 'referral',
    label: 'How did you hear about us?',
    type: 'text',
    value: '',
    source: 'unresolved',
    resolvedByTier: null,
    confidence: 0,
    isRequired: false,
  }, 'AWL-TEST', []);
  assert.equal(result.valuePopulated, '');
  assert.equal(result.success, true);
});
