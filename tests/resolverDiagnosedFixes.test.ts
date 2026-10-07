import type { ProfileRow } from '../src/db/profiles.js';
import { scannedFieldsToResolvedShells } from '../src/db/applicationFieldHydration.js';
import { resolvePreTierField } from '../src/resolver/answerResolver.js';
import { resolveTier1, resolveFromPayloadStructured } from '../src/resolver/tier1Supabase.js';
import { resolveTier3 } from '../src/resolver/tier3FuzzyMatch.js';
import { getEffectiveFieldOptions, LLMSynthesizer } from '../src/resolver/llmSynthesizer.js';
import { buildPayloadContext } from '../src/resolver/profileAdapter.js';
import { normalizeText } from '../src/resolver/fingerprint.js';
import { matchChoiceOption } from '../src/utils/choiceOptions.js';
import type { ScannedField } from '../src/types/index.js';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function makeField(overrides: Partial<ScannedField>): ScannedField {
  return {
    fieldId: 'field',
    name: 'field',
    type: 'text',
    label: 'Field',
    isRequired: true,
    ...overrides,
  };
}

async function run(): Promise<void> {
  const countryField = makeField({
    fieldId: 'country',
    name: 'country',
    type: 'select',
    label: 'Country',
    options: ['United States of America', 'India'],
  });
  const countryProfile: ProfileRow = {
    applywizz_id: 'AWL-TEST',
    client_name: 'Test Candidate',
    country: 'United States',
  };
  assertEqual(
    resolvePreTierField(countryField, countryProfile, true)?.value || null,
    'United States of America',
    'country pre-tier uses profile country and aliases'
  );
  assertEqual(
    matchChoiceOption('United States', ['U.S.']),
    'U.S.',
    'country matcher recognizes the punctuated U.S. alias'
  );
  assertEqual(
    resolvePreTierField(
      makeField({ label: 'Do you agree to the restrictive covenant?' }),
      countryProfile,
      true
    ),
    null,
    'pre-tier consent skips interrogative restrictive-covenant questions'
  );
  assertEqual(
    resolvePreTierField(
      makeField({ label: 'This agreement covers restrictive covenants.' }),
      countryProfile,
      true
    ),
    null,
    'pre-tier does not treat agreement as a first-person declaration'
  );
  assertEqual(
    resolvePreTierField(
      makeField({
        type: 'radio',
        label: 'I acknowledge that all information is accurate.',
        options: ['Yes', 'No'],
      }),
      countryProfile,
      true
    )?.value || null,
    'Yes',
    'pre-tier resolves explicit first-person declarations'
  );

  assertEqual(
    getEffectiveFieldOptions(
      makeField({ type: 'select', label: 'What is your gender identity?' })
    ),
    undefined,
    'option-less rich EEOC identity fields do not get fabricated binary options'
  );
  assertEqual(
    getEffectiveFieldOptions(
      makeField({ type: 'select', label: 'Are you authorized to work in the United States?' })
    )?.join('|') || null,
    'Yes|No',
    'label-identified binary questions retain effective options'
  );
  assertEqual(
    getEffectiveFieldOptions(
      makeField({ type: 'select', label: 'Are you Hispanic or Latino?' })
    )?.join('|') || null,
    'Yes|No',
    'Hispanic/Latino binary questions retain their effective choices'
  );
  const partialSchoolField = makeField({
    fieldId: 'school',
    name: 'school',
    type: 'select',
    label: 'School',
    options: ['Captured School'],
    optionsComplete: false,
  });
  assertEqual(
    getEffectiveFieldOptions(partialSchoolField),
    undefined,
    'partial captured choice lists are not treated as exhaustive'
  );
  const partialChoiceShell = scannedFieldsToResolvedShells([partialSchoolField])[0];
  assertEqual(partialChoiceShell.type, 'select', 'hydrated incomplete choice keeps its true select type');
  assertEqual(partialChoiceShell.optionsComplete, false, 'hydration retains incomplete option metadata');
  assertEqual(
    resolvePreTierField(
      makeField({
        type: 'select',
        label: 'Country',
        options: ['Canada'],
        optionsComplete: false,
      }),
      { applywizz_id: 'AWL-TEST', client_name: 'Test Candidate', country: 'United States' },
      true
    )?.value || null,
    'United States',
    'pre-tier answer is preserved when the captured options are incomplete'
  );
  assertEqual(
    getEffectiveFieldOptions(makeField({ type: 'select', label: 'Please select your ethnicity' })),
    undefined,
    'rich ethnicity identity fields remain without fabricated choices'
  );

  const degreeLabel = normalizeText('Do you have a Masters or PhD in Engineering?');
  assertEqual(
    resolveFromPayloadStructured(degreeLabel, 'radio', null, ['Yes', 'No'], [
      { degree: 'Master of Science', fieldOfStudy: 'Engineering' },
    ]),
    'Yes',
    'binary degree question matches candidate education'
  );
  assertEqual(
    resolveFromPayloadStructured(degreeLabel, 'radio', null, ['Yes', 'No'], [
      { degree: 'Master of Science', fieldOfStudy: 'Computer Science' },
    ]),
    'No',
    'binary degree question rejects a different subject'
  );
  assertEqual(
    resolveFromPayloadStructured(degreeLabel, 'radio', null, ['Yes', 'No'], [
      { degree: 'Master of Science', fieldOfStudy: 'Computer Science' },
      { degree: 'Master of Engineering', fieldOfStudy: 'Engineering' },
    ]),
    'No',
    'binary degree question uses the first education record'
  );
  assertEqual(
    resolveFromPayloadStructured(degreeLabel, 'radio', null, ['Engineering', 'Computer Science'], [
      { degree: 'Master of Science', fieldOfStudy: 'Engineering' },
    ]),
    null,
    'two arbitrary choices are not treated as Yes/No'
  );
  assertEqual(
    resolveFromPayloadStructured('state', 'text', {
      additional_information: { state_of_residence: 'Austin, TX' },
    }),
    'Texas',
    'state-of-residence payload extracts and expands state abbreviation'
  );

  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST',
    client_name: 'Test Candidate',
    raw_api_payload: {
      additional_information: { githubUrl: 'github.com/test-candidate' },
    },
    education: [
      {
        degree: 'Master of Science',
        fieldOfStudy: 'Engineering',
        startDate: '2020-09-01',
        endDate: '2023-05-10',
        graduationYear: '2023',
      },
    ],
  };
  const llmProfile = {
    applywizzId: 'AWL-TEST',
    clientName: 'Test Candidate',
    firstName: 'Test',
    lastName: 'Candidate',
    email: '',
    phone: '',
    location: '',
    linkedinUrl: '',
    workAuthorization: '',
    requiresSponsorship: false,
    education: [],
    workExperience: [],
    resumeUrl: '',
    localResumePath: '',
  };
  const llm = new LLMSynthesizer({ provider: 'openai', apiKey: 'test' });
  const incompleteChoiceAnswer = llm.finalizeRawAnswer(
    '{"answer":"Captured School (full answer)","confidence":0.9}',
    partialSchoolField,
    llmProfile,
    { title: 'Engineer', company: 'Example' }
  );
  assertEqual(
    incompleteChoiceAnswer.value,
    'Captured School (full answer)',
    'LLM answer for incomplete select is not forced to match partial sample options'
  );
  assertEqual(incompleteChoiceAnswer.source, 'ai', 'supported incomplete-choice answer remains resolved');
  assertEqual(
    llm.finalizeRawAnswer(
      '{"answer":"NONE","confidence":0.9}',
      partialSchoolField,
      llmProfile,
      { title: 'Engineer', company: 'Example' }
    ).source,
    'unresolved',
    'unsupported incomplete-choice answers remain unresolved'
  );

  const combinedProfileField = makeField({
    label: 'LinkedIn or Github Profile',
    name: 'profile_url',
  });
  assertEqual(
    (await resolveTier1('AWL-TEST', combinedProfileField, profile))?.value || null,
    'https://github.com/test-candidate',
    'combined LinkedIn/GitHub label falls back to GitHub payload URL'
  );
  assertEqual(
    (await resolveTier1(
      'AWL-TEST',
      combinedProfileField,
      { ...profile, linkedin_url: 'linkedin.com/in/test-candidate' }
    ))?.value || null,
    'https://linkedin.com/in/test-candidate',
    'combined LinkedIn/GitHub label prefers a populated LinkedIn column'
  );
  assertEqual(
    (await resolveTier1(
      'AWL-TEST',
      makeField({ label: 'Portfolio URL' }),
      {
        applywizz_id: 'AWL-TEST',
        client_name: 'Test Candidate',
        raw_api_payload: { additional_information: { portfolio_url: 'portfolio.example.com' } },
      }
    ))?.value || null,
    'https://portfolio.example.com',
    'portfolio resolution falls back to the matching payload URL key'
  );
  assertEqual(
    (await resolveTier1(
      'AWL-TEST',
      makeField({
        type: 'select',
        label: 'Start Month',
        options: ['January', 'August', 'September', 'October'],
      }),
      profile
    ))?.value || null,
    'September',
    'education start month aligns with scanned month options'
  );
  assertEqual(
    (await resolveTier1(
      'AWL-TEST',
      makeField({ type: 'select', label: 'Graduation Year', options: ['2022', '2023', '2024'] }),
      profile
    ))?.value || null,
    '2023',
    'education graduation year aligns with scanned year options'
  );
  assertEqual(
    (await resolveTier1(
      'AWL-TEST',
      makeField({ type: 'select', label: 'State' }),
      { applywizz_id: 'AWL-TEST', client_name: 'Test Candidate', location: 'Dallas, TX' }
    ))?.value || null,
    'Texas',
    'state field extracts profile location state'
  );
  assertEqual(
    buildPayloadContext(profile).education.start_date,
    '2020-09-01',
    'payload context includes first education start date'
  );

  const urlAnswer = 'https://example.com/profile';
  const cachedAnswer = {
    applywizz_id: 'AWL-TEST',
    question_fingerprint: '1234567890abcdef',
    question_label: 'What is your work authorization?',
    field_type: 'text',
    value: urlAnswer,
    source: 'ai' as const,
  };
  assertEqual(
    await resolveTier3(
      'AWL-TEST',
      makeField({ label: 'What is your work authorization?' }),
      [cachedAnswer]
    ),
    null,
    'Tier 4 rejects URL answers for non-URL labels'
  );
  assertEqual(
    (await resolveTier3(
      'AWL-TEST',
      makeField({ label: 'What is your LinkedIn profile?' }),
      [{ ...cachedAnswer, question_label: 'What is your LinkedIn profile?' }]
    ))?.value || null,
    urlAnswer,
    'Tier 4 retains URLs for profile labels'
  );
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
