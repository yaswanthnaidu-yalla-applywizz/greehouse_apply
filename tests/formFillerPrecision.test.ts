import { describe, it, expect, vi } from 'vitest';
import {
  isCountryCodeField,
  normalizeForCombobox,
  isDemographicOrEeoField,
  resolveEeoFallbackOption,
} from '../src/submitter/formFiller.js';

describe('Form Filler Precision (Phase 3)', () => {
  describe('3a: isCountryCodeField regex fix', () => {
    it('returns false for work authorization question containing "country"', () => {
      expect(
        isCountryCodeField('', '', 'Are you legally authorized to work in the country this role is based?')
      ).toBe(false);
    });

    it('returns true for phone country code', () => {
      expect(isCountryCodeField('', '', 'Phone country code')).toBe(true);
    });

    it('returns true for generic country question', () => {
      expect(isCountryCodeField('', '', 'What country are you located in?')).toBe(true);
    });
  });

  describe('3b: normalizeForCombobox', () => {
    it('normalizes curly apostrophes in Master’s Degree to straight apostrophe', () => {
      expect(normalizeForCombobox('Master\u2019s Degree')).toBe("Master's Degree");
    });

    it('normalizes curly apostrophes in Bachelor’s of Science to straight apostrophe', () => {
      expect(normalizeForCombobox('Bachelor\u2019s of Science')).toBe("Bachelor's of Science");
    });

    it('normalizes curly double quotes and en/em dashes', () => {
      expect(normalizeForCombobox('\u201CHello\u201D \u2013 World')).toBe('"Hello" - World');
    });
  });

  describe('3c: Mandatory Education Degree Fallback', () => {
    it('defaults degree to Bachelor\'s Degree when DOM requires education and candidate degree is blank', async () => {
      const { applyEducationDegreeFallback } = await import('../src/submitter/formFiller.js');
      const fields = [
        { fieldId: 'school--0', name: 'school--0', label: 'School', value: 'Georgia Tech', isRequired: true },
        { fieldId: 'degree--0', name: 'degree--0', label: 'Degree', value: '', isRequired: true },
        { fieldId: 'discipline--0', name: 'discipline--0', label: 'Discipline', value: 'Computer Science', isRequired: true },
      ];

      const adjusted = applyEducationDegreeFallback(fields as any, true);
      const degreeField = adjusted.find((f: any) => f.fieldId.includes('degree'));
      expect(degreeField?.value).toBe("Bachelor's Degree");
    });

    it('does NOT default degree when education section is optional on DOM', async () => {
      const { applyEducationDegreeFallback } = await import('../src/submitter/formFiller.js');
      const fields = [
        { fieldId: 'school--0', name: 'school--0', label: 'School', value: 'Georgia Tech', isRequired: false },
        { fieldId: 'degree--0', name: 'degree--0', label: 'Degree', value: '', isRequired: false },
      ];

      const adjusted = applyEducationDegreeFallback(fields as any, false);
      const degreeField = adjusted.find((f: any) => f.fieldId.includes('degree'));
      expect(degreeField?.value).toBe('');
    });
  });

  describe('3d: EEO voluntary self-identification fallback', () => {
    it('identifies demographic fields correctly', () => {
      expect(isDemographicOrEeoField('gender', 'gender', 'Please identify your gender *')).toBe(true);
      expect(isDemographicOrEeoField('race', 'race', 'Please identify your race *')).toBe(true);
      expect(isDemographicOrEeoField('veteran', 'veteran_status', 'Veteran Status')).toBe(true);
      expect(isDemographicOrEeoField('first_name', 'first_name', 'First Name')).toBe(false);
    });

    it('selects "Decline to self-identify" when option exists', () => {
      const options = ['Asian', 'White', 'Black or African American', 'Decline to self-identify'];
      expect(resolveEeoFallbackOption(options)).toBe('Decline to self-identify');
    });

    it('selects first available option when no decline option exists', () => {
      const options = ['Select...', 'Female', 'Male', 'Non-binary'];
      expect(resolveEeoFallbackOption(options)).toBe('Female');
    });
  });

  describe('3e: detectFormFillingErrors aria-labelledby label resolution', () => {
    it('resolves correct label via aria-labelledby for React-Select inputs', async () => {
      const { resolveInvalidFieldLabel } = await import('../src/submitter/formFiller.js');

      // Mock DOM element with aria-labelledby
      const mockElement = {
        id: 'react-select-2-input',
        getAttribute: (attr: string) => (attr === 'aria-labelledby' ? 'race-label-id' : null),
        closest: (_sel: string) => null,
      };
      const mockDocument = {
        querySelector: (_sel: string) => null,
        getElementById: (id: string) => (id === 'race-label-id' ? { textContent: 'Please identify your race *' } : null),
      };

      const label = resolveInvalidFieldLabel(mockElement as any, mockDocument as any);
      expect(label).toBe('Please identify your race *');
    });
  });
});
