/**
 * Batch Tier-5 post-validation: choice fields must match options exactly (fail-closed).
 */

import { LLMSynthesizer, matchExactOption } from '../src/resolver/llmSynthesizer.js';
import type { ScannedField } from '../src/types/index.js';

async function runTests() {
  console.log('🧪 Batch LLM validation tests\n');
  let passed = 0;
  let total = 0;

  function assert(condition: boolean, name: string) {
    total++;
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
    }
  }

  assert(matchExactOption('Yes', ['Yes', 'No']) === 'Yes', 'matchExactOption accepts Yes');
  assert(matchExactOption('maybe', ['Yes', 'No']) === null, 'matchExactOption rejects non-option');

  const synthesizer = new LLMSynthesizer({ provider: 'openai', apiKey: '' });
  const profile = {
    applywizz_id: 'TEST-1',
    client_name: 'Test User',
    email: 'test@example.com',
  } as any;

  const radioField: ScannedField = {
    fieldId: 'auth',
    name: 'authorized',
    type: 'radio',
    label: 'Are you authorized to work in the US?',
    isRequired: true,
    options: ['Yes', 'No'],
  };

  const good = synthesizer.finalizeRawAnswer('Yes', radioField, profile, {
    title: 'Engineer',
    company: 'Acme',
  }, { defaultConfidenceIfMissing: 0.85 });
  assert(good.source === 'ai' && good.value === 'Yes', 'finalizeRawAnswer accepts exact radio option');

  const bad = synthesizer.finalizeRawAnswer('Definitely yes', radioField, profile, {
    title: 'Engineer',
    company: 'Acme',
  }, { defaultConfidenceIfMissing: 0.85 });
  assert(bad.source === 'unresolved', 'finalizeRawAnswer fail-closed on non-exact option');

  console.log(`\n${passed}/${total} passed`);
  if (passed !== total) process.exit(1);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
