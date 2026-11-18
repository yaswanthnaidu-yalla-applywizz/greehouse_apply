import test from 'node:test';
import assert from 'node:assert/strict';
import { humanType, pauseBetweenFields, type HumanCadenceOptions } from '../src/submitter/humanCadence.js';

test('Task 3: Unified Human-like Interaction Cadence', async (t) => {
  await t.test('humanType with humanize: false fills instantaneously', async () => {
    let fillValue = '';
    let pressSequentiallyCalled = false;

    const mockLocator: any = {
      scrollIntoViewIfNeeded: async () => {},
      fill: async (v: string) => { fillValue = v; },
      click: async () => {},
      pressSequentially: async () => { pressSequentiallyCalled = true; },
    };

    await humanType(mockLocator, 'Jane Doe', { humanize: false });
    assert.strictEqual(fillValue, 'Jane Doe');
    assert.strictEqual(pressSequentiallyCalled, false);
  });

  await t.test('humanType with humanize: true types character-by-character with jitter', async () => {
    const typedChars: string[] = [];
    const delays: number[] = [];

    const mockLocator: any = {
      scrollIntoViewIfNeeded: async () => {},
      fill: async () => {},
      click: async () => {},
      pressSequentially: async (char: string, opts?: { delay?: number }) => {
        typedChars.push(char);
        if (opts?.delay !== undefined) delays.push(opts.delay);
      },
    };

    await humanType(mockLocator, 'Hello', {
      humanize: true,
      typingDelayMinMs: 40,
      typingDelayMaxMs: 80,
    });

    assert.strictEqual(typedChars.join(''), 'Hello');
    assert.strictEqual(delays.length, 5);
    for (const d of delays) {
      assert.ok(d >= 40 && d <= 80, `delay ${d} should be within [40, 80]`);
    }
  });

  await t.test('pauseBetweenFields waits within configured min and max bounds', async () => {
    let waitedMs = 0;
    const mockPage: any = {
      waitForTimeout: async (ms: number) => { waitedMs = ms; },
    };

    await pauseBetweenFields(mockPage, {
      humanize: true,
      fieldGapMinMs: 100,
      fieldGapMaxMs: 300,
    });

    assert.ok(waitedMs >= 100 && waitedMs <= 300, `waited ${waitedMs} should be between 100 and 300`);

    // With humanize: false
    waitedMs = 0;
    await pauseBetweenFields(mockPage, { humanize: false });
    assert.strictEqual(waitedMs, 0);
  });
});
