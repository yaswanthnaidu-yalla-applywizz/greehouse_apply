import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { config } from '../src/config/env.js';
import { sendEmail, sendOtpEmail } from '../src/services/azureEmail.js';
import { sendCaNotificationEmails, sendLeadershipIngestionSummary } from '../src/services/caNotificationEmail.js';
import { sendExecutiveDailyDigest } from '../src/services/executiveDailyReport.js';

describe('DISABLE_EMAIL feature', () => {
  const originalFetch = globalThis.fetch;
  const originalDisableEmail = (config as any).DISABLE_EMAIL;
  let fetchCalls: any[] = [];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes('/oauth2/v2.0/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'fake-token', expires_in: 3600 }),
          text: async () => '',
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
      } as any;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (config as any).DISABLE_EMAIL = originalDisableEmail;
  });

  it('skips non-auth email dispatch when DISABLE_EMAIL is true without calling network', async () => {
    (config as any).DISABLE_EMAIL = true;

    const result = await sendEmail({
      to: 'dev@applywizz.ai',
      subject: 'Test Notification',
      text: 'Notification body',
    });

    assert.equal(result.success, true);
    assert.equal(result.messageId, 'disabled-by-env');
    assert.equal(fetchCalls.length, 0);
  });

  it('allows sendOtpEmail even when DISABLE_EMAIL is true', async () => {
    (config as any).DISABLE_EMAIL = true;
    (config as any).ACTIVE_AZURE_TENANT_ID = 'test-tenant';
    (config as any).AZURE_CLIENT_ID = 'test-client';
    (config as any).AZURE_CLIENT_SECRET = 'test-secret';
    (config as any).AZURE_SENDER_EMAIL = 'sender@applywizz.ai';

    const result = await sendOtpEmail({
      to: 'dev@applywizz.ai',
      otp: '654321',
    });

    assert.equal(result.success, true);
    // Should have made OAuth token call and sendMail call
    assert.ok(fetchCalls.length >= 1);
    const sendMailCall = fetchCalls.find((call) => call.url.includes('/sendMail'));
    assert.ok(sendMailCall, 'Should have called /sendMail endpoint for Auth OTP');
  });

  it('early-exits sendCaNotificationEmails when DISABLE_EMAIL is true', async () => {
    (config as any).DISABLE_EMAIL = true;

    const result = await sendCaNotificationEmails(new Date().toISOString());
    assert.equal(result.sent, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.summaries, []);
  });

  it('early-exits sendLeadershipIngestionSummary when DISABLE_EMAIL is true', async () => {
    (config as any).DISABLE_EMAIL = true;

    // Should return cleanly without throwing or making network requests
    await sendLeadershipIngestionSummary(new Date().toISOString());
    assert.equal(fetchCalls.length, 0);
  });

  it('early-exits sendExecutiveDailyDigest when DISABLE_EMAIL is true', async () => {
    (config as any).DISABLE_EMAIL = true;

    const result = await sendExecutiveDailyDigest();
    assert.equal(result.success, true);
    assert.equal(result.skipped, true);
    assert.equal(fetchCalls.length, 0);
  });
});
