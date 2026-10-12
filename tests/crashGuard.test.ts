import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isPlaywrightCdpError,
  handleUncaughtException,
  handleUnhandledRejection,
  sweepStaleApplications,
} from '../src/server/crashGuard.js';

describe('Process Crash Guard (Phase 1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('identifies Playwright CDP disconnect errors correctly', () => {
    expect(isPlaywrightCdpError(new Error('SyntaxError: Unexpected end of JSON input'))).toBe(true);
    expect(isPlaywrightCdpError(new Error('Target closed'))).toBe(true);
    expect(isPlaywrightCdpError(new Error('Browser closed'))).toBe(true);
    expect(isPlaywrightCdpError(new Error('Protocol error (Page.navigate): Target closed.'))).toBe(true);
    expect(isPlaywrightCdpError(new Error('Some other random fatal database error'))).toBe(false);
  });

  it('emitting uncaughtException with a CDP pipe error does not exit the process', () => {
    const exitMock = vi.fn();
    const cdpError = new Error('SyntaxError: Unexpected end of JSON input');

    handleUncaughtException(cdpError, exitMock as any);

    expect(exitMock).not.toHaveBeenCalled();
  });

  it('emitting uncaughtException with a non-CDP error exits the process', () => {
    const exitMock = vi.fn();
    const fatalError = new Error('Fatal database corruption or unhandled business crash');

    handleUncaughtException(fatalError, exitMock as any);

    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('unhandledRejection with a Playwright Target closed error does not exit', () => {
    const exitMock = vi.fn();
    const targetClosedError = new Error('Target closed');

    handleUnhandledRejection(targetClosedError, Promise.resolve(), exitMock as any);

    expect(exitMock).not.toHaveBeenCalled();
  });

  it('startup sweep transitions stale OTP_REQUIRED rows (>10 min old) to QUEUED', async () => {
    const now = Date.now();
    const staleTime = new Date(now - 15 * 60 * 1000).toISOString();
    const freshTime = new Date(now - 2 * 60 * 1000).toISOString();

    const mockDb = {
      applications: [
        { id: 'app-stale-1', status: 'OTP_REQUIRED', updated_at: staleTime },
        { id: 'app-stale-2', status: 'APPLYING', updated_at: staleTime },
        { id: 'app-fresh-1', status: 'OTP_REQUIRED', updated_at: freshTime },
        { id: 'app-other', status: 'RETRY', updated_at: staleTime },
      ],
      async updateRows(ids: string[], newStatus: string) {
        for (const app of this.applications) {
          if (ids.includes(app.id)) {
            app.status = newStatus;
          }
        }
      },
    };

    const count = await sweepStaleApplications({
      fetchStale: async (cutoff) => {
        return mockDb.applications.filter(
          (a) =>
            (a.status === 'OTP_REQUIRED' || a.status === 'APPLYING') &&
            new Date(a.updated_at).getTime() < cutoff.getTime()
        );
      },
      updateStatus: async (ids, status) => {
        await mockDb.updateRows(ids, status);
      },
    });

    expect(count).toBe(2);
    expect(mockDb.applications.find((a) => a.id === 'app-stale-1')?.status).toBe('QUEUED');
    expect(mockDb.applications.find((a) => a.id === 'app-stale-2')?.status).toBe('QUEUED');
    // Startup sweep leaves fresh OTP_REQUIRED rows (< 10 min old) untouched:
    expect(mockDb.applications.find((a) => a.id === 'app-fresh-1')?.status).toBe('OTP_REQUIRED');
  });
});
