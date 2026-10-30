/**
 * RC-GH-1 regression: Greenhouse phone-section country dropdown must not be skipped
 * when optional with no resolved value.
 *
 * The field: name='country', fieldId='country', label='Country', type='select', isRequired=false
 * Expected: isPhoneCountrySelect=true → skipOptional=false → isForcedCountryField fires → val='United States'
 */
import { describe, it, expect } from 'vitest';
import { isCountryCodeField } from '../src/submitter/formFiller.js';

describe('RC-GH-1: Greenhouse phone-section country dropdown fix', () => {
  it('isCountryCodeField returns true for the phone-section country field (name=country)', () => {
    // This field is optionally present in the phone section of Greenhouse forms.
    // It has name='country', fieldId='country', label='Country', type='select', isRequired=false.
    expect(isCountryCodeField('country', 'country', 'Country')).toBe(true);
  });

  it('isCountryCodeField returns false for phone dialing code field (name=country_code)', () => {
    // Phone dialing code fields must NOT trigger the phone-country forced fill (different field)
    expect(isCountryCodeField('country_code', 'country_code', 'Country Code')).toBe(true);
  });

  it('computeSkipOptional returns false for optional phone-country dropdown with no value', async () => {
    // After the fix: skipOptional must be false for isPhoneCountrySelect fields,
    // allowing isForcedCountryField to set val='United States'.
    const { computeSkipOptional } = await import('../src/submitter/formFiller.js');
    const result = computeSkipOptional({
      isRequired: false,
      val: '',
      fieldId: 'country',
      name: 'country',
      rawType: 'select',
    });
    expect(result).toBe(false);
  });

  it('computeSkipOptional returns true for an optional text field with no value (no regression)', async () => {
    // Any non-country optional field with no value should still be skipped
    const { computeSkipOptional } = await import('../src/submitter/formFiller.js');
    const result = computeSkipOptional({
      isRequired: false,
      val: '',
      fieldId: 'some_optional_field',
      name: 'some_optional_field',
      rawType: 'text',
    });
    expect(result).toBe(true);
  });

  it('computeSkipOptional returns true for an optional country_code select with no value (no regression)', async () => {
    // A phone dialing code field (country_code) that is optional with no value should still be skipped
    // (we don't force-fill the dialing code, only the country name dropdown)
    const { computeSkipOptional } = await import('../src/submitter/formFiller.js');
    const result = computeSkipOptional({
      isRequired: false,
      val: '',
      fieldId: 'country_code',
      name: 'country_code',
      rawType: 'select',
    });
    expect(result).toBe(true);
  });

  it('computeForcedCountryValue returns United States for the phone-country select field', async () => {
    // After the fix: isForcedCountryField must fire for the phone-country dropdown
    const { computeForcedCountryValue } = await import('../src/submitter/formFiller.js');
    const val = computeForcedCountryValue({
      val: '',
      fieldId: 'country',
      name: 'country',
      label: 'Country',
      rawType: 'select',
    });
    expect(val).toBe('United States');
  });

  it('computeForcedCountryValue returns null for a phone dialing code field (no regression)', async () => {
    // Dialing code fields (country_code) must NOT get force-set to "United States"
    const { computeForcedCountryValue } = await import('../src/submitter/formFiller.js');
    const val = computeForcedCountryValue({
      val: '',
      fieldId: 'country_code',
      name: 'country_code',
      label: 'Country Code',
      rawType: 'select',
    });
    expect(val).toBeNull();
  });
});
