import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS,
  SPINNER_EXTENDED_TIMEOUT_MS,
  isSubmitButtonSpinnerActive,
  verifySubmissionSignals,
} from '../src/submitter/otpSession.js';

describe('Spinner-Aware Submission Confirmation (Phase 4)', () => {
  it('extends base timeout to 75s and spinner ceiling to 90s', () => {
    expect(DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS).toBe(75000);
    expect(SPINNER_EXTENDED_TIMEOUT_MS).toBe(90000);
  });

  it('spinner detection handles missing submit button without throwing', async () => {
    const mockPage = {
      evaluate: vi.fn().mockImplementation((fn) => {
        // Run with mock document having no button
        const mockDoc = { querySelector: () => null };
        return Promise.resolve(false);
      }),
    };
    const active = await isSubmitButtonSpinnerActive(mockPage as any);
    expect(active).toBe(false);
  });

  it('spinner detection detects button with loading class or aria-busy', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(true),
    };
    const active = await isSubmitButtonSpinnerActive(mockPage as any);
    expect(active).toBe(true);
  });

  it('confirmation found within 75s succeeds', async () => {
    let callCount = 0;
    const mockPage = {
      isClosed: () => false,
      title: vi.fn().mockResolvedValue('Apply'),
      url: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount >= 2 ? 'https://boards.greenhouse.io/job/confirmation' : 'https://boards.greenhouse.io/job';
      }),
      evaluate: vi.fn().mockResolvedValue(''),
      locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const res = await verifySubmissionSignals(mockPage as any, 75000);
    expect(res.verified).toBe(true);
    expect(res.signal).toContain('confirmation URL');
  });

  it('spinner active past base timeout continues polling until spinner ceiling', async () => {
    let checkCount = 0;
    let fakeNow = 100000;
    const realDateNow = Date.now;

    // Simulate elapsed time advancing past 75s with active spinner
    Date.now = () => fakeNow;

    const mockPage = {
      isClosed: () => false,
      title: vi.fn().mockResolvedValue(''),
      url: vi.fn().mockReturnValue('https://boards.greenhouse.io/job'),
      evaluate: vi.fn().mockImplementation((fn) => {
        checkCount++;
        if (checkCount >= 2) {
          // Signal arrived while spinning
          return Promise.resolve('thank you for applying');
        }
        return Promise.resolve('');
      }),
      locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
      waitForTimeout: vi.fn().mockImplementation(() => {
        fakeNow += 500;
        return Promise.resolve();
      }),
    };

    try {
      const res = await verifySubmissionSignals(mockPage as any, 75000, 90000);
      expect(res.verified).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('no spinner at 75s triggers timeout', async () => {
    let fakeNow = 0;
    const realDateNow = Date.now;
    Date.now = () => fakeNow;

    const mockPage = {
      isClosed: () => false,
      title: vi.fn().mockResolvedValue(''),
      url: vi.fn().mockReturnValue('https://boards.greenhouse.io/job'),
      evaluate: vi.fn().mockResolvedValue(false), // No spinner and no token
      locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
      waitForTimeout: vi.fn().mockImplementation(() => {
        fakeNow += 10000;
        return Promise.resolve();
      }),
    };

    try {
      const res = await verifySubmissionSignals(mockPage as any, 75000, 90000);
      expect(res.verified).toBe(false);
      expect(res.error).toContain('timed out');
    } finally {
      Date.now = realDateNow;
    }
  });

  it('spinner active at 91s reaches absolute ceiling and times out', async () => {
    let fakeNow = 0;
    const realDateNow = Date.now;
    Date.now = () => fakeNow;

    const mockPage = {
      isClosed: () => false,
      title: vi.fn().mockResolvedValue(''),
      url: vi.fn().mockReturnValue('https://boards.greenhouse.io/job'),
      evaluate: vi.fn().mockResolvedValue(true), // spinner active always
      locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
      waitForTimeout: vi.fn().mockImplementation(() => {
        fakeNow += 15000;
        return Promise.resolve();
      }),
    };

    try {
      const res = await verifySubmissionSignals(mockPage as any, 75000, 90000);
      expect(res.verified).toBe(false);
      expect(res.error).toContain('timed out');
    } finally {
      Date.now = realDateNow;
    }
  });
});
