import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isEmailMessageIdAlreadyAttached } from '../src/submitter/proofCapture.js';
import { queryZohoConfirmationEmail } from '../src/services/inbox/zohoStrategy.js';

describe('Email proof matching and deduplication', () => {
  it('defines isEmailMessageIdAlreadyAttached helper', () => {
    assert.equal(typeof isEmailMessageIdAlreadyAttached, 'function');
  });

  it('handles empty messageId safely in isEmailMessageIdAlreadyAttached', async () => {
    const attached = await isEmailMessageIdAlreadyAttached('');
    assert.equal(attached, false);
  });

  it('rejects confirmation query when candidate email is missing', async () => {
    const res = await queryZohoConfirmationEmail({
      candidateEmail: '',
      companyName: 'Stripe',
      submissionTime: new Date().toISOString(),
      allowHistorical: true,
    });
    assert.equal(res.success, false);
    assert.equal(res.matched, false);
  });
});
