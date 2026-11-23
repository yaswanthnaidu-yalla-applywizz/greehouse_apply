import { describe, it, expect } from 'vitest';
import { matchCorporatePolicy } from '../src/resolver/corporatePolicies.js';
import { resolveStandardProfileAttribute } from '../src/resolver/tier1Supabase.js';
import type { ScannedField } from '../types/index.js';
import type { ProfileRow } from '../db/profiles.js';

describe('Corporate Policies & Resolver - Sponsorship Polarity & Marketing Opt-Out', () => {
  const f1Profile: ProfileRow = {
    applywizz_id: 'cand-f1',
    client_name: 'F1 Candidate',
    work_authorization: 'F1',
    requires_sponsorship: false, // Inverted or ambiguous in raw DB
  } as any;

  const citizenProfile: ProfileRow = {
    applywizz_id: 'cand-citizen',
    client_name: 'Citizen Candidate',
    work_authorization: 'US Citizen',
    requires_sponsorship: false,
  } as any;

  describe('Future Sponsorship Polarity', () => {
    it('resolves future sponsorship to Yes for F1 visa holders', () => {
      const field: ScannedField = {
        fieldId: 'future_sponsorship',
        name: 'future_sponsorship',
        label: 'Will you now or in the future require sponsorship for an employment visa status?',
        type: 'select',
        options: ['Yes', 'No'],
      };

      const corpPolicy = matchCorporatePolicy(field, f1Profile);
      expect(corpPolicy).toBe('Yes');

      const tier1 = resolveStandardProfileAttribute(field, f1Profile);
      expect(tier1).toBe('Yes');
    });

    it('resolves future employer sponsorship to Yes for H-1B visa holders', () => {
      const h1bProfile: ProfileRow = {
        applywizz_id: 'cand-h1b',
        client_name: 'H1B Candidate',
        work_authorization: 'H1B',
        requires_sponsorship: true,
      } as any;

      const field: ScannedField = {
        fieldId: 'sponsor_future',
        name: 'sponsor_future',
        label: 'Will you at any point in the future require employer sponsorship?',
        type: 'radio',
        options: ['Yes', 'No'],
      };

      expect(matchCorporatePolicy(field, h1bProfile)).toBe('Yes');
      expect(resolveStandardProfileAttribute(field, h1bProfile)).toBe('Yes');
    });

    it('preserves current legal work authorization as Yes for F1 visa holders', () => {
      const field: ScannedField = {
        fieldId: 'work_auth',
        name: 'work_auth',
        label: 'Are you legally authorized to work in the United States?',
        type: 'select',
        options: ['Yes', 'No'],
      };

      const tier1 = resolveStandardProfileAttribute(field, f1Profile);
      expect(tier1).toBe('Yes');
    });

    it('resolves future sponsorship to No for US Citizens', () => {
      const field: ScannedField = {
        fieldId: 'future_sponsorship',
        name: 'future_sponsorship',
        label: 'Will you in the future require sponsorship?',
        type: 'select',
        options: ['Yes', 'No'],
      };

      expect(matchCorporatePolicy(field, citizenProfile)).toBe('No');
      expect(resolveStandardProfileAttribute(field, citizenProfile)).toBe('No');
    });
  });

  describe('SMS & Recruitment Marketing Opt-Out Policy', () => {
    it('resolves recruitment marketing and talent community opt-in to No', () => {
      const field: ScannedField = {
        fieldId: 'talent_marketing',
        name: 'talent_marketing',
        label: 'May we contact you about future job opportunities and talent community marketing via SMS?',
        type: 'radio',
        options: ['Yes, opt in', 'No, do not consent'],
      };

      expect(matchCorporatePolicy(field, f1Profile)).toBe('No, do not consent');
      expect(resolveStandardProfileAttribute(field, f1Profile)).toBe('No, do not consent');
    });

    it('resolves SMS communications consent to No for standard Yes/No choices', () => {
      const field: ScannedField = {
        fieldId: 'sms_consent',
        name: 'sms_consent',
        label: 'Consent to receive text messages regarding your application',
        type: 'select',
        options: ['Yes', 'No'],
      };

      expect(matchCorporatePolicy(field, f1Profile)).toBe('No');
      expect(resolveStandardProfileAttribute(field, f1Profile)).toBe('No');
    });

    it('resolves checkbox SMS opt-in to false', () => {
      const field: ScannedField = {
        fieldId: 'sms_checkbox',
        name: 'sms_checkbox',
        label: 'I opt in to receive promotional text messages',
        type: 'checkbox',
      };

      expect(matchCorporatePolicy(field, f1Profile)).toBe('false');
      expect(resolveStandardProfileAttribute(field, f1Profile)).toBe('false');
    });
  });
});
