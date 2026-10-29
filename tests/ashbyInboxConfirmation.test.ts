import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { queryZohoConfirmationEmail } from '../src/services/inbox/zohoStrategy.js';
import { queryGmailConfirmationEmail } from '../src/services/inbox/gmailStrategy.js';
import { queryConfirmationEmail } from '../src/services/zoho-connector.js';

describe('Ashby Connected Inbox Confirmation Routing (Task 9)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('Zoho strategy: Ashby matching email returns EmailProofJson', async () => {
    const submissionTime = Date.now();
    const candidateEmail = 'candidate@applywizard.ai';
    const companyName = 'Nexxen';

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/zoho/ui/inbox') {
        return new Response(
          JSON.stringify({
            accountId: 'acc-123',
            folder: { folderId: 'folder-inbox' },
            messages: [
              {
                messageId: 'msg-ashby-confirm-1',
                folderId: 'folder-inbox',
                from: 'no-reply@ashbyhq.com',
                to: candidateEmail,
                subject: 'Thank You for Applying to Nexxen',
                receivedTime: submissionTime + 2000,
              },
            ],
            count: 1,
            totalMatched: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.pathname === '/api/zoho/ui/message') {
        assert.equal(url.searchParams.get('messageId'), 'msg-ashby-confirm-1');
        return new Response(
          JSON.stringify({
            message: {
              messageId: 'msg-ashby-confirm-1',
              from: 'no-reply@ashbyhq.com',
              to: candidateEmail,
              subject: 'Thank You for Applying to Nexxen',
              receivedTime: submissionTime + 2000,
              textContent:
                'Thank you for applying to Nexxen! We have received your application for the Senior ML Engineer role and our team will review your application.',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL called: ${url.pathname}`);
    };

    const res = await queryZohoConfirmationEmail({
      candidateEmail,
      companyName,
      submissionTime,
      ats: 'ashby',
      jobTitle: 'Senior ML Engineer',
    });

    assert.equal(res.success, true);
    assert.equal(res.matched, true);
    assert.ok(res.email, 'res.email must be populated');
    assert.equal(res.email.messageId, 'msg-ashby-confirm-1');
    assert.equal(res.email.from, 'no-reply@ashbyhq.com');
    assert.equal(res.email.to, candidateEmail);
    assert.match(res.email.subject, /Nexxen/);
    assert.match(res.email.body_text, /received your application/i);
    assert.ok(res.email.received_at);
  });

  it('Zoho strategy: Ashby email arriving 3s before submissionTime matches via clock skew', async () => {
    const submissionTime = 1710000010000;
    // Message arrived 3,000ms before form submit click (clock skew allows up to 5,000ms)
    const arrivalTime = submissionTime - 3000;
    const candidateEmail = 'candidate@applywizard.ai';
    const companyName = 'Keycard';

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/zoho/ui/inbox') {
        return new Response(
          JSON.stringify({
            accountId: 'acc-123',
            folder: { folderId: 'folder-inbox' },
            messages: [
              {
                messageId: 'msg-clock-skew-1',
                folderId: 'folder-inbox',
                from: 'no-reply@keycard.ai',
                to: candidateEmail,
                subject: 'Thanks for applying to Keycard',
                receivedTime: arrivalTime,
              },
            ],
            count: 1,
            totalMatched: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.pathname === '/api/zoho/ui/message') {
        assert.equal(url.searchParams.get('messageId'), 'msg-clock-skew-1');
        return new Response(
          JSON.stringify({
            message: {
              messageId: 'msg-clock-skew-1',
              from: 'no-reply@keycard.ai',
              to: candidateEmail,
              subject: 'Thanks for applying to Keycard',
              receivedTime: arrivalTime,
              textContent:
                'Thanks for applying to Keycard! Your application has been received by our recruiting team.',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL called: ${url.pathname}`);
    };

    const res = await queryZohoConfirmationEmail({
      candidateEmail,
      companyName,
      submissionTime,
      ats: 'ashby',
    });

    assert.equal(res.success, true);
    assert.equal(res.matched, true);
    assert.ok(res.email);
    assert.equal(res.email.messageId, 'msg-clock-skew-1');
  });

  it('Zoho strategy: Rejection email in inbox is skipped and valid confirmation later in window is matched', async () => {
    const submissionTime = Date.now();
    const candidateEmail = 'candidate@applywizard.ai';
    const companyName = 'Fluidstack';

    const messageDetails: Record<string, any> = {
      'msg-rejection': {
        messageId: 'msg-rejection',
        from: 'no-reply@ashbyhq.com',
        to: candidateEmail,
        subject: 'Fluidstack Application Update',
        receivedTime: submissionTime + 3000,
        textContent:
          'Thank you for your interest in Fluidstack. After reviewing your background, we have decided to move forward with other candidates whose experience more closely matches our needs. All the best in your job search.',
      },
      'msg-valid-confirm': {
        messageId: 'msg-valid-confirm',
        from: 'no-reply@ashbyhq.com',
        to: candidateEmail,
        subject: 'Thank You for Applying to Fluidstack',
        receivedTime: submissionTime + 1000,
        textContent:
          'Thank you for your application to Fluidstack! We have received your application and our team will review your application shortly.',
      },
    };

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/zoho/ui/inbox') {
        return new Response(
          JSON.stringify({
            accountId: 'acc-123',
            folder: { folderId: 'folder-inbox' },
            messages: [
              {
                messageId: 'msg-rejection',
                folderId: 'folder-inbox',
                from: 'no-reply@ashbyhq.com',
                to: candidateEmail,
                subject: 'Fluidstack Application Update',
                receivedTime: submissionTime + 3000,
              },
              {
                messageId: 'msg-valid-confirm',
                folderId: 'folder-inbox',
                from: 'no-reply@ashbyhq.com',
                to: candidateEmail,
                subject: 'Thank You for Applying to Fluidstack',
                receivedTime: submissionTime + 1000,
              },
            ],
            count: 2,
            totalMatched: 2,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.pathname === '/api/zoho/ui/message') {
        const id = url.searchParams.get('messageId')!;
        const detail = messageDetails[id];
        if (!detail) throw new Error(`Unknown messageId: ${id}`);
        return new Response(
          JSON.stringify({ message: detail }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL called: ${url.pathname}`);
    };

    const res = await queryZohoConfirmationEmail({
      candidateEmail,
      companyName,
      submissionTime,
      ats: 'ashby',
    });

    assert.equal(res.success, true);
    assert.equal(res.matched, true);
    assert.ok(res.email);
    // msg-rejection must be skipped, msg-valid-confirm matched
    assert.equal(res.email.messageId, 'msg-valid-confirm');
    assert.match(res.email.body_text, /received your application/i);
  });

  it('Gmail strategy: Ashby matching email returns EmailProofJson', async () => {
    const submissionTime = Date.now();
    const candidateEmail = 'candidate@gmail.com';
    const companyName = 'Nexxen';

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/gmail/ui/inbox') {
        assert.equal(url.searchParams.get('email'), candidateEmail);
        return new Response(
          JSON.stringify({
            email: candidateEmail,
            count: 1,
            messages: [
              {
                messageId: 'gmail-ashby-1',
                from: 'no-reply@ashbyhq.com',
                subject: 'Thank You for Applying to Nexxen',
                receivedAt: submissionTime + 2000,
                snippet: 'We have received your application',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.pathname === '/api/gmail/ui/message') {
        assert.equal(url.searchParams.get('messageId'), 'gmail-ashby-1');
        return new Response(
          JSON.stringify({
            message: {
              messageId: 'gmail-ashby-1',
              from: 'no-reply@ashbyhq.com',
              to: candidateEmail,
              subject: 'Thank You for Applying to Nexxen',
              receivedAt: submissionTime + 2000,
              textContent:
                'Thank you for applying to Nexxen! Your application has been received and will be reviewed by our team.',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL called: ${url.pathname}`);
    };

    const res = await queryConfirmationEmail({
      candidateEmail,
      companyName,
      submissionTime,
      ats: 'ashby',
    });

    assert.equal(res.success, true);
    assert.equal(res.matched, true);
    assert.ok(res.email);
    assert.equal(res.email.messageId, 'gmail-ashby-1');
    assert.equal(res.email.from, 'no-reply@ashbyhq.com');
    assert.match(res.email.body_text, /received/i);
  });

  it('Greenhouse queries without ats: "ashby" preserve Greenhouse matching', async () => {
    const submissionTime = Date.now();
    const candidateEmail = 'candidate@applywizard.ai';
    const companyName = 'AcmeCorp';

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/zoho/ui/inbox') {
        return new Response(
          JSON.stringify({
            accountId: 'acc-123',
            folder: { folderId: 'folder-inbox' },
            messages: [
              {
                messageId: 'gh-confirm-1',
                folderId: 'folder-inbox',
                from: 'no-reply@us.greenhouse-mail.io',
                to: candidateEmail,
                subject: 'Thank you for applying to AcmeCorp',
                receivedTime: submissionTime + 2000,
              },
            ],
            count: 1,
            totalMatched: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.pathname === '/api/zoho/ui/message') {
        return new Response(
          JSON.stringify({
            message: {
              messageId: 'gh-confirm-1',
              from: 'no-reply@us.greenhouse-mail.io',
              to: candidateEmail,
              subject: 'Thank you for applying to AcmeCorp',
              receivedTime: submissionTime + 2000,
              textContent:
                'Thank you for applying to AcmeCorp. Your application has been received.',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL called: ${url.pathname}`);
    };

    // Call without ats property (defaults to Greenhouse)
    const res = await queryConfirmationEmail({
      candidateEmail,
      companyName,
      submissionTime,
    });

    assert.equal(res.success, true);
    assert.equal(res.matched, true);
    assert.ok(res.email);
    assert.equal(res.email.messageId, 'gh-confirm-1');
    assert.match(res.email.from, /greenhouse-mail\.io/);
  });
});
