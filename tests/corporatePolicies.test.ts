import { describe, it, expect } from 'vitest';
import {
  matchCorporatePolicy,
  enforceCorporatePolicy,
  CORPORATE_POLICY_PROMPT_GUIDELINES,
} from '../src/resolver/corporatePolicies.js';
import type { ScannedField, ResolvedField } from '../src/types/index.js';

describe('Corporate Policies Module', () => {
  describe('matchCorporatePolicy', () => {
    it('matches prior interview / employment questions and returns No', () => {
      const field: ScannedField = {
        fieldId: 'q1',
        name: 'prior_interview',
        type: 'radio',
        label: 'Have you interviewed at Anthropic before in the past 12 months?',
        options: ['Yes', 'No'],
        isRequired: true,
      };
      expect(matchCorporatePolicy(field)).toBe('No');
    });

    it('matches prior interview questions for checkbox fields and returns false', () => {
      const field: ScannedField = {
        fieldId: 'q2',
        name: 'prior_work',
        type: 'checkbox',
        label: 'Check if you have previously been employed by this company',
        isRequired: true,
      };
      expect(matchCorporatePolicy(field)).toBe('false');
    });

    it('matches mandatory agreements and policies and returns affirmative', () => {
      const field: ScannedField = {
        fieldId: 'q3',
        name: 'arbitration',
        type: 'select',
        label: 'Please read the arbitration agreement and acknowledge below',
        options: ['I do not agree', 'I agree to the terms'],
        isRequired: true,
      };
      expect(matchCorporatePolicy(field)).toBe('I agree to the terms');
    });

    it('matches communication / SMS consent and returns No', () => {
      const field: ScannedField = {
        fieldId: 'q4',
        name: 'sms_consent',
        type: 'select',
        label: 'Would you like to receive text messages about application updates?',
        options: ['Yes', 'No'],
        isRequired: true,
      };
      expect(matchCorporatePolicy(field)).toBe('No');
    });

    it('matches job source and returns LinkedIn', () => {
      const fieldSelect: ScannedField = {
        fieldId: 'q5',
        name: 'job_source',
        type: 'select',
        label: 'How did you hear about this opportunity?',
        options: ['Event', 'Glassdoor', 'LinkedIn', 'Referral'],
        isRequired: true,
      };
      expect(matchCorporatePolicy(fieldSelect)).toBe('LinkedIn');

      const fieldText: ScannedField = {
        fieldId: 'q5_text',
        name: 'job_source_text',
        type: 'text',
        label: 'How did you hear about us?',
        isRequired: true,
      };
      expect(matchCorporatePolicy(fieldText)).toBe('LinkedIn');
    });

    it('returns null for candidate-specific or generic questions', () => {
      const field: ScannedField = {
        fieldId: 'q6',
        name: 'years_experience',
        type: 'text',
        label: 'How many years of experience do you have with TypeScript?',
        isRequired: true,
      };
      expect(matchCorporatePolicy(field)).toBeNull();
    });
  });

  describe('enforceCorporatePolicy (Post-Tier Clamping)', () => {
    it('clamps an incorrect Tier 3 / Tier 5 answer to No for prior interview', () => {
      const field: ScannedField = {
        fieldId: 'q1',
        name: 'prior_interview',
        type: 'radio',
        label: 'Have you interviewed at Anthropic before?',
        options: ['Yes', 'No'],
        isRequired: true,
      };
      const hallucinatedResolved: ResolvedField = {
        fieldId: 'q1',
        name: 'prior_interview',
        type: 'radio',
        label: field.label,
        value: 'Yes',
        source: 'ai',
        resolvedByTier: 5,
        confidence: 0.8,
        isRequired: true,
      };

      const clamped = enforceCorporatePolicy(field, hallucinatedResolved);
      expect(clamped.value).toBe('No');
      expect(clamped.source).toBe('supabase'); // Clamped by policy
      expect(clamped.resolvedByTier).toBe(1);
    });

    it('clamps an incorrect Tier 3 / Tier 5 answer to No for communication consent', () => {
      const field: ScannedField = {
        fieldId: 'q4',
        name: 'sms_consent',
        type: 'select',
        label: 'Would you like to receive text message communications?',
        options: ['Yes', 'No'],
        isRequired: true,
      };
      const wrongResolved: ResolvedField = {
        fieldId: 'q4',
        name: 'sms_consent',
        type: 'select',
        label: field.label,
        value: 'Yes',
        source: 'qa_bank',
        resolvedByTier: 3,
        confidence: 0.95,
        isRequired: true,
      };

      const clamped = enforceCorporatePolicy(field, wrongResolved);
      expect(clamped.value).toBe('No');
      expect(clamped.resolvedByTier).toBe(1);
    });

    it('does not alter non-policy resolved fields', () => {
      const field: ScannedField = {
        fieldId: 'q6',
        name: 'years_experience',
        type: 'text',
        label: 'Years of experience',
        isRequired: true,
      };
      const normalResolved: ResolvedField = {
        fieldId: 'q6',
        name: 'years_experience',
        type: 'text',
        label: field.label,
        value: '5',
        source: 'ai',
        resolvedByTier: 5,
        confidence: 0.85,
        isRequired: true,
      };

      const result = enforceCorporatePolicy(field, normalResolved);
      expect(result).toBe(normalResolved);
      expect(result.value).toBe('5');
    });
  });

  describe('CORPORATE_POLICY_PROMPT_GUIDELINES', () => {
    it('contains prompt guidelines for agreements, prior interview, SMS, and job source', () => {
      expect(CORPORATE_POLICY_PROMPT_GUIDELINES.toLowerCase()).toContain('prior interview');
      expect(CORPORATE_POLICY_PROMPT_GUIDELINES.toLowerCase()).toContain('agreement');
      expect(CORPORATE_POLICY_PROMPT_GUIDELINES.toLowerCase()).toContain('sms');
      expect(CORPORATE_POLICY_PROMPT_GUIDELINES.toLowerCase()).toContain('linkedin');
    });
  });
});
