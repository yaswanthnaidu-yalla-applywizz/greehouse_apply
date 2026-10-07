import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applicationNeedsOperatorReview } from '../src/resolver/needsReview.js';
import {
  RESOLVE_STATUS_PRESERVE,
  RESOLVE_AUTO_ENQUEUE_ELIGIBLE,
  upsertApplication,
} from '../src/db/applications.js';
import {
  groupReadyForReviewByCa,
  buildCaNotificationHtml,
  sendCaNotificationEmails,
} from '../src/services/caNotificationEmail.js';

describe('Auto-queue Routing & NeedsReview', () => {
  it('applicationNeedsOperatorReview requires review when a required field has source=ai', () => {
    const fields = [
      { isRequired: true, source: 'supabase' },
      { isRequired: true, source: 'ai' },
      { isRequired: false, source: 'resume_parse' },
    ];
    assert.equal(applicationNeedsOperatorReview(fields), true);
  });

  it('applicationNeedsOperatorReview requires review when a required field has source=unresolved', () => {
    const fields = [
      { isRequired: true, source: 'supabase' },
      { isRequired: true, source: 'unresolved' },
    ];
    assert.equal(applicationNeedsOperatorReview(fields), true);
  });

  it('applicationNeedsOperatorReview requires review when a required field has missing/null source', () => {
    const fields = [
      { isRequired: true, source: null },
    ];
    assert.equal(applicationNeedsOperatorReview(fields), true);
  });

  it('applicationNeedsOperatorReview does NOT require review when AI or unresolved fields are optional', () => {
    const fields = [
      { isRequired: true, source: 'supabase' },
      { isRequired: true, source: 'resume_parse' },
      { isRequired: true, source: 'semantic' },
      { isRequired: false, source: 'ai' },
      { isRequired: false, source: 'unresolved' },
    ];
    assert.equal(applicationNeedsOperatorReview(fields), false);
  });

  it('applicationNeedsOperatorReview does NOT require review when all required sources are safe', () => {
    const fields = [
      { isRequired: true, source: 'supabase' },
      { isRequired: true, source: 'resume_parse' },
      { isRequired: true, source: 'semantic' },
      { isRequired: true, source: 'fuzzy_match' },
      { isRequired: true, source: 'api' },
      { isRequired: true, source: 'manual' },
    ];
    assert.equal(applicationNeedsOperatorReview(fields), false);
  });

  it('applicationNeedsOperatorReview returns false for empty or all-optional fields', () => {
    assert.equal(applicationNeedsOperatorReview([]), false);
    assert.equal(
      applicationNeedsOperatorReview([
        { isRequired: false, source: 'ai' },
        { isRequired: false, source: 'unresolved' },
      ]),
      false
    );
  });
});

describe('Status Preservation & Auto-enqueue Eligibility', () => {
  it('RESOLVE_STATUS_PRESERVE contains all terminal and in-flight statuses', () => {
    const expected = [
      'APPLIED',
      'FAILED',
      'APPLYING',
      'QUEUED',
      'OTP_REQUIRED',
      'CAPTCHA_TIMEOUT',
      'CAPTCHA_REQUIRED',
      'SKIPPED',
      'RETRY',
      'EMAIL_PROOF_PENDING',
      'DRY_RUN_COMPLETE',
      'EXPIRED',
    ];
    for (const status of expected) {
      assert.equal(
        RESOLVE_STATUS_PRESERVE.has(status as any),
        true,
        `Expected ${status} to be in RESOLVE_STATUS_PRESERVE`
      );
    }
    assert.equal(RESOLVE_STATUS_PRESERVE.has('READY_FOR_REVIEW'), false);
    assert.equal(RESOLVE_STATUS_PRESERVE.has('APPROVED'), false);
  });

  it('RESOLVE_AUTO_ENQUEUE_ELIGIBLE only permits READY_FOR_REVIEW and APPROVED', () => {
    assert.equal(RESOLVE_AUTO_ENQUEUE_ELIGIBLE.has('READY_FOR_REVIEW'), true);
    assert.equal(RESOLVE_AUTO_ENQUEUE_ELIGIBLE.has('APPROVED'), true);
    assert.equal(RESOLVE_AUTO_ENQUEUE_ELIGIBLE.has('QUEUED'), false);
    assert.equal(RESOLVE_AUTO_ENQUEUE_ELIGIBLE.has('APPLIED'), false);
    assert.equal(RESOLVE_AUTO_ENQUEUE_ELIGIBLE.has('FAILED'), false);
    assert.equal(RESOLVE_AUTO_ENQUEUE_ELIGIBLE.has('APPLYING'), false);
  });

  it('upsertApplication preserves existing terminal status in fallback mode', async () => {
    const applywizzId = `TEST_${Date.now()}`;
    const jobUrl = 'https://boards.greenhouse.io/testco/jobs/12345';

    // Seed existing app as APPLIED
    const seeded = await upsertApplication({
      applywizz_id: applywizzId,
      job_url: jobUrl,
      status: 'APPLIED',
      resolved_fields: [{ name: 'first_name', value: 'Jane', source: 'supabase' }],
    });
    assert.equal(seeded.status, 'APPLIED');

    // Re-ingest with READY_FOR_REVIEW
    const reingested = await upsertApplication({
      applywizz_id: applywizzId,
      job_url: jobUrl,
      status: 'READY_FOR_REVIEW',
      resolved_fields: [{ name: 'first_name', value: 'Jane', source: 'supabase' }],
    });
    // Status must remain APPLIED!
    assert.equal(reingested.status, 'APPLIED');
  });
});

describe('CA Notification Email', () => {
  it('groupReadyForReviewByCa groups rows by CA email and counts unique clients', () => {
    const rows = [
      { applywizz_id: 'AW-001', assigned_ca_email: 'ca1@example.com' },
      { applywizz_id: 'AW-001', assigned_ca_email: 'ca1@example.com' },
      { applywizz_id: 'AW-002', assigned_ca_email: 'CA1@EXAMPLE.COM ' },
      { applywizz_id: 'AW-003', assigned_ca_email: 'ca2@example.com' },
      { applywizz_id: 'AW-004', assigned_ca_email: null },
      { applywizz_id: 'AW-005', assigned_ca_email: '  ' },
    ];

    const summaries = groupReadyForReviewByCa(rows);
    assert.equal(summaries.length, 2);

    const ca1 = summaries.find((s) => s.caEmail === 'ca1@example.com');
    assert.ok(ca1);
    assert.equal(ca1.appCount, 3);
    assert.equal(ca1.clientCount, 2);

    const ca2 = summaries.find((s) => s.caEmail === 'ca2@example.com');
    assert.ok(ca2);
    assert.equal(ca2.appCount, 1);
    assert.equal(ca2.clientCount, 1);
  });

  it('buildCaNotificationHtml formats HTML template properly', () => {
    const html = buildCaNotificationHtml({
      caEmail: 'ca@applywizz.ai',
      clientCount: 4,
      appCount: 12,
    });

    assert.match(html, /12 application\(s\)/);
    assert.match(html, /4 client\(s\)/);
    assert.match(html, /https:\/\/gh\.applywizz\.ai/);
    assert.match(html, /automated message from ApplyWizz/i);
  });

  it('sendCaNotificationEmails completes safely without unhandled rejections', async () => {
    // When Supabase or Azure is unconfigured/offline, function returns gracefully
    const result = await sendCaNotificationEmails(new Date().toISOString());
    assert.ok(typeof result.sent === 'number');
    assert.ok(typeof result.failed === 'number');
    assert.ok(Array.isArray(result.summaries));
  });
});
