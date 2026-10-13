import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStructuredEeocField } from '../src/resolver/answerResolver.js';
import { resolveFromPayloadStructured } from '../src/resolver/tier1Supabase.js';
import { resolveEeoFallbackOption } from '../src/submitter/formFiller.js';

describe('Demographic Race Matching and EEO Fallback', () => {
  const mockProfile: any = {
    applywizz_id: 'AWL-TEST-DEMO',
    raw_api_payload: {
      demographics: {
        raceEthnicity: 'Asian',
        gender: 'Male',
      },
      additional: {
        race_ethnicity: 'Asian',
        gender: 'Male',
      },
    },
  };

  it('matches "Please identify your race" to candidate race in tier1 payload resolver', () => {
    const val = resolveFromPayloadStructured('Please identify your race', 'select', mockProfile.raw_api_payload);
    assert.equal(val, 'Asian');
  });

  it('matches "Please identify your race/ethnicity" in resolveStructuredEeocField', () => {
    const field: any = {
      fieldId: 'race_field_1',
      name: 'race',
      label: 'Please identify your race',
      type: 'select',
      options: ['Select...', 'Asian', 'Black or African American', 'White', 'Decline to self-identify'],
    };
    const resolved = resolveStructuredEeocField(field, mockProfile, true);
    assert.ok(resolved, 'Expected field to be resolved');
    assert.equal(resolved?.value, 'Asian');
  });

  it('resolveEeoFallbackOption selects decline option when present', () => {
    const options = ['Select...', 'Asian', 'White', 'Decline to self-identify'];
    const chosen = resolveEeoFallbackOption(options);
    assert.equal(chosen, 'Decline to self-identify');
  });

  it('resolveEeoFallbackOption selects "Prefer not to say" when present', () => {
    const options = ['Select...', 'Male', 'Female', 'Prefer not to say'];
    const chosen = resolveEeoFallbackOption(options);
    assert.equal(chosen, 'Prefer not to say');
  });
});
