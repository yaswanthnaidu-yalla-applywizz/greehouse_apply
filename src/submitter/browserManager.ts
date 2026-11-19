/**
 * @fileoverview Centralized Chromium Browser Lifecycle Manager (Phase V2-4).
 *
 * Provides a global counting semaphore, launch queue with inter-launch cooldown throttling,
 * active browser registry, and automatic zombie process cleanup to prevent memory spikes
 * and 'Target crashed' errors on Railway Pro.
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright';

// Initialize Playwright stealth evasion globally for all managed browser instances
chromium.use(StealthPlugin());
import { createLogger } from '../utils/logger.js';
import crypto from 'crypto';

const log = createLogger('BrowserManager');

export const STANDARD_CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--window-size=1280,900',
];

export interface ManagedBrowser {
  browserId: string;
  browser: Browser;
  createdAt: number;
}

export interface BrowserManagerOptions {
  maxConcurrentBrowsers?: number;
  launchCooldownMs?: number;
  staleTtlMs?: number;
  launchFn?: (options?: LaunchOptions) => Promise<Browser>;
}

export class BrowserManager {
  private readonly maxConcurrentBrowsers: number;
  private readonly launchCooldownMs: number;
  private readonly staleTtlMs: number;
  private readonly launchFn: (options?: LaunchOptions) => Promise<Browser>;

  private activeBrowsers = new Map<string, ManagedBrowser>();
  private waitQueue: Array<() => void> = [];
  private launchChain: Promise<void> = Promise.resolve();
  private lastLaunchTime = 0;

  constructor(options: BrowserManagerOptions = {}) {
    this.maxConcurrentBrowsers = options.maxConcurrentBrowsers ?? 5;
    this.launchCooldownMs = options.launchCooldownMs ?? 1500;
    this.staleTtlMs = options.staleTtlMs ?? 10 * 60 * 1000; // 10 minutes default TTL
    this.launchFn = options.launchFn ?? ((opts) => chromium.launch(opts));
  }

  /**
   * Returns current concurrency and waiting queue metrics.
   */
  public getStats(): { activeCount: number; waitingCount: number; maxBrowsers: number } {
    return {
      activeCount: this.activeBrowsers.size,
      waitingCount: this.waitQueue.length,
      maxBrowsers: this.maxConcurrentBrowsers,
    };
  }

  /**
   * Creates a dedicated, sterile BrowserContext with standardized viewport,
   * sanitized user agent, and isolated cookies/storage.
   */
  public async createSterileContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
    return browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
      ...options,
    });
  }

  /**
   * Acquires a launch slot via semaphore, schedules the launch through the cooldown throttler,
   * and registers the live browser instance in the managed registry.
   */
  public async acquireBrowser(options: LaunchOptions = {}): Promise<ManagedBrowser> {
    await this.acquireSlot();

    const browserId = `brw_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    try {
      const browser = await this.scheduleThrottledLaunch(options);
      const managed: ManagedBrowser = {
        browserId,
        browser,
        createdAt: Date.now(),
      };
      this.activeBrowsers.set(browserId, managed);

      if (typeof browser.on === 'function') {
        browser.on('disconnected', () => {
          if (!this.activeBrowsers.has(browserId)) return;
          log.warn(`[BrowserManager] ⚠️ Browser ${browserId} disconnected unexpectedly.`);
          this.releaseBrowser(browserId).catch(() => {});
        });
      }

      log.info(
        `[BrowserManager] 🚀 Acquired browser ${browserId} (active: ${this.activeBrowsers.size}/${this.maxConcurrentBrowsers})`
      );
      return managed;
    } catch (err) {
      log.error(`[BrowserManager] ❌ Browser launch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.releaseSlot();
      throw err;
    }
  }

  /**
   * Releases a browser from tracking and frees up a semaphore slot for queued requests.
   */
  public async releaseBrowser(browserId: string): Promise<void> {
    const managed = this.activeBrowsers.get(browserId);
    if (!managed) {
      return;
    }

    this.activeBrowsers.delete(browserId);

    try {
      if (managed.browser.isConnected()) {
        await managed.browser.close().catch(() => {});
      }
    } catch {}

    log.info(
      `[BrowserManager] 🏁 Released browser ${browserId} (active: ${this.activeBrowsers.size}/${this.maxConcurrentBrowsers})`
    );

    this.releaseSlot();
  }

  /**
   * Closes all active browsers and clears the queue (e.g. during shutdown).
   */
  public async closeAll(): Promise<void> {
    const browsers = Array.from(this.activeBrowsers.values());
    this.activeBrowsers.clear();
    this.waitQueue = [];

    await Promise.all(
      browsers.map(async (m) => {
        try {
          if (m.browser.isConnected()) {
            await m.browser.close();
          }
        } catch {}
      })
    );
  }

  /**
   * Scans tracked browsers and forcefully closes any that exceed staleTtlMs or are disconnected.
   */
  public async cleanupStaleBrowsers(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, managed] of Array.from(this.activeBrowsers.entries())) {
      const isStale = now - managed.createdAt > this.staleTtlMs;
      const isDisconnected = !managed.browser.isConnected();

      if (isStale || isDisconnected) {
        log.warn(
          `[BrowserManager] 🧹 Sweeping stale/disconnected browser ${id} (age: ${Math.round(
            (now - managed.createdAt) / 1000
          )}s, disconnected: ${isDisconnected})`
        );
        await this.releaseBrowser(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeBrowsers.size < this.maxConcurrentBrowsers) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  private releaseSlot(): void {
    if (this.waitQueue.length > 0 && this.activeBrowsers.size < this.maxConcurrentBrowsers) {
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
    }
  }

  private scheduleThrottledLaunch(options: LaunchOptions): Promise<Browser> {
    const throttled = async (): Promise<Browser> => {
      const now = Date.now();
      const elapsed = now - this.lastLaunchTime;
      const delay = Math.max(0, this.launchCooldownMs - elapsed);

      if (delay > 0) {
        log.info(`[BrowserManager] ⏳ Throttling browser launch by ${delay}ms to avoid burst contention...`);
        await new Promise((r) => setTimeout(r, delay));
      }

      this.lastLaunchTime = Date.now();
      const mergedArgs = Array.from(new Set([...STANDARD_CHROMIUM_ARGS, ...(options.args || [])]));
      return this.launchFn({ ...options, args: mergedArgs });
    };

    const task = this.launchChain.then(throttled, throttled);
    this.launchChain = task.then(
      () => {},
      () => {}
    );
    return task;
  }
}

import { config } from '../config/env.js';

/** Default singleton instance */
export const browserManager = new BrowserManager({
  maxConcurrentBrowsers: config.MAX_CONCURRENT_BROWSERS,
  launchCooldownMs: config.BROWSER_LAUNCH_COOLDOWN_MS,
});
