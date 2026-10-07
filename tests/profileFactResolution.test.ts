import { resolveTier3 } from '../src/resolver/tier3FuzzyMatch.js';
import { bestSemanticProfileFact } from '../src/resolver/semanticSearch.js';
import { getProfileFacts } from '../src/resolver/profileFacts.js';
import type { ProfileRow } from '../src/db/profiles.js';
import type { ScannedField } from '../src/types/index.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST',
    client_name: 'Test Candidate',
    work_authorization: 'Authorized to work in the United States',
    raw_api_payload: {
      client: {
        sponsorship_required: false,
      },
    },
  };
  const facts = getProfileFacts(profile);
  assert(
    facts.some((fact) => fact.label === 'work authorization'),
    'profile columns are available as semantic facts'
  );
  assert(
    facts.some((fact) => fact.label === 'client sponsorship required' && fact.value === 'false'),
    'nested raw payload scalars retain their key path and value'
  );
  assert(
    !facts.some((fact) => fact.label.includes('applywizz id')),
    'candidate identifiers are not searchable profile facts'
  );

  const bestFact = bestSemanticProfileFact(
    [1, 0],
    [
      { label: 'work authorization', value: 'yes' },
      { label: 'candidate name', value: 'Test Candidate' },
    ],
    [[0.9, 0.1], [0, 1]],
    0.82
  );
  assert(bestFact?.fact.value === 'yes', 'Tier 3 selects the closest profile-fact embedding');
  assert(
    bestSemanticProfileFact([1, 0], [{ label: 'candidate name', value: 'x' }], [[0, 1]], 0.82) === null,
    'Tier 3 rejects profile-fact embeddings below threshold'
  );

  const field: ScannedField = {
    fieldId: 'work_auth',
    name: 'work_auth',
    type: 'text',
    label: 'Work authorization',
    isRequired: true,
  };
  const fuzzyMatch = await resolveTier3(
    'AWL-TEST',
    field,
    [{
      applywizz_id: 'AWL-TEST',
      question_fingerprint: 'test-fingerprint',
      question_label: 'Work authorization',
      field_type: 'text',
      value: 'QA bank answer',
      source: 'manual',
    }],
    profile
  );
  assert(fuzzyMatch?.value === profile.work_authorization, 'Tier 4 prefers profile facts to QA-bank matches');
  assert(fuzzyMatch?.resolvedByTier === 4, 'Tier 4 profile-fact result is tagged as Tier 4');

  const choiceFallback = await resolveTier3(
    'AWL-TEST',
    { ...field, type: 'select', options: ['QA option', 'Other'] },
    [{
      applywizz_id: 'AWL-TEST',
      question_fingerprint: 'test-choice-fingerprint',
      question_label: 'Work authorization',
      field_type: 'select',
      value: 'QA option',
      source: 'manual',
    }],
    profile
  );
  assert(
    choiceFallback?.value === 'QA option',
    'Tier 4 falls back to the QA bank when a profile fact cannot align to current options'
  );

  const qaFallback = await resolveTier3(
    'AWL-TEST',
    { ...field, label: 'Notice period' },
    [{
      applywizz_id: 'AWL-TEST',
      question_fingerprint: 'test-fingerprint',
      question_label: 'Notice period',
      field_type: 'text',
      value: '30 days',
      source: 'manual',
    }],
    { applywizz_id: 'AWL-TEST', client_name: 'Unrelated Candidate' }
  );
  assert(qaFallback?.value === '30 days', 'Tier 4 falls back to QA-bank answers after profile facts miss');

  console.log('Profile-fact resolution tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
