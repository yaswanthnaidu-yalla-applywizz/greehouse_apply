import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { browserManager } from '../src/submitter/browserManager.js';
import {
  storePausedSession,
  registerSubmissionSession,
  clearPausedSession,
  resolvePausedSession,
} from '../src/submitter/otpSession.js';

describe('OTP Session browserId preservation', () => {
  it('preserves browserId through registerSubmissionSession and frees BrowserManager slot on clear', async () => {
    let closed = false;
    const fakeBrowser = {
      isConnected: () => true,
      close: async () => {
        closed = true;
      },
      on: () => {},
    } as any;

    const b = await browserManager.acquireBrowser({ headless: true } as any).catch(async () => {
      // If launch fails (no chrome in test runner), manually register in activeBrowsers
      const testId = `brw_test_${Date.now()}`;
      Reflect.get(browserManager, 'activeBrowsers').set(testId, {
        browserId: testId,
        browser: fakeBrowser,
        createdAt: Date.now(),
      });
      return { browserId: testId, browser: fakeBrowser, createdAt: Date.now() };
    });

    const initialActive = browserManager.getStats().activeCount;
    assert.ok(initialActive >= 1);

    storePausedSession('app-test-pid', {
      browser: b.browser,
      browserId: b.browserId,
      applicationId: 'app-test-pid',
    });

    registerSubmissionSession({
      applicationId: 'app-test-pid',
      browser: b.browser,
      page: null as any,
    });

    const resolved = resolvePausedSession('app-test-pid');
    assert.equal(resolved?.session.browserId, b.browserId, 'browserId must be preserved');

    await clearPausedSession('app-test-pid');
    assert.equal(
      browserManager.getStats().activeCount,
      initialActive - 1,
      'BrowserManager active slot must be freed'
    );
  });
});
