import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  preflightFallback,
  shouldAttemptApifyPreflightFallback,
} from '../src/submitter/ashbySubmit.js';

describe('Ashby Apify preflight fallback eligibility', () => {
  it('allows one configured Apify fallback after failed Massive preflight', () => {
    assert.equal(
      shouldAttemptApifyPreflightFallback(true, 'http://apify-user:apify-password@proxy.example:8123', {
        success: false,
        error: 'Preflight probe timed out',
      }),
      true
    );
  });

  it('preserves the existing path when Massive, Apify credentials, or preflight failure is absent', () => {
    assert.equal(shouldAttemptApifyPreflightFallback(false, 'http://apify-user:apify-password@proxy.example:8123', { success: false }), false);
    assert.equal(shouldAttemptApifyPreflightFallback(true, undefined, { success: false }), false);
    assert.equal(shouldAttemptApifyPreflightFallback(true, 'http://apify-user:apify-password@proxy.example:8123', { success: true }), false);
  });

  it('only considers a failed pre-navigation preflight result', () => {
    assert.equal(
      shouldAttemptApifyPreflightFallback(true, 'http://apify-user:apify-password@proxy.example:8123', {
        success: true,
        error: 'CAPTCHA challenge detected',
      }),
      false
    );
  });

  it('releases Massive before acquiring Apify and returns its successful preflight', async () => {
    const events = ['massive-probe-failed'];
    const massivePage = {};
    const apifyPage = {};

    const result = await preflightFallback({
      page: massivePage,
      preflight: { success: false, outcome: 'timeout', error: 'Massive timed out' },
      shouldFallback: true,
      releaseCurrent: async () => {
        events.push('release-massive-browser');
      },
      acquireFallback: async () => {
        events.push('acquire-apify-browser');
        return apifyPage;
      },
      verify: async () => {
        events.push('verify-apify');
        return { success: true, outcome: 'success', exitIpHash: 'apify-exit' };
      },
    });

    assert.deepEqual(events, [
      'massive-probe-failed',
      'release-massive-browser',
      'acquire-apify-browser',
      'verify-apify',
    ]);
    assert.equal(result.page, apifyPage);
    assert.equal(result.preflight.success, true);
  });

  it('returns the final failed preflight when Massive and Apify both fail', async () => {
    const events: string[] = [];
    const massivePage = {};
    const apifyPage = {};

    const result = await preflightFallback({
      page: massivePage,
      preflight: { success: false, outcome: 'timeout', error: 'Massive timed out' },
      shouldFallback: true,
      releaseCurrent: async () => {
        events.push('release-massive-browser');
      },
      acquireFallback: async () => {
        events.push('acquire-apify-browser');
        return apifyPage;
      },
      verify: async () => {
        events.push('verify-apify');
        return { success: false, outcome: 'network_error', error: 'Apify failed' };
      },
    });

    assert.deepEqual(events, ['release-massive-browser', 'acquire-apify-browser', 'verify-apify']);
    assert.equal(result.preflight.success, false);
  });
});
