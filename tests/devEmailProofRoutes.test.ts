import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { devDashboardRouter } from '../src/server/routes/devDashboard.js';

describe('Dev Dashboard email proof routes', () => {
  it('registers email-proofs/batch-retry and status endpoints', () => {
    const routes = devDashboardRouter.stack.map((layer: any) => layer.route?.path).filter(Boolean);
    assert.ok(routes.includes('/email-proofs/batch-retry'), 'missing /email-proofs/batch-retry route');
    assert.ok(routes.includes('/email-proofs/status'), 'missing /email-proofs/status route');
  });
});
