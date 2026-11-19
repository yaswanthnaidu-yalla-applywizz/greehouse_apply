import test from 'node:test';
import assert from 'node:assert/strict';
import { matchChoiceOption } from '../src/utils/choiceOptions.js';
import {
  matchCorporatePolicy,
  resolveDeterministicPolicy,
} from '../src/resolver/deterministicPolicies.js';
import type { ScannedField } from '../src/types/index.js';
import type { ProfileRow } from '../src/db/profiles.js';

test('Task 1: Dynamic Sanctioned Country Check', () => {
  const field: ScannedField = {
    fieldId: 'export_control_question',
    label: 'Are you located in the following countries: Cuba, Iran, North Korea, Syria, Russia and the Crimea, Donetsk, and Luhansk regions of Ukraine',
    type: 'select',
    options: ['Yes', 'No'],
    isRequired: true,
  };

  const usProfile: Partial<ProfileRow> = {
    applywizz_id: 'AWL-101',
    country: 'United States',
    location: 'Austin, Texas, United States',
  };

  const resolvedUs = matchCorporatePolicy(field, usProfile as ProfileRow);
  assert.equal(resolvedUs, 'No', 'US candidate should be answered "No" for sanctioned countries');

  const cubaProfile: Partial<ProfileRow> = {
    applywizz_id: 'AWL-102',
    country: 'Cuba',
    location: 'Havana, Cuba',
  };

  const resolvedCuba = matchCorporatePolicy(field, cubaProfile as ProfileRow);
  assert.equal(resolvedCuba, 'Yes', 'Candidate from Cuba should be answered "Yes"');
});

test('Task 2: Letter-Prefixed Option Matching (A. / B. / C. / D.)', () => {
  const options = [
    'A. I have built and owned ML systems deployed in production and used by real users',
    'B. I have contributed to ML systems that were deployed in production',
    'C. I have trained or experimented with models, but not deployed to production',
    'D. My experience is primarily coursework, research, or benchmarks',
  ];

  // Single letter "A"
  const matchA = matchChoiceOption('A', options);
  assert.equal(matchA, options[0]);

  // Letter with dot "A."
  const matchADot = matchChoiceOption('A.', options);
  assert.equal(matchADot, options[0]);

  // Letter "B"
  const matchB = matchChoiceOption('B', options);
  assert.equal(matchB, options[1]);

  // Full sentence still matches
  const matchFull = matchChoiceOption(
    'I have built and owned ML systems deployed in production and used by real users',
    options
  );
  assert.equal(matchFull, options[0]);
});

test('Task 3: Standard Work Authorization & Commute Policies', () => {
  const workAuthField: ScannedField = {
    fieldId: 'work_auth_status',
    label: 'What is your current work authorization status?',
    type: 'select',
    options: ['US Citizen', 'Green Card', 'H-1B', 'OPT/CPT', 'TN Visa', 'Other'],
    isRequired: true,
  };

  const h1bProfile: Partial<ProfileRow> = {
    applywizz_id: 'AWL-201',
    requires_sponsorship: true,
    us_work_authorized: true,
    country: 'United States',
  };

  const resolvedH1B = matchCorporatePolicy(workAuthField, h1bProfile as ProfileRow);
  assert.equal(resolvedH1B, 'H-1B');

  const citizenProfile: Partial<ProfileRow> = {
    applywizz_id: 'AWL-202',
    requires_sponsorship: false,
    us_work_authorized: true,
    country: 'United States',
  };

  const resolvedCitizen = matchCorporatePolicy(workAuthField, citizenProfile as ProfileRow);
  assert.equal(resolvedCitizen, 'US Citizen');

  const commuteField: ScannedField = {
    fieldId: 'commute_midtown',
    label: 'Are you comfortable commuting to our Midtown office location three days a week?',
    type: 'select',
    options: ['Yes', 'No'],
    isRequired: true,
  };

  const resolvedCommute = matchCorporatePolicy(commuteField, citizenProfile as ProfileRow);
  assert.equal(resolvedCommute, 'Yes');
});

test('Task 4: Numbered Work Experience (1)-(3) & Compliance Defaults', () => {
  const profile: Partial<ProfileRow> = {
    applywizz_id: 'AWL-301',
    work_experience: [
      { company: 'Google', title: 'Senior Software Engineer', duration: '2021 - Present' },
      { company: 'Meta', title: 'Software Engineer', duration: '2019 - 2021' },
      { company: 'Amazon', title: 'SDE Intern', duration: '2018 - 2019' },
    ] as any,
  };

  const emp1Field: ScannedField = {
    fieldId: 'employer_1',
    label: 'Please provide the name of your most recent employer (1)',
    type: 'text',
    isRequired: true,
  };
  assert.equal(matchCorporatePolicy(emp1Field, profile as ProfileRow), 'Google');

  const title2Field: ScannedField = {
    fieldId: 'title_2',
    label: 'Job title (2)',
    type: 'text',
    isRequired: true,
  };
  assert.equal(matchCorporatePolicy(title2Field, profile as ProfileRow), 'Software Engineer');

  const militaryField: ScannedField = {
    fieldId: 'military_service',
    label: 'Have you ever served in the U.S. Armed Forces? If yes, list duties...',
    type: 'textarea',
    isRequired: true,
  };
  assert.equal(matchCorporatePolicy(militaryField, profile as ProfileRow), 'N/A');

  const overtimeField: ScannedField = {
    fieldId: 'overtime_willing',
    label: 'Are you willing to work overtime if necessary?',
    type: 'select',
    options: ['Yes', 'No'],
    isRequired: true,
  };
  assert.equal(matchCorporatePolicy(overtimeField, profile as ProfileRow), 'Yes');
});

test('Task 5: Ashby SMS Radio Detection', () => {
  const smsRadioField: ScannedField = {
    fieldId: '15a4235c-6d32-471b-9b91-24aa7f3141a1',
    label: 'Phone',
    type: 'radio',
    options: [
      'Yes - I consent to receiving SMS text messages',
      'No - I do not consent to receiving SMS text messages',
      'Yes - I consent to receiving WhatsApp messages',
      'No - I do not consent to receiving WhatsApp messages',
    ],
    isRequired: true,
  };

  const resolved = matchCorporatePolicy(smsRadioField);
  assert.equal(resolved, 'Yes - I consent to receiving SMS text messages');
});
