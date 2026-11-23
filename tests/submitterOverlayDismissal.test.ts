import { describe, it, expect, vi } from 'vitest';
import { dismissBlockingOverlays } from '../src/submitter/fieldFillers/overlayDismissal.js';

describe('Submitter Overlay Dismissal - Age Gates & Cookie Modals', () => {
  it('detects and clicks age verification button ("I\'m Over 21")', async () => {
    const clickMock = vi.fn().mockResolvedValue(undefined);
    const mockAgeGateButton = {
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(true),
      click: clickMock,
      dispatchEvent: vi.fn().mockResolvedValue(undefined),
    };

    const mockPage: any = {
      locator: vi.fn().mockImplementation((sel: string) => {
        if (sel.includes("I'm Over 21")) {
          return {
            first: () => mockAgeGateButton,
          };
        }
        return {
          first: () => ({
            count: vi.fn().mockResolvedValue(0),
            isVisible: vi.fn().mockResolvedValue(false),
          }),
        };
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const dismissed = await dismissBlockingOverlays(mockPage);
    expect(dismissed).toBe(true);
    expect(clickMock).toHaveBeenCalled();
  });

  it('detects and clicks cookie consent button ("Accept All Cookies")', async () => {
    const clickMock = vi.fn().mockResolvedValue(undefined);
    const mockCookieButton = {
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(true),
      click: clickMock,
      dispatchEvent: vi.fn().mockResolvedValue(undefined),
    };

    const mockPage: any = {
      locator: vi.fn().mockImplementation((sel: string) => {
        if (sel.includes('Accept All Cookies')) {
          return {
            first: () => mockCookieButton,
          };
        }
        return {
          first: () => ({
            count: vi.fn().mockResolvedValue(0),
            isVisible: vi.fn().mockResolvedValue(false),
          }),
        };
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const dismissed = await dismissBlockingOverlays(mockPage);
    expect(dismissed).toBe(true);
    expect(clickMock).toHaveBeenCalled();
  });

  it('returns false and completes safely when no overlays are present', async () => {
    const mockPage: any = {
      locator: vi.fn().mockReturnValue({
        first: () => ({
          count: vi.fn().mockResolvedValue(0),
          isVisible: vi.fn().mockResolvedValue(false),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const dismissed = await dismissBlockingOverlays(mockPage);
    expect(dismissed).toBe(false);
  });
});
