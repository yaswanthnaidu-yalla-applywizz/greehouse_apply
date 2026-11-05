import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFailureReason,
  computeDateOffset,
  handleAnalysisStats,
  handleRequeueRetryable,
} from '../src/server/analysisStats.js';
import type { Request, Response } from 'express';

describe('analysisStats unit tests', () => {
  describe('normalizeFailureReason', () => {
    it('normalizes email verification timeouts as terminal', () => {
      const res = normalizeFailureReason('Verification email was not received within timeout (300s)');
      assert.equal(res.category, 'Email Verification');
      assert.equal(res.reason, 'Email verification timeout');
      assert.equal(res.isRetryable, false);
    });

    it('normalizes OTP timeouts and failures as retryable', () => {
      const res = normalizeFailureReason('OTP verification timed out while polling Zoho mail');
      assert.equal(res.category, 'OTP');
      assert.equal(res.reason, 'OTP retrieval / submission timeout');
      assert.equal(res.isRetryable, true);
    });

    it('normalizes mandatory cover letter requirements as terminal', () => {
      const res = normalizeFailureReason('Application requires mandatory cover letter upload');
      assert.equal(res.category, 'Validation');
      assert.equal(res.reason, 'Mandatory cover letter required');
      assert.equal(res.isRetryable, false);
    });

    it('normalizes empty required fields as terminal', () => {
      const res = normalizeFailureReason('Required field empty: "years_of_experience" was left blank');
      assert.equal(res.category, 'Form Fill');
      assert.equal(res.reason, 'Required field empty or unmapped');
      assert.equal(res.isRetryable, false);
    });

    it('normalizes navigation and load timeouts as retryable', () => {
      const res = normalizeFailureReason('Navigation timeout of 30000ms exceeded while opening job link');
      assert.equal(res.category, 'Network / Timeout');
      assert.equal(res.reason, 'Page navigation / load timeout');
      assert.equal(res.isRetryable, true);
    });

    it('normalizes anti-bot and cloudflare challenges as retryable', () => {
      const res = normalizeFailureReason('Cloudflare Turnstile captcha challenge encountered');
      assert.equal(res.category, 'Bot Challenge');
      assert.equal(res.reason, 'Anti-bot / CAPTCHA challenge encountered');
      assert.equal(res.isRetryable, true);
    });

    it('normalizes rate limits (429) as retryable', () => {
      const res = normalizeFailureReason('HTTP 429 Too Many Requests from rate limiter');
      assert.equal(res.category, 'Rate Limit');
      assert.equal(res.reason, 'Rate limited by job board');
      assert.equal(res.isRetryable, true);
    });

    it('sanitizes UUIDs and long numbers in unexpected error messages', () => {
      const res = normalizeFailureReason(
        'Unexpected backend error occurred at run 12345678-1234-1234-1234-123456789abc with code 998811'
      );
      assert.equal(res.category, 'General Failure');
      assert.ok(!res.reason.includes('12345678-1234-1234-1234-123456789abc'));
      assert.ok(res.reason.includes('<id>'));
      assert.ok(res.reason.includes('<num>'));
    });

    it('handles empty or null error messages gracefully', () => {
      const res1 = normalizeFailureReason('');
      assert.equal(res1.reason, 'Unknown failure');
      const res2 = normalizeFailureReason(null);
      assert.equal(res2.reason, 'Unknown failure');
    });
  });

  describe('computeDateOffset', () => {
    it('computes offsets backward in time across months', () => {
      const offset = computeDateOffset('2026-03-01', 1);
      assert.equal(offset, '2026-02-28');
    });

    it('computes 7 days back', () => {
      const offset = computeDateOffset('2026-11-05', 6);
      assert.equal(offset, '2026-10-30');
    });
  });

  describe('handleAnalysisStats handler execution', () => {
    it('handles single date mode request structure', async () => {
      let status = 200;
      let jsonPayload: any = null;

      const mockReq = {
        query: {
          mode: 'date',
          date: '2026-11-05',
          ats: 'all',
        },
      } as unknown as Request;

      const mockRes = {
        status(code: number) {
          status = code;
          return this;
        },
        json(data: any) {
          jsonPayload = data;
          return this;
        },
      } as unknown as Response;

      await handleAnalysisStats(mockReq, mockRes);

      assert.equal(status, 200);
      assert.ok(jsonPayload);
      assert.equal(jsonPayload.mode, 'date');
      assert.equal(jsonPayload.range.fromDate, '2026-11-05');
      assert.equal(jsonPayload.range.toDate, '2026-11-05');
      assert.equal(jsonPayload.timeline.length, 1);
      assert.ok(typeof jsonPayload.summary.total === 'number');
      assert.ok(typeof jsonPayload.summary.applied === 'number');
      assert.ok(typeof jsonPayload.summary.failed === 'number');
      assert.ok(typeof jsonPayload.summary.clients === 'number');
      assert.ok(Array.isArray(jsonPayload.failures));
    });

    it('handles 7d period mode request structure', async () => {
      let jsonPayload: any = null;

      const mockReq = {
        query: {
          mode: 'period',
          preset: '7d',
          ats: 'greenhouse',
        },
      } as unknown as Request;

      const mockRes = {
        status() {
          return this;
        },
        json(data: any) {
          jsonPayload = data;
          return this;
        },
      } as unknown as Response;

      await handleAnalysisStats(mockReq, mockRes);

      assert.ok(jsonPayload);
      assert.equal(jsonPayload.mode, 'period');
      assert.equal(jsonPayload.ats, 'greenhouse');
      assert.equal(jsonPayload.timeline.length, 7);
      assert.ok(Array.isArray(jsonPayload.failures));
    });
  });

  describe('router mounting and filtered-stats handler', () => {
    it('adminDashboardRouter and devDashboardRouter expose analysis and filtered-stats routes', async () => {
      const { adminDashboardRouter } = await import('../src/server/routes/adminDashboard.js');
      const { devDashboardRouter } = await import('../src/server/routes/devDashboard.js');

      const adminRoutes = adminDashboardRouter.stack
        .filter((layer: any) => layer.route)
        .map((layer: any) => ({
          path: layer.route.path,
          method: Object.keys(layer.route.methods)[0],
        }));

      const devRoutes = devDashboardRouter.stack
        .filter((layer: any) => layer.route)
        .map((layer: any) => ({
          path: layer.route.path,
          method: Object.keys(layer.route.methods)[0],
        }));

      assert.ok(adminRoutes.some((r) => r.path === '/filtered-stats' && r.method === 'get'));
      assert.ok(adminRoutes.some((r) => r.path === '/analysis' && r.method === 'get'));
      assert.ok(adminRoutes.some((r) => r.path === '/analysis/requeue' && r.method === 'post'));
      assert.ok(devRoutes.some((r) => r.path === '/filtered-stats' && r.method === 'get'));
      assert.ok(devRoutes.some((r) => r.path === '/analysis' && r.method === 'get'));
      assert.ok(devRoutes.some((r) => r.path === '/analysis/requeue' && r.method === 'post'));
    });
  });

  describe('handleRequeueRetryable handler', () => {
    it('handles requeue request structure and returns result payload', async () => {
      let jsonPayload: any = null;

      const mockReq = {
        body: {
          mode: 'period',
          preset: '7d',
          ats: 'all',
        },
      } as unknown as Request;

      const mockRes = {
        status() {
          return this;
        },
        json(data: any) {
          jsonPayload = data;
          return this;
        },
      } as unknown as Response;

      await handleRequeueRetryable(mockReq, mockRes);

      assert.ok(jsonPayload);
      assert.equal(jsonPayload.success, true);
      assert.ok(typeof jsonPayload.requeuedCount === 'number');
    });
  });
});
