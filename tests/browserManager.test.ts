import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserManager } from '../src/submitter/browserManager.js';
import type { Browser } from 'playwright';

describe('BrowserManager', () => {
  let browserManager: BrowserManager;

  const mockBrowser = (id: string = 'mock-browser'): Browser => ({
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    version: vi.fn().mockReturnValue('1.0.0'),
  } as unknown as Browser);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    if (browserManager) {
      await browserManager.closeAll();
    }
    vi.useRealTimers();
  });

  it('enforces maximum concurrent browser limit via semaphore', async () => {
    const launchMock = vi.fn().mockImplementation(async () => mockBrowser());
    browserManager = new BrowserManager({
      maxConcurrentBrowsers: 2,
      launchCooldownMs: 0,
      launchFn: launchMock,
    });

    const b1 = await browserManager.acquireBrowser({ headless: true });
    const b2 = await browserManager.acquireBrowser({ headless: true });

    expect(browserManager.getStats().activeCount).toBe(2);
    expect(browserManager.getStats().waitingCount).toBe(0);

    // 3rd request should wait
    let b3Resolved = false;
    const b3Promise = browserManager.acquireBrowser({ headless: true }).then((res) => {
      b3Resolved = true;
      return res;
    });

    // Advance event loop tick
    await vi.advanceTimersByTimeAsync(10);
    expect(b3Resolved).toBe(false);
    expect(browserManager.getStats().waitingCount).toBe(1);

    // Release b1 -> b3 should resolve
    await browserManager.releaseBrowser(b1.browserId);
    const b3 = await b3Promise;

    expect(b3Resolved).toBe(true);
    expect(b3).toBeDefined();
    expect(browserManager.getStats().activeCount).toBe(2);
    expect(browserManager.getStats().waitingCount).toBe(0);

    await browserManager.releaseBrowser(b2.browserId);
    await browserManager.releaseBrowser(b3.browserId);
    expect(browserManager.getStats().activeCount).toBe(0);
  });

  it('throttles consecutive browser launches by launchCooldownMs', async () => {
    const launchTimestamps: number[] = [];
    const launchMock = vi.fn().mockImplementation(async () => {
      launchTimestamps.push(Date.now());
      return mockBrowser();
    });

    browserManager = new BrowserManager({
      maxConcurrentBrowsers: 5,
      launchCooldownMs: 1500,
      launchFn: launchMock,
    });

    const p1 = browserManager.acquireBrowser({ headless: true });
    const p2 = browserManager.acquireBrowser({ headless: true });

    const b1 = await p1;
    expect(launchMock).toHaveBeenCalledTimes(1);

    // Advance 1400ms -> 2nd launch should not have executed yet
    await vi.advanceTimersByTimeAsync(1400);
    expect(launchMock).toHaveBeenCalledTimes(1);

    // Advance another 200ms (total 1600ms) -> 2nd launch should execute
    await vi.advanceTimersByTimeAsync(200);
    const b2 = await p2;
    expect(launchMock).toHaveBeenCalledTimes(2);

    expect(launchTimestamps.length).toBe(2);
    expect(launchTimestamps[1] - launchTimestamps[0]).toBeGreaterThanOrEqual(1500);

    await browserManager.releaseBrowser(b1.browserId);
    await browserManager.releaseBrowser(b2.browserId);
  });

  it('releases semaphore slot when launch fails without throwing unhandled error', async () => {
    const launchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Playwright launch failed: Target crashed'))
      .mockImplementationOnce(async () => mockBrowser());

    browserManager = new BrowserManager({
      maxConcurrentBrowsers: 1,
      launchCooldownMs: 0,
      launchFn: launchMock,
    });

    await expect(browserManager.acquireBrowser({ headless: true })).rejects.toThrow(
      'Target crashed'
    );

    // Active count should be 0 because failed launch released the slot
    expect(browserManager.getStats().activeCount).toBe(0);
    expect(browserManager.getStats().waitingCount).toBe(0);

    // Next request should succeed immediately
    const b2 = await browserManager.acquireBrowser({ headless: true });
    expect(browserManager.getStats().activeCount).toBe(1);
    await browserManager.releaseBrowser(b2.browserId);
  });

  it('cleans up stale browsers that exceed TTL', async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const launchMock = vi.fn().mockImplementation(async () => ({
      close: closeSpy,
      isConnected: vi.fn().mockReturnValue(true),
    } as unknown as Browser));

    browserManager = new BrowserManager({
      maxConcurrentBrowsers: 5,
      launchCooldownMs: 0,
      launchFn: launchMock,
      staleTtlMs: 5000,
    });

    const b1 = await browserManager.acquireBrowser({ headless: true });
    expect(browserManager.getStats().activeCount).toBe(1);

    // Advance time past TTL
    await vi.advanceTimersByTimeAsync(6000);

    const closedCount = await browserManager.cleanupStaleBrowsers();
    expect(closedCount).toBe(1);
    expect(closeSpy).toHaveBeenCalled();
    expect(browserManager.getStats().activeCount).toBe(0);
  });
});
