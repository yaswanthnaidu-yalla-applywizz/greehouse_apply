import { describe, expect, it } from 'vitest';
import type { ScannedField, ScannedJobTemplate } from '../src/types/index.js';
import { hasSecurityClearanceQuestion, isSecurityClearanceQuestion } from '../src/scanner/securityClearance.js';

function field(label: string, values: Partial<ScannedField> = {}): ScannedField {
  return {
    fieldId: 'custom_question',
    name: 'custom_question',
    type: 'text',
    label,
    isRequired: false,
    ...values,
  };
}

describe('security clearance question policy', () => {
  it.each([
    'Do you currently hold a U.S. security clearance?',
    'Are you eligible for Public Trust?',
    'Do you hold an active TS/SCI clearance?',
    'Have you been cleared for classified work?',
  ])('detects clearance question: %s', (label) => {
    expect(isSecurityClearanceQuestion(field(label))).toBe(true);
  });

  it('checks field identifiers and captured metadata as well as the label', () => {
    expect(isSecurityClearanceQuestion(field('Additional information', {
      fieldId: 'security_clearance_level',
    }))).toBe(true);
    expect(isSecurityClearanceQuestion(field('Additional information', {
      metadata: { section: 'U.S. Government Clearance' },
    }))).toBe(true);
  });

  it('does not treat an unrelated security question as a clearance question', () => {
    expect(isSecurityClearanceQuestion(field('Can you follow our security policies?'))).toBe(false);
  });

  it('detects a clearance field in a scanned job template', () => {
    const template: ScannedJobTemplate = {
      jobUrl: 'https://boards.greenhouse.io/example/jobs/123',
      companyName: 'Example',
      jobTitle: 'Engineer',
      fields: [field('Can you obtain and maintain a security clearance?')],
      scannedAt: '2026-10-15T00:00:00.000Z',
      isExpired: false,
    };
    expect(hasSecurityClearanceQuestion(template)).toBe(true);
  });
});
