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

  it('extracts 8-character alphanumeric code across varying whitespace, HTML tags, and labels', () => {
    const htmlText = `
      <div>Your verification code is:</div>
      <p style="font-size: 24px; font-weight: bold;">
        7kP9mQ2x
      </p>
      <span>Enter this code to finish your application.</span>
    `;
    const code = extractOtpCodeFromText(htmlText);
    assert.equal(code, '7kP9mQ2x');
  });

  it('extracts standalone mixed-case 8-character code with alphanumeric characters', () => {
    const text = 'Use code 9aB4cD1z to complete your Greenhouse submission.';
    const code = extractOtpCodeFromText(text);
    assert.equal(code, '9aB4cD1z');
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

  it('fetches OTP code successfully from Gmail direct inbox and message APIs', async () => {
    const originalFetch = globalThis.fetch;
    const urlsHit: string[] = [];
    const now = Date.now();

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urlsHit.push(url.pathname);

      if (url.pathname === '/api/gmail/ui/inbox') {
        assert.equal(url.searchParams.get('email'), 'candidate@gmail.com');
        return new Response(
          JSON.stringify({
            email: 'candidate@gmail.com',
            count: 2,
            messages: [
              {
                messageId: 'old-msg-1',
                from: 'no-reply@us.greenhouse-mail.io',
                subject: 'Your Block verification code',
                receivedAt: now - 600000, // Stale message (10 mins ago)
              },
              {
                messageId: 'fresh-msg-2',
                from: 'no-reply@us.greenhouse-mail.io',
                subject: 'Your Block security code',
                receivedAt: now + 1000, // Fresh message
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (url.pathname === '/api/gmail/ui/message') {
        assert.equal(url.searchParams.get('email'), 'candidate@gmail.com');
        assert.equal(url.searchParams.get('messageId'), 'fresh-msg-2');
        return new Response(
          JSON.stringify({
            message: {
              messageId: 'fresh-msg-2',
              subject: 'Your Block security code',
              from: 'no-reply@us.greenhouse-mail.io',
              to: 'candidate@gmail.com',
              receivedAt: now + 1000,
              textContent: 'Hi, your verification code is 948215. Valid for 10 minutes.',
            },
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    };

    try {
      const { fetchGmailOtpViaApi } = await import('../src/services/zoho-connector.js');
      const result = await fetchGmailOtpViaApi({
        candidateEmail: 'candidate@gmail.com',
        sinceTimestamp: now,
        companyName: 'Block',
        timeoutMs: 2000,
        pollIntervalMs: 500,
      });

      assert.equal(urlsHit.includes('/api/gmail/ui/inbox'), true, 'Must query /api/gmail/ui/inbox');
      assert.equal(urlsHit.includes('/api/gmail/ui/message'), true, 'Must query /api/gmail/ui/message');
      assert.equal(result.success, true);
      assert.equal(result.otp, '948215');
      assert.equal(result.messageId, 'fresh-msg-2');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

