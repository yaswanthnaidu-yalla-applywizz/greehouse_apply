import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFieldIntent, isEvidenceCompatible } from '../src/resolver/fieldIntent.js';
import { resolveTier3, setFuzzyMatchingEnabled } from '../src/resolver/tier3FuzzyMatch.js';
import { findSemanticMatch, bestSemanticProfileFact } from '../src/resolver/semanticSearch.js';
import type { ScannedField } from '../src/types/index.js';
import type { ProfileRow } from '../src/db/profiles.js';

test('employer history questions reject company email and accept employer evidence', async () => {
  const field: ScannedField = {
    fieldId: 'current_company',
    name: 'current_company',
    type: 'text',
    label: 'Current Company',
    isRequired: true,
  };
  const intent = classifyFieldIntent(field);
  assert.equal(intent.family, 'employer_history');

  assert.equal(
    isEvidenceCompatible(intent, { kind: 'profile_fact', key: 'company_email', value: 'alice@corp.com' }),
    false,
    'company_email must be incompatible with employer_history'
  );
  assert.equal(
    isEvidenceCompatible(intent, { kind: 'profile_fact', key: 'current_company', value: 'Acme Corp' }),
    true,
    'current_company must be compatible with employer_history'
  );

  const profile: ProfileRow = {
    applywizz_id: 'CAND_1',
    company_email: 'alice@corp.com',
    current_company: 'Acme Corp',
  };

  const resolved = await resolveTier3('CAND_1', field, [], profile);
  assert.ok(resolved);
  assert.notEqual(resolved.value, 'alice@corp.com');
  assert.equal(resolved.value, 'Acme Corp');
});

test('incompatible QA bank entries are filtered before scoring', async () => {
  const field: ScannedField = {
    fieldId: 'current_company',
    name: 'current_company',
    type: 'text',
    label: 'Current Employer',
    isRequired: true,
  };

  const qaEntries = [
    {
      id: '1',
      applywizz_id: 'CAND_1',
      question_fingerprint: 'fp1',
      question_label: 'Current Company Email Address',
      field_type: 'text',
      value: 'alice@acme.com',
      source: 'manual' as const,
    },
  ];

  const resolved = await resolveTier3('CAND_1', field, qaEntries as any, null);
  assert.equal(resolved, null, 'Email QA entry must not resolve employer question');
});

test('URL and non-URL facts do not overlap across families', () => {
  const urlField: ScannedField = {
    fieldId: 'linkedin_url',
    name: 'linkedin_url',
    type: 'text',
    label: 'LinkedIn Profile URL',
    isRequired: true,
  };
  const urlIntent = classifyFieldIntent(urlField);

  const textFact = { kind: 'profile_fact', key: 'first_name', value: 'Alice' };
  assert.equal(isEvidenceCompatible(urlIntent, textFact), false);

  const nonUrlField: ScannedField = {
    fieldId: 'first_name',
    name: 'first_name',
    type: 'text',
    label: 'First Name',
    isRequired: true,
  };
  const nonUrlIntent = classifyFieldIntent(nonUrlField);
  const urlFact = { kind: 'profile_fact', key: 'linkedin_url', value: 'https://linkedin.com/in/alice' };
  assert.equal(isEvidenceCompatible(nonUrlIntent, urlFact), false);
});

test('residence and workplace preferences do not overlap', () => {
  const residenceField: ScannedField = {
    fieldId: 'residence_city',
    name: 'residence_city',
    type: 'text',
    label: 'Current City of Residence',
    isRequired: true,
  };
  const resIntent = classifyFieldIntent(residenceField);
  assert.equal(isEvidenceCompatible(resIntent, { kind: 'job_posting_location', value: 'New York, NY' }), false);

  const workplaceField: ScannedField = {
    fieldId: 'office_location',
    name: 'office_location',
    type: 'select',
    label: 'Office Location Preference',
    isRequired: true,
  };
  const workIntent = classifyFieldIntent(workplaceField);
  assert.equal(isEvidenceCompatible(workIntent, { kind: 'job_posting_location', value: 'New York, NY' }), true);
});

test('Fuse candidates that tie or remain weak are rejected', async () => {
  setFuzzyMatchingEnabled(true);
  try {
    const field: ScannedField = {
      fieldId: 'job_title',
      name: 'job_title',
      type: 'text',
      label: 'Software Engineer Specialty',
      isRequired: true,
    };

    const tiedEntries = [
      {
        id: '1',
        applywizz_id: 'CAND_1',
        question_fingerprint: 'fp1',
        question_label: 'Software Engineer Area A',
        field_type: 'text',
        value: 'Backend',
        source: 'manual' as const,
      },
      {
        id: '2',
        applywizz_id: 'CAND_1',
        question_fingerprint: 'fp2',
        question_label: 'Software Engineer Area B',
        field_type: 'text',
        value: 'Frontend',
        source: 'manual' as const,
      },
    ];

    const resolved = await resolveTier3('CAND_1', field, tiedEntries as any, null);
    assert.equal(resolved, null, 'Tied candidates must be rejected');
  } finally {
    setFuzzyMatchingEnabled(false);
  }
});

