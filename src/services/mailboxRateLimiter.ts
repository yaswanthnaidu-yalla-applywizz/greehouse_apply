/**
 * Shared token bucket rate limiter for candidate mailbox REST endpoints (Zoho & Gmail).
 * Caps total requests at 3 req/sec across all workers to eliminate HTTP 429 rate limits.
 */

export class TokenBucketLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRatePerSecond: number;
  private lastRefillTimestamp: number;
  private queue: Array<() => void> = [];
  private refillTimer: NodeJS.Timeout | null = null;

  constructor(maxTokens = 3, refillRatePerSecond = 3) {
    this.maxTokens = maxTokens;
    this.refillRatePerSecond = refillRatePerSecond;
    this.tokens = maxTokens;
    this.lastRefillTimestamp = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTimestamp) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + elapsedSeconds * this.refillRatePerSecond);
      this.lastRefillTimestamp = now;
    }

    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const resolve = this.queue.shift();
      resolve?.();
    }
  }

  public async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1 && this.queue.length === 0) {
      this.tokens -= 1;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      if (!this.refillTimer) {
        this.refillTimer = setInterval(() => {
          this.refill();
          if (this.queue.length === 0 && this.refillTimer) {
            clearInterval(this.refillTimer);
            this.refillTimer = null;
          }
        }, 100);
        this.refillTimer.unref?.();
      }
    });
  }

  public getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }
}

export const mailboxRateLimiter = new TokenBucketLimiter(3, 3);
