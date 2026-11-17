import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { waitForSubmitConfirmation } from '../src/submitter/ashbySubmit.js';

function createMockPage(options: {
  pageText?: string;
  url?: string;
  title?: string;
  hasSuccessElement?: boolean;
}): Page {
  return {
    textContent: async (selector: string) => options.pageText ?? '',
    url: () => options.url ?? 'https://jobs.ashbyhq.com/company/job/application',
    title: async () => options.title ?? 'Job Application',
    locator: (selector: string) => ({
      count: async () => (options.hasSuccessElement ? 1 : 0),
    }),
    waitForTimeout: async (ms: number) => {},
    evaluate: async () => false,
    $: async () => null,
    $$: async () => [],
  } as unknown as Page;
}

describe('Ashby Submit Confirmation Detection Broadening', () => {
  it('detects IRIS confirmation: "Success: Thanks for applying to IRIS..."', async () => {
    const page = createMockPage({
      pageText: 'Success: Thanks for applying to IRIS. Every application is reviewed by a real person...',
    });
    const result = await waitForSubmitConfirmation(page, { timeoutMs: 50, pollIntervalMs: 10 });
    assert.equal(result, true, 'Should detect IRIS confirmation copy');
  });

  it('detects Lovable confirmation: "Success: Thank you for your interest in joining Lovable! Your application was received..."', async () => {
    const page = createMockPage({
      pageText: 'Success: Thank you for your interest in joining Lovable! Your application was received...',
    });
    const result = await waitForSubmitConfirmation(page, { timeoutMs: 50, pollIntervalMs: 10 });
    assert.equal(result, true, 'Should detect Lovable confirmation copy');
  });

  it('detects BillGO confirmation: "Success: Thank you for your application! Our team will be in touch with next steps!"', async () => {
    const page = createMockPage({
      pageText: 'Success: Thank you for your application! Our team will be in touch with next steps!',
    });
    const result = await waitForSubmitConfirmation(page, { timeoutMs: 50, pollIntervalMs: 10 });
    assert.equal(result, true, 'Should detect BillGO confirmation copy');
  });

  it('detects HUMAN confirmation: "Success: Hello! Thank you for your interest in joining HUMAN! We\'ve received your application..."', async () => {
    const page = createMockPage({
      pageText: "Success: Hello! Thank you for your interest in joining HUMAN! We've received your application...",
    });
    const result = await waitForSubmitConfirmation(page, { timeoutMs: 50, pollIntervalMs: 10 });
    assert.equal(result, true, 'Should detect HUMAN confirmation copy');
  });

  it('detects Cohere confirmation: "Success: Your application has been submitted!"', async () => {
    const page = createMockPage({
      pageText: 'Success: Your application has been submitted!',
    });
    const result = await waitForSubmitConfirmation(page, { timeoutMs: 50, pollIntervalMs: 10 });
    assert.equal(result, true, 'Should detect Cohere confirmation copy');
  });

  it('detects confirmation via DOM element class .ashby-application-form-success', async () => {
    const page = createMockPage({
      pageText: 'Your details have been saved.',
      hasSuccessElement: true,
    });
    const result = await waitForSubmitConfirmation(page, { timeoutMs: 50, pollIntervalMs: 10 });
    assert.equal(result, true, 'Should detect success DOM element');
  });

  it('negative case 1: "Your form needs corrections" returns false', async () => {
    const page = createMockPage({
      pageText: 'Your form needs corrections. Please review the highlighted fields.',
    });
    const result = await waitForSubmitConfirmation(page, { timeoutMs: 30, pollIntervalMs: 10 }).catch(() => false);
    assert.equal(result, false, 'Validation error should return false');
  });

  it('negative case 2: "We couldn\'t submit this application" returns false', async () => {
    const page = createMockPage({
      pageText: "We couldn't submit this application. Please try again later.",
    });
    const result = await waitForSubmitConfirmation(page, { timeoutMs: 30, pollIntervalMs: 10 }).catch(() => false);
    assert.equal(result, false, 'Submission error should return false');
  });
});
