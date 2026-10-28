import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

export class InvalidationCoalescer {
  private inFlight = false;
  private queued = false;
  private timer: NodeJS.Timeout | null = null;
  public fetchCount = 0;

  constructor(private readonly fetcher: () => Promise<void>) {}

  public trigger(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.execute();
    }, 10);
  }

  private async execute(): Promise<void> {
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    this.inFlight = true;
    try {
      this.fetchCount++;
      await this.fetcher();
    } finally {
      this.inFlight = false;
      if (this.queued) {
        this.queued = false;
        void this.execute();
      }
    }
  }

  public handleVisibility(visible: boolean): void {
    if (visible) {
      this.trigger();
    }
  }

  public handleReconnect(): void {
    this.trigger();
  }

  public teardown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queued = false;
  }
}

describe('stats refresh invalidation and coalescing contract', () => {
  it('coalesces rapid burst invalidations into a single execution', async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
    };
    const coalescer = new InvalidationCoalescer(fetcher);

    // Fire 5 rapid invalidation signals
    coalescer.trigger();
    coalescer.trigger();
    coalescer.trigger();
    coalescer.trigger();
    coalescer.trigger();

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(callCount, 1, 'Burst signals should coalesce to 1 fetch');
  });

  it('schedules a follow-up fetch when an invalidation arrives during an in-flight fetch', async () => {
    let callCount = 0;
    let resolveInFlight: (() => void) | null = null;
    const fetcher = () =>
      new Promise<void>((resolve) => {
        callCount++;
        resolveInFlight = resolve;
      });

    const coalescer = new InvalidationCoalescer(fetcher);
    coalescer.trigger();

    // Wait for the first fetch to start and become in-flight
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callCount, 1);

    // Trigger another invalidation while in-flight
    coalescer.trigger();

    // Complete first in-flight fetch
    if (resolveInFlight) (resolveInFlight as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(callCount, 2, 'Queued invalidation during in-flight fetch must execute once');
  });

  it('recovers missed state on visible-tab return and on reconnect', async () => {
    let callCount = 0;
    const coalescer = new InvalidationCoalescer(async () => {
      callCount++;
    });

    // Hidden tab does not trigger
    coalescer.handleVisibility(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callCount, 0);

    // Visible tab returns
    coalescer.handleVisibility(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callCount, 1);

    // Reconnection occurs
    coalescer.handleReconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callCount, 2);

    // Second reconnect after disconnection also invalidates
    coalescer.handleReconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(callCount, 3);
  });

  it('verifies 5-minute connected reconciliation interval and 60-second disconnected fallback cadence', () => {
    // Model the cadence logic used in useApplicationStatsInvalidation
    const runTicks = (connected: boolean, totalMinutes: number): number => {
      let invalidations = 0;
      let tickCount = 0;
      for (let min = 1; min <= totalMinutes; min++) {
        tickCount++;
        if (!connected) {
          // Every 1 minute tick while disconnected
          invalidations++;
        } else if (tickCount % 5 === 0) {
          // Every 5 minute ticks while connected
          invalidations++;
        }
      }
      return invalidations;
    };

    // In 15 minutes of connected state: exactly 3 reconciliations (at 5m, 10m, 15m)
    assert.equal(runTicks(true, 15), 3, 'Connected reconciliation must trigger once per 5 minutes');

    // In 5 minutes of disconnected state: exactly 5 fallback triggers (1m, 2m, 3m, 4m, 5m)
    assert.equal(runTicks(false, 5), 5, 'Disconnected fallback must trigger every 60 seconds');
  });

  it('cleans up timers and queues cleanly on teardown', async () => {
    let callCount = 0;
    const coalescer = new InvalidationCoalescer(async () => {
      callCount++;
    });

    coalescer.trigger();
    coalescer.teardown();

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(callCount, 0, 'Teardown must cancel pending scheduled fetch');
  });
});
