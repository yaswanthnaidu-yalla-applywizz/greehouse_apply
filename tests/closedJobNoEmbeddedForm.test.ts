import { describe, it, expect } from 'vitest';
import { isClosedJobNoEmbeddedForm } from '../src/scanner/playwrightScanner.js';

describe('RC-GH-5: isClosedJobNoEmbeddedForm', () => {
  it('marks job expired/closed when hasEmbeddedForm is false and hasSubmitButton is false', () => {
    expect(isClosedJobNoEmbeddedForm({ hasEmbeddedForm: false, hasSubmitButton: false, pageText: 'Please apply on our portal' })).toBe(true);
  });

  it('marks job expired/closed when page text explicitly says apply on external portal or link', () => {
    const text = 'This position is managed via an external portal. Please visit our careers site to apply.';
    expect(isClosedJobNoEmbeddedForm({ hasEmbeddedForm: false, hasSubmitButton: false, pageText: text })).toBe(true);
  });

  it('does NOT mark expired if embedded form is present', () => {
    expect(isClosedJobNoEmbeddedForm({ hasEmbeddedForm: true, hasSubmitButton: true, pageText: 'Apply for this job below' })).toBe(false);
  });

  it('does NOT mark expired if submit button is present even if form wrapper was atypical', () => {
    expect(isClosedJobNoEmbeddedForm({ hasEmbeddedForm: false, hasSubmitButton: true, pageText: 'Submit Application' })).toBe(false);
  });
});
