import test from 'node:test';
import assert from 'node:assert/strict';
import { browserManager } from '../src/submitter/browserManager.js';

test('Task 2: Per-Application Sterile BrowserContext Isolation', async (t) => {
  let managedBrowser: any = null;

  t.before(async () => {
    managedBrowser = await browserManager.acquireBrowser({ headless: true });
  });

  t.after(async () => {
    if (managedBrowser) {
      await browserManager.releaseBrowser(managedBrowser.browserId);
    }
  });

  await t.test('createSterileContext creates fresh isolated environment with standard viewport', async () => {
    const context1 = await (browserManager as any).createSterileContext(managedBrowser.browser);
    const page1 = await context1.newPage();

    // Verify viewport
    const viewport = page1.viewportSize();
    assert.strictEqual(viewport?.width, 1280);
    assert.strictEqual(viewport?.height, 900);

    // Set cookie and web storage in context 1
    await context1.addCookies([
      {
        name: 'cf_clearance',
        value: 'mock_turnstile_token_123',
        domain: 'example.com',
        path: '/',
      },
      {
        name: '__hssc',
        value: 'mock_session_456',
        domain: 'example.com',
        path: '/',
      },
    ]);

    const cookies1 = await context1.cookies();
    assert.strictEqual(cookies1.length, 2);

    // Create context 2 from the same underlying browser
    const context2 = await (browserManager as any).createSterileContext(managedBrowser.browser);
    const page2 = await context2.newPage();

    // Verify context 2 has ZERO cookies from context 1
    const cookies2 = await context2.cookies();
    assert.strictEqual(cookies2.length, 0, 'Context 2 must not inherit cookies from Context 1');

    // Clean up
    await context1.close();
    await context2.close();
  });

  await t.test('sequential contexts on the same browser do not leak state', async () => {
    // Session 1
    const ctxA = await (browserManager as any).createSterileContext(managedBrowser.browser);
    await ctxA.addCookies([{ name: 'session_id', value: 'candidate_A', domain: 'lever.co', path: '/' }]);
    assert.strictEqual((await ctxA.cookies()).length, 1);
    await ctxA.close();

    // Session 2
    const ctxB = await (browserManager as any).createSterileContext(managedBrowser.browser);
    assert.strictEqual((await ctxB.cookies()).length, 0, 'Session B must have clean cookies');
    await ctxB.close();
  });
});
