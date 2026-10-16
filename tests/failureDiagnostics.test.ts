import { describe, it, expect } from 'vitest';
import { captureFailureDiagnostics } from '../src/submitter/failureDiagnostics.js';
import type { Page } from 'playwright';

describe('captureFailureDiagnostics', () => {
  it('detects inline field validation errors', async () => {
    const mockPage = {
      title: async () => 'Job Application',
      url: () => 'https://boards.greenhouse.io/test/jobs/123',
      $$eval: async (selector: string, fn: any) => {
        if (selector.includes('.field-error')) {
          const fakeEls = [
            {
              id: 'job_application_answers_attributes_1_text_value',
              textContent: 'This field is required.',
              closest: (sel: string) => {
                if (sel === '[data-field]') return { getAttribute: () => 'linkedin_profile' };
                if (sel === 'label') return { textContent: 'LinkedIn Profile' };
                return null;
              },
            },
          ];
          return fn(fakeEls);
        }
        return [];
      },
      evaluate: async (fn: any) => {
        return 'Standard page body without server error';
      },
    } as unknown as Page;

    const diag = await captureFailureDiagnostics(mockPage);
    expect(diag.failureType).toBe('field_validation');
    expect(diag.failingFields).toHaveLength(1);
    expect(diag.failingFields[0].label).toBe('linkedin_profile');
    expect(diag.failingFields[0].errorText).toBe('This field is required.');
    expect(diag.serverError).toBeNull();
    expect(diag.pageTitle).toBe('Job Application');
    expect(diag.pageUrl).toBe('https://boards.greenhouse.io/test/jobs/123');
    expect(diag.capturedAt).toBeDefined();
  });

  it('detects Greenhouse server error banner', async () => {
    const mockPage = {
      title: async () => 'Application Error',
      url: () => 'https://boards.greenhouse.io/test/jobs/123',
      $$eval: async () => [],
      evaluate: async () => 'We were unable to submit your application. There was an error processing your application. Please try again.',
    } as unknown as Page;

    const diag = await captureFailureDiagnostics(mockPage);
    expect(diag.failureType).toBe('server_error');
    expect(diag.serverError).toContain('error processing your application');
    expect(diag.failingFields).toHaveLength(0);
  });

  it('returns unknown when no specific error signatures found', async () => {
    const mockPage = {
      title: async () => 'Application Page',
      url: () => 'https://boards.greenhouse.io/test/jobs/123',
      $$eval: async () => [],
      evaluate: async () => 'Form content normal',
    } as unknown as Page;

    const diag = await captureFailureDiagnostics(mockPage);
    expect(diag.failureType).toBe('unknown');
    expect(diag.serverError).toBeNull();
    expect(diag.failingFields).toHaveLength(0);
  });

  it('handles page evaluation exceptions gracefully', async () => {
    const mockPage = {
      title: async () => { throw new Error('Target closed'); },
      url: () => 'https://boards.greenhouse.io/test/jobs/123',
      $$eval: async () => { throw new Error('Target closed'); },
      evaluate: async () => { throw new Error('Target closed'); },
    } as unknown as Page;

    const diag = await captureFailureDiagnostics(mockPage);
    expect(diag.failureType).toBe('unknown');
    expect(diag.failingFields).toEqual([]);
    expect(diag.serverError).toBeNull();
  });
});
