import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { SANDBOX_CA_EMAIL, resolveAssignedCaEmail } from '../src/db/sandboxAssignment.js';

const originalSandbox = process.env.SANDBOX;

after(() => {
  if (originalSandbox === undefined) {
    delete process.env.SANDBOX;
  } else {
    process.env.SANDBOX = originalSandbox;
  }
});

describe('sandbox CA assignment', () => {
  it('overrides supplied CA emails in sandbox mode', () => {
    process.env.SANDBOX = 'true';

    assert.equal(resolveAssignedCaEmail('other-ca@example.com'), SANDBOX_CA_EMAIL);
  });

  it('recognizes the numeric sandbox flag', () => {
    process.env.SANDBOX = '1';

    assert.equal(resolveAssignedCaEmail(null), SANDBOX_CA_EMAIL);
  });

  it('preserves the existing CA assignment outside sandbox mode', () => {
    delete process.env.SANDBOX;

    assert.equal(resolveAssignedCaEmail('Other-CA@Example.com'), 'Other-CA@Example.com');
  });
});
