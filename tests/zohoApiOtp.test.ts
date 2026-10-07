import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOtpCodeFromText,
  fetchZohoOtpViaApi,
} from '../src/services/zoho-connector.js';

describe('extractOtpCodeFromText', () => {
  it('extracts Greenhouse copy-paste format from body', () => {
    const text = `
      Hi Sri,
      Please complete your application for DoorDash.
      Copy and paste this code into the security code field on your application: NgW4NT62
      Thanks!
    `;
    const code = extractOtpCodeFromText(text);
    assert.equal(code, 'NgW4NT62');
  });

  it('extracts labeled verification code from text', () => {
    const text = 'Your verification code is: 938104. Please enter it within 10 minutes.';
    const code = extractOtpCodeFromText(text);
    assert.equal(code, '938104');
  });

  it('extracts 8-character alphanumeric code with letters and digits', () => {
    const text = 'Here is your security code: Aebf0aDc to continue applying.';
    const code = extractOtpCodeFromText(text);
    assert.equal(code, 'Aebf0aDc');
  });

  it('extracts 6-digit numeric OTP code', () => {
    const text = 'Enter the following code to verify your account: 629103';
    const code = extractOtpCodeFromText(text);
    assert.equal(code, '629103');
  });

  it('returns null on non-OTP text or stopwords', () => {
    const text = 'Thank you for your application to DoorDash. We have received your response.';
    const code = extractOtpCodeFromText(text);
    assert.equal(code, null);
  });

  it('fetches OTP from the message body instead of extracting it from the subject', async () => {
    const originalFetch = globalThis.fetch;
    let messageDetailFetched = false;

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/api/zoho/ui/inbox')) {
        return new Response(
          JSON.stringify({
            accountId: 'account-1',
            messages: [
              {
                messageId: 'message-1',
                folderId: 'folder-1',
                from: 'no-reply@us.greenhouse-mail.io',
                subject: 'Security code for ExampleCo is Subject123',
                receivedTime: Date.now(),
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url.pathname.endsWith('/api/zoho/ui/message')) {
        messageDetailFetched = true;
        assert.equal(url.searchParams.get('accountId'), 'account-1');
        assert.equal(url.searchParams.get('folderId'), 'folder-1');
        assert.equal(url.searchParams.get('messageId'), 'message-1');
        return new Response(
          JSON.stringify({
            message: {
              textContent:
                'Copy and paste this code into the security code field on your application: Body1234',
            },
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected Zoho API request: ${url}`);
    };

    try {
      const result = await fetchZohoOtpViaApi({
        candidateEmail: 'candidate@example.com',
        sinceTimestamp: Date.now() - 30_000,
        companyName: 'ExampleCo',
        timeoutMs: 3000,
      });

      assert.equal(messageDetailFetched, true);
      assert.equal(result.success, true);
      assert.equal(result.otp, 'Body1234');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
