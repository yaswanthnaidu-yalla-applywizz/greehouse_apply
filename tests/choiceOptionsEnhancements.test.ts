import { describe, it, expect } from 'vitest';
import { matchChoiceOption } from '../src/utils/choiceOptions.js';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import type { ScannedField } from '../src/types/index.js';
import type { ProfileRow } from '../src/db/profiles.js';

describe('ChoiceOptions Enhancements', () => {
  it('correctly maps visa sponsorship text to Yes in binary choice options', () => {
    const options = ['Yes', 'No'];
    expect(matchChoiceOption('F1 STEM OPT (requires sponsorship in the future)', options)).toBe('Yes');
    expect(matchChoiceOption('Yes, require sponsorship', options)).toBe('Yes');
    expect(matchChoiceOption('F-1 OPT', options)).toBe('Yes');
    expect(matchChoiceOption('Will require H1-B sponsorship', options)).toBe('Yes');
  });

  it('correctly maps US state name to ISO/prefixed state codes (e.g. USA-MO)', () => {
    const options = ['BRA', 'CAN-ON', 'USA-CA', 'USA-NY', 'USA-MO', 'USA-TX'];
    expect(matchChoiceOption('Missouri', options)).toBe('USA-MO');
    expect(matchChoiceOption('MO', options)).toBe('USA-MO');
    expect(matchChoiceOption('California', options)).toBe('USA-CA');
    expect(matchChoiceOption('Texas', options)).toBe('USA-TX');
  });

  it('disambiguates duplicate prefix matches for referral sources by preferring job post', () => {
    const options = [
      'Careers Fair',
      'Employee referral',
      'Glassdoor',
      'LinkedIn (Job post)',
      'LinkedIn (Post/Feed)',
      'Other',
    ];
    expect(matchChoiceOption('LinkedIn', options)).toBe('LinkedIn (Job post)');
  });

  it('matches relocation choices even when employer options contain slight typos', () => {
    const options = ['Yes', 'No', "No, but I'm wiling to relocate"];
    expect(matchChoiceOption("No, but I'm willing to relocate", options)).toBe("No, but I'm wiling to relocate");
  });
});

describe('Tier 1 Location Bleed Prevention & File Handling', () => {
  const mockProfile: ProfileRow = {
    applywizz_id: 'AWL-TEST',
    first_name: 'John',
    last_name: 'Doe',
    email: 'john@example.com',
    phone: '+1 555-123-4567',
    location: 'Kansas City, MO, United States',
    created_at: new Date(),
    updated_at: new Date(),
  };

  const exec = { mode: 'evaluation' } as any;

  it('does NOT bleed Missouri/location into drug screening or statement of disclosure', async () => {
    const drugScreenField: ScannedField = {
      fieldId: 'drug_screen_1',
      name: 'drug_screen',
      label: '24-hour drug screening consent required by state and federal laws',
      type: 'select',
      isRequired: true,
      options: ['Yes', 'No'],
    };

    const res = await resolveTier1('AWL-TEST', drugScreenField, mockProfile, exec);
    expect(res?.value).not.toBe('Missouri');
    expect(res?.value).not.toBe('Kansas City, MO, United States');
  });

  it('does NOT bleed Missouri into company disclosure / relation questions mentioning state', async () => {
    const disclosureField: ScannedField = {
      fieldId: 'disclosure_1',
      name: 'disclosure',
      label: 'Statement of disclosure: Are you related to any employee in this state?',
      type: 'select',
      isRequired: true,
      options: ['Yes', 'No'],
    };

    const res = await resolveTier1('AWL-TEST', disclosureField, mockProfile, exec);
    expect(res?.value).not.toBe('Missouri');
    expect(res?.value).not.toBe('Kansas City, MO, United States');
  });

  it('resolves Cover Letter file inputs as __FILE_UPLOAD__ instead of unhandled text', async () => {
    const coverLetterField: ScannedField = {
      fieldId: 'cover_letter_1',
      name: 'cover_letter',
      label: 'Cover Letter',
      type: 'file',
      isRequired: true,
    };

    const res = await resolveTier1('AWL-TEST', coverLetterField, mockProfile, exec);
    expect(res?.value).toBe('__FILE_UPLOAD__');
    expect(res?.resolvedByTier).toBe(1);
  });

  it('STILL correctly resolves genuine State fields to the candidate state', async () => {
    const genuineStateField: ScannedField = {
      fieldId: 'state_1',
      name: 'state',
      label: 'State of Residence',
      type: 'text',
      isRequired: true,
    };

    const res = await resolveTier1('AWL-TEST', genuineStateField, mockProfile, exec);
    expect(res?.value).toBe('Missouri');
  });
});
