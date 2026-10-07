import type { ProfileRow } from '../src/db/profiles.js';
import { scannedFieldsToResolvedShells } from '../src/db/applicationFieldHydration.js';
import {
  isUnsupportedUuidAnswer,
  resolveAvailabilityField,
  resolvePreTierField,
} from '../src/resolver/answerResolver.js';
import { resolveTier1, resolveFromPayloadStructured } from '../src/resolver/tier1Supabase.js';
import { resolveTier2 } from '../src/resolver/tier2ResumeParse.js';
import { resolveTier3 } from '../src/resolver/tier3FuzzyMatch.js';
import {
  getEffectiveFieldOptions,
  LLMSynthesizer,
  parseBatchAnswerResponse,
} from '../src/resolver/llmSynthesizer.js';
import { buildQuestionRelevantEvidence, extractResumePhone } from '../src/resolver/candidateEvidence.js';
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
    null,
    'country fields continue to Tier 1 resolution'
  );
  const profileWithoutCountry: ProfileRow = {
    applywizz_id: 'AWL-TEST',
    client_name: 'Test Candidate',
  };
  const unresolvedCountry = resolvePreTierField(countryField, profileWithoutCountry, true);
  assertEqual(unresolvedCountry?.value || null, null, 'missing country remains unresolved');
  assertEqual(
    unresolvedCountry?.source || null,
    null,
    'missing country continues through the tier waterfall'
  );
  assertEqual(
    resolvePreTierField(
      makeField({
        fieldId: 'country',
        name: 'country',
        label: 'Will you need sponsorship for the country you are applying in?',
      }),
      countryProfile,
      true
    ),
    null,
    'country mentions in sponsorship questions are not treated as country fields'
  );
  assertEqual(
    (await resolveTier1('AWL-TEST', countryField, profileWithoutCountry))?.value || null,
    null,
    'Tier 1 does not infer a country when the profile country is missing'
  );
  assertEqual(
    (
      await resolveTier1('AWL-TEST', countryField, {
        ...profileWithoutCountry,
        raw_api_payload: { additional_information: { zip_or_country: 'United States' } },
      })
    )?.value || null,
    'United States of America',
    'Tier 1 option-matches country from additional_information.zip_or_country'
  );
  assertEqual(
    (
      await resolveTier1(
        'AWL-TEST',
        { ...countryField, options: ['Canada'] },
        {
          ...profileWithoutCountry,
          raw_api_payload: { additional_information: { zip_or_country: 'United States' } },
        }
      )
    )?.value || null,
    null,
    'Tier 1 country remains unresolved when payload country has no option match'
  );
  assertEqual(
    (
      await resolveTier1(
        'AWL-TEST',
        countryField,
        {
          ...profileWithoutCountry,
          raw_api_payload: { additional_information: { zip_or_country: 'India' } },
        }
      )
    )?.value || null,
    'India',
    'Tier 1 option-matches India from additional_information.zip_or_country'
  );
  assertEqual(
    (
      await resolveTier1('AWL-TEST', countryField, {
        ...profileWithoutCountry,
        country: 'India',
        raw_api_payload: { additional_information: { zip_or_country: 'United States' } },
      })
    )?.value || null,
    'United States of America',
    'Tier 1 prefers zip_or_country over a conflicting profile country'
  );
  const countryEvidence = buildQuestionRelevantEvidence(
    countryField,
    {
      raw_api_payload: {
        additional_information: { zip_or_country: 'United States', unrelated_payload_field: 'Do not send' },
      },
    }
  );
  assertEqual(
    countryEvidence.includes('zip_or_country: United States'),
    true,
    'country evidence exposes the raw zip_or_country candidate answer to Tier 5'
  );
  assertEqual(
    countryEvidence.includes('Do not send'),
    false,
    'country Tier 5 evidence excludes unrelated raw payload fields'
  );
  assertEqual(
    (
      await resolveTier1(
        'AWL-TEST',
        { ...countryField, options: ['Canada'], optionsComplete: false },
        {
          ...profileWithoutCountry,
          raw_api_payload: { additional_information: { zip_or_country: 'United States' } },
        }
      )
    )?.value || null,
    null,
    'Tier 1 does not accept an unmatched country when options are incomplete'
  );
  assertEqual(
    (await resolveTier1('AWL-YASWANTH', countryField, {
      applywizz_id: 'AWL-YASWANTH',
      client_name: 'Yaswanth Naidu Yalla',
    }))?.value || null,
    null,
    'Tier 1 does not infer India from a candidate ID'
  );
  const phoneField = makeField({
    fieldId: 'phone',
    name: 'phone',
    label: 'Phone Number',
  });
  const resumeFacts = {
    rawSections: {
      summary: 'DEVI VARAPRASAD BOLISETTY\nBUSINESS ANALYST\n+1 312 536 7337 | devivaraprasad.bolisetty@applywizard.ai | LinkedIn',
    },
  };
  assertEqual(
    extractResumePhone(resumeFacts),
    '3125367337',
    'resume contact-header extraction strips the international calling prefix'
  );
  assertEqual(
    extractResumePhone({
      rawSections: { summary: 'Candidate Name\n+91 98765 43210 | candidate@example.com' },
    }),
    '9876543210',
    'resume phone extraction strips a non-US international calling prefix'
  );
  assertEqual(
    await resolveTier1('AWL-TEST', phoneField, {
      applywizz_id: 'AWL-TEST',
      client_name: 'Test Candidate',
      phone: '+1 773 555 0199',
      resume_facts: { rawSections: {} },
    }),
    null,
    'Tier 1 never substitutes the profile phone for resume evidence'
  );
  const tier2Phone = await resolveTier2('AWL-TEST', phoneField, {
    applywizz_id: 'AWL-TEST',
    raw_text: resumeFacts.rawSections.summary,
    structured: resumeFacts,
  });
  assertEqual(tier2Phone?.value || null, '3125367337', 'Tier 2 resolves phone from resume facts');

  const availabilityField = makeField({
    label: 'Date Available to Start?',
    metadata: { expectedDateFormat: 'DD/MM/YYYY' },
  });
  assertEqual(
    resolveAvailabilityField(availabilityField, true, new Date('2026-10-07T23:59:00-07:00'))?.value || null,
    '15/10/2026',
    'availability date is seven UTC calendar days from the application date in the captured format'
  );
  assertEqual(
    resolveAvailabilityField(
      makeField({ label: 'Start Date', type: 'date', metadata: { inputType: 'date' } }),
      true,
      new Date('2026-10-07T23:59:00-07:00')
    )?.value || null,
    '2026-10-15',
    'native date controls receive the ISO calendar date'
  );
  assertEqual(
    resolveAvailabilityField(
      makeField({
        label: 'When can you start?',
        type: 'select',
        options: ['Immediately', 'Within 3 weeks', 'In 1 week', 'In 2 weeks'],
      }),
      true
    )?.value || null,
    'In 1 week',
    'availability dropdown prefers its unique one-week choice'
  );
  assertEqual(
    resolveAvailabilityField(
      makeField({
        label: 'When can you start?',
        type: 'select',
        options: ['Immediately', 'Within 3 weeks', 'In 2 weeks'],
      }),
      true
    )?.value || null,
    'Within 3 weeks',
    'ambiguous week choices use the first listed option after Immediately'
  );
  assertEqual(
    matchChoiceOption('United States', ['U.S.']),
    'U.S.',
    'country matcher recognizes the punctuated U.S. alias'
  );
  assertEqual(
    parseBatchAnswerResponse('Here are the answers:\n```json\n["yes", "Canada"]\n```\nDone.', 2)?.join('|') || null,
    'yes|Canada',
    'Tier 5 batch parser extracts a valid JSON array wrapped in prose and markdown'
  );
  assertEqual(
    parseBatchAnswerResponse('not valid JSON', 2),
    null,
    'Tier 5 batch parser rejects malformed output instead of treating prose as an answer'
  );
  assertEqual(
    isUnsupportedUuidAnswer(
      makeField({ label: 'Additional Information' }),
      'c5df6fcd-ad8a-462a-a4f0-fa49e4a05a81'
    ),
    true,
    'UUID-like values are rejected for generic fields'
  );
  assertEqual(
    isUnsupportedUuidAnswer(
      makeField({ label: 'Candidate ID' }),
      'c5df6fcd-ad8a-462a-a4f0-fa49e4a05a81'
    ),
    false,
    'UUID-like values remain valid when a field explicitly requests an identifier'
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
  const dateShell = scannedFieldsToResolvedShells([
    makeField({
      fieldId: 'available_date',
      name: 'available_date',
      label: 'Date Available to Start?',
      metadata: { inputType: 'date', expectedDateFormat: 'YYYY-MM-DD' },
    }),
  ])[0];
  assertEqual(
    dateShell.metadata?.expectedDateFormat || null,
    'YYYY-MM-DD',
    'hydrated unresolved shells retain scanned date-format metadata'
  );
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
    null,
    'country fields defer to Tier 1 even when captured options are incomplete'
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
  assertEqual(
    resolveFromPayloadStructured('start date year', 'text', {
      additional_information: { desired_start_date: '1927-01-05' },
    }),
    null,
    'availability date payload is not copied into a month/year date component'
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
      makeField({ type: 'select', label: 'Start date year', options: ['2020', '2021', '2022'] }),
      profile
    ))?.value || null,
    '2020',
    'start-date year fields use the candidate education year, not a full desired-start date'
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
