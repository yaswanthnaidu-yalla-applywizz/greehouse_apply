import { describe, it, expect } from 'vitest';
import { resolvePreTierField } from '../src/resolver/answerResolver.js';
import type { ScannedField } from '../src/types/index.js';

describe('Agreements, AI Policy & Onsite Willingness Rules', () => {
  it('resolves agreement option for "Please read the arbitration agreement below"', () => {
    const field: ScannedField = {
      fieldId: 'q_arbitration',
      name: 'q_arbitration',
      type: 'select',
      label: 'Please read the arbitration agreement below',
      options: ['I will read the arbitration agreement below.'],
      isRequired: true,
    };
    const res = resolvePreTierField(field, null, true);
    expect(res).not.toBeNull();
    expect(res?.value).toBe('I will read the arbitration agreement below.');
  });

  it('resolves Yes for "AI Policy for Application"', () => {
    const field: ScannedField = {
      fieldId: 'q_aipolicy',
      name: 'q_aipolicy',
      type: 'select',
      label: 'AI Policy for Application',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolvePreTierField(field, null, true);
    expect(res).not.toBeNull();
    expect(res?.value).toBe('Yes');
  });

  it('resolves Yes for onsite / in-person office willingness', () => {
    const field: ScannedField = {
      fieldId: 'q_onsite',
      name: 'q_onsite',
      type: 'select',
      label: 'Are you open to working in-person in one of our offices 25% of the time?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolvePreTierField(field, null, true);
    expect(res).not.toBeNull();
    expect(res?.value).toBe('Yes');
  });

  it('resolves Yes for 5-days office willingness', () => {
    const field: ScannedField = {
      fieldId: 'q_office5',
      name: 'q_office5',
      type: 'select',
      label: 'Are you willing to work in the office 5-days a week?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolvePreTierField(field, null, true);
    expect(res).not.toBeNull();
    expect(res?.value).toBe('Yes');
  });

  it('resolves Yes for PitchBook onsite compliance', () => {
    const field: ScannedField = {
      fieldId: 'q_pitchbook',
      name: 'q_pitchbook',
      type: 'select',
      label: 'PitchBook is an office-first environment. Most roles are expected to be onsite full-time. Are you able to comply with onsite expectations?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolvePreTierField(field, null, true);
    expect(res).not.toBeNull();
    expect(res?.value).toBe('Yes');
  });

  it('resolves Yes for "work from our office in Union Square" (iCapital pattern)', () => {
    const field: ScannedField = {
      fieldId: 'q_icapital_office',
      name: 'q_icapital_office',
      type: 'select',
      label: 'Will you be able to work from our office in Union Square, NYC?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolvePreTierField(field, null, true);
    expect(res).not.toBeNull();
    expect(res?.value).toBe('Yes');
  });

  it('resolves Yes for "in-office expectation" schedule confirmation', () => {
    const field: ScannedField = {
      fieldId: 'q_inoffice_exp',
      name: 'q_inoffice_exp',
      type: 'select',
      label: 'This role has a 5 days in-office expectation. Are you comfortable with this?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolvePreTierField(field, null, true);
    expect(res).not.toBeNull();
    expect(res?.value).toBe('Yes');
  });

  it('resolves Yes for "3 times per week in the office" hybrid schedule', () => {
    const field: ScannedField = {
      fieldId: 'q_hybrid_3x',
      name: 'q_hybrid_3x',
      type: 'select',
      label: 'Are you able to work from our NYC office (Three World Trade Center) 3 times per week in the office?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolvePreTierField(field, null, true);
    expect(res).not.toBeNull();
    expect(res?.value).toBe('Yes');
  });

  it('resolves Yes for "office-first culture" schedule confirmation', () => {
    const field: ScannedField = {
      fieldId: 'q_office_first',
      name: 'q_office_first',
      type: 'select',
      label: 'iCapital is an office-first culture. Are you comfortable with this schedule?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolvePreTierField(field, null, true);
    expect(res).not.toBeNull();
    expect(res?.value).toBe('Yes');
  });
});
