import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import { alignResolvedChoice } from '../src/resolver/answerResolver.js';
import { AnswerResolver } from '../src/resolver/answerResolver.js';
import { resolveTier3 } from '../src/resolver/tier3FuzzyMatch.js';
import type { ProfileRow } from '../src/db/profiles.js';
import type { ScannedField } from '../src/types/index.js';

function dateField(overrides: Partial<ScannedField>): ScannedField {
  return {
    fieldId: 'date_component',
    name: 'date_component',
    type: 'select',
    label: 'Start date month',
    isRequired: true,
    options: ['March', 'September'],
    optionsComplete: false,
    ...overrides,
  };
}

const profile = (overrides: Partial<ProfileRow>): ProfileRow => ({
  applywizz_id: 'AWL-TEST',
  client_name: 'Test Candidate',
  ...overrides,
});

test('raw start dates do not resolve uncontextualized date components', async () => {
  const result = await resolveTier1('AWL-TEST', dateField({
    fieldId: 'start_date--0',
    name: 'start_date--0',
    options: undefined,
  }), profile({
    raw_api_payload: { start_date: '2026-10-05' },
  }));
  assert.equal(result, null);
});

test('an indexed field name without section provenance does not establish education context', async () => {
  const result = await resolveTier1('AWL-TEST', dateField({
    fieldId: 'start_date--0',
    name: 'start_date--0',
  }), profile({ education: [{ startDate: '2022-09-01' }] }));
  assert.equal(result, null);
});

test('education date components use an indexed education record', async () => {
  const result = await resolveTier1('AWL-TEST', dateField({
    fieldId: 'start_date--1',
    name: 'start_date--1',
    metadata: { section: 'Education' },
  }), profile({ education: [
    { startDate: '2018-01-01' },
    { startDate: '2022-09-01' },
  ] }));
  assert.equal(result?.value, 'September');
});

test('single education record can resolve a component without an index', async () => {
  const result = await resolveTier1('AWL-TEST', dateField({
    metadata: { section: 'Education' },
  }), profile({ education: [{ startDate: '2022-09-01' }] }));
  assert.equal(result?.value, 'September');
});

test('employment date components read work experience records', async () => {
  const result = await resolveTier1('AWL-TEST', dateField({
    fieldId: 'start_date--0',
    name: 'start_date--0',
    metadata: { section: 'Work Experience' },
  }), profile({
    education: [{ startDate: '2018-01-01' }],
    work_experience: [{ startDate: '2021-03-01' }],
  }));
  assert.equal(result?.value, 'March');
});

test('choice alignment rejects a full ISO date for a month or year component', () => {
  const field = dateField({ metadata: { section: 'Education' } });
  const aligned = alignResolvedChoice(field, {
    fieldId: field.fieldId,
    name: field.name,
    type: field.type,
    label: field.label,
    value: '2026-10-05',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1,
    isRequired: true,
  });
  assert.equal(aligned.value, '');
  assert.equal(aligned.source, 'unresolved');
});

test('normal resolver keeps date components unresolved when context is absent', async () => {
  const field = dateField({ fieldId: 'start_date--0', name: 'start_date--0' });
  const qaEntries = [{
    applywizz_id: 'AWL-TEST',
    question_fingerprint: 'unused',
    question_label: 'Start date month',
    field_type: 'select',
    value: 'May',
    source: 'manual' as const,
  }];
  assert.equal((await resolveTier3('AWL-TEST', { ...field, options: undefined }, qaEntries, null))?.value, 'May');
  const result = await new AnswerResolver().resolveField('AWL-TEST', field, {
    profile: profile({ education: [{ startDate: '2022-09-01' }] }),
    parsedResume: null,
    qaEntries,
  });
  assert.equal(result.value, '');
  assert.equal(result.source, 'unresolved');
});

test('normal resolver does not fall through when the indexed record is absent', async () => {
  const field = dateField({
    fieldId: 'start_date--1',
    name: 'start_date--1',
    metadata: { section: 'Education' },
  });
  const result = await new AnswerResolver().resolveField('AWL-TEST', field, {
    profile: profile({ education: [{ startDate: '2022-09-01' }] }),
    parsedResume: null,
    qaEntries: [{
      applywizz_id: 'AWL-TEST',
      question_fingerprint: 'unused',
      question_label: 'Start date month',
      field_type: 'select',
      value: 'May',
      source: 'manual',
    }],
  });
  assert.equal(result.value, '');
  assert.equal(result.source, 'unresolved');
});

test('normal resolver resolves contextual components from incomplete searchable catalogs', async () => {
  const field = dateField({ metadata: { section: 'Education' }, options: ['January'] });
  const result = await new AnswerResolver().resolveField('AWL-TEST', field, {
    profile: profile({ education: [{ startDate: '2022-09-01' }] }),
    parsedResume: null,
    qaEntries: [],
  });
  assert.equal(result.value, 'September');
  assert.equal(result.resolvedByTier, 1);
});
