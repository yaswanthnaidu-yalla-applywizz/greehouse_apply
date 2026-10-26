import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGraphMailPayload } from '../src/services/azureEmail.js';

describe('buildGraphMailPayload', () => {
  it('formats single string toRecipients correctly', () => {
    const payload = buildGraphMailPayload({ to: 'single@example.com', subject: 'Test Single' });
    assert.deepEqual(payload.message.toRecipients, [
      { emailAddress: { address: 'single@example.com' } },
    ]);
    assert.equal(payload.message.ccRecipients, undefined);
  });

  it('formats array of toRecipients and ccRecipients correctly', () => {
    const payload = buildGraphMailPayload({
      to: ['to1@example.com', 'TO2@example.com'],
      cc: ['cc1@example.com', 'cc2@example.com'],
      subject: 'Test Multi',
    });
    assert.deepEqual(payload.message.toRecipients, [
      { emailAddress: { address: 'to1@example.com' } },
      { emailAddress: { address: 'to2@example.com' } },
    ]);
    assert.deepEqual(payload.message.ccRecipients, [
      { emailAddress: { address: 'cc1@example.com' } },
      { emailAddress: { address: 'cc2@example.com' } },
    ]);
  });

  it('handles optional single string cc correctly', () => {
    const payload = buildGraphMailPayload({
      to: 'to@example.com',
      cc: 'cc@example.com',
      subject: 'Test Single CC',
    });
    assert.deepEqual(payload.message.toRecipients, [
      { emailAddress: { address: 'to@example.com' } },
    ]);
    assert.deepEqual(payload.message.ccRecipients, [
      { emailAddress: { address: 'cc@example.com' } },
    ]);
  });
});
