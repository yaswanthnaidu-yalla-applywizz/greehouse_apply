import { describe, it, expect } from 'vitest';
import { getResumeFileSelectors } from '../src/submitter/formFiller.js';

describe('getResumeFileSelectors', () => {
  it('includes Remix data-field, accept=pdf, and wrapper selectors in priority order', () => {
    const selectors = getResumeFileSelectors(undefined, 'custom_resume', 'field_123');

    expect(selectors).toContain('input[type="file"][data-field*="resume" i]');
    expect(selectors).toContain('input[type="file"][accept*="pdf" i]');
    expect(selectors).toContain('.resume-upload-wrapper input[type="file"]');
    expect(selectors).toContain('[data-testid*="resume" i] input[type="file"]');
    expect(selectors).toContain('input[type="file"]#resume');
    expect(selectors).toContain('input[type="file"]');

    // Verify priority: Remix data-field and accept=pdf come before the generic ID selectors
    const remixIndex = selectors.indexOf('input[type="file"][data-field*="resume" i]');
    const acceptIndex = selectors.indexOf('input[type="file"][accept*="pdf" i]');
    const genericIdIndex = selectors.indexOf('input[type="file"]#resume');
    const genericFallbackIndex = selectors.indexOf('input[type="file"]');

    expect(remixIndex).toBeLessThan(genericIdIndex);
    expect(acceptIndex).toBeLessThan(genericIdIndex);
    expect(genericIdIndex).toBeLessThan(genericFallbackIndex);
  });

  it('preserves metadata selector as top priority when present', () => {
    const selectors = getResumeFileSelectors('#my-custom-file-input', 'resume', 'resume');
    expect(selectors[0]).toBe('#my-custom-file-input');
  });
});
