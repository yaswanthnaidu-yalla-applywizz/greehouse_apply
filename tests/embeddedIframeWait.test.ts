import { describe, it, expect, vi } from 'vitest';
import { waitForEmbeddedGreenhouseApplicationUrl, findEmbeddedGreenhouseApplicationUrl } from '../src/scanner/playwrightScanner.js';

describe('waitForEmbeddedGreenhouseApplicationUrl', () => {
  it('detects embedded Greenhouse frame URLs from page.frames()', async () => {
    const mockPage: any = {
      frames: () => [
        { url: () => 'https://www.jamf.com/about/careers/jobs/?gh_jid=6216768004' },
        { url: () => 'https://job-boards.greenhouse.io/embed/job_app?for=jamf&token=6216768004' },
      ],
      evaluate: vi.fn().mockResolvedValue(null),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const resolved = await waitForEmbeddedGreenhouseApplicationUrl(mockPage, 1000);
    expect(resolved).toBe('https://job-boards.greenhouse.io/embed/job_app?for=jamf&token=6216768004');
  });

  it('detects embedded Greenhouse iframe from DOM src attribute before subframe navigates', async () => {
    let callCount = 0;
    const mockPage: any = {
      frames: () => [
        { url: () => 'https://cribl.io/job-detail/6264458004/' },
        { url: () => 'about:blank' },
      ],
      evaluate: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount >= 2) {
          return 'https://job-boards.greenhouse.io/embed/job_app?for=cribl&token=6264458004';
        }
        return null;
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const resolved = await waitForEmbeddedGreenhouseApplicationUrl(mockPage, 2000);
    expect(resolved).toBe('https://job-boards.greenhouse.io/embed/job_app?for=cribl&token=6264458004');
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('returns null if no embedded Greenhouse iframe appears within timeout', async () => {
    const mockPage: any = {
      frames: () => [
        { url: () => 'https://example.com/careers/job1' },
      ],
      evaluate: vi.fn().mockResolvedValue(null),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const resolved = await waitForEmbeddedGreenhouseApplicationUrl(mockPage, 200);
    expect(resolved).toBeNull();
  });
});
