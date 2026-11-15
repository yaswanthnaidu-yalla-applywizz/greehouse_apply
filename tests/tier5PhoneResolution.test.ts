import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { LLMSynthesizer } from '../src/resolver/llmSynthesizer.js';
import { resolveTier5, resolveTier5Batch } from '../src/resolver/tier5LLM.js';
import type { ProfileRow } from '../src/db/profiles.js';
import type { ResolvedField, ScannedField } from '../src/types/index.js';

type Scenario = { answer: string; quote: string };
let scenario: Scenario = { answer: '', quote: '' };

const phoneField: ScannedField = {
  fieldId: 'phone',
  name: 'phone',
  type: 'text',
  label: 'Phone number',
  isRequired: true,
};

function answer(field: ScannedField, value: string): ResolvedField {
  return {
    fieldId: field.fieldId,
    name: field.name,
    type: field.type,
    label: field.label,
    value,
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.95,
    isRequired: Boolean(field.isRequired),
  };
}

function profile(phone: string, withConflictingResume = false): ProfileRow {
  return {
    applywizz_id: 'OFFLINE-PHONE-TEST',
    client_name: 'Jane Doe',
    phone,
    country_code: '+1',
    resume_facts: withConflictingResume
      ? { rawSections: { summary: 'Jane Doe | jane@example.com | +1 (415) 555-0136' } }
      : {},
  } as ProfileRow;
}

function setupOfflineSynthesizer() {
  mock.method(LLMSynthesizer.prototype, 'synthesizeAnswer', async (field) => answer(field, scenario.answer));
  mock.method(LLMSynthesizer.prototype, 'synthesizeDeepSeekAnswer', async (field) => {
    return { result: answer(field, scenario.answer), supportQuote: scenario.quote };
  });
  mock.method(LLMSynthesizer.prototype, 'synthesizeBatchAnswers', async () => ({
    answers: [scenario.answer],
    confidences: [0.95],
    supportQuotes: [scenario.quote],
  }));
}

afterEach(() => mock.restoreAll());

test('legacy Tier 5 single accepts a supported profile phone and rejects conflicting or invalid values', async () => {
  setupOfflineSynthesizer();
  const warnings: string[] = [];
  mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')));
  const candidate = profile('+1 (415) 555-0136');

  scenario = { answer: '4155550136', quote: '4155550136' };
  const supported = await resolveTier5('OFFLINE-PHONE-TEST', phoneField, candidate, { companyName: 'Example', jobTitle: 'Engineer' });
  assert.equal(supported?.value, '4155550136');

  scenario = { answer: '2125550199', quote: '2125550199' };
  const conflicting = await resolveTier5('OFFLINE-PHONE-TEST', phoneField, profile('212-555-0199', true), { companyName: 'Example', jobTitle: 'Engineer' });
  assert.equal(conflicting, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unsupported_or_conflicting_candidate_evidence/);
  assert.doesNotMatch(warnings[0], /OFFLINE-PHONE-TEST|2125550199/);

  scenario = { answer: '0000000000', quote: '0000000000' };
  const invalid = await resolveTier5('OFFLINE-PHONE-TEST', phoneField, profile('000-000-0000'), { companyName: 'Example', jobTitle: 'Engineer' });
  assert.equal(invalid, null);
});

test('legacy Tier 5 batch accepts a supported profile phone and rejects conflicting or invalid values', async () => {
  setupOfflineSynthesizer();
  const warnings: string[] = [];
  mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')));

  scenario = { answer: '4155550136', quote: '4155550136' };
  const supported = await resolveTier5Batch(
    'OFFLINE-PHONE-TEST', [phoneField], profile('+1 (415) 555-0136'), { companyName: 'Example', jobTitle: 'Engineer' }
  );
  assert.equal(supported[0]?.value, '4155550136');

  scenario = { answer: '2125550199', quote: '2125550199' };
  const conflicting = await resolveTier5Batch(
    'OFFLINE-PHONE-TEST', [phoneField], profile('212-555-0199', true), { companyName: 'Example', jobTitle: 'Engineer' }
  );
  assert.equal(conflicting[0], null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unsupported_or_conflicting_candidate_evidence/);
  assert.doesNotMatch(warnings[0], /OFFLINE-PHONE-TEST|2125550199/);

  scenario = { answer: '0000000000', quote: '0000000000' };
  const invalid = await resolveTier5Batch(
    'OFFLINE-PHONE-TEST', [phoneField], profile('000-000-0000'), { companyName: 'Example', jobTitle: 'Engineer' }
  );
  assert.equal(invalid[0], null);
});
