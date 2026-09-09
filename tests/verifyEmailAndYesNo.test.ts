/**
 * Verification tests for company email priority and Yes/No question enforcement.
 */

import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import {
  coerceBinaryYesNo,
  isBinaryYesNoQuestion,
  LLMSynthesizer,
} from '../src/resolver/llmSynthesizer.js';
import type { ScannedField } from '../src/types/index.js';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function runVerification() {
  console.log('=== EMAIL & YES/NO VERIFICATION TEST START ===\n');

  // --- Company email priority in Tier 1 ---
  console.log('--- 1. Company Email Priority (Tier 1) ---');
  const emailField: ScannedField = {
    fieldId: 'email',
    name: 'email',
    type: 'text',
    label: 'Email',
    isRequired: true,
  };

  const palutlaProfile: any = {
    applywizz_id: 'AWL-36144',
    client_name: 'Sai Palutla',
    first_name: 'Sai',
    last_name: 'Palutla',
    email: 'pramod.palutla@hotmail.com',
    company_email: 'sai.palutla@applywizard.ai',
    raw_api_payload: {
      client: { company_email: 'sai.palutla@applywizard.ai', personal_email: 'pramod.palutla@hotmail.com' },
    },
  };

  const resEmail = await resolveTier1('AWL-36144', emailField, palutlaProfile);
  console.log('AWL-36144 email resolved:', resEmail?.value);
  assert(resEmail?.value === 'sai.palutla@applywizard.ai', `Expected company email, got ${resEmail?.value}`);
  console.log('✅ AWL-36144 resolves to company email.');

  // company_email column takes priority even when profile.email is personal
  const columnPriorityProfile: any = {
    applywizz_id: 'AWL-36144',
    client_name: 'Sai Palutla',
    email: 'pramod.palutla@hotmail.com',
    company_email: 'sai.palutla@applywizard.ai',
  };
  const resColumn = await resolveTier1('AWL-36144', emailField, columnPriorityProfile);
  assert(
    resColumn?.value === 'sai.palutla@applywizard.ai',
    `company_email column must win, got ${resColumn?.value}`
  );
  console.log('✅ company_email column is used directly.');

  // profile.email column has personal email — must still return company email from raw payload
  const personalOnlyProfile: any = {
    ...palutlaProfile,
    email: 'pramod.palutla@hotmail.com',
    raw_api_payload: {
      client: {
        company_email: 'sai.palutla@applywizard.ai',
        personal_email: 'pramod.palutla@hotmail.com',
      },
    },
  };
  const resPersonalOverride = await resolveTier1('AWL-36144', emailField, personalOnlyProfile);
  assert(
    resPersonalOverride?.value === 'sai.palutla@applywizard.ai',
    `Personal email in profile.email must be overridden, got ${resPersonalOverride?.value}`
  );
  console.log('✅ Personal email in profile.email column is overridden by company email.');

  const veeravalliProfile: any = {
    applywizz_id: 'AWL-28737',
    client_name: 'Sai Lokesh Veeravalli',
    email: 'sai.slv.grad@gmail.com',
    company_email: 'sai.slv.grad@gmail.com',
    raw_api_payload: {
      client: { company_email: 'sai.slv.grad@gmail.com' },
    },
  };

  const resEmail2 = await resolveTier1('AWL-28737', emailField, veeravalliProfile);
  console.log('AWL-28737 email resolved:', resEmail2?.value);
  assert(resEmail2?.value === 'sai.slv.grad@gmail.com', `Expected sai.slv.grad@gmail.com, got ${resEmail2?.value}`);
  console.log('✅ AWL-28737 email verified.');

  // --- Relocation Yes/No in Tier 1 ---
  console.log('\n--- 2. Relocation Yes/No (Tier 1) ---');
  const relocateField: ScannedField = {
    fieldId: 'question_relocate',
    name: 'question_relocate',
    type: 'select',
    label:
      'If you are not based in the same city as the role you have applied for, are you willing to relocate?',
    isRequired: true,
    options: ['Yes', 'No'],
  };

  const resRelocate = await resolveTier1('AWL-36144', relocateField, {
    ...palutlaProfile,
    location: 'Missouri',
    raw_api_payload: {
      ...palutlaProfile.raw_api_payload,
      additional_information: { willing_to_relocate: true },
    },
  });
  console.log('Relocation question resolved:', resRelocate?.value);
  assert(resRelocate?.value === 'Yes', `Expected Yes, got ${resRelocate?.value}`);
  console.log('✅ Relocation question resolves to Yes (not location string).');

  const dallasField: ScannedField = {
    fieldId: 'question_dallas',
    name: 'question_dallas',
    type: 'select',
    label: 'Are you currently located in Dallas, TX, or are you willing to relocate to Dallas, TX?',
    isRequired: true,
    options: ['Yes', 'No'],
  };

  const resDallas = await resolveTier1('AWL-36144', dallasField, {
    ...palutlaProfile,
    location: 'Missouri',
    raw_api_payload: {
      additional_information: { willing_to_relocate: true },
    },
  });
  console.log('Dallas/relocation question resolved:', resDallas?.value);
  assert(
    resDallas?.value === 'Yes' || resDallas?.value === 'No',
    `Expected Yes or No, got ${resDallas?.value}`
  );
  assert(resDallas?.value !== 'Missouri', 'Must not return location string');
  console.log('✅ Dallas/relocation question resolves to Yes or No only.');

  // --- LLM binary detection & coercion ---
  console.log('\n--- 3. Yes/No Detection & Coercion (LLM helpers) ---');
  assert(isBinaryYesNoQuestion(relocateField), 'Relocation field should be binary');
  assert(
    isBinaryYesNoQuestion({
      fieldId: 'q1',
      name: 'q1',
      type: 'select',
      label: 'Do you have experience with Kubernetes?',
      isRequired: true,
      options: ['Yes', 'No'],
    }),
    'Do you have experience should be binary'
  );

  assert(coerceBinaryYesNo('I am confident in my ability to relocate.', relocateField) === 'Yes', 'Prose with willing → Yes');
  assert(coerceBinaryYesNo('Chicago, IL', relocateField) === 'Yes', 'Location string defaults to Yes');
  assert(coerceBinaryYesNo('No, I cannot relocate.', relocateField) === 'No', 'Explicit no → No');

  const synthesizer = new LLMSynthesizer({ apiKey: '' });
  const fallback = (synthesizer as any).generateFallbackAnswer(relocateField, {
    clientName: 'Test',
    location: 'Missouri',
  }, { title: 'Engineer', company: 'TestCo' });
  console.log('Fallback for relocation:', fallback);
  assert(fallback === 'Yes', `Fallback should be Yes, got ${fallback}`);
  console.log('✅ LLM binary helpers and fallback verified.');

  console.log('\n🎉 ALL EMAIL & YES/NO TESTS PASSED!');
}

runVerification().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
