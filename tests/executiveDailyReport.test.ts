import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveExecutiveDailyReportRecipients,
  aggregateIngestRunMetrics,
  generateExecutiveSummary,
} from '../src/services/executiveDailyReport.js';

describe('executiveDailyReport - recipients resolution', () => {
  it('resolves production recipients to Ramakrishna with CC to Anusha, Yaswanth, Vivek', () => {
    delete process.env.SANDBOX;
    delete process.env.CA_NOTIFICATION_EMAIL_OVERRIDE;
    const recipients = resolveExecutiveDailyReportRecipients();
    assert.deepEqual(recipients.to, ['ramakrishna@applywizz.ai']);
    assert.deepEqual(recipients.cc, [
      'anushabandreddy@applywizz.ai',
      'yaswanthnaiduyalla@applywizz.ai',
      'vivek@applywizz.ai',
    ]);
  });

  it('redirects to dev email when SANDBOX=true', () => {
    process.env.SANDBOX = 'true';
    const recipients = resolveExecutiveDailyReportRecipients();
    assert.deepEqual(recipients.to, ['yaswanthnaiduyalla@applywizz.ai']);
    assert.deepEqual(recipients.cc, []);
    delete process.env.SANDBOX;
  });

  it('redirects to override email when CA_NOTIFICATION_EMAIL_OVERRIDE is set', () => {
    process.env.CA_NOTIFICATION_EMAIL_OVERRIDE = 'override@applywizz.ai';
    const recipients = resolveExecutiveDailyReportRecipients();
    assert.deepEqual(recipients.to, ['override@applywizz.ai']);
    assert.deepEqual(recipients.cc, []);
    delete process.env.CA_NOTIFICATION_EMAIL_OVERRIDE;
  });
});

describe('executiveDailyReport - metrics aggregation and ATS breakdown', () => {
  it('aggregates status counts, separates ATS types, and groups failure reasons', () => {
    const mockRows = [
      // Greenhouse apps
      { id: '1', status: 'APPLIED', job_url: 'https://boards.greenhouse.io/acme/jobs/123' },
      { id: '2', status: 'APPLIED', job_url: 'https://boards.greenhouse.io/acme/jobs/124' },
      { id: '3', status: 'FAILED', job_url: 'https://boards.greenhouse.io/acme/jobs/125', error_message: 'anti-bot cloudflare challenge detected' },
      { id: '4', status: 'FAILED', job_url: 'https://boards.greenhouse.io/acme/jobs/126', error_message: 'Cloudflare turnstile challenge' },
      { id: '5', status: 'QUEUED', job_url: 'https://boards.greenhouse.io/acme/jobs/127' },
      // Ashby apps
      { id: '6', status: 'APPLIED', job_url: 'https://jobs.ashbyhq.com/techcorp/456' },
      { id: '7', status: 'FAILED', job_url: 'https://jobs.ashbyhq.com/techcorp/457', error_message: 'OTP retrieval timed out after 300s' },
      { id: '8', status: 'QUEUED', job_url: 'https://jobs.ashbyhq.com/techcorp/458' },
      // Other
      { id: '9', status: 'READY_FOR_REVIEW', job_url: 'https://careers.example.com/job/789' },
    ];

    const data = aggregateIngestRunMetrics(mockRows, '2026-11-17');

    assert.equal(data.targetDate, '2026-11-17');
    assert.equal(data.totalApplications, 9);
    assert.equal(data.totalApplied, 3);
    assert.equal(data.totalFailed, 3);
    assert.equal(data.totalQueued, 2);
    assert.equal(data.totalReadyForReview, 1);

    // Completion: (3 applied + 3 failed) / 9 = 66.7%
    assert.equal(data.completionRatePercent, 66.7);
    // Success: 3 applied / 6 terminal = 50%
    assert.equal(data.successRatePercent, 50);

    // ATS Breakdown
    assert.equal(data.atsBreakdown.greenhouse.total, 5);
    assert.equal(data.atsBreakdown.greenhouse.applied, 2);
    assert.equal(data.atsBreakdown.greenhouse.failed, 2);
    assert.equal(data.atsBreakdown.greenhouse.queued, 1);

    assert.equal(data.atsBreakdown.ashby.total, 3);
    assert.equal(data.atsBreakdown.ashby.applied, 1);
    assert.equal(data.atsBreakdown.ashby.failed, 1);
    assert.equal(data.atsBreakdown.ashby.queued, 1);

    assert.equal(data.atsBreakdown.other.total, 1);
    assert.equal(data.atsBreakdown.other.readyForReview, 1);

    // Grouped failure reasons
    assert.ok(data.failureReasons.length >= 2);
    const topFailure = data.failureReasons[0];
    assert.ok(topFailure.reason.toLowerCase().includes('challenge') || topFailure.category.includes('Bot'));
    assert.equal(topFailure.count, 2); // 2 cloudflare errors normalized together

    const otpFailure = data.failureReasons.find((f) => f.category === 'OTP');
    assert.ok(otpFailure);
    assert.equal(otpFailure.count, 1);
  });

  it('handles empty run gracefully without division by zero', () => {
    const data = aggregateIngestRunMetrics([], '2026-11-17');
    assert.equal(data.totalApplications, 0);
    assert.equal(data.totalApplied, 0);
    assert.equal(data.totalFailed, 0);
    assert.equal(data.successRatePercent, 0);
    assert.equal(data.completionRatePercent, 0);
    assert.equal(data.failureReasons.length, 0);
  });
});

describe('executiveDailyReport - summary generator', () => {
  it('generates a crisp bulleted executive summary highlighting volume, rates, and primary blocker', () => {
    const summary = generateExecutiveSummary({
      targetDate: '2026-11-17',
      totalApplications: 100,
      totalApplied: 75,
      totalFailed: 15,
      totalQueued: 10,
      totalReadyForReview: 0,
      completionRatePercent: 90,
      successRatePercent: 83.3,
      atsBreakdown: {
        greenhouse: { total: 80, applied: 65, failed: 10, queued: 5, readyForReview: 0, other: 0 },
        ashby: { total: 20, applied: 10, failed: 5, queued: 5, readyForReview: 0, other: 0 },
        other: { total: 0, applied: 0, failed: 0, queued: 0, readyForReview: 0, other: 0 },
      },
      failureReasons: [
        { reason: 'Anti-bot / CAPTCHA challenge encountered', category: 'Bot Challenge', count: 10 },
        { reason: 'OTP retrieval / submission timeout', category: 'OTP', count: 5 },
      ],
    });

    assert.ok(summary.includes('100 total applications'));
    assert.ok(summary.includes('75 applied'));
    assert.ok(summary.includes('83.3% success rate'));
    assert.ok(summary.includes('Greenhouse'));
    assert.ok(summary.includes('Anti-bot / CAPTCHA challenge encountered'));
  });
});
