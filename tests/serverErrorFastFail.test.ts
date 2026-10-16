import { describe, it, expect } from 'vitest';
import { verifySubmissionSignals } from '../src/submitter/otpSession.js';
import type { Page } from 'playwright';

describe('verifySubmissionSignals - fast fail on server error', () => {
  it('returns immediately with GREENHOUSE_SERVER_ERROR when server error text appears', async () => {
    const startTime = Date.now();
    const mockPage = {
      isClosed: () => false,
      title: async () => 'Application Error Page',
      url: () => 'https://boards.greenhouse.io/test/jobs/123',
      evaluate: async (fn: any) => {
        return 'There was an error processing your application. Please try again.';
      },
      locator: () => ({
        count: async () => 0,
      }),
      waitForTimeout: async () => {},
    } as unknown as Page;

    const result = await verifySubmissionSignals(mockPage, 10000);
    const duration = Date.now() - startTime;

    expect(result.verified).toBe(false);
    expect(result.error).toContain('GREENHOUSE_SERVER_ERROR');
    expect(duration).toBeLessThan(2000); // Fast fails on first poll, does not wait 10s
  });
});
