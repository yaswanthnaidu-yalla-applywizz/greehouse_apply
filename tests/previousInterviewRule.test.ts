import { describe, it, expect } from 'vitest';
import { resolveStandardProfileAttribute } from '../src/resolver/tier1Supabase.js';
import type { ScannedField } from '../src/types/index.js';

describe('Previous Interview & Employment History Rule', () => {
  it('resolves No to "Have you ever interviewed at Anthropic before?"', () => {
    const field: ScannedField = {
      fieldId: 'q_interviewed',
      name: 'q_interviewed',
      type: 'select',
      label: 'Have you ever interviewed at Anthropic before?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, {} as any);
    expect(res).toBe('No');
  });

  it('resolves No to "Have you been employed by Upstart before?"', () => {
    const field: ScannedField = {
      fieldId: 'q_employed',
      name: 'q_employed',
      type: 'select',
      label: 'Have you been employed by Upstart before?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, {} as any);
    expect(res).toBe('No');
  });

  it('resolves negative option for "HISTORY WITH ANDURIL"', () => {
    const field: ScannedField = {
      fieldId: 'q_anduril',
      name: 'q_anduril',
      type: 'select',
      label: 'HISTORY WITH ANDURIL',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, {} as any);
    expect(res).toBe('No');
  });

  it('resolves No to "Have you interviewed for this role in the past 3 months?"', () => {
    const field: ScannedField = {
      fieldId: 'q_role_interview',
      name: 'q_role_interview',
      type: 'select',
      label: 'Have you interviewed for this role in the past 3 months?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, {} as any);
    expect(res).toBe('No');
  });
});
