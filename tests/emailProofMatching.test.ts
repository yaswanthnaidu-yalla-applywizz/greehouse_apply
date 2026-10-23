import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isEmailMessageIdAlreadyAttached } from '../src/submitter/proofCapture.js';
import { queryZohoConfirmationEmail } from '../src/services/inbox/zohoStrategy.js';
import { queryGmailConfirmationEmail } from '../src/services/inbox/gmailStrategy.js';
import { resolveInboxProvider, queryConfirmationEmail } from '../src/services/zoho-connector.js';
import { isGmailDomain, isCandidateMailboxDomain } from '../src/db/profiles.js';

describe('Email proof matching and deduplication', () => {
  it('defines isEmailMessageIdAlreadyAttached helper', () => {
    assert.equal(typeof isEmailMessageIdAlreadyAttached, 'function');
  });

  it('handles empty messageId safely in isEmailMessageIdAlreadyAttached', async () => {
    const attached = await isEmailMessageIdAlreadyAttached('');
    assert.equal(attached, false);
  });

  it('rejects Zoho confirmation query when candidate email is missing', async () => {
    const res = await queryZohoConfirmationEmail({
      candidateEmail: '',
      companyName: 'Stripe',
      submissionTime: new Date().toISOString(),
      allowHistorical: true,
    });
    assert.equal(res.success, false);
    assert.equal(res.matched, false);
  });

  it('rejects Gmail confirmation query when candidate email is missing', async () => {
    const res = await queryGmailConfirmationEmail({
      candidateEmail: '',
      companyName: 'Stripe',
      submissionTime: new Date().toISOString(),
      allowHistorical: true,
    });
    assert.equal(res.success, false);
    assert.equal(res.matched, false);
  });

  it('resolves inbox provider correctly based on domain', () => {
    assert.equal(resolveInboxProvider('user@gmail.com'), 'gmail');
    assert.equal(resolveInboxProvider('USER@GOOGLEMAIL.COM'), 'gmail');
    assert.equal(resolveInboxProvider('candidate@applywizard.ai'), 'zoho');
    assert.equal(resolveInboxProvider('candidate@applywizz.ai'), 'zoho');
    assert.equal(resolveInboxProvider(''), 'zoho');
  });

  it('verifies isGmailDomain and isCandidateMailboxDomain', () => {
    assert.equal(isGmailDomain('foo@gmail.com'), true);
    assert.equal(isGmailDomain('foo@googlemail.com'), true);
    assert.equal(isGmailDomain('foo@applywizard.ai'), false);

    assert.equal(isCandidateMailboxDomain('foo@gmail.com'), true);
    assert.equal(isCandidateMailboxDomain('foo@applywizard.ai'), true);
    assert.equal(isCandidateMailboxDomain('foo@yahoo.com'), false);
  });

  it('queryConfirmationEmail rejects empty candidate email gracefully', async () => {
    const res = await queryConfirmationEmail({
      candidateEmail: '',
      companyName: 'Stripe',
      submissionTime: new Date().toISOString(),
    });
    assert.equal(res.success, false);
    assert.equal(res.matched, false);
  });
});
